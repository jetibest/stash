#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const child_process = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const express = require('express'); // npm install express
const busboy = require('busboy'); // npm install busboy

function parse_size(value, fallback)
{
	if(value === null || value === undefined) return fallback;
	var m = /^([0-9]+(?:\.[0-9]+)?)\s*(b|kib|mib|gib|tib|kb|mb|gb|tb|)?$/i.exec(String(value));
	if(!m) return fallback;
	var number = parseFloat(m[1]);
	if(!(number >= 0) || !isFinite(number)) return fallback;
	var units = {b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 * 1024, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4};
	var multiplier = (m[2] && units[m[2].toLowerCase()]) || 1;
	return Math.floor(number * multiplier);
}

function parse_positive_int(value, fallback)
{
	var n = parseInt(value, 10);
	return (n >= 1) ? n : fallback;
}
const JAIL_PATH = path.resolve(process.env.STASH_JAIL_PATH || '/var/cache/stash/');
const MAX_WRITE_BYTES = parse_size(process.env.STASH_MAX_WRITE_BYTES, 5 * 1024 * 1024 * 1024);
const MAX_FILE_BYTES = parse_size(process.env.STASH_MAX_FILE_BYTES, MAX_WRITE_BYTES);
const MAX_FIELD_BYTES = parse_size(process.env.STASH_MAX_FIELD_BYTES, 16 * 1024 * 1024);
const MIN_FREE_BYTES = parse_size(process.env.STASH_MIN_FREE_BYTES, 4 * 1024 * 1024 * 1024);
const CLEAN_INTERVAL_MINUTES = parse_positive_int(process.env.STASH_CLEAN_INTERVAL_MINUTES, 360);
const LISTEN_ADDRESS = process.env.STASH_LISTEN_ADDRESS || '0.0.0.0';
const LISTEN_PORT = parseInt(process.env.STASH_LISTEN_PORT, 10) || 8080;

var server;
var cleanup_timer;

function graceful_shutdown()
{
	console.log('Received signal to shutdown. Starting graceful shutdown...');
	
	clearTimeout(cleanup_timer);
	
	if(server) server.close(err => {
		if(err)
		{
			console.error('Error during server close:', err);
			process.exit(1);
		}
		
		console.log('Graceful shutdown completed.');
		process.exit(0);
	});
	
	setTimeout(() =>
	{
		console.log('Could not close server in time, forcing shutdown.');
		process.exit(1);
	}, 10000);
}
process.on('SIGTERM', graceful_shutdown);
process.on('SIGINT', graceful_shutdown);

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
		serverOptions.hostname = LISTEN_ADDRESS;
		serverOptions.port = parseInt(process.argv[2]) || LISTEN_PORT;
	}
	else
	{
		serverOptions.hostname = process.argv[2] || LISTEN_ADDRESS;
		serverOptions.port = parseInt(process.argv[3]) || LISTEN_PORT;
	}
}
const indexPage = fs.readFileSync('index.html');
const encryptedPage = fs.readFileSync('encrypted.html');

const stat = {
	randomIds: {},
	writtenBytes: 0
};

function sanity_check(p)
{
	var real_p = path.resolve(p);
	return real_p && real_p.startsWith(JAIL_PATH) && real_p !== '/';
}

function has_disk_space()
{
	try
	{
		var stats = fs.statfsSync(JAIL_PATH);
		var free = stats.bsize * stats.bavail;
		var total = stats.bsize * stats.blocks;
		if(MIN_FREE_BYTES > 0 && free < MIN_FREE_BYTES)
		{
			console.error('Not enough free disk space: ' + free + ' bytes free, minimum is ' + MIN_FREE_BYTES);
			return false;
		}
		return true;
	}
	catch(err)
	{
		// statfs is best-effort: if it fails, do not block uploads
		console.error('Could not determine free disk space: ' + err);
		return true;
	}
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
		var diskSpace = has_disk_space() ? '' : ' (not enough free disk space)';
		console.log('cleanup(): Clean-up completed for ' + stat.writtenBytes + ' bytes written.' + diskSpace);
		
		stat.writtenBytes = 0;
		
		cleanup_timer = setTimeout(cleanup, CLEAN_INTERVAL_MINUTES * 60000);
	});
}

function stream_write(chunk, encoding, cb)
{
	if(chunk.length + stat.writtenBytes > MAX_WRITE_BYTES)
	{
		console.error('MAX_WRITE_BYTES (' + MAX_WRITE_BYTES + ') reached, cleanup is every ' + CLEAN_INTERVAL_MINUTES + ' minutes');
		return cb(new Error('No space left on device. Wait for cleanup.'));
	}
	if(!has_disk_space())
	{
		return cb(new Error('Not enough free disk space. Wait for cleanup or free up space.'));
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

function parse_disposition_filename(header)
{
	if(!header) return null;
	var m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(header);
	if(m) return decodeURIComponent(m[1].trim());
	m = /filename\s*=\s*"([^"]*)"/i.exec(header);
	if(m) return m[1];
	m = /filename\s*=\s*([^;]+)/i.exec(header);
	if(m) return m[1].trim();
	return null;
}

function sanitize_basename(name)
{
	var base = String(name || 'download').replace(/[\\/]/g, '_').replace(/^\.+/, '');
	return base || 'download';
}

// download a remote url into the jail cache, returning the resulting
// {filename, bytes} on success. the filename is taken from the
// Content-Disposition header if present, else the last url path segment.
function download_url(url)
{
	return new Promise((resolve, reject) =>
	{
		var parsed;
		try
		{
			parsed = new URL(url);
		}
		catch(err)
		{
			return reject(new Error('Invalid URL: ' + url));
		}
		var lib = parsed.protocol === 'https:' ? https : (parsed.protocol === 'http:' ? http : null);
		if(!lib)
		{
			return reject(new Error('Unsupported protocol: ' + parsed.protocol));
		}
		
		var request = lib.get(url, function(res)
		{
			if(res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
			{
				// follow redirect
				res.resume();
				return download_url(new URL(res.headers.location, url).href).then(resolve, reject);
			}
			if(res.statusCode >= 400)
			{
				res.resume();
				return reject(new Error('Download failed: HTTP ' + res.statusCode));
			}
			
			var filename = sanitize_basename(parse_disposition_filename(res.headers['content-disposition']) || path.basename(parsed.pathname));
			var real_path = path.resolve(path.join(JAIL_PATH, filename));
			if(!sanity_check(real_path))
			{
				res.resume();
				return reject(new Error('Invalid download filename.'));
			}
			
			var writtenBytes = 0;
			var limit = new stream.Transform({
				transform: function(chunk, enc, cb)
				{
					writtenBytes += chunk.length;
					if(writtenBytes > MAX_FILE_BYTES)
					{
						return cb(new Error('File exceeds ' + MAX_FILE_BYTES + ' byte limit.'));
					}
					stream_write(chunk, enc, cb);
				}
			});
			createWriteStream(real_path).catch(reject).then(fh =>
			{
				res.pipe(limit.on('error', reject)).pipe(fh.on('error', reject)).on('error', reject).on('finish', () => resolve({filename: filename, bytes: writtenBytes}));
			});
		});
		request.on('error', reject);
	});
}

function req_pipe(req, real_path)
{
	return new Promise((resolveOnce, rejectOnce) =>
	{
		var resolve = function(val)
		{
			resolve = function(){};
			resolveOnce(val);
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
			var bb = busboy({
				headers: req.headers,
				limits: {fieldSize: MAX_FIELD_BYTES} // maximum text data through textarea
			});
			
			var hasData = false;
			bb.on('field', function(fieldName, value)
			{
				console.log('field received with name: ' + fieldName);
				if(fieldName === 'download' && !hasData)
				{
					// server-side download of a remote url into the cache
					hasData = true;
					download_url(value).then(function(result)
					{
						resolve(result);
					}, reject);
				}
				else if(fieldName === 'data' && !hasData)
				{
					hasData = true;
					createWriteStream(real_path).catch(reject).then(fh => {
						new stream.Transform({transform: stream_write}).pipe(fh.on('error', reject)).on('error', reject).on('finish', resolve).end(value);
					});
				}
			});
			bb.on('file', function(fieldName, file, info)
			{
				var fileName = (info && (info.filename !== undefined ? info.filename : info)) || '';
				console.log('file received with name: ' + fieldName + ' (' + fileName + ')');
				if((fieldName === 'file' || fieldName === 'data') && !hasData)
				{
					hasData = true;
					// when posting to the root (e.g. `curl -F file=@x stash/`),
					// the target is the jail root itself; use the multipart
					// filename so the file gets a real stash path/name.
					var target = real_path;
					if(path.resolve(target) === path.resolve(JAIL_PATH))
					{
						target = path.join(JAIL_PATH, sanitize_basename(fileName));
					}
					console.log('file upload target: ' + target + ' (filename=' + fileName + ')');
					var writtenBytes = 0;
					var fileLimit = new stream.Transform({
						transform: function(chunk, enc, cb)
						{
							writtenBytes += chunk.length;
							if(writtenBytes > MAX_FILE_BYTES)
							{
								return cb(new Error('File exceeds ' + MAX_FILE_BYTES + ' byte limit.'));
							}
							stream_write(chunk, enc, cb);
						}
					});
					createWriteStream(target).catch(reject).then(fh =>
					{
						file.pipe(fileLimit.on('error', reject)).pipe(fh.on('error', reject)).on('error', reject).on('finish', resolve);
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

function set_cors_headers(res)
{
	res.set('Access-Control-Allow-Origin', '*');
	res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS');
	res.set('Access-Control-Allow-Headers', '*');
	res.set('Access-Control-Expose-Headers', '*');
	res.set('Access-Control-Max-Age', '86400');
}

function stash_servlet(req, res, next)
{
	if(!res || res.headersSent) return next();

	var url_path = req.url.replace(/[?].*$/g, '');
	var is_get = req.method === 'GET' || req.method === 'HEAD';
	
	if(is_get && (url_path === '/' || url_path === ''))
	{
		console.log('stash homepage');
		
		generate_random_id().catch(function(err)
		{
			console.error(err);
			res.status(500).end('error: Internal error.\n');
			next();
		}).then(function(randomId)
		{
			res.set('Content-Type', 'text/html; charset=UTF-8');
			res.set('Cache-Control', 'no-store');
			res.status(200).end(indexPage.toString().replace(/[$]__RANDOM_PATH/g, function()
			{
				return randomId;
			}).replace(/[$]__SERVER_PATH/g, function()
			{
				return path.join((req.headers['x-forwarded-original-path'] || ''), (req.originalUrl + ''));
			}));
			
			next();
		});
	}
	else if(is_get && url_path.indexOf('/encrypted/') === 0)
	{
		// serve the client-side decryption page. the encrypted file data is
		// stored as a normal stash entry at <SERVER_PATH>/<encName>, and the
		// decryption key lives in the url #fragment (never sent to us), so we
		// cannot read the plaintext.
		console.log('stash encrypted viewer: ' + url_path);
		res.set('Content-Type', 'text/html; charset=UTF-8');
		res.set('Cache-Control', 'no-store');
		res.status(200).end(encryptedPage.toString());
		next();
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
			res.status(500).end('error: ' + (err && err.message ? err.message : 'Internal write error.') + '\n');
		}).then((downloadResult) =>
		{
			if(res && !res.headersSent)
			{
				// if ?redirect=yes
				if(req.query.redirect)
				{
					// use temporary redirect (302 Found)
					res.redirect(302, './' + req.url.replace(/[?].*$/g, '').replace(/^.*[/]/g, ''));
				}
				else if(downloadResult && typeof downloadResult === 'object' && downloadResult.filename)
				{
					// download result: report the url where the stash can be found
					var base = path.join((req.headers['x-forwarded-original-path'] || ''), (req.originalUrl + '')).replace(/[^/]*$/g, '');
					var stashUrl = path.join(base, downloadResult.filename);
					res.status(200).end('ok ' + stashUrl + ' ' + downloadResult.bytes + '\n');
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
app.use(function(req, res, next)
{
	set_cors_headers(res);
	if(req.method === 'OPTIONS')
	{
		res.status(204).end();
		return;
	}
	next();
});
app.use(stash_servlet);
app.use(express.static(JAIL_PATH, {redirect: false}));
app.use(stash_error);
server = app.listen(serverOptions);

console.log('Server listening at ', serverOptions);

try
{
	fs.mkdirSync(JAIL_PATH, {recursive: true});
}
catch(err)
{
	console.error('Could not create jail path ' + JAIL_PATH + ': ' + err);
}
if(!has_disk_space())
{
	console.error('Warning: starting with low disk space, uploads will be rejected until space is freed or files expire.');
}

cleanup_timer = cleanup();
