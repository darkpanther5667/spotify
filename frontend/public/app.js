// ============================================================
// SpotiClone — Local YouTube backend
// ============================================================

const API_BASE = '/api/yt';
const fallbackThumb = 'https://via.placeholder.com/200x200/333/fff.png?text=Music';
const SEARCH_CACHE_TTL = 30 * 60 * 1000; // 30 min cache for searches
const REQUEST_TIMEOUT = 90000; // 90 second timeout

let songs = [];
let currentIndex = -1;
let currentView = 'home';
let activeLibraryGenre = 'bollywood';
let isShuffle = false;
let repeatMode = 0;
let liked = new Set();
let prevVolume = 0.7;
let currentAbortController = null;

// Search result cache
const searchCache = new Map();
const getCachedSearch = (key) => {
    const cached = searchCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
        searchCache.delete(key);
        return null;
    }
    return cached.results;
};
const setCachedSearch = (key, results) => {
    searchCache.set(key, { results, expiresAt: Date.now() + SEARCH_CACHE_TTL });
};

const audio = document.getElementById('audio-player');
const playPauseBtn = document.getElementById('main-play-pause');
const playIcon = document.getElementById('play-icon');
const progressFill = document.getElementById('progress-bar-fill');
const progressBg = document.getElementById('progress-bar-bg');
const currentTimeEl = document.getElementById('current-time');
const totalTimeEl = document.getElementById('total-time');
const albumArt = document.getElementById('current-album-art');
const trackNameEl = document.getElementById('current-track-name');
const artistNameEl = document.getElementById('current-artist-name');
const volumeFill = document.getElementById('volume-bar-fill');
const volumeBg = document.getElementById('volume-bar-bg');
const likeBtn = document.getElementById('like-btn');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const runtimeBanner = document.getElementById('runtime-banner');

const toggleSidebar = () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    sidebar.classList.toggle('open');
    overlay.classList.toggle('show');
};

const fmtSec = (seconds) => {
    if (!seconds || Number.isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const showRuntimeBanner = (message) => {
    runtimeBanner.innerHTML = message;
    runtimeBanner.style.display = 'block';
};

const clearRuntimeBanner = () => {
    runtimeBanner.innerHTML = '';
    runtimeBanner.style.display = 'none';
};

const updatePlayIcon = (playing) => {
    playIcon.classList.toggle('bx-pause', playing);
    playIcon.classList.toggle('bx-play', !playing);
};

const setPlaybackTime = (currentTime, duration) => {
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const safeCurrent = Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0;
    const pct = safeDuration > 0 ? (safeCurrent / safeDuration) * 100 : 0;
    progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    currentTimeEl.textContent = fmtSec(safeCurrent);
    totalTimeEl.textContent = fmtSec(safeDuration);
};

const updateVolumeIcon = (volume) => {
    const icon = document.getElementById('volume-icon');
    icon.className = volume === 0 ? 'bx bx-volume-mute' : volume < 0.4 ? 'bx bx-volume-low' : 'bx bx-volume-full';
};

const setVolume = (volume) => {
    const safe = Math.max(0, Math.min(1, volume));
    audio.volume = safe;
    prevVolume = safe;
    volumeFill.style.width = `${safe * 100}%`;
    updateVolumeIcon(safe);
};

const apiGet = async (path, params = {}, signal = null) => {
    const qs = new URLSearchParams(params);
    const cacheKey = `${path}?${qs.toString()}`;
    
    // Return cached search results if available
    if (path === '/search') {
        const cached = getCachedSearch(cacheKey);
        if (cached) return cached;
    }
    
    // Wrap with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const finalSignal = signal || controller.signal;
    
    try {
        const response = await fetch(`${API_BASE}${path}?${qs.toString()}`, { signal: finalSignal });
        const data = await response.json();
        if (!response.ok || data.status !== 200) {
            throw new Error(data.message || `Request failed (${response.status})`);
        }
        
        // Cache search results
        if (path === '/search') {
            setCachedSearch(cacheKey, data.response);
        }
        
        return data.response;
    } finally {
        clearTimeout(timeoutId);
    }
};

const searchSongs = async (query, limit = 20, signal = null) => {
    return apiGet('/search', { q: query, limit }, signal);
};

const getStreamInfo = async (id, signal = null) => {
    return apiGet('/stream', { id }, signal);
};

const updateNowPlaying = (song) => {
    albumArt.src = song.thumb || fallbackThumb;
    albumArt.onerror = () => { albumArt.src = fallbackThumb; };
    trackNameEl.textContent = song.title;
    artistNameEl.textContent = song.artist;
    document.title = `${song.title} — SpotiClone`;
    likeBtn.classList.toggle('liked', liked.has(song.id));

    document.querySelectorAll('.track-row').forEach((row) => {
        row.classList.toggle('playing', row.dataset.songId === song.id);
    });
};

const isUnavailableError = (message) => {
    return /sign in|age-restricted|unavailable|private video/i.test(message);
};

const ensureStreamUrl = async (song) => {
    // Always use proxy URL to avoid CORS issues
    song.streamUrl = `${API_BASE}/audio?id=${encodeURIComponent(song.id)}`;
    return song;
};

const playSongAtIndex = async (index) => {
    if (index < 0 || index >= songs.length) return;
    currentIndex = index;
    const song = songs[index];
    updateNowPlaying(song);
    artistNameEl.textContent = `${song.artist} • Loading stream...`;

    try {
        await ensureStreamUrl(song);
        audio.src = song.streamUrl;
        audio.load();
        await audio.play();
        artistNameEl.textContent = song.artist;
        if (song.duration) {
            totalTimeEl.textContent = fmtSec(song.duration);
        }
    } catch (error) {
        console.error('Playback failed:', error);
        song.unavailable = true;
        song.errorReason = error.message;
        if (isUnavailableError(error.message)) {
            artistNameEl.textContent = 'This track cannot be played because it requires YouTube sign-in or is unavailable.';
        } else {
            artistNameEl.textContent = `Playback failed: ${error.message}`;
        }
        updatePlayIcon(false);
    }
};

const renderTrackList = (tracks, containerId) => {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    if (!tracks.length) {
        container.innerHTML = `<div class="error-msg"><i class='bx bx-search-alt'></i>No songs found</div>`;
        return;
    }

    // Use document fragment for better performance
    const fragment = document.createDocumentFragment();
    
    tracks.forEach((track, index) => {
        const row = document.createElement('div');
        const unavailableClass = track.unavailable ? ' unavailable' : '';
        row.className = 'track-row' + (songs[currentIndex]?.id === track.id ? ' playing' : '') + unavailableClass;
        row.dataset.songId = track.id;
        row.innerHTML = `
            <div class="col-num"><span class="row-index">${index + 1}</span><i class='bx bx-play row-play-icon'></i></div>
            <div class="col-title">
                <img src="" data-src="${escapeHtml(track.thumb)}" alt="art" loading="lazy" onerror="this.src='${fallbackThumb}'">
                <div class="title-info">
                    <div class="t-name">${escapeHtml(track.title)}</div>
                    <div class="t-artist">${escapeHtml(track.artist)}</div>
                </div>
            </div>
            <div class="col-album">${escapeHtml(track.album || 'YouTube')}</div>
            <div class="col-time">${track.duration ? fmtSec(track.duration) : '--:--'}</div>
        `;
        row.addEventListener('click', () => {
            if (track.unavailable) {
                artistNameEl.textContent = 'This track is unavailable and cannot be played.';
                updatePlayIcon(false);
                return;
            }
            songs = tracks;
            playSongAtIndex(index);
        });
        fragment.appendChild(row);
    });
    
    container.appendChild(fragment);

    // Lazy load images
    if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        delete img.dataset.src;
                    }
                    obs.unobserve(img);
                }
            });
        });
        container.querySelectorAll('img[data-src]').forEach(img => imageObserver.observe(img));
    } else {
        // Fallback for older browsers
        container.querySelectorAll('img[data-src]').forEach(img => {
            img.src = img.dataset.src;
        });
    }
};

const renderCardGrid = (tracks, containerId) => {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    tracks.slice(0, 6).forEach((track, index) => {
        const card = document.createElement('div');
        card.className = 'album-card';
        card.innerHTML = `
            <img src="" data-src="${escapeHtml(track.thumb)}" alt="art" loading="lazy" onerror="this.src='${fallbackThumb}'">
            <h4>${escapeHtml(track.title)}</h4>
            <p>${escapeHtml(track.artist)}</p>
            <button class="album-play"><i class='bx bx-play'></i></button>
        `;
        card.addEventListener('click', () => {
            songs = tracks;
            playSongAtIndex(index);
        });
        card.querySelector('.album-play').addEventListener('click', (event) => {
            event.stopPropagation();
            songs = tracks;
            playSongAtIndex(index);
        });
        container.appendChild(card);
    });

    // Lazy load images
    if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        delete img.dataset.src;
                    }
                    obs.unobserve(img);
                }
            });
        });
        container.querySelectorAll('img[data-src]').forEach(img => imageObserver.observe(img));
    } else {
        // Fallback for older browsers
        container.querySelectorAll('img[data-src]').forEach(img => {
            img.src = img.dataset.src;
        });
    }
};

const renderRecentGrid = (tracks, containerId) => {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    tracks.slice(0, 6).forEach((track, index) => {
        const card = document.createElement('div');
        card.className = 'recent-card';
        card.innerHTML = `
            <img src="" data-src="${escapeHtml(track.thumb)}" alt="art" loading="lazy" onerror="this.src='${fallbackThumb}'">
            <span>${escapeHtml(track.title)}</span>
            <button class="card-play"><i class='bx bx-play'></i></button>
        `;
        card.addEventListener('click', () => {
            songs = tracks;
            playSongAtIndex(index);
        });
        card.querySelector('.card-play').addEventListener('click', (event) => {
            event.stopPropagation();
            songs = tracks;
            playSongAtIndex(index);
        });
        container.appendChild(card);
    });

    // Lazy load images
    if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        delete img.dataset.src;
                    }
                    obs.unobserve(img);
                }
            });
        });
        container.querySelectorAll('img[data-src]').forEach(img => imageObserver.observe(img));
    } else {
        // Fallback for older browsers
        container.querySelectorAll('img[data-src]').forEach(img => {
            img.src = img.dataset.src;
        });
    }
};

const syncGenrePills = (genre) => {
    const labels = {
        bollywood: 'Bollywood',
        punjabi: 'Punjabi',
        'indie+india': 'Indie',
        '90s+bollywood': '90s Hits'
    };
    const target = labels[genre];
    document.querySelectorAll('.genre-pill').forEach((button) => {
        button.classList.toggle('active', button.textContent.trim() === target);
    });
};

const loadGenreToList = async (genre, containerId) => {
    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;
    const container = document.getElementById(containerId);
    container.innerHTML = `<div class="loading-spinner"><div class="spinner"></div> Loading ${genre}...</div>`;

    try {
        const tracks = await searchSongs(genre, 20, signal);
        renderTrackList(tracks, containerId);
        clearRuntimeBanner();
    } catch (error) {
        if (error.name === 'AbortError') return;
        container.innerHTML = `<div class="error-msg"><i class='bx bx-error'></i>${escapeHtml(error.message)}</div>`;
        showRuntimeBanner(`<strong>Search backend failed.</strong> ${escapeHtml(error.message)}`);
    }
};

const loadHome = async () => {
    const hour = new Date().getHours();
    document.getElementById('greeting').textContent = hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';

    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    // Show skeletons immediately
    const show = (containerId) => document.getElementById(containerId).style.display = 'block';
    show('featured-grid');
    show('trending-grid');
    show('new-releases-grid');
    
    try {
        // Load SEQUENTIALLY (not parallel) to avoid overwhelming yt-dlp
        // Featured section first (most visible)
        const featured = await searchSongs('bollywood hits songs', 10, signal);
        renderRecentGrid(featured, 'featured-grid');
        showRuntimeBanner('Featured loaded. Loading trending...');
        
        // Then trending
        const trending = await searchSongs('punjabi hits songs', 10, signal);
        renderCardGrid(trending, 'trending-grid');
        showRuntimeBanner('Trending loaded. Loading new releases...');
        
        // Finally new releases
        const releases = await searchSongs('new hindi songs', 10, signal);
        renderCardGrid(releases, 'new-releases-grid');
        
        clearRuntimeBanner();
    } catch (error) {
        if (error.name === 'AbortError') return;
        showRuntimeBanner(`<strong>Home feed failed.</strong> ${escapeHtml(error.message)}`);
    }
};

window.navigate = (view) => {
    if (currentAbortController) currentAbortController.abort();
    currentView = view;

    document.querySelectorAll('.view').forEach((section) => {
        section.style.display = 'none';
    });
    document.getElementById(`view-${view}`).style.display = 'block';

    document.querySelectorAll('.sidebar-nav li').forEach((item) => item.classList.remove('active'));
    document.getElementById(`nav-${view}`).classList.add('active');

    const topbarSearch = document.getElementById('topbar-search');
    topbarSearch.style.display = view === 'search' ? 'flex' : 'none';

    if (view === 'search') {
        setTimeout(() => searchInput.focus(), 100);
    }

    if (view === 'home') {
        loadHome();
    }

    if (view === 'library') {
        syncGenrePills(activeLibraryGenre);
        loadGenreToList(activeLibraryGenre, 'library-list');
    }
};

window.loadGenre = async (genre, btnEl) => {
    activeLibraryGenre = genre;
    if (currentView !== 'library') {
        navigate('library');
        return;
    }

    if (btnEl) {
        document.querySelectorAll('.genre-pill').forEach((button) => button.classList.remove('active'));
        btnEl.classList.add('active');
    } else {
        syncGenrePills(genre);
    }

    await loadGenreToList(genre, 'library-list');
};

window.searchQuery = async (query) => {
    navigate('search');
    searchInput.value = query;
    searchClear.style.display = 'block';
    performSearch(query);
};

const performSearch = async (query) => {
    if (!query.trim()) return;

    currentAbortController = new AbortController();
    const signal = currentAbortController.signal;

    document.getElementById('search-browse').style.display = 'none';
    document.getElementById('search-results').style.display = 'block';
    document.getElementById('search-results-title').textContent = `Results for "${query}"`;
    document.getElementById('search-results-list').innerHTML = `<div class="loading-spinner"><div class="spinner"></div> Searching...</div>`;

    try {
        const tracks = await searchSongs(query, 20, signal);
        renderTrackList(tracks, 'search-results-list');
        clearRuntimeBanner();
    } catch (error) {
        if (error.name === 'AbortError') return;
        document.getElementById('search-results-list').innerHTML = `<div class="error-msg"><i class='bx bx-error'></i>${escapeHtml(error.message)}</div>`;
        showRuntimeBanner(`<strong>Search failed.</strong> ${escapeHtml(error.message)}`);
    }
};

let searchDebounce;
searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    searchClear.style.display = query ? 'block' : 'none';

    if (!query) {
        document.getElementById('search-browse').style.display = 'block';
        document.getElementById('search-results').style.display = 'none';
        return;
    }

    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => performSearch(query), 800);
});

searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        clearTimeout(searchDebounce);
        performSearch(searchInput.value.trim());
    }
});

searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    document.getElementById('search-browse').style.display = 'block';
    document.getElementById('search-results').style.display = 'none';
    searchInput.focus();
});

playPauseBtn.addEventListener('click', () => {
    if (currentIndex === -1) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
});

progressBg.addEventListener('click', (event) => {
    if (!audio.duration) return;
    const ratio = (event.clientX - progressBg.getBoundingClientRect().left) / progressBg.offsetWidth;
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
});

volumeBg.addEventListener('click', (event) => {
    const ratio = (event.clientX - volumeBg.getBoundingClientRect().left) / volumeBg.offsetWidth;
    setVolume(ratio);
});

window.nextSong = () => {
    if (!songs.length) return;
    let next = currentIndex + 1;
    if (isShuffle) next = Math.floor(Math.random() * songs.length);
    if (next >= songs.length) {
        if (repeatMode === 1) next = 0;
        else return;
    }
    playSongAtIndex(next);
};

window.prevSong = () => {
    if (!songs.length) return;
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    let prev = currentIndex - 1;
    if (prev < 0) prev = songs.length - 1;
    playSongAtIndex(prev);
};

window.toggleShuffle = () => {
    isShuffle = !isShuffle;
    document.getElementById('shuffle-btn').classList.toggle('active', isShuffle);
};

window.toggleRepeat = () => {
    repeatMode = (repeatMode + 1) % 3;
    const btn = document.getElementById('repeat-btn');
    btn.classList.toggle('active', repeatMode > 0);
    btn.querySelector('i').className = repeatMode === 2 ? 'bx bx-repeat-1' : 'bx bx-repeat';
};

window.toggleMute = () => {
    if (audio.volume > 0) {
        prevVolume = audio.volume;
        setVolume(0);
    } else {
        setVolume(prevVolume || 0.7);
    }
};

likeBtn.addEventListener('click', () => {
    const id = songs[currentIndex]?.id;
    if (!id) return;
    if (liked.has(id)) liked.delete(id);
    else liked.add(id);
    likeBtn.classList.toggle('liked', liked.has(id));
});

document.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT') return;
    if (event.code === 'Space') {
        event.preventDefault();
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    }
    if (event.code === 'ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
    if (event.code === 'ArrowLeft' && audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10);
});

audio.addEventListener('play', () => updatePlayIcon(true));
audio.addEventListener('pause', () => updatePlayIcon(false));
audio.addEventListener('loadedmetadata', () => {
    if (songs[currentIndex] && !songs[currentIndex].duration && audio.duration) {
        songs[currentIndex].duration = Math.floor(audio.duration);
    }
    setPlaybackTime(audio.currentTime, audio.duration);
});
audio.addEventListener('timeupdate', () => setPlaybackTime(audio.currentTime, audio.duration));
audio.addEventListener('ended', () => {
    if (repeatMode === 2) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
    }
    nextSong();
});
audio.addEventListener('error', () => {
    artistNameEl.textContent = 'Audio stream failed.';
    updatePlayIcon(false);
});

window.testAPI = async () => {
    try {
        const results = await searchSongs('Arijit Singh', 5);
        alert(`Backend OK\nResults: ${results.length}`);
    } catch (error) {
        alert(`Backend failed\n${error.message}`);
    }
};

window.debugApp = () => {
    console.log('SpotiClone debug', {
        songs: songs.length,
        currentIndex,
        currentView,
        activeLibraryGenre,
        repeatMode,
        isShuffle,
        volume: audio.volume
    });
    alert(`Songs: ${songs.length}\nCurrent: ${currentIndex}\nView: ${currentView}`);
};

console.log('🚀 Starting SpotiClone with local yt-dlp backend...');
setVolume(prevVolume);
clearRuntimeBanner();
navigate('home');
setTimeout(() => loadHome(), 150);
