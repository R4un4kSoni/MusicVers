/* ============================================================
   musicVer · interactive synced lyrics
   Frontend-only view. Metadata comes from LRCLIB (via the local
   bridge in the desktop build, direct fetch in the web build).
   ============================================================ */

(function (MV) {
  'use strict';

  const CACHE_KEY = 'musicver.lyrics.cache.v1';
  const MAX_CACHED = 40;
  const BASE_SWITCH_SECONDS = 0.9;

  let view = null;
  let linesRoot = null;
  let titleNode = null;
  let artistNode = null;
  let sourceNode = null;
  let coverNode = null;
  let progressFill = null;
  let progressKnob = null;
  let elapsedNode = null;
  let totalNode = null;
  let micButton = null;
  let playButton = null;

  let currentKey = '';
  let currentTrack = null;
  let currentLines = [];
  let activeIndex = -1;
  let requestToken = 0;
  let userScrollUntil = 0;
  let lastSnapshot = null;
  let scrollFrame = null;
  let lastPhase = -1;
  let focusIndex = -1;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function norm(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function trackKey(track) {
    if (!track) return '';
    return norm(track.artist) + '|' + norm(track.title);
  }

  /** User-controlled speed: higher is faster, so the morph window shrinks. */
  function switchWindow() {
    const profile = MV.store && MV.store.state && MV.store.state.profile;
    const raw = Number(profile && profile.lyricsSwitchSpeed);
    const speed = Number.isFinite(raw) && raw > 0 ? Math.min(2.4, Math.max(0.6, raw)) : 1;
    return BASE_SWITCH_SECONDS / speed;
  }

  function fmt(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
  }

  function parseLrc(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const parsed = [];
    raw.split(/\r?\n/).forEach((row) => {
      stamp.lastIndex = 0;
      const times = [];
      let match;
      while ((match = stamp.exec(row)) !== null) {
        const fraction = match[3] ? Number(match[3]) / Math.pow(10, match[3].length) : 0;
        times.push(Number(match[1]) * 60 + Number(match[2]) + fraction);
      }
      if (!times.length) return;
      const text = row.replace(stamp, '').trim();
      if (!text) return;
      times.forEach((time) => parsed.push({ time: time, text: text }));
    });
    parsed.sort((a, b) => a.time - b.time);
    return parsed;
  }

  function plainLines(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw.split(/\r?\n/)
      .map((row) => row.trim())
      .filter(Boolean)
      .map((text) => ({ time: null, text: text }));
  }

  function readCache(key) {
    try {
      const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      return stored && stored[key] ? stored[key] : null;
    } catch (error) {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
      stored[key] = value;
      const keys = Object.keys(stored);
      while (keys.length > MAX_CACHED) delete stored[keys.shift()];
      localStorage.setItem(CACHE_KEY, JSON.stringify(stored));
    } catch (error) {
      /* storage may be unavailable in private browsing */
    }
  }

  function applyTrack(track) {
    if (!track) return;
    currentTrack = track;
    if (titleNode) titleNode.textContent = track.title || 'Untitled';
    if (artistNode) artistNode.textContent = track.artist || 'Unknown artist';
    if (coverNode) {
      if (MV.artwork) MV.artwork.background(coverNode, track, 'song');
      else {
        const cover = MV.data && MV.data.normalizeCover
          ? MV.data.normalizeCover(track.cover, track.title, track.artist)
          : track.cover;
        coverNode.style.backgroundImage = cover ? 'url("' + String(cover).replace(/"/g, '%22') + '")' : '';
      }
    }
    if (view) view.style.setProperty('--lyrics-accent', track.accent || '#8b6cff');
  }

  function showMessage(text) {
    if (!linesRoot) return;
    currentLines = [];
    activeIndex = -1;
    lastPhase = -1;
    focusIndex = -1;
    stopScroll();
    linesRoot.innerHTML = '<p class="lyrics-empty">' + esc(text) + '</p>';
    linesRoot.scrollTop = 0;
    if (sourceNode) sourceNode.textContent = '';
  }

  function renderLines() {
    if (!linesRoot) return;
    if (!currentLines.length) {
      showMessage('Lyrics are not available for this song.');
      return;
    }
    linesRoot.innerHTML = currentLines.map((line, index) => {
      const seek = line.time == null ? '' : ' data-lyric-time="' + line.time.toFixed(2) + '"';
      return '<button type="button" class="lyric-line" data-lyric-index="' + index + '"' + seek + '>' +
        '<span>' + esc(line.text) + '</span></button>';
    }).join('');
    if (sourceNode) {
      sourceNode.textContent = currentLines[0].time == null
        ? 'Plain lyrics · synced timing unavailable'
        : 'Synced lyrics · tap a line to jump there';
    }
    activeIndex = -1;
    lastPhase = -1;
    focusIndex = -1;
    stopScroll();
    paint(0);
    linesRoot.scrollTop = 0;
  }

  // `phase` stays at 0 for most of a line, then ramps through the final
  // switch window. That keeps the active line steady, then moves the
  // focus quickly onto the next one without a hard cut at the timestamp.
  function paint(phase) {
    if (!linesRoot) return;
    const flow = Math.min(1, Math.max(0, Number(phase) || 0));
    const visual = activeIndex + (flow >= 0.5 && currentLines[activeIndex + 1] ? 1 : 0);
    const nodes = linesRoot.querySelectorAll('.lyric-line');
    nodes.forEach((node, index) => {
      const distance = Math.abs(index - activeIndex - flow);
      node.classList.toggle('is-active', index === visual);
      node.classList.toggle('is-past', index < visual);
      node.style.setProperty('--lyric-scale', Math.max(0.45, 1 - distance * 0.4).toFixed(3));
      node.style.setProperty('--lyric-tilt', Math.min(40, distance * 26).toFixed(1) + 'deg');
      node.style.setProperty('--lyric-blur', Math.min(2.8, distance * 1.8).toFixed(2) + 'px');
      node.style.setProperty('--lyric-opacity', Math.max(0.22, 1 - distance * 0.4).toFixed(2));
    });
  }

  function stopScroll() {
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  }

  function centerLine(index, instant) {
    if (!linesRoot || index < 0) return;
    if (!instant && Date.now() < userScrollUntil) return;
    const node = linesRoot.querySelector('.lyric-line[data-lyric-index="' + index + '"]');
    if (!node) return;
    const target = Math.max(0, node.offsetTop + node.offsetHeight / 2 - linesRoot.clientHeight / 2);
    stopScroll();
    if (instant) {
      linesRoot.scrollTop = target;
      return;
    }
    const start = linesRoot.scrollTop;
    const delta = target - start;
    if (Math.abs(delta) < 1) return;
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 620);
      const eased = t * t * (3 - 2 * t);
      linesRoot.scrollTop = start + delta * eased;
      if (t < 1) scrollFrame = requestAnimationFrame(step);
      else scrollFrame = null;
    };
    scrollFrame = requestAnimationFrame(step);
  }

  async function load(track) {
    if (!track || !track.title) return;
    const key = trackKey(track);
    if (key === currentKey && currentLines.length) return;
    currentKey = key;
    applyTrack(track);
    const token = ++requestToken;
    showMessage('Loading lyrics…');

    let data = readCache(key);
    if (!data && MV.api && MV.api.syncedLyrics) {
      try {
        data = await MV.api.syncedLyrics(track);
      } catch (error) {
        data = null;
      }
    }
    if (token !== requestToken) return;
    if (!data) {
      showMessage('Lyrics are not available for this song.');
      return;
    }

    writeCache(key, data);
    const synced = parseLrc(data.synced);
    const plain = synced.length ? [] : plainLines(data.plain);
    currentLines = synced.length ? synced : plain;
    if (sourceNode) sourceNode.textContent = data.source || (synced.length ? 'LRCLIB' : 'Plain lyrics');
    if (!currentLines.length) {
      showMessage('Lyrics are not available for this song.');
      return;
    }
    renderLines();
    if (lastSnapshot) sync(lastSnapshot, true);
  }

  function sync(snap, instant) {
    lastSnapshot = snap || MV.player.snapshot();
    if (micButton) micButton.classList.toggle('is-playing', Boolean(lastSnapshot.playing));
    if (!view || !view.classList.contains('is-open')) return;
    view.style.setProperty(
      '--lyrics-morph',
      Math.min(0.36, Math.max(0.12, switchWindow() * 0.3)).toFixed(3) + 's'
    );
    const track = lastSnapshot.current;
    if (!track) {
      if (currentKey) showMessage('Play a song to see its lyrics.');
      currentKey = '';
      return;
    }
    if (trackKey(track) !== currentKey) {
      load(track);
      return;
    }
    if (playButton) {
      playButton.textContent = lastSnapshot.playing ? '❚❚' : '▶';
      playButton.setAttribute('aria-label', lastSnapshot.playing ? 'Pause' : 'Play');
    }

    const elapsed = Number(lastSnapshot.elapsed) || 0;
    const duration = Number(lastSnapshot.duration) || 0;
    if (progressFill) progressFill.style.width = (duration ? Math.min(100, elapsed / duration * 100) : 0).toFixed(2) + '%';
    if (progressKnob) progressKnob.style.left = (duration ? Math.min(100, elapsed / duration * 100) : 0).toFixed(2) + '%';
    if (elapsedNode) elapsedNode.textContent = fmt(elapsed);
    if (totalNode) totalNode.textContent = fmt(duration);

    if (!currentLines.length || currentLines[0].time == null) return;
    const position = elapsed + 0.12;
    let next = 0;
    for (let index = 0; index < currentLines.length; index += 1) {
      if (currentLines[index].time <= position) next = index;
      else break;
    }
    const current = currentLines[next];
    const upcoming = currentLines[next + 1];
    let phase = 0;
    if (upcoming && current && upcoming.time > current.time) {
      const remaining = upcoming.time - position;
      const window = Math.min(switchWindow(), (upcoming.time - current.time) * 0.5);
      if (remaining < window) {
        const u = Math.min(1, Math.max(0, 1 - remaining / window));
        phase = u * u * (3 - 2 * u);
      }
    }
    const changed = next !== activeIndex;
    if (changed) activeIndex = next;
    const focus = phase > 0 && upcoming ? next + 1 : next;
    if (focus !== focusIndex) {
      focusIndex = focus;
      centerLine(focus, Boolean(instant));
    }
    if (changed || Math.abs(phase - lastPhase) > 0.01) {
      lastPhase = phase;
      paint(phase);
    }
  }

  function updateMic() {
    if (!micButton) return;
    const open = Boolean(view && view.classList.contains('is-open'));
    micButton.classList.toggle('is-active', open);
    micButton.setAttribute('aria-pressed', String(open));
    micButton.setAttribute('aria-label', open ? 'Close lyrics' : 'Lyrics');
    micButton.title = open ? 'Close lyrics' : 'Lyrics';
  }

  function open() {
    if (!MV.player.state.current) {
      if (MV.ui && MV.ui.toast) MV.ui.toast('Play a song to see its lyrics.');
      return;
    }
    if (!view) return;
    view.classList.add('is-open');
    view.setAttribute('aria-hidden', 'false');
    view.inert = false;
    const snap = MV.player.snapshot();
    applyTrack(snap.current);
    sync(snap, true);
    updateMic();
    requestAnimationFrame(() => centerLine(focusIndex, true));
  }

  function close() {
    if (!view) return;
    // Keep focus out of the subtree before aria-hidden is applied.
    if (MV.ui && MV.ui.releaseFocus) MV.ui.releaseFocus(view, '#flow-lyrics-open, #top-flow');
    view.classList.remove('is-open');
    view.setAttribute('aria-hidden', 'true');
    view.inert = true;
    updateMic();
  }

  function toggle() {
    if (view && view.classList.contains('is-open')) close();
    else open();
  }

  function isOpen() {
    return Boolean(view && view.classList.contains('is-open'));
  }

  function seekFromEvent(event) {
    const line = event.target.closest && event.target.closest('[data-lyric-time]');
    if (!line) return;
    const time = Number(line.dataset.lyricTime);
    const duration = Number((MV.player.snapshot() || {}).duration) || 0;
    if (!time || !duration || !MV.player.seekRatio) return;
    MV.player.seekRatio(Math.min(1, time / duration));
    event.stopPropagation();
  }

  function seekFromBar(event) {
    const bar = event.currentTarget;
    const rect = bar.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
    if (MV.player.seekRatio) MV.player.seekRatio(ratio);
  }

  function init() {
    if (document.documentElement.dataset.lyricsReady) return;
    document.documentElement.dataset.lyricsReady = '1';

    view = document.getElementById('lyrics-view');
    if (!view) return;
    view.inert = !view.classList.contains('is-open');
    linesRoot = document.getElementById('lyrics-lines');
    titleNode = document.getElementById('lyrics-title');
    artistNode = document.getElementById('lyrics-artist');
    sourceNode = document.getElementById('lyrics-source');
    coverNode = document.getElementById('lyrics-cover');
    progressFill = document.getElementById('lyrics-progress-fill');
    progressKnob = document.getElementById('lyrics-progress-knob');
    elapsedNode = document.getElementById('lyrics-elapsed');
    totalNode = document.getElementById('lyrics-total');
    micButton = document.getElementById('lyrics-launch');

    const closeButton = document.getElementById('lyrics-close');
    if (closeButton) closeButton.onclick = close;
    playButton = document.getElementById('lyrics-play');
    if (playButton) playButton.onclick = () => MV.player.toggle();
    const prevButton = document.getElementById('lyrics-prev');
    if (prevButton) prevButton.onclick = () => MV.player.previous();
    const nextButton = document.getElementById('lyrics-next');
    if (nextButton) nextButton.onclick = () => MV.player.next(true);
    const bar = document.getElementById('lyrics-progress');
    if (bar) bar.onclick = seekFromBar;
    if (linesRoot) {
      linesRoot.addEventListener('click', seekFromEvent);
      linesRoot.addEventListener('wheel', () => { userScrollUntil = Date.now() + 2600; }, { passive: true });
      linesRoot.addEventListener('touchstart', () => { userScrollUntil = Date.now() + 2600; }, { passive: true });
    }
    updateMic();
  }

  MV.lyrics = { init, open, close, toggle, isOpen, sync, parseLrc, trackKey };
})(window.MV = window.MV || {});
