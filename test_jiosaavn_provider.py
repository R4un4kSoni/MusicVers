import unittest
from unittest.mock import Mock, patch

from backend.services.providers.jiosaavn_provider import JioSaavnProvider


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def song_payload():
    return {
        "id": "song-1",
        "name": "Test Song",
        "duration": 200,
        "language": "english",
        "year": "2024",
        "album": {"id": "album-1", "name": "Test Album"},
        "artists": {
            "primary": [{"id": "artist-1", "name": "Test Artist"}]
        },
        "image": [
            {"quality": "50x50", "url": "https://img/50.jpg"},
            {"quality": "500x500", "url": "https://img/500.jpg"},
        ],
        "downloadUrl": [
            {"quality": "96kbps", "url": "https://audio/96.mp4"},
            {"quality": "320kbps", "url": "https://audio/320.mp4"},
        ],
    }


class TestJioSaavnProvider(unittest.TestCase):

    def setUp(self):
        self.provider = JioSaavnProvider()

    @patch("backend.services.providers.jiosaavn_provider.requests.get")
    def test_search_normalizes_results(self, mock_get):
        mock_get.return_value = FakeResponse({
            "success": True,
            "data": {"results": [song_payload()]},
        })

        result = self.provider.search("test song")

        self.assertTrue(result["success"])
        self.assertEqual(result["count"], 1)

        track = result["results"][0]
        self.assertEqual(track["id"], "song-1")
        self.assertEqual(track["title"], "Test Song")
        self.assertEqual(track["artist"], "Test Artist")
        self.assertEqual(track["album"], "Test Album")
        self.assertEqual(track["thumbnail"], "https://img/500.jpg")
        self.assertEqual(track["duration"], 200)
        self.assertEqual(track["provider"], "jiosaavn")

    @patch("backend.services.providers.jiosaavn_provider.requests.get")
    def test_get_stream_prefers_requested_quality(self, mock_get):
        mock_get.return_value = FakeResponse({
            "success": True,
            "data": [song_payload()],
        })

        result = self.provider.get_stream("song-1", quality="96kbps")
        track = result["track"]

        self.assertTrue(result["success"])
        self.assertEqual(track["quality"], "96kbps")
        self.assertEqual(track["stream_url"], "https://audio/96.mp4")

        self.provider._song_cache.clear()

        fallback = self.provider.get_stream("song-1", quality="160kbps")
        self.assertEqual(fallback["track"]["quality"], "320kbps")

    @patch("backend.services.providers.jiosaavn_provider.requests.get")
    def test_search_hides_karaoke_and_cover_versions(self, mock_get):
        karaoke = song_payload()
        karaoke["id"] = "song-2"
        karaoke["name"] = "Treasure (Karaoke Version)"

        mock_get.return_value = FakeResponse({
            "success": True,
            "data": {"results": [karaoke, song_payload()]},
        })

        result = self.provider.search("test song")

        self.assertTrue(result["success"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["results"][0]["id"], "song-1")

    @patch("backend.services.providers.jiosaavn_provider.requests.get")
    def test_search_reports_when_only_covers_exist(self, mock_get):
        karaoke = song_payload()
        karaoke["name"] = "Just The Way You Are (Piano Karaoke)"

        mock_get.return_value = FakeResponse({
            "success": True,
            "data": {"results": [karaoke]},
        })

        result = self.provider.search("Bruno Mars")

        self.assertFalse(result["success"])
        self.assertTrue(result.get("only_low_quality"))
        self.assertEqual(result["results"], [])

    @patch("backend.services.providers.jiosaavn_provider.requests.get")
    def test_search_failure_is_reported(self, mock_get):
        mock_get.return_value = FakeResponse({"success": False})

        result = self.provider.search("anything")

        self.assertFalse(result["success"])
        self.assertEqual(result["results"], [])

    def test_capabilities_advertise_streaming(self):
        capabilities = self.provider.get_capabilities()

        self.assertTrue(capabilities["search"])
        self.assertTrue(capabilities["streaming"])
        self.assertFalse(capabilities["embed_playback"])


def web_song_payload():
    return {
        "id": "web-1",
        "title": "Time",
        "subtitle": "Pink Floyd - The Dark Side of the Moon",
        "image": "https://c.saavncdn.com/261/album-150x150.jpg",
        "language": "english",
        "year": "2016",
        "more_info": {
            "duration": "418",
            "album": "The Dark Side of the Moon",
            "artistMap": {
                "primary": [{"name": "Pink Floyd"}]
            },
            "encrypted_media_url": "ENCRYPTED-URL",
        },
    }


class TestJioSaavnWebAPI(unittest.TestCase):

    @patch.object(JioSaavnProvider, "_web_get")
    def test_web_search_normalizes_full_catalogue(self, mock_web_get):
        karaoke = web_song_payload()
        karaoke["id"] = "web-2"
        karaoke["title"] = "Time (Karaoke Version)"

        mock_web_get.return_value = {
            "success": True,
            "data": {"results": [karaoke, web_song_payload()]},
        }

        provider = JioSaavnProvider()
        result = provider.search("Time Pink Floyd")

        self.assertTrue(result["success"])
        self.assertEqual(result["count"], 1)

        track = result["results"][0]
        self.assertEqual(track["id"], "web-1")
        self.assertEqual(track["title"], "Time")
        self.assertEqual(track["artist"], "Pink Floyd")
        self.assertEqual(track["album"], "The Dark Side of the Moon")
        self.assertEqual(track["thumbnail"], "https://c.saavncdn.com/261/album-500x500.jpg")
        self.assertEqual(track["duration"], 418)

    @patch.object(JioSaavnProvider, "_web_get")
    def test_web_stream_returns_playable_aac_url(self, mock_web_get):
        song = web_song_payload()

        def respond(call, params=None):
            if call == "song.getDetails":
                return {"success": True, "data": {"web-1": song}}
            if call == "song.generateAuthToken":
                return {
                    "success": True,
                    "data": {
                        "auth_url": (
                            "https://web.saavncdn.com/261/hash_320.mp4"
                            "?Expires=123&Signature=abc"
                        )
                    },
                }
            return {"success": False, "error": f"Unexpected call: {call}"}

        mock_web_get.side_effect = respond

        provider = JioSaavnProvider()
        result = provider.get_stream("web-1", quality="320kbps")

        self.assertTrue(result["success"])
        self.assertEqual(
            result["track"]["stream_url"],
            "https://aac.saavncdn.com/261/hash_320.mp4",
        )
        self.assertEqual(result["track"]["quality"], "320kbps")


if __name__ == "__main__":
    unittest.main()
