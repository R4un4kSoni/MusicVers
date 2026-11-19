# Building the Windows release

The repository ships everything needed to reproduce the v1.0.0 Windows build.

## Layout

```text
packaging/windows/
├── musicver.spec         PyInstaller recipe (onefile, windowed app)
├── musicver-icon.svg     editable icon source
├── musicver.ico          Windows icon used by the .exe
└── build.bat             one-click local build
```

## Option A — local build on Windows

Requirements: Windows 10/11 (64-bit), Python 3.12, Git.

```bat
git clone https://github.com/R4un4kSoni/MusicVers.git
cd MusicVers
python -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r requirements-build.txt
packaging\windows\build.bat
```

The finished file is `dist\MusicVer.exe`.

## Publishing a new release

After building, upload `dist\MusicVer.exe` to a GitHub release for the version
tag. A ZIP containing the exe, `docs/WINDOWS-GUIDE.md`,
`docs/THIRD-PARTY-NOTICES.md` and `requirements.txt` is also published so users
get the guide with the download.

## Notes for maintainers

- Keep `requirements.txt` pinned; the workflow installs it verbatim.
- The spec bundles only `f-3/` (the default interface). Legacy frontends are
  intentionally excluded from the download.
- User data is written to `%APPDATA%\MusicVer`, not beside the exe.
- VLC is **not** bundled. Users must install 64-bit VLC themselves.
- The app is not code-signed, so Windows SmartScreen will show a first-run
  warning. Code signing requires a certificate and is a future enhancement.
