/* ============================================================
   musicVer · player engine
   Spotify-style controls, queue, shuffle / repeat and cover-
   driven ambience. Playback itself goes through the Python API.
   ============================================================ */

(function (MV) {
  'use strict';

  const D = MV.data;

  const state = {
    current: null,
    queue: [],
    index: -1,
    playing: false,
    elapsed: 0,
    duration: 0,
    volume: Number(MV.store.state.volume || 70),
    shuffle: Boolean(MV.store.state.shuffle),
    repeat: MV.store.state.repeat || 'off',
    simulated: false,
    lastTick: Date.now(),

    // Ported from the old frontend/js/app.js shuffle engine.
    shuffleHistory: [],
    shuffleHistoryIndex: -1
  };

  let progressBusy = false;
  let toggleBusy = false;
  let autoAdvanceHandled = false;
  let pauseGraceUntil = 0;
  let flowOpened = false;

  function notify() {
    document.dispatchEvent(new CustomEvent('mv:player', { detail: snapshot() }));
  }

  function snapshot() {
    return {
      current: state.current,
      queue: state.queue.slice(),
      index: state.index,
      playing: state.playing,
      elapsed: state.elapsed,
      duration: state.duration,
      volume: state.volume,
      shuffle: state.shuffle,
      repeat: state.repeat
    };
  }

  function prepare(track) {
    const normalized = D.normalizeTrack(track);
    if (normalized && track && track.raw) normalized.raw = track.raw;
    return normalized;
  }

  function findIndex(list, track) {
    return list.findIndex((item) => String(item.id) === String(track && track.id));
  }

  // Stable identity for both local files and streamed tracks, copied from
  // the old frontend/js/app.js implementation.
  function trackKey(song) {
    if (!song) return '';
    if (song.path) return 'local:' + song.path;
    return (song.provider || 'online') + ':' + (song.id || song.title);
  }

  /* ---------------- cover colour ---------------- */

  function hexToRgb(hex) {
    const value = String(hex).replace('#', '');
    const full = value.length === 3 ? value.split('').map((char) => char + char).join('') : value;
    const number = parseInt(full, 16);
    if (!isFinite(number)) return null;
    return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
  }

  function fallbackColor(seed) {
    const hue = D.hash(seed || 'musicver') % 360;
    const hsl = (h, s, l) => {
      const a = s * Math.min(l, 1 - l);
      const f = (n) => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(255 * color);
      };
      return { r: f(0), g: f(8), b: f(4) };
    };
    return {
      main: hsl(hue, .44, .47),
      light: hsl((hue + 26) % 360, .38, .68)
    };
  }

  function contrastFor(rgb) {
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return luminance > .62 ? '#26221e' : '#ffffff';
  }

  function applyAccent(cover, seed) {
    let colors = fallbackColor(seed || (state.current && state.current.title) || cover);

    const finish = () => {
      const root = document.documentElement;
      const main = colors.main;
      root.style.setProperty('--accent', 'rgb(' + main.r + ',' + main.g + ',' + main.b + ')');
      root.style.setProperty('--accent-rgb', main.r + ',' + main.g + ',' + main.b);
      root.style.setProperty('--accent-2', 'rgb(' + colors.light.r + ',' + colors.light.g + ',' + colors.light.b + ')');
      root.style.setProperty('--accent-contrast', contrastFor(main));
      document.dispatchEvent(new CustomEvent('mv:accent', { detail: colors }));
    };

    if (!cover) { finish(); return; }

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, 1, 1);
        const data = ctx.getImageData(0, 0, 1, 1).data;
        const main = { r: data[0], g: data[1], b: data[2] };
        const light = {
          r: Math.min(255, Math.round(main.r * .55 + 255 * .45)),
          g: Math.min(255, Math.round(main.g * .55 + 255 * .45)),
          b: Math.min(255, Math.round(main.b * .55 + 255 * .45))
        };
        colors = { main, light };
      } catch (error) {
        // Remote artwork without CORS headers keeps the hash-based colour.
      }
      finish();
    };
    image.onerror = finish;
    image.src = cover;
  }

  /* ---------------- playback ---------------- */

  async function play(track, list, options) {
    const prepared = prepare(track);
    if (!prepared) return;

    const settings = options || {};
    if (Array.isArray(list) && list.length) {
      state.queue = list.map(prepare).filter(Boolean);
      state.index = findIndex(state.queue, prepared);
      if (state.index < 0) {
        state.queue.unshift(prepared);
        state.index = 0;
      }
    } else if (findIndex(state.queue, prepared) >= 0) {
      state.index = findIndex(state.queue, prepared);
    } else {
      state.queue = [prepared];
      state.index = 0;
    }

    state.current = state.queue[state.index];
    state.elapsed = Number(settings.startAt) || 0;
    state.duration = state.current.duration || 0;
    state.playing = true;
    state.lastTick = Date.now();
    flowOpened = false;
    // VLC reports "loading" while a stream opens; keep the button in sync
    // with the user's intent until playback has had time to start. Streams
    // get a longer grace period because they also need metadata/auth work.
    pauseGraceUntil = Date.now() + (MV.api.isLive() ? 4000 : 1200);

    // Record song in shuffle history (same rule as the old player).
    if (state.shuffle && settings.recordShuffleHistory !== false) {
      state.shuffleHistory = state.shuffleHistory.slice(0, state.shuffleHistoryIndex + 1);
      if (
        state.shuffleHistory.length === 0 ||
        trackKey(state.shuffleHistory[state.shuffleHistory.length - 1]) !== trackKey(state.current)
      ) {
        state.shuffleHistory.push(state.current);
      }
      state.shuffleHistoryIndex = state.shuffleHistory.length - 1;
    }

    MV.store.addRecentlyPlayed({
      id: state.current.id,
      type: 'song',
      title: state.current.title,
      subtitle: state.current.artist,
      cover: state.current.cover
    });

    applyAccent(state.current.cover, state.current.title + state.current.artist);
    notify();

    const result = await MV.api.play(state.current);
    state.simulated = Boolean(result && result.simulated);
    if (result && result.success === false) {
      MV.ui.toast(result.message || 'Playback could not start.');
      state.playing = false;
      notify();
    }

    // In browser preview there is no backend progress event, so open Flow
    // immediately. In live mode we wait for the backend to report "playing"
    // first; opening the immersive view before audio is ready makes the
    // startup feel like a pause.
    if (result && result.simulated && MV.store.state.profile.flowAuto && MV.ui.openFlow) {
      MV.ui.openFlow();
    }
  }

  async function toggle() {
    if (toggleBusy) return;
    if (!state.current) {
      play(D.songs[0]);
      return;
    }

    toggleBusy = true;
    const wasPlaying = state.playing;
    state.playing = !wasPlaying;
    if (!wasPlaying) {
      state.lastTick = Date.now();
      pauseGraceUntil = Date.now() + 1200;
    }
    notify();

    try {
      const result = wasPlaying ? await MV.api.pause() : await MV.api.resume();
      if (result && result.success === false) {
        state.playing = wasPlaying;
        MV.ui.toast(result.message || 'Playback could not be updated.');
      }
    } catch (error) {
      state.playing = wasPlaying;
      MV.ui.toast('Playback could not be updated.');
    } finally {
      toggleBusy = false;
      notify();
    }
  }

  function next(manual) {
    if (!state.queue.length) return;
    if (!manual && state.repeat === 'one' && state.current) {
      state.elapsed = 0;
      state.lastTick = Date.now();
      MV.api.seek(0);
      notify();
      return;
    }

    // Shuffle navigation — verbatim behaviour from the old player.
    if (state.shuffle) {
      if (state.shuffleHistoryIndex < state.shuffleHistory.length - 1) {
        state.shuffleHistoryIndex += 1;
        play(state.shuffleHistory[state.shuffleHistoryIndex], state.queue, {
          recordShuffleHistory: false
        });
        return;
      }

      if (state.queue.length > 1) {
        const availableSongs = state.queue.filter(
          (song) => trackKey(song) !== trackKey(state.current)
        );
        if (availableSongs.length) {
          const nextSongIndex = Math.floor(Math.random() * availableSongs.length);
          play(availableSongs[nextSongIndex], state.queue);
        }
      }
      return;
    }

    // Normal queue navigation.
    const currentIndex = state.queue.findIndex(
      (item) => trackKey(item) === trackKey(state.current)
    );
    let nextIndex = currentIndex + 1;
    if (nextIndex >= state.queue.length || currentIndex === -1) {
      if (state.repeat === 'all' || manual) nextIndex = 0;
      else {
        state.playing = false;
        state.elapsed = state.duration;
        MV.api.stop();
        notify();
        return;
      }
    }
    play(state.queue[nextIndex], state.queue);
  }

  function previous() {
    if (!state.queue.length) return;

    // Shuffle navigation — verbatim behaviour from the old player.
    if (state.shuffle) {
      if (state.shuffleHistoryIndex > 0) {
        state.shuffleHistoryIndex -= 1;
        play(state.shuffleHistory[state.shuffleHistoryIndex], state.queue, {
          recordShuffleHistory: false
        });
      }
      return;
    }

    // Normal queue navigation.
    const currentIndex = state.queue.findIndex(
      (item) => trackKey(item) === trackKey(state.current)
    );
    let previousIndex = currentIndex - 1;
    if (currentIndex === -1 || previousIndex < 0) previousIndex = state.queue.length - 1;
    play(state.queue[previousIndex], state.queue);
  }

  function seekRatio(ratio) {
    if (!state.current) return;
    const value = Math.max(0, Math.min(1, ratio));
    state.elapsed = Math.round(value * (state.duration || 0));
    state.lastTick = Date.now();
    MV.api.seek(state.elapsed);
    notify();
  }

  function setVolume(value) {
    state.volume = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    MV.store.setPreference('volume', state.volume);
    MV.api.setVolume(state.volume / 100);
    notify();
  }

  function toggleMute() {
    if (state.volume > 0) {
      state._previousVolume = state.volume;
      setVolume(0);
    } else {
      setVolume(state._previousVolume || 70);
    }
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    if (state.shuffle) {
      // Start history with the currently playing song.
      state.shuffleHistory = state.current ? [state.current] : [];
      state.shuffleHistoryIndex = state.shuffleHistory.length - 1;
    } else {
      state.shuffleHistory = [];
      state.shuffleHistoryIndex = -1;
    }
    MV.store.setPreference('shuffle', state.shuffle);
    notify();
    if (MV.ui.toast) MV.ui.toast(state.shuffle ? '⤨ Shuffle Mode On' : '⤨ Shuffle Mode Off');
  }

  function cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    state.repeat = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
    MV.store.setPreference('repeat', state.repeat);
    notify();
  }

  function enqueue(track) {
    const prepared = prepare(track);
    if (!prepared || state.queue.some((item) => String(item.id) === String(prepared.id))) {
      MV.ui.toast('Already in the queue.');
      return;
    }
    state.queue.push(prepared);
    MV.ui.toast('Added to the queue.');
    notify();
  }

  function removeFromQueue(index) {
    if (index === state.index) return;
    state.queue.splice(index, 1);
    if (index < state.index) state.index -= 1;
    notify();
  }

  function currentAlbum() {
    if (!state.current) return null;
    const title = state.current.album === 'Unknown album' ? state.current.title : state.current.album;
    const known = D.albums.find((album) =>
      String(album.title).toLowerCase() === String(title).toLowerCase());
    return {
      id: known ? known.id : 'album-' + D.hash(title + state.current.artist),
      title: title,
      artist: state.current.artist,
      cover: known ? known.cover : state.current.cover,
      kind: 'album'
    };
  }

  /* ---------------- progress loop ---------------- */

  setInterval(() => {
    const now = Date.now();
    const delta = Math.min(1, (now - state.lastTick) / 1000);
    state.lastTick = now;
    if (!state.current || !state.playing) return;

    if (MV.api.isLive()) {
      if (progressBusy) return;
      progressBusy = true;
      MV.api.progress().then((progress) => {
        progressBusy = false;
        if (!progress || !state.playing) return;
        state.duration = progress.total || state.duration;
        state.elapsed = progress.current;

        // Re-arm auto-advance only after the backend reports real playback.
        if (progress.state === 'playing') {
          autoAdvanceHandled = false;
          if (!flowOpened && MV.store.state.profile.flowAuto && MV.ui.openFlow) {
            flowOpened = true;
            MV.ui.openFlow();
          }
        }
        // "loading" is normal while a stream opens, so it must not flip the
        // play glyph back. A real pause is also ignored briefly after a resume.
        if (
          progress.state === 'paused' &&
          !toggleBusy &&
          Date.now() > pauseGraceUntil
        ) {
          state.playing = false;
          notify();
          return;
        }
        if (progress.state === 'ended' || progress.state === 'stopped') {
          if (autoAdvanceHandled) return;
          autoAdvanceHandled = true;
          next(false);
          return;
        }
        MV.ui.updateProgress(snapshot());
      }).catch(() => { progressBusy = false; });
    } else {
      state.elapsed += delta;
      if (state.duration && state.elapsed >= state.duration) {
        next(false);
        return;
      }
      MV.ui.updateProgress(snapshot());
    }
  }, 250);

  MV.player = {
    state,
    snapshot, trackKey,
    play, toggle, next, previous, seekRatio, setVolume, toggleMute,
    toggleShuffle, cycleRepeat, enqueue, removeFromQueue,
    currentAlbum, applyAccent, notify
  };
})(window.MV = window.MV || {});
