/* ============================================================
   musicVer · catalogue
   Curated demo catalogue + normalisers for backend responses.
   All artwork is generated locally as SVG data URLs, so the UI
   looks complete even with no internet connection.
   ============================================================ */

(function (MV) {
  'use strict';

  const PALETTES = [
    ['#e5a06b', '#8c4f3f', '#f6dcc0'],
    ['#5f7fb8', '#243a63', '#d7e5f7'],
    ['#7fa38b', '#2f5545', '#dcebdc'],
    ['#c4859f', '#68364f', '#f1dbe5'],
    ['#d8b46c', '#7a5a20', '#f7ecc9'],
    ['#7886b5', '#37395f', '#dfe1f4'],
    ['#cf7f73', '#713b36', '#f5ddd8'],
    ['#6fa5a6', '#2d5557', '#d8eeee'],
    ['#a08bc0', '#4b3a6b', '#e8dff3'],
    ['#93a06d', '#47522c', '#e5eacd'],
    ['#d39b81', '#6d4737', '#f3ded2'],
    ['#698cb0', '#2c4762', '#d9e6f2']
  ];

  function hash(value) {
    const text = String(value || '');
    let result = 0;
    for (let i = 0; i < text.length; i += 1) {
      result = (result * 31 + text.charCodeAt(i)) | 0;
    }
    return Math.abs(result);
  }

  function xml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  /** A deterministic, attractive "album cover" as a data URL. */
  function coverFor(seed, label, round) {
    const palette = PALETTES[hash(seed) % PALETTES.length];
    const initials = String(label || seed).trim().split(/\s+/).slice(0, 2)
      .map((word) => word.charAt(0)).join('').toUpperCase() || '♪';
    const angle = hash(seed + 'a') % 180;
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
      '<defs>' +
      '<linearGradient id="g" gradientTransform="rotate(' + angle + ' .5 .5)">' +
      '<stop offset="0%" stop-color="' + palette[0] + '"/>' +
      '<stop offset="100%" stop-color="' + palette[1] + '"/>' +
      '</linearGradient>' +
      '<radialGradient id="r" cx="72%" cy="22%" r="70%">' +
      '<stop offset="0%" stop-color="' + palette[2] + '" stop-opacity=".9"/>' +
      '<stop offset="100%" stop-color="' + palette[2] + '" stop-opacity="0"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<rect width="400" height="400" fill="url(#g)"/>' +
      '<rect width="400" height="400" fill="url(#r)"/>' +
      '<circle cx="' + (80 + hash(seed + 'x') % 220) + '" cy="' + (70 + hash(seed + 'y') % 150) +
      '" r="' + (70 + hash(seed + 'r') % 90) + '" fill="rgba(255,255,255,.12)"/>' +
      '<path d="M0 300 Q120 240 210 320 T400 280 V400 H0Z" fill="rgba(0,0,0,.12)"/>' +
      '<path d="M0 330 Q140 280 230 350 T400 315 V400 H0Z" fill="rgba(255,255,255,.08)"/>' +
      (round ? '' : '<rect x="18" y="18" width="364" height="364" rx="28" fill="none" stroke="rgba(255,255,255,.24)" stroke-width="2"/>') +
      '<text x="200" y="216" text-anchor="middle" font-family="Georgia,serif" font-size="104" ' +
      'font-style="italic" fill="rgba(255,255,255,.9)">' + xml(initials) + '</text>' +
      '<text x="200" y="262" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" ' +
      'letter-spacing="5" fill="rgba(255,255,255,.72)">' + xml(String(label || 'MUSICVER').slice(0, 20).toUpperCase()) + '</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function song(id, title, artist, album, duration, language) {
    return {
      id: id,
      title: title,
      artist: artist,
      album: album,
      duration: duration,
      language: language,
      cover: coverFor(title + artist, artist)
    };
  }

  function album(id, title, artist, year, language) {
    return {
      id: id,
      kind: 'album',
      title: title,
      artist: artist,
      year: year,
      language: language,
      cover: coverFor(title + artist, title)
    };
  }

  function artist(id, name) {
    return {
      id: id,
      kind: 'artist',
      name: name,
      title: name,
      cover: coverFor(name, name, true)
    };
  }

  const songs = [
    song('s1', 'Die For You', 'Joji', 'Nectar', 239, 'English'),
    song('s2', 'Blinding Lights', 'The Weeknd', 'After Hours', 200, 'English'),
    song('s3', 'Kesariya', 'Arijit Singh', 'Brahmāstra', 269, 'Hindi'),
    song('s4', 'Levitating', 'Dua Lipa', 'Future Nostalgia', 203, 'English'),
    song('s5', 'Tum Hi Ho', 'Arijit Singh', 'Aashiqui 2', 261, 'Hindi'),
    song('s6', 'Sunflower', 'Post Malone, Swae Lee', 'Spider-Man: Into the Spider-Verse', 158, 'English'),
    song('s7', 'Chaiyya Chaiyya', 'Sukhwinder Singh', 'Dil Se', 300, 'Hindi'),
    song('s8', 'As It Was', 'Harry Styles', "Harry's House", 167, 'English'),
    song('s9', 'Gulabi Sadi', 'Aditi Rao Hydari', 'Gulabi', 212, 'Hindi'),
    song('s10', 'Midnight City', 'M83', 'Hurry Up, We’re Dreaming', 244, 'English'),
    song('s11', 'Agar Tum Saath Ho', 'Alka Yagnik, Arijit Singh', 'Tamasha', 337, 'Hindi'),
    song('s12', 'Space Song', 'Beach House', 'Depression Cherry', 320, 'English'),
    song('s13', 'Jai Ho', 'A. R. Rahman', 'Slumdog Millionaire', 265, 'Hindi'),
    song('s14', 'Dancing Queen', 'ABBA', 'Arrival', 230, 'English'),
    song('s15', 'Bhalobasi Tomake', 'Arijit Singh', 'Bhalobasi Tomake', 246, 'Hindi'),
    song('s16', 'Starboy', 'The Weeknd', 'Starboy', 230, 'English')
  ];

  const albums = [
    album('a1', 'Nectar', 'Joji', 2020, 'English'),
    album('a2', 'After Hours', 'The Weeknd', 2020, 'English'),
    album('a3', 'Brahmāstra', 'Arijit Singh', 2022, 'Hindi'),
    album('a4', 'Blonde', 'Frank Ocean', 2016, 'English'),
    album('a5', 'Currents', 'Tame Impala', 2015, 'English'),
    album('a6', 'Aashiqui 2', 'Arijit Singh', 2013, 'Hindi'),
    album('a7', 'AM', 'Arctic Monkeys', 2013, 'English'),
    album('a8', 'Future Nostalgia', 'Dua Lipa', 2020, 'English'),
    album('a9', 'Dil Se', 'A. R. Rahman', 1998, 'Hindi'),
    album('a10', "Harry's House", 'Harry Styles', 2022, 'English'),
    album('a11', 'Tamasha', 'A. R. Rahman', 2015, 'Hindi'),
    album('a12', 'Hurry Up, We’re Dreaming', 'M83', 2011, 'English')
  ];

  const artists = [
    artist('ar1', 'Joji'),
    artist('ar2', 'The Weeknd'),
    artist('ar3', 'Arijit Singh'),
    artist('ar4', 'Dua Lipa'),
    artist('ar5', 'A. R. Rahman'),
    artist('ar6', 'Frank Ocean'),
    artist('ar7', 'Harry Styles'),
    artist('ar8', 'M83')
  ];

  const heroes = [
    {
      eyebrow: 'LATEST HITS · WORLDWIDE',
      title: 'The sound of <em>right now.</em>',
      copy: 'The records everyone is playing, gathered in one place.',
      songId: 's1',
      cover: coverFor('worldwide-hits-01', 'WORLDWIDE HITS')
    },
    {
      eyebrow: 'LATEST RELEASED ALBUMS',
      title: 'Fresh from the <em>studio.</em>',
      copy: 'New albums from the artists shaping the sound of today.',
      albumId: 'a2',
      cover: coverFor('new-albums-02', 'NEW ALBUMS')
    },
    {
      eyebrow: 'HOT RIGHT NOW · INDIA',
      title: 'Bollywood, <em>all heart.</em>',
      copy: 'The voices and melodies on every playlist this week.',
      songId: 's3',
      cover: coverFor('hindi-hot-03', 'HOT IN INDIA')
    },
    {
      eyebrow: 'GLOBAL AFTER HOURS',
      title: 'For the <em>long way home.</em>',
      copy: 'Slow lights, open windows, and songs that stay with you.',
      songId: 's10',
      cover: coverFor('after-hours-04', 'AFTER HOURS')
    }
  ];

  const genres = [
    'Chill', 'Indie Pop', 'Bollywood', 'Lo-fi', 'R&B', 'Electronic',
    'Acoustic', 'Hip-Hop', 'Dream Pop', 'Classic Hits'
  ];

  function getSong(id) { return songs.find((item) => String(item.id) === String(id)) || null; }
  function getAlbum(id) { return albums.find((item) => String(item.id) === String(id)) || null; }
  function getArtist(id) { return artists.find((item) => String(item.id) === String(id)) || null; }
  function byLanguage(language) { return songs.filter((item) => item.language === language); }

  function parseDuration(value) {
    if (typeof value === 'number' && isFinite(value)) return Math.max(0, Math.round(value));
    const text = String(value || '').trim();
    if (!text) return 0;
    if (/^\d+$/.test(text)) return Number(text);
    const parts = text.split(':').map(Number);
    if (parts.some((part) => !isFinite(part))) return 0;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  function imageOf(item) {
    if (!item || typeof item !== 'object') return '';
    return item.cover || item.thumbnail || item.image || item.art || '';
  }

  /** Convert a backend / library track into the shared track shape. */
  function normalizeTrack(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = raw.title || raw.name || raw.song || 'Unknown title';
    const seed = title + '|' + (raw.artist || raw.primary_artists || '');
    return {
      id: raw.id != null ? String(raw.id) : 'local-' + hash(seed),
      title: String(title),
      artist: String(raw.artist || raw.primary_artists || raw.artists || 'Unknown artist'),
      album: String(raw.album || raw.album_name || 'Unknown album'),
      duration: parseDuration(raw.duration),
      language: raw.language || '',
      year: raw.year || '',
      provider: raw.provider || (raw.path ? 'local' : ''),
      path: raw.path || '',
      image: imageOf(raw),
      cover: imageOf(raw) || coverFor(seed, title),
      raw: raw
    };
  }

  function normalizeAlbum(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = raw.title || raw.name || 'Unknown album';
    return {
      id: String(raw.id || hash(title)),
      kind: 'album',
      title: String(title),
      artist: String(raw.artist || 'Unknown artist'),
      year: raw.year || '',
      language: raw.language || '',
      track_count: raw.track_count || raw.count || null,
      token: raw.token || '',
      image: imageOf(raw),
      cover: imageOf(raw) || coverFor(title + (raw.artist || ''), title),
      raw: raw
    };
  }

  function normalizeArtist(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = raw.name || raw.title || 'Unknown artist';
    return {
      id: String(raw.id || hash(name)),
      kind: 'artist',
      name: String(name),
      title: String(name),
      listeners: raw.listeners || null,
      token: raw.token || '',
      image: imageOf(raw),
      cover: imageOf(raw) || coverFor(name, name, true),
      raw: raw
    };
  }

  function searchLocal(query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return { results: [], albums: [], artists: [] };
    const hit = (item) => [item.title, item.artist, item.album, item.name]
      .some((value) => String(value || '').toLowerCase().includes(needle));
    return {
      results: songs.filter(hit),
      albums: albums.filter(hit),
      artists: artists.filter(hit)
    };
  }

  MV.data = {
    songs, albums, artists, heroes, genres,
    coverFor, getSong, getAlbum, getArtist, byLanguage,
    normalizeTrack, normalizeAlbum, normalizeArtist,
    searchLocal, parseDuration, imageOf, hash
  };
})(window.MV = window.MV || {});
