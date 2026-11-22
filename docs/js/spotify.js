/* ============================================================
   musicVer · Spotify catalogue layer
   Browser-only PKCE client. No client secret is bundled: the user
   supplies a Spotify Client ID and signs in from Settings. Spotify
   supplies search/metadata/recommendations; audio is resolved to
   JioSaavn by web-api.js before playback.
   ============================================================ */

(function (MV) {
  'use strict';

  const AUTH_URL = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API_BASE = 'https://api.spotify.com/v1';
  const PLAYLIST_SCOPES = 'playlist-read-private playlist-read-collaborative';
  const MAX_IMPORT_TRACKS = 500;

  const CLIENT_KEY = 'musicver.spotify.clientId';
  const TOKEN_KEY = 'musicver.spotify.tokens';
  const PREF_KEY = 'musicver.spotify.preferences';
  const PKCE_KEY = 'musicver.spotify.pkce';
  const ERROR_KEY = 'musicver.spotify.error';

  const DEFAULT_PREFS = { spotifyFirst: true, indiaSaavnFirst: true };
  const INDIAN_LANGUAGES = new Set([
    'hindi', 'bollywood', 'tamil', 'telugu', 'kannada', 'malayalam',
    'marathi', 'bengali', 'punjabi', 'gujarati', 'urdu', 'bhojpuri',
    'assamese', 'odia', 'nepali', 'sanskrit', 'indian', 'desi'
  ]);

  const INDIC_SCRIPT = /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;
  const SPOTIFY_ID = /[A-Za-z0-9]{22}/;

  const trackIndex = new Map();
  const recCache = new Map();
  const listeners = new Set();

  let lastPlaylistError = '';
  let lastPlaylistStatus = 0;

  let accessToken = '';
  let refreshToken = '';
  let tokenScope = '';
  let expiresAt = 0;
  let refreshPromise = null;
  let callbackPromise = null;

  /* ---------------- storage ---------------- */

  function read(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }

  function write(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (error) { /* private mode / quota */ }
  }

  function readObject(key, fallback) {
    try {
      const raw = read(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeObject(key, value) {
    write(key, JSON.stringify(value));
  }

  function clientId() {
    return String(read(CLIENT_KEY) || '').trim();
  }

  function preferences() {
    return Object.assign({}, DEFAULT_PREFS, readObject(PREF_KEY, {}));
  }

  function loadTokens() {
    const saved = readObject(TOKEN_KEY, null);
    if (!saved) return;
    accessToken = String(saved.accessToken || '');
    refreshToken = String(saved.refreshToken || '');
    tokenScope = String(saved.scope || '');
    expiresAt = Number(saved.expiresAt) || 0;
  }

  function saveTokens(data) {
    if (!data) return;
    if (data.access_token) accessToken = String(data.access_token);
    if (data.refresh_token) refreshToken = String(data.refresh_token);
    if (data.scope) tokenScope = String(data.scope);
    expiresAt = data.expires_in
      ? Date.now() + (Number(data.expires_in) - 60) * 1000
      : (accessToken ? Date.now() + 50 * 60 * 1000 : 0);
    if (accessToken || refreshToken) {
      writeObject(TOKEN_KEY, { accessToken: accessToken, refreshToken: refreshToken, scope: tokenScope, expiresAt: expiresAt });
    }
    write(ERROR_KEY, null);
    emitStatus();
  }

  /* ---------------- status ---------------- */

  function hasPlaylistScope() {
    return /\bplaylist-read-(?:private|collaborative)\b/.test(tokenScope);
  }

  function status() {
    const prefs = preferences();
    return {
      configured: Boolean(clientId()),
      connected: Boolean(accessToken || refreshToken),
      ready: Boolean(accessToken && Date.now() < expiresAt),
      canImportPlaylists: hasPlaylistScope(),
      maxImportTracks: MAX_IMPORT_TRACKS,
      clientId: clientId(),
      redirectUri: redirectUri(),
      preferences: prefs,
      error: read(ERROR_KEY) || ''
    };
  }

  function emitStatus() {
    const detail = status();
    try {
      document.dispatchEvent(new CustomEvent('mv:spotify', { detail: detail }));
    } catch (error) { /* CustomEvent unavailable in very old browsers */ }
    listeners.forEach((listener) => {
      try { listener(detail); } catch (error) { /* ignore listener errors */ }
    });
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function redirectUri() {
    return location.origin + location.pathname;
  }

  /* ---------------- PKCE auth ---------------- */

  function randomString(length) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = new Uint8Array(length);
    crypto.getRandomValues(values);
    let result = '';
    for (let i = 0; i < values.length; i += 1) result += alphabet[values[i] % alphabet.length];
    return result;
  }

  function base64Url(buffer) {
    let binary = '';
    new Uint8Array(buffer).forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  }

  async function challengeFor(verifier) {
    if (!window.crypto || !crypto.subtle || !window.TextEncoder) {
      throw new Error('Spotify sign-in needs a secure HTTPS or localhost page.');
    }
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64Url(digest);
  }

  async function connect() {
    const id = clientId();
    if (!id) throw new Error('Add your Spotify Client ID in Settings first.');
    const verifier = randomString(64);
    const state = randomString(28);
    const challenge = await challengeFor(verifier);
    writeObject(PKCE_KEY, { verifier: verifier, state: state, savedAt: Date.now(), redirectUri: redirectUri() });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: id,
      redirect_uri: redirectUri(),
      state: state,
      scope: PLAYLIST_SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge
    });
    location.href = AUTH_URL + '?' + params.toString();
  }

  async function tokenRequest(params) {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString()
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Spotify did not return an access token.');
    }
    return data;
  }

  async function handleCallback() {
    if (callbackPromise) return callbackPromise;
    callbackPromise = (async function () {
      const params = new URLSearchParams(location.search);
      const hasAuth = params.has('code') || params.has('error');
      if (!hasAuth) return false;

      const saved = readObject(PKCE_KEY, null);
      const state = params.get('state');
      if (params.get('error')) {
        write(ERROR_KEY, params.get('error') === 'access_denied'
          ? 'Spotify sign-in was cancelled.'
          : 'Spotify sign-in failed: ' + params.get('error'));
        write(PKCE_KEY, null);
      } else if (!saved || saved.state !== state || Date.now() - Number(saved.savedAt || 0) > 10 * 60 * 1000) {
        write(ERROR_KEY, 'Spotify sign-in expired. Try connecting again.');
        write(PKCE_KEY, null);
      } else {
        try {
          const data = await tokenRequest({
            grant_type: 'authorization_code',
            code: params.get('code'),
            redirect_uri: saved.redirectUri || redirectUri(),
            client_id: clientId(),
            code_verifier: saved.verifier
          });
          saveTokens(data);
        } catch (error) {
          write(ERROR_KEY, error.message || 'Could not finish Spotify sign-in.');
        } finally {
          write(PKCE_KEY, null);
        }
      }

      const clean = new URL(location.href);
      ['code', 'state', 'error'].forEach((key) => clean.searchParams.delete(key));
      history.replaceState(null, document.title, clean.pathname + clean.search + clean.hash);
      emitStatus();
      return true;
    }());
    return callbackPromise;
  }

  async function refresh() {
    if (!refreshToken || !clientId()) return null;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async function () {
      try {
        const data = await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId()
        });
        saveTokens(data);
        return accessToken;
      } catch (error) {
        write(ERROR_KEY, 'Spotify session expired. Connect again.');
        accessToken = '';
        refreshToken = '';
        expiresAt = 0;
        write(TOKEN_KEY, null);
        emitStatus();
        return null;
      } finally {
        refreshPromise = null;
      }
    }());
    return refreshPromise;
  }

  async function ensureToken() {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    if (refreshToken) return refresh();
    return null;
  }

  async function api(path) {
    let token = await ensureToken();
    if (!token) return null;
    const url = /^https:\/\//i.test(String(path)) ? String(path) : API_BASE + path;
    let response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    });
    if (response.status === 401 && refreshToken) {
      token = await refresh();
      if (!token) return null;
      response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
      });
    }
    if (!response.ok) {
      let message = 'Spotify request failed (' + response.status + ').';
      try {
        const body = await response.json();
        if (body && body.error && body.error.message) message = body.error.message;
      } catch (error) { /* keep generic message */ }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /* ---------------- normalisers ---------------- */

  function imageUrl(images, size) {
    if (!Array.isArray(images) || !images.length) return '';
    const wanted = Number(size) || 640;
    const sorted = images.slice().sort((a, b) => Math.abs((a.width || 0) - wanted) - Math.abs((b.width || 0) - wanted));
    return (sorted[0] && sorted[0].url) || '';
  }

  function artistNames(artists) {
    if (!Array.isArray(artists)) return 'Unknown artist';
    return artists.map((artist) => (artist && artist.name) || '').filter(Boolean).join(', ') || 'Unknown artist';
  }

  function toTrackRaw(raw) {
    if (!raw || !raw.id) return null;
    const id = 'spotify-' + String(raw.id);
    const cover = imageUrl(raw.album && raw.album.images, 640) || imageUrl(raw.images, 640);
    if (MV.artwork) MV.artwork.associate({
      id: id,
      spotifyId: String(raw.id),
      title: raw.name,
      artist: artistNames(raw.artists),
      album: raw.album && raw.album.name,
      provider: 'spotify',
      raw: raw
    }, cover);
    const track = {
      id: id,
      title: String(raw.name || 'Unknown title'),
      artist: artistNames(raw.artists),
      album: String((raw.album && raw.album.name) || 'Single'),
      duration: String(Math.round((Number(raw.duration_ms) || 0) / 1000)),
      language: String((raw.album && raw.album.album_type) || ''),
      year: String(((raw.album && raw.album.release_date) || '').slice(0, 4)),
      provider: 'spotify',
      path: 'stream:spotify:' + id,
      cover: cover,
      image: cover,
      downloadUrl: [],
      spotifyId: String(raw.id),
      spotifyUrl: (raw.external_urls && raw.external_urls.spotify) || '',
      previewUrl: raw.preview_url || '',
      raw: raw
    };
    trackIndex.set(id, track);
    return track;
  }

  function toAlbumRaw(raw) {
    if (!raw || !raw.id) return null;
    const cover = imageUrl(raw.images, 640);
    if (MV.artwork) MV.artwork.associate({
      id: 'spotify-album-' + String(raw.id),
      spotifyId: String(raw.id),
      title: raw.name,
      artist: artistNames(raw.artists),
      kind: 'album',
      provider: 'spotify',
      raw: raw
    }, cover);
    return {
      id: 'spotify-album-' + String(raw.id),
      title: String(raw.name || 'Unknown album'),
      artist: String(raw.artists && raw.artists.length ? artistNames(raw.artists) : 'Unknown artist'),
      year: String((raw.release_date || '').slice(0, 4)),
      language: '',
      track_count: Number(raw.total_tracks) || null,
      token: '',
      kind: 'spotifyAlbum',
      cover: cover,
      image: cover,
      spotifyId: String(raw.id),
      spotifyUrl: (raw.external_urls && raw.external_urls.spotify) || '',
      raw: raw
    };
  }

  function toArtistRaw(raw) {
    if (!raw || !raw.id) return null;
    const cover = imageUrl(raw.images, 640);
    const name = String(raw.name || 'Unknown artist');
    if (MV.artwork) MV.artwork.associate({
      id: 'spotify-artist-' + String(raw.id),
      spotifyId: String(raw.id),
      name: name,
      title: name,
      kind: 'artist',
      provider: 'spotify',
      raw: raw
    }, cover);
    return {
      id: 'spotify-artist-' + String(raw.id),
      name: name,
      title: name,
      kind: 'artist',
      listeners: Number(raw.followers && raw.followers.total) || null,
      token: '',
      cover: cover,
      image: cover,
      genres: Array.isArray(raw.genres) ? raw.genres.slice() : [],
      spotifyId: String(raw.id),
      spotifyUrl: (raw.external_urls && raw.external_urls.spotify) || '',
      raw: raw
    };
  }

  function toPlaylistRaw(raw) {
    if (!raw || !raw.id) return null;
    const rawId = String(raw.id);
    const id = 'spotify-playlist-' + rawId;
    const cover = imageUrl(raw.images, 640);
    if (MV.artwork) MV.artwork.associate({
      id: id,
      spotifyId: rawId,
      title: raw.name,
      kind: 'playlist',
      provider: 'spotify',
      raw: raw
    }, cover);
    return {
      id: id,
      name: String(raw.name || 'Untitled playlist'),
      title: String(raw.name || 'Untitled playlist'),
      description: String(raw.description || ''),
      cover: cover,
      image: cover,
      trackCount: Number(raw.tracks && raw.tracks.total) || 0,
      owner: String((raw.owner && (raw.owner.display_name || raw.owner.id)) || ''),
      public: Boolean(raw.public),
      spotifyId: rawId,
      spotifyUrl: (raw.external_urls && raw.external_urls.spotify) || '',
      kind: 'spotifyPlaylist',
      provider: 'spotify',
      raw: raw
    };
  }

  function trackById(id) {
    const key = String(id || '');
    return trackIndex.get(key) || trackIndex.get('spotify-' + key.replace(/^spotify-/, '')) || null;
  }

  /* ---------------- search + recommendations ---------------- */

  function cleanSearchQuery(query) {
    let text = String(query || '').trim().replace(/\s+/g, ' ');
    text = text.replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:play|search|find|show|open|get|look\s+up)\s+/i, '');
    text = text.replace(/^(?:for|about)\s+/i, '');
    text = text.replace(/^(?:the\s+)?(?:albums?|songs?|artists?|tracks?|music)\s+(?:called\s+|named\s+|titled\s+|entitled\s+|for\s+|by\s+|from\s+)?/i, '');
    text = text.replace(/\s+by\s+/gi, ' ');
    text = text.replace(/\s+(?:feat|featuring)\.?\s+.+$/i, '');
    return text.trim();
  }

  function searchQueries(query) {
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

  function normalizeSearchData(data) {
    return {
      available: true,
      tracks: (((data && data.tracks && data.tracks.items) || []).map(toTrackRaw)).filter(Boolean),
      albums: (((data && data.albums && data.albums.items) || []).map(toAlbumRaw)).filter(Boolean),
      artists: (((data && data.artists && data.artists.items) || []).map(toArtistRaw)).filter(Boolean)
    };
  }

  function hasResults(result) {
    return Boolean(result && (result.tracks.length || result.albums.length || result.artists.length));
  }

  async function search(query) {
    const empty = { available: false, tracks: [], albums: [], artists: [] };
    const queries = searchQueries(query);
    if (!queries.length || !(await ensureToken())) return empty;
    let fallback = empty;
    try {
      for (const needle of queries) {
        const data = await api('/search?q=' + encodeURIComponent(needle) +
          '&type=track,album,artist&limit=24');
        if (!data) continue;
        const result = normalizeSearchData(data);
        if (!hasResults(fallback)) fallback = result;
        if (hasResults(result)) return result;
      }
      return fallback;
    } catch (error) {
      return hasResults(fallback) ? fallback : empty;
    }
  }

  async function albumTracks(id) {
    const rawId = spotifyIdOf(id);
    if (!rawId || !(await ensureToken())) return [];
    try {
      const data = await api('/albums/' + encodeURIComponent(rawId) + '/tracks?limit=50&country=US');
      return ((data && data.items) || []).map((item) => toTrackRaw(item)).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  async function artistTracks(id) {
    const rawId = spotifyIdOf(id);
    if (!rawId || !(await ensureToken())) return [];
    try {
      const data = await api('/artists/' + encodeURIComponent(rawId) + '/top-tracks?country=US');
      return ((data && data.tracks) || []).map((track) => toTrackRaw(track)).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  async function artistDetails(id) {
    const rawId = spotifyIdOf(id);
    if (!rawId || !(await ensureToken())) return null;
    try {
      const [artist, top, albums] = await Promise.all([
        api('/artists/' + encodeURIComponent(rawId)),
        api('/artists/' + encodeURIComponent(rawId) + '/top-tracks?country=US'),
        api('/artists/' + encodeURIComponent(rawId) + '/albums?include_groups=album,single&limit=20&country=US')
      ]);
      return {
        artist: toArtistRaw(artist),
        tracks: (((top && top.tracks) || []).map(toTrackRaw)).filter(Boolean),
        albums: (((albums && albums.items) || []).map(toAlbumRaw)).filter(Boolean),
        genres: (artist && Array.isArray(artist.genres)) ? artist.genres.slice() : [],
        bio: ''
      };
    } catch (error) {
      return null;
    }
  }

  async function apiPaged(path, maxItems) {
    const limit = Math.max(1, Number(maxItems) || MAX_IMPORT_TRACKS);
    const items = [];
    let next = path;
    let pages = 0;
    while (next && items.length < limit && pages < 30) {
      const data = await api(next);
      if (!data) break;
      const page = Array.isArray(data.items) ? data.items : [];
      page.forEach((item) => {
        if (items.length < limit) items.push(item);
      });
      next = data.next || '';
      pages += 1;
    }
    return items;
  }

  async function userPlaylists() {
    if (!hasPlaylistScope() || !(await ensureToken())) return [];
    try {
      const fields = [
        'next',
        'items(id,name,description,images,tracks(total),owner(display_name,id),public,external_urls)'
      ].join(',');
      const raw = await apiPaged('/me/playlists?limit=50&fields=' + encodeURIComponent(fields), 200);
      return raw.map(toPlaylistRaw).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  function playlistItemTrack(entry) {
    if (!entry || typeof entry !== 'object') return null;
    // Spotify's current playlist-items endpoint returns `item`; the deprecated
    // endpoint returns `track`. Accept both so imports keep working during the
    // transition, and skip local files and non-track items such as episodes.
    const source = entry.item || entry.track || null;
    if (!source || source.type === 'episode' || source.episode) return null;
    if (entry.is_local || source.is_local) return null;
    return source;
  }

  function normalizePlaylistTracks(entries) {
    const seen = new Set();
    const tracks = [];
    (entries || []).forEach((entry) => {
      const source = playlistItemTrack(entry);
      if (!source || !source.id) return;
      const track = toTrackRaw(source);
      if (!track || seen.has(track.id)) return;
      seen.add(track.id);
      tracks.push(track);
    });
    return tracks;
  }

  async function playlistTracks(id, limit) {
    lastPlaylistError = '';
    lastPlaylistStatus = 0;
    const rawId = spotifyIdOf(id);
    const size = Math.min(MAX_IMPORT_TRACKS, Math.max(1, Number(limit) || MAX_IMPORT_TRACKS));
    if (!rawId || !(await ensureToken())) return [];
    try {
      const fields = [
        'next',
        'items(added_at,is_local,item(id,name,type,artists,',
        'album(id,name,images,album_type,release_date),',
        'duration_ms,external_ids,external_urls,is_local))'
      ].join('');
      const raw = await apiPaged(
        '/playlists/' + encodeURIComponent(rawId) + '/items?limit=100&fields=' + encodeURIComponent(fields),
        size
      );
      const tracks = normalizePlaylistTracks(raw);
      if (tracks.length) return tracks;

      // Older Spotify responses and some app versions still expose `track`.
      const legacyFields = [
        'next',
        'items(added_at,is_local,track(id,name,type,artists,',
        'album(id,name,images,album_type,release_date),',
        'duration_ms,external_ids,external_urls,is_local))'
      ].join('');
      const legacy = await apiPaged(
        '/playlists/' + encodeURIComponent(rawId) + '/tracks?limit=100&fields=' + encodeURIComponent(legacyFields),
        size
      );
      return normalizePlaylistTracks(legacy);
    } catch (error) {
      lastPlaylistStatus = Number(error.status) || 0;
      lastPlaylistError = lastPlaylistStatus === 403
        ? 'Spotify only allows reading playlists you own or collaborate on. Save a copy in Spotify, then import that copy.'
        : (error.message || 'Spotify could not read that playlist.');
      return [];
    }
  }

  async function track(id) {
    const rawId = spotifyIdOf(id);
    if (!rawId || !(await ensureToken())) return null;
    try {
      return toTrackRaw(await api('/tracks/' + encodeURIComponent(rawId)));
    } catch (error) {
      return null;
    }
  }

  function spotifyIdOf(value) {
    if (!value) return '';
    if (typeof value === 'object') {
      return spotifyIdOf(value.spotifyId || (value.raw && value.raw.id) || value.id);
    }
    const text = String(value);
    const match = text.match(SPOTIFY_ID);
    return match ? match[0] : '';
  }

  function seedText(seeds) {
    const source = seeds || {};
    const list = [];
    (source.queries || []).forEach((item) => { if (item) list.push(String(item)); });
    (source.titles || []).forEach((item) => { if (item) list.push(String(item)); });
    (source.artists || []).forEach((item) => {
      if (item && typeof item === 'object') list.push(String(item.name || item.title || ''));
      else if (item) list.push(String(item));
    });
    return list.filter(Boolean).slice(0, 4);
  }

  function localRecommendations(seeds, limit) {
    const source = seeds || {};
    const live = (MV.discoverData && MV.discoverData.trending) || [];
    const pool = [];
    const seen = new Set();
    const add = (song) => {
      if (!song || !song.title) return;
      const key = String(song.title).toLowerCase() + '|' + String(song.artist || '').toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      pool.push(song);
    };

    // On the search page, seed local picks with the actual results. Without
    // this, the shelf falls back to the first bundled songs and looks like it
    // ignores the search entirely.
    const query = (source.queries || [])[0];
    const search = MV.searchState;
    if (query && search && search.result &&
        String(search.query || '') === String(query)) {
      (search.result.songs || []).forEach(add);
    }
    live.concat((MV.data && MV.data.songs) || []).forEach(add);

    const text = seedText(source).join(' ').toLowerCase();
    const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 2);
    const avoid = new Set((source.titles || []).map((title) => String(title).toLowerCase()));
    const ranked = pool.map((song, index) => {
      const haystack = (String(song.title || '') + ' ' + String(song.artist || '') + ' ' +
        String(song.language || '')).toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.indexOf(token) >= 0 ? 2 : 0), 0);
      return { song: song, score: score, index: index };
    }).filter((entry) => !avoid.has(String(entry.song.title || '').toLowerCase()))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const tracks = ranked.slice(0, Math.max(1, Number(limit) || 8)).map((entry) => entry.song);
    return { available: false, source: 'local', tracks: tracks };
  }

  async function recommendations(seeds, limit) {
    const source = seeds || {};
    const size = Math.max(1, Math.min(30, Number(limit) || 10));
    const trackIds = [];
    const artistIds = [];
    const genres = [];

    (source.tracks || []).forEach((value) => {
      const id = spotifyIdOf(value);
      if (id && trackIds.indexOf(id) < 0) trackIds.push(id);
    });
    (source.artists || []).forEach((value) => {
      const id = spotifyIdOf(value);
      if (id && artistIds.indexOf(id) < 0) artistIds.push(id);
    });
    (source.genres || []).forEach((genre) => {
      const name = String(genre || '').trim().toLowerCase();
      if (name && genres.indexOf(name) < 0) genres.push(name);
    });

    if (!trackIds.length && !artistIds.length && !genres.length && seedText(source).length) {
      const found = await search(seedText(source)[0]);
      if (found.tracks.length) {
        trackIds.push(spotifyIdOf(found.tracks[0]));
        if (found.artists.length) artistIds.push(spotifyIdOf(found.artists[0]));
      }
    }

    if (!trackIds.length && !artistIds.length && !genres.length) return localRecommendations(source, size);
    if (!(await ensureToken())) return localRecommendations(source, size);

    const params = new URLSearchParams({ limit: String(size) });
    let remaining = 5;
    if (remaining && trackIds.length) {
      params.set('seed_tracks', trackIds.slice(0, remaining).join(','));
      remaining -= Math.min(remaining, trackIds.length);
    }
    if (remaining && artistIds.length) {
      params.set('seed_artists', artistIds.slice(0, remaining).join(','));
      remaining -= Math.min(remaining, artistIds.length);
    }
    if (remaining && genres.length) {
      params.set('seed_genres', genres.slice(0, remaining).join(','));
    }

    try {
      const data = await api('/recommendations?' + params.toString());
      if (!data) return localRecommendations(source, size);
      const tracks = ((data.tracks || []).map(toTrackRaw)).filter(Boolean);
      if (!tracks.length) return localRecommendations(source, size);
      return { available: true, source: 'spotify', tracks: tracks };
    } catch (error) {
      return localRecommendations(source, size);
    }
  }

  function cacheKey(seeds, limit) {
    const source = seeds || {};
    return JSON.stringify({
      tracks: (source.tracks || []).map(spotifyIdOf).filter(Boolean).slice(0, 5),
      artists: (source.artists || []).map(spotifyIdOf).filter(Boolean).slice(0, 5),
      genres: (source.genres || []).slice(0, 3),
      queries: seedText(source),
      limit: limit,
      connected: status().ready || status().connected
    });
  }

  function recommendFor(seeds, limit) {
    const key = cacheKey(seeds, limit);
    if (!recCache.has(key)) recCache.set(key, recommendations(seeds, limit));
    return recCache.get(key);
  }

  function clearCache() {
    recCache.clear();
  }

  /* ---------------- provider ranking helpers ---------------- */

  let indianNames = null;

  function indianCatalogNames() {
    if (indianNames) return indianNames;
    const names = new Set();
    const add = (value) => {
      const text = String(value || '').trim().toLowerCase();
      if (text.length >= 4) names.add(text);
      text.split(/\s*,\s*|\s*&\s*|\s+vs\.?\s+/i).forEach((part) => {
        const clean = String(part || '').trim().toLowerCase();
        if (clean.length >= 4) names.add(clean);
      });
    };
    const source = (MV.data && MV.data.songs) || [];
    source.forEach((song) => {
      if (!INDIAN_LANGUAGES.has(String((song && song.language) || '').toLowerCase())) return;
      add(song.title);
      add(song.artist);
      add(song.album);
    });
    ((MV.data && MV.data.albums) || []).forEach((album) => {
      if (!INDIAN_LANGUAGES.has(String((album && album.language) || '').toLowerCase())) return;
      add(album.title);
      add(album.artist);
    });
    indianNames = names;
    return names;
  }

  function mentionsIndianCatalog(text) {
    const needle = String(text || '').toLowerCase();
    if (!needle) return false;
    const names = indianCatalogNames();
    let found = false;
    names.forEach((name) => {
      if (found) return;
      if (needle === name || needle.indexOf(name) >= 0) found = true;
    });
    return found;
  }

  function isIndianQuery(query, tracks) {
    const text = String(query || '');
    if (INDIC_SCRIPT.test(text)) return true;
    if (/(hindi|bollywood|indian|desi|tamil|telugu|kannada|malayalam|marathi|bengali|punjabi|gujarati|urdu|bhojpuri)/i.test(text)) return true;
    if (mentionsIndianCatalog(text)) return true;
    const list = Array.isArray(tracks) ? tracks : [];
    if (!list.length) return false;
    const indian = list.filter((track) => {
      if (INDIAN_LANGUAGES.has(String((track && track.language) || '').toLowerCase())) return true;
      return mentionsIndianCatalog(String((track && track.artist) || '') + ' ' + String((track && track.title) || ''));
    }).length;
    return indian >= Math.max(1, Math.ceil(list.length / 3));
  }

  function trackDupeKey(track) {
    const clean = (value) => String(value || '').toLowerCase()
      .replace(/[\u2018\u2019\u201c\u201d]/g, '')
      .replace(/\(.*?\)|\[.*?\]/g, ' ')
      .replace(/\b(official|audio|video|full|song|hd|hq|lyrics|remastered)\b/g, ' ')
      .replace(/[^a-z0-9\u0900-\u097F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return clean(track && track.title) + '|' + clean(track && track.artist);
  }

  function artistDupeKey(artist) {
    return String((artist && (artist.name || artist.title)) || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function albumDupeKey(album) {
    const clean = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return clean(album && album.title) + '|' + clean(album && album.artist);
  }

  function mergePreferred(primary, secondary, keyFn) {
    const seen = new Set();
    const result = [];
    [].concat(primary || [], secondary || []).forEach((item) => {
      if (!item) return;
      const key = keyFn(item);
      if (key && seen.has(key)) return;
      if (key) seen.add(key);
      result.push(item);
    });
    return result;
  }

  /* ---------------- settings helpers ---------------- */

  function setClientId(value) {
    const id = String(value || '').trim();
    if (!id) write(CLIENT_KEY, null);
    else write(CLIENT_KEY, id);
    clearCache();
    emitStatus();
    return status();
  }

  function setPreference(key, value) {
    if (!(key in DEFAULT_PREFS)) return;
    const prefs = preferences();
    prefs[key] = Boolean(value);
    writeObject(PREF_KEY, prefs);
    clearCache();
    emitStatus();
  }

  function disconnect() {
    accessToken = '';
    refreshToken = '';
    tokenScope = '';
    expiresAt = 0;
    write(TOKEN_KEY, null);
    write(ERROR_KEY, null);
    recCache.clear();
    emitStatus();
  }

  function lastError() {
    return read(ERROR_KEY) || '';
  }

  loadTokens();

  MV.spotify = {
    status: status,
    onStatus: onStatus,
    connect: connect,
    disconnect: disconnect,
    search: search,
    track: track,
    albumTracks: albumTracks,
    artistTracks: artistTracks,
    artistDetails: artistDetails,
    userPlaylists: userPlaylists,
    playlistTracks: playlistTracks,
    toPlaylistRaw: toPlaylistRaw,
    recommendations: recommendations,
    recommendFor: recommendFor,
    trackById: trackById,
    toTrackRaw: toTrackRaw,
    toAlbumRaw: toAlbumRaw,
    toArtistRaw: toArtistRaw,
    setClientId: setClientId,
    setPreference: setPreference,
    clearCache: clearCache,
    lastError: lastError,
    lastPlaylistError: () => lastPlaylistError,
    lastPlaylistStatus: () => lastPlaylistStatus,
    handleCallback: handleCallback,
    isIndianQuery: isIndianQuery,
    trackDupeKey: trackDupeKey,
    artistDupeKey: artistDupeKey,
    albumDupeKey: albumDupeKey,
    mergePreferred: mergePreferred
  };

  handleCallback().catch((error) => {
    write(ERROR_KEY, error.message || 'Spotify sign-in failed.');
    emitStatus();
  });
})(window.MV = window.MV || {});
