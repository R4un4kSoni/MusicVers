from backend.services.chunk_loader import ChunkLoader
from backend.services.media_validator import validate_media_source


class DownloadService:

    def __init__(self):
        self.loader = None

    def download(self, source):
        """Validate an authorized media source and download it in chunks."""

        if self.loader is not None:
            return {
                "success": False,
                "error": "A previous download is still active."
            }

        valid, message = validate_media_source(source)

        if not valid:
            return {
                "success": False,
                "error": message
            }

        loader = None

        try:
            loader = ChunkLoader(
                audio_url=source.url,
                headers=source.headers,
                media_type=getattr(source, "media_type", "audio")
            )

            result = loader.download_to_file()

            if not result.get("success"):
                loader.cleanup()
                return result

            self.loader = loader

            return result

        except Exception as error:
            if loader is not None:
                loader.cleanup()

            return {
                "success": False,
                "error": str(error)
            }

    def cleanup(self):
        """Clean up the active download and its temporary files."""

        if self.loader is not None:
            self.loader.cleanup()
            self.loader = None