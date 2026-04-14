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
const SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;  // 15 min cache for search results
const streamCache = new Map();
const searchCache = new Map();

// Multiple Invidious instances for redundancy
const INVIDIOUS_INSTANCES = [
    'https://iv.nboeck.de',
    'https://invidious.namazso.eu',
    'https://yewtu.be'
];

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
        ...args
    ];

    console.log(`[yt-dlp] Starting: ${args.join(' ').substring(0, 100)}`);
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
            console.error(`[yt-dlp] Timeout after 90s: ${args.join(' ').substring(0, 50)}`);
            reject(new Error('Search timed out. Please try again.'));
        }
    }, 90000);  // 90 sec timeout - yt-dlp can be very slow

    child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        completed = true;
        console.error(`[yt-dlp] Process error: ${err.message}`);
        reject(err);
    });

    child.on('close', (code) => {
        clearTimeout(timeoutHandle);
        completed = true;
        console.log(`[yt-dlp] Exit code: ${code}, output length: ${stdout.length}`);
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

const getCachedSearch = (query, limit) => {
    const key = `${query}|${limit}`;
    const cached = searchCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
        searchCache.delete(key);
        return null;
    }
    return cached.results;
};

const setCachedSearch = (query, limit, results) => {
    const key = `${query}|${limit}`;
    searchCache.set(key, {
        results,
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS
    });
};

const searchYoutube = async (query, limit) => {
    // Check server-side cache FIRST
    const cachedResults = getCachedSearch(query, limit);
    if (cachedResults) {
        console.log(`[Cache] Search hit: "${query.substring(0, 40)}" (${cachedResults.length} results)`);
        return cachedResults;
    }
    
    console.log(`[Search] Fetching: "${query}"`);
    
    // Try each Invidious instance until one works
    for (const instance of INVIDIOUS_INSTANCES) {
        try {
            const results = await searchInvidious(instance, query, limit);
            console.log(`[Search] Success (${instance}): ${results.length} results`);
            setCachedSearch(query, limit, results);
            return results;
        } catch (error) {
            console.error(`[Search] Failed on ${instance}: ${error.message}`);
        }
    }
    
    // If all Invidious instances fail, try yt-dlp fallback
    console.log(`[Search] All Invidious instances failed, trying yt-dlp...`);
    const results = await searchYoutubeFallback(query, limit);
    setCachedSearch(query, limit, results);
    return results;
};

const searchInvidious = (instance, query, limit) => {
    return new Promise((resolve, reject) => {
        const searchUrl = `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
        const timeout = setTimeout(() => {
            reject(new Error(`Invidious timeout (${instance})`));
        }, 8000);
        
        https.get(searchUrl, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 8000
        }, (res) => {
            clearTimeout(timeout);
            let body = '';
            
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        throw new Error(`HTTP ${res.statusCode}`);
                    }
                    
                    const data = JSON.parse(body);
                    if (!Array.isArray(data)) {
                        throw new Error('Invalid response format');
                    }
                    
                    const results = data
                        .filter(item => item.type === 'video' && item.videoId)
                        .slice(0, limit)
                        .map(item => ({
                            id: item.videoId,
                            title: item.title || 'Unknown',
                            artist: item.author || 'YouTube',
                            album: 'YouTube',
                            thumb: item.videoThumbnails?.[item.videoThumbnails.length - 1]?.url || 
                                    `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`,
                            duration: item.lengthSeconds ? Math.round(item.lengthSeconds) : null
                        }));
                    
                    if (results.length === 0) {
                        reject(new Error('No results'));
                    } else {
                        resolve(results);
                    }
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
};

const searchYoutubeFallback = async (query, limit) => {
    console.log(`[yt-dlp] Attempting fallback with aggressive flags...`);
    const searchLimit = Math.min(Math.ceil(limit * 1.1), 20);
    const json = await runYtDlp([
        '--dump-single-json',
        '--match-filters', '!is_live',
        '--extractor-args', 'youtube:player_client=web_embedded',
        `ytsearch${searchLimit}:${query}`
    ]);

    const data = JSON.parse(json);
    const filtered = (data.entries || []).filter((entry) => {
        if (!entry || !entry.id || !entry.title) return false;
        if (entry.availability !== undefined && entry.availability !== 'public') return false;
        if (entry.age_limit && entry.age_limit > 0) return false;
        if (entry.is_live) return false;
        return true;
    });

    const results = filtered.slice(0, limit).map((entry) => ({
        id: entry.id,
        title: entry.title,
        artist: entry.channel || entry.uploader || 'YouTube',
        album: 'YouTube',
        thumb: entry.thumbnails?.[1]?.url || entry.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
        duration: entry.duration ? Math.round(entry.duration) : null
    }));
    
    setCachedSearch(query, limit, results);
    return results;
};

const getStream = async (id) => {
    const cached = getCachedStream(id);
    if (cached) {
        return cached;
    }

    console.log(`[Stream] Getting audio for: ${id}`);
    
    // Try each Invidious instance
    for (const instance of INVIDIOUS_INSTANCES) {
        try {
            const result = await getStreamInvidious(instance, id);
            console.log(`[Stream] Success (${instance}): ${result.title}`);
            setCachedStream(id, result);
            return result;
        } catch (error) {
            console.error(`[Stream] Failed on ${instance}: ${error.message}`);
        }
    }
    
    // Fallback to yt-dlp
    console.log(`[Stream] All Invidious instances failed, trying yt-dlp...`);
    const result = await getStreamFallback(id);
    setCachedStream(id, result);
    return result;
};

const getStreamInvidious = (instance, id) => {
    return new Promise((resolve, reject) => {
        const videoUrl = `${instance}/api/v1/videos/${id}`;
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout (${instance})`));
        }, 10000);
        
        https.get(videoUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 10000
        }, (res) => {
            clearTimeout(timeout);
            let body = '';
            
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        throw new Error(`HTTP ${res.statusCode}`);
                    }
                    
                    const data = JSON.parse(body);
                    
                    // Find best audio format
                    const audioFormats = (data.formatStreams || [])
                        .filter(f => f.type && f.type.includes('audio'))
                        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                    
                    if (!audioFormats.length) {
                        throw new Error('No audio available');
                    }
                    
                    const preferred = audioFormats[0];
                    const streamUrl = `${instance}${preferred.url}`;
                    
                    const result = {
                        id: data.videoId,
                        title: data.title || 'Unknown',
                        artist: data.author || 'YouTube',
                        album: 'YouTube',
                        thumb: data.videoThumbnails?.[data.videoThumbnails.length - 1]?.url || 
                                `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                        duration: data.lengthSeconds ? Math.round(data.lengthSeconds) : null,
                        streamUrl: streamUrl,
                        mimeType: 'audio/aac',
                        proxyUrl: `/api/yt/audio?id=${encodeURIComponent(id)}`
                    };
                    
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
};

const getStreamFallback = async (id) => {
    console.log(`[yt-dlp] Attempting fallback for stream: ${id}`);
    
    const json = await runYtDlp([
        '--dump-single-json',
        '-f',
        'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        '--extractor-args', 'youtube:player_client=web_embedded',
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
            console.log(`[API] Search request: "${query.substring(0, 50)}" limit=${limit}`);
            try {
                const results = await searchYoutube(query, limit);
                console.log(`[API] Search success: ${results.length} results`);
                sendJson(res, 200, { status: 200, message: 'success', response: results }, req);
            } catch (error) {
                console.error(`[API] Search error: ${error.message}`);
                sendJson(res, 500, { status: 500, message: error.message, response: [] }, req);
            }
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
