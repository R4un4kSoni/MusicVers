/* ============================================================
   musicVer · cinematic word-synced lyrics

   Lyrics are metadata only. Enhanced LRC word stamps are used when
   present; ordinary synced lyrics get word times spread evenly
   across each line. The audio player remains the only clock.
   ============================================================ */

(function (MV) {
  'use strict';

  const CACHE_KEY = 'musicver.lyrics.cache.v1';
  const MAX_CACHED = 40;
  const BASE_WORD_SECONDS = 0.42;

  let view = null;
  let linesRoot = null;
  let titleNode = null;
  let artistNode = null;
  let sourceNode = null;
  let coverNode = null;
  let bgNode = null;
  let progressFill = null;
  let progressKnob = null;
  let elapsedNode = null;
  let totalNode = null;
  let micButton = null;
  let playButton = null;

  let currentKey = '';
  let currentTrack = null;
  let currentLines = [];
  let sourceLabel = '';
  let activeLineIndex = -1;
  let activeWordIndex = -1;
  let paintedLineIndex = -2;
  let paintedWordIndex = -2;
  let requestToken = 0;
  let userScrollUntil = 0;
  let lastSnapshot = null;
  let shiftToken = 0;

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

  /** The setting controls transition ease, never the playback clock. */
  function transitionSeconds() {
    const profile = MV.store && MV.store.state && MV.store.state.profile;
    const raw = Number(profile && profile.lyricsSwitchSpeed);
    const speed = Number.isFinite(raw) && raw > 0 ? Math.min(2.4, Math.max(0.6, raw)) : 1;
    return Math.min(0.75, Math.max(0.18, 0.45 / speed));
  }

  function reducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** Advanced settings can mute word highlighting; the published view lives in its own module. */
  function lyricSettings() {
    const profile = (MV.store && MV.store.state && MV.store.state.profile) || {};
    return { wordSync: profile.wordSync !== false };
  }

  function fmt(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
  }

  function stampSeconds(match) {
    const fraction = match[3] ? Number(match[3]) / Math.pow(10, match[3].length) : 0;
    return Number(match[1]) * 60 + Number(match[2]) + fraction;
  }

  function splitWords(text) {
    return String(text || '')
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean)
      .map((word) => ({ text: word, time: null }));
  }

  function fillWordTimes(lines) {
    lines.forEach((line, index) => {
      if (line.time == null) return;
      const words = Array.isArray(line.words) && line.words.length
        ? line.words
        : splitWords(line.text);
      words.forEach((word) => {
        if (word.time != null) word.time = Math.max(line.time, word.time);
      });

      if (!words.some((word) => word.time != null)) {
        const next = lines[index + 1];
        const lineEnd = next && next.time > line.time
          ? next.time
          : line.time + Math.max(1.4, Math.min(5, words.length * BASE_WORD_SECONDS));
        const span = Math.max(0.6, Math.min(lineEnd - line.time, words.length * BASE_WORD_SECONDS));
        words.forEach((word, wordIndex) => {
          word.time = line.time + (span * wordIndex) / Math.max(1, words.length);
        });
      } else {
        let previous = line.time;
        words.forEach((word) => {
          if (word.time == null || word.time < previous) word.time = previous;
          previous = word.time;
        });
      }
      line.words = words;
      line.text = words.map((word) => word.text).join(' ');
    });
    return lines;
  }

  /**
   * Reusable line helper. Lines with identical timestamps are kept; the last
   * matching entry is returned so the sync loop stays predictable.
   */
  function getActiveLyricIndex(lyrics, currentTime) {
    let activeIndex = -1;
    for (let i = 0; i < lyrics.length; i += 1) {
      if (Number(lyrics[i].time) <= currentTime) activeIndex = i;
      else break;
    }
    return activeIndex;
  }

  function getActiveWordIndex(line, currentTime) {
    if (!line || !Array.isArray(line.words) || line.time == null) return -1;
    let activeIndex = -1;
    for (let i = 0; i < line.words.length; i += 1) {
      const wordTime = line.words[i].time;
      if (wordTime == null) continue;
      if (wordTime <= currentTime) activeIndex = i;
      else break;
    }
    return activeIndex;
  }

  function parseLrc(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const wordStamp = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
    const parsed = [];

    raw.split(/\r?\n/).forEach((row) => {
      stamp.lastIndex = 0;
      const times = [];
      let match;
      while ((match = stamp.exec(row)) !== null) times.push(stampSeconds(match));
      if (!times.length) return;

      const body = row.replace(stamp, '').trim();
      if (!body) return;

      const words = [];
      wordStamp.lastIndex = 0;
      if (wordStamp.test(body)) {
        wordStamp.lastIndex = 0;
        let cursor = 0;
        let wordTime = null;
        let wordMatch;
        while ((wordMatch = wordStamp.exec(body)) !== null) {
          const text = body.slice(cursor, wordMatch.index).trim();
          if (text) words.push({ text: text, time: wordTime });
          wordTime = stampSeconds(wordMatch);
          cursor = wordStamp.lastIndex;
        }
        const tail = body.slice(cursor).trim();
        if (tail) words.push({ text: tail, time: wordTime });
      } else {
        words.push(...splitWords(body));
      }
      if (!words.length) words.push(...splitWords(body));

      times.forEach((time) => parsed.push({
        time: time,
        text: words.map((word) => word.text).join(' '),
        words: words.map((word) => ({ text: word.text, time: word.time }))
      }));
    });

    // Array#sort is stable in modern browsers, so identical timestamps keep
    // their original row order instead of collapsing into one entry.
    parsed.sort((a, b) => a.time - b.time);
    return fillWordTimes(parsed);
  }

  function plainLines(raw) {
    if (!raw || typeof raw !== 'string') return [];
    return raw.split(/\r?\n/)
      .map((row) => row.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((text) => ({ time: null, text: text, words: splitWords(text) }));
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

  function paintCover(node, track) {
    if (!node) return;
    if (MV.artwork) {
      MV.artwork.background(node, track, 'song');
      return;
    }
    const cover = MV.data && MV.data.normalizeCover
      ? MV.data.normalizeCover(track.cover, track.title, track.artist)
      : track.cover;
    node.style.backgroundImage = cover ? 'url("' + String(cover).replace(/"/g, '%22') + '")' : '';
  }

  function applyTrack(track) {
    if (!track) return;
    currentTrack = track;
    if (titleNode) titleNode.textContent = track.title || 'Untitled';
    if (artistNode) artistNode.textContent = track.artist || 'Unknown artist';
    paintCover(coverNode, track);
    paintCover(bgNode, track);
    if (view) view.style.setProperty('--lyrics-accent', track.accent || '#9b6cff');
  }

  function updateSourceLabel() {
    if (!sourceNode || !currentLines.length) return;
    const kind = currentLines[0].time == null
      ? 'Lyrics'
      : (lyricSettings().wordSync ? 'Word-synced lyrics' : 'Synced lyrics');
    sourceNode.textContent = sourceLabel ? kind + ' · ' + sourceLabel : kind;
  }

  function showMessage(text) {
    if (!linesRoot) return;
    currentLines = [];
    sourceLabel = '';
    activeLineIndex = -1;
    activeWordIndex = -1;
    paintedLineIndex = -2;
    paintedWordIndex = -2;
    userScrollUntil = 0;
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
      const words = Array.isArray(line.words) && line.words.length
        ? line.words
        : splitWords(line.text);
      const wordHtml = words.map((word, wordIndex) =>
        '<span class="lyric-word" data-word-index="' + wordIndex + '">' + esc(word.text) + '</span>'
      ).join(' ');
      return '<button type="button" class="lyric-line" data-lyric-index="' + index + '"' + seek + '>' +
        '<span class="lyric-line__text">' + wordHtml + '</span></button>';
    }).join('');
    updateSourceLabel();
    activeLineIndex = -1;
    activeWordIndex = -1;
    paintedLineIndex = -2;
    paintedWordIndex = -2;
    userScrollUntil = 0;
    linesRoot.scrollTop = 0;
    paint(-1, -1, true, false, -1, true);
  }

  function nearActiveLine(index) {
    if (!linesRoot || index < 0) return false;
    const node = linesRoot.querySelector('.lyric-line[data-lyric-index="' + index + '"]');
    if (!node) return false;
    const nodeRect = node.getBoundingClientRect();
    const rootRect = linesRoot.getBoundingClientRect();
    const distance = Math.abs(
      nodeRect.top + nodeRect.height / 2 - (rootRect.top + rootRect.height / 2)
    );
    return distance < rootRect.height * 0.32;
  }

  function centerLine(index, instant) {
    if (!linesRoot || index < 0) return;
    const node = linesRoot.querySelector('.lyric-line[data-lyric-index="' + index + '"]');
    if (!node) return;

    if (!instant && Date.now() < userScrollUntil) {
      if (nearActiveLine(index)) userScrollUntil = 0;
      else return;
    }

    const nodeRect = node.getBoundingClientRect();
    const rootRect = linesRoot.getBoundingClientRect();
    const target = Math.max(0, linesRoot.scrollTop +
      nodeRect.top - rootRect.top + nodeRect.height / 2 - rootRect.height / 2);
    const delta = target - linesRoot.scrollTop;
    if (Math.abs(delta) < 12) return;

    if (instant || reducedMotion()) {
      linesRoot.scrollTo({ top: target, behavior: 'auto' });
      return;
    }
    linesRoot.scrollTo({ top: target, behavior: 'smooth' });
  }

  function stretchLine(index) {
    if (index < 0 || !linesRoot || reducedMotion()) return;
    const node = linesRoot.querySelector('.lyric-line[data-lyric-index="' + index + '"]');
    if (!node) return;
    const token = String(++shiftToken);
    node.dataset.lyricShift = token;
    node.classList.remove('is-shifting');
    void node.offsetWidth;
    node.classList.add('is-shifting');
    const clear = () => {
      if (node.dataset.lyricShift !== token) return;
      node.classList.remove('is-shifting');
      delete node.dataset.lyricShift;
    };
    node.addEventListener('animationend', clear, { once: true });
    // Reduced motion cancels the animation before animationend can fire.
    setTimeout(clear, 620);
  }

  function paint(lineIndex, wordIndex, instant, lineChanged, previousIndex, forceCenter) {
    if (!linesRoot) return;
    const activeLine = lineIndex >= 0 ? currentLines[lineIndex] : null;
    const activeTime = activeLine && activeLine.time != null ? activeLine.time : null;
    const lineNodesChanged = lineIndex !== paintedLineIndex || wordIndex !== paintedWordIndex || instant;

    if (lineChanged && !instant) {
      stretchLine(previousIndex);
      stretchLine(lineIndex);
    }

    if (lineNodesChanged) {
      const nodes = linesRoot.querySelectorAll('.lyric-line');
      nodes.forEach((node, nodeIndex) => {
        const line = currentLines[nodeIndex];
        const isActiveLine = activeTime == null
          ? lineIndex === nodeIndex
          : line.time != null && Math.abs(line.time - activeTime) < 0.001;
        node.classList.toggle('is-active', isActiveLine);
        node.classList.toggle('is-past', !isActiveLine && lineIndex >= 0 && nodeIndex < lineIndex);
        if (isActiveLine) node.setAttribute('aria-current', 'true');
        else node.removeAttribute('aria-current');

        const words = node.querySelectorAll('.lyric-word');
        words.forEach((word, wordNodeIndex) => {
          const isActiveWord = isActiveLine && wordIndex >= 0 && wordNodeIndex === wordIndex;
          word.classList.toggle('is-word-past',
            isActiveLine && wordIndex >= 0 && wordNodeIndex < wordIndex);
          word.classList.toggle('is-word-active', isActiveWord);
        });
      });
      paintedLineIndex = lineIndex;
      paintedWordIndex = wordIndex;
    }

    // Scrolling follows line changes only, never individual words.
    if (lineChanged || instant || forceCenter) centerLine(lineIndex, Boolean(instant));
    if (instant) void linesRoot.offsetWidth;
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
    sourceLabel = data.source || (synced.length ? 'LRCLIB' : 'Local text');
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

    view.style.setProperty('--lyrics-morph', transitionSeconds().toFixed(3) + 's');

    const track = lastSnapshot.current;
    if (!track) {
      if (currentKey) {
        // Invalidate an in-flight lyrics request before clearing the view.
        requestToken += 1;
        showMessage('Play a song to see its lyrics.');
      }
      currentKey = '';
      return;
    }
    if (trackKey(track) !== currentKey) {
      load(track);
      return;
    }
    if (playButton) {
      if (MV.icon) playButton.innerHTML = MV.icon(lastSnapshot.playing ? 'pause' : 'play');
      else playButton.textContent = lastSnapshot.playing ? '❚❚' : '▶';
      playButton.setAttribute('aria-label', lastSnapshot.playing ? 'Pause' : 'Play');
    }

    const elapsed = Number(lastSnapshot.elapsed) || 0;
    const duration = Number(lastSnapshot.duration) || 0;
    if (progressFill) progressFill.style.width = (duration ? Math.min(100, elapsed / duration * 100) : 0).toFixed(2) + '%';
    if (progressKnob) progressKnob.style.left = (duration ? Math.min(100, elapsed / duration * 100) : 0).toFixed(2) + '%';
    if (elapsedNode) elapsedNode.textContent = fmt(elapsed);
    if (totalNode) totalNode.textContent = fmt(duration);

    if (!currentLines.length || currentLines[0].time == null) {
      if (paintedLineIndex !== -1 || paintedWordIndex !== -1 || instant) {
        paint(-1, -1, Boolean(instant), false, paintedLineIndex, false);
      }
      return;
    }

    // One authoritative clock: the player's real playback position.
    const lastMatch = getActiveLyricIndex(currentLines, elapsed);
    if (lastMatch < 0) {
      if (paintedLineIndex !== -1 || instant) {
        paint(-1, -1, Boolean(instant), false, paintedLineIndex, false);
      }
      return;
    }

    const activeTime = currentLines[lastMatch].time;
    const centerIndex = currentLines.findIndex((line) =>
      line.time != null && Math.abs(line.time - activeTime) < 0.001);
    const wordIndex = lyricSettings().wordSync
      ? getActiveWordIndex(currentLines[centerIndex], elapsed)
      : -1;
    const lineChanged = centerIndex !== paintedLineIndex;
    const wordChanged = wordIndex !== paintedWordIndex;
    activeLineIndex = centerIndex;
    activeWordIndex = wordIndex;

    let resumeNow = false;
    if (!instant && userScrollUntil > 0 && Date.now() >= userScrollUntil) {
      userScrollUntil = 0;
      resumeNow = true;
    }

    if (lineChanged || wordChanged || instant || resumeNow) {
      paint(centerIndex, wordIndex, Boolean(instant), lineChanged, paintedLineIndex, resumeNow);
      return;
    }

    if (!instant && userScrollUntil > 0 && nearActiveLine(centerIndex)) {
      userScrollUntil = 0;
      centerLine(centerIndex, false);
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

  /** Called by Advanced settings after either lyrics button changes. */
  function applySettings() {
    if (!view) return;
    const settings = lyricSettings();
    view.classList.toggle('is-word-off', !settings.wordSync);
    view.style.setProperty('--lyrics-morph', transitionSeconds().toFixed(3) + 's');
    updateSourceLabel();
    if (view.classList.contains('is-open') && lastSnapshot) {
      paintedWordIndex = -2;
      sync(lastSnapshot, true);
    }
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
    applySettings();
    const snap = MV.player.snapshot();
    applyTrack(snap.current);
    sync(snap, true);
    updateMic();
  }

  function close() {
    if (!view) return;
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

  function pauseAutoScroll() {
    userScrollUntil = Date.now() + 3200;
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
    bgNode = document.getElementById('lyrics-bg');
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
      linesRoot.addEventListener('wheel', pauseAutoScroll, { passive: true });
      linesRoot.addEventListener('touchstart', pauseAutoScroll, { passive: true });
    }
    applySettings();
    updateMic();
  }

  MV.lyrics = {
    init, open, close, toggle, isOpen, sync, applySettings,
    parseLrc, getActiveLyricIndex, getActiveWordIndex, trackKey
  };
})(window.MV = window.MV || {});
