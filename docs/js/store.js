/* ============================================================
   musicVer · local state
   Persists likes, saved albums, playlists, covers and history.
   ============================================================ */

(function (MV) {
  'use strict';

  const KEY = 'musicver.f3.v1';

  const defaults = {
    profile: {
      name: 'Music Lover',
      picture: '',
      flowAuto: false,
      ambience: true,
      rememberSearches: true
    },
    liked: [],
    savedAlbums: [],
    playlists: [],
    recentSearches: [],
    recentlyPlayed: [],
    demoSeeded: false,
    theme: 'light',
    volume: 70,
    shuffle: false,
    repeat: 'off'
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  /** Keep stored tracks small: no provider raw payloads. */
  function compact(track) {
    if (!track) return track;
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      language: track.language || '',
      provider: track.provider || '',
      path: track.path || '',
      cover: track.cover || '',
      image: track.image || ''
    };
  }

  /** Stable key shared with the Python library for saved albums. */
  function albumKey(album) {
    if (!album) return '';
    if (album.album_key || album.key) return String(album.album_key || album.key);
    const slug = (value) => String(value || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return 'ab-' + (slug(album.title) || 'album') + (slug(album.artist) ? '--' + slug(album.artist) : '');
  }

  function compactAlbum(album) {
    if (!album) return album;
    return {
      id: album.id || albumKey(album),
      album_key: albumKey(album),
      title: album.title,
      artist: album.artist,
      year: album.year || '',
      language: album.language || '',
      cover: album.cover || '',
      image: album.image || '',
      kind: 'album'
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return clone(defaults);
      const parsed = JSON.parse(raw);
      return {
        ...clone(defaults),
        ...parsed,
        profile: { ...defaults.profile, ...(parsed.profile || {}) }
      };
    } catch (error) {
      console.warn('musicVer: could not read saved state', error);
      return clone(defaults);
    }
  }

  let state = load();

  function save(reason) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('musicVer: could not save state', error);
    }
    document.dispatchEvent(new CustomEvent('mv:store', {
      detail: { state: clone(state), reason: reason || '' }
    }));
  }

  function uid(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function sameId(a, b) { return String(a) === String(b); }

  const store = {
    get state() { return state; },

    save,

    /* ---------------- likes ---------------- */
    isLiked(id) { return state.liked.some((song) => sameId(song.id, id)); },

    toggleLike(song) {
      if (!song) return false;
      const index = state.liked.findIndex((item) => sameId(item.id, song.id));
      if (index >= 0) state.liked.splice(index, 1);
      else state.liked.unshift(compact(song));
      save('like');
      return index < 0;
    },

    setLike(song, liked) {
      if (!song) return;
      const index = state.liked.findIndex((item) => sameId(item.id, song.id));
      if (liked && index < 0) state.liked.unshift(compact(song));
      if (!liked && index >= 0) state.liked.splice(index, 1);
      save('like');
    },

    /* ---------------- saved albums ---------------- */
    albumKey,

    /** Accepts an id/key string or the album object itself. */
    isAlbumSaved(albumOrKey) {
      const key = typeof albumOrKey === 'string' || typeof albumOrKey === 'number'
        ? String(albumOrKey) : albumKey(albumOrKey);
      return state.savedAlbums.some((album) =>
        sameId(album.id, key) || sameId(album.album_key, key) ||
        (typeof albumOrKey !== 'string' && typeof albumOrKey !== 'number' && sameId(album.id, albumOrKey && albumOrKey.id)));
    },

    saveAlbum(album) {
      if (!album || store.isAlbumSaved(album)) return false;
      state.savedAlbums.unshift(compactAlbum(album));
      save();
      return true;
    },

    removeSavedAlbum(albumOrKey) {
      const key = typeof albumOrKey === 'string' || typeof albumOrKey === 'number'
        ? String(albumOrKey) : albumKey(albumOrKey);
      state.savedAlbums = state.savedAlbums.filter((album) =>
        !sameId(album.id, key) && !sameId(album.album_key, key) &&
        !(typeof albumOrKey !== 'string' && typeof albumOrKey !== 'number' && sameId(album.id, albumOrKey && albumOrKey.id)));
      save();
    },

    /* ---------------- playlists ---------------- */
    getPlaylist(id) { return state.playlists.find((item) => sameId(item.id, id)) || null; },

    createPlaylist(name, cover, id) {
      const clean = String(name || '').trim();
      if (!clean) return null;
      const playlist = {
        id: id || uid('pl'),
        name: clean.slice(0, 60),
        cover: cover || null,
        songs: [],
        createdAt: Date.now()
      };
      state.playlists.unshift(playlist);
      save();
      return playlist;
    },

    deletePlaylist(id) {
      state.playlists = state.playlists.filter((item) => !sameId(item.id, id));
      save();
    },

    renamePlaylist(id, name) {
      const playlist = store.getPlaylist(id);
      const clean = String(name || '').trim();
      if (!playlist || !clean) return false;
      playlist.name = clean.slice(0, 60);
      save();
      return true;
    },

    setPlaylistCover(id, cover) {
      const playlist = store.getPlaylist(id);
      if (!playlist) return false;
      playlist.cover = cover;
      save();
      return true;
    },

    addSongToPlaylist(id, song) {
      const playlist = store.getPlaylist(id);
      if (!playlist || !song || playlist.songs.some((item) => sameId(item.id, song.id))) return false;
      playlist.songs.push(compact(song));
      save();
      return true;
    },

    removeSongFromPlaylist(id, songId) {
      const playlist = store.getPlaylist(id);
      if (!playlist) return false;
      playlist.songs = playlist.songs.filter((song) => !sameId(song.id, songId));
      save();
      return true;
    },

    /* ---------------- history ---------------- */
    addRecentSearch(query) {
      const clean = String(query || '').trim();
      if (!clean || !state.profile.rememberSearches) return;
      state.recentSearches = [clean, ...state.recentSearches.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, 8);
      save();
    },

    clearRecentSearches() { state.recentSearches = []; save(); },

    addRecentlyPlayed(item) {
      if (!item) return;
      const entry = {
        id: item.id,
        type: item.type || 'song',
        title: item.title || 'Untitled',
        subtitle: item.subtitle || item.artist || '',
        cover: item.cover || ''
      };
      state.recentlyPlayed = [entry, ...state.recentlyPlayed.filter((old) => !(String(old.id) === String(entry.id) && old.type === entry.type))].slice(0, 14);
      save();
    },

    clearRecentlyPlayed() { state.recentlyPlayed = []; save(); },

    /* ---------------- backend hydration ---------------- */
    replaceLibrary(library) {
      if (!library) return;
      if (Array.isArray(library.playlists)) {
        const remote = library.playlists.map((item) => String(item.id));
        const localOnly = state.playlists.filter((item) => !/^\d+$/.test(String(item.id)) && remote.indexOf(String(item.id)) < 0);
        state.playlists = library.playlists.concat(localOnly);
      }
      if (Array.isArray(library.liked)) {
        const remote = library.liked.map((item) => String(item.id));
        const localOnly = state.liked.filter((item) => !/^\d+$/.test(String(item.id)) && remote.indexOf(String(item.id)) < 0);
        state.liked = library.liked.concat(localOnly);
      }
      if (Array.isArray(library.savedAlbums)) {
        state.savedAlbums = library.savedAlbums.map(compactAlbum);
      }
      save();
    },

    /* ---------------- preferences ---------------- */
    setProfile(key, value) {
      if (!(key in state.profile)) return;
      state.profile[key] = value;
      if (key === 'rememberSearches' && !value) state.recentSearches = [];
      save();
    },

    setPreference(key, value) {
      if (!(key in state)) return;
      state[key] = value;
      save();
    }
  };

  MV.store = store;
})(window.MV = window.MV || {});
