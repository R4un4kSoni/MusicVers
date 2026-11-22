/* ============================================================
   musicVer · backend bridge
   Uses the existing Python engine when running inside pywebview.
   Falls back to a silent, fully interactive preview in a browser.
   ============================================================ */

(function (MV) {
  'use strict';

  const D = MV.data;

  function bridge() {
    return (window.pywebview && window.pywebview.api) || null;
  }

  function isLive() { return Boolean(bridge()); }

  function call(name) {
    const api = bridge();
    const args = Array.prototype.slice.call(arguments, 1);
    if (!api || typeof api[name] !== 'function') {
      return Promise.reject(new Error('NO_BRIDGE:' + name));
    }
    try {
      return Promise.resolve(api[name].apply(api, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function waitForBridge(timeout) {
    const limit = timeout || 2200;
    if (isLive()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (isLive() || Date.now() - started > limit) {
          clearInterval(timer);
          resolve(isLive());
        }
      }, 90);
    });
  }

  function unwrap(response, key, fallback) {
    if (!response || response.success === false) return fallback;
    return response[key] || fallback;
  }

  /* ---------------- catalogue ---------------- */

  async function discover() {
    if (!isLive()) return null;
    try {
      const response = await call('get_jiosaavn_discovery');
      if (!response || !response.success) return null;
      return {
        trending: (response.trending || []).map(D.normalizeTrack).filter(Boolean),
        albums: (response.albums || []).map(D.normalizeAlbum).filter(Boolean),
        artists: (response.artists || []).map(D.normalizeArtist).filter(Boolean),
        charts: (response.charts || []).map(D.normalizeAlbum).filter(Boolean),
        genres: response.genres || [],
        live: true
      };
    } catch (error) {
      console.info('musicVer: discovery unavailable', error.message);
      return null;
    }
  }

  async function search(query) {
    const needle = String(query || '').trim();
    if (!needle) return { songs: [], albums: [], artists: [], source: 'local', success: true };

    if (isLive()) {
      try {
        const response = await call('search_online_music', needle, 'jiosaavn');
        const songs = (unwrap(response, 'results', []) || []).map(D.normalizeTrack).filter(Boolean);
        const albums = (unwrap(response, 'albums', []) || []).map(D.normalizeAlbum).filter(Boolean);
        const artists = (unwrap(response, 'artists', []) || []).map(D.normalizeArtist).filter(Boolean);
        if (songs.length || albums.length || artists.length) {
          return { songs, albums, artists, source: 'online', success: true };
        }
      } catch (error) {
        console.info('musicVer: online search unavailable', error.message);
      }
    }

    const local = D.searchLocal(needle);
    return {
      songs: local.results,
      albums: local.albums,
      artists: local.artists,
      source: 'local',
      success: true,
      offline: true
    };
  }

  async function albumTracks(album) {
    if (!album) return [];
    if (isLive() && album.id && !/^[as]\d+$/.test(String(album.id))) {
      try {
        const response = await call('get_jiosaavn_album', album.id, 40);
        const tracks = unwrap(response, 'tracks', []) || [];
        const normalized = tracks.map(D.normalizeTrack).filter(Boolean);
        if (normalized.length) return normalized;
      } catch (error) {
        console.info('musicVer: album lookup unavailable', error.message);
      }
    }
    const matches = D.songs.filter((song) =>
      String(song.album).toLowerCase() === String(album.title).toLowerCase());
    return (matches.length ? matches : D.songs.slice(0, 6)).map((song) => ({
      ...song,
      album: album.title || song.album
    }));
  }

  async function artistTracks(artist) {
    if (!artist) return [];
    const details = await artistDetails(artist);
    if (details && details.songs && details.songs.length) return details.songs;
    const name = String(artist.name || artist.title || '').toLowerCase();
    return D.songs.filter((song) => song.artist.toLowerCase().includes(name)).slice(0, 8);
  }

  /** Full artist page: bio, popular songs, albums, singles and similar artists. */
  async function artistDetails(artist, page) {
    if (!artist) return null;
    const name = artist.name || artist.title || '';
    const fallback = {
      artist: D.normalizeArtist(artist) || { id: D.hash(name), name, title: name, kind: 'artist', cover: D.coverFor(name, name, true) },
      songs: [], albums: [], singles: [], similar: [], playlists: [],
      bio: '', sourceUrl: '', page: Number(page) || 0
    };

    const fillFallback = () => {
      const lowerName = String(name).toLowerCase();
      fallback.songs = D.songs.filter((song) => String(song.artist).toLowerCase().includes(lowerName)).slice(0, 8);
      fallback.albums = D.albums.filter((album) => String(album.artist).toLowerCase().includes(lowerName)).slice(0, 8);
      fallback.singles = D.albums.filter((album) =>
        String(album.artist).toLowerCase().includes(lowerName) &&
        /single|ep\b/i.test(String(album.title || ''))).slice(0, 8);
      fallback.similar = D.artists.filter((other) => String(other.id) !== String(artist.id)).slice(0, 8);
      fallback.bio = 'Explore ' + (name || 'this artist') + "'s popular songs, albums and releases in your library.";
      return fallback;
    };

    // Bundled artists use local IDs (ar1, ar2, ...). They are not valid
    // JioSaavn IDs, so skip the remote lookup and avoid a guaranteed failure.
    if (!isLive() || !artist.id || (D.getArtist && D.getArtist(artist.id))) return fillFallback();

    try {
      const response = await call(
        'get_jiosaavn_artist', String(artist.id), Number(page) || 0, 20, 'overview');
      if (!response || response.success === false) return fillFallback();

      return {
        artist: D.normalizeArtist(response.artist || artist) || fallback.artist,
        songs: (response.songs || []).map(D.normalizeTrack).filter(Boolean),
        albums: (response.albums || []).map(D.normalizeAlbum).filter(Boolean),
        singles: (response.singles || []).map(D.normalizeAlbum).filter(Boolean),
        similar: (response.similar_artists || []).map(D.normalizeArtist).filter(Boolean),
        playlists: (response.playlists || []).map(D.normalizeAlbum).filter(Boolean),
        bio: String(response.bio || ''),
        sourceUrl: response.source_url || '',
        page: Number(page) || 0
      };
    } catch (error) {
      console.info('musicVer: artist details unavailable', error.message);
      return fillFallback();
    }
  }

  /** Load another page of artist songs without repeating the current ones. */
  async function moreArtistSongs(artist, page, limit) {
    if (!artist || !isLive() || !artist.id) return [];
    try {
      const response = await call(
        'get_jiosaavn_artist', String(artist.id), Number(page) || 0, Number(limit) || 20, 'songs');
      return ((response && response.songs) || []).map(D.normalizeTrack).filter(Boolean);
    } catch (error) {
      console.info('musicVer: more artist songs unavailable', error.message);
      return [];
    }
  }

  /* ---------------- playback ---------------- */

  // Short catalog IDs (s1, s9, itunes-…) are not JioSaavn IDs. Passing the
  // title/artist along lets the web bridge resolve them to a full stream.
  function playbackMeta(track) {
    if (!track) return null;
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      cover: track.cover,
      image: track.image,
      provider: track.provider,
      path: track.path,
      raw: track.raw
    };
  }

  async function play(track) {
    if (!track) return { success: false, message: 'No track selected.' };
    if (!isLive()) return { success: true, simulated: true };

    const meta = MV.webApi ? playbackMeta(track) : null;

    try {
      // Saved streaming tracks carry a synthetic path like `stream:jiosaavn:<id>`.
      if (typeof track.path === 'string' && track.path.indexOf('stream:') === 0) {
        const parts = track.path.split(':');
        const provider = parts[1] || 'jiosaavn';
        const providerId = parts.slice(2).join(':');
        return provider === 'jiosaavn'
          ? await call('play_jiosaavn_track', providerId, meta)
          : await call('play_provider_track', providerId, meta);
      }
      if (track.path) return await call('play_song', track.path);
      if (track.provider === 'jiosaavn' || /^[a-zA-Z0-9_-]{10,}$/.test(String(track.id))) {
        return await call('play_jiosaavn_track', String(track.id), meta);
      }
      return await call('play_provider_track', String(track.id), meta);
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  function pause() { return isLive() ? call('pause_song').catch(() => null) : Promise.resolve(null); }
  function resume() { return isLive() ? call('resume_song').catch(() => null) : Promise.resolve(null); }
  function stop() { return isLive() ? call('stop_song').catch(() => null) : Promise.resolve(null); }
  function seek(seconds) { return isLive() ? call('seek_song', Math.max(0, Math.round(seconds))).catch(() => null) : Promise.resolve(null); }
  function setVolume(value) { return isLive() ? call('set_volume', Math.max(0, Math.min(1, value))).catch(() => null) : Promise.resolve(null); }

  async function progress() {
    if (!isLive()) return null;
    try {
      const response = await call('get_progress');
      if (!response) return null;
      return {
        current: Number(response.current_time || 0),
        total: Number(response.total_time || 0),
        state: response.playback_state || 'stopped'
      };
    } catch (error) {
      return null;
    }
  }

  async function lyrics(trackId) {
    if (!isLive()) return null;
    try {
      const response = await call('get_jiosaavn_lyrics', String(trackId));
      return response && response.available ? response.lyrics : null;
    } catch (error) {
      return null;
    }
  }

  /* Synced lyrics are metadata only. The desktop build asks the local bridge
     (which avoids file:// CORS); the static web build uses LRCLIB directly. */
  async function syncedLyrics(track) {
    if (!track) return null;
    const title = String(track.title || '').trim();
    const artist = String(track.artist || '').trim();
    if (!title) return null;

    const api = bridge();
    if (api && typeof api.get_synced_lyrics === 'function') {
      try {
        const response = await call('get_synced_lyrics', title, artist, Number(track.duration) || 0);
        if (!response || !response.success) return null;
        return {
          synced: response.syncedLyrics || '',
          plain: response.plainLyrics || '',
          source: response.source || 'LRCLIB',
          title: response.trackName || title,
          artist: response.artistName || artist
        };
      } catch (error) {
        return null;
      }
    }

    try {
      const query = new URLSearchParams({ track_name: title });
      if (artist) query.set('artist_name', artist);
      let response = await fetch('https://lrclib.net/api/get?' + query.toString(), {
        headers: { Accept: 'application/json' }
      });
      let data = response.ok ? await response.json() : null;
      if (!data) {
        const term = title + (artist ? ' ' + artist : '');
        const search = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(term), {
          headers: { Accept: 'application/json' }
        });
        if (!search.ok) return null;
        const results = await search.json();
        const duration = Number(track.duration) || 0;
        data = (Array.isArray(results) && results.find((item) =>
          !duration || !item.duration || Math.abs(Number(item.duration) - duration) < 12
        )) || (Array.isArray(results) && results[0]) || null;
      }
      if (!data) return null;
      return {
        synced: data.syncedLyrics || '',
        plain: data.plainLyrics || '',
        source: 'LRCLIB',
        title: data.trackName || title,
        artist: data.artistName || artist
      };
    } catch (error) {
      return null;
    }
  }

  /* ---------------- library sync ---------------- */

  async function ensureLibraryId(track) {
    if (!track) return null;
    if (track.path || /^\d+$/.test(String(track.id))) return String(track.id);
    if (!isLive()) return String(track.id);
    try {
      const response = await call('ensure_saved_track', {
        id: String(track.id),
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration || 0,
        provider: track.provider || 'jiosaavn'
      });
      return response && response.success && response.song ? String(response.song.id) : String(track.id);
    } catch (error) {
      return String(track.id);
    }
  }

  async function toggleLike(track) {
    // Local state is authoritative for the interface; the desktop engine
    // receives the same change when available.
    const liked = MV.store.toggleLike(track);
    if (isLive() && track) {
      try {
        const id = await ensureLibraryId(track);
        const response = await call('toggle_like_song', id);
        if (response && typeof response.liked === 'boolean') MV.store.setLike(track, response.liked);
      } catch (error) {
        console.info('musicVer: like sync unavailable', error.message);
      }
    }
    return MV.store.isLiked(track && track.id);
  }

  async function createPlaylist(name, cover) {
    let backendId = null;
    if (isLive()) {
      try {
        const response = await call('create_playlist', name, cover || null);
        if (response && response.success) backendId = String(response.playlist_id);
      } catch (error) {
        console.info('musicVer: playlist sync unavailable', error.message);
      }
    }
    return MV.store.createPlaylist(name, cover, backendId);
  }

  async function setPlaylistCover(id, cover) {
    MV.store.setPlaylistCover(id, cover);
    if (isLive() && /^\d+$/.test(String(id))) {
      try { await call('set_playlist_cover', id, cover || null); }
      catch (error) { console.info('musicVer: cover sync unavailable', error.message); }
    }
  }

  async function deletePlaylist(id) {
    MV.store.deletePlaylist(id);
    if (isLive() && /^\d+$/.test(String(id))) {
      try { await call('delete_playlist', id); } catch (error) { /* local copy already removed */ }
    }
  }

  async function renamePlaylist(id, name) {
    MV.store.renamePlaylist(id, name);
    if (isLive() && /^\d+$/.test(String(id))) {
      try { await call('rename_playlist', id, name); } catch (error) { /* ignore */ }
    }
  }

  async function addToPlaylist(playlist, track) {
    if (!playlist || !track) return false;
    let storedTrack = track;
    if (isLive() && /^\d+$/.test(String(playlist.id))) {
      try {
        const id = await ensureLibraryId(track);
        storedTrack = { ...track, id };
        await call('add_to_playlist', playlist.id, id);
      } catch (error) { /* keep the local copy */ }
    }
    return MV.store.addSongToPlaylist(playlist.id, storedTrack);
  }

  async function removeFromPlaylist(playlist, songId) {
    MV.store.removeSongFromPlaylist(playlist && playlist.id, songId);
    if (isLive() && playlist && /^\d+$/.test(String(playlist.id))) {
      try { await call('remove_from_playlist', playlist.id, songId); } catch (error) { /* ignore */ }
    }
  }

  async function chooseFolder() {
    if (!isLive()) return { success: false, message: 'Open the app from Python to choose a folder.' };
    try { return await call('choose_music_folder'); }
    catch (error) { return { success: false, message: error.message }; }
  }

  async function folderPath() {
    if (!isLive()) return null;
    try {
      const response = await call('get_music_folder');
      return response && response.folder ? response.folder : null;
    } catch (error) { return null; }
  }

  /* ---------------- saved albums ---------------- */

  function albumKey(album) { return MV.store.albumKey(album); }

  async function saveAlbum(album) {
    const added = MV.store.saveAlbum(album);
    if (isLive() && album) {
      try {
        await call('save_album', {
          album_key: albumKey(album),
          title: album.title,
          artist: album.artist,
          cover: album.cover || '',
          year: album.year || '',
          language: album.language || ''
        });
      } catch (error) {
        console.info('musicVer: album sync unavailable', error.message);
      }
    }
    return added;
  }

  async function removeSavedAlbum(album) {
    MV.store.removeSavedAlbum(album);
    if (isLive() && album) {
      try { await call('remove_saved_album', albumKey(album)); }
      catch (error) { /* local copy already removed */ }
    }
  }

  /* ---------------- theme ---------------- */

  async function getTheme() {
    if (isLive()) {
      try {
        const response = await call('get_theme');
        if (response && response.success && response.theme) return response.theme;
      } catch (error) { /* use the local preference */ }
    }
    return MV.store.state.theme === 'dark' ? 'dark' : 'light';
  }

  async function setTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    MV.store.setPreference('theme', value);
    if (isLive()) {
      try { await call('set_theme', value); }
      catch (error) { console.info('musicVer: theme sync unavailable', error.message); }
    }
    return value;
  }

  /* ---------------- profile ---------------- */

  async function getProfilePicture() {
    if (isLive()) {
      try {
        const response = await call('get_profile_picture');
        if (response && response.success && response.picture) return response.picture;
      } catch (error) { /* use the locally stored picture */ }
    }
    return MV.store.state.profile.picture || '';
  }

  async function setProfilePicture(picture) {
    MV.store.setProfile('picture', picture || '');
    if (isLive()) {
      try { await call('set_profile_picture', picture || ''); }
      catch (error) { console.info('musicVer: profile picture sync unavailable', error.message); }
    }
    return picture || '';
  }

  /* ---------------- whole library ---------------- */

  async function syncLibrary() {
    if (!isLive()) return null;

    // The static web bridge already owns the same localStorage library that
    // store.js uses. Hydrate directly instead of round-tripping through the
    // desktop SQLite-shaped methods, which do not exist on the web.
    const activeBridge = bridge();
    if (activeBridge && typeof activeBridge.syncLibrary === 'function') {
      try {
        const local = await call('syncLibrary');
        if (local) return local;
      } catch (error) {
        console.info('musicVer: local library sync unavailable', error.message);
      }
    }

    const safeCall = (name, ...args) => call(name, ...args).catch(() => null);
    const [playlistsRes, albumsRes, likedRes, songsRes] = await Promise.all([
      safeCall('get_playlists'),
      safeCall('get_saved_albums'),
      safeCall('get_liked_song_ids'),
      safeCall('get_saved_songs'),
    ]);

    const allSongs = (songsRes && songsRes.songs ? songsRes.songs : [])
      .map(D.normalizeTrack).filter(Boolean);
    const byId = new Map(allSongs.map((song) => [String(song.id), song]));

    const playlists = [];
    const rawPlaylists = (playlistsRes && playlistsRes.playlists) || [];
    await Promise.all(rawPlaylists.map(async (raw) => {
      // The special "Liked Songs" playlist is shown as the Liked tile instead.
      if (String(raw.name || '') === 'Liked Songs') return;
      let songs = [];
      try {
        const response = await call('get_playlist_songs', raw.id);
        if (response && response.success && Array.isArray(response.songs)) {
          songs = response.songs.map(D.normalizeTrack).filter(Boolean);
        }
      } catch (error) { /* playlist stays empty for this session */ }
      playlists.push({
        id: String(raw.id),
        name: String(raw.name || 'Untitled playlist'),
        cover: raw.cover || null,
        songs,
        createdAt: raw.created_at ? (Date.parse(raw.created_at) || Date.now()) : Date.now()
      });
    }));
    playlists.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));

    const liked = [];
    const likedIds = (likedRes && likedRes.song_ids) || [];
    likedIds.forEach((id) => {
      const song = byId.get(String(id));
      if (song) liked.push(song);
    });

    const savedAlbums = ((albumsRes && albumsRes.albums) || []).map((album) => ({
      id: String(album.album_key || D.hash((album.title || '') + (album.artist || ''))),
      album_key: album.album_key,
      title: album.title,
      artist: album.artist,
      year: album.year || '',
      language: album.language || '',
      cover: album.cover || D.coverFor((album.title || '') + (album.artist || ''), album.title),
      image: album.cover || '',
      kind: 'album'
    }));

    return { playlists, liked, savedAlbums };
  }

  MV.api = {
    bridge, isLive, call, waitForBridge,
    discover, search, albumTracks, artistTracks,
    play, pause, resume, stop, seek, setVolume, progress, lyrics, syncedLyrics,
    ensureLibraryId, toggleLike, createPlaylist, deletePlaylist, renamePlaylist,
    setPlaylistCover, addToPlaylist, removeFromPlaylist, chooseFolder, folderPath,
    albumKey, saveAlbum, removeSavedAlbum, getTheme, setTheme, syncLibrary,
    artistDetails, moreArtistSongs, getProfilePicture, setProfilePicture
  };
})(window.MV = window.MV || {});
