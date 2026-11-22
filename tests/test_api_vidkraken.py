
import unittest
from unittest.mock import Mock, patch

from backend.api import NeonWaveAPI


class TestVidKrakenAPI(unittest.TestCase):

    def setUp(self):
        # Avoid initializing VLC, the database, or the full application.
        self.api = NeonWaveAPI.__new__(NeonWaveAPI)
        self.api._youtube_metadata = {}
        self.api.vidkraken = Mock()
        self.api.permanent_download_service = Mock()
        self.api._vidkraken_jobs = {}
        self.api.music_service = Mock()

    def test_successful_status(self):
        self.api.vidkraken.get_account.return_value = {
            "success": True,
            "account": {
                "email": "private@example.com",
                "name": "Private User",
                "api_key": "secret",
                "plan": {
                    "id": "free"
                },
                "balances": {
                    "download_count": {
                        "granted": 25,
                        "used": 5,
                        "remaining": 20,
                        "unlimited": False,
                        "resetsAt": None
                    },
                    "bandwidth_mb": {
                        "granted": 500,
                        "used": 100,
                        "remaining": 400,
                        "unlimited": False,
                        "resetsAt": None
                    },
                    "info": {
                        "granted": 10,
                        "used": 2,
                        "remaining": 8,
                        "unlimited": False,
                        "resetsAt": None
                    }
                }
            }
        }

        result = self.api.get_vidkraken_status()

        self.assertTrue(result["success"])
        self.assertEqual(result["plan"]["id"], "free")

        downloads = result["usage"]["download_count"]
        self.assertEqual(downloads["granted"], 25)
        self.assertEqual(downloads["used"], 5)
        self.assertEqual(downloads["remaining"], 20)

        bandwidth = result["usage"]["bandwidth_mb"]
        self.assertEqual(bandwidth["granted"], 500)
        self.assertEqual(bandwidth["used"], 100)
        self.assertEqual(bandwidth["remaining"], 400)

        # Private account information must not be returned.
        self.assertNotIn("email", result)
        self.assertNotIn("name", result)
        self.assertNotIn("api_key", result)

    def test_forward_authentication_failure(self):
        self.api.vidkraken.get_account.return_value = {
            "success": False,
            "error": "VidKraken authentication failed."
        }

        result = self.api.get_vidkraken_status()

        self.assertFalse(result["success"])
        self.assertEqual(
            result["error"],
            "VidKraken authentication failed."
        )

    def test_reject_invalid_account_response(self):
        self.api.vidkraken.get_account.return_value = {
            "success": True,
            "account": ["invalid", "account"]
        }

        result = self.api.get_vidkraken_status()

        self.assertFalse(result["success"])
        self.assertEqual(
            result["error"],
            "Invalid account response."
        )

    def test_handle_unexpected_exception(self):
        self.api.vidkraken.get_account.side_effect = RuntimeError(
            "Unexpected test error"
        )

        result = self.api.get_vidkraken_status()

        self.assertFalse(result["success"])
        self.assertEqual(
            result["error"],
            "Could not retrieve VidKraken account status."
        )

    def test_reject_unknown_download_job(self):
        result = self.api.get_vidkraken_download_status("unknown-job")

        self.assertFalse(result["success"])
        self.assertIn("Unknown VidKraken job", result["error"])
        self.api.vidkraken.get_download_status.assert_not_called()

    def test_reject_job_when_video_is_no_longer_authorized(self):
        self.api._vidkraken_jobs["job123"] = {
            "video_id": "abcdefghijk",
            "saved": False,
            "processing": False,
            "save_result": None
        }

        with patch("backend.api.AUTHORIZED_VIDEO_IDS", set()):
            result = self.api.get_vidkraken_download_status("job123")

        self.assertFalse(result["success"])
        self.assertIn("no longer", result["error"])
        self.api.vidkraken.get_download_status.assert_not_called()

    def test_unfinished_job_is_not_saved(self):
        self.api._vidkraken_jobs["job123"] = {
            "video_id": "abcdefghijk",
            "saved": False,
            "processing": False,
            "save_result": None
        }

        self.api.vidkraken.get_download_status.return_value = {
            "success": True,
            "status": "IN_PROGRESS",
            "progress": {"percent": 50}
        }

        with patch(
            "backend.api.AUTHORIZED_VIDEO_IDS",
            {"abcdefghijk"}
        ):
            result = self.api.get_vidkraken_download_status("job123")

        self.assertTrue(result["success"])
        self.assertEqual(result["status"], "IN_PROGRESS")
        self.assertFalse(result["saved"])
        self.api.permanent_download_service.download_and_save.assert_not_called()

    def test_completed_job_is_saved_only_once(self):
        self.api._vidkraken_jobs["job123"] = {
            "video_id": "abcdefghijk",
            "saved": False,
            "processing": False,
            "save_result": None
        }

        self.api.vidkraken.get_download_status.return_value = {
            "success": True,
            "status": "COMPLETED",
            "download_url": "https://example.com/audio.mp3",
            "actual_format": "mp3"
        }

        saved_song = {
            "title": "Test Song",
            "artist": "Test Artist"
        }

        self.api.permanent_download_service.download_and_save.return_value = {
            "success": True,
            "song": saved_song,
            "file_path": "/home/test/Music/Test Song.mp3"
        }

        with patch(
            "backend.api.AUTHORIZED_VIDEO_IDS",
            {"abcdefghijk"}
        ):
            first_result = self.api.get_vidkraken_download_status("job123")
            second_result = self.api.get_vidkraken_download_status("job123")

        self.assertTrue(first_result["success"])
        self.assertTrue(first_result["saved"])
        self.assertEqual(first_result["song"], saved_song)

        self.assertTrue(second_result["success"])
        self.assertTrue(second_result["saved"])

        # The permanent save must happen only once.
        self.api.permanent_download_service.download_and_save.assert_called_once()

        source = (
            self.api.permanent_download_service
            .download_and_save.call_args.args[0]
        )

        self.assertEqual(source.media_type, "audio")
        self.assertEqual(source.extension, ".mp3")
        self.assertTrue(source.download_allowed)
        self.assertEqual(source.authorization_type, "manual_allowlist")

    def test_unsupported_format_is_not_saved(self):
        self.api._vidkraken_jobs["job123"] = {
            "video_id": "abcdefghijk",
            "saved": False,
            "processing": False,
            "save_result": None
        }

        self.api.vidkraken.get_download_status.return_value = {
            "success": True,
            "status": "COMPLETED",
            "download_url": "https://example.com/audio.unknown",
            "actual_format": "unknown"
        }

        with patch(
            "backend.api.AUTHORIZED_VIDEO_IDS",
            {"abcdefghijk"}
        ):
            result = self.api.get_vidkraken_download_status("job123")

        self.assertFalse(result["success"])
        self.assertIn("Unsupported VidKraken audio format", result["error"])
        self.api.permanent_download_service.download_and_save.assert_not_called()

    def test_reject_invalid_job_id_type(self):
        result = self.api.get_vidkraken_download_status(["invalid"])

        self.assertFalse(result["success"])
        self.assertEqual(
            result["error"],
            "Invalid VidKraken job ID."
        )
    def test_youtube_search_metadata_is_cached(self):
        self.api.music_service.search_music.return_value = {
            "success": True,
            "results": [
                 {
                      "id": "abcdefghijk",
                     "title": "Test Song",
                     "artist": "Test Artist",
                      "album": "Test Album",
                       "provider": "youtube"
                  }
             ],
             "count": 1
         }

        result = self.api.search_online_music("Test Song")

        self.assertTrue(result["success"])
        self.assertEqual(
        self.api._youtube_metadata["abcdefghijk"],
            {
                    "title": "Test Song",
                    "artist": "Test Artist",
                    "album": "Test Album"
                }
        )

    def test_non_youtube_results_are_not_cached(self):
        self.api.music_service.search_music.return_value = {
            "success": True,
            "results": [
                {
                    "id": "spotify-track-123",
                    "title": "Test Song",
                    "artist": "Test Artist",
                    "provider": "spotify"
                }
            ],
            "count": 1
        }

        self.api.search_online_music("Test Song")

        self.assertEqual(self.api._youtube_metadata, {})

    def test_invalid_search_results_are_ignored(self):
        self.api.music_service.search_music.return_value = {
            "success": True,
            "results": [
                None,
                "invalid track",
                {
                    "id": "",
                    "provider": "youtube"
                },
                {
                    "id": "abcdefghijk",
                    "provider": "youtube",
                    "title": None,
                    "artist": None,
                    "album": None
                }
            ],
            "count": 4
        }

        result = self.api.search_online_music("Test Song")

        self.assertTrue(result["success"])
        self.assertEqual(
            self.api._youtube_metadata["abcdefghijk"],
            {
                "title": "Unknown Title",
                "artist": "Unknown Artist",
                "album": None
            }
        )
        self.api.vidkraken.get_download_status.assert_not_called()
if __name__ == "__main__":
    unittest.main()
