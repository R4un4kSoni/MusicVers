/* MusicVers — universal artwork manager.
   One place for artwork normalisation, verified source matching, loading,
   fallbacks, persistence and request coordination. No provider keys here. */
(function (MV) {
  'use strict';

  var DB_NAME = 'musicver-artwork-v2';
  var ITUNES_API = 'https://itunes.apple.com';
  var DB_STORE = 'images';
  var DB_VERSION = 1;
  var TTL = 14 * 24 * 60 * 60 * 1000; // 14 days
  var MAX_ENTRIES = 120;
  var MAX_FAILED_AGE = 6 * 60 * 60 * 1000; // 6 hours
  var MAX_TOKENS = 2400;
  var PROVIDER_RANK = {
    spotify: 1,
    jiosaavn: 2,
    itunes: 3,
    apple: 3,
    bundled: 4,
    local: 4
  };

  var config = {
    proxyEndpoint: '',
    allowProxy: false,
    timeout: 12000,
    maxConcurrent: 4,
    ttl: TTL,
    useCache: true
  };

  var dbPromise = null;
  var memory = new Map();
  var failed = new Map();
  var inflight = new Map();
  var index = new Map();
  var tokens = new Map();
  var lookupMemo = new Map();
  var lookupPending = new Map();
  var queue = [];
  var active = 0;
  var tokenId = 0;
  var ready = false;
  var observer = null;
  var mutationObserver = null;

  function text(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function attr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function cssUrl(url) {
    return 'url("' + String(url || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '")';
  }

  function isBlob(value) {
    return typeof value === 'string' && /^blob:/i.test(value);
  }

  function isData(value) {
    return typeof value === 'string' && /^data:image\//i.test(value);
  }

  function isPlaceholder(value) {
    if (typeof value !== 'string' || !/^data:image\/svg\+xml/i.test(value)) return false;
    // Only MusicVers-generated covers are placeholders. A user may legitimately
    // upload an SVG profile picture, which must still be allowed to load.
    return /viewBox%3D%220%200%20400%20400%22/i.test(value) &&
      /linearGradient%20id%3D%22g%22/i.test(value);
  }

  function isRemote(value) {
    return typeof value === 'string' && /^https:\/\//i.test(value);
  }

  /** Pick the best URL out of the incompatible image shapes providers return. */
  function pickImage(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      var usable = value.filter(function (item) {
        return item && (item.url || item.src || typeof item === 'string');
      });
      if (!usable.length) return '';
      var scored = usable.map(function (item, position) {
        var raw = typeof item === 'string' ? item : (item.url || item.src);
        var size = Number(item.width || item.height || 0);
        var quality = String(item.quality || '');
        var score = /500/i.test(quality) || size >= 500 ? 100 : (size >= 300 ? 70 : 40);
        if (/\b150\b/.test(quality) || /-150x150/i.test(raw)) score -= 20;
        return { url: raw, score: score - position };
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      return String(scored[0].url || '').trim();
    }
    if (typeof value === 'object') {
      return String(value.url || value.src || value.cover || value.image || '').trim();
    }
    return '';
  }

  /** Safe, deterministic URL cleanup. Never returns a generated placeholder. */
  function normalize(value) {
    var url = pickImage(value);
    if (!url) return '';
    if (url.indexOf('//') === 0) url = 'https:' + url;
    else if (/^http:\/\//i.test(url)) url = 'https://' + url.slice(7);
    if (!isRemote(url) && !isData(url) && !isBlob(url)) return '';

    if (!isData(url) && !isBlob(url)) {
      url = url
        .replace(/-150x150\.(jpg|jpeg|png|webp)$/i, '-500x500.$1')
        .replace(/-50x50\.(jpg|jpeg|png|webp)$/i, '-500x500.$1')
        .replace(/100x100bb\.(jpg|jpeg|png|webp)$/i, '600x600bb.$1');
      if (/mzstatic\.com/i.test(url)) {
        url = url.replace(/\d+x\d+bb\.(jpg|jpeg|png|webp)$/i, '600x600bb.$1');
      }
    }
    return url;
  }

  function placeholder(meta, round) {
    var source = meta || {};
    var label = source.name || source.title || source.alt || 'Music';
    var seed = source.id || source.spotifyId || source.isrc || (label + '|' + (source.artist || source.album || ''));
    if (MV.data && MV.data.coverFor) return MV.data.coverFor(seed, label, Boolean(round));
    return '';
  }

  function keysFor(meta) {
    var source = meta || {};
    var keys = [];
    var add = function (prefix, value) {
      var clean = text(value);
      if (clean) keys.push(prefix + ':' + clean);
    };
    add('id', source.id);
    add('albumid', source.albumId || (source.raw && (source.raw.albumId || source.raw.album && source.raw.album.id)));
    add('artistid', source.artistId || (source.raw && source.raw.artistId));
    add('isrc', source.isrc || (source.raw && source.raw.isrc));
    add('spotify', source.spotifyId || (source.raw && source.raw.id && source.provider === 'spotify' ? source.raw.id : ''));
    add('artistalbum', (source.artist || '') + '|' + (source.album || source.title || ''));
    add('titleartist', (source.title || '') + '|' + (source.artist || ''));
    return keys.filter(function (key, position) { return keys.indexOf(key) === position; });
  }

  /** Index provider-verified matches. IDs and ISRC always outrank text keys. */
  function associate(meta, value) {
    var url = normalize(value);
    if (!url || isPlaceholder(url) || !meta) return url;
    index.set('url:' + url, meta);
    var provider = String(meta.provider || '').toLowerCase();
    var rank = PROVIDER_RANK[provider] == null ? 5 : PROVIDER_RANK[provider];
    keysFor(meta).forEach(function (key) {
      var list = index.get(key);
      if (!Array.isArray(list)) list = [];
      var known = list.some(function (item) { return item.url === url; });
      if (!known) list.push({ url: url, provider: provider, rank: rank });
      list.sort(function (a, b) { return a.rank - b.rank; });
      index.set(key, list);
    });
    return url;
  }

  function matchesFor(key) {
    var entry = index.get(key);
    if (Array.isArray(entry)) return entry.map(function (item) { return item.url; });
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object') {
      var url = entry.cover || entry.image;
      return url ? [url] : [];
    }
    return [];
  }

  function youtubeSeries(url) {
    var match = url.match(/^(https:\/\/i\.ytimg\.com\/vi\/[^/]+\/)(maxresdefault|sddefault|hqdefault|mqdefault|default)(\.jpg)$/i);
    if (!match) return [];
    return [
      'maxresdefault',
      'sddefault',
      'hqdefault',
      'mqdefault',
      'default'
    ].map(function (name) { return match[1] + name + match[3]; });
  }

  function variants(url) {
    if (!isRemote(url)) return [];
    var extra = [];
    if (/-500x500\.(jpg|jpeg|png|webp)$/i.test(url)) {
      extra.push(url.replace(/-500x500\.(jpg|jpeg|png|webp)$/i, '-150x150.$1'));
    }
    if (/600x600bb\.(jpg|jpeg|png|webp)$/i.test(url)) {
      extra.push(url.replace(/600x600bb\.(jpg|jpeg|png|webp)$/i, '150x150bb.$1'));
    }
    youtubeSeries(url).forEach(function (candidate) {
      if (candidate !== url && extra.indexOf(candidate) === -1) extra.push(candidate);
    });
    return extra;
  }

  function candidates(meta, type) {
    var source = typeof meta === 'string' ? { url: meta } : (meta || {});
    var found = [];
    var push = function (value) {
      var url = normalize(value);
      if (url && found.indexOf(url) === -1) found.push(url);
    };

    push(source.artworkUrl);
    push(source.imageUrl);
    push(source.cover);
    push(source.image);
    push(source.thumbnail);
    push(source.art);
    push(source.images);
    if (source.raw) {
      push(source.raw.cover || source.raw.image || source.raw.thumbnail || source.raw.art);
      push(source.raw.images);
      if (source.raw.album) push(source.raw.album.images || source.raw.album.cover);
    }

    // YouTube thumbnails are only valid at some sizes. Try them from highest
    // to lowest instead of trusting whichever URL the provider supplied.
    found.slice().forEach(function (url) {
      var series = youtubeSeries(url);
      if (!series.length) return;
      var position = found.indexOf(url);
      series.forEach(function (candidate) {
        var existing = found.indexOf(candidate);
        if (existing !== -1) found.splice(existing, 1);
        if (existing !== -1 && existing < position) position -= 1;
      });
      series.forEach(function (candidate, offset) {
        if (found.indexOf(candidate) === -1) found.splice(position + offset, 0, candidate);
      });
    });

    var fallback = placeholder(source, type === 'artist' || source.kind === 'artist');

    // Provider matches already resolved elsewhere in the app. These are indexed
    // by ID/ISRC where available, so we never guess from a title alone.
    keysFor(source).forEach(function (key) {
      matchesFor(key).forEach(push);
    });
    found.slice().forEach(function (url) {
      var linked = index.get('url:' + url);
      if (!linked || Array.isArray(linked) || typeof linked === 'string') return;
      keysFor(linked).forEach(function (key) {
        matchesFor(key).forEach(push);
      });
    });
    found.slice().forEach(function (url) { variants(url).forEach(push); });

    // A data: SVG can be a real uploaded profile picture, so only remote URLs
    // are filtered by the recent-failure cooldown; generated fallbacks stay
    // last in the chain and are never suppressed.
    found = found.filter(function (url) {
      var failedAt = failed.get(url);
      return !failedAt || Date.now() - failedAt > MAX_FAILED_AGE;
    });
    if (found.indexOf(fallback) === -1) found.push(fallback);
    return found.slice(0, 10);
  }

  /** Synchronous best guess, for non-blocking consumers such as colour sampling. */
  function getArtwork(meta, type) {
    var list = candidates(meta, type);
    return list[0] || placeholder(meta, type === 'artist');
  }

  function cleanText(value) {
    var node = document.createElement('textarea');
    node.innerHTML = String(value == null ? '' : value);
    return node.value;
  }

  function coreText(value) {
    return text(cleanText(value).replace(/<[^>]*>/g, ' '))
      .replace(/\b(feat|featuring|ft|with)\b.*$/, '')
      .replace(/\b(official|music|video|audio|hd|hq|full|version|remastered|remaster)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenSet(value) {
    var set = new Set();
    coreText(value).split(' ').forEach(function (word) { if (word) set.add(word); });
    return set;
  }

  function similarName(a, b) {
    var left = coreText(a);
    var right = coreText(b);
    if (!left || !right) return false;
    if (left === right || left.indexOf(right) === 0 || right.indexOf(left) === 0) return true;
    var leftSet = tokenSet(left);
    var rightSet = tokenSet(right);
    var overlap = 0;
    leftSet.forEach(function (word) { if (rightSet.has(word)) overlap += 1; });
    return overlap / Math.max(1, Math.min(leftSet.size, rightSet.size)) >= 0.6;
  }

  /** Last-resort verified artwork from iTunes, never used for audio playback. */
  function lookupExternal(meta, type) {
    var source = meta || {};
    var title = cleanText(source.title || source.name || '');
    var artist = cleanText(source.artist || (source.raw && source.raw.artist) || '');
    if ((type !== 'song' && type !== 'album') || !title) return Promise.resolve('');

    var key = type + '|' + coreText(title) + '|' + coreText(artist);
    var memo = lookupMemo.get(key);
    if (memo && Date.now() - memo.at < 6 * 60 * 60 * 1000) return Promise.resolve(memo.url);
    if (lookupPending.has(key)) return lookupPending.get(key);

    var entity = type === 'album' ? 'album' : 'song';
    var term = artist ? title + ' ' + artist : title;
    var task = fetch(ITUNES_API + '/search?term=' + encodeURIComponent(term) +
      '&entity=' + entity + '&limit=12&country=US', {
      mode: 'cors',
      credentials: 'omit',
      cache: 'force-cache',
      referrerPolicy: 'no-referrer'
    }).then(function (response) {
      if (!response.ok) throw new Error('iTunes lookup failed');
      return response.json();
    }).then(function (data) {
      var results = (data && data.results) || [];
      var wantedTitle = cleanText(type === 'album' ? (source.album || title) : title);
      for (var index = 0; index < results.length; index += 1) {
        var item = results[index];
        var candidateTitle = type === 'album' ? item.collectionName : item.trackName;
        var candidateArtist = item.artistName || '';
        if (!similarName(candidateTitle, wantedTitle)) continue;
        if (artist && !similarName(candidateArtist, artist)) continue;
        var url = normalize(item.artworkUrl100 || item.artworkUrl60 || '');
        if (!url) continue;
        // Store it as an iTunes-verified match without changing the track's
        // original provider. Audio resolution still never comes from here.
        var linked = {};
        Object.keys(source).forEach(function (field) { linked[field] = source[field]; });
        linked.provider = 'itunes';
        associate(linked, url);
        return url;
      }
      return '';
    }).catch(function () { return ''; }).then(function (url) {
      lookupMemo.set(key, { url: url, at: Date.now() });
      lookupPending.delete(key);
      return url;
    });

    lookupPending.set(key, task);
    return task;
  }

  function markFailed(url) {
    if (isRemote(url)) failed.set(url, Date.now());
  }

  function invalidate(url) {
    var clean = normalize(url);
    if (!clean) return;
    failed.delete(clean);
    var memo = memory.get(clean);
    if (memo && isBlob(memo.src)) URL.revokeObjectURL(memo.src);
    memory.delete(clean);
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error('Artwork store timeout'));
        }
      }, 5000);
      var finish = function (callback, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      try {
        if (!window.indexedDB) return finish(reject, new Error('IndexedDB unavailable'));
        var request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(DB_STORE)) {
            var store = db.createObjectStore(DB_STORE, { keyPath: 'key' });
            store.createIndex('createdAt', 'createdAt', { unique: false });
          }
        };
        request.onsuccess = function () {
          var db = request.result;
          db.onversionchange = function () {
            db.close();
            dbPromise = null;
          };
          finish(resolve, db);
        };
        request.onerror = function () { finish(reject, request.error || new Error('Artwork store failed')); };
        request.onblocked = function () { finish(reject, new Error('Artwork store blocked')); };
      } catch (error) {
        finish(reject, error);
      }
    }).catch(function (error) {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  function cacheKey(url) {
    var key = String(url || '');
    var hash = 0;
    for (var i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    return 'art-' + (hash >>> 0).toString(36) + '-' + key.length.toString(36);
  }

  function cleanupDb(db) {
    return new Promise(function (resolve) {
      try {
        var transaction = db.transaction(DB_STORE, 'readwrite');
        var store = transaction.objectStore(DB_STORE);
        var indexRef = store.index('createdAt');
        var cursor = indexRef.openCursor();
        var seen = [];
        cursor.onsuccess = function () {
          var item = cursor.result;
          if (!item) return;
          var value = item.value;
          var expired = value.expiresAt && Date.now() > value.expiresAt;
          if (expired || seen.length >= MAX_ENTRIES) {
            if (value.objectUrl) URL.revokeObjectURL(value.objectUrl);
            item.delete();
          } else {
            seen.push(value);
          }
          item.continue();
        };
        transaction.oncomplete = function () { resolve(); };
        transaction.onerror = function () { resolve(); };
      } catch (error) {
        resolve();
      }
    });
  }

  function getCachedArtwork(url) {
    var clean = normalize(url);
    if (!clean || !isRemote(clean) || !config.useCache) return Promise.resolve('');
    var memo = memory.get(clean);
    if (memo) {
      if (!memo.expiresAt || memo.expiresAt > Date.now()) return Promise.resolve(memo.src);
      if (isBlob(memo.src)) URL.revokeObjectURL(memo.src);
      memory.delete(clean);
    }
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(cacheKey(clean));
          request.onsuccess = function () {
            var entry = request.result;
            if (!entry || !entry.blob || (entry.expiresAt && entry.expiresAt < Date.now())) return resolve('');
            var src = URL.createObjectURL(entry.blob);
            entry.objectUrl = src;
            memory.set(clean, { src: src, expiresAt: entry.expiresAt });
            resolve(src);
          };
          request.onerror = function () { resolve(''); };
        } catch (error) {
          resolve('');
        }
      });
    }).catch(function () { return ''; });
  }

  function cacheArtwork(url, blob, type) {
    var clean = normalize(url);
    if (!clean || !isRemote(clean) || !config.useCache || !blob || !/^image\//i.test(String(blob.type || type || ''))) return Promise.resolve(false);
    var entry = {
      key: cacheKey(clean),
      url: clean,
      blob: blob,
      contentType: String(blob.type || type || 'image/jpeg'),
      createdAt: Date.now(),
      expiresAt: Date.now() + config.ttl,
      lastUsed: Date.now()
    };
    return openDb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var request = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(entry);
          request.onsuccess = function () {
            var src = URL.createObjectURL(blob);
            entry.objectUrl = src;
            memory.set(clean, { src: src, expiresAt: entry.expiresAt });
            cleanupDb(db);
            resolve(true);
          };
          request.onerror = function () { resolve(false); };
        } catch (error) {
          resolve(false);
        }
      });
    }).catch(function () { return false; });
  }

  function directImage(url) {
    return new Promise(function (resolve, reject) {
      var probe = new Image();
      var done = false;
      var timer = setTimeout(function () { finish(false); }, config.timeout);
      var finish = function (ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        probe.onload = probe.onerror = null;
        if (ok) resolve(url);
        else reject(new Error('Image failed'));
      };
      probe.onload = function () { finish(true); };
      probe.onerror = function () { finish(false); };
      probe.referrerPolicy = 'no-referrer';
      probe.src = url;
    });
  }

  function loadArtwork(url) {
    var clean = normalize(url);
    if (!clean) return Promise.reject(new Error('No artwork URL'));
    if (isData(clean) || isBlob(clean)) return Promise.resolve(clean);

    var failedAt = failed.get(clean);
    if (failedAt && Date.now() - failedAt < MAX_FAILED_AGE) return Promise.reject(new Error('Artwork recently failed'));
    if (inflight.has(clean)) return inflight.get(clean);

    var task = getCachedArtwork(clean).then(function (cached) {
      if (cached) return cached;
      var target = clean;
      if (config.allowProxy && config.proxyEndpoint) {
        target = String(config.proxyEndpoint).replace(/\/$/, '') + '?url=' + encodeURIComponent(clean);
      }
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, config.timeout) : null;
      return fetch(target, {
        mode: 'cors',
        credentials: 'omit',
        cache: 'force-cache',
        referrerPolicy: 'no-referrer',
        signal: controller ? controller.signal : undefined
      }).then(function (response) {
        if (timer) clearTimeout(timer);
        if (!response.ok) throw new Error('Artwork HTTP ' + response.status);
        var type = response.headers.get('content-type') || '';
        if (!/^image\//i.test(type)) throw new Error('Not an image');
        return response.blob().then(function (blob) {
          var objectUrl = URL.createObjectURL(blob);
          return directImage(objectUrl).then(function () {
            URL.revokeObjectURL(objectUrl);
            cacheArtwork(clean, blob, type);
            return getCachedArtwork(clean).then(function (src) { return src || clean; });
          }, function (error) {
            URL.revokeObjectURL(objectUrl);
            throw error;
          });
        });
      }).catch(function () {
        if (timer) clearTimeout(timer);
        // CORS-blocked CDNs can still display in an <img>. Losing byte caching
        // here is acceptable; the URL is still remembered as a working source.
        return directImage(clean);
      });
    }).then(function (src) {
      failed.delete(clean);
      return src;
    }).catch(function (error) {
      markFailed(clean);
      throw error;
    }).then(function (src) {
      inflight.delete(clean);
      return src;
    }, function (error) {
      inflight.delete(clean);
      throw error;
    });

    inflight.set(clean, task);
    return task;
  }

  function makeRecord(options) {
    var source = options.meta || options.url || {};
    if (typeof source === 'string') source = { url: source };
    else if (source && typeof source === 'object') {
      var hasArt = source.artworkUrl || source.imageUrl || source.cover || source.image ||
        source.thumbnail || source.art ||
        (Array.isArray(source.images) && source.images.length) ||
        (source.raw && (source.raw.cover || source.raw.image || source.raw.images));
      if (!hasArt && options.url) {
        var clone = {};
        Object.keys(source).forEach(function (key) { clone[key] = source[key]; });
        clone.cover = options.url;
        source = clone;
      }
    }
    var round = options.round != null
      ? options.round
      : (options.type === 'artist' || source.kind === 'artist' || source.type === 'artist');
    var record = {
      meta: source,
      type: options.type || source.kind || '',
      round: Boolean(round),
      alt: options.alt || source.name || source.title || 'Music',
      kind: options.kind || 'image'
    };
    tokenId += 1;
    var token = 'a' + tokenId;
    if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
    var stored = { token: token, record: record };
    tokens.set(token, stored);
    return stored;
  }

  function enqueue(task) {
    queue.push(task);
    pump();
  }

  function pump() {
    while (active < config.maxConcurrent && queue.length) {
      var task = queue.shift();
      active += 1;
      Promise.resolve().then(task).catch(function () {}).then(function () {
        active -= 1;
        pump();
      });
    }
  }

  function applyImage(img, src, record) {
    img.src = src;
    img.classList.add('cover-image', 'is-artwork-loaded');
    img.classList.remove('is-artwork-loading', 'cover-image--fallback');
    img.dispatchEvent(new CustomEvent('mv:artwork-loaded', {
      bubbles: true,
      detail: { url: src, alt: record.alt, type: record.type }
    }));
  }

  function loadRecord(record, node) {
    var list = candidates(record.meta, record.type);
    // Generated SVGs are a final visual fallback, never a successful cover.
    // Filtering them here lets a verified iTunes match run before we give up.
    var usable = list.filter(function (url) { return !isPlaceholder(url); });
    var fallback = list[list.length - 1] || placeholder(record.meta, record.round);
    return usable.reduce(function (chain, url) {
      return chain.then(function (result) {
        if (result) return result;
        return loadArtwork(url).then(function (src) { return { url: url, src: src }; }, function () { return null; });
      });
    }, Promise.resolve(null)).then(function (result) {
      if (result) return result;
      return lookupExternal(record.meta, record.type).then(function (url) {
        if (!url) return null;
        return loadArtwork(url).then(function (src) { return { url: url, src: src }; }, function () { return null; });
      });
    }).then(function (result) {
      var src = result ? result.src : fallback;
      if (!node || !node.isConnected) return result;
      if (node.dataset.mvArtKind === 'background') {
        node.style.backgroundImage = cssUrl(src);
        node.classList.add('is-artwork-loaded');
        node.classList.remove('is-artwork-loading');
      } else {
        applyImage(node, src, record);
      }
      return result;
    });
  }

  function enqueueImage(img) {
    if (!img || img.dataset.mvArtBusy) return;
    var token = img.dataset.mvArt;
    var stored = token && tokens.get(token);
    if (!stored) {
      var made = makeRecord({
        url: img.dataset.mvArtSrc || img.currentSrc || img.src,
        alt: img.dataset.coverAlt || img.alt,
        round: img.dataset.coverRound === 'true',
        kind: 'image'
      });
      stored = { token: made.token, record: made.record };
      img.dataset.mvArt = made.token;
    }
    img.dataset.mvArtBusy = '1';
    img.dataset.mvArtKind = 'image';
    img.classList.add('is-artwork-loading');
    enqueue(function () {
      return Promise.resolve().then(function () {
        return loadRecord(stored.record, img);
      }).then(function () {
        delete img.dataset.mvArtBusy;
      }, function () {
        delete img.dataset.mvArtBusy;
        img.classList.remove('is-artwork-loading');
        img.classList.add('cover-image--fallback');
      });
    });
  }

  function enqueueBackground(node) {
    if (!node || node.dataset.mvArtBusy) return;
    var token = node.dataset.mvArtBg;
    var stored = token && tokens.get(token);
    if (!stored) return;
    node.dataset.mvArtBusy = '1';
    node.dataset.mvArtKind = 'background';
    node.classList.add('is-artwork-loading');
    enqueue(function () {
      return Promise.resolve().then(function () {
        return loadRecord(stored.record, node);
      }).then(function () {
        delete node.dataset.mvArtBusy;
      }, function () {
        delete node.dataset.mvArtBusy;
        node.classList.remove('is-artwork-loading');
      });
    });
  }

  function observeNode(node) {
    if (!node) return;
    var images = node.matches && node.matches('[data-mv-art]')
      ? [node]
      : (node.querySelectorAll ? Array.prototype.slice.call(node.querySelectorAll('[data-mv-art]')) : []);
    images.forEach(function (img) {
      if (img.dataset.mvArtSeen) return;
      img.dataset.mvArtSeen = '1';
      var rects = img.getClientRects();
      var nearViewport = false;
      if (rects && rects.length) {
        var rect = rects[0];
        nearViewport = rect.bottom > -300 && rect.top < (window.innerHeight || 800) + 300;
      }
      // IntersectionObserver can miss images inside nested scroll containers
      // in some layouts, which left covers stuck as gradients after scroll.
      // Queue visible artwork first, then sweep the rest; the manager's
      // concurrency cap and request dedupe keep this bounded.
      if (img.loading === 'eager' || !observer || nearViewport) enqueueImage(img);
      else {
        observer.observe(img);
        setTimeout(function () { enqueueImage(img); }, 30);
      }
    });
    var backgrounds = node.matches && node.matches('[data-mv-art-bg]')
      ? [node]
      : (node.querySelectorAll ? Array.prototype.slice.call(node.querySelectorAll('[data-mv-art-bg]')) : []);
    backgrounds.forEach(enqueueBackground);
  }

  function markup(url, alt, round, meta, type, eager) {
    var made = makeRecord({ meta: meta || url, url: url, alt: alt, round: round, type: type });
    var src = placeholder(made.record.meta, made.record.round);
    return '<img class="cover-image is-artwork-loading" src="' + attr(src) + '"' +
      ' alt="' + attr(made.record.alt) + '"' +
      ' data-cover-alt="' + attr(made.record.alt) + '"' +
      (made.record.round ? ' data-cover-round="true"' : '') +
      ' data-mv-art="' + made.token + '"' +
      ' data-mv-art-src="' + attr(normalize(url)) + '"' +
      ' loading="' + (eager ? 'eager' : 'lazy') + '" decoding="async" referrerpolicy="no-referrer">';
  }

  function background(node, meta, type) {
    if (!node) return;
    var made = makeRecord({ meta: meta, type: type, kind: 'background' });
    node.dataset.mvArtBg = made.token;
    enqueueBackground(node);
  }

  function handleArtworkError(img) {
    if (!img || img.tagName !== 'IMG' || img.dataset.mvArtHandling) return;
    var src = img.currentSrc || img.src || '';
    if (!src || isPlaceholder(src)) return;
    img.dataset.mvArtHandling = '1';
    markFailed(src);
    var token = img.dataset.mvArt;
    if (!token || !tokens.get(token)) {
      var made = makeRecord({
        url: src,
        alt: img.dataset.coverAlt || img.alt,
        round: img.dataset.coverRound === 'true',
        kind: 'image'
      });
      img.dataset.mvArt = made.token;
    }
    img.classList.add('cover-image--fallback');
    enqueueImage(img);
    setTimeout(function () { delete img.dataset.mvArtHandling; }, 1500);
  }

  function init() {
    if (ready) return;
    ready = true;
    if (config.useCache) openDb().then(function (db) { cleanupDb(db); }).catch(function () {});

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          enqueueImage(entry.target);
        });
      }, { rootMargin: '300px 0px' });
    }
    if ('MutationObserver' in window) {
      mutationObserver = new MutationObserver(function (records) {
        records.forEach(function (record) {
          Array.prototype.forEach.call(record.addedNodes || [], observeNode);
        });
      });
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener('error', function (event) {
      if (event.target && event.target.tagName === 'IMG') handleArtworkError(event.target);
    }, true);
    observeNode(document);
  }

  function configure(options) {
    if (!options || typeof options !== 'object') return;
    if ('proxyEndpoint' in options) config.proxyEndpoint = String(options.proxyEndpoint || '').trim();
    if ('allowProxy' in options) config.allowProxy = Boolean(options.allowProxy);
    if ('timeout' in options) config.timeout = Math.max(2000, Number(options.timeout) || config.timeout);
    if ('ttl' in options) config.ttl = Math.max(60 * 1000, Number(options.ttl) || config.ttl);
    if ('useCache' in options) config.useCache = Boolean(options.useCache);
    if ('maxConcurrent' in options) config.maxConcurrent = Math.min(8, Math.max(1, Number(options.maxConcurrent) || config.maxConcurrent));
  }

  MV.artwork = {
    configure: configure,
    init: init,
    normalize: normalize,
    placeholder: getFallback,
    associate: associate,
    candidates: candidates,
    getArtwork: getArtwork,
    resolve: loadArtwork,
    markup: markup,
    background: background,
    enqueue: enqueueImage,
    invalidate: invalidate,
    cacheArtwork: cacheArtwork,
    getCachedArtwork: getCachedArtwork,
    loadArtwork: loadArtwork,
    getFallbackArtwork: getFallback,
    handleArtworkError: handleArtworkError,
    stats: function () {
      return {
        queued: queue.length,
        active: active,
        cached: memory.size,
        failed: failed.size,
        indexed: index.size,
        tokens: tokens.size,
        lookups: lookupMemo.size
      };
    }
  };

  function getFallback(meta, round) { return placeholder(meta, round); }
})(window.MV = window.MV || {});
