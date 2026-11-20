/* ============================================================
   musicVer · static web bridge
   Replaces the Python/pywebview engine on GitHub Pages.

   - live catalogue: JioSaavn-compatible APIs + itunes.apple.com (CORS-enabled)
   - full mainstream audio: JioSaavn original streams resolved at runtime
   - static ID map: fast fallback for popular tracks and whole albums
   - all audio: direct aac.saavncdn.com streams via HTMLAudioElement
   - account data: localStorage (same MV.store used by the desktop SPA)
   - local music: File System Access API / file input, files stay on device
   ============================================================ */

(function (MV) {
  'use strict';

  const DEFAULT_API = 'https://saavn.sumit.co/api';
  const JIO_LIVE_APIS = ['https://saavnx.vercel.app/api', DEFAULT_API];
  const ITUNES_API = 'https://itunes.apple.com';
  const API_BASE_KEY = 'musicver.web.apiBase';
  const CACHE_KEY = 'musicver.web.cache.v1';
  const DISCOVERY_KEY = 'musicver.web.discovery.v1';
  const LIBRARY_KEY = 'musicver.web.localLibrary.v1';
  const FOLDER_KEY = 'musicver.web.folderName';

  const apiBase = read(API_BASE_KEY) || DEFAULT_API;
  const streamCache = new Map();
  const itunesMeta = new Map();
  const jioFullCache = new Map();
  const jioLiveSearchCache = new Map();
  const jioLivePending = new Map();
  const localTracks = new Map();
  const jioCatalog = MV.webJioCatalog || { songs: {}, albums: {}, entries: {} };
  let folderName = read(FOLDER_KEY) || '';
  let playbackState = 'stopped';
  let switching = false;
  let currentTrack = null;
  let audio = null;
  let streamQueue = [];
  let streamIndex = 0;
  let playRequestId = 0;

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

  /* iTunes fills the metadata gaps in JioSaavn's regional catalogue. Its own
     audio is only a 30-second preview, so mainstream playback is remapped to
     the matching JioSaavn original from the generated ID catalogue below. */

  function itunesArtwork(url, size) {
    if (!url) return '';
    return String(url).replace(/\d+x\d+bb\.(jpg|png|jpeg)$/i, (size || 600) + 'x' + (size || 600) + 'bb.$1');
  }

  function toItunesTrackRaw(item) {
    if (!item || !item.previewUrl) return null;
    const id = 'itunes-' + String(item.trackId || hash((item.trackName || '') + (item.artistName || '')));
    const cover = itunesArtwork(item.artworkUrl100 || item.artworkUrl60);
    streamCache.set(id, [item.previewUrl]);
    itunesMeta.set(id, {
      id: id,
      title: decode(item.trackName || item.title || 'Unknown title'),
      artist: decode(item.artistName || 'Unknown artist'),
      album: decode(item.collectionName || 'Unknown album'),
      duration: Math.round((item.trackTimeMillis || 0) / 1000),
      cover: cover
    });
    return {
      id: id,
      title: decode(item.trackName || item.title || 'Unknown title'),
      artist: decode(item.artistName || 'Unknown artist'),
      album: decode(item.collectionName || 'Unknown album'),
      duration: String(Math.round((item.trackTimeMillis || 0) / 1000)),
      language: item.primaryGenreName || '',
      provider: 'itunes',
      path: 'stream:itunes:' + id,
      cover: cover,
      image: cover,
      downloadUrl: [{ quality: 'preview', url: item.previewUrl }],
      raw: item
    };
  }

  function toItunesArtistRaw(item) {
    if (!item) return null;
    const id = 'itunes-artist-' + String(item.artistId || hash(item.artistName || 'Unknown artist'));
    const name = decode(item.artistName || item.name || 'Unknown artist');
    const cover = itunesArtwork(item.artworkUrl100 || item.artworkUrl60 || item.cover);
    return {
      id: id,
      name: name,
      title: name,
      kind: 'artist',
      listeners: null,
      token: '',
      image: cover,
      cover: cover,
      raw: item
    };
  }

  function toItunesAlbumRaw(item) {
    if (!item || !item.collectionName) return null;
    const id = 'itunes-album-' + String(item.collectionId || hash(item.collectionName + (item.artistName || '')));
    const cover = itunesArtwork(item.artworkUrl100 || item.artworkUrl60);
    return {
      id: id,
      title: decode(item.collectionName),
      artist: decode(item.artistName || 'Unknown artist'),
      year: String(item.releaseDate || '').slice(0, 4),
      language: '',
      track_count: item.trackCount || null,
      token: '',
      image: cover,
      cover: cover,
      raw: item
    };
  }

  async function itunesSearchSongs(query, limit) {
    const data = await itunesFetch('/search?term=' + encodeURIComponent(query) +
      '&entity=song&country=US&limit=' + (Number(limit) || 20));
    return (data && Array.isArray(data.results) ? data.results : [])
      .map(toItunesTrackRaw).filter(Boolean);
  }

  async function itunesSearchArtists(query, limit) {
    const data = await itunesFetch('/search?term=' + encodeURIComponent(query) +
      '&entity=musicArtist&country=US&limit=' + (Number(limit) || 10));
    return (data && Array.isArray(data.results) ? data.results : [])
      .map(toItunesArtistRaw).filter(Boolean);
  }

  async function itunesLookup(id, entity) {
    const data = await itunesFetch('/lookup?id=' + encodeURIComponent(id) +
      '&entity=' + encodeURIComponent(entity || 'song') + '&country=US&limit=200');
    return data && Array.isArray(data.results) ? data.results : [];
  }

  /* ---------------- full-length JioSaavn streams ----------------
     Browsers cannot call JioSaavn's private web API because it does not send
     CORS headers. The desktop Python app can, which is why main.py plays
     originals in full. This build ships a small ID map generated from that
     API at build time. At runtime a CORS-enabled JioSaavn-compatible search
     API resolves any available artist dynamically, and the public mirror
     supplies full-length aac.saavncdn.com audio — no external video fallback,
     no server and no 30-second preview for resolved tracks. */

  function jioNorm(value) {
    return decode(value || '').toLowerCase()
      .replace(/\([^)]*feat[^)]*\)/gi, ' ')
      .replace(/\[[^\]]*feat[^\]]*\]/gi, ' ')
      .replace(/[^a-z0-9\u0900-\u097f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function jioLookup(title, artist) {
    const name = jioNorm(title);
    const byArtist = jioNorm(artist);
    if (!name || !byArtist) return null;
    if (jioCatalog.songs[name + '|' + byArtist]) return jioCatalog.songs[name + '|' + byArtist];
    const shortened = jioNorm(String(title || '').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' '));
    return jioCatalog.songs[shortened + '|' + byArtist] || null;
  }

  function jioAlbumLookup(title, artist) {
    const name = jioNorm(title);
    const albums = jioCatalog.albums || {};
    if (!name || !albums[name]) {
      const byArtist = jioNorm(artist);
      let match = null;
      Object.keys(albums).forEach((key) => {
        const entry = albums[key];
        const candidate = jioNorm(entry && (entry.title || key));
        if (!candidate || !(candidate === name || candidate.indexOf(name) >= 0 || name.indexOf(candidate) >= 0)) return;
        const entryArtist = jioNorm(entry && entry.artist);
        if (byArtist && entryArtist && entryArtist !== byArtist && entryArtist.indexOf(byArtist) < 0) return;
        match = entry;
      });
      return albums[name] || match;
    }
    return albums[name];
  }

  function jioAlbumById(id) {
    const key = String(id || '');
    if (!key) return null;
    const albums = jioCatalog.albums || {};
    return Object.keys(albums).map((name) => albums[name])
      .find((entry) => entry && String(entry.id) === key) || null;
  }

  function toJioFullTrack(id, fallback) {
    const key = String(id || '');
    if (!key) return null;
    const entry = jioCatalog.entries[key] || null;
    const cover = (entry && entry.cover) || (fallback && (fallback.cover || fallback.image)) || '';
    const entryStreams = entry && Array.isArray(entry.streams) ? entry.streams : [];
    const fallbackStreams = fallback && Array.isArray(fallback.downloadUrl)
      ? fallback.downloadUrl.map((item) => item && item.url).filter(Boolean) : [];
    const streams = entryStreams.length ? entryStreams : (entry && entry.stream ? [entry.stream] : fallbackStreams);
    if (streams.length) streamCache.set(key, streams);
    const raw = (fallback && (fallback.raw || fallback)) || entry || {};
    return {
      id: key,
      title: (entry && entry.title) || (fallback && fallback.title) || key,
      artist: (entry && entry.artist) || (fallback && fallback.artist) || 'Unknown artist',
      album: (entry && entry.album) || (fallback && fallback.album) || 'Unknown album',
      duration: String((entry && entry.duration) || (fallback && fallback.duration) || 0),
      language: (fallback && fallback.language) || '',
      provider: 'jiosaavn',
      path: 'stream:jiosaavn:' + key,
      cover: cover,
      image: cover,
      downloadUrl: streams.map((url, index) => ({ quality: index ? 'stream' : '160kbps', url: url })),
      raw: raw
    };
  }

  function jioFullTrackFor(raw) {
    if (!raw) return null;
    const title = raw.title || raw.name || raw.trackName || raw.song || '';
    const artist = raw.artist || raw.artistName || artistName(raw);
    const knownId = jioCatalog.entries[String(raw.id)] ? String(raw.id) : null;
    const id = knownId || jioLookup(title, artist);
    return id ? toJioFullTrack(id, raw) : null;
  }

  function mapToJioFull(items) {
    return (items || []).map((item) => jioFullTrackFor(item) || item);
  }

  function isLocalDesktop() {
    return /^http:\/\/127\.0\.0\.1:\d+$/.test(location.origin);
  }

  let jioWebSearchAvailable = true;

  async function jioWebSearch(query) {
    if (!isLocalDesktop() || !jioWebSearchAvailable) return null;
    try {
      const data = await fetchJson(location.origin, '/__jio/search?q=' + encodeURIComponent(query));
      if (!data || !data.success || !Array.isArray(data.results)) return null;
      return data.results;
    } catch (error) {
      jioWebSearchAvailable = false;
      return null;
    }
  }

  function jioBadTrack(track) {
    const text = jioNorm([track && track.title, track && track.artist, track && track.album].join(' '));
    return /\b(karaoke|instrumental|tribute|emulation|cover version|sped up|slowed|nightcore|performed by)\b/.test(text);
  }

  async function jioLiveSearch(query, limit) {
    const needle = String(query || '').trim();
    if (!needle) return [];
    const size = Math.max(20, Math.min(50, Number(limit) || 20));
    const cacheKey = jioNorm(needle) + '|' + size;
    if (jioLiveSearchCache.has(cacheKey)) return jioLiveSearchCache.get(cacheKey).slice(0, size);
    if (jioLivePending.has(cacheKey)) return jioLivePending.get(cacheKey);

    const request = (async function () {
      const allowVariants = /(karaoke|instrumental|tribute|sped|slowed|nightcore|cover)/i.test(needle);
      let lastError = null;
      for (let index = 0; index < JIO_LIVE_APIS.length; index += 1) {
        try {
          const data = await fetchJson(JIO_LIVE_APIS[index],
            '/search/songs?query=' + encodeURIComponent(needle) + '&limit=' + size);
          const songs = data && data.data && Array.isArray(data.data.results) ? data.data.results : [];
          const tracks = dedupeById(songs.map(toTrackRaw).filter(Boolean)
            .filter((track) => allowVariants || !jioBadTrack(track)));
          if (tracks.length) {
            jioLiveSearchCache.set(cacheKey, tracks);
            return tracks;
          }
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) console.info('musicVer: live JioSaavn search unavailable', lastError.message);
      jioLiveSearchCache.set(cacheKey, []);
      return [];
    }());

    jioLivePending.set(cacheKey, request);
    try {
      return await request;
    } finally {
      jioLivePending.delete(cacheKey);
    }
  }

  function jioMatchScore(track, title, artist) {
    const wantedTitle = jioNorm(title);
    const wantedArtist = jioNorm(artist);
    const gotTitle = jioNorm(track && track.title);
    const gotArtist = jioNorm(track && track.artist);
    const gotAlbum = jioNorm(track && track.album);
    let score = 0;

    if (wantedTitle && gotTitle === wantedTitle) score += 10;
    else if (wantedTitle && (gotTitle.indexOf(wantedTitle) >= 0 || wantedTitle.indexOf(gotTitle) >= 0)) score += 6;

    if (wantedArtist && gotArtist === wantedArtist) score += 10;
    else if (wantedArtist && (gotArtist.indexOf(wantedArtist) >= 0 || wantedArtist.indexOf(gotArtist) >= 0)) score += 6;
    else if (wantedArtist && gotAlbum.indexOf(wantedArtist) >= 0) score += 2;

    if (wantedTitle && wantedArtist && gotTitle === wantedTitle && gotArtist === wantedArtist) score += 8;
    if (jioBadTrack(track)) score -= 20;
    score += (Number(track && track.duration) || 0) > 40 ? 2 : -8;
    return score;
  }

  async function jioLiveMatch(title, artist) {
    if (!jioNorm(title)) return null;
    const query = String(title || '').trim() + (artist ? ' ' + String(artist).trim() : '');
    const candidates = await jioLiveSearch(query, 12);
    if (!candidates.length) return null;
    const ranked = candidates
      .map((track) => ({ track: track, score: jioMatchScore(track, title, artist) }))
      .sort((a, b) => b.score - a.score);
    return ranked[0] && ranked[0].score >= 8 ? ranked[0].track : null;
  }

  function featuredCatalogTracks(limit) {
    const ids = Array.isArray(jioCatalog.featured) && jioCatalog.featured.length
      ? jioCatalog.featured : Object.keys(jioCatalog.entries || {});
    return ids.slice(0, Number(limit) || 20).map((id) => toJioFullTrack(id)).filter(Boolean);
  }

  function searchJioCatalog(query, limit) {
    const needle = jioNorm(query);
    if (!needle) return [];
    const tokens = needle.split(' ').filter(Boolean);
    const matches = [];
    Object.keys(jioCatalog.entries || {}).forEach((id) => {
      const entry = jioCatalog.entries[id];
      const title = jioNorm(entry && entry.title);
      const artist = jioNorm(entry && entry.artist);
      const album = jioNorm(entry && entry.album);
      const haystack = title + ' ' + artist + ' ' + album;
      let score = 0;
      if (title === needle) score += 10;
      else if (title && (title.indexOf(needle) >= 0 || needle.indexOf(title) >= 0)) score += 6;
      if (artist === needle) score += 10;
      else if (artist && (artist.indexOf(needle) >= 0 || needle.indexOf(artist) >= 0)) score += 6;
      const covered = tokens.filter((token) => haystack.indexOf(token) >= 0).length;
      score += tokens.length && covered === tokens.length ? 8 + tokens.length : covered * 2;
      if (score >= 6) matches.push({ id: id, score: score });
    });
    matches.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    return matches.slice(0, Number(limit) || 20).map((item) => toJioFullTrack(item.id)).filter(Boolean);
  }

  async function resolveJioFull(id) {
    const key = String(id || '');
    if (jioFullCache.has(key)) return jioFullCache.get(key);
    const bundled = jioCatalog.entries[key];
    if (bundled) {
      const track = toJioFullTrack(key);
      const urls = streamCache.get(key) || [];
      if (urls.length) {
        const result = { track: track, urls: urls };
        jioFullCache.set(key, result);
        return result;
      }
    }
    const data = await fetchJson(apiBase, '/songs/' + encodeURIComponent(key));
    let list = data && Array.isArray(data.data) ? data.data : [];
    if (!list.length && data && data.data && Array.isArray(data.data.songs)) list = data.data.songs;
    const song = list.find((item) => item && String(item.id) === key) || list[0];
    if (!song || !Array.isArray(song.downloadUrl) || !song.downloadUrl.length) {
      throw new Error('Full JioSaavn stream is not available for this track.');
    }
    const track = toTrackRaw(song);
    const result = { track: track, urls: streamCache.get(track.id) || [] };
    jioFullCache.set(key, result);
    return result;
  }

  async function playJioFull(id, meta, requestId) {
    const token = requestId == null ? ++playRequestId : requestId;
    const resolved = await resolveJioFull(id);
    if (token !== playRequestId) return { success: false, stale: true };
    currentTrack = resolved.track;
    if (meta && meta.cover && !currentTrack.cover) {
      currentTrack.cover = meta.cover;
      currentTrack.image = meta.cover;
    }
    rememberStreams([currentTrack]);
    await startPlayback(resolved.urls, token);
    if (token !== playRequestId) return { success: false, stale: true };
    return { success: true, source: 'jiosaavn', full: true };
  }

  function seedTracks() {
    return (MV.webSeed || []).map((item) => {
      const provider = item.provider || (String(item.id).indexOf('itunes-') === 0 ? 'itunes' : 'jiosaavn');
      const id = String(item.id);
      const stream = item.stream || '';
      if (stream) streamCache.set(id, [stream]);
      return {
        id: id,
        title: decode(item.title),
        artist: decode(item.artist),
        album: decode(item.album),
        duration: String(item.duration || 0),
        language: item.language || '',
        provider: provider,
        path: item.path || ('stream:' + provider + ':' + id),
        cover: item.cover || '',
        image: item.cover || '',
        downloadUrl: stream ? [{ quality: provider === 'itunes' ? 'preview' : '160kbps', url: stream }] : [],
        raw: Object.assign({ provider: provider }, item)
      };
    });
  }

  function cachedTracks() {
    const cache = loadObject(CACHE_KEY, {});
    return Object.keys(cache).map((id) => {
      const item = cache[id];
      const streams = Array.isArray(item.streams) ? item.streams : (item.stream ? [item.stream] : []);
      if (streams.length) streamCache.set(id, streams);
      const provider = item.provider || (id.indexOf('itunes-') === 0 ? 'itunes' : 'jiosaavn');
      return {
        id: id,
        title: item.title || id,
        artist: item.artist || 'Saved track',
        album: item.album || 'Offline cache',
        duration: String(item.duration || 0),
        language: item.language || '',
        provider: provider,
        path: item.path || ('stream:' + provider + ':' + id),
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
        provider: song.provider || 'jiosaavn',
        path: song.path || '',
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

  function dedupeById(list) {
    const seen = new Set();
    return (list || []).filter((item) => {
      const key = String(item && item.id);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function rankTracks(tracks, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return tracks;
    return tracks.map((track, index) => {
      const title = String(track.title || '').toLowerCase();
      const artist = String(track.artist || '').toLowerCase();
      let score = 0;
      if (artist === needle) score = 6;
      else if (title === needle) score = 5;
      else if (artist.indexOf(needle) >= 0 || title.indexOf(needle) >= 0) score = 4;
      else if (needle.split(/\s+/).some((part) => part && (artist.indexOf(part) >= 0 || title.indexOf(part) >= 0))) score = 2;
      if (track.provider === 'jiosaavn' && (track.downloadUrl || []).length &&
          Number(track.duration) > 40) score += 8;
      if (track.provider === 'itunes') score -= 4;
      return { track, score, index };
    }).sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.track);
  }

  function rankArtists(artists, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return artists;
    return artists.map((artist, index) => {
      const name = String(artist.name || artist.title || '').toLowerCase();
      let score = 0;
      if (name === needle) score = String(artist.id).indexOf('itunes-') === 0 ? 5 : 4;
      else if (name.indexOf(needle) === 0) score = 3;
      else if (name.indexOf(needle) >= 0) score = 2;
      else if (needle.split(/\s+/).some((part) => part && name.indexOf(part) >= 0)) score = 1;
      return { artist, score, index };
    }).sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.artist);
  }

  function interleave(first, second) {
    const result = [];
    const max = Math.max(first.length, second.length);
    for (let i = 0; i < max; i += 1) {
      if (i < first.length) result.push(first[i]);
      if (i < second.length) result.push(second[i]);
    }
    return result;
  }

  /* ---------------- network ---------------- */

  async function fetchJson(base, path) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const options = { cache: 'no-store', headers: { Accept: 'application/json' } };
      if (controller) options.signal = controller.signal;
      const response = await fetch(base + path, options);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function apiFetch(path) { return fetchJson(apiBase, path); }
  function itunesFetch(path) { return fetchJson(ITUNES_API, path); }

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

  function startPlayback(urls, requestId) {
    if (requestId != null && requestId !== playRequestId) {
      return Promise.resolve({ success: false, stale: true });
    }
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
    const token = ++playRequestId;
    const key = String(id || '').replace(/^stream:jiosaavn:/, '');
    let urls = streamCache.get(key);
    let track = null;

    if (!urls || !urls.length) {
      try {
        const data = await apiFetch('/songs?ids=' + encodeURIComponent(key));
        if (token !== playRequestId) return { success: false, stale: true };
        const song = data && Array.isArray(data.data) ? data.data[0] : null;
        if (!song) throw new Error('Track not found.');
        track = toTrackRaw(song);
        rememberStreams([track]);
        urls = streamCache.get(track.id);
      } catch (error) {
        if (token !== playRequestId) return { success: false, stale: true };
        track = seedTracks().find((item) => String(item.id) === key) || null;
        urls = track && streamCache.get(track.id);
      }
    }

    if (token !== playRequestId) return { success: false, stale: true };
    if (!track) {
      const all = seedTracks().concat(cachedTracks());
      track = all.find((item) => String(item.id) === key) || { id: key, duration: 0 };
    }
    currentTrack = track;

    try {
      await startPlayback(urls, token);
      if (token !== playRequestId) return { success: false, stale: true };
      return { success: true, source: 'jiosaavn', full: true };
    } catch (error) {
      if (token !== playRequestId) return { success: false, stale: true };
      playbackState = 'paused';
      return { success: false, message: 'Playback was blocked — click play again.' };
    }
  }

  async function playItunes(id) {
    const token = ++playRequestId;
    const key = String(id || '');
    const rawId = key.replace(/^itunes-/, '');
    let lookupItem = null;
    let track = itunesMeta.get(key) || seedTracks().concat(cachedTracks())
      .find((item) => String(item.id) === key) || null;

    if (!track) {
      try {
        const items = await itunesLookup(rawId, 'song');
        if (token !== playRequestId) return { success: false, stale: true };
        lookupItem = items.find((entry) => String(entry.trackId) === rawId) || null;
        if (lookupItem) track = toItunesTrackRaw(lookupItem);
      } catch (error) { /* use the cached preview below */ }
    }

    if (track) {
      const full = jioFullTrackFor(track) || await jioLiveMatch(track.title, track.artist);
      if (token !== playRequestId) return { success: false, stale: true };
      if (full) return playJioFull(full.id, track, token);
    }

    let urls = streamCache.get(key);
    if ((!urls || !urls.length) && lookupItem && lookupItem.previewUrl) {
      currentTrack = track || toItunesTrackRaw(lookupItem);
      urls = [lookupItem.previewUrl];
    }
    if (!urls || !urls.length) {
      return { success: false, message: 'This track is not currently available.' };
    }
    if (!currentTrack) {
      currentTrack = itunesMeta.get(key) || seedTracks().concat(cachedTracks())
        .find((item) => String(item.id) === key) || null;
    }
    try {
      await startPlayback(urls, token);
      if (token !== playRequestId) return { success: false, stale: true };
      return { success: true, source: 'itunes', preview: true };
    } catch (error) {
      if (token !== playRequestId) return { success: false, stale: true };
      playbackState = 'paused';
      return { success: false, message: 'Playback was blocked — click play again.' };
    }
  }

  async function playLocal(path) {
    const token = ++playRequestId;
    const requested = String(path || '');
    const key = requested.indexOf('local:') === 0 ? requested.slice(6) : requested;
    let entry = localTracks.get(key) || Array.from(localTracks.values())
      .find((item) => String(item.raw && item.raw.path) === requested);
    if (!entry) {
      await restorePromise;
      if (token !== playRequestId) return { success: false, stale: true };
      entry = localTracks.get(key) || Array.from(localTracks.values())
        .find((item) => String(item.raw && item.raw.path) === requested);
    }
    if (!entry || !entry.url) {
      return { success: false, message: 'Choose your music folder again to play local files.' };
    }
    currentTrack = entry.raw;
    try {
      await startPlayback([entry.url], token);
      if (token !== playRequestId) return { success: false, stale: true };
      return { success: true };
    } catch (error) {
      if (token !== playRequestId) return { success: false, stale: true };
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
      const mainstreamQueries = ['Joji', 'The Weeknd', 'Billie Eilish', 'Taylor Swift',
        'Imagine Dragons', 'Ed Sheeran', 'Steve Lacy', 'Doechii', 'Tame Impala'];
      const [jioSettled, itunesSettled, liveSettled] = await Promise.all([
        Promise.allSettled(queries.map(searchCatalogue)),
        Promise.allSettled(mainstreamQueries.map((name) => itunesSearchSongs(name, 8))),
        Promise.allSettled(mainstreamQueries.map((name) => jioLiveSearch(name, 8)))
      ]);

      let jioSongs = [];
      let jioAlbums = [];
      let jioArtists = [];
      jioSettled.filter((item) => item.status === 'fulfilled').forEach((item) => {
        jioSongs = jioSongs.concat(item.value.songs);
        jioAlbums = jioAlbums.concat(item.value.albums);
        jioArtists = jioArtists.concat(item.value.artists);
      });

      let itunesSongs = [];
      itunesSettled.filter((item) => item.status === 'fulfilled').forEach((item) => {
        itunesSongs = itunesSongs.concat(item.value);
      });
      let liveSongs = [];
      liveSettled.filter((item) => item.status === 'fulfilled').forEach((item) => {
        liveSongs = liveSongs.concat(item.value);
      });
      const sourceItems = itunesSongs.slice(0, 40).map((track) => track.raw).filter(Boolean);
      const mainstreamArtists = sourceItems.map((item) => toItunesArtistRaw(item)).filter(Boolean);
      const mainstreamAlbums = sourceItems.map((item) => toItunesAlbumRaw(item)).filter(Boolean);
      const catalogSongs = featuredCatalogTracks(12);

      let songs = dedupeById(catalogSongs.concat(liveSongs, mapToJioFull(jioSongs)));
      if (!songs.length) songs = dedupeById(mapToJioFull(itunesSongs));
      const albums = dedupeById(jioAlbums.concat(mainstreamAlbums));
      const artists = dedupeById(jioArtists.concat(mainstreamArtists));

      if (!songs.length) {
        songs = seedTracks().concat(cachedTracks());
      }
      const result = {
        success: true,
        trending: songs.slice(0, 24),
        albums: albums.slice(0, 12),
        artists: artists.slice(0, 12),
        charts: dedupeById(mainstreamAlbums).slice(0, 12),
        genres: MV.data.genres || []
      };
      write(DISCOVERY_KEY, JSON.stringify({ ...result, savedAt: Date.now() }));
      return result;
    },

    async search_online_music(query) {
      const needle = String(query || '').trim();
      if (!needle) return { success: true, results: [], albums: [], artists: [], source: 'online' };
      try {
        const [jioResult, songResult, artistResult, jioWebResult, liveResult] = await Promise.allSettled([
          searchCatalogue(needle),
          itunesSearchSongs(needle, 20),
          itunesSearchArtists(needle, 10),
          jioWebSearch(needle),
          jioLiveSearch(needle, 30)
        ]);
        const jio = jioResult.status === 'fulfilled'
          ? jioResult.value : { songs: [], albums: [], artists: [] };
        const itunesSongs = songResult.status === 'fulfilled' ? songResult.value : [];
        const itunesArtists = artistResult.status === 'fulfilled' ? artistResult.value : [];
        const songArtists = itunesSongs.slice(0, 8)
          .map((track) => toItunesArtistRaw(track.raw)).filter(Boolean);
        const dynamicJio = jioWebResult.status === 'fulfilled' && Array.isArray(jioWebResult.value)
          ? jioWebResult.value.map((item) => toJioFullTrack(item.id, {
            title: item.title,
            artist: item.artist,
            album: item.album,
            duration: item.duration,
            cover: item.cover,
            raw: item
          })).filter(Boolean) : [];
        const liveJio = liveResult.status === 'fulfilled' ? liveResult.value : [];

        const catalogMatches = searchJioCatalog(needle, 15);
        let songs = dedupeById(liveJio.concat(catalogMatches, dynamicJio, mapToJioFull(jio.songs)));
        if (songs.length < 6) {
          songs = dedupeById(songs.concat(mapToJioFull(itunesSongs)));
        }
        songs = rankTracks(songs, needle).slice(0, 40);
        const artists = rankArtists(dedupeById(jio.artists.concat(itunesArtists, songArtists)), needle).slice(0, 12);
        const albums = dedupeById(jio.albums).slice(0, 12);
        rememberStreams(songs);
        return {
          success: true,
          results: songs,
          albums: albums,
          artists: artists,
          source: 'online',
          offline: false
        };
      } catch (error) {
        const local = localMatches(query);
        return { success: true, results: local.songs, albums: local.albums, artists: local.artists,
          source: 'offline', offline: true };
      }
    },

    async get_jiosaavn_album(id) {
      const albumId = String(id || '');
      if (albumId.indexOf('itunes-album-') === 0) {
        try {
          const rawId = albumId.replace(/^itunes-album-/, '');
          const items = await itunesLookup(rawId, 'song');
          const own = items.filter((entry) => entry.wrapperType === 'track' &&
            String(entry.collectionId) === rawId);
          const tracks = own.map(toItunesTrackRaw).filter(Boolean);
          const source = own[0] || {};
          const jioAlbum = jioAlbumLookup(source.collectionName, source.artistName);
          let fullTracks = mapToJioFull(tracks);
          if (jioAlbum && Array.isArray(jioAlbum.tracks) && jioAlbum.tracks.length) {
            fullTracks = jioAlbum.tracks.map((trackId) => {
              const match = tracks.find((item) => jioLookup(item.title, item.artist) === trackId);
              return toJioFullTrack(trackId, match);
            }).filter(Boolean);
          }
          rememberStreams(fullTracks);
          return { success: true, tracks: fullTracks };
        } catch (error) {
          return { success: true, tracks: [] };
        }
      }
      try {
        const data = await apiFetch('/albums?id=' + encodeURIComponent(id));
        const album = data && data.data ? data.data : {};
        let tracks = mapToJioFull((Array.isArray(album.songs) ? album.songs : []).map(toTrackRaw).filter(Boolean));
        const bundled = jioAlbumById(id);
        if ((!tracks.length || !bundled) && bundled && Array.isArray(bundled.tracks)) {
          tracks = bundled.tracks.map((trackId) => toJioFullTrack(trackId)).filter(Boolean);
        }
        if (!tracks.length) {
          const local = localMatches('');
          tracks = local.songs.slice(0, 12);
        }
        rememberStreams(tracks.slice(0, 50));
        return { success: true, tracks: tracks, source: bundled ? 'jiosaavn' : apiBase };
      } catch (error) {
        const bundled = jioAlbumById(id);
        const tracks = bundled && Array.isArray(bundled.tracks)
          ? bundled.tracks.map((trackId) => toJioFullTrack(trackId)).filter(Boolean)
          : localMatches('').songs.slice(0, 12);
        rememberStreams(tracks.slice(0, 50));
        return { success: true, tracks: tracks, source: bundled ? 'jiosaavn' : apiBase };
      }
    },

    async get_jiosaavn_artist(id, page, limit, section) {
      const rawArtistId = String(id || '');
      if (rawArtistId.indexOf('itunes-artist-') === 0) {
        try {
          const rawId = rawArtistId.replace(/^itunes-artist-/, '');
          const items = await itunesLookup(rawId, 'song');
          const own = items.filter((entry) => entry.wrapperType === 'track' &&
            String(entry.artistId) === rawId);
          const tracks = mapToJioFull(own.map(toItunesTrackRaw).filter(Boolean));
          rememberStreams(tracks);
          if (section === 'songs') {
            const size = Number(limit) || 20;
            const start = (Number(page) || 0) * size;
            return { success: true, songs: tracks.slice(start, start + size) };
          }
          const source = own[0] || { artistId: Number(rawId), artistName: 'Artist' };
          return {
            success: true,
            artist: toItunesArtistRaw(source),
            songs: tracks.slice(0, 20),
            albums: dedupeById(own.map((item) => toItunesAlbumRaw(item)).filter(Boolean)),
            singles: [],
            similar_artists: [],
            playlists: [],
            bio: '',
            source_url: source.artistViewUrl || ''
          };
        } catch (error) {
          const local = localMatches('');
          return { success: true, artist: { id: rawArtistId, name: 'Artist', title: 'Artist', kind: 'artist',
            cover: MV.data.coverFor(rawArtistId, 'Artist', true) }, songs: local.songs.slice(0, 8),
            albums: [], singles: [], similar_artists: [], playlists: [], bio: '', source_url: '' };
        }
      }

      const artistId = encodeURIComponent(id);
      try {
        if (section === 'songs') {
          const data = await apiFetch('/artists/' + artistId + '/songs?page=' + (Number(page) + 1));
          const songs = mapToJioFull(
            (data && data.data && Array.isArray(data.data.songs) ? data.data.songs : [])
              .map(toTrackRaw).filter(Boolean)
          );
          rememberStreams(songs.slice(0, 40));
          return { success: true, songs: songs };
        }
        const data = await apiFetch('/artists/' + artistId);
        const artist = data && data.data ? data.data : {};
        const bio = Array.isArray(artist.bio)
          ? artist.bio.map((item) => item && item.text ? item.text : '').join(' ')
          : String(artist.bio || '');
        const songs = mapToJioFull((artist.topSongs || []).map(toTrackRaw).filter(Boolean));
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
    play_provider_track(id) {
      if (String(id || '').indexOf('itunes-') === 0) return playItunes(id);
      return playJioSaavn(id);
    },
    play_song: playLocal,

    pause_song() {
      playRequestId += 1;
      switching = false;
      getAudio().pause();
      return { success: true };
    },

    resume_song() {
      const element = getAudio();
      if (!element.src) return Promise.resolve({ success: true });
      return element.play().then(() => ({ success: true })).catch(() => ({ success: false }));
    },

    stop_song() {
      playRequestId += 1;
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
        playback_state: playbackState,
        source: currentTrack && currentTrack.provider === 'jiosaavn' ? 'jiosaavn' : ''
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
