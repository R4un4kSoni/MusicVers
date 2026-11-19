
import re
import shutil
from pathlib import Path

from backend.library import SUPPORTED_FORMATS
from backend.metadata import get_metadata
from backend.database import save_songs
from backend.services.download_service import DownloadService


class PermanentDownloadService:

    def __init__(self, music_folder=None):
        self.download_service = DownloadService()

        self.music_folder = Path(
            music_folder or Path.home() / "Music"
        ).expanduser()

    def _safe_filename(self, title):
        """Remove characters unsuitable for a filename."""

        title = re.sub(r'[\\/:*?"<>|]', "-", str(title))
        title = title.strip(" .")

        return title[:150] or "Unknown Title"

    def _get_unique_path(self, filename):
        """Avoid overwriting an existing music file."""

        destination = self.music_folder / filename

        counter = 2

        while destination.exists():
            stem = Path(filename).stem
            extension = Path(filename).suffix

            destination = self.music_folder / (
                f"{stem} ({counter}){extension}"
            )

            counter += 1

        return destination

    def download_and_save(self, source, metadata=None):
        """
        Download validated audio, move it permanently,
        and register it in the NeonWave database.
        """

        metadata = metadata if isinstance(metadata, dict) else {}
        if getattr(source, "media_type", None) != "audio":
            return {
                "success": False,
                "error": "Permanent downloads only support audio."
            }

        temporary_path = None
        permanent_path = None

        try:
            result = self.download_service.download(source)

            if not result.get("success"):
                return result

            temporary_path = Path(result["file_path"])

            if not temporary_path.is_file():
                return {
                    "success": False,
                    "error": "Downloaded audio file was not found."
                }

            extension = temporary_path.suffix.lower()

            if extension not in SUPPORTED_FORMATS:
                return {
                    "success": False,
                    "error": f"Unsupported audio format: {extension}"
                }

            self.music_folder.mkdir(
                parents=True,
                exist_ok=True
            )

            title = metadata.get("title") or temporary_path.stem
            filename = self._safe_filename(title) + extension

            permanent_path = self._get_unique_path(filename)

            shutil.move(
                str(temporary_path),
                str(permanent_path)
            )

            extracted = get_metadata(permanent_path) or {}

            song = {
                "title": extracted.get("title") or title,
                "artist": (
                    extracted.get("artist")
                    if extracted.get("artist") != "Unknown Artist"
                    else metadata.get("artist", "Unknown Artist")
                ),
                "album": (
                    extracted.get("album")
                    if extracted.get("album") != "Unknown Album"
                    else metadata.get("album", "Unknown Album")
                ),
                "duration": extracted.get("duration", "0:00"),
                "path": str(permanent_path.resolve())
            }

            # Use search metadata if the file has no useful title tag.
            if song["title"] == permanent_path.stem:
                song["title"] = title

            save_songs([song])

            return {
                "success": True,
                "song": song,
                "file_path": str(permanent_path)
            }

        except Exception as error:

            # Remove a newly moved file if registration failed.
            if permanent_path is not None and permanent_path.exists():
                permanent_path.unlink(missing_ok=True)

            return {
                "success": False,
                "error": str(error)
            }

        finally:
            self.download_service.cleanup()
