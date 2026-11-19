# MusicVer v1.0.0 — Windows guide

This guide is for the ready-to-run Windows build. You do **not** need Python to
use the downloaded app.

## 1. Download

1. Open the repository's **Releases** page:
   <https://github.com/R4un4kSoni/MusicVers/releases>
2. Find release **v1.0.0**.
3. Download either:
   - **MusicVer.exe** — the single-file app, or
   - **MusicVer-v1.0.0-windows.zip** — the app plus this guide and the
     dependency list.

The `.exe` is a 64-bit Windows application.

## 2. Install VLC (required for sound)

MusicVer uses VLC to play audio. Install the **64-bit** VLC player first:

- <https://www.videolan.org/vlc/download-windows.html>

Restart MusicVer after installing VLC. If VLC is installed somewhere unusual,
add the folder containing `libvlc.dll` to Windows' `PATH`.

## 3. Run the app

1. Put `MusicVer.exe` anywhere you like, for example `Desktop` or
   `Documents\MusicVer`.
2. Double-click it. The first launch may take 10–30 seconds while Windows
   unpacks the app to a temporary folder.
3. If Windows Defender SmartScreen says *"Windows protected your PC"*:
   - click **More info** → **Run anyway**.
   - The build is not code-signed yet, so this warning is expected.

> Tip: the first start is slower than later ones. This is normal for a
> single-file app.

## 4. First-time setup

- Open **Dynamic island → Account → Music library → Choose folder** (or
  **Library → Choose folder**) and select the folder with your songs.
- Use **Library → Scan** to add them to the local library.
- Streaming via JioSaavn needs an internet connection.
- Light/dark theme, profile picture, likes, playlists and saved albums are
  stored automatically.

## 5. Where your data lives

The packaged app never writes into the folder containing `MusicVer.exe`.
Your settings and library are stored here:

```text
C:\Users\<you>\AppData\Roaming\MusicVer\
├── neonwave.db          playlists, likes, library, play history
└── app_settings.json    theme, music folder, profile picture
```

To back up the app, copy that folder. To reset everything, close MusicVer and
delete that folder — a fresh one is created on the next launch.

Optional API keys can be placed in a `.env` file inside that folder. The
repository contains
[.env.example](https://github.com/R4un4kSoni/MusicVers/blob/main/.env.example)
showing the available keys.

## 6. Uninstall

1. Close MusicVer.
2. Delete `MusicVer.exe` (or the folder holding the extracted zip).
3. Optionally delete `C:\Users\<you>\AppData\Roaming\MusicVer\` to remove
   settings and library data.

## 7. Troubleshooting

| Problem | What to do |
| --- | --- |
| Window opens but there is no sound | Install 64-bit VLC, then restart MusicVer. |
| SmartScreen blocks the file | **More info → Run anyway**, or check the file's digital-signature warning in your organisation's policy. |
| Antivirus quarantines the exe | PyInstaller single-file apps are sometimes flagged heuristically. Add the folder to your antivirus exclusions. |
| Search returns no live results | Check your internet connection. MusicVer uses JioSaavn's public API, which can change without notice. The bundled demo catalogue still works offline. |
| Settings reset on every start | Make sure you can write to `%APPDATA%\MusicVer`. Running from a read-only network drive is not supported. |
| Black/empty window | Update your graphics driver, then restart. The app forces QtWebEngine's non-GBM path where needed. |

## 8. Building it yourself

See
[BUILD-WINDOWS.md](https://github.com/R4un4kSoni/MusicVers/blob/main/docs/BUILD-WINDOWS.md)
for the exact PyInstaller commands, or use the GitHub Actions workflow in
`.github/workflows/build-windows.yml` to produce the same release assets.
