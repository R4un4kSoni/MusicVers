import unittest
from unittest.mock import patch

from backend.services.providers.jiosaavn_provider import JioSaavnProvider


def album_payload():
    return {
        "id": "13435951",
        "title": "Evolve",
        "subtitle": "Imagine Dragons",
        "image": "https://c.saavncdn.com/248/Evolve-English-2018-150x150.jpg",
        "perma_url": "https://www.jiosaavn.com/album/evolve/gvCWqZLfVbs_",
        "language": "english",
        "year": "2018",
        "more_info": {"song_count": "12"},
    }


def song_payload():
    return {
        "id": "uQKEtZYc",
        "title": "Next To Me",
        "subtitle": "Imagine Dragons - Evolve",
        "image": "https://c.saavncdn.com/248/Evolve-English-2018-150x150.jpg",
        "more_info": {
            "duration": "189",
            "album": "Evolve",
            "artistMap": {
                "primary_artists": [{"name": "Imagine Dragons"}]
            },
        },
    }


def artist_payload():
    return {
        "artistId": "599452",
        "name": "Imagine Dragons",
        "image": "https://c.saavncdn.com/artists/Imagine_Dragons_150x150.jpg",
        "follower_count": "12345",
        "isVerified": True,
        "topSongs": [song_payload()],
        "topAlbums": [album_payload()],
        "similarArtists": [
            {
                "id": "598351",
                "name": "OneRepublic",
                "perma_url": "https://www.jiosaavn.com/artist/onerepublic-songs/rXNvoiX7x7w_",
            }
        ],
        "featured_artist_playlist": [],
        "urls": {
            "overview": "https://www.jiosaavn.com/artist/imagine-dragons/f0aFxsa231o_"
        },
    }


def collection_payload(title="Best Of Rock - Hindi"):
    return {
        "id": "903166403",
        "title": title,
        "subtitle": "37.3K Followers",
        "type": "playlist",
        "image": "https://c.saavncdn.com/editorial/Rock_150x150.jpg",
        "perma_url": "https://www.jiosaavn.com/featured/rock/DGl4UBWnRqlFo9wdEAzFBA__",
        "list": [song_payload()],
    }


class TestJioSaavnDiscovery(unittest.TestCase):

    def setUp(self):
        self.provider = JioSaavnProvider()

    @patch.object(JioSaavnProvider, "_web_get")
    def test_search_albums_normalizes_results(self, mock_get):
        mock_get.return_value = {
            "success": True,
            "data": {"results": [album_payload()]},
        }

        result = self.provider.search_albums("Imagine Dragons")

        self.assertTrue(result["success"])
        self.assertEqual(result["count"], 1)
        album = result["results"][0]
        self.assertEqual(album["id"], "13435951")
        self.assertEqual(album["artist"], "Imagine Dragons")
        self.assertEqual(album["token"], "gvCWqZLfVbs_")
        self.assertEqual(album["track_count"], 12)

    @patch.object(JioSaavnProvider, "_web_get")
    def test_get_album_returns_playable_tracks(self, mock_get):
        album = album_payload()
        album["list"] = [song_payload(), dict(song_payload(), id="karaoke-1", title="Next To Me (Karaoke Version)")]
        mock_get.return_value = {"success": True, "data": album}

        result = self.provider.get_album(album_id="13435951")

        self.assertTrue(result["success"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["tracks"][0]["id"], "uQKEtZYc")
        self.assertEqual(result["tracks"][0]["artist"], "Imagine Dragons")

    @patch.object(JioSaavnProvider, "_web_get")
    def test_get_artist_overview_includes_profile_sections(self, mock_get):
        mock_get.return_value = {"success": True, "data": artist_payload()}

        result = self.provider.get_artist(artist_id="599452")

        self.assertTrue(result["success"])
        self.assertEqual(result["artist"]["name"], "Imagine Dragons")
        self.assertEqual(result["artist"]["token"], "f0aFxsa231o_")
        self.assertEqual(result["artist"]["listeners"], 12345)
        self.assertTrue(result["artist"]["verified"])
        self.assertEqual(result["songs"][0]["title"], "Next To Me")
        self.assertEqual(result["albums"][0]["title"], "Evolve")
        self.assertEqual(result["similar_artists"][0]["name"], "OneRepublic")

    @patch.object(JioSaavnProvider, "_web_get")
    def test_get_collection_tracks_normalizes_playlist(self, mock_get):
        mock_get.return_value = {"success": True, "data": collection_payload()}

        result = self.provider.get_collection_tracks("DGl4UBWnRqlFo9wdEAzFBA__")

        self.assertTrue(result["success"])
        self.assertEqual(result["collection"]["title"], "Best Of Rock - Hindi")
        self.assertEqual(result["tracks"][0]["id"], "uQKEtZYc")

    @patch.object(JioSaavnProvider, "get_featured_playlists")
    @patch.object(JioSaavnProvider, "_launch_data")
    def test_genres_map_to_playable_playlists(self, mock_launch, mock_playlists):
        mock_launch.return_value = {
            "success": True,
            "data": {
                "browse_discover": [
                    {
                        "id": "37",
                        "title": "Rock",
                        "type": "channel",
                        "image": "https://img/rock.jpg",
                        "perma_url": "https://www.jiosaavn.com/s/channel/rock/89HV0q4izuM_",
                        "more_info": {"tags": {"genre": ["Rock"]}},
                    }
                ],
                "promo:vx:data:76": [collection_payload()],
                "top_playlists": [],
            },
        }
        mock_playlists.return_value = {"success": False, "results": []}

        result = self.provider.get_genres()

        self.assertTrue(result["success"])
        self.assertEqual(result["count"], 1)
        genre = result["results"][0]
        self.assertEqual(genre["title"], "Rock")
        self.assertEqual(genre["token"], "DGl4UBWnRqlFo9wdEAzFBA__")
        self.assertEqual(genre["type"], "genre")

    @patch.object(JioSaavnProvider, "get_genres")
    @patch.object(JioSaavnProvider, "search_albums")
    @patch.object(JioSaavnProvider, "_launch_data")
    def test_discovery_shelves_aggregate_sources(
        self,
        mock_launch,
        mock_albums,
        mock_genres,
    ):
        mock_launch.return_value = {
            "success": True,
            "data": {
                "new_trending": [song_payload()],
                "new_albums": [album_payload()],
                "artist_recos": [
                    {
                        "id": "599452",
                        "name": "Imagine Dragons",
                        "perma_url": "https://www.jiosaavn.com/artist/imagine-dragons-songs/f0aFxsa231o_",
                    }
                ],
                "charts": [collection_payload("India Superhits Top 50")],
            },
        }
        mock_albums.return_value = {
            "success": True,
            "results": [self.provider._normalize_web_album(album_payload())],
        }
        mock_genres.return_value = {
            "success": True,
            "results": [
                {
                    "id": "37",
                    "title": "Rock",
                    "token": "DGl4UBWnRqlFo9wdEAzFBA__",
                    "type": "genre",
                }
            ],
        }

        result = self.provider.get_discovery_shelves()

        self.assertTrue(result["success"])
        self.assertEqual(result["count"]["trending"], 1)
        self.assertEqual(result["count"]["albums"], 2)
        self.assertEqual(result["count"]["artists"], 1)
        self.assertEqual(result["count"]["charts"], 1)
        self.assertEqual(result["count"]["genres"], 1)


if __name__ == "__main__":
    unittest.main()
