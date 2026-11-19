import os
import sys

# QtWebEngine 6.12 can abort in its OpenGL texture-cleanup callback with
# "Failed to restore OpenGL context after clean-up" on Linux/Wayland when the
# GBM-backed graphics path is used. Prefer the non-GBM path by default; an
# explicit environment setting still wins for debugging.
if sys.platform.startswith("linux"):
    os.environ.setdefault("QTWEBENGINE_FORCE_USE_GBM", "0")

# pywebview reaches Qt through qtpy. Force PySide6 so the frozen build ships
# exactly one Qt stack.
os.environ.setdefault("QT_API", "pyside6")

import webview

from backend.app_paths import BUNDLE_DIR, WEBVIEW_STORAGE, ensure_dirs
from backend.api import NeonWaveAPI
from backend.settings_store import get_theme
from backend.video_host import VideoHostBridge


BASE_DIR = BUNDLE_DIR
ensure_dirs()

# musicVer (f-3) is the default. Set NEONWAVE_UI=old/v1/v2 to launch one of
# the earlier interfaces instead. Nothing is deleted or overwritten.
UI_CHOICE = os.environ.get("NEONWAVE_UI", "f3").strip().lower()
LEGACY_V1_NAMES = {"old", "classic", "legacy", "frontend", "v1"}
LEGACY_V2_NAMES = {"v2", "frontend_v2"}

if UI_CHOICE in LEGACY_V1_NAMES:
    FRONTEND_NAME = "frontend"
elif UI_CHOICE in LEGACY_V2_NAMES:
    FRONTEND_NAME = "frontend_v2"
else:
    FRONTEND_NAME = "f-3"

FRONTEND_DIR = BASE_DIR / FRONTEND_NAME
HTML_FILE = FRONTEND_DIR / "index.html"
URL = str(HTML_FILE)
WINDOW_BG = "#121317" if get_theme() == "dark" else "#e8eee9"

api = NeonWaveAPI()


def main():
    bridge = VideoHostBridge()
    bridge.api = api

    window = webview.create_window(
        title="MusicVer",
        url=URL,
        width=1280,
        height=840,
        min_size=(960, 640),
        background_color=WINDOW_BG,
        js_api=api
    )

    # The shown event runs outside Qt's GUI thread.
    # VideoHostBridge safely forwards it to Qt using a signal.
    window.events.shown += bridge.request_initialize

    webview.start(
        gui="qt",
        debug=bool(os.environ.get("MUSICVER_DEBUG")),
        http_server=True,
        storage_path=str(WEBVIEW_STORAGE),
        private_mode=False,
    )


if __name__ == "__main__":
    main()
