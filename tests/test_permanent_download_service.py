
import unittest
import tempfile

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from backend.services.permanent_download_service import (
    PermanentDownloadService
)


def create_valid_source():
    return SimpleNamespace(
        url="https://example.com/audio.mp3",
        headers={},
        mime_type="audio/mpeg",
        extension=".mp3",
        expires_at=None,
        download_allowed=True,
        authorization_type="user_owned",
        authorization_reference="test-asset-001",
        media_type="audio"
    )


class TestPermanentDownloadService(unittest.TestCase):

    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.music_folder = Path(self.temp_directory.name) / "Music"

        self.source = create_valid_source()

    def tearDown(self):
        self.temp_directory.cleanup()

    @patch("backend.services.permanent_download_service.save_songs")
    @patch("backend.services.permanent_download_service.get_metadata")
    @patch("backend.services.permanent_download_service.DownloadService")
    def test_successful_download(
        self, mock_download_class, mock_metadata, mock_save
    ):
        self.service = PermanentDownloadService(
            music_folder=self.music_folder
        )
        temporary_file = Path(self.temp_directory.name) / "temp.mp3"
        temporary_file.write_bytes(b"test audio")

        mock_download = mock_download_class.return_value
        mock_download.download.return_value = {
            "success": True,
            "file_path": str(temporary_file)
        }

        mock_metadata.return_value = {
            "title": "Test Song",
            "artist": "Test Artist",
            "album": "Test Album",
            "duration": "3:30"
        }

        result = self.service.download_and_save(
            self.source,
            {"title": "Test Song"}
        )

        self.assertTrue(result["success"])
        self.assertTrue(Path(result["file_path"]).exists())
        self.assertEqual(result["song"]["title"], "Test Song")
        mock_save.assert_called_once()
        mock_download.cleanup.assert_called_once()

    @patch("backend.services.permanent_download_service.DownloadService")
    def test_reject_video_source(self, mock_download_class):
        self.service = PermanentDownloadService(
            music_folder=self.music_folder
        )

        self.source.media_type = "video"

        result = self.service.download_and_save(self.source)

        self.assertFalse(result["success"])
        self.assertIn("only support audio", result["error"])
        mock_download_class.return_value.download.assert_not_called()

    @patch("backend.services.permanent_download_service.DownloadService")
    def test_reject_unsupported_format(self, mock_download_class):
        self.service = PermanentDownloadService(
            music_folder=self.music_folder
        )

        temporary_file = Path(self.temp_directory.name) / "temp.webm"
        temporary_file.write_bytes(b"test audio")

        mock_download = mock_download_class.return_value
        mock_download.download.return_value = {
            "success": True,
            "file_path": str(temporary_file)
        }

        result = self.service.download_and_save(self.source)

        self.assertFalse(result["success"])
        self.assertIn("Unsupported audio format", result["error"])
        mock_download.cleanup.assert_called_once()

    @patch("backend.services.permanent_download_service.save_songs")
    @patch("backend.services.permanent_download_service.get_metadata")
    @patch("backend.services.permanent_download_service.DownloadService")
    def test_duplicate_filename(
        self, mock_download_class, mock_metadata, mock_save
    ):
        self.service = PermanentDownloadService(
            music_folder=self.music_folder
        )
        self.music_folder.mkdir(parents=True)

        existing_file = self.music_folder / "Test Song.mp3"
        existing_file.write_bytes(b"existing audio")

        temporary_file = Path(self.temp_directory.name) / "temp.mp3"
        temporary_file.write_bytes(b"new audio")

        mock_download = mock_download_class.return_value
        mock_download.download.return_value = {
            "success": True,
            "file_path": str(temporary_file)
        }

        mock_metadata.return_value = {
            "title": "Test Song",
            "artist": "Test Artist",
            "album": "Test Album",
            "duration": "3:30"
        }

        result = self.service.download_and_save(
            self.source,
            {"title": "Test Song"}
        )

        self.assertTrue(result["success"])
        self.assertEqual(
            Path(result["file_path"]).name,
            "Test Song (2).mp3"
        )
        self.assertTrue(existing_file.exists())

    @patch("backend.services.permanent_download_service.save_songs")
    @patch("backend.services.permanent_download_service.get_metadata")
    @patch("backend.services.permanent_download_service.DownloadService")
    def test_database_failure_removes_permanent_file(
        self, mock_download_class, mock_metadata, mock_save
    ):
        self.service = PermanentDownloadService(
            music_folder=self.music_folder
        )
        temporary_file = Path(self.temp_directory.name) / "temp.mp3"
        temporary_file.write_bytes(b"test audio")

        mock_download = mock_download_class.return_value
        mock_download.download.return_value = {
            "success": True,
            "file_path": str(temporary_file)
        }

        mock_metadata.return_value = {}
        mock_save.side_effect = Exception("Database error")

        result = self.service.download_and_save(
            self.source,
            {"title": "Test Song"}
        )

        self.assertFalse(result["success"])
        self.assertIn("Database error", result["error"])
        self.assertFalse(
            (self.music_folder / "Test Song.mp3").exists()
        )
        mock_download.cleanup.assert_called_once()

    @patch("backend.services.permanent_download_service.DownloadService")
    def test_download_failure(self, mock_download_class):
        self.service = PermanentDownloadService(
            music_folder=self.music_folder
        )
        mock_download = mock_download_class.return_value
        mock_download.download.return_value = {
            "success": False,
            "error": "Download failed"
        }

        result = self.service.download_and_save(self.source)

        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "Download failed")
        mock_download.cleanup.assert_called_once()


if __name__ == "__main__":
    unittest.main()
