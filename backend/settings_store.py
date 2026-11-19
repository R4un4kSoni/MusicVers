"""Small JSON-backed settings store for user preferences."""

import json
from pathlib import Path
from typing import Any, Dict

from backend.services.config import PROJECT_ROOT

SETTINGS_PATH = PROJECT_ROOT / "data" / "app_settings.json"

DEFAULT_SETTINGS: Dict[str, Any] = {
    "music_folder": str(Path.home() / "Music"),
    "theme": "light",
    "profile_picture": "",
}


def load_settings() -> Dict[str, Any]:
    settings = dict(DEFAULT_SETTINGS)

    if not SETTINGS_PATH.is_file():
        return settings

    try:
        with SETTINGS_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)

        if isinstance(data, dict):
            settings.update(
                {key: value for key, value in data.items() if key in DEFAULT_SETTINGS}
            )
    except (OSError, ValueError):
        pass

    return settings


def save_settings(settings: Dict[str, Any]) -> bool:
    try:
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)

        with SETTINGS_PATH.open("w", encoding="utf-8") as handle:
            json.dump(settings, handle, indent=2)

        return True
    except OSError:
        return False


def get_music_folder() -> str:
    return str(load_settings().get("music_folder") or DEFAULT_SETTINGS["music_folder"])


def set_music_folder(folder_path: str) -> bool:
    path = Path(folder_path).expanduser()

    if not path.is_dir():
        return False

    settings = load_settings()
    settings["music_folder"] = str(path.resolve())

    return save_settings(settings)


def get_theme() -> str:
    theme = str(load_settings().get("theme") or "light").strip().lower()
    return "dark" if theme == "dark" else "light"


def set_theme(theme: str) -> bool:
    theme = str(theme or "").strip().lower()
    if theme not in ("light", "dark"):
        return False

    settings = load_settings()
    settings["theme"] = theme

    return save_settings(settings)


def get_profile_picture() -> str:
    return str(load_settings().get("profile_picture") or "")


def set_profile_picture(data_url: str) -> bool:
    picture = str(data_url or "")
    if picture and not picture.startswith("data:image/"):
        return False

    settings = load_settings()
    settings["profile_picture"] = picture

    return save_settings(settings)
