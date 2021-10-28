#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const child_process = require('child_process');
const crypto = require('crypto');
const express = require('express'); // npm install express
const busboy = require('busboy'); // npm install busboy

const JAIL_PATH = path.resolve('stash_cache/');
const MAX_WRITE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

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
	autoIncrId: 0,
	writtenBytes: 0
};

function sanity_check(p)
{
	var real_p = path.resolve(p);
	return real_p && real_p.startsWith(JAIL_PATH) && real_p !== '/';
}

const cleanup = (function()
{
	var timer = null;
	return function cleanup()
	{
		return new Promise(function(resolve)
		{
			if(timer !== null)
			{
				clearTimeout(timer);
				timer = null;
			}
			
			// delete any files older than some time (6 hours = 360 minutes)
			console.log('cleanup(): Cleaning up ' + JAIL_PATH);
			var cp = child_process.spawn('find', [JAIL_PATH, '-type', 'f', '-mmin', '+10', '-delete']);
			cp.stdout.on('data', function(chunk){console.log(chunk.toString('utf8'));}); // consume
			cp.stderr.on('data', function(chunk){console.error(chunk.toString('utf8'));}); // consume
			cp.on('error', function(err)
			{
				console.error(err);
			});
			cp.on('close', function()
			{
				console.log('cleanup(): Clean-up completed.');
				
				if(timer === null)
				{
					// every so often, we check again to cleanup
					timer = setTimeout(cleanup, 15 * 60 * 1000);
				}
				
				resolve();
			});
		});
	};
})();

function stream_write(chunk, encoding, cb)
{
	if(chunk.length + stat.writtenBytes > MAX_WRITE_BYTES)
	{
		console.error('MAX_WRITE_BYTES reached');
		return cb(new Error('No space left on device.'));
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
	return new Promise((resolve, reject) =>
	{
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
						fh.on('error', reject).on('finish', resolve).end(value);
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
						file.pipe(fh.on('error', reject)).on('error', reject).on('finish', resolve);
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
				req.pipe(new stream.Transform({transform: stream_write}).on('error', reject)).pipe(fh).on('error', reject).on('finish', resolve);
			});
		}
	});
}

function stash_servlet(req, res, next)
{
	if(!res || res.headersSent) return next();
	
	if(req.url === '/' || req.url === '')
	{
		crypto.randomBytes(16, function(err, buf)
		{
			if(err)
			{
				buf = Buffer.from(new Uint8Array(16));
			}
			
			var rbuf = Buffer.concat([Buffer.from(new Uint32Array(++stat.autoIncrId).buffer), buf]);
			
			res.set('Content-Type', 'text/html; charset=UTF-8').status(200).end(indexPage.toString().replace(/[$]__RANDOM_PATH/g, function()
			{
				return rbuf.toString('hex') +'';
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
		var real_path = path.resolve(path.join(JAIL_PATH, req.url));
		console.log('stash request: ' + real_path);
		
		// check jail
		if(!sanity_check(real_path))
		{
			console.error('Jailbreak attempt for: ' + req.url);
			res.status(400).end('error: Jailbreak for path: ' + req.url + '\n');
			return next();
		}
		
		req_pipe(req, real_path).catch(err =>
		{
			console.error(err);
			res.status(500).end('error: Internal write error.\n');
		}).then(() =>
		{
			console.log('resolved');
			if(res && !res.headersSent)
			{
				res.status(200).end('ok\n');
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
