import unittest
from unittest.mock import Mock

from backend.api import NeonWaveAPI


def make_api(provider):
    api = object.__new__(NeonWaveAPI)
    api.jiosaavn = provider
    api._jiosaavn_metadata = {}
    api._discovery_shelves = None
    return api


class TestApiJioSaavnDiscovery(unittest.TestCase):

    def test_discovery_is_cached_and_tracks_are_kept(self):
        track = {"id": "song-1", "title": "Song", "provider": "jiosaavn"}
        provider = Mock()
        provider.get_discovery_shelves.return_value = {
            "success": True,
            "trending": [track],
            "albums": [],
            "artists": [],
            "charts": [],
            "genres": [],
            "count": {"trending": 1},
        }
        api = make_api(provider)

        first = api.get_jiosaavn_discovery()
        second = api.get_jiosaavn_discovery()

        self.assertIs(first, second)
        self.assertEqual(api._jiosaavn_metadata["song-1"], track)
        provider.get_discovery_shelves.assert_called_once_with(refresh=False)

    def test_refresh_forces_a_new_provider_call(self):
        provider = Mock()
        provider.get_discovery_shelves.return_value = {
            "success": True,
            "trending": [],
            "albums": [],
            "artists": [],
            "charts": [],
            "genres": [],
            "count": {},
        }
        api = make_api(provider)

        api.get_jiosaavn_discovery()
        api.get_jiosaavn_discovery(refresh=True)

        self.assertEqual(provider.get_discovery_shelves.call_count, 2)
        provider.get_discovery_shelves.assert_called_with(refresh=True)

    def test_album_and_collection_tracks_are_cached(self):
        album_track = {"id": "album-track", "title": "Album Track"}
        collection_track = {"id": "collection-track", "title": "Chart Track"}
        provider = Mock()
        provider.get_album.return_value = {
            "success": True,
            "album": {"id": "a1"},
            "tracks": [album_track],
        }
        provider.get_collection_tracks.return_value = {
            "success": True,
            "collection": {"id": "c1"},
            "tracks": [collection_track],
        }
        api = make_api(provider)

        album = api.get_jiosaavn_album("a1", 10)
        chart = api.get_jiosaavn_genre_tracks("token-1", 1, 10)

        self.assertTrue(album["success"])
        self.assertTrue(chart["success"])
        self.assertEqual(api._jiosaavn_metadata["album-track"], album_track)
        self.assertEqual(
            api._jiosaavn_metadata["collection-track"], collection_track
        )

    def test_artist_wrapper_uses_requested_kind(self):
        provider = Mock()
        provider.get_artist.return_value = {
            "success": True,
            "artist": {"id": "ar1", "name": "Artist"},
            "songs": [{"id": "song-1"}],
        }
        api = make_api(provider)

        result = api.get_jiosaavn_artist_songs("ar1", page=2, limit=15)

        self.assertTrue(result["success"])
        self.assertEqual(api._jiosaavn_metadata["song-1"], {"id": "song-1"})
        provider.get_artist.assert_called_once_with(
            artist_id="ar1",
            page=2,
            limit=15,
            kind="songs",
        )

    def test_provider_errors_are_returned_as_serializable_dicts(self):
        provider = Mock()
        provider.get_discovery_shelves.side_effect = RuntimeError("offline")
        provider.search_albums.side_effect = RuntimeError("offline")
        api = make_api(provider)

        discovery = api.get_jiosaavn_discovery()
        albums = api.search_jiosaavn_albums("Queen")

        self.assertFalse(discovery["success"])
        self.assertEqual(discovery["error"], "offline")
        self.assertEqual(discovery["trending"], [])
        self.assertFalse(albums["success"])
        self.assertEqual(albums["results"], [])


if __name__ == "__main__":
    unittest.main()
