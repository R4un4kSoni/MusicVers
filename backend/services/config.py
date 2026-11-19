import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from backend.app_paths import ENV_PATH

# Project root in development. In a frozen build this points inside the
# temporary bundle, so it is only used as a fallback.
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# In development use the repo's .env. In a frozen app use the writable
# per-user folder (and optionally one placed beside the executable).
ENV_FILES = [PROJECT_ROOT / ".env"] if not getattr(sys, "frozen", False) else [ENV_PATH]
if getattr(sys, "frozen", False):
    ENV_FILES.append(Path(sys.executable).resolve().parent / ".env")

for env_file in ENV_FILES:
    if env_file.is_file():
        load_dotenv(env_file, override=False)


class Settings:

    YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY")
    VIDKRAKEN_API_KEY = os.getenv("VIDKRAKEN_API_KEY")
    JIOSAAVN_API_BASE = os.getenv(
        "JIOSAAVN_API_BASE",
        "https://saavn.sumit.co/api",
    )
    MUSIC_FOLDER = os.getenv("MUSIC_FOLDER", str(Path.home() / "Music"))


settings = Settings()
