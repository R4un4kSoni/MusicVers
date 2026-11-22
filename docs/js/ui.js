/* ============================================================
   musicVer · interface
   Renders every page and wires all visual interactions.
   ============================================================ */

(function (MV) {
  'use strict';

  const D = MV.data;
  const registry = {};
  let registryCount = 0;
  let modalClose = null;
  let coverCallback = null;
  let heroTimer = null;
  const PENDING_SPOTIFY_IMPORT_KEY = 'musicver.spotify.pendingImport';

  MV.registry = registry;

  MV.heroIndex = 0;
  MV.homeRefreshId = 1;
  MV.homeHeroes = [];
  MV.libraryTab = 'playlists';
  MV.libraryFilter = 'all';
  MV.resultFilter = 'all';
  MV.currentPlaylistId = null;
  MV.localSongs = [];
  MV.searchState = { query: '', result: null, visibleSongs: 30 };
  MV.discoverData = null;
  MV.artistState = null;
  MV.albumState = null;
  MV.albumReturnPage = 'home';
  let artistToken = 0;
  let albumToken = 0;
  const spotifyShelves = Object.create(null);
  const spotifyShelfTokens = Object.create(null);
  let profileEditorOpen = false;
  let selectedStoryMonth = '';
  let storyIndex = 0;

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ref(item) {
    registryCount += 1;
    const key = 'ref' + registryCount;
    registry[key] = item;
    return key;
  }
  function image(url, alt, round, meta, type, eager) {
    if (MV.artwork) {
      return MV.artwork.markup(url, alt || 'Music', round, meta || url, type, eager);
    }
    const label = alt || 'Music';
    const src = D.normalizeCover
      ? D.normalizeCover(url, label, label, round)
      : (url || D.coverFor(label, label, round));
    return '<img class="cover-image" src="' + esc(src) + '" alt="' + esc(label) + '"' +
      ' data-cover-alt="' + esc(label) + '"' +
      (round ? ' data-cover-round="true"' : '') +
      ' loading="lazy" decoding="async">';
  }
  function fmt(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const rest = Math.floor(value % 60);
    return minutes + ':' + String(rest).padStart(2, '0');
  }

  function sameTrack(a, b) { return Boolean(a && b && String(a.id) === String(b.id)); }
  function listContains(list, song) {
    return Array.isArray(list) && list.some((item) => sameTrack(item, song));
  }

  /** Play the queue that the clicked song actually belongs to. */
  function contextListFor(song) {
    const result = MV.searchState.result;
    if (listContains(result && result.songs, song)) return result.songs;
    if (listContains(MV.albumState && MV.albumState.tracks, song)) return MV.albumState.tracks;
    if (listContains(MV.artistState && MV.artistState.songs, song)) return MV.artistState.songs;
    const playlistPage = el('page-playlist');
    const playlist = playlistPage && playlistPage.classList.contains('is-active')
      ? MV.store.getPlaylist(MV.currentPlaylistId) : null;
    if (listContains(playlist && playlist.songs, song)) return playlist.songs;
    if (listContains(MV.store.state.liked, song)) return MV.store.state.liked;
    if (listContains(MV.localSongs, song)) return MV.localSongs;

    // Home/discover shelves are built from discovery data, not from
    // spotifyShelves. Match them before falling back, otherwise tapping a
    // recommendation inherits the previous home-screen queue.
    const discover = MV.discoverData || {};
    const discoverLists = [discover.trending, discover.albums, discover.charts, discover.artists];
    const discoverMatch = discoverLists.find((list) => listContains(list, song));
    if (discoverMatch) return discoverMatch;

    const recommended = Object.keys(spotifyShelves)
      .map((name) => spotifyShelves[name])
      .find((list) => listContains(list, song));
    if (recommended) return recommended;

    // Never reuse the current queue as an implicit context. That made a
    // searched song play, fail, then auto-advance into an unrelated
    // home-screen track. A song with no known list gets its own one-item queue.
    return [song];
  }

  function formatListeners(value) {
    const count = Number(value || 0);
    if (!count) return 'Artist · tap to explore';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M listeners';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K listeners';
    return count + ' listeners';
  }

  /* ---------------- toasts + modals ---------------- */

  function toast(message) {
    const root = el('toast-root');
    if (!root) return;
    const item = document.createElement('div');
    item.className = 'toast';
    item.textContent = String(message || '');
    root.appendChild(item);
    setTimeout(() => {
      item.classList.add('is-out');
      setTimeout(() => item.remove(), 320);
    }, 2500);
  }

  function closeModal() {
    const root = el('modal-root');
    if (!root) return;
    root.hidden = true;
    root.innerHTML = '';
    modalClose = null;
  }

  function openModal(content, onMount) {
    const root = el('modal-root');
    root.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + content + '</div>';
    root.hidden = false;
    modalClose = closeModal;
    root.onclick = (event) => { if (event.target === root) closeModal(); };
    const focusable = root.querySelector('input, button');
    if (focusable) focusable.focus();
    if (typeof onMount === 'function') onMount(root);
  }

  function confirmModal(title, text, label, onConfirm) {
    openModal(
      '<p class="eyebrow">PLEASE CONFIRM</p><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p>' +
      '<div class="modal__actions"><button class="btn btn--outline" data-modal="cancel">Cancel</button>' +
      '<button class="btn btn--danger-ghost" data-modal="confirm">' + esc(label) + '</button></div>',
      (root) => {
        root.querySelector('[data-modal="cancel"]').onclick = closeModal;
        root.querySelector('[data-modal="confirm"]').onclick = () => { closeModal(); onConfirm(); };
      }
    );
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('Please choose an image file.')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that image.'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('Could not open that image.'));
        image.onload = () => resolve(image);
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function readCoverFile(file) {
    return loadImageFile(file).then((image) => {
      const size = 512;
      const scale = Math.min(size / image.width, size / image.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      const width = image.width * scale;
      const height = image.height * scale;
      ctx.fillStyle = '#e8e2d9';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      return canvas.toDataURL('image/jpeg', .86);
    });
  }

  /* Interactive cropper. The guide shape matches the final artwork:
     circle for profile pictures, square for playlist covers. */
  function openImageCropper(image, options) {
    const opts = options || {};
    const shape = opts.shape === 'circle' ? 'circle' : 'square';
    const outputSize = opts.size || 512;
    const viewport = 280;
    const baseScale = Math.max(viewport / image.naturalWidth, viewport / image.naturalHeight);
    let zoom = 1;
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startOffsetX = 0;
    let startOffsetY = 0;

    const cropRoot = document.createElement('div');
    cropRoot.className = 'cropper-root';
    cropRoot.innerHTML = '<div class="modal modal--cropper" role="dialog" aria-modal="true">' +
      '<p class="eyebrow">POSITION YOUR IMAGE</p><h2>' + esc(opts.title || 'Crop image') + '</h2>' +
      '<p>' + esc(opts.description || 'Drag to reposition, then use the slider to zoom.') + '</p>' +
      '<div class="cropper-body">' +
        '<div class="cropper-stage cropper-stage--' + shape + '" id="crop-stage">' +
          '<img class="cropper-image" id="crop-image" alt="">' +
          '<div class="cropper-guide" aria-hidden="true"></div>' +
        '</div>' +
        '<div class="cropper-side">' +
          '<div class="cropper-preview cropper-preview--' + shape + '" id="crop-preview" aria-hidden="true"></div>' +
          '<label class="cropper-zoom-label" for="crop-zoom">Zoom</label>' +
          '<input class="cropper-zoom" id="crop-zoom" type="range" min="1" max="3" step="0.01" value="1">' +
          '<small>' + (shape === 'circle'
            ? 'The circular guide is your final profile picture.'
            : 'The square guide is your final playlist cover.') + '</small>' +
        '</div>' +
      '</div>' +
      '<div class="modal__actions">' +
        '<button class="btn btn--outline" data-crop="cancel">Cancel</button>' +
        '<button class="btn btn--dark" data-crop="done">Use this area</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(cropRoot);
    const closeCropper = () => cropRoot.remove();
    cropRoot.onclick = (event) => { if (event.target === cropRoot) closeCropper(); };

    (() => {
      const root = cropRoot;
        const stage = root.querySelector('#crop-stage');
        const img = root.querySelector('#crop-image');
        const slider = root.querySelector('#crop-zoom');
        const preview = root.querySelector('#crop-preview');

        img.src = image.src;

        const displayWidth = () => image.naturalWidth * baseScale * zoom;
        const displayHeight = () => image.naturalHeight * baseScale * zoom;

        function clampOffsets() {
          const maxX = Math.max(0, (displayWidth() - viewport) / 2);
          const maxY = Math.max(0, (displayHeight() - viewport) / 2);
          offsetX = Math.min(maxX, Math.max(-maxX, offsetX));
          offsetY = Math.min(maxY, Math.max(-maxY, offsetY));
        }

        function render() {
          const width = displayWidth();
          const height = displayHeight();
          img.style.width = width + 'px';
          img.style.height = height + 'px';
          img.style.left = ((viewport - width) / 2 + offsetX) + 'px';
          img.style.top = ((viewport - height) / 2 + offsetY) + 'px';
          preview.style.backgroundImage = 'url("' + image.src + '")';
          preview.style.backgroundSize = (width / viewport * 100) + '% ' + (height / viewport * 100) + '%';
          preview.style.backgroundPosition =
            (50 - offsetX / Math.max(1, width - viewport) * 100) + '% ' +
            (50 - offsetY / Math.max(1, height - viewport) * 100) + '%';
        }

        stage.addEventListener('pointerdown', (event) => {
          dragging = true;
          startX = event.clientX;
          startY = event.clientY;
          startOffsetX = offsetX;
          startOffsetY = offsetY;
          if (stage.setPointerCapture) stage.setPointerCapture(event.pointerId);
        });
        stage.addEventListener('pointermove', (event) => {
          if (!dragging) return;
          offsetX = startOffsetX + (event.clientX - startX);
          offsetY = startOffsetY + (event.clientY - startY);
          clampOffsets();
          render();
        });
        const stopDragging = () => { dragging = false; };
        stage.addEventListener('pointerup', stopDragging);
        stage.addEventListener('pointercancel', stopDragging);
        slider.addEventListener('input', () => {
          zoom = Number(slider.value) || 1;
          clampOffsets();
          render();
        });

        root.querySelector('[data-crop="cancel"]').onclick = closeCropper;
        root.querySelector('[data-crop="done"]').onclick = () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = outputSize;
          const ctx = canvas.getContext('2d');
          const ratio = outputSize / viewport;
          const width = displayWidth();
          const height = displayHeight();
          ctx.fillStyle = '#e8e2d9';
          ctx.fillRect(0, 0, outputSize, outputSize);
          ctx.drawImage(
            image,
            ((viewport - width) / 2 + offsetX) * ratio,
            ((viewport - height) / 2 + offsetY) * ratio,
            width * ratio,
            height * ratio
          );
          const dataUrl = canvas.toDataURL('image/jpeg', .9);
          closeCropper();
          if (typeof opts.onCrop === 'function') opts.onCrop(dataUrl);
        };
        render();
    })();
  }

  function coverPicker(current, callback) {
    coverCallback = (dataUrl) => {
      const preview = el('cover-preview');
      if (preview) preview.innerHTML = image(dataUrl, 'Cover');
    };
    openModal(
      '<p class="eyebrow">COVER ART</p><h2>Choose a cover</h2>' +
      '<p>Pick an image from your computer, then drag and zoom to frame the exact square you want. It is kept on this device.</p>' +
      '<div class="cover-picker"><div class="cover-picker__preview" id="cover-preview">' +
      (current ? image(current, 'Cover') : '♪') + '</div>' +
      '<div><strong>Playlist artwork</strong><small>JPG or PNG · square works best</small>' +
      '<button class="btn btn--outline" id="pick-cover-file" style="margin-top:10px">Browse files…</button></div></div>' +
      '<div class="modal__actions"><button class="btn btn--outline" data-modal="cancel">Cancel</button>' +
      '<button class="btn btn--dark" data-modal="done">Use this cover</button></div>',
      (root) => {
        root.querySelector('[data-modal="cancel"]').onclick = closeModal;
        root.querySelector('#pick-cover-file').onclick = () => el('cover-file').click();
        root.querySelector('[data-modal="done"]').onclick = () => {
          const preview = el('cover-preview');
          const img = preview && preview.querySelector('img');
          const chosen = img ? img.src : current;
          closeModal();
          if (chosen && callback) callback(chosen);
        };
      }
    );
  }

  /* ---------------- cards + rows ---------------- */

  function cardArt(item, title, isArtist, type) {
    // Artist search results often carry only a remote cover URL. Let the
    // browser load it directly so the round artwork is not stuck on the
    // cached placeholder while the artwork queue works through other images.
    if (isArtist) {
      const cover = item.cover || item.image || (item.raw && item.raw.cover) || '';
      if (cover) {
        return '<img class="cover-image media-card__artist-art" src="' + esc(cover) + '"' +
          ' alt="' + esc(title) + '" data-cover-alt="' + esc(title) + '"' +
          ' data-cover-round="true" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
      }
    }
    return image(item.cover, title, isArtist, item, type);
  }

  function mediaCard(item, type, opts) {
    const settings = opts || {};
    const key = ref(item);
    const isArtist = type === 'artist';
    const title = isArtist ? (item.name || item.title) : item.title;
    const subtitle = isArtist ? 'Artist' : (item.artist || 'Album');
    const opensDetails = isArtist || type === 'album';
    const action = settings.action || (isArtist ? 'open-artist' : (type === 'album' ? 'open-album' : 'play-song'));
    const saved = type === 'album' && MV.store.isAlbumSaved(item);
    const classes = [
      'media-card',
      isArtist ? 'media-card--artist' : '',
      settings.wide ? 'media-card--wide' : '',
      settings.spotify ? 'media-card--spotify' : ''
    ].join(' ').replace(/\s+/g, ' ').trim();
    const glyph = settings.glyph || (opensDetails ? '↗' : '▶');

    return '<article class="' + classes + '" tabindex="0" role="button" data-action="' + action + '" data-key="' + key + '" data-tilt aria-label="' + (opensDetails ? 'Open ' : 'Play ') + esc(title) + '">' +
      '<div class="media-card__art">' + cardArt(item, title, isArtist, type) +
      '<span class="media-card__shine"></span>' +
      '<button class="media-card__play" aria-label="' + (opensDetails ? 'Open details' : 'Open mix') + '">' + glyph + '</button>' +
      (type === 'album'
        ? '<button class="media-card__save ' + (saved ? 'is-saved' : '') + '" data-action="save-album" data-key="' + key + '" aria-label="Save album" title="Save album to library">' + (saved ? '✓' : '↓') + '</button>'
        : '') +
      '</div><div class="media-card__meta"><strong>' + esc(title) + '</strong><span>' + esc(subtitle) + '</span></div></article>';
  }

  function recentTile(entry) {
    const display = {
      id: entry.id,
      title: entry.title,
      artist: entry.subtitle || entry.type || '',
      cover: entry.cover
    };
    return mediaCard(display, 'song', {
      action: 'play-recent',
      spotify: true,
      subtitle: entry.subtitle || entry.type || ''
    });
  }

  function songRow(song, index, opts) {
    const settings = opts || {};
    const key = ref(song);
    const liked = MV.store.isLiked(song.id);
    const current = MV.player.state.current && String(MV.player.state.current.id) === String(song.id);
    return '<article class="song-row ' + (current ? 'is-current' : '') + '" tabindex="0" role="button" data-action="' + (settings.action || 'play-song') + '" data-key="' + key + '">' +
      '<span class="song-row__index">' + String(index + 1).padStart(2, '0') + '</span>' +
      '<div class="song-row__art">' + image(song.cover, song.title, false, song, 'song') + '</div>' +
      '<div class="song-row__copy"><strong>' + esc(song.title) + '</strong><span>' + esc(song.artist) + '</span></div>' +
      (settings.detailed
        ? '<span class="song-row__album">' + esc(song.album || '') + '</span>' +
          '<span class="song-row__duration">' + esc(song.duration ? fmt(Number(song.duration)) : '') + '</span>'
        : '') +
      (settings.inPlaylist
        ? '<button class="song-row__more" data-action="song-menu" data-key="' + key + '" data-in-playlist="1" aria-label="More options" title="More options">···</button>'
        : '<button class="song-row__like ' + (liked ? 'is-liked' : '') + '" data-action="like-song" data-key="' + key + '" aria-label="Like song">' + (liked ? '♥' : '♡') + '</button>' +
          '<button class="song-row__more" data-action="song-menu" data-key="' + key + '" aria-label="More options" title="More options">···</button>') +
      '<button class="song-row__play" aria-label="Play">▶</button></article>';
  }

  function sparkle(button, liked) {
    if (!button || !liked) return;
    button.classList.remove('like-sparkle');
    // Force a reflow so consecutive likes replay the animation.
    void button.offsetWidth;
    button.classList.add('like-sparkle');
    setTimeout(() => button.classList.remove('like-sparkle'), 650);
  }

  /** Update hearts everywhere without re-rendering the whole interface. */
  function updateLikeButtons(song, button, animate) {
    const liked = song ? MV.store.isLiked(song.id) : false;

    document.querySelectorAll('.song-row__like').forEach((node) => {
      const item = registry[node.dataset.key];
      if (song && !sameTrack(item, song)) return;
      const value = song ? liked : MV.store.isLiked(item && item.id);
      node.textContent = value ? '♥' : '♡';
      node.classList.toggle('is-liked', value);
      node.setAttribute('aria-pressed', String(value));
      node.title = value ? 'Remove from Liked Songs' : 'Add to Liked Songs';
    });

    const current = MV.player.state.current;
    if (current && (!song || sameTrack(current, song))) {
      const playerLike = el('player-like');
      if (playerLike) {
        playerLike.textContent = liked ? '♥' : '♡';
        playerLike.classList.toggle('is-on', liked);
        playerLike.classList.toggle('is-liked', liked);
        playerLike.setAttribute('aria-pressed', String(liked));
      }
      const flowLike = el('flow-like');
      if (flowLike) {
        flowLike.textContent = liked ? '♥ Liked' : '♡ Like';
        flowLike.classList.toggle('is-on', liked);
        flowLike.classList.toggle('is-liked', liked);
      }
      const flowLikeTop = el('flow-like-top');
      if (flowLikeTop) {
        flowLikeTop.textContent = liked ? '♥' : '♡';
        flowLikeTop.classList.toggle('is-on', liked);
        flowLikeTop.classList.toggle('is-liked', liked);
        flowLikeTop.setAttribute('aria-pressed', String(liked));
      }
    }

    if (animate) sparkle(button, liked);
  }

  function miniTile(item, type) {
    const key = ref(item);
    const title = type === 'artist' ? (item.name || item.title) : item.title;
    const action = type === 'artist' ? 'open-artist' : 'open-album';
    return '<button class="mini-tile ' + (type === 'artist' ? 'mini-tile--artist' : '') + '" data-action="' + action + '" data-key="' + key + '">' +
      image(item.cover, title, type === 'artist', item, type) + '<span class="mini-tile__copy"><strong>' + esc(title) + '</strong>' +
      '<small>' + esc(type === 'artist' ? 'Artist' : (item.artist || 'Album')) + '</small></span></button>';
  }

  /** Artist result shown as a song-like bar with one top matched track. */
  function artistRow(artist, index, topSong) {
    const key = ref(artist);
    const name = artist.name || artist.title || 'Unknown artist';
    const songKey = topSong ? ref(topSong) : null;
    const listeners = artist.listeners
      ? '<span>✦ ' + esc(typeof artist.listeners === 'number' ? artist.listeners.toLocaleString() : artist.listeners) + ' listeners</span>'
      : '<span>Artist · tap to explore</span>';

    return '<article class="artist-row" tabindex="0" role="button" data-action="open-artist" data-key="' + key + '" aria-label="Open ' + esc(name) + '">' +
      '<div class="artist-row__art">' + image(artist.cover, name, true, artist, 'artist') + '</div>' +
      '<div class="artist-row__copy"><strong>' + esc(name) + '</strong>' + listeners + '</div>' +
      '<div class="artist-row__top">' +
      (topSong
        ? '<small>TOP MATCHED SONG</small><strong>' + esc(topSong.title) + '</strong><em>' + esc(topSong.artist || name) + '</em>'
        : '<small>DISCOVER</small><strong>Popular songs, albums &amp; more</strong>') +
      '</div>' +
      '<div class="artist-row__actions">' +
      (topSong ? '<button class="artist-row__play" data-action="play-song" data-key="' + songKey + '" aria-label="Play ' + esc(topSong.title) + '">▶</button>' : '') +
      '<button class="artist-row__open" data-action="open-artist" data-key="' + key + '" aria-label="Open artist" title="Open artist">↗</button>' +
      '</div></article>';
  }

  /* ---------------- home ---------------- */

  /** A new seed on every page load keeps the home mixes feeling fresh. */
  function nextHomeRefreshId() {
    const key = 'musicver.home.refresh';
    try {
      const next = (Number(sessionStorage.getItem(key)) || 0) + 1;
      sessionStorage.setItem(key, String(next));
      return next;
    } catch (error) {
      return (Math.random() * 100000) | 0 || 1;
    }
  }

  function hashSeed(text) {
    let hash = 2166136261;
    String(text || '').split('').forEach((char) => {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    });
    return hash >>> 0;
  }

  function homeShuffle(list, salt) {
    const shuffled = (list || []).slice();
    let seed = (((MV.homeRefreshId || 1) * 104729 + hashSeed(salt)) >>> 0) || 1;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    return shuffled;
  }

  function refreshedShelf(primary, secondary, salt, limit) {
    return homeShuffle(fillShelf(primary, secondary, 1000), salt).slice(0, limit);
  }

  function renderHero() {
    const track = el('hero-track');
    if (!track) return;
    const slides = MV.homeHeroes && MV.homeHeroes.length ? MV.homeHeroes : D.heroes;
    track.innerHTML = slides.map((slide, index) => {
      // Hero copy is a tagline, not searchable metadata. Use the linked song or
      // album so artwork matching can find a verified cover before the default.
      const linked = (slide.songId && D.getSong && D.getSong(slide.songId)) ||
        (slide.albumId && D.getAlbum && D.getAlbum(slide.albumId)) || slide;
      const artType = slide.albumId ? 'album' : 'song';
      const label = String(slide.title || 'Music').replace(/<[^>]*>/g, '');
      return '<div class="hero-slide ' + (index === 0 ? 'is-current' : '') + '">' +
        image(linked.cover || slide.cover, label, false, linked, artType, true) +
        '<span class="hero-slide__orb"></span></div>';
    }).join('');
    track.querySelectorAll('img').forEach((img) => img.classList.add('hero-slide__art'));
    el('hero-dots').innerHTML = slides.map((slide, index) =>
      '<button class="hero-dot ' + (index === 0 ? 'is-current' : '') + '" data-hero="' + index + '" aria-label="Slide ' + (index + 1) + '"></button>').join('');
    setHero(0);
  }

  function setHero(index) {
    const slides = MV.homeHeroes && MV.homeHeroes.length ? MV.homeHeroes : D.heroes;
    if (!slides.length) return;
    MV.heroIndex = (index + slides.length) % slides.length;
    const slide = slides[MV.heroIndex];
    el('hero-track').style.transform = 'translateX(-' + (MV.heroIndex * 100) + '%)';
    el('hero-eyebrow').textContent = slide.eyebrow;
    el('hero-title').innerHTML = slide.title;
    el('hero-copy').textContent = slide.copy;
    el('hero-index').textContent = String(MV.heroIndex + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
    document.querySelectorAll('.hero-slide').forEach((node, i) => node.classList.toggle('is-current', i === MV.heroIndex));
    document.querySelectorAll('.hero-dot').forEach((node, i) => node.classList.toggle('is-current', i === MV.heroIndex));
  }

  function startHero() {
    stopHero();
    heroTimer = setInterval(() => setHero(MV.heroIndex + 1), 6200);
  }
  function stopHero() { if (heroTimer) clearInterval(heroTimer); }

  const HOME_SHELF_SIZE = 18;
  const LIBRARY_VIEWS = { all: 'playlists', downloads: 'local', albums: 'saved' };

  /** De-duplicated source list for a classic horizontal Spotify-style shelf. */
  function fillShelf(primary, secondary, limit) {
    const seen = new Set();
    const unique = [];
    [].concat(primary || [], secondary || []).forEach((song) => {
      if (!song) return;
      const key = String(song.id || song.title || '');
      if (!key || seen.has(key)) return;
      seen.add(key);
      unique.push(song);
    });
    return unique.slice(0, limit);
  }

  function languageShelf(language) {
    const live = (MV.discoverData && MV.discoverData.trending) || [];
    const match = live.filter((song) => String(song.language || '').toLowerCase() === language.toLowerCase());
    return refreshedShelf(match, D.byLanguage(language), 'language-' + language, HOME_SHELF_SIZE);
  }

  function renderHome() {
    const history = MV.store.state.recentlyPlayed || [];
    el('recently-played').innerHTML = history.length
      ? history.map(recentTile).join('')
      : '<div class="empty-state empty-state--rail"><span class="empty-state__icon">♫</span><h3>Your history starts here</h3><p>Play a song and it will appear in this shelf.</p></div>';

    const discovered = MV.discoverData;
    const trending = discovered && discovered.trending && discovered.trending.length
      ? discovered.trending : D.songs;
    const albumList = discovered && discovered.albums && discovered.albums.length
      ? discovered.albums : D.albums;

    el('trending-now').innerHTML = refreshedShelf(trending, D.songs, 'trending', HOME_SHELF_SIZE)
      .map((song) => mediaCard(song, 'song', { spotify: true, action: 'open-song-mix', glyph: '›' })).join('');
    el('albums-all').innerHTML = homeShuffle(albumList, 'albums').slice(0, 14)
      .map((album) => mediaCard(album, 'album', { spotify: true, action: 'open-album-catalog', glyph: '›' })).join('');
    el('hindi-songs').innerHTML = languageShelf('Hindi')
      .map((song) => mediaCard(song, 'song', { spotify: true, action: 'open-language-mix', glyph: '›' })).join('');
    el('english-songs').innerHTML = languageShelf('English')
      .map((song) => mediaCard(song, 'song', { spotify: true, action: 'open-language-mix', glyph: '›' })).join('');
  }

  function renderFeatureCards() {
    const host = el('feature-cards');
    if (!host) return;
    const live = (MV.discoverData && MV.discoverData.albums) || [];
    const albums = homeShuffle(fillShelf(live, D.albums, 1000), 'featured-albums').slice(0, 2);
    host.innerHTML = albums.map((album) => {
      const key = ref(album);
      return '<article class="feature-card" tabindex="0" role="button" data-action="open-album" data-key="' + key + '" aria-label="Open ' + esc(album.title) + '">' +
        '<div class="feature-card__art">' + image(album.cover, album.title, false, album, 'album') + '</div>' +
        '<div class="feature-card__copy"><span>FEATURED ALBUM</span>' +
        '<strong>' + esc(album.title) + '</strong><small>' + esc(album.artist || 'Album') + '</small></div>' +
        '<span class="feature-card__arrow" aria-hidden="true">↗</span></article>';
    }).join('');
  }

  function renderHomeChrome() {
    const profile = MV.store.state.profile;
    const initial = (profile.name || 'M').charAt(0).toUpperCase();
    const pictureHtml = profile.picture
      ? image(profile.picture, profile.name || 'Profile', true, { picture: profile.picture, name: profile.name }, 'artist', true)
      : initial;
    const avatar = el('home-avatar');
    if (avatar) avatar.innerHTML = pictureHtml;
    const name = el('home-profile-name');
    if (name) name.textContent = profile.name || 'Music Lover';
    const greeting = el('home-greeting');
    if (greeting) {
      const hour = new Date().getHours();
      greeting.textContent = hour < 12 ? 'Good morning' : (hour < 17 ? 'Good afternoon' : 'Good evening');
    }
  }

  function setHomeFilter(filter) {
    document.querySelectorAll('.home-filter').forEach((node) => {
      const active = node.dataset.homeFilter === filter;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', String(active));
    });
    const target = el(filter === 'new' ? 'shelf-albums' : (filter === 'trending' || filter === 'charts' ? 'shelf-trending' : 'feature-cards'));
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    blurIn(target);
  }

  /* ---------------- discover ---------------- */

  function renderRecentSearches() {
    const popover = el('recent-searches');
    if (!popover) return;
    const items = MV.store.state.recentSearches || [];
    popover.innerHTML =
      '<div class="recent-popover__head"><span>RECENT SEARCHES</span>' +
      (items.length ? '<button data-action="clear-searches">Clear all</button>' : '') + '</div>' +
      (items.length
        ? items.map((query) => '<button class="recent-item" data-action="recent-search" data-query="' + esc(query) + '"><span>↗</span>' + esc(query) + '</button>').join('')
        : '<div class="recent-popover__empty">Your searches will show up here.</div>');
  }

  function renderSearchSuggestions() {
    const host = el('start-here');
    if (!host) return;
    const song = D.songs[0];
    const album = D.albums[0];
    const artist = D.artists[0];
    const language = (D.genres && D.genres[0]) || 'Hindi';
    const genreAlbum = D.albums[2] || album;
    const suggestions = [
      { query: song.title, label: 'Popular song', cover: song.cover, meta: song, type: 'song' },
      { query: album.title, label: 'Album', cover: album.cover, meta: album, type: 'album' },
      { query: artist.name || artist.title, label: 'Artist', cover: artist.cover, meta: artist, type: 'artist' },
      { query: language, label: 'Genre', cover: genreAlbum.cover, meta: genreAlbum, type: 'album' }
    ].filter((entry) => entry.query);
    host.innerHTML = suggestions.map((entry) =>
      '<button class="start-item" data-action="quick-search" data-query="' + esc(entry.query) + '">' +
      '<span class="start-item__art">' + image(entry.cover, entry.query, false, entry.meta, entry.type) + '</span>' +
      '<span class="start-item__copy"><strong>' + esc(entry.query) + '</strong><small>' + esc(entry.label) + '</small></span>' +
      '<span class="start-item__arrow" aria-hidden="true">↗</span></button>').join('');
  }

  function renderDiscoverPicks() {
    const host = el('discover-picks');
    if (!host) return;
    const live = (MV.discoverData && MV.discoverData.trending) || [];
    const picks = refreshedShelf(live, D.songs, 'discover-picks', 4);
    host.innerHTML = picks.map((song) =>
      mediaCard(song, 'song', { spotify: true, action: 'open-song-mix', glyph: '›' })).join('');
  }

  /* ---------------- Spotify recommendation shelves ---------------- */

  const SPOTIFY_SHELVES = {
    home: { host: 'spotify-home-recs', source: 'spotify-home-source', limit: 8 },
    discover: { host: 'spotify-discover-recs', source: 'spotify-discover-source', limit: 8 },
    results: { host: 'spotify-result-recs', source: 'spotify-results-source', limit: 8 },
    library: { host: 'spotify-library-recs', source: 'spotify-library-source', limit: 8 },
    playlist: { host: 'spotify-playlist-recs', source: 'spotify-playlist-source', limit: 6 },
    album: { host: 'spotify-album-recs', source: 'spotify-album-source', limit: 8 },
    artist: { host: 'spotify-artist-recs', source: 'spotify-artist-source', limit: 8 }
  };

  function genreName(genre) {
    if (typeof genre === 'string') return genre;
    return (genre && (genre.name || genre.title)) || '';
  }

  function spotifyRawId(item) {
    const value = item && (item.spotifyId || (item.raw && item.raw.id) || item.id);
    const match = String(value || '').match(/[A-Za-z0-9]{22}/);
    return match ? match[0] : '';
  }

  function compactSpotifySeeds(seeds) {
    const source = seeds || {};
    const tracks = (source.tracks || []).slice(0, 5).map(spotifyRawId).filter(Boolean);
    const artists = (source.artists || []).slice(0, 5).map(spotifyRawId).filter(Boolean);
    const queries = (source.queries || []).slice(0, 4).map((query) => String(query || '')).filter(Boolean);
    (source.artists || []).slice(0, 2).forEach((artist) => {
      const name = artist && (artist.name || artist.title);
      if (name && queries.indexOf(String(name)) < 0) queries.push(String(name));
    });
    return {
      tracks: tracks,
      artists: artists,
      genres: (source.genres || []).slice(0, 3).map((genre) => String(genre || '').toLowerCase()).filter(Boolean),
      queries: queries,
      titles: (source.titles || []).slice(0, 3).map((title) => String(title || '')).filter(Boolean)
    };
  }

  function spotifySeedsForHome() {
    const trending = (MV.discoverData && MV.discoverData.trending) || D.songs || [];
    return {
      tracks: trending.slice(0, 2),
      queries: [genreName(D.genres && D.genres[0]), 'trending hits'].filter(Boolean)
    };
  }

  function spotifySeedsForDiscover() {
    const recent = (MV.store.state.recentSearches || []).slice(0, 2);
    const genres = (D.genres || []).slice(0, 2).map(genreName).filter(Boolean);
    return {
      queries: recent.concat(genres),
      tracks: ((MV.discoverData && MV.discoverData.trending) || []).slice(0, 2)
    };
  }

  function spotifySeedsForResults() {
    const result = MV.searchState.result;
    const query = MV.searchState.query || '';
    // Do not put the raw query in `titles`: local recommendations exclude
    // seed titles, which would discard every song matching the search.
    return {
      queries: [query].filter(Boolean),
      tracks: result && result.songs ? result.songs.slice(0, 2) : [],
      artists: result && result.artists ? result.artists.slice(0, 1) : []
    };
  }

  function spotifySeedsForLibrary() {
    const state = MV.store.state;
    return {
      tracks: (state.liked || []).slice(0, 2),
      queries: (state.savedAlbums || []).slice(0, 2).map((album) => album.title).filter(Boolean),
      titles: (state.playlists || []).slice(0, 1).map((playlist) => playlist.name).filter(Boolean)
    };
  }

  function spotifySeedsForPlaylist() {
    const playlist = MV.store.getPlaylist(MV.currentPlaylistId);
    if (!playlist) return { queries: [] };
    return {
      tracks: (playlist.songs || []).slice(0, 2),
      queries: [playlist.name].filter(Boolean),
      titles: [playlist.name].filter(Boolean)
    };
  }

  function spotifySeedsForAlbum() {
    const state = MV.albumState;
    if (!state || !state.album) return { queries: [] };
    return {
      tracks: (state.tracks || []).slice(0, 2),
      queries: [state.album.title, state.album.artist].filter(Boolean),
      titles: [state.album.title].filter(Boolean)
    };
  }

  function spotifySeedsForArtist() {
    const state = MV.artistState;
    if (!state) return { queries: [] };
    const artist = (state.details && state.details.artist) || state.artist || {};
    const name = artist.name || artist.title || '';
    return {
      tracks: (state.songs || []).slice(0, 2),
      artists: [artist],
      queries: [name].filter(Boolean),
      titles: [name].filter(Boolean)
    };
  }

  function renderSpotifyShelf(name, seeds) {
    const config = SPOTIFY_SHELVES[name];
    const host = config ? el(config.host) : null;
    if (!host) return;
    const payload = compactSpotifySeeds(seeds);
    const status = MV.spotify ? MV.spotify.status() : null;
    const token = name + '|' + (status && status.ready ? 'live' : 'local') + '|' + JSON.stringify(payload);
    spotifyShelfTokens[name] = token;
    host.innerHTML = '<div class="recommend-skeleton"><span></span><span></span><span></span><span></span></div>';

    const source = el(config.source);
    if (source) {
      source.textContent = status && status.ready
        ? 'LIVE SPOTIFY'
        : (status && status.connected ? 'RECONNECTING' : 'CONNECT FOR LIVE PICKS');
      source.classList.toggle('is-live', Boolean(status && status.ready));
    }

    const request = MV.spotify
      ? MV.spotify.recommendFor(payload, config.limit)
      : Promise.resolve({ source: 'local', tracks: [] });

    Promise.resolve(request).then((data) => {
      if (spotifyShelfTokens[name] !== token) return;
      const tracks = ((data && data.tracks) || []).filter(Boolean).slice(0, config.limit);
      spotifyShelves[name] = tracks;
      const live = Boolean(data && data.source === 'spotify');
      if (!tracks.length) {
        host.innerHTML = '<div class="recommend-empty">No picks yet. Connect Spotify or try another search.</div>';
        if (source) {
          source.textContent = 'NO PICKS';
          source.classList.remove('is-live');
        }
        return;
      }
      host.innerHTML = tracks.map((song) =>
        mediaCard(song, 'song', { spotify: true, action: 'play-song', glyph: '▶' })).join('');
      if (source) {
        source.textContent = live ? 'LIVE SPOTIFY' : 'LOCAL PICKS';
        source.classList.toggle('is-live', live);
      }
    }).catch(() => {
      if (spotifyShelfTokens[name] !== token) return;
      spotifyShelves[name] = [];
      host.innerHTML = '<div class="recommend-empty">Recommendations are unavailable right now.</div>';
      if (source) {
        source.textContent = 'UNAVAILABLE';
        source.classList.remove('is-live');
      }
    });
  }

  function renderAllSpotifyShelves() {
    renderSpotifyShelf('home', spotifySeedsForHome());
    renderSpotifyShelf('discover', spotifySeedsForDiscover());
    renderSpotifyShelf('library', spotifySeedsForLibrary());
    if (MV.currentPlaylistId) renderSpotifyShelf('playlist', spotifySeedsForPlaylist());
    if (MV.albumState && MV.albumState.album) renderSpotifyShelf('album', spotifySeedsForAlbum());
    if (MV.artistState && MV.artistState.details) renderSpotifyShelf('artist', spotifySeedsForArtist());
  }

  function renderRecentlyExplored() {
    const host = el('recently-explored');
    if (!host) return;
    const played = (MV.store.state.recentlyPlayed || []).slice(0, 4).map(recentTile);
    const searched = (MV.store.state.recentSearches || []).slice(0, 4).map((query) =>
      '<button class="recent-explored-card" data-action="quick-search" data-query="' + esc(query) + '">' +
      '<span class="recent-explored-card__icon" aria-hidden="true">⌕</span>' +
      '<strong>' + esc(query) + '</strong><small>Recent search</small></button>');
    const entries = played.concat(searched).slice(0, 6);
    host.innerHTML = entries.length
      ? entries.join('')
      : '<div class="recent-explored-empty">Songs you play or search for will appear here.</div>';
  }

  function setResultFilter(filter) {
    MV.resultFilter = filter;
    document.querySelectorAll('.result-filter').forEach((node) => {
      const active = node.dataset.resultFilter === filter;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', String(active));
    });
    const map = { songs: 'result-block-songs', artists: 'result-block-artists', albums: 'result-block-albums', podcasts: 'result-block-podcasts' };
    const resultsRoot = el('results');
    if (resultsRoot) resultsRoot.classList.toggle('results-filtered', filter !== 'all');
    document.querySelectorAll('[id^="result-block-"]').forEach((node) => { node.hidden = true; });
    if (filter === 'all') {
      document.querySelectorAll('[id^="result-block-"]').forEach((node) => { node.hidden = false; });
      el('result-block-podcasts').hidden = true;
    } else if (map[filter]) {
      el(map[filter]).hidden = false;
    }
    blurIn(map[filter] ? el(map[filter]) : resultsRoot);
  }

  function renderGenres() {
    const genres = (MV.discoverData && MV.discoverData.genres && MV.discoverData.genres.length)
      ? MV.discoverData.genres.slice(0, 12).map((genre) => typeof genre === 'string' ? genre : (genre.name || genre.title))
      : D.genres;
    // Spotify-style browse tiles: one card per mood instead of a run-together
    // row of small capsules.
    el('genre-chips').innerHTML = genres.filter(Boolean).map((name) =>
      '<button class="genre-card" data-action="chip-search" data-query="' + esc(name) + '">' +
      '<span class="genre-card__label">' + esc(name) + '</span>' +
      '<span class="genre-card__orb" aria-hidden="true"></span></button>').join('');
  }

  function topSongFor(artist, songs) {
    const name = String(artist.name || artist.title || '').toLowerCase().trim();
    const list = songs || [];
    if (!list.length) return null;
    if (!name) return list[0];
    const exact = list.find((song) => String(song.artist || '').toLowerCase().includes(name)) ||
      list.find((song) => name.includes(String(song.artist || '').toLowerCase()));
    if (exact) return exact;
    const tokens = name.split(/\s+/).filter((token) => token.length > 2);
    return list.find((song) => {
      const artistName = String(song.artist || '').toLowerCase();
      return tokens.some((token) => artistName.includes(token));
    }) || list[0];
  }

  function topResultFor(result, query) {
    const clean = String(query || '').trim().replace(/^(?:the|a|an)\s+/i, '').toLowerCase();
    const wanted = clean.replace(/\s+(?:by|from)\s+.+$/i, '');
    const albums = (result && result.albums) || [];
    const artists = (result && result.artists) || [];
    const songs = (result && result.songs) || [];
    const matchesAlbum = albums.find((album) =>
      String(album.title || '').toLowerCase().indexOf(wanted) >= 0);
    const matchesArtist = artists.find((artist) =>
      String(artist.name || artist.title || '').toLowerCase().indexOf(wanted) >= 0);
    const matchesSong = songs.find((song) =>
      String(song.title || '').toLowerCase().indexOf(wanted) >= 0);
    if (/\balbums?\b/i.test(String(query || '')) && albums.length) {
      return { item: matchesAlbum || albums[0], type: 'Album' };
    }
    // An exact artist name should win over an album that merely contains the
    // artist's name; otherwise "arijit singh" surfaces a compilation first.
    if (matchesArtist && !/\bsongs?\b/i.test(String(query || '')) && !matchesSong) {
      return { item: matchesArtist, type: 'Artist' };
    }
    if (matchesAlbum && !matchesSong) return { item: matchesAlbum, type: 'Album' };
    if (songs.length) return { item: matchesSong || songs[0], type: 'Song' };
    if (albums.length) return { item: albums[0], type: 'Album' };
    if (artists.length) return { item: artists[0], type: 'Artist' };
    return null;
  }

  function topResultCard(result, query) {
    const top = topResultFor(result, query);
    if (!top || !top.item) {
      return '<div class="top-result top-result--empty"><strong>No top match</strong><span>Try a different spelling or artist.</span></div>';
    }
    const item = top.item;
    const key = ref(item);
    const title = top.type === 'Artist' ? (item.name || item.title) : item.title;
    const subtitle = top.type === 'Artist' ? 'Artist' : (item.artist || top.type);
    const action = top.type === 'Artist' ? 'open-artist'
      : (top.type === 'Album' ? 'open-album' : 'play-song');
    return '<article class="top-result" tabindex="0" role="button" data-action="' + action + '" data-key="' + key + '" aria-label="' + (top.type === 'Song' ? 'Play ' : 'Open ') + esc(title) + '">' +
      '<div class="top-result__art">' + image(item.cover, title, false, item, 'song') + '</div>' +
      '<div class="top-result__copy"><span class="top-result__type">' + esc(top.type) + '</span>' +
      '<strong>' + esc(title) + '</strong><small>' + esc(subtitle) + '</small></div>' +
      '<button class="top-result__action" data-action="' + action + '" data-key="' + key + '" aria-label="' + (top.type === 'Song' ? 'Play ' : 'Open ') + esc(title) + '">' +
      (top.type === 'Song' ? '▶' : '↗') + '</button></article>';
  }

  function renderResults() {
    const results = el('results');
    const discoverPage = el('page-discover');
    if (!MV.searchState.result) {
      results.hidden = true;
      if (discoverPage) discoverPage.classList.remove('has-results');
      const loadButton = el('load-more-songs');
      if (loadButton) loadButton.hidden = true;
      const topHost = el('result-top');
      if (topHost) topHost.innerHTML = '';
      const spotifyHost = el(SPOTIFY_SHELVES.results.host);
      if (spotifyHost) spotifyHost.innerHTML = '';
      spotifyShelves.results = [];
      return;
    }
    results.hidden = false;
    if (discoverPage) discoverPage.classList.add('has-results');
    const { query, result } = MV.searchState;
    const visible = Math.max(30, Number(MV.searchState.visibleSongs) || 30);
    el('results-heading').textContent = 'Results for “' + query + '”';
    el('results-eyebrow').textContent = result.source === 'online' ? 'LIVE CATALOGUE' : 'LOCAL CATALOGUE';
    el('search-status').textContent = result.songs.length + ' songs · ' + result.artists.length + ' artists · ' + result.albums.length + ' albums';

    const topHost = el('result-top');
    if (topHost) topHost.innerHTML = topResultCard(result, query);

    const songs = result.songs.slice(0, visible);
    const emptySongs = '<div class="empty-state"><span class="empty-state__icon">⌕</span><h3>No songs found</h3><p>Try another spelling or artist name.</p></div>';
    const songsA = el('result-songs-a');
    if (songsA) {
      songsA.innerHTML = songs.length
        ? songs.map((song, idx) => songRow(song, idx, { detailed: true })).join('')
        : emptySongs;
    }

    const loadButton = el('load-more-songs');
    if (loadButton) {
      loadButton.hidden = result.songs.length <= visible;
      loadButton.textContent = 'Load more songs ↓ (' + Math.max(0, result.songs.length - visible) + ' left)';
    }

    el('result-artists').innerHTML = result.artists.length
      ? result.artists.map((artist) => mediaCard(artist, 'artist', { spotify: true, glyph: '↗' })).join('')
      : '<p class="empty-state empty-state--compact">No artists matched.</p>';
    el('result-albums').innerHTML = result.albums.length
      ? result.albums.slice(0, 8).map((album) => mediaCard(album, 'album', { spotify: true, glyph: '↗' })).join('')
      : '<p class="empty-state empty-state--compact">No albums matched.</p>';

    const podcasts = Array.isArray(result.podcasts) ? result.podcasts : [];
    el('result-podcasts').innerHTML = podcasts.length
      ? podcasts.map((podcast) => {
        const key = ref(podcast);
        return '<button class="start-item" data-action="play-song" data-key="' + key + '">' +
          '<span class="start-item__art">' + image(podcast.cover, podcast.title, false, podcast, 'album') + '</span>' +
          '<span class="start-item__copy"><strong>' + esc(podcast.title) + '</strong><small>' + esc(podcast.artist || 'Podcast') + '</small></span>' +
          '<span class="start-item__arrow" aria-hidden="true">▶</span></button>';
      }).join('')
      : '<div class="empty-state"><span class="empty-state__icon">◎</span><h3>No podcasts in this catalogue</h3><p>Music search is available. Podcast results will appear here if a provider returns them.</p></div>';
    setResultFilter(MV.resultFilter);
    renderSpotifyShelf('results', spotifySeedsForResults());
  }

  async function runSearch(query) {
    const clean = String(query || '').trim();
    if (!clean) return;
    el('search-input').value = clean;
    el('search-clear').hidden = false;
    el('recent-searches').hidden = true;
    el('search-status').textContent = 'Searching…';
    MV.store.addRecentSearch(clean);
    renderRecentlyExplored();
    const result = await MV.api.search(clean);
    MV.searchState = { query: clean, result, visibleSongs: 30 };
    renderResults();
  }

  /* ---------------- library ---------------- */

  function playlistCard(playlist) {
    const key = ref(playlist);
    return '<article class="playlist-card" tabindex="0" role="button" data-action="open-playlist" data-key="' + key + '">' +
      '<div class="playlist-card__art">' + (playlist.cover ? image(playlist.cover, playlist.name, false, playlist, 'playlist') : '♪') + '</div>' +
      '<div class="playlist-card__meta"><strong>' + esc(playlist.name) + '</strong><small>' + playlist.songs.length + ' songs · Playlist</small></div>' +
      '<button class="library-row__play" data-action="play-playlist" data-key="' + key + '" aria-label="Play ' + esc(playlist.name) + '">▶</button>' +
      '<button class="playlist-card__menu" data-action="playlist-menu" data-key="' + key + '" aria-label="Playlist options">···</button></article>';
  }

  function savedCard(album) {
    const key = ref(album);
    return '<article class="playlist-card" tabindex="0" role="button" data-action="open-album" data-key="' + key + '">' +
      '<div class="playlist-card__art">' + image(album.cover, album.title, false, album, 'album') + '</div>' +
      '<div class="playlist-card__meta"><strong>' + esc(album.title) + '</strong><small>' + esc(album.artist || 'Album') + '</small></div>' +
      '<button class="library-row__play" data-action="open-album" data-key="' + key + '" aria-label="Open ' + esc(album.title) + '">↗</button>' +
      '<button class="playlist-card__menu" data-action="remove-saved" data-key="' + key + '" aria-label="Remove saved album">×</button></article>';
  }

  function libraryEmpty(icon, title, copy) {
    return '<div class="empty-state"><span class="empty-state__icon">' + icon + '</span><h3>' + title + '</h3><p>' + copy + '</p></div>';
  }

  function librarySection(title, content) {
    return '<section class="library-section"><h3>' + title + '</h3>' + content + '</section>';
  }

  function renderLibrary() {
    const state = MV.store.state;
    const filter = MV.libraryFilter || MV.libraryTab;
    const view = LIBRARY_VIEWS[filter] || filter;
    el('liked-count').textContent = state.liked.length + ' songs';
    el('saved-count').textContent = state.savedAlbums.length + ' albums';
    document.querySelectorAll('[data-library-tab]').forEach((tab) =>
      tab.classList.toggle('is-active', tab.dataset.libraryTab === filter));
    document.querySelectorAll('.library-tab[data-library-tab]').forEach((tab) =>
      tab.classList.toggle('is-active', tab.dataset.libraryTab === view));

    const createCard = '<button class="playlist-card playlist-card--create" data-action="create-playlist"><span>＋</span><strong>New playlist</strong></button>';
    const playlists = state.playlists.map(playlistCard).join('') + createCard;
    const liked = state.liked.length
      ? '<div class="song-list">' + state.liked.map((song, i) => songRow(song, i)).join('') + '</div>'
      : libraryEmpty('♥', 'Nothing liked yet', 'Tap the heart on a song to keep it here.');
    const saved = state.savedAlbums.length
      ? '<div class="grid-rail">' + state.savedAlbums.map(savedCard).join('') + '</div>'
      : libraryEmpty('↓', 'No saved albums', 'Use the ↓ button on any album to save it to your library.');
    const local = MV.localSongs.length
      ? '<div class="song-list">' + MV.localSongs.map((song, i) => songRow(song, i)).join('') + '</div>'
      : libraryEmpty('⌁', 'No local songs found', 'Choose your music folder from Settings to scan your collection.');

    const panel = el('library-panel');
    if (filter === 'all') {
      panel.innerHTML = librarySection('Playlists', '<div class="grid-rail">' + playlists + '</div>') +
        librarySection('Liked songs', liked) +
        librarySection('Albums', saved) +
        librarySection('Downloads', local);
    } else if (view === 'playlists') {
      panel.innerHTML = '<div class="grid-rail">' + playlists + '</div>';
    } else if (view === 'liked') {
      panel.innerHTML = liked;
    } else if (view === 'saved') {
      panel.innerHTML = saved;
    } else {
      panel.innerHTML = local;
    }
  }

  function renderPlaylistDetail() {
    const playlist = MV.store.getPlaylist(MV.currentPlaylistId);
    if (!playlist) { navigate('library'); return; }
    const cover = el('playlist-head-cover');
    cover.innerHTML = playlist.cover ? image(playlist.cover, playlist.name, false, playlist, 'playlist') : '♪';
    cover.style.backgroundImage = playlist.cover ? 'none' : '';
    el('playlist-head-title').textContent = playlist.name;
    const playlistSource = playlist.source === 'spotify' ? 'Imported from Spotify' : 'Created on this device';
    el('playlist-head-meta').textContent = playlist.songs.length + ' songs · ' + playlistSource;
    el('playlist-songs').innerHTML = playlist.songs.length
      ? playlist.songs.map((song, i) => songRow(song, i, { inPlaylist: true })).join('')
      : '<div class="empty-state"><span class="empty-state__icon">♪</span><h3>This playlist is empty</h3><p>Tap + to add songs from what you play and love.</p></div>';
    renderSpotifyShelf('playlist', spotifySeedsForPlaylist());
  }

  function openPlaylist(id) {
    MV.currentPlaylistId = id;
    renderPlaylistDetail();
    navigate('playlist');
  }

  /* ---------------- modals ---------------- */

  function openCreatePlaylist() {
    let cover = null;
    openModal(
      '<p class="eyebrow">A NEW COLLECTION</p><h2>Create playlist</h2><p>Give it a name and, if you like, a cover from your computer.</p>' +
      '<label class="field-label" for="playlist-name">Playlist name</label>' +
      '<input type="text" id="playlist-name" maxlength="60" placeholder="Late night drive">' +
      '<div class="cover-picker"><div class="cover-picker__preview" id="new-cover-preview">♪</div>' +
      '<div><strong>Cover art · optional</strong><small>Choose an image from your PC</small>' +
      '<button class="btn btn--outline" id="new-pick-cover" style="margin-top:10px">Browse files…</button></div></div>' +
      '<div class="modal__actions"><button class="btn btn--outline" data-modal="cancel">Cancel</button>' +
      '<button class="btn btn--dark" data-modal="create">Create playlist</button></div>',
      (root) => {
        root.querySelector('[data-modal="cancel"]').onclick = closeModal;
        root.querySelector('#new-pick-cover').onclick = () => el('cover-file').click();
        root.querySelector('[data-modal="create"]').onclick = async () => {
          const name = root.querySelector('#playlist-name').value;
          if (!name.trim()) { toast('Give your playlist a name first.'); return; }
          closeModal();
          const playlist = await MV.api.createPlaylist(name, cover);
          if (playlist) { openPlaylist(playlist.id); renderLibrary(); toast('Playlist created.'); }
        };
        coverCallback = (dataUrl) => {
          cover = dataUrl;
          const preview = el('new-cover-preview');
          if (preview) preview.innerHTML = image(dataUrl, 'Cover');
        };
      }
    );
  }

  function playlistEditModal(playlist) {
    let cover = playlist.cover || '';
    openModal(
      '<p class="eyebrow">EDIT PLAYLIST</p><h2>Playlist details</h2>' +
      '<label class="field-label" for="playlist-edit-name">Name</label>' +
      '<input type="text" id="playlist-edit-name" maxlength="60" value="' + esc(playlist.name) + '">' +
      '<div class="cover-picker"><div class="cover-picker__preview" id="playlist-edit-cover">' +
      (cover ? image(cover, playlist.name, false, playlist, 'playlist') : '♪') + '</div>' +
      '<div><strong>Cover art</strong><small>Choose a new image from your PC</small>' +
      '<button class="btn btn--outline" id="playlist-edit-pick" style="margin-top:10px">Browse files…</button></div></div>' +
      '<div class="modal__actions"><button class="btn btn--outline" data-modal="cancel">Cancel</button>' +
      '<button class="btn btn--dark" data-modal="save">Save changes</button></div>',
      (root) => {
        root.querySelector('[data-modal="cancel"]').onclick = closeModal;
        root.querySelector('#playlist-edit-pick').onclick = () => coverPicker(cover, (dataUrl) => {
          cover = dataUrl;
          const preview = root.querySelector('#playlist-edit-cover');
          if (preview) preview.innerHTML = image(dataUrl, 'Cover');
        });
        root.querySelector('[data-modal="save"]').onclick = async () => {
          const name = root.querySelector('#playlist-edit-name').value.trim();
          if (!name) { toast('Give your playlist a name first.'); return; }
          await MV.api.renamePlaylist(playlist.id, name);
          if (cover !== (playlist.cover || '')) await MV.api.setPlaylistCover(playlist.id, cover);
          closeModal();
          renderLibrary();
          if (MV.currentPlaylistId === playlist.id) renderPlaylistDetail();
          toast('Playlist updated.');
        };
      }
    );
  }

  function playlistMenu(playlist) {
    openModal(
      '<p class="eyebrow">PLAYLIST OPTIONS</p><h2>' + esc(playlist.name) + '</h2><p>Make this collection yours.</p>' +
      '<div class="account-actions" style="margin-top:18px">' +
      '<button class="btn btn--outline" data-pm="edit">Edit playlist · name & cover</button>' +
      '<button class="btn btn--danger-ghost" data-pm="delete">Delete playlist</button></div>' +
      '<div class="modal__actions"><button class="btn btn--dark" data-modal="done">Done</button></div>',
      (root) => {
        root.querySelector('[data-modal="done"]').onclick = closeModal;
        root.querySelector('[data-pm="edit"]').onclick = () => {
          closeModal();
          playlistEditModal(MV.store.getPlaylist(playlist.id) || playlist);
        };
        root.querySelector('[data-pm="delete"]').onclick = () => {
          closeModal();
          confirmModal('Delete playlist?', '“' + playlist.name + '” and its songs will be removed from this device.', 'Delete', async () => {
            await MV.api.deletePlaylist(playlist.id);
            if (MV.currentPlaylistId === playlist.id) MV.currentPlaylistId = null;
            renderLibrary();
            toast('Playlist deleted.');
          });
        };
      }
    );
  }

  function suggestionKey(song) {
    return String(song && (song.id || ((song.title || '') + '|' + (song.artist || '')))).toLowerCase();
  }

  function resolveSuggestionSong(entry) {
    if (!entry || typeof entry !== 'object') return null;
    if (entry.id) {
      const byId = D.getSong && D.getSong(entry.id);
      if (byId) return byId;
      const album = D.getAlbum && D.getAlbum(entry.id);
      if (album) {
        const fromAlbum = D.songs.find((song) => song.album === album.title && song.artist === album.artist) ||
          D.songs.find((song) => song.album === album.title);
        if (fromAlbum) return fromAlbum;
      }
    }
    const title = String(entry.title || '').trim();
    if (!title) return null;
    if (entry.artist && (entry.path || entry.id)) return D.normalizeTrack ? D.normalizeTrack(entry) : entry;
    const local = D.searchLocal(title + (entry.artist ? ' ' + entry.artist : '')).results[0];
    if (local) return local;
    const pools = [MV.localSongs, MV.discoverData && MV.discoverData.trending];
    for (const pool of pools) {
      if (!Array.isArray(pool)) continue;
      const match = pool.find((song) => String(song.id) === String(entry.id) ||
        (String(song.title || '').toLowerCase() === title.toLowerCase() &&
          (!entry.artist || String(song.artist || '').toLowerCase() === String(entry.artist).toLowerCase())));
      if (match) return match;
    }
    return null;
  }

  function suggestedSongsForPlaylist(playlist) {
    const state = MV.store.state;
    const found = new Map();
    const add = (entry, score) => {
      const song = resolveSuggestionSong(entry);
      if (!song || listContains(playlist.songs, song)) return;
      const key = suggestionKey(song);
      const previous = found.get(key);
      if (!previous || score > previous.score) found.set(key, { song: song, score: score });
    };

    (state.liked || []).slice().reverse().forEach((song, index) => add(song, 40 - index * 0.4));
    (state.recentlyPlayed || []).forEach((entry, index) => add(entry, 30 - index * 0.7));
    (state.playEvents || []).slice(-120).reverse().forEach((entry, index) => add(entry, 20 - index * 0.1));
    const trending = (MV.discoverData && MV.discoverData.trending) || [];
    trending.slice(0, 30).forEach((song, index) => add(song, 10 - index * 0.1));
    D.songs.slice(0, 40).forEach((song, index) => add(song, 5 - index * 0.05));

    return Array.from(found.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 18)
      .map((item) => item.song);
  }

  function playlistAddSongsModal(playlist) {
    const live = MV.store.getPlaylist(playlist.id) || playlist;
    const suggestions = suggestedSongsForPlaylist(live);
    openModal(
      '<p class="eyebrow">ADD SONGS</p><h2>Add to ' + esc(live.name) + '</h2>' +
      '<p>Picked from your listening activity and liked songs.</p>' +
      (suggestions.length
        ? '<div class="suggestion-list" id="playlist-suggestions">' + suggestions.map((song, index) => {
          const key = ref(song);
          return '<div class="suggestion-item">' +
            '<span class="suggestion-item__art">' + image(song.cover, song.title, false, song, 'song') + '</span>' +
            '<span class="suggestion-item__copy"><strong>' + esc(song.title) + '</strong>' +
            '<span>' + esc(song.artist) + '</span></span>' +
            '<button class="suggestion-item__add" data-add-song="' + key + '" aria-label="Add ' + esc(song.title) + '" title="Add song">+</button>' +
            '</div>';
        }).join('') + '</div>'
        : '<p class="field-note">No suggestions yet. Play a few songs or like something first.</p>') +
      '<div class="modal__actions"><button class="btn btn--dark" data-modal="done">Done</button></div>',
      (root) => {
        root.querySelector('[data-modal="done"]').onclick = () => {
          closeModal();
          renderPlaylistDetail();
          renderLibrary();
        };
        root.querySelectorAll('[data-add-song]').forEach((button) => {
          button.onclick = async () => {
            const song = registry[button.dataset.addSong];
            const current = MV.store.getPlaylist(live.id) || live;
            const added = await MV.api.addToPlaylist(current, song);
            if (added) {
              button.disabled = true;
              button.textContent = '✓';
              toast('Added to ' + current.name);
            } else {
              toast('Already in that playlist.');
            }
          };
        });
      }
    );
  }

  function addToPlaylistModal(song) {
    const playlists = MV.store.state.playlists;
    openModal(
      '<p class="eyebrow">ADD TO COLLECTION</p><h2>Add to playlist</h2><p>' + esc(song.title) + '</p>' +
      (playlists.length
        ? '<div class="account-actions" style="margin-top:16px">' + playlists.map((playlist) =>
          '<button class="btn btn--outline" data-pl="' + esc(playlist.id) + '">' + esc(playlist.name) + '</button>').join('') + '</div>'
        : '<p>You have no playlists yet.</p>') +
      '<div class="modal__actions"><button class="btn btn--outline" data-modal="cancel">Cancel</button>' +
      '<button class="btn btn--dark" data-modal="new">＋ New playlist</button></div>',
      (root) => {
        root.querySelector('[data-modal="cancel"]').onclick = closeModal;
        root.querySelector('[data-modal="new"]').onclick = () => { closeModal(); openCreatePlaylist(); };
        root.querySelectorAll('[data-pl]').forEach((button) => {
          button.onclick = async () => {
            const playlist = MV.store.getPlaylist(button.dataset.pl);
            const added = await MV.api.addToPlaylist(playlist, song);
            closeModal();
            renderLibrary();
            toast(added ? 'Added to ' + playlist.name : 'Already in that playlist.');
          };
        });
      }
    );
  }

  function hasPendingSpotifyImport() {
    try { return sessionStorage.getItem(PENDING_SPOTIFY_IMPORT_KEY) === '1'; }
    catch (error) { return false; }
  }

  function clearPendingSpotifyImport() {
    try { sessionStorage.removeItem(PENDING_SPOTIFY_IMPORT_KEY); } catch (error) { /* storage disabled */ }
  }

  function maybeResumeSpotifyImport(status) {
    if (!hasPendingSpotifyImport()) return;
    if (!status || !status.connected || !status.canImportPlaylists) return;
    clearPendingSpotifyImport();
    setTimeout(() => openSpotifyImportModal(), 0);
  }

  async function openSpotifyImportModal() {
    const spotify = MV.spotify ? MV.spotify.status() : null;
    if (!spotify || !spotify.configured) {
      toast('Add your Spotify Client ID in Spotify Catalogue first.');
      navigate('account');
      return;
    }
    if (!spotify.connected || !spotify.canImportPlaylists) {
      try {
        // The PKCE redirect returns to this page; remember why we left so the
        // import picker opens automatically once playlist scope is granted.
        try { sessionStorage.setItem(PENDING_SPOTIFY_IMPORT_KEY, '1'); } catch (error) { /* storage disabled */ }
        await MV.spotify.connect();
      } catch (error) {
        clearPendingSpotifyImport();
        toast(error.message || 'Could not open Spotify sign-in.');
      }
      return;
    }

    const cap = spotify.maxImportTracks || 500;
    openModal(
      '<p class="eyebrow">SPOTIFY CATALOGUE</p><h2>Import a playlist</h2>' +
      '<p>Choose one of your Spotify playlists. Up to ' + cap + ' tracks are copied to this device with their names, covers and metadata.</p>' +
      '<p class="field-note">Audio is still resolved to full-length JioSaavn at play time. Spotify previews are never used.</p>' +
      '<p class="field-note">Spotify only permits importing playlists you own or collaborate on. Make a copy in Spotify first if a playlist belongs to someone else.</p>' +
      '<div class="spotify-import-list" id="spotify-import-list"><p class="field-note">Loading your playlists…</p></div>' +
      '<p class="field-note" id="spotify-import-status"></p>' +
      '<div class="modal__actions"><button class="btn btn--outline" data-modal="cancel">Cancel</button></div>',
      (root) => {
        const list = root.querySelector('#spotify-import-list');
        const statusNode = root.querySelector('#spotify-import-status');
        root.querySelector('[data-modal="cancel"]').onclick = closeModal;

        MV.spotify.userPlaylists().then((playlists) => {
          if (!root.isConnected) return;
          if (!playlists.length) {
            const reason = MV.spotify.lastCatalogError && MV.spotify.lastCatalogError();
            list.innerHTML = '<p class="field-note">' + esc(reason ||
              'No playlists were returned. Reconnect with playlist access enabled, or add a playlist in Spotify first.') + '</p>';
            return;
          }
          list.innerHTML = playlists.map((playlist, index) => {
            const existing = MV.store.getPlaylist(playlist.id);
            return '<button class="spotify-import-item" data-index="' + index + '">' +
              '<span class="spotify-import-item__copy"><strong>' + esc(playlist.name) + '</strong>' +
              '<small>' + playlist.trackCount + ' tracks' + (playlist.owner ? ' · ' + esc(playlist.owner) : '') + '</small></span>' +
              '<span class="spotify-import-item__flag">' + (existing ? 'Update' : 'Import') + '</span></button>';
          }).join('');
          list.querySelectorAll('[data-index]').forEach((button) => {
            button.onclick = async () => {
              const playlist = playlists[Number(button.dataset.index)];
              if (!playlist) return;
              statusNode.textContent = 'Importing “' + playlist.name + '”…';
              list.querySelectorAll('button').forEach((node) => { node.disabled = true; });
              const tracks = await MV.spotify.playlistTracks(playlist.spotifyId || playlist.id, cap);
              if (!tracks.length) {
                const code = MV.spotify.lastPlaylistStatus && MV.spotify.lastPlaylistStatus();
                const detail = MV.spotify.lastPlaylistError && MV.spotify.lastPlaylistError();
                statusNode.textContent = detail
                  ? 'Spotify could not import that playlist: ' + detail
                  : 'No playable tracks were returned. Local files and episodes are skipped.';
                if (code === 403) {
                  button.disabled = true;
                  const flag = button.querySelector('.spotify-import-item__flag');
                  if (flag) flag.textContent = 'Not available';
                } else {
                  list.querySelectorAll('button').forEach((node) => { node.disabled = false; });
                }
                return;
              }
              // Keep enough Spotify metadata locally to resolve full-length
              // JioSaavn audio after reload, even if the user disconnects.
              if (MV.webApi && MV.webApi.rememberSpotify) MV.webApi.rememberSpotify(tracks);
              let stored = MV.store.getPlaylist(playlist.id);
              if (stored) {
                MV.store.renamePlaylist(playlist.id, playlist.name);
                MV.store.setPlaylistCover(playlist.id, playlist.cover || '');
              } else {
                stored = MV.store.createPlaylist(playlist.name, playlist.cover || '', playlist.id);
              }
              if (!stored) {
                statusNode.textContent = 'Could not save this playlist locally.';
                list.querySelectorAll('button').forEach((node) => { node.disabled = false; });
                return;
              }
              MV.store.setPlaylistMeta(playlist.id, {
                source: 'spotify',
                spotifyId: playlist.spotifyId,
                spotifyUrl: playlist.spotifyUrl,
                description: String(playlist.description || '').slice(0, 240),
                owner: playlist.owner,
                importedAt: Date.now()
              });
              MV.store.setPlaylistSongs(playlist.id, tracks);
              statusNode.textContent = 'Imported ' + tracks.length + ' tracks. Opening your playlist…';
              toast('Imported ' + playlist.name);
              setTimeout(() => {
                closeModal();
                renderLibrary();
                openPlaylist(playlist.id);
              }, 420);
            };
          });
        }).catch((error) => {
          if (!root.isConnected) return;
          list.innerHTML = '<p class="field-note">' + esc((error && error.message) ||
            'Spotify playlists could not be loaded. Reconnect and try again.') + '</p>';
        });
      }
    );
  }

  function songMenu(song, inPlaylist) {
    const liked = MV.store.isLiked(song.id);
    openModal(
      '<p class="eyebrow">SONG OPTIONS</p><h2>' + esc(song.title) + '</h2><p>' + esc(song.artist) + '</p>' +
      '<div class="account-actions" style="margin-top:18px">' +
      '<button class="btn btn--outline" data-sm="play">▶ Play now</button>' +
      '<button class="btn btn--outline" data-sm="queue">＋ Add to queue</button>' +
      '<button class="btn btn--outline" data-sm="like">' + (liked ? '♥ Remove from Liked' : '♡ Add to Liked') + '</button>' +
      '<button class="btn btn--outline" data-sm="playlist">≋ Add to playlist</button>' +
      '<button class="btn btn--outline" data-sm="save">↓ Save album to library</button>' +
      (inPlaylist ? '<button class="btn btn--danger-ghost" data-sm="remove">× Remove from this playlist</button>' : '') + '</div>' +
      '<div class="modal__actions"><button class="btn btn--dark" data-modal="done">Done</button></div>',
      (root) => {
        root.querySelector('[data-modal="done"]').onclick = closeModal;
        root.querySelector('[data-sm="play"]').onclick = () => { closeModal(); MV.player.play(song); };
        root.querySelector('[data-sm="queue"]').onclick = () => { closeModal(); MV.player.enqueue(song); };
        root.querySelector('[data-sm="like"]').onclick = async () => {
          closeModal();
          await MV.api.toggleLike(song);
          updateLikeButtons(song, null, false);
          const likedCount = el('liked-count');
          if (likedCount) likedCount.textContent = MV.store.state.liked.length + ' songs';
        };
        root.querySelector('[data-sm="playlist"]').onclick = () => { closeModal(); addToPlaylistModal(song); };
        root.querySelector('[data-sm="save"]').onclick = () => {
          closeModal(); doSaveAlbum({ id: 'album-' + D.hash(song.album || song.title), title: song.album || song.title, artist: song.artist, cover: song.cover });
        };
        const remove = root.querySelector('[data-sm="remove"]');
        if (remove) remove.onclick = async () => {
          closeModal();
          await MV.api.removeFromPlaylist(MV.store.getPlaylist(MV.currentPlaylistId), song.id);
          renderPlaylistDetail(); renderLibrary();
          toast('Removed from playlist.');
        };
      }
    );
  }

  /* ---------------- actions ---------------- */

  async function doSaveAlbum(album) {
    if (!album) return;
    if (MV.store.isAlbumSaved(album)) {
      await MV.api.removeSavedAlbum(album);
      toast('Removed from saved albums.');
    } else {
      await MV.api.saveAlbum(album);
      toast('Album saved to your library.');
    }
    renderAll();
  }

  async function doPlayArtist(artist) {
    const tracks = await MV.api.artistTracks(artist);
    if (!tracks.length) { toast('No playable tracks found for this artist.'); return; }
    MV.player.play(tracks[0], tracks);
  }

  /* ---------------- album overview + generated mixes ---------------- */

  function uniqueItems(items, key) {
    const seen = new Set();
    const result = [];
    (items || []).forEach((item) => {
      if (!item) return;
      const value = String(key(item) || '');
      if (!value || seen.has(value)) return;
      seen.add(value);
      result.push(item);
    });
    return result;
  }

  function itemKey(item) {
    return String(item && (item.id || item.title || item.name) || '').toLowerCase();
  }

  function rememberAlbumReturn() {
    const activePage = document.querySelector('.page.is-active');
    MV.albumReturnPage = (activePage && activePage.dataset.page) || 'home';
    if (MV.albumReturnPage === 'album') MV.albumReturnPage = 'home';
  }

  function showGeneratedAlbum(album, tracks, albums, message) {
    MV.albumState = { album, tracks: tracks || [], albums: albums || [], busy: false };
    el('album-head-cover').innerHTML = image(album.cover, album.title || 'Album', false, album, 'album');
    el('album-head-title').textContent = album.title || 'Album';
    el('album-head-meta').textContent = 'Building your collection…';
    navigate('album');
    renderAlbum();
    if (message) toast(message);
  }

  async function collectSearchResults(queries, kind) {
    const responses = await Promise.all(queries.filter(Boolean).map((query) =>
      MV.api.search(query).catch(() => null)));
    const collected = [];
    responses.forEach((response) => {
      if (response && Array.isArray(response[kind])) collected.push.apply(collected, response[kind]);
    });
    return collected;
  }

  async function collectMixTracks(seeds, queries) {
    const found = await collectSearchResults(queries, 'songs');
    const fallback = (MV.discoverData && MV.discoverData.trending) || D.songs;
    return uniqueItems([].concat(seeds || [], found, fallback), itemKey).slice(0, 50);
  }

  async function openSongMix(song) {
    if (!song) return;
    rememberAlbumReturn();
    const queries = [
      [song.title, song.artist].filter(Boolean).join(' '),
      song.artist,
      song.album ? [song.album, song.artist].filter(Boolean).join(' ') : '',
      song.language ? String(song.language) + ' hits' : 'trending songs'
    ];
    const tracks = await collectMixTracks([song], queries);
    const album = {
      id: 'songmix-' + String(song.id || D.hash(song.title)).replace(/\W/g, ''),
      title: (song.album || song.title) + ' Mix',
      artist: song.artist || 'MusicVer Mix',
      cover: song.cover,
      kind: 'mix',
      generated: true
    };
    showGeneratedAlbum(album, tracks, [], 'Built a ' + tracks.length + '-song mix around ' + song.title + '.');
  }

  async function openLanguageMix(language) {
    const name = language || 'Hindi';
    rememberAlbumReturn();
    const queries = [
      name + ' hits',
      'top ' + name + ' songs',
      name + ' songs 2026',
      name === 'Hindi' ? 'bollywood hits' : 'english chart hits'
    ];
    const tracks = await collectMixTracks(languageShelf(name), queries);
    const album = {
      id: 'languagemix-' + name.toLowerCase(),
      title: name + ' Hits · 50 Songs',
      artist: 'MusicVer Mix',
      cover: tracks[0] && tracks[0].cover,
      language: name,
      kind: 'mix',
      generated: true
    };
    showGeneratedAlbum(album, tracks, [], name + ' mix ready with ' + tracks.length + ' full-length songs.');
  }

  async function openTrendingMix() {
    rememberAlbumReturn();
    const seeds = (MV.discoverData && MV.discoverData.trending) ? MV.discoverData.trending.slice(0, 20) : D.songs.slice(0, 12);
    const tracks = await collectMixTracks(seeds, ['top songs', 'trending hits', 'jiosaavn top charts']);
    const album = {
      id: 'trendingmix',
      title: 'Trending Now · 50 Songs',
      artist: 'Live chart mix',
      cover: seeds[0] && seeds[0].cover,
      kind: 'mix',
      generated: true
    };
    showGeneratedAlbum(album, tracks, [], 'Live chart mix ready with ' + tracks.length + ' songs.');
  }

  async function openAlbumCatalog(seedAlbum) {
    const albumSeed = seedAlbum || (MV.discoverData && MV.discoverData.albums && MV.discoverData.albums[0]) || D.albums[0];
    if (!albumSeed) return;
    rememberAlbumReturn();
    const queries = [
      [albumSeed.title, albumSeed.artist].filter(Boolean).join(' '),
      albumSeed.artist ? String(albumSeed.artist) + ' albums' : 'new albums',
      albumSeed.language ? String(albumSeed.language) + ' albums' : 'top albums',
      'popular albums',
      'new album releases',
      'top albums 2026',
      'bollywood albums',
      'pop albums'
    ];
    const found = await collectSearchResults(queries, 'albums');
    const songAlbums = D.songs.map((song) => ({
      id: 'album-' + D.hash(song.album || song.title),
      title: song.album || song.title,
      artist: song.artist,
      cover: song.cover,
      language: song.language
    }));
    const bundledAlbums = Object.keys((MV.webJioCatalog && MV.webJioCatalog.albums) || {}).map((key) => {
      const record = MV.webJioCatalog.albums[key];
      const firstTrack = MV.webJioCatalog.entries[String((record.tracks || [])[0])];
      return {
        id: record.id || D.hash(record.title),
        title: record.title,
        artist: record.artist,
        cover: firstTrack && firstTrack.cover ? firstTrack.cover : '',
        language: 'Hindi',
        tracks: record.tracks || []
      };
    });
    const albumIdentity = (item) => String((item && (item.title || item.name)) || '').toLowerCase() + '|' + String((item && item.artist) || '').toLowerCase();
    const albums = uniqueItems([].concat(
      [albumSeed],
      found,
      (MV.discoverData && MV.discoverData.albums) || [],
      bundledAlbums,
      D.albums,
      songAlbums
    ), albumIdentity).slice(0, 50);
    const album = {
      id: 'albumcatalog-' + String(albumSeed.id || D.hash(albumSeed.title)).replace(/\W/g, ''),
      title: 'Album Catalog · 50 Picks',
      artist: 'Curated from JioSaavn',
      cover: albumSeed.cover,
      kind: 'albumCatalog',
      generated: true
    };
    showGeneratedAlbum(album, [], albums, 'Album catalog ready with ' + albums.length + ' records.');
  }

  async function openAlbum(album, returnPage) {
    if (!album) return;
    const token = ++albumToken;
    const activePage = document.querySelector('.page.is-active');
    MV.albumReturnPage = returnPage || (activePage && activePage.dataset.page) || 'home';
    if (MV.albumReturnPage === 'album') MV.albumReturnPage = 'home';
    MV.albumState = { album, tracks: [], albums: [], busy: true };

    el('album-head-cover').innerHTML = image(album.cover, album.title || 'Album', false, album, 'album');
    el('album-head-title').textContent = album.title || 'Album';
    el('album-head-meta').textContent = 'Loading tracks…';
    el('album-songs').innerHTML = '<div class="skeleton" style="height:62px;margin-bottom:6px"></div>' +
      '<div class="skeleton" style="height:62px;margin-bottom:6px"></div>';
    navigate('album');

    const tracks = await MV.api.albumTracks(album);
    if (token !== albumToken || !MV.albumState) return;
    MV.albumState.tracks = tracks || [];
    MV.albumState.busy = false;
    renderAlbum();
    blurIn(el('album-songs'));
  }

  function renderAlbum() {
    const state = MV.albumState;
    if (!state || !state.album) return;
    const album = state.album;
    const tracks = state.tracks || [];
    const albums = state.albums || [];
    const isCatalog = album.kind === 'albumCatalog';
    const playButton = el('album-play');
    const saveButton = el('album-save');
    const note = el('album-note');

    if (playButton) playButton.hidden = isCatalog;
    if (saveButton) saveButton.hidden = isCatalog;
    if (note) note.textContent = isCatalog
      ? 'Browse the catalog, then open any record for its full track list.'
      : 'Read-only collection · the title and cover come from the catalogue.';

    renderSpotifyShelf('album', spotifySeedsForAlbum());
    el('album-head-cover').innerHTML = image(album.cover, album.title || 'Album', false, album, 'album');
    el('album-head-title').textContent = album.title || 'Album';
    el('album-head-meta').textContent = state.busy
      ? 'Loading tracks…'
      : isCatalog
        ? albums.length + ' albums · catalog · full-length playback'
        : tracks.length + ' songs · ' + (album.artist || 'Unknown artist') + ' · Read-only album';

    if (isCatalog) {
      el('album-songs').innerHTML = albums.length
        ? '<div class="album-grid">' + albums.map((item) =>
            mediaCard(item, 'album', { spotify: true, action: 'open-album', glyph: '↗' })).join('') + '</div>'
        : '<div class="empty-state"><span class="empty-state__icon">▤</span><h3>No albums found</h3><p>Try opening a catalog from another album.</p></div>';
      return;
    }

    el('album-songs').innerHTML = tracks.length
      ? tracks.map((song, i) => songRow(song, i)).join('')
      : '<div class="empty-state"><span class="empty-state__icon">♪</span><h3>No tracks found</h3><p>This album has no playable tracks in the current catalogue.</p></div>';

    if (saveButton) {
      const saved = MV.store.isAlbumSaved(album);
      // Keep this control icon-only: the compact album header has no room for
      // long button labels.
      saveButton.innerHTML = '<span>' + (saved ? '✓' : '↓') + '</span>';
      saveButton.setAttribute('aria-label', saved ? 'Saved to library' : 'Save album');
      saveButton.setAttribute('title', saved ? 'Saved to library' : 'Save album');
      saveButton.classList.toggle('is-on', saved);
      saveButton.setAttribute('aria-pressed', String(saved));
    }
  }

  /* ---------------- artist detail ---------------- */

  async function openArtist(artist) {
    if (!artist) return;
    const token = ++artistToken;
    const name = artist.name || artist.title || 'Artist';
    MV.artistState = {
      artist,
      details: null,
      songs: [],
      page: 0,
      hasMore: false,
      busy: true
    };

    el('artist-hero').innerHTML =
      '<div class="artist-hero__placeholder">Loading ' + esc(name) + '…</div>';
    el('artist-songs').innerHTML = '';
    el('artist-load-more').hidden = true;
    ['artist-albums', 'artist-singles', 'artist-similar', 'artist-playlists'].forEach((id) => {
      if (el(id)) el(id).innerHTML = '';
    });
    ['artist-singles-block', 'artist-similar-block', 'artist-playlists-block'].forEach((id) => {
      if (el(id)) el(id).hidden = true;
    });
    navigate('artist');

    const details = await MV.api.artistDetails(artist, 0);
    if (token !== artistToken || !MV.artistState) return;

    MV.artistState.details = details;
    MV.artistState.songs = (details && details.songs ? details.songs : []).slice();
    MV.artistState.hasMore = Boolean(details && details.songs && details.songs.length >= 20);
    MV.artistState.busy = false;
    renderArtist();
    blurIn(el('artist-songs'));
  }

  function renderArtist() {
    const state = MV.artistState;
    if (!state || !state.details) return;
    const details = state.details;
    const artist = details.artist || state.artist || {};
    const name = artist.name || artist.title || state.artist.name || 'Artist';
    const verified = Boolean((artist.raw && artist.raw.verified) || artist.verified);
    const listeners = formatListeners(artist.listeners || (state.artist && state.artist.listeners));
    const bio = details.bio || "Explore this artist's releases, popular songs and similar artists below.";

    el('artist-hero').innerHTML =
      '<div class="artist-hero__portrait">' +
      image(artist.cover || state.artist.cover, name, true, artist, 'artist', true) +
      '<p class="artist-hero__note"><span>IN FOCUS</span>' +
      'A closer look at the songs, releases and sound behind ' + esc(name) + '.</p>' +
      '</div>' +
      '<div class="artist-hero__copy">' +
      '<p class="eyebrow">ARTIST PROFILE' + (verified ? ' · VERIFIED' : '') + '</p>' +
      '<h1 class="artist-hero__name">' + esc(name) + '</h1>' +
      '<div class="artist-hero__meta"><span>' + esc(listeners) + '</span>' +
      (verified ? '<span class="artist-hero__verified">✓ Verified artist</span>' : '') + '</div>' +
      '<p class="artist-hero__bio">' + esc(bio) + '</p>' +
      '<div class="artist-hero__actions">' +
      '<button class="btn btn--dark" id="artist-hero-play"><span>▶</span> Play popular</button>' +
      '<button class="btn btn--outline" id="artist-hero-queue">＋ Queue popular</button>' +
      '</div></div>';
    el('artist-hero').querySelectorAll('img').forEach((img) => img.classList.add('artist-hero__cover'));

    const heroPlay = el('artist-hero-play');
    if (heroPlay) heroPlay.onclick = () => {
      if (state.songs.length) MV.player.play(state.songs[0], state.songs);
      else toast('No popular songs found for this artist.');
    };
    const heroQueue = el('artist-hero-queue');
    if (heroQueue) heroQueue.onclick = () => {
      state.songs.slice(0, 10).forEach((song) => MV.player.enqueue(song));
    };

    el('artist-songs').innerHTML = state.songs.length
      ? state.songs.map((song, i) => songRow(song, i)).join('')
      : '<div class="empty-state"><span class="empty-state__icon">♫</span><h3>No popular songs found</h3><p>Try loading more or choose another artist.</p></div>';
    const loadButton = el('artist-load-more');
    loadButton.hidden = state.busy || !state.hasMore;
    loadButton.textContent = state.busy ? 'Loading…' : 'Load more songs ↓';

    const albums = details.albums || [];
    el('artist-albums').innerHTML = albums.length
      ? albums.map((album) => mediaCard(album, 'album')).join('')
      : '<p class="empty-state" style="padding:22px">No albums listed.</p>';

    const singles = details.singles || [];
    el('artist-singles-block').hidden = !singles.length;
    el('artist-singles').innerHTML = singles.map((album) => mediaCard(album, 'album')).join('');

    const similar = details.similar || [];
    el('artist-similar-block').hidden = !similar.length;
    el('artist-similar').innerHTML = similar.map((item) => artistRow(item, 0)).join('');

    const playlists = details.playlists || [];
    el('artist-playlists-block').hidden = !playlists.length;
    el('artist-playlists').innerHTML = playlists.map((item) => mediaCard(item, 'album')).join('');
    renderSpotifyShelf('artist', spotifySeedsForArtist());
  }

  async function loadMoreArtistSongs() {
    const state = MV.artistState;
    if (!state || !state.details || state.busy || !state.hasMore) return;
    state.busy = true;
    renderArtist();

    state.page += 1;
    const more = await MV.api.moreArtistSongs(state.artist, state.page, 20);
    const seen = new Set(state.songs.map((song) => String(song.id)));
    const fresh = more.filter((song) => !seen.has(String(song.id)));
    state.songs = state.songs.concat(fresh);
    state.hasMore = more.length >= 20;
    state.busy = false;
    renderArtist();
    toast(fresh.length ? fresh.length + ' more songs loaded.' : 'No more songs to show.');
  }

  function doPlayRecent(entry) {
    if (entry.type === 'album') {
      openAlbum(entry, 'home');
      return;
    }
    const song = D.getSong(entry.id) || {
      id: entry.id, title: entry.title, artist: entry.subtitle, cover: entry.cover, duration: 0
    };
    MV.player.play(song);
  }

  /* ---------------- player + flow ---------------- */

  function updatePlayer(snap) {
    const player = el('player');
    player.classList.toggle('is-playing', snap.playing);
    const track = snap.current;
    const cover = el('player-cover');
    cover.innerHTML = track ? image(track.cover, track.title, false, track, 'song', true) : '♪';
    el('player-title').textContent = track ? track.title : 'Nothing playing';
    el('player-artist').textContent = track ? track.artist : 'Choose a song to begin';
    el('main-play').textContent = snap.playing ? '❚❚' : '▶';
    el('main-play').setAttribute('aria-label', snap.playing ? 'Pause' : 'Play');

    const liked = Boolean(track && MV.store.isLiked(track.id));
    const like = el('player-like');
    like.textContent = liked ? '♥' : '♡';
    like.classList.toggle('is-on', liked);
    like.classList.toggle('is-liked', liked);
    like.setAttribute('aria-pressed', String(liked));

    const album = MV.player.currentAlbum();
    const saved = Boolean(album && MV.store.isAlbumSaved(album));
    const save = el('player-save');
    save.classList.toggle('is-on', saved);
    save.setAttribute('aria-pressed', String(saved));
    save.title = saved ? 'Remove album from saved' : 'Save album to library';

    el('shuffle').classList.toggle('is-on', snap.shuffle);
    const repeat = el('repeat');
    if (repeat) {
      repeat.classList.toggle('is-on', snap.repeat !== 'off');
      repeat.textContent = snap.repeat === 'one' ? '↻¹' : '↻';
      repeat.title = 'Repeat: ' + snap.repeat;
    }

    el('volume').value = String(snap.volume);
    el('volume').style.setProperty('--vol', snap.volume + '%');
    el('volume-icon').textContent = snap.volume === 0 ? '◖' : '◖';

    renderQueue(snap);
    updateProgress(snap);
    renderFlow(snap);
  }

  function updateProgress(snap) {
    const ratio = snap.duration ? Math.min(1, snap.elapsed / snap.duration) : 0;
    const pct = (ratio * 100).toFixed(2) + '%';
    el('seek-fill').style.width = pct;
    el('seek-knob').style.left = pct;
    el('seek').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    const playerProgress = el('player-progress');
    if (playerProgress) {
      el('player-progress-fill').style.width = pct;
      playerProgress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    }
    el('current-time').textContent = fmt(snap.elapsed);
    el('total-time').textContent = fmt(snap.duration);
    if (MV.lyrics) MV.lyrics.sync(snap);

    el('flow-progress-fill').style.width = pct;
    el('flow-progress-knob').style.left = pct;
    el('flow-current').textContent = fmt(snap.elapsed);
    el('flow-total').textContent = fmt(snap.duration);
  }

  function renderQueue(snap) {
    const list = el('queue-list');
    const now = el('queue-now');
    const count = el('queue-count');

    if (count) count.textContent = snap.queue.length + (snap.queue.length === 1 ? ' song' : ' songs');

    if (now) {
      if (snap.current) {
        now.innerHTML =
          '<div class="queue-now__art">' + (snap.current.cover ? image(snap.current.cover, snap.current.title, false, snap.current, 'song') : '♪') + '</div>' +
          '<div class="queue-now__copy"><p class="eyebrow">NOW PLAYING</p>' +
          '<strong>' + esc(snap.current.title) + '</strong><span>' + esc(snap.current.artist) + '</span></div>' +
          '<span class="queue-now__bars' + (snap.playing ? ' is-playing' : '') + '" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
        now.classList.remove('is-empty');
      } else {
        now.innerHTML = '<div class="queue-now__empty">Nothing playing yet</div>';
        now.classList.add('is-empty');
      }
    }

    if (!snap.queue.length) {
      list.innerHTML = '<div class="queue-empty"><span>☷</span><strong>Your queue is empty</strong>' +
        '<p>Use the “···” menu on any song to add it here.</p></div>';
      return;
    }

    list.innerHTML = '<p class="queue-label">UP NEXT <span>' + snap.queue.length + '</span></p>' +
      snap.queue.map((song, index) => {
        return '<article class="queue-item ' + (index === snap.index ? 'is-current' : '') + '">' +
          '<span class="queue-item__num">' + String(index + 1).padStart(2, '0') + '</span>' +
          '<div class="queue-item__art">' + image(song.cover, song.title, false, song, 'song') + '</div>' +
          '<button class="queue-item__copy" data-action="queue-play" data-index="' + index + '">' +
          '<strong>' + esc(song.title) + '</strong><span>' + esc(song.artist) + '</span></button>' +
          (song.duration ? '<span class="queue-item__time">' + fmt(song.duration) + '</span>' : '') +
          '<button class="queue-item__remove" data-action="queue-remove" data-index="' + index + '" aria-label="Remove from queue">×</button>' +
          '</article>';
      }).join('');
  }

  function renderFlow(snap) {
    const track = snap && snap.current;
    const play = el('flow-play');
    play.textContent = snap && snap.playing ? '❚❚' : '▶';
    el('flow-shuffle').classList.toggle('is-on', Boolean(snap && snap.shuffle));
    el('flow-repeat').classList.toggle('is-on', Boolean(snap && snap.repeat !== 'off'));

    if (!track) return;
    el('flow-title').textContent = track.title;
    el('flow-artist').textContent = track.artist;
    el('flow-album').textContent = track.album || '';
    el('flow-cover').innerHTML = image(track.cover, track.title, false, track, 'song', true);
    if (MV.artwork) MV.artwork.background(el('flow-bg'), track, 'song');
    else {
      const flowCover = D.normalizeCover(track.cover, track.title, track.title);
      el('flow-bg').style.backgroundImage = 'url("' + String(flowCover).replace(/"/g, '%22') + '")';
    }

    const liked = MV.store.isLiked(track.id);
    const like = el('flow-like');
    like.textContent = liked ? '♥ Liked' : '♡ Like';
    like.classList.toggle('is-on', liked);
    like.classList.toggle('is-liked', liked);
    const likeTop = el('flow-like-top');
    if (likeTop) {
      likeTop.textContent = liked ? '♥' : '♡';
      likeTop.classList.toggle('is-on', liked);
      likeTop.classList.toggle('is-liked', liked);
      likeTop.setAttribute('aria-pressed', String(liked));
    }
    const album = MV.player.currentAlbum();
    const saved = Boolean(album && MV.store.isAlbumSaved(album));
    el('flow-save').textContent = saved ? '✓ Saved' : '↓ Save album';
    el('flow-save').classList.toggle('is-on', saved);

  }

  function openFlow() {
    if (!MV.player.state.current) { toast('Play a song to enter Flow State.'); return; }
    const flow = el('flow');
    flow.classList.add('is-open');
    flow.setAttribute('aria-hidden', 'false');
    flow.inert = false;
    renderFlow(MV.player.snapshot());
  }

  function closeFlow() {
    const flow = el('flow');
    releaseFocus(flow, '#top-flow');
    flow.classList.remove('is-open');
    flow.setAttribute('aria-hidden', 'true');
    flow.inert = true;
  }

  /* ---------------- navigation ---------------- */

  // Chrome blocks aria-hidden on a subtree that still owns focus. Move focus
  // to a visible opener, then blur as a last resort, before hiding a panel.
  function releaseFocus(container, fallbackSelector) {
    if (!container) return;
    const active = document.activeElement;
    if (!active || !container.contains(active)) return;
    let target = null;
    if (fallbackSelector) {
      try { target = document.querySelector(fallbackSelector); } catch (error) { /* selector is optional */ }
    }
    if (target && !container.contains(target) && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
    if (container.contains(document.activeElement) && typeof active.blur === 'function') active.blur();
  }

  function blurIn(node) {
    if (!node || !node.classList) return;
    clearTimeout(node.mvBlurTimer);
    node.classList.remove('mv-switch-in');
    void node.offsetWidth;
    node.classList.add('mv-switch-in');
    node.mvBlurTimer = setTimeout(() => {
      node.classList.remove('mv-switch-in');
      node.mvBlurTimer = null;
    }, 260);
  }

  // Slide the compact bottom-nav pill to the active tab. Mobile switches
  // animate this pill only; the page content itself does not blur or slide.
  function syncMobileNavIndicator() {
    const nav = document.querySelector('.mobile-nav');
    const indicator = nav && nav.querySelector('.mobile-nav__indicator');
    if (!nav || !indicator || getComputedStyle(nav).display === 'none') return;
    const active = nav.querySelector('.mobile-tab.is-active');
    if (!active) return;
    const navRect = nav.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    if (!navRect.width || !rect.width) return;
    const width = Math.min(Math.max(rect.width - 12, 28), 52);
    indicator.style.width = width + 'px';
    indicator.style.transform = 'translateX(' + (rect.left - navRect.left + (rect.width - width) / 2) + 'px)';
  }

  function navigate(page) {
    const names = { home: 'HOME', library: 'LIBRARY', discover: 'DISCOVER', stats: 'LISTENING STATS', account: 'ACCOUNT', advanced: 'ADVANCE SETTINGS', playlist: 'YOUR PLAYLIST', album: 'ALBUM', artist: 'ARTIST', report: 'REPORT' };
    const targetSection = document.querySelector('#page-' + page);
    const compact = window.matchMedia('(max-width: 820px)').matches;
    if (targetSection) {
      document.querySelectorAll('.page').forEach((section) =>
        section.classList.toggle('is-active', section === targetSection));
      if (!compact) blurIn(targetSection);
    }
    document.querySelectorAll('.island-tab').forEach((tab) =>
      tab.classList.toggle('is-active', tab.dataset.nav === page));
    syncMobileNavIndicator();
    el('crumb').textContent = names[page] || String(page).toUpperCase();
    document.querySelector('.stage').scrollTop = 0;
    const pages = document.querySelector('.pages');
    if (pages) pages.scrollLeft = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (page === 'library') renderLibrary();
    if (page === 'account') renderAccount();
    if (page === 'advanced') renderAdvanced();
    if (page === 'stats') renderStatsPage();
    if (page === 'playlist') renderPlaylistDetail();
    if (page === 'album') renderAlbum();
    el('island').classList.remove('is-open');
  }

  function setLibraryTab(tab) {
    MV.libraryFilter = tab;
    MV.libraryTab = LIBRARY_VIEWS[tab] || tab;
    renderLibrary();
    navigate('library');
  }

  /* ---------------- queue drawer ---------------- */

  function openQueue() {
    const drawer = el('queue-drawer');
    if (!drawer) return;
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    drawer.inert = false;
    renderQueue(MV.player.snapshot());
  }

  function closeQueue() {
    const drawer = el('queue-drawer');
    if (!drawer) return;
    // Move focus out before hiding so aria-hidden never covers a live control.
    releaseFocus(drawer, '#queue-toggle, #flow-queue');
    drawer.hidden = true;
    drawer.setAttribute('aria-hidden', 'true');
    drawer.inert = true;
  }

  function toggleQueue(force) {
    const drawer = el('queue-drawer');
    if (!drawer) return;
    const shouldOpen = typeof force === 'boolean' ? force : drawer.hidden;
    if (shouldOpen) openQueue();
    else closeQueue();
  }

  /* ---------------- event wiring ---------------- */

  function initIsland() {
    const island = el('island');
    const pearl = el('island-pearl');
    let timer = null;
    const open = () => {
      island.classList.add('is-open');
      pearl.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      island.classList.remove('is-open');
      pearl.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('mousemove', (event) => {
      if (event.clientX <= 150) {
        if (timer) clearTimeout(timer);
        open();
      } else if (!island.contains(event.target) && !timer) {
        timer = setTimeout(() => { close(); timer = null; }, 380);
      }
    });
    island.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null; } open(); });
    island.addEventListener('mouseleave', () => { timer = setTimeout(() => { close(); timer = null; }, 280); });
    pearl.addEventListener('click', (event) => { event.stopPropagation(); open(); });
  }

  function initSeeking() {
    const seek = el('seek');
    const flowSeek = el('flow-progress');
    function bind(node) {
      const handle = (event) => {
        const rect = node.getBoundingClientRect();
        MV.player.seekRatio((event.clientX - rect.left) / rect.width);
      };
      node.addEventListener('pointerdown', (event) => {
        handle(event);
        const move = (moveEvent) => handle(moveEvent);
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      node.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') { MV.player.seekRatio((MV.player.state.elapsed + 5) / (MV.player.state.duration || 1)); event.preventDefault(); }
        if (event.key === 'ArrowLeft') { MV.player.seekRatio((MV.player.state.elapsed - 5) / (MV.player.state.duration || 1)); event.preventDefault(); }
      });
    }
    bind(seek);
    bind(flowSeek);
    bind(el('player-progress'));
  }

  function initTilt() {
    document.addEventListener('pointermove', (event) => {
      const surface = event.target.closest && event.target.closest('.song-list .song-row');
      if (surface) {
        const bounds = surface.getBoundingClientRect();
        surface.style.setProperty('--px', (((event.clientX - bounds.left) / bounds.width) * 100).toFixed(1) + '%');
        surface.style.setProperty('--py', (((event.clientY - bounds.top) / bounds.height) * 100).toFixed(1) + '%');
      }

      const card = event.target.closest && event.target.closest('[data-tilt]');
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      card.style.setProperty('--rx', ((.5 - y) * 9).toFixed(2) + 'deg');
      card.style.setProperty('--ry', ((x - .5) * 11).toFixed(2) + 'deg');
      card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
      card.style.setProperty('--shift', ((x - .5) * 12).toFixed(1) + 'px');
    });
    document.addEventListener('pointerout', (event) => {
      const card = event.target.closest && event.target.closest('[data-tilt]');
      if (!card) return;
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
      card.style.setProperty('--shift', '0px');
    });
  }

  function initEvents() {
    const betaNotice = el('beta-notice');
    const betaClose = el('beta-notice-close');
    if (betaNotice && betaClose) {
      betaClose.onclick = () => {
        betaNotice.classList.remove('is-visible');
        betaNotice.hidden = true;
      };
    }

    const topMenu = el('top-menu');
    const topMenuToggle = el('top-menu-toggle');
    const closeTopMenu = () => {
      if (!topMenu) return;
      topMenu.classList.remove('is-open');
      if (topMenuToggle) topMenuToggle.setAttribute('aria-expanded', 'false');
      const list = el('top-menu-list');
      if (list) list.setAttribute('aria-hidden', 'true');
    };
    if (topMenuToggle && topMenu) {
      topMenuToggle.onclick = (event) => {
        event.stopPropagation();
        const open = !topMenu.classList.contains('is-open');
        topMenu.classList.toggle('is-open', open);
        topMenuToggle.setAttribute('aria-expanded', String(open));
        const list = el('top-menu-list');
        if (list) list.setAttribute('aria-hidden', String(!open));
      };
      topMenu.addEventListener('click', (event) => {
        if (event.target.closest('.top-menu__item')) closeTopMenu();
      });
      document.addEventListener('click', (event) => {
        if (!event.target.closest('.top-menu')) closeTopMenu();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeTopMenu();
      });
    }

    document.addEventListener('click', async (event) => {
      const target = event.target.closest('[data-action], [data-nav], [data-library-tab], [data-rail], [data-hero]');
      if (!target) {
        const recent = el('recent-searches');
        if (recent && !recent.hidden && !event.target.closest('.search-bar')) recent.hidden = true;
        return;
      }

      if (target.dataset.nav) {
        event.preventDefault();
        navigate(target.dataset.nav);
        return;
      }
      if (target.dataset.libraryTab) { setLibraryTab(target.dataset.libraryTab); return; }
      if (target.dataset.rail) {
        const rail = el(target.dataset.rail);
        if (rail) rail.scrollBy({ left: 460, behavior: 'smooth' });
        return;
      }
      if (target.dataset.hero != null) { setHero(Number(target.dataset.hero)); startHero(); return; }

      const action = target.dataset.action;
      if (!action) return;
      const item = registry[target.dataset.key];

      switch (action) {
        case 'home-filter':
          setHomeFilter(target.dataset.homeFilter);
          break;
        case 'result-filter':
          setResultFilter(target.dataset.resultFilter);
          break;
        case 'play-playlist':
          event.stopPropagation();
          if (item && item.songs && item.songs.length) MV.player.play(item.songs[0], item.songs);
          else toast('This playlist is empty.');
          break;
        case 'play-song':
          if (item) MV.player.play(item, contextListFor(item));
          break;
        case 'play-album':
          openAlbum(item);
          break;
        case 'open-album':
          openAlbum(item);
          break;
        case 'open-song-mix':
          await openSongMix(item);
          break;
        case 'open-album-catalog':
          await openAlbumCatalog(item);
          break;
        case 'open-language-mix':
          await openLanguageMix(target.dataset.language || (item && item.language) || 'Hindi');
          break;
        case 'open-trending-mix':
          await openTrendingMix();
          break;
        case 'play-artist':
          await doPlayArtist(item);
          break;
        case 'open-artist':
          openArtist(item);
          break;
        case 'play-recent':
          doPlayRecent(item);
          break;
        case 'save-album':
          event.stopPropagation();
          await doSaveAlbum(item);
          break;
        case 'remove-saved':
          event.stopPropagation();
          MV.api.removeSavedAlbum(item);
          renderAll(); toast('Removed from saved albums.');
          break;
        case 'like-song':
          event.stopPropagation();
          await MV.api.toggleLike(item);
          updateLikeButtons(item, target, true);
          const likedCount = el('liked-count');
          if (likedCount) likedCount.textContent = MV.store.state.liked.length + ' songs';
          break;
        case 'song-menu':
          event.stopPropagation();
          songMenu(item, target.dataset.inPlaylist === '1');
          break;
        case 'open-playlist':
          openPlaylist(item && item.id);
          break;
        case 'playlist-menu':
          event.stopPropagation();
          playlistMenu(item);
          break;
        case 'create-playlist':
          openCreatePlaylist();
          break;
        case 'playlist-remove-song':
          event.stopPropagation();
          await MV.api.removeFromPlaylist(MV.store.getPlaylist(MV.currentPlaylistId), item && item.id);
          renderPlaylistDetail(); renderLibrary();
          break;
        case 'queue-play':
          MV.player.play(MV.player.state.queue[Number(target.dataset.index)], MV.player.state.queue);
          break;
        case 'queue-remove':
          MV.player.removeFromQueue(Number(target.dataset.index));
          break;
        case 'recent-search':
          await runSearch(target.dataset.query);
          break;
        case 'chip-search':
        case 'quick-search':
          await runSearch(target.dataset.query);
          break;
        case 'clear-searches':
          MV.store.clearRecentSearches();
          renderRecentSearches();
          break;
        default:
          break;
      }
    });

    document.addEventListener('keydown', (event) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      if (event.key === 'Escape') {
        if (!el('modal-root').hidden) closeModal();
        else if (MV.lyrics && MV.lyrics.isOpen()) MV.lyrics.close();
        else if (el('flow').classList.contains('is-open')) closeFlow();
        else if (!el('queue-drawer').hidden) closeQueue();
        return;
      }
      const actionable = !typing && event.target.closest && event.target.closest('[data-action]');
      if (actionable && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        actionable.click();
        return;
      }
      if (typing) return;
      if (event.code === 'Space') { event.preventDefault(); MV.player.toggle(); }
      if (event.key === 'ArrowRight' && event.ctrlKey) MV.player.next(true);
      if (event.key === 'ArrowLeft' && event.ctrlKey) MV.player.previous();
    });

    el('main-play').onclick = () => MV.player.toggle();
    el('flow-play').onclick = () => MV.player.toggle();
    el('previous').onclick = () => MV.player.previous();
    el('flow-prev').onclick = () => MV.player.previous();
    el('next').onclick = () => MV.player.next(true);
    el('flow-next').onclick = () => MV.player.next(true);
    el('shuffle').onclick = () => MV.player.toggleShuffle();
    el('flow-shuffle').onclick = () => MV.player.toggleShuffle();
    const playerAdd = el('player-add');
    if (playerAdd) playerAdd.onclick = () => {
      const song = MV.player.state.current;
      if (!song) { toast('Play a song first.'); return; }
      addToPlaylistModal(song);
    };
    el('flow-repeat').onclick = () => MV.player.cycleRepeat();
    el('volume').oninput = (event) => MV.player.setVolume(event.target.value);
    el('volume-icon').onclick = () => MV.player.toggleMute();
    el('player-like').onclick = async () => {
      const current = MV.player.state.current;
      if (!current) return;
      await MV.api.toggleLike(current);
      updateLikeButtons(current, el('player-like'), true);
    };
    el('flow-like').onclick = async () => {
      const current = MV.player.state.current;
      if (!current) return;
      await MV.api.toggleLike(current);
      updateLikeButtons(current, el('flow-like'), true);
    };
    const flowLikeTop = el('flow-like-top');
    if (flowLikeTop) flowLikeTop.onclick = () => el('flow-like').click();
    el('player-save').onclick = async () => { const album = MV.player.currentAlbum(); if (album) await doSaveAlbum(album); };
    el('flow-save').onclick = async () => { const album = MV.player.currentAlbum(); if (album) await doSaveAlbum(album); };

    el('album-back').onclick = () => navigate(MV.albumReturnPage || 'home');
    el('album-play').onclick = () => {
      const state = MV.albumState;
      if (!state || !state.tracks.length) {
        toast('This album has no playable tracks yet.');
        return;
      }
      MV.store.addRecentlyPlayed({
        id: state.album.id,
        type: 'album',
        title: state.album.title,
        subtitle: state.album.artist,
        cover: state.album.cover
      });
      MV.player.play(state.tracks[0], state.tracks);
    };
    el('album-save').onclick = async () => {
      if (MV.albumState) await doSaveAlbum(MV.albumState.album);
    };
    el('player-cover').onclick = () => openFlow();
    const playerTrack = document.querySelector('.player-track');
    if (playerTrack) playerTrack.addEventListener('click', (event) => {
      if (event.target.closest('button, input, .seek, .player-progress')) return;
      openFlow();
    });
    el('top-flow').onclick = () => openFlow();
    const lyricsLaunch = el('lyrics-launch');
    if (lyricsLaunch) lyricsLaunch.onclick = () => MV.lyrics.toggle();
    const flowLyrics = el('flow-lyrics-open');
    if (flowLyrics) flowLyrics.onclick = () => { closeFlow(); MV.lyrics.open(); };
    el('flow-close').onclick = closeFlow;
    const flowBack = el('flow-back');
    if (flowBack) flowBack.onclick = closeFlow;
    el('flow').addEventListener('dblclick', (event) => { if (event.target === el('flow')) closeFlow(); });
    el('player').addEventListener('dblclick', (event) => {
      if (event.target.closest('button, input, .seek, .player-progress')) return;
      openFlow();
    });

    el('queue-toggle').onclick = () => toggleQueue();
    el('flow-queue').onclick = () => toggleQueue();
    el('queue-close').onclick = closeQueue;

    el('hero-prev').onclick = () => { setHero(MV.heroIndex - 1); startHero(); };
    el('hero-next').onclick = () => { setHero(MV.heroIndex + 1); startHero(); };
    el('hero-play').onclick = () => {
      const slides = MV.homeHeroes && MV.homeHeroes.length ? MV.homeHeroes : D.heroes;
      const slide = slides[MV.heroIndex];
      const song = D.getSong(slide.songId);
      const album = D.getAlbum(slide.albumId);
      if (album) openAlbum(album, 'home'); else MV.player.play(song);
    };
    el('hero-save').onclick = () => {
      const slides = MV.homeHeroes && MV.homeHeroes.length ? MV.homeHeroes : D.heroes;
      const slide = slides[MV.heroIndex];
      const album = D.getAlbum(slide.albumId) || (() => {
        const song = D.getSong(slide.songId);
        return { id: 'album-' + D.hash(song.album), title: song.album, artist: song.artist, cover: song.cover };
      })();
      doSaveAlbum(album);
    };
    const heroNode = el('hero');
    heroNode.addEventListener('mouseenter', stopHero);
    heroNode.addEventListener('mouseleave', startHero);
    let touchX = null;
    heroNode.addEventListener('touchstart', (event) => { touchX = event.touches[0].clientX; }, { passive: true });
    heroNode.addEventListener('touchend', (event) => {
      if (touchX == null) return;
      const delta = event.changedTouches[0].clientX - touchX;
      if (Math.abs(delta) > 45) setHero(MV.heroIndex + (delta < 0 ? 1 : -1));
      touchX = null;
    }, { passive: true });

    const openSearch = () => {
      navigate('discover');
      setTimeout(() => {
        const input = el('search-input');
        if (input && input.focus) input.focus({ preventScroll: true });
      }, 720);
    };
    el('top-search').onclick = () => { closeTopMenu(); openSearch(); };
    const homeSearch = el('home-search');
    if (homeSearch) homeSearch.onclick = openSearch;
    const searchClose = el('search-close');
    if (searchClose) searchClose.onclick = () => navigate('home');
    const input = el('search-input');
    input.addEventListener('focus', () => { renderRecentSearches(); el('recent-searches').hidden = false; });
    input.addEventListener('input', () => { el('search-clear').hidden = !input.value; });
    el('search-clear').onclick = () => {
      input.value = ''; el('search-clear').hidden = true;
      el('results').hidden = true; MV.searchState = { query: '', result: null };
      el('page-discover').classList.remove('has-results');
      input.focus();
    };
    el('search-form').onsubmit = (event) => { event.preventDefault(); runSearch(input.value); };

    const loadMoreSongs = el('load-more-songs');
    if (loadMoreSongs) loadMoreSongs.onclick = () => {
      MV.searchState.visibleSongs = (Number(MV.searchState.visibleSongs) || 30) + 30;
      renderResults();
    };
    const artistLoadMore = el('artist-load-more');
    if (artistLoadMore) artistLoadMore.onclick = loadMoreArtistSongs;
    const artistPlayAll = el('artist-play-all');
    if (artistPlayAll) artistPlayAll.onclick = () => {
      const songs = MV.artistState && MV.artistState.songs;
      if (songs && songs.length) MV.player.play(songs[0], songs);
      else toast('No popular songs found for this artist.');
    };

    document.querySelectorAll('[data-query]').forEach((node) => {
      if (!node.dataset.action) node.dataset.action = 'quick-search';
    });

    el('add-playlist').onclick = openCreatePlaylist;
    el('lib-create').onclick = openCreatePlaylist;

    el('playlist-add-songs').onclick = () => {
      const playlist = MV.store.getPlaylist(MV.currentPlaylistId);
      if (playlist) playlistAddSongsModal(playlist);
    };
    el('playlist-more').onclick = () => {
      const playlist = MV.store.getPlaylist(MV.currentPlaylistId);
      if (playlist) playlistMenu(playlist);
    };
    el('playlist-play').onclick = async () => {
      const playlist = MV.store.getPlaylist(MV.currentPlaylistId);
      if (playlist && playlist.songs.length) MV.player.play(playlist.songs[0], playlist.songs);
      else toast('This playlist is empty.');
    };

    el('cover-file').onchange = async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file || !coverCallback) return;
      try {
        const image = await loadImageFile(file);
        openImageCropper(image, {
          title: 'Frame your cover',
          description: 'Drag the image and zoom until the square guide contains the part you want.',
          shape: 'square',
          onCrop: (dataUrl) => coverCallback(dataUrl)
        });
      } catch (error) {
        toast(error.message || 'Could not use that image.');
      }
    };

    const profileEditToggle = el('profile-edit-toggle');
    if (profileEditToggle) profileEditToggle.onclick = () => {
      profileEditorOpen = !profileEditorOpen;
      const editor = el('profile-editor');
      if (editor) editor.hidden = !profileEditorOpen;
      profileEditToggle.textContent = profileEditorOpen ? 'Close' : 'Edit';
      profileEditToggle.setAttribute('aria-expanded', String(profileEditorOpen));
    };
    const statsMonth = el('stats-month');
    if (statsMonth) statsMonth.onchange = (event) => {
      selectedStoryMonth = event.target.value;
      storyIndex = 0;
      renderStatsPage();
    };
    const wrappedPrev = el('wrapped-prev');
    if (wrappedPrev) wrappedPrev.onclick = () => {
      storyIndex = Math.max(0, storyIndex - 1);
      renderStatsPage();
    };
    const wrappedNext = el('wrapped-next');
    if (wrappedNext) wrappedNext.onclick = () => {
      const slides = statsSlides(MV.store.playStats(selectedStoryMonth));
      storyIndex = storyIndex >= slides.length - 1 ? 0 : storyIndex + 1;
      renderStatsPage();
    };
    const wrappedDots = el('wrapped-dots');
    if (wrappedDots) wrappedDots.onclick = (event) => {
      const dot = event.target.closest('[data-slide]');
      if (!dot) return;
      storyIndex = Number(dot.dataset.slide) || 0;
      renderStatsPage();
    };

    el('profile-save').onclick = () => {
      const name = el('profile-name').value.trim();
      if (!name) { toast('Enter a name first.'); return; }
      MV.store.setProfile('name', name);
      renderAccount();
      toast('Profile saved.');
    };
    const chooseAvatar = el('choose-avatar');
    if (chooseAvatar) chooseAvatar.onclick = () => el('avatar-file').click();
    const removeAvatar = el('remove-avatar');
    if (removeAvatar) removeAvatar.onclick = async () => {
      await MV.api.setProfilePicture('');
      renderAccount();
      toast('Profile picture removed.');
    };
    el('avatar-file').onchange = async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        const image = await loadImageFile(file);
        openImageCropper(image, {
          title: 'Frame your profile picture',
          description: 'Drag the image and zoom until your face sits inside the circular guide.',
          shape: 'circle',
          onCrop: async (dataUrl) => {
            try {
              await MV.api.setProfilePicture(dataUrl);
              renderAccount();
              toast('Profile picture updated.');
            } catch (error) {
              toast(error.message || 'Could not save that picture.');
            }
          }
        });
      } catch (error) {
        toast(error.message || 'Could not use that image.');
      }
    };

    el('setting-flow-auto').onchange = (event) => MV.store.setProfile('flowAuto', event.target.checked);
    el('setting-ambience').onchange = (event) => {
      MV.store.setProfile('ambience', event.target.checked);
      document.body.classList.toggle('no-ambience', !event.target.checked);
    };
    el('setting-history').onchange = (event) => MV.store.setProfile('rememberSearches', event.target.checked);

    const lyricsSpeed = el('setting-lyrics-speed');
    if (lyricsSpeed) {
      lyricsSpeed.addEventListener('input', () => updateLyricsSpeedLabel(lyricsSpeed.value));
      lyricsSpeed.addEventListener('change', () => {
        const speed = Math.min(2.4, Math.max(0.6, Number(lyricsSpeed.value) || 1));
        MV.store.setProfile('lyricsSwitchSpeed', Number(speed.toFixed(1)));
        updateLyricsSpeedLabel(speed);
      });
      updateLyricsSpeedLabel(lyricsSpeed.value);
    }

    const spotifySave = el('spotify-save-client');
    if (spotifySave && MV.spotify) {
      spotifySave.onclick = () => {
        const id = String((el('spotify-client-id') || {}).value || '').trim();
        MV.spotify.setClientId(id);
        toast(id ? 'Spotify Client ID saved.' : 'Spotify Client ID removed.');
      };
      const spotifyConnect = el('spotify-connect');
      if (spotifyConnect) spotifyConnect.onclick = async () => {
        try {
          await MV.spotify.connect();
        } catch (error) {
          toast(error.message || 'Could not start Spotify sign-in.');
        }
      };
      const spotifyImport = el('spotify-import-playlist');
      if (spotifyImport) spotifyImport.onclick = () => openSpotifyImportModal();
      const spotifyDisconnect = el('spotify-disconnect');
      if (spotifyDisconnect) spotifyDisconnect.onclick = () => {
        MV.spotify.disconnect();
        toast('Spotify disconnected.');
      };
    }

    el('clear-searches').onclick = () => { MV.store.clearRecentSearches(); toast('Recent searches cleared.'); };
    el('clear-history').onclick = () => {
      confirmModal('Clear listening history?', 'Recently played items and listening stats will be removed.', 'Clear', () => {
        MV.store.clearListeningHistory(); renderHome(); renderAccount(); toast('History cleared.');
      });
    };

    const reportForm = el('report-form');
    if (reportForm) {
      reportForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = String((el('report-name') || {}).value || '').trim();
        const email = String((el('report-email') || {}).value || '').trim();
        const description = String((el('report-description') || {}).value || '').trim();
        const error = el('report-error');
        const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

        if (!email || !emailOk) {
          if (error) {
            error.textContent = 'Please enter a valid email address.';
            error.hidden = false;
          }
          const field = el('report-email');
          if (field) field.focus();
          return;
        }
        if (!description) {
          if (error) {
            error.textContent = 'Please describe the issue so we can help.';
            error.hidden = false;
          }
          const field = el('report-description');
          if (field) field.focus();
          return;
        }

        if (error) error.hidden = true;
        const subject = 'MusicVer report';
        const body = [
          'Name: ' + (name || 'Not provided'),
          'Email: ' + email,
          '',
          'Bug description:',
          description
        ].join('\n');
        const mailto = 'mailto:r91128577@gmail.com?subject=' +
          encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);

        // Open the user's email client with the report prefilled.
        window.location.href = mailto;

        reportForm.hidden = true;
        const thanks = el('report-thanks');
        if (thanks) thanks.hidden = false;
      });
    }

    const reportAnother = el('report-another');
    if (reportAnother) reportAnother.onclick = () => {
      const form = el('report-form');
      if (form) {
        form.reset();
        form.hidden = false;
      }
      const thanks = el('report-thanks');
      if (thanks) thanks.hidden = true;
      const err = el('report-error');
      if (err) err.hidden = true;
    };

    el('choose-folder').onclick = async () => {
      const result = await MV.api.chooseFolder();
      if (result && result.success) {
        toast('Music folder updated.');
        renderAccount();
      } else {
        toast(result && result.message ? result.message : 'Folder picker is available in the desktop app.');
      }
    };

    const themeToggle = el('theme-toggle');
    if (themeToggle) themeToggle.onclick = (event) => toggleTheme(event.currentTarget);
    const darkSetting = el('setting-dark');
    if (darkSetting) {
      darkSetting.onchange = (event) =>
        toggleTheme(event.target.closest('.switch-row') || event.target);
    }
  }

  /* ---------------- theme ---------------- */

  const THEME_BG = { light: '#f7f5f1', dark: '#121317' };

  function applyTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', value);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_BG[value]);

    const toggle = el('theme-toggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(value === 'dark'));
      toggle.setAttribute('aria-label', value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      toggle.title = value === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      const glyph = toggle.querySelector('.theme-toggle__glyph');
      if (glyph) glyph.textContent = value === 'dark' ? '☀' : '☾';
    }
    const setting = el('setting-dark');
    if (setting) setting.checked = value === 'dark';
  }

  function setThemeWithAnimation(theme, origin) {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = theme === 'dark' ? 'dark' : 'light';
    if (current === next) return;

    applyTheme(next);

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const cols = Math.max(6, Math.ceil(width / 96));
    const rows = Math.max(4, Math.ceil(height / 96));
    let ox = .92;
    let oy = .06;
    if (origin && origin.getBoundingClientRect) {
      const rect = origin.getBoundingClientRect();
      ox = (rect.left + rect.width / 2) / width;
      oy = (rect.top + rect.height / 2) / height;
    }

    const grid = document.createElement('div');
    grid.className = 'flip-grid';
    grid.setAttribute('aria-hidden', 'true');
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    grid.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';

    let markup = '';
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const distance = Math.hypot(
          col / Math.max(1, cols - 1) - ox,
          row / Math.max(1, rows - 1) - oy
        );
        const delay = Math.round(distance * 300);
        markup += '<div class="flip-tile" style="--delay:' + delay + 'ms">' +
          '<div class="flip-tile__inner">' +
          '<div class="flip-tile__face flip-tile__face--front" style="background:' + THEME_BG[current] + '"></div>' +
          '<div class="flip-tile__face flip-tile__face--back" style="background:' + THEME_BG[next] + '"></div>' +
          '</div></div>';
      }
    }
    grid.innerHTML = markup;
    document.body.appendChild(grid);
    requestAnimationFrame(() => grid.classList.add('is-active'));
    setTimeout(() => { if (grid.parentNode) grid.remove(); }, 300 + 680 + 140);
  }

  function toggleTheme(origin) {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    MV.api.setTheme(next);
    setThemeWithAnimation(next, origin);
    toast(next === 'dark' ? 'Dark mode on' : 'Light mode on');
  }

  /* ---------------- listening stats tab ---------------- */

  function monthLabel(key) {
    const date = new Date(String(key) + '-01T00:00:00');
    if (isNaN(date.getTime())) return String(key);
    return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function currentMonthKey() {
    const now = new Date();
    return String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0');
  }

  function statsSlides(stats) {
    const topSong = stats.topSong;
    const topArtist = stats.topArtist;
    const empty = !stats.total;

    return [
      {
        theme: 'intro',
        html: '<p class="wrapped-kicker">musicVer wrapped</p>' +
          '<h2 class="wrapped-title">Your <em>' + esc(stats.monthName) + '</em> in sound.</h2>' +
          '<p class="wrapped-copy">' + (empty
            ? 'No plays recorded yet. Play a few songs and come back to unwrap your month.'
            : 'A story built from every song you pressed play on this device.') + '</p>'
      },
      {
        theme: 'plays',
        html: '<p class="wrapped-kicker">You showed up</p>' +
          '<div class="wrapped-big">' + stats.total + '</div>' +
          '<h2 class="wrapped-title">plays this month.</h2>' +
          '<p class="wrapped-copy">' + stats.uniqueSongs + ' different songs. ' +
          (stats.listenedSeconds ? Math.max(1, Math.round(stats.listenedSeconds / 60)) + ' minutes of soundtrack. ' : '') +
          'Every one of them yours.</p>'
      },
      {
        theme: 'artist',
        html: '<p class="wrapped-kicker">Your top artist</p>' +
          '<h2 class="wrapped-title">' + esc(topArtist ? topArtist.name : 'Nobody yet') + '</h2>' +
          '<p class="wrapped-copy">' + (topArtist
            ? 'You came back to ' + esc(topArtist.name) + ' ' + topArtist.count + (topArtist.count === 1 ? ' time' : ' times') + ' this month.'
            : 'Play a few songs and your most-listened artist will appear here.') + '</p>'
      },
      {
        theme: 'song',
        html: '<p class="wrapped-kicker">Your most-played song</p>' +
          (topSong ? '<div class="wrapped-cover">' + image(topSong.cover, topSong.title, false, topSong, 'song') + '</div>' : '') +
          '<h2 class="wrapped-title">' + esc(topSong ? topSong.title : 'Nothing yet') + '</h2>' +
          '<p class="wrapped-copy">' + (topSong
            ? esc(topSong.artist) + ' · played ' + topSong.count + (topSong.count === 1 ? ' time' : ' times')
            : 'Your repeat anthem is still waiting to be discovered.') + '</p>'
      },
      {
        theme: 'songs',
        html: '<p class="wrapped-kicker">Your rotation</p>' +
          '<h2 class="wrapped-title">Top songs.</h2>' +
          '<div class="wrapped-rank-list">' + ((stats.songs || []).length
            ? stats.songs.map((song, index) =>
                '<div class="wrapped-rank"><span>' + (index + 1) + '</span>' +
                '<strong>' + esc(song.title) + '</strong>' +
                '<em>' + song.count + '×</em></div>').join('')
            : '<div class="wrapped-rank"><span>—</span><strong>No plays yet</strong><em>0×</em></div>') + '</div>'
      },
      {
        theme: 'outro',
        html: '<p class="wrapped-kicker">That is your month</p>' +
          '<h2 class="wrapped-title">Keep the <em>streak</em> alive.</h2>' +
          '<p class="wrapped-copy">' + (empty
            ? 'Your next play starts a brand-new story.'
            : 'From ' + stats.total + ' plays to one very clear favourite. Here is to the next ' + esc(monthLabel(selectedStoryMonth)) + '.') + '</p>'
      }
    ];
  }

  function renderStatsPage() {
    const select = el('stats-month');
    const stage = el('wrapped-stage');
    if (!select || !stage) return;

    const current = currentMonthKey();
    const months = uniqueItems([current].concat(MV.store.playMonths()), (key) => key);
    if (selectedStoryMonth && months.indexOf(selectedStoryMonth) < 0) selectedStoryMonth = '';
    if (!selectedStoryMonth) selectedStoryMonth = months[0] || current;
    select.innerHTML = months.map((key) =>
      '<option value="' + esc(key) + '"' + (key === selectedStoryMonth ? ' selected' : '') + '>' + esc(monthLabel(key)) + '</option>').join('');

    const stats = MV.store.playStats(selectedStoryMonth);
    const slides = statsSlides(stats);
    storyIndex = Math.max(0, Math.min(storyIndex, slides.length - 1));
    const slide = slides[storyIndex];
    stage.innerHTML = '<div class="wrapped-slide wrapped-slide--' + slide.theme + '">' + slide.html + '</div>';

    const dots = el('wrapped-dots');
    if (dots) {
      dots.innerHTML = slides.map((_, index) =>
        '<button type="button" data-slide="' + index + '" aria-label="Story slide ' + (index + 1) + '"' +
        ' class="' + (index === storyIndex ? 'is-current' : (index < storyIndex ? 'is-done' : '')) + '"></button>').join('');
    }
    const prev = el('wrapped-prev');
    const next = el('wrapped-next');
    if (prev) prev.disabled = storyIndex === 0;
    if (next) next.textContent = storyIndex === slides.length - 1 ? 'Replay ↺' : 'Next →';
  }

  /* ---------------- account + render all ---------------- */

  function updateLyricsSpeedLabel(value) {
    const node = el('lyrics-speed-value');
    if (!node) return;
    const speed = Math.min(2.4, Math.max(0.6, Number(value) || 1));
    const seconds = (0.9 / speed).toFixed(2).replace(/\.?0+$/, '') + 's';
    node.textContent = speed.toFixed(1) + '× · ' + seconds + ' morph';
  }

  function renderAdvanced() {
    const input = el('setting-lyrics-speed');
    if (!input) return;
    const profile = MV.store.state.profile;
    const raw = Number(profile.lyricsSwitchSpeed);
    const speed = Number.isFinite(raw) && raw > 0 ? Math.min(2.4, Math.max(0.6, raw)) : 1;
    input.value = speed.toFixed(1);
    updateLyricsSpeedLabel(speed);
  }

  function renderAccount() {
    const profile = MV.store.state.profile;
    const initial = (profile.name || 'M').charAt(0).toUpperCase();
    el('profile-name').value = profile.name || '';
    const displayName = el('profile-display-name');
    if (displayName) displayName.textContent = profile.name || 'Music Lover';
    const pictureHtml = profile.picture
      ? image(profile.picture, 'Profile picture', true, { picture: profile.picture, name: profile.name }, 'artist', true)
      : initial;
    if (el('account-avatar')) el('account-avatar').innerHTML = pictureHtml;
    if (el('top-avatar')) el('top-avatar').innerHTML = pictureHtml;
    if (el('mobile-tab-avatar')) el('mobile-tab-avatar').innerHTML = pictureHtml;
    const editor = el('profile-editor');
    if (editor) editor.hidden = !profileEditorOpen;
    const editToggle = el('profile-edit-toggle');
    if (editToggle) {
      editToggle.textContent = profileEditorOpen ? 'Close' : 'Edit';
      editToggle.setAttribute('aria-expanded', String(profileEditorOpen));
    }
    const removeAvatar = el('remove-avatar');
    if (removeAvatar) removeAvatar.hidden = !profile.picture;
    el('setting-flow-auto').checked = Boolean(profile.flowAuto);
    el('setting-ambience').checked = Boolean(profile.ambience);
    el('setting-history').checked = Boolean(profile.rememberSearches);
    const darkSetting = el('setting-dark');
    if (darkSetting) {
      darkSetting.checked = (document.documentElement.getAttribute('data-theme') || MV.store.state.theme || 'light') === 'dark';
    }
    document.body.classList.toggle('no-ambience', !profile.ambience);

    const spotify = MV.spotify ? MV.spotify.status() : null;
    if (spotify) {
      const clientInput = el('spotify-client-id');
      if (clientInput) clientInput.value = spotify.clientId || '';
      const redirect = el('spotify-redirect-uri');
      if (redirect) redirect.textContent = spotify.redirectUri;
      const connect = el('spotify-connect');
      if (connect) {
        connect.hidden = Boolean(spotify.connected && spotify.canImportPlaylists);
        connect.textContent = spotify.connected && !spotify.canImportPlaylists
          ? 'Enable playlist access' : 'Connect Spotify';
      }
      const importButton = el('spotify-import-playlist');
      if (importButton) {
        importButton.textContent = spotify.connected && !spotify.canImportPlaylists
          ? 'Enable playlist access & import' : 'Import a playlist';
      }
      const disconnect = el('spotify-disconnect');
      if (disconnect) disconnect.hidden = !spotify.connected;
      const spotifyStatus = el('spotify-status');
      if (spotifyStatus) {
        spotifyStatus.textContent = spotify.error
          ? spotify.error
          : (spotify.connected && !spotify.canImportPlaylists
            ? 'Connected · enable playlist access to import your playlists.'
            : (spotify.ready
              ? 'Connected · live recommendations and playlist import are active.'
              : (spotify.connected
                ? 'Connected · refreshing your Spotify session…'
                : (spotify.configured ? 'Ready to connect.' : 'Not connected'))));
        spotifyStatus.classList.toggle('is-live', Boolean(spotify.ready && spotify.canImportPlaylists));
      }
    }

    const status = el('backend-status');
    const live = MV.api.isLive();
    if (status) {
      status.textContent = live ? 'ENGINE LIVE' : 'PREVIEW';
      status.classList.toggle('is-live', live);
    }
    el('account-status').textContent = live
      ? 'Connected to the local music engine. Everything is stored on this device.'
      : 'Preview mode · open f-3/main.py for real playback and library sync.';
    MV.api.folderPath().then((folder) => {
      if (folder) el('folder-path').textContent = 'Local library folder: ' + folder;
    });
  }

  function renderAll() {
    renderHome();
    renderFeatureCards();
    renderHomeChrome();
    renderSearchSuggestions();
    renderDiscoverPicks();
    renderRecentlyExplored();
    renderResults();
    renderLibrary();
    renderAccount();
    renderAllSpotifyShelves();
    const active = document.querySelector('.page.is-active');
    if (active && active.id === 'page-album') renderAlbum();
    updatePlayer(MV.player.snapshot());
  }

  /* Image error events do not bubble, so listen in the capture phase once and
     heal every remote cover the same way. The local SVG is deterministic, so
     a blocked CDN never leaves a broken image or an empty square behind. */
  function initImageFallbacks() {
    if (document.documentElement.dataset.coverFallbackReady) return;
    document.documentElement.dataset.coverFallbackReady = '1';
    if (MV.artwork) MV.artwork.init();
  }

  function init() {
    MV.homeRefreshId = nextHomeRefreshId();
    const heroOffset = D.heroes.length ? (MV.homeRefreshId - 1) % D.heroes.length : 0;
    MV.homeHeroes = D.heroes.map((_, index) => D.heroes[(index + heroOffset) % D.heroes.length]);
    initImageFallbacks();
    // Hidden overlays must not be reachable by Tab before their first open.
    if (el('flow')) el('flow').inert = true;
    if (el('queue-drawer')) el('queue-drawer').inert = true;
    initIsland();
    initSeeking();
    initTilt();
    initEvents();
    if (MV.lyrics) MV.lyrics.init();
    if (MV.spotify && MV.spotify.onStatus) {
      MV.spotify.onStatus((status) => {
        renderAccount();
        renderAllSpotifyShelves();
        maybeResumeSpotifyImport(status);
      });
      maybeResumeSpotifyImport(MV.spotify.status());
    }
    renderHero();
    startHero();
    renderGenres();
    renderAll();
    renderRecentSearches();
    if (!window.matchMedia('(max-width: 820px)').matches) {
      blurIn(document.querySelector('.page.is-active'));
    }
    syncMobileNavIndicator();
    window.addEventListener('resize', syncMobileNavIndicator, { passive: true });
    document.addEventListener('mv:player', (event) => updatePlayer(event.detail));
    document.addEventListener('mv:store', (event) => {
      // Likes update hearts in place so the sparkle animation is not wiped
      // away by a full re-render.
      if (event.detail && event.detail.reason === 'like') {
        updateLikeButtons();
        const likedCount = el('liked-count');
        if (likedCount) likedCount.textContent = MV.store.state.liked.length + ' songs';
        return;
      }
      renderHome();
      renderFeatureCards();
      renderHomeChrome();
      renderDiscoverPicks();
      renderRecentlyExplored();
      renderLibrary();
      updatePlayer(MV.player.snapshot());
      const active = document.querySelector('.page.is-active');
      if (active && active.id === 'page-stats') renderStatsPage();
      if (active && active.id === 'page-advanced') renderAdvanced();
    });
    const inDesktop = /Electron|MusicVer/i.test(navigator.userAgent || '');
    document.documentElement.classList.toggle('is-desktop', inDesktop);
    window.addEventListener('resize', () => {
      const pages = document.querySelector('.pages');
      if (pages) pages.scrollLeft = 0;
    });
    const notice = el('beta-notice');
    if (!inDesktop && notice) {
      setTimeout(() => {
        notice.hidden = false;
        requestAnimationFrame(() => notice.classList.add('is-visible'));
      }, 450);
    }
  }

  MV.ui = {
    init, renderAll, renderHome, renderLibrary, renderAccount, renderAdvanced, renderGenres,
    renderPlaylistDetail, renderResults, renderRecentSearches,
    updatePlayer, updateProgress, renderQueue, renderFlow,
    navigate, setLibraryTab, openPlaylist, openAlbum, renderAlbum, openArtist, openFlow, closeFlow,
    openQueue, closeQueue, toggleQueue, applyTheme, setThemeWithAnimation, toggleTheme,
    openCreatePlaylist, songMenu, addToPlaylistModal, coverPicker,
    runSearch, setHero, toast, loadImageFile, readCoverFile, openImageCropper, fmt, esc,
    renderSpotifyShelf, renderAllSpotifyShelves, openSpotifyImportModal, releaseFocus
  };
})(window.MV = window.MV || {});
