/* ============================================================
   musicVer · static web bridge
   Replaces the Python/pywebview engine on GitHub Pages.

   - live catalogue: saavn.sumit.co (CORS-enabled, no key)
   - audio: direct aac.saavncdn.com streams via HTMLAudioElement
   - account data: localStorage (same MV.store used by the desktop SPA)
   - local music: File System Access API / file input, files stay on device
   ============================================================ */

(function (MV) {
  'use strict';

  const DEFAULT_API = 'https://saavn.sumit.co/api';
  const API_BASE_KEY = 'musicver.web.apiBase';
  const CACHE_KEY = 'musicver.web.cache.v1';
  const DISCOVERY_KEY = 'musicver.web.discovery.v1';
  const LIBRARY_KEY = 'musicver.web.localLibrary.v1';
  const FOLDER_KEY = 'musicver.web.folderName';

  const apiBase = read(API_BASE_KEY) || DEFAULT_API;
  const streamCache = new Map();
  const localTracks = new Map();
  let folderName = read(FOLDER_KEY) || '';
  let playbackState = 'stopped';
  let switching = false;
  let currentTrack = null;
  let audio = null;
  let streamQueue = [];
  let streamIndex = 0;

  /* ---------------- small storage helpers ---------------- */

  function read(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* quota / private mode */ }
  }

  function decode(value) {
    const node = document.createElement('textarea');
    node.innerHTML = String(value == null ? '' : value);
    return node.value;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function hash(value) {
    let h = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
    return 'local-' + (h >>> 0).toString(36);
  }

  function bestImage(value) {
    if (Array.isArray(value)) {
      const image = value.find((item) => item && /500/.test(String(item.quality))) ||
        value[value.length - 1];
      return image && image.url ? image.url : '';
    }
    return typeof value === 'string' ? value : '';
  }

  function artistName(song) {
    const source = song.artists || song.primary_artists || song.artists_primary || '';
    if (Array.isArray(source)) {
      return decode(source.map((item) => item && item.name ? item.name : item).join(', '));
    }
    if (source && typeof source === 'object' && Array.isArray(source.primary)) {
      return decode(source.primary.map((item) => item.name || item).join(', '));
    }
    return decode(source || song.primaryArtists || song.singers || 'Unknown artist');
  }

  function albumName(value) {
    if (value && typeof value === 'object') return decode(value.name || value.title || 'Unknown album');
    return decode(value || 'Unknown album');
  }

  function loadObject(key, fallback) {
    try {
      const raw = read(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  /* ---------------- response normalisers ---------------- */

  function toTrackRaw(song) {
    if (!song) return null;
    const id = String(song.id || song.songId || hash(song.name || song.title));
    const cover = bestImage(song.image) || song.cover || song.thumbnail || '';
    const downloads = Array.isArray(song.downloadUrl)
      ? song.downloadUrl.map((item) => item && item.url).filter(Boolean)
      : [];
    if (downloads.length) streamCache.set(id, downloads);

    return {
      id: id,
      title: decode(song.title || song.name || 'Unknown title'),
      artist: artistName(song),
      album: albumName(song.album || song.album_name),
      duration: String(song.duration || 0),
      language: song.language || '',
      provider: 'jiosaavn',
      path: 'stream:jiosaavn:' + id,
      cover: cover,
      image: cover,
      downloadUrl: song.downloadUrl || [],
      raw: song
    };
  }

  function toAlbumRaw(album) {
    if (!album) return null;
    const cover = bestImage(album.image) || album.cover || '';
    const artists = album.artists && Array.isArray(album.artists.primary)
      ? album.artists.primary.map((item) => item.name).join(', ')
      : album.artist;
    return {
      id: String(album.id || hash(album.name || album.title)),
      title: decode(album.title || album.name || 'Unknown album'),
      artist: decode(artists || 'Unknown artist'),
      year: album.year || '',
      language: album.language || '',
      track_count: album.songCount || album.track_count || null,
      token: album.token || '',
      image: cover,
      cover: cover,
      raw: album
    };
  }

  function toArtistRaw(artist) {
    if (!artist) return null;
    const cover = bestImage(artist.image) || artist.cover || '';
    return {
      id: String(artist.id || hash(artist.name || artist.title)),
      name: decode(artist.name || artist.title || 'Unknown artist'),
      title: decode(artist.name || artist.title || 'Unknown artist'),
      listeners: artist.followerCount || artist.fanCount || null,
      token: artist.token || '',
      image: cover,
      cover: cover,
      raw: artist
    };
  }

  function seedTracks() {
    return (MV.webSeed || []).map((item) => ({
      id: String(item.id),
      title: decode(item.title),
      artist: decode(item.artist),
      album: decode(item.album),
      duration: String(item.duration || 0),
      language: item.language || '',
      provider: 'jiosaavn',
      path: 'stream:jiosaavn:' + item.id,
      cover: item.cover || '',
      image: item.cover || '',
      downloadUrl: item.stream ? [{ quality: '160kbps', url: item.stream }] : [],
      raw: item
    }));
  }

  function cachedTracks() {
    const cache = loadObject(CACHE_KEY, {});
    return Object.keys(cache).map((id) => {
      const item = cache[id];
      const streams = Array.isArray(item.streams) ? item.streams : (item.stream ? [item.stream] : []);
      if (streams.length) streamCache.set(id, streams);
      return {
        id: id,
        title: item.title || id,
        artist: item.artist || 'Saved track',
        album: item.album || 'Offline cache',
        duration: String(item.duration || 0),
        language: item.language || '',
        provider: 'jiosaavn',
        path: 'stream:jiosaavn:' + id,
        cover: item.cover || '',
        image: item.cover || '',
        downloadUrl: streams.map((url) => ({ url: url })),
        raw: item
      };
    });
  }

  function rememberStreams(songs) {
    const cache = loadObject(CACHE_KEY, {});
    (songs || []).forEach((song) => {
      if (!song || !song.id) return;
      const streams = streamCache.get(String(song.id));
      cache[String(song.id)] = {
        id: String(song.id),
        title: song.title,
        artist: song.artist,
        album: song.album,
        duration: song.duration,
        language: song.language,
        cover: song.cover,
        streams: streams || [],
        savedAt: Date.now()
      };
    });
    const keys = Object.keys(cache);
    if (keys.length > 240) {
      keys.sort((a, b) => (cache[a].savedAt || 0) - (cache[b].savedAt || 0));
      keys.slice(0, keys.length - 240).forEach((key) => delete cache[key]);
    }
    write(CACHE_KEY, JSON.stringify(cache));
  }

  function orderedStreams(urls) {
    const list = (urls || []).filter(Boolean);
    const markers = ['_160.', '_320.', '_96.', '_48.'];
    const ranked = [];
    markers.forEach((marker) => {
      list.forEach((url) => {
        if (String(url).indexOf(marker) >= 0) ranked.push(url);
      });
    });
    list.forEach((url) => ranked.push(url));
    return ranked.filter((url, index) => ranked.indexOf(url) === index);
  }

  /* ---------------- network ---------------- */

  async function apiFetch(path) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const options = { cache: 'no-store', headers: { Accept: 'application/json' } };
      if (controller) options.signal = controller.signal;
      const response = await fetch(apiBase + path, options);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function resultsOf(container) {
    return (container && Array.isArray(container.results)) ? container.results : [];
  }

  async function searchCatalogue(query) {
    const needle = encodeURIComponent(query);
    const [global, songResults] = await Promise.all([
      apiFetch('/search?query=' + needle),
      apiFetch('/search/songs?query=' + needle + '&limit=20')
    ]);
    const source = global && global.data ? global.data : {};
    // The dedicated song search includes downloadUrl values, so cache those
    // tracks; the global search is used for albums and artists.
    const songSource = songResults && songResults.data ? songResults.data : source.songs;
    const songs = resultsOf(songSource).map(toTrackRaw).filter(Boolean);
    const albums = resultsOf(source.albums).map(toAlbumRaw).filter(Boolean);
    const artists = resultsOf(source.artists).map(toArtistRaw).filter(Boolean);
    rememberStreams(songs.slice(0, 40));
    return { songs: songs, albums: albums, artists: artists };
  }

  function localMatches(query) {
    const needle = String(query || '').trim().toLowerCase();
    const pool = seedTracks().concat(cachedTracks());
    if (!needle) return { songs: pool, albums: [], artists: [] };
    const hit = (song) => [song.title, song.artist, song.album, song.language]
      .some((value) => String(value || '').toLowerCase().includes(needle));
    return { songs: pool.filter(hit), albums: [], artists: [] };
  }

  /* ---------------- HTML audio engine ---------------- */

  function getAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'metadata';
    audio.addEventListener('playing', () => { playbackState = 'playing'; });
    audio.addEventListener('pause', () => { if (!switching) playbackState = 'paused'; });
    audio.addEventListener('ended', () => { playbackState = 'ended'; });
    audio.addEventListener('error', () => {
      if (switching) return;
      playbackState = 'error';
      if (streamQueue.length <= streamIndex + 1) return;
      streamIndex += 1;
      const next = streamQueue[streamIndex];
      if (!next) return;
      switching = true;
      audio.src = next;
      audio.load();
      const retry = audio.play();
      if (retry && retry.catch) retry.catch(() => { playbackState = 'error'; });
      setTimeout(() => { switching = false; }, 0);
    });
    audio.addEventListener('waiting', () => { playbackState = 'loading'; });
    return audio;
  }

  function startPlayback(urls) {
    const list = orderedStreams(urls);
    if (!list.length) return Promise.reject(new Error('No playable stream found.'));
    streamQueue = list;
    streamIndex = 0;
    const element = getAudio();
    switching = true;
    element.pause();
    element.src = list[0];
    element.currentTime = 0;
    element.volume = clamp(MV.store.state.volume, 0, 100) / 100;
    element.load();
    playbackState = 'loading';
    setTimeout(() => { switching = false; }, 0);
    return element.play();
  }

  async function playJioSaavn(id) {
    const key = String(id || '').replace(/^stream:jiosaavn:/, '');
    let urls = streamCache.get(key);
    let track = null;

    if (!urls || !urls.length) {
      try {
        const data = await apiFetch('/songs?ids=' + encodeURIComponent(key));
        const song = data && Array.isArray(data.data) ? data.data[0] : null;
        if (!song) throw new Error('Track not found.');
        track = toTrackRaw(song);
        rememberStreams([track]);
        urls = streamCache.get(track.id);
      } catch (error) {
        track = seedTracks().find((item) => String(item.id) === key) || null;
        urls = track && streamCache.get(track.id);
      }
    }

    if (!track) {
      const all = seedTracks().concat(cachedTracks());
      track = all.find((item) => String(item.id) === key) || { id: key, duration: 0 };
    }
    currentTrack = track;

    try {
      await startPlayback(urls);
      return { success: true, source: apiBase };
    } catch (error) {
      playbackState = 'paused';
      return { success: false, message: 'Playback was blocked — click play again.' };
    }
  }

  async function playLocal(path) {
    const requested = String(path || '');
    const key = requested.indexOf('local:') === 0 ? requested.slice(6) : requested;
    let entry = localTracks.get(key) || Array.from(localTracks.values())
      .find((item) => String(item.raw && item.raw.path) === requested);
    if (!entry) {
      await restorePromise;
      entry = localTracks.get(key) || Array.from(localTracks.values())
        .find((item) => String(item.raw && item.raw.path) === requested);
    }
    if (!entry || !entry.url) {
      return { success: false, message: 'Choose your music folder again to play local files.' };
    }
    currentTrack = entry.raw;
    try {
      await startPlayback([entry.url]);
      return { success: true };
    } catch (error) {
      return { success: false, message: 'Playback was blocked — click play again.' };
    }
  }

  /* ---------------- local music folder ---------------- */

  function isAudioFile(name) {
    return /\.(mp3|m4a|aac|ogg|oga|wav|flac|opus|webm)$/i.test(String(name || ''));
  }

  function cleanFileName(name) {
    return String(name || 'Untitled').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  }

  function revokeLocalUrls() {
    localTracks.forEach((entry) => {
      if (entry.url && String(entry.url).indexOf('blob:') === 0) {
        try { URL.revokeObjectURL(entry.url); } catch (error) { /* ignore */ }
      }
    });
    localTracks.clear();
  }

  function applyFiles(files) {
    revokeLocalUrls();
    const songs = (files || []).filter((file) => isAudioFile(file.name)).slice(0, 1000).map((file) => {
      const id = hash(file.name + '|' + file.size + '|' + file.lastModified);
      const url = URL.createObjectURL(file);
      const song = {
        id: id,
        title: cleanFileName(file.name),
        artist: 'Local file',
        album: folderName || 'Local library',
        duration: '0',
        language: '',
        provider: 'local',
        path: url,
        cover: '',
        image: '',
        raw: { name: file.name, size: file.size }
      };
      localTracks.set(id, { id: id, url: url, raw: song });
      return song;
    });
    write(LIBRARY_KEY, JSON.stringify(songs.map((song) => ({ ...song, path: 'local:' + song.id }))));
    return songs;
  }

  function loadPersistedLibrary() {
    if (localTracks.size) return;
    const songs = loadObject(LIBRARY_KEY, []);
    songs.forEach((song) => {
      if (!song || !song.id) return;
      localTracks.set(String(song.id), { id: String(song.id), url: '', raw: song });
    });
  }

  function openSettingsDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const request = indexedDB.open('musicver-web', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('settings')) {
          request.result.createObjectStore('settings');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB error'));
    });
  }

  async function idbGet(key) {
    const db = await openSettingsDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readonly');
      const request = tx.objectStore('settings').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openSettingsDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function collectAudio(handle) {
    const files = [];
    async function walk(directory) {
      if (files.length >= 1000) return;
      for await (const entry of directory.values()) {
        if (entry.kind === 'directory') await walk(entry);
        else if (entry.kind === 'file' && isAudioFile(entry.name)) files.push(await entry.getFile());
        if (files.length >= 1000) return;
      }
    }
    await walk(handle);
    return files;
  }

  async function restoreFolder() {
    try {
      const handle = await idbGet('musicFolder');
      if (!handle) return;
      folderName = handle.name || folderName;
      if (handle.queryPermission) {
        const permission = await handle.queryPermission({ mode: 'read' });
        if (permission !== 'granted') return;
      }
      const files = await collectAudio(handle);
      if (files.length) applyFiles(files);
    } catch (error) {
      /* IndexedDB or folder permission unavailable — keep persisted metadata. */
    }
  }

  const restorePromise = restoreFolder();

  async function chooseMusicFolder() {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker({ id: 'musicver', mode: 'read' });
        if (handle.queryPermission) {
          const permission = await handle.queryPermission({ mode: 'read' });
          if (permission === 'prompt') await handle.requestPermission({ mode: 'read' });
        }
        const files = await collectAudio(handle);
        folderName = handle.name || 'Music folder';
        write(FOLDER_KEY, folderName);
        try { await idbSet('musicFolder', handle); } catch (error) { /* non-fatal */ }
        applyFiles(files);
        return { success: true, folder: folderName, count: files.length };
      } catch (error) {
        if (error && error.name === 'AbortError') return { success: false, message: 'Folder selection cancelled.' };
        return { success: false, message: 'Could not read that folder.' };
      }
    }

    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = 'audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac';
      input.onchange = () => {
        const files = Array.prototype.slice.call(input.files || []);
        folderName = 'Selected files';
        write(FOLDER_KEY, folderName);
        applyFiles(files);
        resolve({ success: true, folder: folderName, count: files.length });
      };
      input.click();
    });
  }

  /* ---------------- web bridge API ---------------- */

  const webApi = {
    ping() { return { success: true, web: true, source: apiBase }; },

    async get_jiosaavn_discovery() {
      const cached = loadObject(DISCOVERY_KEY, null);
      if (cached && cached.savedAt && Date.now() - cached.savedAt < 30 * 60 * 1000) {
        return { success: true, trending: cached.trending || [], albums: cached.albums || [],
          artists: cached.artists || [], charts: cached.charts || [], genres: cached.genres || [] };
      }

      const queries = ['top hindi songs', 'bollywood hits', 'arijit singh', 'romantic hindi', 'english hits'];
      const settled = await Promise.allSettled(queries.map(searchCatalogue));
      const bundles = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
      let songs = [];
      let albums = [];
      let artists = [];
      bundles.forEach((bundle) => {
        songs = songs.concat(bundle.songs);
        albums = albums.concat(bundle.albums);
        artists = artists.concat(bundle.artists);
      });

      const dedupe = (list) => {
        const seen = new Set();
        return list.filter((item) => {
          const key = String(item && item.id);
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      };
      songs = dedupe(songs);
      albums = dedupe(albums);
      artists = dedupe(artists);

      if (!songs.length) {
        songs = seedTracks().concat(cachedTracks());
        albums = [];
        artists = [];
      }
      const result = {
        success: true,
        trending: songs.slice(0, 18),
        albums: albums.slice(0, 12),
        artists: artists.slice(0, 10),
        charts: albums.slice(12, 24),
        genres: MV.data.genres || []
      };
      write(DISCOVERY_KEY, JSON.stringify({ ...result, savedAt: Date.now() }));
      return result;
    },

    async search_online_music(query) {
      try {
        const found = await searchCatalogue(query);
        return { success: true, results: found.songs, albums: found.albums, artists: found.artists,
          source: 'online' };
      } catch (error) {
        const local = localMatches(query);
        return { success: true, results: local.songs, albums: local.albums, artists: local.artists,
          source: 'offline', offline: true };
      }
    },

    async get_jiosaavn_album(id) {
      try {
        const data = await apiFetch('/albums?id=' + encodeURIComponent(id));
        const album = data && data.data ? data.data : {};
        const tracks = (Array.isArray(album.songs) ? album.songs : []).map(toTrackRaw).filter(Boolean);
        rememberStreams(tracks.slice(0, 50));
        return { success: true, tracks: tracks };
      } catch (error) {
        const local = localMatches('');
        return { success: true, tracks: local.songs.slice(0, 12) };
      }
    },

    async get_jiosaavn_artist(id, page, limit, section) {
      const artistId = encodeURIComponent(id);
      try {
        if (section === 'songs') {
          const data = await apiFetch('/artists/' + artistId + '/songs?page=' + (Number(page) + 1));
          const songs = (data && data.data && Array.isArray(data.data.songs) ? data.data.songs : [])
            .map(toTrackRaw).filter(Boolean);
          rememberStreams(songs.slice(0, 40));
          return { success: true, songs: songs };
        }
        const data = await apiFetch('/artists/' + artistId);
        const artist = data && data.data ? data.data : {};
        const bio = Array.isArray(artist.bio)
          ? artist.bio.map((item) => item && item.text ? item.text : '').join(' ')
          : String(artist.bio || '');
        const songs = (artist.topSongs || []).map(toTrackRaw).filter(Boolean);
        rememberStreams(songs.slice(0, 40));
        return {
          success: true,
          artist: toArtistRaw(artist),
          songs: songs,
          albums: (artist.topAlbums || []).map(toAlbumRaw).filter(Boolean),
          singles: (artist.singles || []).map(toAlbumRaw).filter(Boolean),
          similar_artists: (artist.similarArtists || []).map(toArtistRaw).filter(Boolean),
          playlists: [],
          bio: bio,
          source_url: artist.url || ''
        };
      } catch (error) {
        const local = localMatches('');
        return { success: true, artist: { id: String(id), name: 'Artist', title: 'Artist', kind: 'artist',
          cover: MV.data.coverFor(String(id), 'Artist', true) }, songs: local.songs.slice(0, 8),
          albums: [], singles: [], similar_artists: [], playlists: [], bio: '', source_url: '' };
      }
    },

    async get_jiosaavn_lyrics() {
      return { success: true, available: false };
    },

    play_jiosaavn_track: playJioSaavn,
    play_provider_track: playJioSaavn,
    play_song: playLocal,

    pause_song() {
      const element = getAudio();
      switching = false;
      element.pause();
      return { success: true };
    },

    resume_song() {
      const element = getAudio();
      if (!element.src) return Promise.resolve({ success: true });
      return element.play().then(() => ({ success: true })).catch(() => ({ success: false }));
    },

    stop_song() {
      const element = getAudio();
      element.pause();
      try { element.currentTime = 0; } catch (error) { /* ignore */ }
      playbackState = 'stopped';
      return { success: true };
    },

    seek_song(seconds) {
      const element = getAudio();
      try { element.currentTime = Math.max(0, Number(seconds) || 0); } catch (error) { /* ignore */ }
      return { success: true };
    },

    set_volume(value) {
      const element = getAudio();
      element.volume = clamp(value, 0, 1);
      return { success: true };
    },

    get_progress() {
      const element = getAudio();
      const total = Number.isFinite(element.duration) && element.duration > 0
        ? element.duration
        : Number(currentTrack && currentTrack.duration) || 0;
      return {
        success: true,
        current_time: Number(element.currentTime) || 0,
        total_time: total,
        playback_state: playbackState
      };
    },

    ensure_saved_track(track) {
      return { success: true, song: { id: track && track.id != null ? String(track.id) : hash(track && track.title) } };
    },

    toggle_like_song(id) {
      return { success: true, liked: MV.store.isLiked(id) };
    },

    create_playlist() { return null; },
    set_playlist_cover() { return null; },
    delete_playlist() { return null; },
    rename_playlist() { return null; },
    add_to_playlist() { return null; },
    remove_from_playlist() { return null; },

    choose_music_folder: chooseMusicFolder,

    get_music_folder() {
      return { success: true, folder: folderName || null };
    },

    save_album() { return null; },
    remove_saved_album() { return null; },

    get_theme() { return null; },
    set_theme() { return null; },

    get_profile_picture() { return null; },
    set_profile_picture() { return null; },

    async get_saved_songs() {
      await restorePromise;
      loadPersistedLibrary();
      const songs = Array.from(localTracks.values()).map((entry) => entry.raw);
      return { success: true, songs: songs, count: songs.length };
    },

    syncLibrary() {
      const state = MV.store.state;
      return {
        playlists: (state.playlists || []).map((playlist) => ({
          id: playlist.id,
          name: playlist.name,
          cover: playlist.cover,
          songs: playlist.songs || [],
          createdAt: playlist.createdAt || Date.now()
        })),
        liked: state.liked || [],
        savedAlbums: state.savedAlbums || []
      };
    }
  };

  loadPersistedLibrary();
  cachedTracks();
  window.MV = MV;
  MV.webApi = webApi;
  window.pywebview = window.pywebview || {};
  window.pywebview.api = webApi;
  document.dispatchEvent(new CustomEvent('mv:webapi-ready'));
})(window.MV = window.MV || {});
