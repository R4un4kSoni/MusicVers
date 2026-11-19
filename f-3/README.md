# musicVer · f-3

A completely new interface for the music app. Nothing in `frontend/` or
`frontend_v2/` is used or modified. See the repository `README.md` for
screenshots and the full feature guide.

## Run it

```bash
python main.py
```

`python f-3/main.py` also works as a standalone launcher. Both open a
pywebview window wired to the existing Python engine, so search, streaming
playback, likes, saved albums, playlists, dark mode and the local folder all
work. The earlier interfaces remain available with
`NEONWAVE_UI=v2 python main.py` (or `NEONWAVE_UI=old` for the first one).

You can also open `f-3/index.html` directly in a browser for a silent preview
of the layout. In preview mode the catalogue is a curated local demo set and
playback progress is simulated.

## What's inside

- **Dynamic island** — no sidebar. Move the pointer to the left edge and the
  glass "musicVer" island unfolds into Home, Library, Discover and Account.
- **Home** — cinematic hero slider for latest hits and new albums, followed by
  Spotify-style horizontal shelves for recently played, trending, albums,
  Hindi songs and English songs. Cards scroll with snapped arrows and respond
  to pointer hover.
- **Discover** — centred search with blue/red corner glow, recent searches,
  and results ordered as songs → artists → albums.
- **Library** — Liked / Saved / Create playlist, a "Your playlist" grid with a
  `+` button, and a `↓` button on every album to save it to Saved. Playlist
  covers can be chosen from your PC (resized and stored locally).
- **Account** — editable local profile, listening preferences, housekeeping
  actions, folder picker, and clearly marked *Coming soon* features.
- **Player** — play/pause, prev/next, shuffle, repeat (off/all/one), seek,
  volume/mute, queue and like. The whole room is tinted from the current cover
  art (sampled with a canvas, with a deterministic fallback).
- **Queue** — a glass drawer with now-playing art, animated levels, track
  numbers, durations and a reliable close button.
- **Dark mode** — use the moon button in the header or the Account switch. The
  layout breaks into squares and each tile flips to the new theme. Your choice
  is saved by the Python backend.
- **Flow State** — double-click the player (or press the expand button) for a
  full-screen immersive now-playing view.

## Files

```
f-3/
  index.html          markup for every page, player and overlay
  css/base.css        tokens, typography, buttons, ambient background
  css/layout.css      island, page grid, hero, account, flow, modals
  css/components.css  cards, rows, search, player, queue
  js/data.js          demo catalogue + normalisers + generated covers
  js/store.js         localStorage state (likes, saved albums, playlists…)
  js/api.js           pywebview bridge with browser-preview fallback
  js/player.js        playback state, queue, progress and cover colours
  js/ui.js            rendering and interactions
  js/app.js           bootstrap
  main.py             desktop launcher
```
