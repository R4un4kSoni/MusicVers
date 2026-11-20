# musicVer Web

The static web build is published with GitHub Pages:

**<https://r4un4ksoni.github.io/MusicVers/>**

It uses the same `musicVer` interface as the Windows app, but runs entirely in
the browser. No Python, VLC, or server account is required.

## What works on the web

- Browse live catalogue data from JioSaavn and Apple Music: trending songs,
  albums, artists, charts and genre chips.
- Search songs, albums and artists — including international/mainstream artists
  such as Joji, The Weeknd, Billie Eilish and Taylor Swift — then open artist
  and album pages.
- Stream real audio directly in the browser with play/pause, seek, volume,
  queue, shuffle, repeat and auto-advance. JioSaavn tracks play in full where
  available; international tracks use official Apple Music **30-second
  previews** because full streaming is region/licence restricted.
- Likes, saved albums, playlists, playlist covers, profile picture, light/dark
  theme, volume, search history and recently played items.
- Flow State, ambient accents and the dynamic island navigation.
- Choose a local music folder (Chrome/Edge) or select local audio files
  (other browsers). Files stay on your device and are never uploaded.

## Where your data is saved

All account-related data lives in your browser's local storage under the key
`musicver.f3.v1`. A small offline cache of song metadata/stream URLs is kept in
`musicver.web.cache.v1`, and an optional folder handle is kept in IndexedDB.

Nothing is sent to this project's server. The app has no backend and no login.

Important consequences:

- Data is **per browser and per device**. Clearing site data, using a different
  browser, or switching devices starts with a fresh library.
- The desktop Windows app uses its own local database, so it does not share
  data with the web build.
- Local audio files are read only after you grant folder/file access. Browsers
  do not allow a page to permanently keep raw file access across restarts;
  reselect the folder if a local track cannot play after a reload.
- Profile pictures are stored as compressed data URLs. Very large images may
  hit the browser's roughly 5 MB local-storage quota.

## Listening to music

Click any song to play it. The web build resolves direct CORS-enabled audio
streams and uses a normal HTML audio element, so playback and seeking work
without VLC. If a stream is blocked by the provider, the player tries the next
available quality and then falls back to cached or bundled demo tracks.

A small bundled catalogue is included as an offline fallback. Live catalogue
and audio require an internet connection. JioSaavn data comes from the
unofficial `saavn.sumit.co` mirror, while international/mainstream results come
from Apple Music's public iTunes Search API. Both services can change or
rate-limit without notice; this project is a portfolio demo, not a commercial
streaming service. Apple Music previews are intentionally limited to 30 seconds.

## Browser support

- **Best:** current Chrome or Edge. Folder access uses the File System Access
  API and can be remembered after you grant permission.
- **Also works:** Firefox and Safari. Use the file picker to select multiple
  audio files instead of a whole folder.
- JavaScript and `localStorage` must be enabled. Private/incognito windows may
  discard saved data when closed.

## Clearing web data

Open the site, then use your browser's site-data controls, or run this in the
developer console:

```js
localStorage.removeItem('musicver.f3.v1');
localStorage.removeItem('musicver.web.cache.v1');
localStorage.removeItem('musicver.web.discovery.v1');
localStorage.removeItem('musicver.web.localLibrary.v1');
localStorage.removeItem('musicver.web.folderName');
indexedDB.deleteDatabase('musicver-web');
location.reload();
```

## Relationship to the Windows release

The Windows release is still available at
<https://github.com/R4un4kSoni/MusicVers/releases/tag/v1.0.0>. It uses Python,
pywebview and VLC, and its data is stored in the Windows app's own local files.
The web build is a separate static deployment under `docs/`.
