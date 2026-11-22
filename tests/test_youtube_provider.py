import unittest
from unittest.mock import Mock, patch

from backend.services.providers.youtube_provider import YouTubeProvider


class TestYouTubeProvider(unittest.TestCase):

    @patch("backend.services.providers.youtube_provider.requests.get")
    def test_audio_friendly_results_are_ranked_first(self, mock_get):
        items = [
            {
                "id": {"videoId": "cover-id"},
                "snippet": {
                    "title": "Time (Cover)",
                    "channelTitle": "Someone"
                }
            },
            {
                "id": {"videoId": "vevo-id"},
                "snippet": {
                    "title": "Pink Floyd - Time (Official Video)",
                    "channelTitle": "Pink Floyd Vevo"
                }
            },
            {
                "id": {"videoId": "topic-id"},
                "snippet": {
                    "title": "Time",
                    "channelTitle": "PINK FLOYD - Topic"
                }
            },
            {
                "id": {"videoId": "official-audio-id"},
                "snippet": {
                    "title": "Pink Floyd – Time (Official Audio)",
                    "channelTitle": "Pink Floyd"
                }
            }
        ]

        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"items": items}
        mock_get.return_value = response

        provider = YouTubeProvider()
        provider.api_key = "test-key"

        result = provider.search("Time Pink Floyd")

        self.assertTrue(result["success"])
        self.assertEqual(
            [track["id"] for track in result["results"]],
            [
                "official-audio-id",
                "topic-id",
                "vevo-id",
                "cover-id"
            ]
        )

    @patch("backend.services.providers.youtube_provider.requests.get")
    def test_search_returns_failure_when_api_key_missing(self, mock_get):
        provider = YouTubeProvider()
        provider.api_key = ""

        result = provider.search("Time Pink Floyd")

        self.assertFalse(result["success"])
        self.assertEqual(result["results"], [])
        mock_get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
