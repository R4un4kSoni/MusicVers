import os
import webview
from pathlib import Path

from backend.api import NeonWaveAPI
from backend.settings_store import get_theme
from backend.video_host import VideoHostBridge


BASE_DIR = Path(__file__).resolve().parent

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
        title="Audio",
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
        debug=True,
        http_server=True
    )


if __name__ == "__main__":
    main()
