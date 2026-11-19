"""Frozen-aware paths for MusicVer.

In development everything stays under ``<project>/data`` exactly as before.
In a PyInstaller onefile build the bundled source lives in a temporary
``_MEI...`` folder, so user data must be redirected to a writable per-user
location instead.
"""

import os
import sys
from pathlib import Path

APP_NAME = "MusicVer"
IS_FROZEN = bool(getattr(sys, "frozen", False))

# Read-only asset root (the project root in dev, _MEI... in a frozen build).
BUNDLE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))

DEV_DATA_DIR = Path(__file__).resolve().parents[1] / "data"

if IS_FROZEN and sys.platform == "win32":
    # Roaming follows the user across machines on domain profiles.
    DATA_DIR = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming")) / APP_NAME
    CACHE_DIR = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")) / APP_NAME
    TEMP_DIR = DATA_DIR / "temp"
else:
    DATA_DIR = DEV_DATA_DIR
    CACHE_DIR = DEV_DATA_DIR / "cache"
    # Preserve the current system-temp behaviour in development.
    TEMP_DIR = None

DB_PATH = DATA_DIR / "neonwave.db"
SETTINGS_PATH = DATA_DIR / "app_settings.json"
ENV_PATH = DATA_DIR / ".env"
WEBVIEW_STORAGE = CACHE_DIR / "webview"


def ensure_dirs():
    """Create the writable directories the app needs at startup."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    WEBVIEW_STORAGE.mkdir(parents=True, exist_ok=True)
    if TEMP_DIR is not None:
        TEMP_DIR.mkdir(parents=True, exist_ok=True)
