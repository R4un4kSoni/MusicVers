"""Launch the musicVer (f-3) desktop interface.

    python f-3/main.py

This is a standalone entry point. It reuses the app's existing Python
engine for real playback, search and library persistence, but does not
touch any of the older frontend folders.
"""

import os
import sys
from pathlib import Path

# QtWebEngine 6.12 can abort in its OpenGL texture-cleanup callback with
# "Failed to restore OpenGL context after clean-up" on Linux/Wayland when the
# GBM-backed graphics path is used. Prefer the non-GBM path by default; an
# explicit environment setting still wins for debugging.
if sys.platform.startswith("linux"):
    os.environ.setdefault("QTWEBENGINE_FORCE_USE_GBM", "0")

# pywebview reaches Qt through qtpy. Force PySide6 so the frozen build ships
# exactly one Qt stack.
os.environ.setdefault("QT_API", "pyside6")

IS_FROZEN = bool(getattr(sys, "frozen", False))

if not IS_FROZEN:
    ROOT = Path(__file__).resolve().parent.parent
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))

from backend.app_paths import (  # noqa: E402
    BUNDLE_DIR,
    WEBVIEW_STORAGE,
    ensure_dirs,
)

HERE = BUNDLE_DIR / "f-3" if IS_FROZEN else Path(__file__).resolve().parent

import webview  # noqa: E402

from backend.api import NeonWaveAPI  # noqa: E402
from backend.settings_store import get_theme  # noqa: E402
from backend.video_host import VideoHostBridge  # noqa: E402

ensure_dirs()

HTML_FILE = HERE / "index.html"
WINDOW_BG = "#121317" if get_theme() == "dark" else "#f7f5f1"


def main():
    api = NeonWaveAPI()
    bridge = VideoHostBridge()
    bridge.api = api

    window = webview.create_window(
        title="musicVer — your sound, your space",
        url=str(HTML_FILE),
        width=1440,
        height=900,
        min_size=(960, 660),
        background_color=WINDOW_BG,
        js_api=api,
    )

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
