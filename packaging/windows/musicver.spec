# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller recipe for the MusicVer v1.0.0 Windows executable.

Build from the project root:

    python -m PyInstaller --noconfirm --clean packaging/windows/musicver.spec
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

# SPECPATH is packaging/windows; project root is two levels up.
SPECPATH = Path(SPECPATH)
PROJECT_ROOT = SPECPATH.parent.parent
ICON = SPECPATH / "musicver.ico"
ENTRY = PROJECT_ROOT / "main.py"

hidden_imports = [
    # pywebview imports its platform backend and HTTP layer lazily.
    "webview",
    "webview.http",
    "webview.js",
    "webview.platforms.qt",
    # pywebview talks to Qt through qtpy.
    "qtpy",
    "qtpy.QtCore",
    "qtpy.QtWidgets",
    "qtpy.QtNetwork",
    "qtpy.QtWebChannel",
    "qtpy.QtWebEngineCore",
    "qtpy.QtWebEngineWidgets",
    # QtWebEngine needs these at runtime even when not imported directly.
    "PySide6.QtCore",
    "PySide6.QtGui",
    "PySide6.QtWidgets",
    "PySide6.QtNetwork",
    "PySide6.QtQml",
    "PySide6.QtQuick",
    "PySide6.QtWebChannel",
    "PySide6.QtWebEngineCore",
    "PySide6.QtWebEngineWidgets",
    "PySide6.QtWebEngineQuick",
    # Supporting libraries.
    "bottle",
    "dotenv",
    "vlc",
    "certifi",
]
hidden_imports += collect_submodules("backend")
hidden_imports += collect_submodules("webview.platforms")

datas = [
    (str(PROJECT_ROOT / "f-3"), "f-3"),
]

block_cipher = None

a = Analysis(
    [str(ENTRY)],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "PyQt6",
        "PyQt5",
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "pytest",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="MusicVer",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="x86_64",
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ICON),
)
