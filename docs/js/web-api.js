/* ============================================================
   musicVer · static web bridge
   Replaces the Python/pywebview engine on GitHub Pages.

   - live catalogue: JioSaavn-compatible APIs + itunes.apple.com (JSONP)
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
  const CACHE_KEY = 'musicver.web.cache.v2';
  const DISCOVERY_KEY = 'musicver.web.discovery.v2';
  const LIBRARY_KEY = 'musicver.web.localLibrary.v1';
  const SPOTIFY_META_KEY = 'musicver.web.spotifyMeta.v1';
  const MAX_STORED_SPOTIFY_META = 600;
  const FOLDER_KEY = 'musicver.web.folderName';

  const apiBase = read(API_BASE_KEY) || DEFAULT_API;
  const streamCache = new Map();
  const itunesMeta = new Map();
  const jioFullCache = new Map();
  const jioLiveSearchCache = new Map();
  const jioLivePending = new Map();
  const spotifyMeta = new Map();
  const spotifyAlbumMeta = new Map();
  const spotifyArtistMeta = new Map();
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
    const cover = MV.data.normalizeCover(
      bestImage(song.image) || song.cover || song.thumbnail,
      song.title || song.name,
      song.title || song.name
    );
    const downloads = Array.isArray(song.downloadUrl)
      ? song.downloadUrl.map((item) => item && item.url).filter(Boolean)
      : [];
    if (downloads.length) streamCache.set(id, downloads);
    if (MV.artwork) MV.artwork.associate({
      id: id,
      title: song.title || song.name,
      artist: artistName(song),
      album: albumName(song.album || song.album_name),
      provider: 'jiosaavn',
      raw: song
    }, cover);

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
    const cover = MV.data.normalizeCover(
      bestImage(album.image) || album.cover,
      album.title || album.name || 'album',
      album.title || album.name || 'Album'
    );
    const artists = album.artists && Array.isArray(album.artists.primary)
      ? album.artists.primary.map((item) => item.name).join(', ')
      : album.artist;
    if (MV.artwork) MV.artwork.associate({
      id: String(album.id || hash(album.name || album.title)),
      title: album.title || album.name,
      artist: artists,
      kind: 'album',
      provider: 'jiosaavn',
      raw: album
    }, cover);
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
    const cover = MV.data.normalizeCover(
      bestImage(artist.image) || artist.cover,
      artist.name || artist.title || 'artist',
      artist.name || artist.title || 'Artist',
      true
    );
    if (MV.artwork) MV.artwork.associate({
      id: String(artist.id || hash(artist.name || artist.title)),
      name: artist.name || artist.title,
      title: artist.name || artist.title,
      kind: 'artist',
      provider: 'jiosaavn',
      raw: artist
    }, cover);
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

  /* iTunes supplies metadata only. Its audio is a 30-second preview, so it is
     never stored as a playable stream; playback must resolve to a full-length
     JioSaavn original at play time. */

  function itunesArtwork(url, size) {
    if (!url) return '';
    const resized = String(url).replace(
      /\d+x\d+bb\.(jpg|png|jpeg)$/i,
      (size || 600) + 'x' + (size || 600) + 'bb.$1'
    );
    return MV.data.normalizeCover(resized, '', '', false);
  }

  function toItunesTrackRaw(item) {
    if (!item || !item.previewUrl) return null;
    const id = 'itunes-' + String(item.trackId || hash((item.trackName || '') + (item.artistName || '')));
    const cover = itunesArtwork(item.artworkUrl100 || item.artworkUrl60);
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
      downloadUrl: [],
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

  async function itunesSearchAlbums(query, limit) {
    const data = await itunesFetch('/search?term=' + encodeURIComponent(query) +
      '&entity=album&country=US&limit=' + (Number(limit) || 12));
    return (data && Array.isArray(data.results) ? data.results : [])
      .map(toItunesAlbumRaw).filter(Boolean);
  }

  function cleanSearchQuery(query) {
    let text = String(query || '').trim().replace(/\s+/g, ' ');
    text = text.replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:play|search|find|show|open|get|look\s+up)\s+/i, '');
    text = text.replace(/^(?:for|about)\s+/i, '');
    text = text.replace(/^(?:the\s+)?(?:albums?|songs?|artists?|tracks?|music)\s+(?:called\s+|named\s+|titled\s+|entitled\s+|for\s+|by\s+|from\s+)?/i, '');
    text = text.replace(/\s+by\s+/gi, ' ');
    text = text.replace(/\s+(?:feat|featuring)\.?\s+.+$/i, '');
    return text.trim();
  }

  function searchQueryVariants(query) {
    const clean = cleanSearchQuery(query);
    if (!clean) return [];
    const variants = [clean];
    const bare = clean.replace(/^(?:the|a|an)\s+/i, '');
    if (bare && bare !== clean) variants.push(bare);
    if (/^the\s+/i.test(clean)) variants.push('this ' + clean.replace(/^the\s+/i, ''));
    if (/^this\s+/i.test(clean)) variants.push('the ' + clean.replace(/^this\s+/i, ''));
    const seen = new Set();
    return variants.filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4);
  }

  /* Search relevance is stricter than "contains one word". A query such as
     "bohemian rhapsody queen" must not surface a Panic! cover, and an album
     query must not drift to an unrelated artist that shares a word. */
  const SEARCH_STOP_WORDS = new Set([
    'the', 'a', 'an', 'by', 'from', 'feat', 'featuring', 'and', 'with',
    'song', 'songs', 'album', 'albums', 'artist', 'artists', 'track',
    'tracks', 'music', 'of', 'for', 'called', 'named', 'titled'
  ]);

  function searchNorm(value) {
    return decode(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function searchWords(value) {
    return searchNorm(value).split(' ')
      .filter((word) => word && word.length > 1 && !SEARCH_STOP_WORDS.has(word));
  }

  function coverageCount(text, words) {
    const haystack = searchNorm(text);
    return (words || []).filter((word) => haystack.indexOf(word) >= 0).length;
  }

  function parseSearchIntent(query) {
    const raw = String(query || '').trim();
    let artist = '';
    let titleSource = raw;
    const explicit = /\s+(?:by|from)\s+(.+)$/i.exec(raw);
    if (explicit) {
      artist = cleanSearchQuery(explicit[1]);
      titleSource = raw.slice(0, explicit.index);
    }
    const title = cleanSearchQuery(titleSource);
    return { title: title, artist: artist, words: searchWords(title + ' ' + artist) };
  }

  function stripTrailingArtist(title, artist) {
    const titleWords = searchWords(title);
    const artistWords = searchWords(artist);
    if (!artistWords.length || artistWords.length > titleWords.length) {
      return artistWords.length ? '' : title;
    }
    return titleWords.slice(0, titleWords.length - artistWords.length).join(' ');
  }

  function inferIntentArtist(intent, artists) {
    if (!intent || intent.artist) return intent.artist || '';
    const parts = searchNorm(intent.title).split(' ').filter(Boolean);
    const names = (artists || [])
      .map((artist) => searchNorm(artist && (artist.name || artist.title)))
      .filter(Boolean);
    if (!parts.length || !names.length) return '';
    for (let size = Math.min(3, parts.length - 1); size >= 1; size -= 1) {
      const candidate = parts.slice(-size).join(' ');
      if (names.some((name) => name === candidate)) return candidate;
    }
    return '';
  }

  function itemRelevance(item, intent, kind) {
    const words = (intent && intent.words) || [];
    if (!words.length || !item) return 1;
    const titleText = kind === 'artist'
      ? String(item.name || item.title || '')
      : String(item.title || item.name || '');
    const artistText = kind === 'artist' ? titleText : String(item.artist || '');
    const artistWords = searchWords(intent.artist);
    const titleWords = searchWords(intent.title);
    let score = 0;

    if (artistWords.length) {
      const nameText = kind === 'artist' ? titleText : artistText;
      const artistCoverage = coverageCount(nameText, artistWords);
      if (artistCoverage < Math.ceil(artistWords.length / 2)) return 0;
      score += 8 + artistCoverage * 2;
      if (titleWords.length && kind !== 'artist') {
        const titleCoverage = coverageCount(titleText, titleWords);
        if (!titleCoverage) return 0;
        score += titleCoverage * 3;
        if (titleCoverage === titleWords.length) score += 4;
      }
      return score;
    }

    const coverage = coverageCount(titleText + ' ' + artistText, words);
    if (coverage < Math.max(1, Math.ceil(words.length / 2))) return 0;
    score += coverage * 2;
    if (coverageCount(titleText, words) >= Math.ceil(words.length / 2)) score += 3;
    return score;
  }

  function filterRelevant(items, intent, kind) {
    return (items || []).map((item, index) => ({
      item: item,
      index: index,
      score: itemRelevance(item, intent, kind)
    })).filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.item);
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
    if (meta && !currentTrack.cover) {
      const verifiedCover = MV.artwork ? MV.artwork.normalize(meta.cover) : meta.cover;
      if (verifiedCover) {
        currentTrack.cover = verifiedCover;
        currentTrack.image = verifiedCover;
        if (MV.artwork) MV.artwork.associate(currentTrack, verifiedCover);
      }
    }
    rememberStreams([currentTrack]);
    try {
      await startPlayback(resolved.urls, token);
    } catch (error) {
      if (token !== playRequestId) return { success: false, stale: true };
      playbackState = 'paused';
      return { success: false, message: 'No full-length stream found for this song.' };
    }
    if (token !== playRequestId) return { success: false, stale: true };
    return { success: true, source: 'jiosaavn', full: true };
  }

  /* Spotify supplies discovery, artwork and names only. Every Spotify item is
     remapped to a full-length JioSaavn stream before audio starts; if there is
     no strong Jio match, playback fails with a clear message instead of
     silently falling back to a 30-second preview. */
  function compactSpotifyMeta(item) {
    const source = item || {};
    const raw = source.raw || {};
    const isrc = source.isrc || (raw.external_ids && raw.external_ids.isrc) || '';
    return {
      id: source.id,
      title: source.title || '',
      artist: source.artist || '',
      album: source.album || '',
      duration: source.duration || '0',
      language: source.language || '',
      provider: 'spotify',
      path: source.path || ('stream:spotify:' + source.id),
      cover: source.cover || '',
      image: source.image || source.cover || '',
      spotifyId: source.spotifyId || raw.id || '',
      spotifyUrl: source.spotifyUrl || '',
      isrc: isrc,
      raw: {
        id: raw.id || source.spotifyId || '',
        external_ids: { isrc: isrc },
        album: { name: source.album || '', images: (raw.album && raw.album.images) || [] }
      }
    };
  }

  function persistSpotifyMeta() {
    const values = [];
    spotifyMeta.forEach((item, key) => {
      if (!item || key !== item.id || !item.title) return;
      values.push(compactSpotifyMeta(item));
    });
    write(SPOTIFY_META_KEY, JSON.stringify(values.slice(-MAX_STORED_SPOTIFY_META)));
  }

  function loadPersistedSpotifyMeta() {
    const saved = loadObject(SPOTIFY_META_KEY, []);
    if (!Array.isArray(saved)) return;
    saved.slice(-MAX_STORED_SPOTIFY_META).forEach((item) => {
      const compact = compactSpotifyMeta(item);
      if (compact.id && compact.id.indexOf('spotify-') === 0 && compact.title) {
        spotifyMeta.set(compact.id, compact);
      }
    });
  }

  function rememberSpotify(items, persist) {
    (items || []).forEach((item) => {
      if (!item) return;
      const id = String(item.id || '');
      if (id.indexOf('spotify-') !== 0) return;
      spotifyMeta.set(id, item);
      if (item.spotifyId && item.album) spotifyMeta.set('spotify-album-' + item.spotifyId, item);
      if (item.raw && item.raw.id && item.artist) {
        spotifyMeta.set('spotify-artist-' + item.raw.id, item);
      }
    });
    if (persist) persistSpotifyMeta();
  }

  function rememberSpotifyCollections(albums, artists) {
    (albums || []).forEach((album) => {
      if (album && album.id) spotifyAlbumMeta.set(String(album.id), album);
    });
    (artists || []).forEach((artist) => {
      if (artist && artist.id) spotifyArtistMeta.set(String(artist.id), artist);
    });
  }

  function spotifyTrackMeta(id) {
    const key = String(id || '');
    const full = key.indexOf('spotify-') === 0 ? key : 'spotify-' + key;
    return spotifyMeta.get(full) || (MV.spotify ? MV.spotify.trackById(full) : null);
  }

  function dedupeBy(items, keyFn) {
    const seen = new Set();
    return (items || []).filter((item) => {
      if (!item) return false;
      const key = String(keyFn(item) || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function spotifyTrackKey(track) {
    return MV.spotify ? MV.spotify.trackDupeKey(track) : String(track && track.id);
  }

  function spotifyArtistKey(artist) {
    return MV.spotify ? MV.spotify.artistDupeKey(artist) : String(artist && artist.id);
  }

  function spotifyAlbumKey(album) {
    return MV.spotify ? MV.spotify.albumDupeKey(album) : String(album && album.id);
  }

  async function mapSpotifyToJio(tracks, query) {
    const list = (tracks || []).slice(0, 30);
    if (!list.length) return [];
    const candidates = await jioLiveSearch(query || list[0].title + ' ' + list[0].artist, 50);
    return list.map((track) => {
      const bundled = jioFullTrackFor(track);
      if (bundled) return bundled;
      const ranked = candidates.map((candidate) => ({
        track: candidate,
        score: jioMatchScore(candidate, track.title, track.artist)
      })).sort((a, b) => b.score - a.score);
      const best = ranked[0];
      return best && best.score >= 8 ? toJioFullTrack(best.track.id, best.track) : track;
    });
  }

  async function playSpotify(id) {
    const token = ++playRequestId;
    playbackState = 'loading';
    let meta = spotifyTrackMeta(id);
    // Imported playlists are stored locally without provider raw payloads.
    // Re-fetching the Spotify track keeps playback available after a reload.
    if (!meta && MV.spotify && MV.spotify.track) meta = await MV.spotify.track(id);
    if (meta) rememberSpotify([meta]);
    if (!meta) {
      return { success: false, message: 'Spotify metadata expired. Search or open the mix again.' };
    }
    const bundled = jioFullTrackFor(meta);
    const full = bundled || await jioLiveMatch(meta.title, meta.artist);
    if (token !== playRequestId) return { success: false, stale: true };
    if (!full) {
      return { success: false, message: 'No full-length JioSaavn stream matched this Spotify track.' };
    }
    rememberStreams([full]);
    return playJioFull(full.id, meta, token);
  }

  function seedTracks() {
    return (MV.webSeed || []).map((item) => {
      const provider = item.provider || (String(item.id).indexOf('itunes-') === 0 ? 'itunes' : 'jiosaavn');
      const id = String(item.id);
      const stream = provider === 'itunes' ? '' : (item.stream || '');
      const cover = MV.data.normalizeCover(item.cover, id, decode(item.title));
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
        cover: cover,
        image: cover,
        downloadUrl: stream ? [{ quality: '160kbps', url: stream }] : [],
        raw: Object.assign({ provider: provider }, item)
      };
    });
  }

  function cachedTracks() {
    const cache = loadObject(CACHE_KEY, {});
    return Object.keys(cache).map((id) => {
      const item = cache[id];
      const streams = (Array.isArray(item.streams) ? item.streams : (item.stream ? [item.stream] : []))
        .filter((url) => !/audio-ssl\.itunes\.apple\.com|itunes-assets|mzaf_/i.test(String(url)));
      if (streams.length) streamCache.set(id, streams);
      const provider = item.provider || (id.indexOf('itunes-') === 0 ? 'itunes' : 'jiosaavn');
      const cover = MV.data.normalizeCover(item.cover, id, item.title || id);
      return {
        id: id,
        title: item.title || id,
        artist: item.artist || 'Saved track',
        album: item.album || 'Offline cache',
        duration: String(item.duration || 0),
        language: item.language || '',
        provider: provider,
        path: item.path || ('stream:' + provider + ':' + id),
        cover: cover,
        image: cover,
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

  function rankTracks(tracks, query, spotifyFirst, intent) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return tracks;
    const artistWords = searchWords(intent && intent.artist);
    return tracks.map((track, index) => {
      const title = String(track.title || '').toLowerCase();
      const artist = String(track.artist || '').toLowerCase();
      let score = 0;
      if (artist === needle) score = 6;
      else if (title === needle) score = 5;
      else if (artist.indexOf(needle) >= 0 || title.indexOf(needle) >= 0) score = 4;
      else if (needle.split(/\s+/).some((part) => part && (artist.indexOf(part) >= 0 || title.indexOf(part) >= 0))) score = 2;
      if (artistWords.length &&
          coverageCount(artist, artistWords) >= Math.ceil(artistWords.length / 2)) score += 5;
      if (track.provider === 'jiosaavn' && (track.downloadUrl || []).length &&
          Number(track.duration) > 40) score += spotifyFirst ? 2 : 8;
      if (track.provider === 'spotify' && spotifyFirst) score += 9;
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

  /* Apple's Search API does not send CORS headers to GitHub Pages, so a plain
     fetch() always fails in the browser. JSONP is the officially supported
     browser form of this endpoint. Requests are cached and lightly throttled
     to stay well below Apple's rate limit. */
  const itunesRequestCache = new Map();
  const ITUNES_MAX_PARALLEL = 3;
  let itunesActive = 0;
  let itunesCallbackId = 0;
  const itunesWaiters = [];

  function itunesSlot() {
    return new Promise((resolve) => {
      if (itunesActive < ITUNES_MAX_PARALLEL) {
        itunesActive += 1;
        resolve();
      } else {
        itunesWaiters.push(resolve);
      }
    });
  }

  function itunesRelease() {
    const next = itunesWaiters.shift();
    if (next) next();
    else itunesActive -= 1;
  }

  function itunesJsonp(path) {
    const callback = 'mvItunes' + (++itunesCallbackId) + '_' + Math.random().toString(36).slice(2, 8);
    const url = ITUNES_API + path + (path.indexOf('?') >= 0 ? '&' : '?') +
      'callback=' + encodeURIComponent(callback);

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let timer = null;
      let settled = false;

      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { delete window[callback]; } catch (ignored) { window[callback] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
        if (error) reject(error);
        else resolve(data);
      };

      window[callback] = (data) => finish(null, data);
      script.onerror = () => finish(new Error('iTunes request failed.'));
      script.src = url;
      script.async = true;
      timer = setTimeout(() => finish(new Error('iTunes request timed out.')), 15000);
      document.head.appendChild(script);
    });
  }

  function itunesFetch(path) {
    const url = ITUNES_API + path;
    if (itunesRequestCache.has(url)) return itunesRequestCache.get(url);
    const task = itunesSlot()
      .then(() => itunesJsonp(path))
      .then(
        (value) => { itunesRelease(); return value; },
        (error) => { itunesRelease(); throw error; }
      );
    itunesRequestCache.set(url, task);
    return task;
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

  async function playJioSaavn(id, meta) {
    const token = ++playRequestId;
    playbackState = 'loading';
    const key = String(id || '').replace(/^stream:jiosaavn:/, '');
    let urls = streamCache.get(key);
    let track = null;

    // Bundled/catalog IDs (s1, s9, itunes-…) are not JioSaavn IDs. Asking the
    // API about them would only produce a 404 before the title/artist match.
    const looksLikeJioId = /^[A-Za-z0-9_-]{10,}$/.test(key);
    if ((!urls || !urls.length) && looksLikeJioId) {
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

    /* Bundled/search songs use short local IDs (s1, s9, itunes-…) that are not
       JioSaavn IDs. Resolve their title/artist to a verified full-length Jio
       track instead of failing and letting the player skip to another song. */
    if (!urls || !urls.length) {
      const hint = meta || (MV.data.getSong && MV.data.getSong(key)) || track;
      if (hint && (hint.title || hint.artist)) {
        const full = jioFullTrackFor(hint) || await jioLiveMatch(hint.title, hint.artist);
        if (token !== playRequestId) return { success: false, stale: true };
        if (full) return playJioFull(full.id, hint, token);
      }
    }

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
      return { success: false, message: 'No full-length stream found for this song.' };
    }
  }

  async function playItunes(id, meta) {
    const token = ++playRequestId;
    playbackState = 'loading';
    const key = String(id || '');
    const rawId = key.replace(/^itunes-/, '');
    let lookupItem = null;
    let track = itunesMeta.get(key) || seedTracks().concat(cachedTracks())
      .find((item) => String(item.id) === key) || meta || null;

    if (!track) {
      try {
        const items = await itunesLookup(rawId, 'song');
        if (token !== playRequestId) return { success: false, stale: true };
        lookupItem = items.find((entry) => String(entry.trackId) === rawId) || null;
        if (lookupItem) track = toItunesTrackRaw(lookupItem);
      } catch (error) { /* metadata lookup only; full stream is resolved below */ }
    }

    if (track) {
      const full = jioFullTrackFor(track) || await jioLiveMatch(track.title, track.artist);
      if (token !== playRequestId) return { success: false, stale: true };
      if (full) return playJioFull(full.id, track, token);
    }

    /* iTunes audio is a 30-second preview. Never start it: the only valid
       playback source here is the full JioSaavn match resolved above. */
    return { success: false, message: 'No full-length stream found for this song.' };
  }

  async function playLocal(path) {
    const token = ++playRequestId;
    playbackState = 'loading';
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
      const allQueries = queries.concat(mainstreamQueries);
      const [songSettled, albumSettled] = await Promise.all([
        Promise.allSettled(allQueries.map((name) => itunesSearchSongs(name, 8))),
        Promise.allSettled(mainstreamQueries.map((name) => itunesSearchAlbums(name, 8)))
      ]);

      let itunesSongs = [];
      songSettled.filter((item) => item.status === 'fulfilled').forEach((item) => {
        itunesSongs = itunesSongs.concat(item.value);
      });
      let itunesAlbums = [];
      albumSettled.filter((item) => item.status === 'fulfilled').forEach((item) => {
        itunesAlbums = itunesAlbums.concat(item.value);
      });
      const sourceItems = itunesSongs.slice(0, 40).map((track) => track.raw).filter(Boolean);
      const mainstreamArtists = dedupeBy(
        sourceItems.map((item) => toItunesArtistRaw(item)).filter(Boolean), spotifyArtistKey
      );
      const mainstreamAlbums = dedupeBy(
        itunesAlbums.concat(sourceItems.map((item) => toItunesAlbumRaw(item)).filter(Boolean)),
        spotifyAlbumKey
      );
      const catalogSongs = featuredCatalogTracks(24);

      let songs = dedupeById(catalogSongs.concat(mapToJioFull(itunesSongs)));
      if (!songs.length) songs = dedupeById(mapToJioFull(itunesSongs));
      const albums = mainstreamAlbums;
      const artists = mainstreamArtists;

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
        const queries = searchQueryVariants(needle);
        const spotifySettled = await Promise.allSettled([
          MV.spotify ? MV.spotify.search(needle)
            : Promise.resolve({ available: false, tracks: [], albums: [], artists: [] })
        ]);
        const spotify = spotifySettled[0].status === 'fulfilled'
          ? spotifySettled[0].value
          : { available: false, tracks: [], albums: [], artists: [] };

        /* Search metadata comes from Spotify and iTunes only. JioSaavn is not
           queried here; it is used later, when playback needs a full stream. */
        let itunesSongs = [];
        let itunesAlbums = [];
        let itunesArtists = [];
        for (const text of queries) {
          const [songSettled, albumSettled, artistSettled] = await Promise.allSettled([
            itunesSearchSongs(text, 20),
            itunesSearchAlbums(text, 12),
            itunesSearchArtists(text, 10)
          ]);
          if (songSettled.status === 'fulfilled') itunesSongs = itunesSongs.concat(songSettled.value);
          if (albumSettled.status === 'fulfilled') itunesAlbums = itunesAlbums.concat(albumSettled.value);
          if (artistSettled.status === 'fulfilled') itunesArtists = itunesArtists.concat(artistSettled.value);
          if (itunesSongs.length && itunesAlbums.length) break;
        }

        const songArtists = itunesSongs.slice(0, 8)
          .map((track) => toItunesArtistRaw(track.raw)).filter(Boolean);
        const songAlbums = itunesSongs.slice(0, 12)
          .map((track) => toItunesAlbumRaw(track.raw)).filter(Boolean);

        const intent = parseSearchIntent(needle);
        const inferredArtist = inferIntentArtist(
          intent, (spotify.artists || []).concat(itunesArtists, songArtists)
        );
        if (inferredArtist && !intent.artist) {
          intent.artist = inferredArtist;
          intent.title = stripTrailingArtist(intent.title, inferredArtist);
          intent.words = searchWords(intent.title + ' ' + intent.artist);
        }

        rememberSpotify(spotify.tracks);
        rememberSpotifyCollections(spotify.albums, spotify.artists);
        let songs = dedupeBy(
          spotify.tracks.concat(mapToJioFull(itunesSongs)), spotifyTrackKey
        );
        const relevantSongs = filterRelevant(songs, intent, 'song');
        songs = rankTracks(
          relevantSongs.length ? relevantSongs : songs,
          queries[0] || needle, true, intent
        ).slice(0, 40);

        const albumPool = dedupeBy(
          spotify.albums.concat(itunesAlbums, songAlbums), spotifyAlbumKey
        );
        const relevantAlbums = filterRelevant(albumPool, intent, 'album');
        const albums = (relevantAlbums.length ? relevantAlbums : albumPool).slice(0, 12);

        const artistPool = dedupeBy(
          spotify.artists.concat(itunesArtists, songArtists), spotifyArtistKey
        );
        const relevantArtists = filterRelevant(artistPool, intent, 'artist');
        const artists = relevantArtists.length ? relevantArtists : artistPool;
        rememberStreams(songs.filter((song) => song.provider !== 'spotify'));
        return {
          success: true,
          results: songs,
          albums: albums,
          artists: rankArtists(artists, queries[0] || needle).slice(0, 12),
          source: 'online',
          offline: false,
          spotify: Boolean(spotify.available),
          spotifyFirst: Boolean(spotify.tracks.length),
          indianPriority: false
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
      if (albumId.indexOf('spotify-album-') === 0) {
        try {
          const meta = spotifyAlbumMeta.get(albumId);
          const query = [meta && meta.title, meta && meta.artist].filter(Boolean).join(' ');
          const spotifyTracks = meta && MV.spotify
            ? await MV.spotify.albumTracks(meta.spotifyId || albumId)
            : [];
          rememberSpotify(spotifyTracks);
          let tracks = spotifyTracks.length ? await mapSpotifyToJio(spotifyTracks, query) : [];
          if (!tracks.length && query) {
            tracks = (await jioLiveSearch(query, 50)).slice(0, 30);
          }
          rememberStreams(tracks);
          return { success: true, tracks: tracks, source: 'spotify+jiosaavn' };
        } catch (error) {
          return { success: true, tracks: [], source: 'spotify+jiosaavn' };
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
      if (rawArtistId.indexOf('spotify-artist-') === 0) {
        try {
          const meta = spotifyArtistMeta.get(rawArtistId);
          const details = meta && MV.spotify ? await MV.spotify.artistDetails(rawArtistId) : null;
          const spotifyTracks = details
            ? details.tracks
            : (meta && MV.spotify ? await MV.spotify.artistTracks(rawArtistId) : []);
          rememberSpotify(spotifyTracks);
          const query = String((meta && (meta.name || meta.title)) || '') + ' songs';
          let tracks = spotifyTracks.length ? await mapSpotifyToJio(spotifyTracks, query) : [];
          if (!tracks.length && query.trim()) {
            tracks = (await jioLiveSearch(query, 40)).slice(0, 20);
          }
          const artist = (details && details.artist) || meta || {
            id: rawArtistId,
            name: 'Artist',
            title: 'Artist',
            kind: 'artist',
            cover: D.coverFor(rawArtistId, 'Artist', true)
          };
          rememberStreams(tracks.slice(0, 40));
          if (section === 'songs') {
            const size = Number(limit) || 20;
            const start = (Number(page) || 0) * size;
            return { success: true, songs: tracks.slice(start, start + size) };
          }
          return {
            success: true,
            artist: artist,
            songs: tracks.slice(0, 20),
            albums: (details && details.albums) || [],
            singles: [],
            similar_artists: [],
            playlists: [],
            bio: (details && details.bio) || '',
            source_url: artist.spotifyUrl || ''
          };
        } catch (error) {
          const local = localMatches('');
          return { success: true, artist: { id: rawArtistId, name: 'Artist', title: 'Artist', kind: 'artist',
            cover: D.coverFor(rawArtistId, 'Artist', true) }, songs: local.songs.slice(0, 8),
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
    rememberSpotify(items) { rememberSpotify(items, true); },
    play_provider_track(id, meta) {
      const key = String(id || '');
      if (key.indexOf('spotify-') === 0) return playSpotify(key);
      if (key.indexOf('itunes-') === 0) return playItunes(key, meta);
      return playJioSaavn(key, meta);
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
  loadPersistedSpotifyMeta();
  cachedTracks();
  window.MV = MV;
  MV.webApi = webApi;
  window.pywebview = window.pywebview || {};
  window.pywebview.api = webApi;
  document.dispatchEvent(new CustomEvent('mv:webapi-ready'));
})(window.MV = window.MV || {});
