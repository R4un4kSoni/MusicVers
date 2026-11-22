# musicVer Web

The static web build is published with GitHub Pages:

**<https://r4un4ksoni.github.io/MusicVers/>**

It uses the same `musicVer` interface as the Windows app, but runs entirely in
the browser. No Python, VLC, or server account is required. A large V-beta
notice appears when the web app opens because this build is still being
finished; use its × button to dismiss it.

## What works on the web

- Browse live catalogue data from JioSaavn and Apple Music: trending songs,
  albums, artists, charts and genre chips.
- Search songs, albums and artists — including international/mainstream artists
  such as Joji, The Weeknd, Billie Eilish and Taylor Swift — then open artist
  and album pages.
- Stream real audio directly in the browser with play/pause, seek, volume,
  queue, shuffle, repeat and auto-advance. Search results are resolved live to
  full-length JioSaavn originals for any artist available in JioSaavn, including
  Steve Lacy, Doechii and Tame Impala. A bundled ID map also pins popular songs
  and whole albums such as Joji's *SMITHEREENS*, Hans Zimmer's *Inception* and
  The Weeknd's *After Hours*. There is no external video fallback.
- Likes, saved albums, playlists, playlist covers, profile picture, light/dark
  theme, volume, search history and recently played items.
- Trending songs and the Hindi/English mixes open a generated 50-song mix page
  and take you straight to that mix. Album cards open a 50-album catalogue you
  can keep browsing.
- Spotify-style **Listening Stats** live in their own tab. Every play is counted
  locally, and the stats view shows monthly totals, top songs, top artists and
  total plays in a wrapped-style story you can page through.
- The Account tab shows your profile picture and name in a classic font, with an
  Edit button underneath for changing or removing the picture and changing the
  name. On small screens the bottom tabs show the selected picture instead of
  the account label, and the mini player is compact like the Spotify app.
- Flow State, ambient accents and the dynamic island navigation. Page switches
  use a short blur-in with no sliding. The top-right actions are collected in a
  single three-dot menu. On Android and other small screens, the dynamic island
  is replaced by a bottom tab bar, the layout is more compact, and the layout
  adapts for touch.
- The player's microphone button opens interactive synced lyrics: the active
  line stays large and sharp while nearby lines shrink, tilt and blur. Tap a
  line to seek to that moment. Spotify recommendations are no longer shown in
  the queue.
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

A small bundled catalogue and a generated JioSaavn ID map are included with the
static build. Live catalogue and audio require an internet connection. Search
uses a CORS-enabled JioSaavn-compatible API at runtime, so full-length
`aac.saavncdn.com` streams are found dynamically rather than being limited to the
bundled map. Apple Music's public iTunes Search API is used for metadata only;
even an older 30-second iTunes result is upgraded to a matching JioSaavn original
when played. The bundled map is produced with `tools/build_web_jio_catalog.py`
and is only a fast fallback. These unofficial services can change or rate-limit
without notice; this project is a portfolio demo, not a commercial streaming
service.

## Artwork reliability

All covers, thumbnails, avatars and blurred artwork backgrounds now go through
one `MV.artwork` module in `js/artwork.js`. It normalises provider URLs (HTTPS,
higher-resolution CDN sizes), keeps provider-verified matches indexed by track,
album, artist, ISRC and Spotify ID, and shows a generated local placeholder
while a remote image is loading. If a URL fails, the manager tries the next
verified source and finally keeps the placeholder, so broken-image icons are
never shown. Visible artwork is loaded first, duplicate requests are shared, and
no more than four image requests run at once.

Working artwork bytes are cached in IndexedDB (`musicver-artwork-v2`) for 14 days
when the image CDN allows CORS. If CORS is blocked, the image still displays
normally but cannot be stored as a blob. Cache failures never stop rendering.
To reset artwork storage, delete the `musicver-artwork-v2` database in site data.

GitHub Pages does not need a backend. An optional, allowlisted Cloudflare Worker
example is included at `worker/artwork-proxy.example.js`. It is disabled by
default; only deploy it if you want validated CDN fetching and longer shared
cache headers, then enable it from the console with:

```js
MV.artwork.configure({
  allowProxy: true,
  proxyEndpoint: 'https://your-worker.example.com/image'
});
```

Never point it at an open or unrestricted image proxy.

## Spotify playlist import

Account → **SPOTIFY CATALOGUE → Import a playlist** lists the signed-in user's
Spotify playlists and copies the chosen playlist into the local Library. First
create an app in the Spotify Developer Dashboard, paste its Client ID into
**SPOTIFY CATALOGUE**, and register the exact redirect URI shown below the field
(including the trailing slash) in that app's Redirect URIs settings. The app must
run on HTTPS or `127.0.0.1`; `localhost` and opening `index.html` directly are
not valid redirect URIs.

The browser PKCE sign-in asks for `playlist-read-private` and
`playlist-read-collaborative`; playlists need this extra permission, so an older
Spotify connection must be reconnected once. Only names, covers and track
metadata are stored locally (no client secret and no Spotify audio). Imported
tracks are still matched to full-length JioSaavn streams at play time, and
Apple/Spotify 30-second previews are never used. After the reconnect, the import
picker reopens automatically. Spotify only allows reading the items of playlists
you own or collaborate on, so duplicate any followed playlist in Spotify before
importing your copy.

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
indexedDB.deleteDatabase('musicver-artwork-v2');
location.reload();
```

## Relationship to the Windows release

The current portable Windows release is
[v1.1.1](https://github.com/R4un4kSoni/MusicVers/releases/tag/v1.1.1). It is a
single-file Electron build that needs no installation and removes the page slide
animations. The earlier
[v1.1.0](https://github.com/R4un4kSoni/MusicVers/releases/tag/v1.1.0) and
[v1.0.0](https://github.com/R4un4kSoni/MusicVers/releases/tag/v1.0.0) releases
are left unchanged. The web build is a separate static deployment under `docs/`.
