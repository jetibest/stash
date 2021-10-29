#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const child_process = require('child_process');
const crypto = require('crypto');
const express = require('express'); // npm install express
const busboy = require('busboy'); // npm install busboy

// support at least 5GiB per 6 hours by default, resulting in a stash_cache directory of at most 10GiB
// by default listens locally (127.0.0.1), change to 0.0.0.0 to make available publicly
// by default listens on port 80, the default HTTP port but privileged (only root), change to 8080 for regular users

const JAIL_PATH = path.resolve('stash_cache/');
const MAX_WRITE_BYTES = 5 * 1024 * 1024 * 1024;
const CLEAN_INTERVAL_MINUTES = 360;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 80;

if(JAIL_PATH.startsWith('/stash_cache'))
{
	JAIL_PATH = '/var/lib/stash_cache';
}

// parse args:
var serverOptions = {};
try
{
	serverOptions = new URL(process.argv[2]);
}
catch(err)
{
	if(/^[0-9]+$/g.test(process.argv[2]))
	{
		serverOptions.host = DEFAULT_HOST;
		serverOptions.port = parseInt(process.argv[2]) || DEFAULT_PORT;
	}
	else
	{
		serverOptions.host = process.argv[2] || DEFAULT_HOST;
		serverOptions.port = parseInt(process.argv[3]) || DEFAULT_PORT;
	}
}

const indexPage = fs.readFileSync('index.html');

const stat = {
	randomIds: {},
	writtenBytes: 0
};

function sanity_check(p)
{
	var real_p = path.resolve(p);
	return real_p && real_p.startsWith(JAIL_PATH) && real_p !== '/';
}

function cleanup()
{
	// delete any files older than some time (6 hours = 360 minutes)
	console.log('cleanup(): Cleaning up ' + JAIL_PATH);
	var cp = child_process.spawn('find', [JAIL_PATH, '-type', 'f', '-mmin', '+' + CLEAN_INTERVAL_MINUTES, '-delete']);
	cp.stdout.on('data', function(chunk){console.log(chunk.toString('utf8'));}); // consume
	cp.stderr.on('data', function(chunk){console.error(chunk.toString('utf8'));}); // consume
	cp.on('error', function(err)
	{
		console.error(err);
	});
	cp.on('close', function()
	{
		console.log('cleanup(): Clean-up completed for ' + stat.writtenBytes + ' bytes.');
		
		stat.writtenBytes = 0;
		
		setTimeout(cleanup, CLEAN_INTERVAL_MINUTES * 60000);
	});
}

function stream_write(chunk, encoding, cb)
{
	if(chunk.length + stat.writtenBytes > MAX_WRITE_BYTES)
	{
		console.error('MAX_WRITE_BYTES (' + MAX_WRITE_BYTES + ') reached, cleanup is every ' + CLEAN_INTERVAL_MINUTES + ' minutes');
		return cb(new Error('No space left on device. Wait for cleanup.'));
	}
	stat.writtenBytes += chunk.length;
	cb(null, chunk);
}

async function createWriteStream(real_path)
{
	console.log('creating write stream for: ' + real_path);
	
	var real_dir = path.dirname(real_path);
	if(real_dir && real_dir !== '.')
	{
		console.log('ensuring directories exist: ' + real_dir);
		try
		{
			await fs.promises.mkdir(real_dir, {recursive: true});
		}
		catch(err)
		{
			if(err.code !== 'EEXIST' || !err.path) throw err;
			
			var real_err_path = path.resolve(err.path);
			if(!sanity_check(real_err_path)) throw err;
			
			console.log('deleting existing file: ' + real_err_path);
			
			// delete any files in our way, and try again
			await fs.promises.unlink(real_err_path);
			
			// retry creating directory
			await fs.promises.mkdir(real_dir, {recursive: true});
		}
	}
	
	// check if path is a directory
	var fstat = await fs.promises.stat(real_path).catch(ignore => {});
	
	if(fstat && fstat.isDirectory())
	{
		console.log('removing existing directory: ' + real_path);
		await (fs.promises.rm || fs.rmdirSync)(real_path, {recursive: true, force: true});
	}
	// else: isFile() => will be overwritten
	
	console.log('returning writestream from fs for: ' + real_path);
	return fs.createWriteStream(real_path);
}

function req_pipe(req, real_path)
{
	return new Promise((resolveOnce, rejectOnce) =>
	{
		var resolve = function()
		{
			resolve = function(){};
			resolveOnce();
		};
		var reject = function()
		{
			reject = function(){};
			rejectOnce();
		};
		
		
		var contentType = req.headers['content-type'] || '';
		if(contentType.startsWith('multipart/form-data'))
		{
			console.log('using busboy');
			// use busboy to parse file
			var bb = new busboy({
				headers: req.headers,
				limits: {fieldSize: 1024 * 1024 * 16} // 16 MiB of text data maximum (through textarea)
			});
			
			var hasData = false;
			bb.on('field', function(fieldName, value)
			{
				console.log('field received with name: ' + fieldName);
				if(fieldName === 'data' && !hasData)
				{
					hasData = true;
					createWriteStream(real_path).catch(reject).then(fh => {
						new stream.Transform({transform: stream_write}).pipe(fh.on('error', reject)).on('error', reject).on('finish', resolve).end(value);
					});
				}
			});
			bb.on('file', function(fieldName, file, fileName, encoding, mimeType)
			{
				console.log('file received with name: ' + fieldName);
				if(fieldName === 'data' && !hasData)
				{
					hasData = true;
					createWriteStream(real_path).catch(reject).then(fh =>
					{
						file.pipe(new stream.Transform({transform: stream_write}).on('error', reject)).pipe(fh.on('error', reject)).on('error', reject).on('finish', resolve);
					});
				}
			});
			bb.on('error', reject);
			bb.on('finish', function()
			{
				console.log('bb finish');
				if(!hasData)
				{
					hasData = true; // already rejected
					reject(); // no data found
				}
			});
			req.pipe(bb);
		}
		else
		{
			createWriteStream(real_path).catch(reject).then(fh =>
			{
				req.pipe(new stream.Transform({transform: stream_write}).on('error', reject)).pipe(fh.on('error', reject)).on('error', reject).on('finish', resolve);
			});
		}
	});
}

function generate_random_id()
{
	return new Promise(function(resolve, reject)
	{
		crypto.randomBytes(32, function(err, buf)
		{
			if(err) return reject(err);
			
			var urlSafeEncodedRandomId = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
			
			// now use a small version of this, until we find one that does not exist yet
			var i = 6, id;
			while(i < urlSafeEncodedRandomId.length)
			{
				if((id = urlSafeEncodedRandomId.substring(0, i)) in stat.randomIds)
				{
					++i;
				}
				else
				{
					break;
				}
			}
			
			stat.randomIds[id] = true;
			
			resolve(id);
		});
	});
}

function stash_servlet(req, res, next)
{
	if(!res || res.headersSent) return next();
	
	var url_path = req.url.replace(/[?].*$/g, '');
	
	if(url_path === '/' || url_path === '')
	{
		console.log('stash homepage');
		
		generate_random_id().catch(function(err)
		{
			console.error(err);
			res.status(500).end('error: Internal error.\n');
			next();
		}).then(function(randomId)
		{
			res.set('Content-Type', 'text/html; charset=UTF-8').status(200).end(indexPage.toString().replace(/[$]__RANDOM_PATH/g, function()
			{
				return randomId;
			}).replace(/[$]__SERVER_PATH/g, function()
			{
				return path.join((req.headers['x-forwarded-original-path'] || ''), (req.originalUrl + ''));
			}));
			
			next();
		});
	}
	else if(req.method === 'POST' || req.method === 'PUT')
	{
		// upload file
		var real_path = path.resolve(path.join(JAIL_PATH, url_path));
		console.log('stash post: ' + real_path);
		
		// check jail
		if(!sanity_check(real_path))
		{
			console.error('Jailbreak attempt for: ' + url_path);
			res.status(400).end('error: Jailbreak for path: ' + url_path + '\n');
			return next();
		}
		
		req_pipe(req, real_path).catch(err =>
		{
			console.error(err);
			res.status(500).end('error: Internal write error.\n');
		}).then(() =>
		{
			if(res && !res.headersSent)
			{
				// if ?redirect=yes
				if(req.query.redirect)
				{
					// use temporary redirect (302 Found)
					res.redirect(302, './' + req.url.replace(/[?].*$/g, '').replace(/^.*[/]/g, ''));
				}
				else
				{
					res.status(200).end('ok\n');
				}
			}
			next();
		});
	}
	else
	{
		next();
	}
}

function stash_error(req, res, next)
{
	console.log('stash error for: ' + req.url + ' and: ' + res.headersSent + ', ' + res.statusCode);
	
	if(!res || res.headersSent) return next();
	
	res.status(404).end('error: No such file or directory (' + req.url + ').'); // no response body
	next();
}

const app = express({strict: true});
app.use(stash_servlet);
app.use(express.static(JAIL_PATH, {redirect: false}));
app.use(stash_error);
app.listen(serverOptions);

cleanup();
