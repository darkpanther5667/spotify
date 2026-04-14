const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const zlib = require('zlib');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;
const streamCache = new Map();

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const spawnSync = require('child_process').spawnSync;

const findPython = () => {
    const candidates = ['/app/venv/bin/python', 'python3', 'python'];
    for (const bin of candidates) {
        if (bin.startsWith('/')) {
            if (fs.existsSync(bin)) {
                return bin;
            }
            continue;
        }
        const result = spawnSync(bin, ['--version'], { stdio: 'ignore' });
        if (result.status === 0) {
            return bin;
        }
    }
    return null;
};

const runYtDlp = (args) => new Promise((resolve, reject) => {
    const pythonBin = findPython();
    if (!pythonBin) {
        return reject(new Error('Python runtime not found. Make sure python3 is installed or /app/venv/bin/python exists.'));
    }

    const ytdlpArgs = [
        '-m',
        'yt_dlp',
        '--no-warnings',
        '--js-runtimes',
        'node',
        '--no-check-certificate',
        '--geo-bypass',
        '-q',  // Quiet mode for faster output
        '--socket-timeout', '10',  // 10 sec socket timeout
        ...args
    ];

    const child = spawn(pythonBin, ytdlpArgs, {
        cwd: ROOT,
        windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let completed = false;
    const timeoutHandle = setTimeout(() => {
        if (!completed) {
            child.kill();
            reject(new Error('Search timed out. Please try again.'));
        }
    }, 12000);  // 12 sec hard timeout

    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        completed = true;
        reject(err);
    });

    child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        completed = true;
        if (code !== 0) {
            const message = stderr.trim();
            const lower = message.toLowerCase();
            if (lower.includes('sign in to confirm your age') || lower.includes('age-restricted') || lower.includes('sign in to confirm your age')) {
                reject(new Error('This track is age-restricted and cannot be streamed without YouTube sign-in.'));
                return;
            }
            if (lower.includes('video unavailable') || lower.includes('not available') || lower.includes('private video')) {
                reject(new Error('This track is unavailable on YouTube.')); 
                return;
            }
            reject(new Error(message || `yt-dlp exited with code ${code}`));
            return;
        }
        resolve(stdout.trim());
    });
});

const sendJson = (res, statusCode, body, req = null) => {
    const json = JSON.stringify(body);
    const encoding = (req?.headers['accept-encoding'] || '').includes('gzip') ? 'gzip' : 'identity';
    
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*'
    };
    
    if (encoding === 'gzip' && json.length > 500) {
        headers['Content-Encoding'] = 'gzip';
        zlib.gzip(json, (err, compressed) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Compression error');
                return;
            }
            res.writeHead(statusCode, headers);
            res.end(compressed);
        });
    } else {
        res.writeHead(statusCode, headers);
        res.end(json);
    }
};

const getCachedStream = (id) => {
    const cached = streamCache.get(id);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
        streamCache.delete(id);
        return null;
    }
    return cached.value;
};

const setCachedStream = (id, value) => {
    streamCache.set(id, {
        value,
        expiresAt: Date.now() + STREAM_CACHE_TTL_MS
    });
};

const searchYoutube = async (query, limit) => {
    // Reduced multiplier for faster results (2x -> 1.5x)
    const searchLimit = Math.min(Math.ceil(limit * 1.5), 40);
    const json = await runYtDlp([
        '--dump-single-json',
        `ytsearch${searchLimit}:${query}`
    ]);

    const data = JSON.parse(json);
    const filtered = (data.entries || []).filter((entry) => {
        if (!entry || !entry.id || !entry.title) return false;
        // Quick availability check
        if (entry.availability !== undefined && entry.availability !== 'public') return false;
        if (entry.age_limit && entry.age_limit > 0) return false;
        if (entry.is_live) return false;
        return true;
    });

    return filtered.slice(0, limit).map((entry) => ({
        id: entry.id,
        title: entry.title,
        artist: entry.channel || entry.uploader || 'YouTube',
        album: 'YouTube',
        thumb: entry.thumbnails?.[1]?.url || entry.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
        duration: entry.duration ? Math.round(entry.duration) : null
    }));
};

const getStream = async (id) => {
    const cached = getCachedStream(id);
    if (cached) {
        return cached;
    }

    const json = await runYtDlp([
        '--dump-single-json',
        '-f',
        'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        '--no-check-certificate',
        '--geo-bypass',
        `https://www.youtube.com/watch?v=${id}`
    ]);

    const data = JSON.parse(json);

    if (data.availability && data.availability !== 'public') {
        throw new Error('This track is unavailable on YouTube.');
    }
    if (data.age_limit && data.age_limit > 0) {
        throw new Error('This track is age-restricted and cannot be streamed without YouTube sign-in.');
    }
    if (data.is_live) {
        throw new Error('Live streams are not supported.');
    }

    const audioFormats = (data.formats || []).filter((format) =>
        format.acodec && format.acodec !== 'none' && format.vcodec === 'none' && format.url
    );
    const preferred = audioFormats.find((format) => format.ext === 'm4a')
        || audioFormats.find((format) => format.ext === 'webm')
        || audioFormats[audioFormats.length - 1];

    if (!preferred?.url) {
        throw new Error('No playable audio stream found');
    }

    const result = {
        id: data.id,
        title: data.title,
        artist: data.channel || data.uploader || 'YouTube',
        album: 'YouTube',
        thumb: data.thumbnail || `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`,
        duration: data.duration ? Math.round(data.duration) : null,
        streamUrl: preferred.url,
        mimeType: preferred.ext === 'm4a' ? 'audio/mp4' : preferred.ext === 'webm' ? 'audio/webm' : 'audio/mpeg',
        proxyUrl: `/api/yt/audio?id=${encodeURIComponent(data.id)}`
    };

    setCachedStream(id, result);
    return result;
};

const proxyAudio = async (req, res, id) => {
    const stream = await getStream(id);
    const upstreamUrl = new URL(stream.streamUrl);
    const headers = {};

    if (req.headers.range) {
        headers.Range = req.headers.range;
    }

    https.get(upstreamUrl, {
        headers
    }, (upstreamRes) => {
        const passthroughHeaders = {
            'Content-Type': upstreamRes.headers['content-type'] || stream.mimeType || 'audio/mpeg',
            'Cache-Control': 'no-store',
            'Accept-Ranges': upstreamRes.headers['accept-ranges'] || 'bytes'
        };

        if (upstreamRes.headers['content-length']) {
            passthroughHeaders['Content-Length'] = upstreamRes.headers['content-length'];
        }

        if (upstreamRes.headers['content-range']) {
            passthroughHeaders['Content-Range'] = upstreamRes.headers['content-range'];
        }

        res.writeHead(upstreamRes.statusCode || 200, passthroughHeaders);
        upstreamRes.pipe(res);
    }).on('error', (error) => {
        sendJson(res, 502, { status: 502, message: `Audio proxy failed: ${error.message}`, response: null }, req);
    });
};

const server = http.createServer(async (req, res) => {
    try {
        if (req.url.startsWith('/api/yt/search')) {
            const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
            const query = requestUrl.searchParams.get('q') || '';
            const limit = Math.max(1, Math.min(50, Number(requestUrl.searchParams.get('limit') || 20)));
            if (!query.trim()) {
                sendJson(res, 400, { status: 400, message: 'Missing q parameter', response: [] }, req);
                return;
            }
            const results = await searchYoutube(query, limit);
            sendJson(res, 200, { status: 200, message: 'success', response: results }, req);
            return;
        }

        if (req.url.startsWith('/api/yt/stream')) {
            const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
            const id = requestUrl.searchParams.get('id') || '';
            if (!id.trim()) {
                sendJson(res, 400, { status: 400, message: 'Missing id parameter', response: null }, req);
                return;
            }
            const result = await getStream(id);
            sendJson(res, 200, { status: 200, message: 'success', response: result }, req);
            return;
        }

        if (req.url.startsWith('/api/yt/audio')) {
            const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
            const id = requestUrl.searchParams.get('id') || '';
            if (!id.trim()) {
                sendJson(res, 400, { status: 400, message: 'Missing id parameter', response: null }, req);
                return;
            }
            await proxyAudio(req, res, id);
            return;
        }

        const requestPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
        const safePath = path.normalize(path.join(ROOT, requestPath));

        if (!safePath.startsWith(ROOT)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Forbidden');
            return;
        }

        fs.readFile(safePath, (error, content) => {
            if (error) {
                const statusCode = error.code === 'ENOENT' ? 404 : 500;
                res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(statusCode === 404 ? 'Not found' : 'Server error');
                return;
            }

            const ext = path.extname(safePath).toLowerCase();
            // Longer cache for CSS/JS, shorter for HTML
            const cacheControl = ext === '.html' ? 'public, max-age=60' : 'public, max-age=3600';
            res.writeHead(200, {
                'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
                'Cache-Control': cacheControl
            });
            res.end(content);
        });
    } catch (error) {
        sendJson(res, 500, { status: 500, message: error.message, response: null }, req);
    }
});

server.listen(PORT, () => {
    console.log(`SpotiClone server running at http://localhost:${PORT}`);
});
