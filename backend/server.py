from fastapi import FastAPI, APIRouter, Request, Response
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import logging
import time
import httpx
from pathlib import Path
from urllib.parse import quote

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# JioSaavn API instances (no auth required, direct audio URLs)
SAAVN_INSTANCES = [
    'https://jiosaavn-api-privatecvc2.vercel.app',
]

SEARCH_CACHE_TTL = 15 * 60  # 15 min
search_cache = {}
song_cache = {}  # Cache song stream URLs from search results


def get_cached_search(key):
    cached = search_cache.get(key)
    if not cached:
        return None
    if cached['expires_at'] < time.time():
        del search_cache[key]
        return None
    return cached['results']


def set_cached_search(key, results):
    search_cache[key] = {'results': results, 'expires_at': time.time() + SEARCH_CACHE_TTL}


def parse_saavn_song(song):
    """Convert JioSaavn song data to our format."""
    download_urls = song.get('downloadUrl', [])
    # Get highest quality audio URL (320kbps)
    audio_url = ''
    for dl in reversed(download_urls):
        if dl.get('link'):
            audio_url = dl['link']
            break

    images = song.get('image', [])
    thumb = ''
    for img in reversed(images):
        if img.get('link'):
            thumb = img['link']
            break

    duration = int(song.get('duration', 0)) if song.get('duration') else None

    return {
        'id': song.get('id', ''),
        'title': song.get('name', 'Unknown'),
        'artist': song.get('primaryArtists', '') or song.get('subtitle', 'Unknown'),
        'album': song.get('album', {}).get('name', '') if isinstance(song.get('album'), dict) else str(song.get('album', '')),
        'thumb': thumb,
        'duration': duration,
        'streamUrl': audio_url,
        'language': song.get('language', ''),
        'year': song.get('year', ''),
        'playCount': song.get('playCount', ''),
    }


async def search_saavn(query, limit=20):
    cache_key = f"{query}|{limit}"
    cached = get_cached_search(cache_key)
    if cached:
        logger.info(f"[Cache] Search hit: '{query[:40]}' ({len(cached)} results)")
        return cached

    logger.info(f"[Search] Fetching: '{query}'")
    async with httpx.AsyncClient(timeout=15.0) as client:
        for instance in SAAVN_INSTANCES:
            try:
                url = f"{instance}/search/songs"
                resp = await client.get(url, params={'query': query, 'limit': limit})
                if resp.status_code != 200:
                    logger.error(f"[Search] {instance}: HTTP {resp.status_code}")
                    continue

                data = resp.json()
                raw_results = data.get('data', {}).get('results', [])
                results = [parse_saavn_song(s) for s in raw_results if s.get('id')]
                # Filter out songs without audio
                results = [r for r in results if r['streamUrl']]
                # Cache individual songs for audio playback
                for r in results:
                    song_cache[r['id']] = r

                if results:
                    logger.info(f"[Search] Success ({instance}): {len(results)} results")
                    set_cached_search(cache_key, results)
                    return results
                logger.warning(f"[Search] {instance}: No results for '{query}'")
            except Exception as e:
                logger.error(f"[Search] {instance} error: {e}")

    raise Exception(f"No results found for '{query}'")


async def get_song_details(song_id):
    """Get song details by ID - from cache (populated by search)."""
    cached = song_cache.get(song_id)
    if cached:
        return cached
    # If not in cache, search for the song ID
    async with httpx.AsyncClient(timeout=15.0) as client:
        for instance in SAAVN_INSTANCES:
            try:
                # Try searching by song ID
                url = f"{instance}/search/songs"
                resp = await client.get(url, params={'query': song_id, 'limit': 5})
                if resp.status_code == 200:
                    data = resp.json()
                    raw_results = data.get('data', {}).get('results', [])
                    for s in raw_results:
                        parsed = parse_saavn_song(s)
                        if parsed.get('id') == song_id and parsed.get('streamUrl'):
                            song_cache[song_id] = parsed
                            return parsed
            except Exception as e:
                logger.error(f"[Song] {instance} error: {e}")
    return None


# ===== API Routes =====

@api_router.get("/yt/search")
async def yt_search(q: str = '', limit: int = 20):
    if not q.strip():
        return JSONResponse(status_code=400, content={'status': 400, 'message': 'Missing q parameter', 'response': []})
    limit = max(1, min(50, limit))
    logger.info(f"[API] Search: '{q[:50]}' limit={limit}")
    try:
        results = await search_saavn(q, limit)
        return {'status': 200, 'message': 'success', 'response': results}
    except Exception as e:
        logger.error(f"[API] Search error: {e}")
        return JSONResponse(status_code=500, content={'status': 500, 'message': str(e), 'response': []})


@api_router.get("/yt/stream")
async def yt_stream(id: str = ''):
    if not id.strip():
        return JSONResponse(status_code=400, content={'status': 400, 'message': 'Missing id parameter', 'response': None})
    try:
        song = await get_song_details(id)
        if not song or not song.get('streamUrl'):
            return JSONResponse(status_code=404, content={'status': 404, 'message': 'Song not found', 'response': None})
        return {'status': 200, 'message': 'success', 'response': song}
    except Exception as e:
        logger.error(f"[API] Stream error: {e}")
        return JSONResponse(status_code=500, content={'status': 500, 'message': str(e), 'response': None})


@api_router.get("/yt/audio")
async def yt_audio(request: Request, id: str = ''):
    """Proxy audio for the given song ID."""
    if not id.strip():
        return JSONResponse(status_code=400, content={'status': 400, 'message': 'Missing id parameter', 'response': None})
    try:
        song = await get_song_details(id)
        if not song or not song.get('streamUrl'):
            return JSONResponse(status_code=404, content={'status': 404, 'message': 'Song not found', 'response': None})

        stream_url = song['streamUrl']
        proxy_headers = {}
        if request.headers.get('range'):
            proxy_headers['Range'] = request.headers['range']

        async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
            upstream = await client.get(stream_url, headers=proxy_headers)

            response_headers = {
                'Content-Type': upstream.headers.get('content-type', 'audio/mp4'),
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600',
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
        logger.error(f"[API] Audio error: {e}")
        return JSONResponse(status_code=502, content={'status': 502, 'message': f'Audio failed: {e}', 'response': None})


@api_router.get("/")
async def root():
    return {"message": "SpotiClone API running (JioSaavn)"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
