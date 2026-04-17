from fastapi import FastAPI, APIRouter, Request, Response
from fastapi.responses import StreamingResponse, JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import logging
import asyncio
import json
import time
import httpx
from pathlib import Path
from urllib.parse import urlencode, quote

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

app = FastAPI()
api_router = APIRouter(prefix="/api")

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Constants
STREAM_CACHE_TTL = 10 * 60  # 10 min
SEARCH_CACHE_TTL = 15 * 60  # 15 min

INVIDIOUS_INSTANCES = [
    'https://inv.thepixora.com',
    'https://iv.nboeck.de',
    'https://yewtu.be',
    'https://invidious.nerdvpn.de',
]

# Caches
stream_cache = {}
search_cache = {}


def get_cached_stream(video_id):
    cached = stream_cache.get(video_id)
    if not cached:
        return None
    if cached['expires_at'] < time.time():
        del stream_cache[video_id]
        return None
    return cached['value']


def set_cached_stream(video_id, value):
    stream_cache[video_id] = {'value': value, 'expires_at': time.time() + STREAM_CACHE_TTL}


def get_cached_search(query, limit):
    key = f"{query}|{limit}"
    cached = search_cache.get(key)
    if not cached:
        return None
    if cached['expires_at'] < time.time():
        del search_cache[key]
        return None
    return cached['results']


def set_cached_search(query, limit, results):
    key = f"{query}|{limit}"
    search_cache[key] = {'results': results, 'expires_at': time.time() + SEARCH_CACHE_TTL}


async def search_invidious(client, instance, query, limit):
    search_url = f"{instance}/api/v1/search"
    params = {'q': query, 'type': 'video'}
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}

    resp = await client.get(search_url, params=params, headers=headers, timeout=8.0)
    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code}")
    data = resp.json()

    if not isinstance(data, list):
        raise ValueError("Invalid response format")

    results = []
    for item in data:
        if item.get('type') != 'video' or not item.get('videoId'):
            continue
        thumbs = item.get('videoThumbnails', [])
        thumb = thumbs[-1]['url'] if thumbs else f"https://i.ytimg.com/vi/{item['videoId']}/hqdefault.jpg"
        results.append({
            'id': item['videoId'],
            'title': item.get('title', 'Unknown'),
            'artist': item.get('author', 'YouTube'),
            'album': 'YouTube',
            'thumb': thumb,
            'duration': round(item['lengthSeconds']) if item.get('lengthSeconds') else None,
        })
        if len(results) >= limit:
            break

    if not results:
        raise ValueError("No results")
    return results


async def search_ytdlp_fallback(query, limit):
    logger.info(f"[yt-dlp] Fallback search: {query}")
    search_limit = min(int(limit * 1.1), 20)
    python_bin = '/root/.venv/bin/python3'
    cmd = [
        python_bin, '-m', 'yt_dlp',
        '--no-warnings', '--no-check-certificate', '--geo-bypass', '-q',
        '--ignore-errors',
        '--dump-single-json',
        '--flat-playlist',
        f'ytsearch{search_limit}:{query}'
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=90)
    except asyncio.TimeoutError:
        proc.kill()
        raise Exception("Search timed out")

    stdout_str = stdout.decode().strip()
    if not stdout_str:
        err = stderr.decode().strip()
        raise Exception(err or f"yt-dlp returned no output (code {proc.returncode})")

    data = json.loads(stdout_str)
    entries = data.get('entries', [])
    results = []
    for entry in entries:
        if not entry or not entry.get('id') or not entry.get('title'):
            continue
        thumb = f"https://i.ytimg.com/vi/{entry['id']}/hqdefault.jpg"
        if entry.get('thumbnails'):
            thumbs = entry['thumbnails']
            thumb = thumbs[1]['url'] if len(thumbs) > 1 else thumbs[0].get('url', thumb)
        results.append({
            'id': entry['id'],
            'title': entry['title'],
            'artist': entry.get('channel') or entry.get('uploader') or 'YouTube',
            'album': 'YouTube',
            'thumb': thumb,
            'duration': round(entry['duration']) if entry.get('duration') else None,
        })
        if len(results) >= limit:
            break
        if len(results) >= limit:
            break
    return results


async def search_youtube(query, limit):
    cached = get_cached_search(query, limit)
    if cached:
        logger.info(f"[Cache] Search hit: '{query[:40]}' ({len(cached)} results)")
        return cached

    logger.info(f"[Search] Fetching: '{query}'")
    async with httpx.AsyncClient() as client:
        for instance in INVIDIOUS_INSTANCES:
            try:
                results = await search_invidious(client, instance, query, limit)
                logger.info(f"[Search] Success ({instance}): {len(results)} results")
                set_cached_search(query, limit, results)
                return results
            except Exception as e:
                logger.error(f"[Search] Failed on {instance}: {e}")

    # Fallback to yt-dlp
    logger.info("[Search] All Invidious instances failed, trying yt-dlp...")
    results = await search_ytdlp_fallback(query, limit)
    set_cached_search(query, limit, results)
    return results


async def get_stream_invidious(client, instance, video_id):
    video_url = f"{instance}/api/v1/videos/{video_id}"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}

    resp = await client.get(video_url, headers=headers, timeout=10.0)
    if resp.status_code != 200:
        raise ValueError(f"HTTP {resp.status_code}")
    data = resp.json()

    audio_formats = [
        f for f in data.get('adaptiveFormats', [])
        if f.get('type', '').startswith('audio/')
    ]
    audio_formats.sort(key=lambda f: f.get('bitrate', 0), reverse=True)

    if not audio_formats:
        raise ValueError("No audio available")

    preferred = audio_formats[0]
    stream_url = preferred.get('url', '')
    if not stream_url.startswith('http'):
        stream_url = f"{instance}{stream_url}"

    return {
        'id': data.get('videoId', video_id),
        'title': data.get('title', 'Unknown'),
        'artist': data.get('author', 'YouTube'),
        'album': 'YouTube',
        'thumb': data.get('videoThumbnails', [{}])[-1].get('url', f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg") if data.get('videoThumbnails') else f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        'duration': round(data['lengthSeconds']) if data.get('lengthSeconds') else None,
        'streamUrl': stream_url,
        'mimeType': preferred.get('type', 'audio/mp4').split(';')[0],
        'proxyUrl': f"/api/yt/audio?id={quote(video_id)}",
    }


async def get_stream_ytdlp_fallback(video_id):
    logger.info(f"[yt-dlp] Fallback stream: {video_id}")
    python_bin = '/root/.venv/bin/python3'
    cmd = [
        python_bin, '-m', 'yt_dlp',
        '--no-warnings', '--no-check-certificate', '--geo-bypass', '-q',
        '--dump-single-json',
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
        '--extractor-args', 'youtube:player_client=web_embedded',
        f'https://www.youtube.com/watch?v={video_id}'
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=90)
    except asyncio.TimeoutError:
        proc.kill()
        raise Exception("Stream fetch timed out")

    if proc.returncode != 0:
        err = stderr.decode().strip().lower()
        if 'sign in' in err or 'age-restricted' in err:
            raise Exception('This track is age-restricted.')
        if 'unavailable' in err or 'private video' in err:
            raise Exception('This track is unavailable.')
        raise Exception(stderr.decode().strip() or f"yt-dlp exited with code {proc.returncode}")

    data = json.loads(stdout.decode())
    if data.get('availability') and data['availability'] != 'public':
        raise Exception('This track is unavailable.')
    if data.get('age_limit', 0) > 0:
        raise Exception('This track is age-restricted.')

    audio_formats = [
        f for f in data.get('formats', [])
        if f.get('acodec') and f['acodec'] != 'none' and f.get('vcodec') == 'none' and f.get('url')
    ]
    preferred = next((f for f in audio_formats if f.get('ext') == 'm4a'), None) \
             or next((f for f in audio_formats if f.get('ext') == 'webm'), None) \
             or (audio_formats[-1] if audio_formats else None)

    if not preferred or not preferred.get('url'):
        raise Exception('No playable audio stream found')

    ext = preferred.get('ext', 'mp4')
    mime_map = {'m4a': 'audio/mp4', 'webm': 'audio/webm'}
    mime_type = mime_map.get(ext, 'audio/mpeg')

    return {
        'id': data['id'],
        'title': data.get('title', 'Unknown'),
        'artist': data.get('channel') or data.get('uploader') or 'YouTube',
        'album': 'YouTube',
        'thumb': data.get('thumbnail', f"https://i.ytimg.com/vi/{data['id']}/hqdefault.jpg"),
        'duration': round(data['duration']) if data.get('duration') else None,
        'streamUrl': preferred['url'],
        'mimeType': mime_type,
        'proxyUrl': f"/api/yt/audio?id={quote(data['id'])}",
    }


async def get_stream(video_id):
    cached = get_cached_stream(video_id)
    if cached:
        return cached

    logger.info(f"[Stream] Getting audio for: {video_id}")
    async with httpx.AsyncClient() as client:
        for instance in INVIDIOUS_INSTANCES:
            try:
                result = await get_stream_invidious(client, instance, video_id)
                logger.info(f"[Stream] Success ({instance}): {result['title']}")
                set_cached_stream(video_id, result)
                return result
            except Exception as e:
                logger.error(f"[Stream] Failed on {instance}: {e}")

    # Fallback
    logger.info("[Stream] All Invidious failed, trying yt-dlp...")
    result = await get_stream_ytdlp_fallback(video_id)
    set_cached_stream(video_id, result)
    return result


# ===== API Routes =====

@api_router.get("/yt/search")
async def yt_search(q: str = '', limit: int = 20):
    if not q.strip():
        return JSONResponse(status_code=400, content={'status': 400, 'message': 'Missing q parameter', 'response': []})
    limit = max(1, min(50, limit))
    logger.info(f"[API] Search request: '{q[:50]}' limit={limit}")
    try:
        results = await search_youtube(q, limit)
        logger.info(f"[API] Search success: {len(results)} results")
        return {'status': 200, 'message': 'success', 'response': results}
    except Exception as e:
        logger.error(f"[API] Search error: {e}")
        return JSONResponse(status_code=500, content={'status': 500, 'message': str(e), 'response': []})


@api_router.get("/yt/stream")
async def yt_stream(id: str = ''):
    if not id.strip():
        return JSONResponse(status_code=400, content={'status': 400, 'message': 'Missing id parameter', 'response': None})
    try:
        result = await get_stream(id)
        return {'status': 200, 'message': 'success', 'response': result}
    except Exception as e:
        logger.error(f"[API] Stream error: {e}")
        return JSONResponse(status_code=500, content={'status': 500, 'message': str(e), 'response': None})


@api_router.get("/yt/audio")
async def yt_audio(request: Request, id: str = ''):
    if not id.strip():
        return JSONResponse(status_code=400, content={'status': 400, 'message': 'Missing id parameter', 'response': None})
    try:
        stream_info = await get_stream(id)
        stream_url = stream_info['streamUrl']

        headers = {}
        if request.headers.get('range'):
            headers['Range'] = request.headers['range']

        async with httpx.AsyncClient(follow_redirects=True) as client:
            upstream = await client.get(stream_url, headers=headers, timeout=30.0)

            response_headers = {
                'Content-Type': upstream.headers.get('content-type', stream_info.get('mimeType', 'audio/mpeg')),
                'Cache-Control': 'no-store',
                'Accept-Ranges': upstream.headers.get('accept-ranges', 'bytes'),
                'Access-Control-Allow-Origin': '*',
            }
            if 'content-length' in upstream.headers:
                response_headers['Content-Length'] = upstream.headers['content-length']
            if 'content-range' in upstream.headers:
                response_headers['Content-Range'] = upstream.headers['content-range']

            return Response(
                content=upstream.content,
                status_code=upstream.status_code,
                headers=response_headers,
            )
    except Exception as e:
        logger.error(f"[API] Audio proxy error: {e}")
        return JSONResponse(status_code=502, content={'status': 502, 'message': f'Audio proxy failed: {e}', 'response': None})


@api_router.get("/")
async def root():
    return {"message": "SpotiClone API running"}


# Include the router
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
