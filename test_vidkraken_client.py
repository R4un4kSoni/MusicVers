
import unittest
from unittest.mock import Mock, patch

import requests

from backend.services.vidkraken_client import VidKrakenClient


class TestVidKrakenClient(unittest.TestCase):

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", None)
    def test_missing_api_key(self, mock_session):
        client = VidKrakenClient()

        result = client.get_account()

        self.assertFalse(result["success"])
        mock_session.return_value.get.assert_not_called()

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_successful_account_response(self, mock_session):
        response = Mock()
        response.ok = True
        response.json.return_value = {
            "plan": {"id": "free"},
            "balances": {"download_count": 10}
        }

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()
        result = client.get_account()

        self.assertTrue(result["success"])
        self.assertEqual(result["account"]["plan"]["id"], "free")

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_authentication_failure(self, mock_session):
        response = Mock()
        response.status_code = 401

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()
        result = client.get_account()

        self.assertFalse(result["success"])
        self.assertIn("authentication failed", result["error"].lower())

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_http_error(self, mock_session):
        response = Mock()
        response.status_code = 500
        response.ok = False

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()
        result = client.get_account()

        self.assertFalse(result["success"])
        self.assertIn("500", result["error"])

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_connection_failure(self, mock_session):
        mock_session.return_value.get.side_effect = requests.ConnectionError()

        client = VidKrakenClient()
        result = client.get_account()

        self.assertFalse(result["success"])
        self.assertIn("connect", result["error"].lower())

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_invalid_json(self, mock_session):
        response = Mock()
        response.ok = True
        response.json.side_effect = ValueError()

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()
        result = client.get_account()

        self.assertFalse(result["success"])
        self.assertIn("JSON", result["error"])

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_successful_download_creation(self, mock_session):

        response = Mock()
        response.ok = True
        response.json.return_value = {
            "jobId": "test_job_123",
            "status": "queued"
        }

        mock_session.return_value.post.return_value = response

        client = VidKrakenClient()

        result = client.start_download(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            format="audio",
            authorized=True
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["job_id"], "test_job_123")
        self.assertEqual(result["status"], "queued")

        mock_session.return_value.post.assert_called_once()

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_download_without_authorization(self, mock_session):

        client = VidKrakenClient()

        result = client.start_download(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            format="audio",
            authorized=False
        )

        self.assertFalse(result["success"])
        self.assertIn("authorization", result["error"].lower())

        mock_session.return_value.post.assert_not_called()

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_unsupported_download_format(self, mock_session):

        client = VidKrakenClient()

        result = client.start_download(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            format="4k",
            authorized=True
        )

        self.assertFalse(result["success"])
        self.assertIn("unsupported", result["error"].lower())

        mock_session.return_value.post.assert_not_called()

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_successful_download_status(self, mock_session):

        response = Mock()
        response.ok = True
        response.json.return_value = {
            "status": "completed",
            "progress": 100,
            "downloadUrl": "https://example.com/file.mp3",
            "actualFormat": "audio-mp3"
        }

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()

        result = client.get_download_status("test_job_123")

        self.assertTrue(result["success"])
        self.assertEqual(result["job_id"], "test_job_123")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["progress"], 100)
        self.assertEqual(
            result["download_url"],
            "https://example.com/file.mp3"
        )
        self.assertEqual(result["actual_format"], "audio-mp3")

        mock_session.return_value.get.assert_called_once()

    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_invalid_download_job_id(self, mock_session):

        client = VidKrakenClient()

        result = client.get_download_status("../invalid")

        self.assertFalse(result["success"])
        self.assertIn("invalid", result["error"].lower())

        mock_session.return_value.get.assert_not_called()


    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_download_status_connection_failure(self, mock_session):

        mock_session.return_value.get.side_effect = requests.ConnectionError

        client = VidKrakenClient()

        result = client.get_download_status("test_job_123")

        self.assertFalse(result["success"])
        self.assertIn("retrieve", result["error"].lower())


    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_download_status_authentication_failure(self, mock_session):

        response = Mock()
        response.status_code = 401
        response.ok = False

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()

        result = client.get_download_status("test_job_123")

        self.assertFalse(result["success"])
        self.assertIn("authentication", result["error"].lower())


    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_download_status_http_error(self, mock_session):

        response = Mock()
        response.status_code = 500
        response.ok = False

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()

        result = client.get_download_status("test_job_123")

        self.assertFalse(result["success"])
        self.assertIn("500", result["error"])


    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_download_status_invalid_json(self, mock_session):

        response = Mock()
        response.ok = True
        response.json.side_effect = ValueError

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()

        result = client.get_download_status("test_job_123")

        self.assertFalse(result["success"])
        self.assertIn("invalid json", result["error"].lower())


    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_download_status_unexpected_response(self, mock_session):

        response = Mock()
        response.ok = True
        response.json.return_value = ["unexpected", "data"]

        mock_session.return_value.get.return_value = response

        client = VidKrakenClient()

        result = client.get_download_status("test_job_123")

        self.assertFalse(result["success"])
        self.assertIn("unexpected", result["error"].lower())


    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_invalid_youtube_url(self, mock_session):

        client = VidKrakenClient()

        result = client.start_download(
            url="https://example.com/video",
            format="audio",
            authorized=True
        )

        self.assertFalse(result["success"])
        self.assertIn("invalid youtube url", result["error"].lower())

        mock_session.return_value.post.assert_not_called()


    @patch("backend.services.vidkraken_client.requests.Session")
    @patch("backend.services.vidkraken_client.settings.VIDKRAKEN_API_KEY", "test-key")
    def test_invalid_job_id_from_api(self, mock_session):

        response = Mock()
        response.ok = True
        response.json.return_value = {
            "jobId": "../invalid",
            "status": "queued"
        }

        mock_session.return_value.post.return_value = response

        client = VidKrakenClient()

        result = client.start_download(
            url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            format="audio",
            authorized=True
        )

        self.assertFalse(result["success"])
        self.assertIn("job id", result["error"].lower())

if __name__ == "__main__":
    unittest.main()
