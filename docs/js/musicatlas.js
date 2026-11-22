/* ============================================================
   musicVer · MusicAtlas recommendation layer
   Optional song-radio engine. MusicAtlas returns track and artist
   names from its public similarity index; audio is always resolved
   through our normal full-length JioSaavn pipeline. The deployed
   site talks to MusicAtlas through a small same-origin-friendly
   proxy because their public endpoints reject github.io origins.
   ============================================================ */

(function (MV) {
  'use strict';

  const MCP_URL = 'https://mcp.musicatlas.ai/mcp';
  const TOOL_NAME = 'find_similar_tracks';
  const PROXY_STORAGE = 'musicver.musicatlas.proxy';
  const ERROR_STORAGE = 'musicver.musicatlas.error';
  const CACHE_LIMIT = 80;
  const cache = new Map();
  const listeners = new Set();

  // Drop settings left behind by the previous provider.
  try {
    localStorage.removeItem('musicver.lastfm.apiKey');
    localStorage.removeItem('musicver.lastfm.error');
  } catch (error) { /* private mode */ }

  function read(key) {
    try { return localStorage.getItem(key) || ''; } catch (error) { return ''; }
  }

  function write(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (error) { /* private mode / quota */ }
  }

  function proxyUrl() {
    return String(read(PROXY_STORAGE) || '').trim().replace(/\/+$/, '');
  }

  function lastError() { return String(read(ERROR_STORAGE) || ''); }

  function setError(message) {
    const text = String(message || '').trim();
    write(ERROR_STORAGE, text);
    emitStatus();
  }

  function directAllowed() {
    try {
      const host = String(window.location.hostname || '').toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    } catch (error) {
      return false;
    }
  }

  function status() {
    const proxy = proxyUrl();
    return {
      name: 'MusicAtlas',
      configured: Boolean(proxy),
      ready: Boolean(proxy || directAllowed()),
      direct: !proxy && directAllowed(),
      proxyUrl: proxy,
      error: lastError(),
      attribution: 'Recommendations from MusicAtlas'
    };
  }

  function emitStatus() {
    const detail = status();
    try {
      document.dispatchEvent(new CustomEvent('mv:musicatlas', { detail: detail }));
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

  function setProxyUrl(value) {
    const input = String(value == null ? '' : value).trim().replace(/\/+$/, '');
    let next = input;
    if (next && !/^https?:\/\//i.test(next)) next = 'https://' + next;
    try {
      if (next) {
        const parsed = new URL(next);
        if (!/^https?:$/.test(parsed.protocol)) next = '';
      }
    } catch (error) {
      setError('Enter a valid https:// proxy URL.');
      return status();
    }
    if (next !== proxyUrl()) {
      write(PROXY_STORAGE, next);
      write(ERROR_STORAGE, '');
      cache.clear();
      emitStatus();
    }
    return status();
  }

  function normalized(value) {
    let text = String(value == null ? '' : value).toLowerCase();
    if (text.normalize) text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  function hash(value) {
    let result = 2166136261;
    String(value || '').split('').forEach((char) => {
      result ^= char.charCodeAt(0);
      result = Math.imul(result, 16777619);
    });
    return (result >>> 0).toString(36);
  }

  function seedParts(seed) {
    const source = seed && typeof seed === 'object' ? seed : { title: seed };
    const title = String(source.title || source.track || source.name || '').trim();
    const artistValue = source.artist;
    const artist = String(
      artistValue && typeof artistValue === 'object'
        ? (artistValue.name || artistValue.title || '')
        : (artistValue || '')
    ).trim();
    return { title: title, artist: artist };
  }

  function toRecommendation(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const title = String(entry.title || entry.name || entry.track || '').trim();
    if (!title) return null;
    const artistValue = entry.artist;
    const artist = String(
      artistValue && typeof artistValue === 'object'
        ? (artistValue.name || artistValue.title || '')
        : (artistValue || '')
    ).trim();
    const mapPath = String(entry.map_path || '').trim();
    return {
      id: 'musicatlas-' + hash(normalized(title) + '|' + normalized(artist)),
      title: title,
      artist: artist,
      match: Number(entry.atlas_similarity || entry.match || entry.score) || 0,
      url: mapPath ? 'https://musicatlas.ai' + (mapPath[0] === '/' ? '' : '/') + mapPath : '',
      source: 'musicatlas'
    };
  }

  function extractMatches(data) {
    if (!data || typeof data !== 'object') return [];
    const list = data.matches || data.tracks ||
      (data.result && (data.result.matches || (data.result.structuredContent && data.result.structuredContent.matches)));
    if (Array.isArray(list)) return list.map(toRecommendation).filter(Boolean);
    const content = data.result && data.result.content;
    const textItem = Array.isArray(content) && content.find((item) => item && item.type === 'text');
    if (textItem && textItem.text) {
      try { return extractMatches(JSON.parse(textItem.text)); } catch (error) { return []; }
    }
    return [];
  }

  function parseBody(text) {
    const body = String(text || '').trim();
    if (!body) throw new Error('MusicAtlas returned an empty response.');
    try { return JSON.parse(body); } catch (error) { /* SSE response */ }
    const dataLines = body.split(/\r?\n/)
      .filter((line) => line.indexOf('data:') === 0)
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (!dataLines.length) throw new Error('MusicAtlas returned an unreadable response.');
    try { return JSON.parse(dataLines[dataLines.length - 1]); } catch (error) {
      throw new Error('MusicAtlas returned an unreadable response.');
    }
  }

  function responseError(data) {
    if (!data || typeof data !== 'object') return '';
    if (data.error && typeof data.error === 'object') return data.error.message || 'MusicAtlas request failed.';
    if (data.error) return String(data.error);
    if (data.result && data.result.error) {
      const error = data.result.error;
      return (error && error.message) || 'MusicAtlas request failed.';
    }
    if (data.message && data.success === false) return String(data.message);
    return '';
  }

  /** Public MCP works from localhost; github.io needs the deployed proxy. */
  function endpoint() {
    return proxyUrl() || (directAllowed() ? MCP_URL : '');
  }

  function cacheSet(key, promise) {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== key) cache.delete(oldest);
    }
    cache.set(key, promise);
  }

  /**
   * Song-to-song recommendations from MusicAtlas audio similarity.
   * Returns compact { title, artist, match } entries; callers resolve names
   * through the JioSaavn pipeline before playback. One response is cached per
   * song and shared by radio, shelves and playlist suggestions.
   */
  function similarTracks(seed) {
    const parts = seedParts(seed);
    const empty = { available: false, source: 'musicatlas', tracks: [] };
    if (!parts.title) return Promise.resolve(empty);
    const target = endpoint();
    if (!target) {
      return Promise.resolve(Object.assign({}, empty, {
        reason: 'proxy-required',
        message: 'Add your MusicAtlas proxy URL in Account.'
      }));
    }

    const key = JSON.stringify([normalized(parts.title), normalized(parts.artist)]);
    if (cache.has(key)) return cache.get(key);

    const body = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: TOOL_NAME,
        arguments: { artist: parts.artist, track: parts.title }
      }
    };
    const promise = fetch(target, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify(body)
    }).then(async (response) => {
      const text = await response.text();
      let data = null;
      try { data = parseBody(text); } catch (error) { /* handled below */ }
      if (!response.ok) {
        throw new Error(responseError(data) || ('MusicAtlas returned HTTP ' + response.status));
      }
      const problem = responseError(data);
      if (problem) throw new Error(problem);
      const tracks = extractMatches(data);
      if (!tracks.length) setError('MusicAtlas found no similar tracks for this song.');
      else write(ERROR_STORAGE, '');
      return { available: Boolean(tracks.length), source: 'musicatlas', tracks: tracks };
    }).catch((error) => {
      const message = error && error.message
        ? error.message
        : 'MusicAtlas request failed. Check the proxy URL in Account.';
      setError(message);
      return { available: false, source: 'musicatlas', tracks: [], message: message };
    });

    cacheSet(key, promise);
    return promise;
  }

  function songRadio(song) {
    return similarTracks(seedParts(song));
  }

  function clearCache() { cache.clear(); }

  MV.musicatlas = {
    status: status,
    onStatus: onStatus,
    setProxyUrl: setProxyUrl,
    similarTracks: similarTracks,
    songRadio: songRadio,
    clearCache: clearCache,
    lastError: lastError
  };
})(window.MV = window.MV || {});
