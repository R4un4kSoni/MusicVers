"""Unofficial JioSaavn provider used by NeonWave.

The primary source is JioSaavn's own web API (the one its website uses).
That API exposes the full international catalogue, including mainstream
Western originals that public community mirrors often hide because those
mirrors run outside the eligible region.

A community mirror is kept as a fallback. Both are unofficial and intended
for personal use only.
"""

import html
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit

import requests

from .audio_source import AudioSource
from .base_provider import BaseMusicProvider


class JioSaavnProvider(BaseMusicProvider):
    name = "jiosaavn"

    WEB_API = os.getenv(
        "JIOSAAVN_WEB_API",
        "https://www.jiosaavn.com/api.php",
    ).rstrip("/")

    API_BASE = os.getenv(
        "JIOSAAVN_API_BASE",
        "https://saavn.sumit.co/api",
    ).rstrip("/")

    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.jiosaavn.com/",
    }

    # Used to build the "Trending / Mainstream" shelf without relying on a
    # dedicated charts endpoint.
    CHART_QUERIES = (
        "Kesariya",
        "Srivalli",
        "Oo Antava",
        "Believer",
        "Blinding Lights",
        "Shape of You",
        "Dandelion",
        "Heeriye",
    )

    # Used to add recognisable international artists to the album shelf.
    ALBUM_QUERIES = (
        ("Pink Floyd", "Pink Floyd"),
        ("Imagine Dragons", "Imagine Dragons"),
        ("Alan Walker", "Alan Walker"),
        ("Ed Sheeran Shape of You", "Ed Sheeran"),
        ("The Weeknd Starboy", "The Weeknd"),
        ("Taylor Swift", "Taylor Swift"),
        ("Queen Bohemian Rhapsody", "Queen"),
        ("Bruno Mars Die With A Smile", "Bruno Mars"),
    )

    QUALITY_ORDER = ("320kbps", "160kbps", "96kbps", "48kbps", "12kbps")
    BITRATES = (320, 160, 96, 48, 12)

    # Hide karaoke, tribute and emulation versions so original recordings are
    # preferred. The web API already returns originals first, but some searches
    # still contain these versions further down the list.
    LOW_QUALITY_MARKERS = (
        "karaoke",
        "tribute",
        "originally performed",
        "originally perfomed",
        "instrumental version",
        "melody version",
        "8-bit",
        "16-bit",
        "emulation",
        "sped up",
        "slowed",
        "reverb",
        "backing track",
        "minus one",
        "piano cover",
        "string cover",
        "verse 1",
        "verse 2",
        "acoustic version",
        "unplugged",
        "mashup",
        "parody",
        "recreation",
        "cover version",
        "with lyrics",
    )

    def __init__(self, timeout: int = 12):
        self.timeout = timeout
        self._song_cache: Dict[str, Dict[str, Any]] = {}
        self._discovery_cache: Optional[Dict[str, Any]] = None
        self._discovery_cached_at: float = 0.0

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _clean(value: Any) -> str:
        return html.unescape(str(value or "")).strip()

    def _web_get(
        self,
        call: str,
        params: Optional[dict] = None,
    ) -> Dict[str, Any]:
        """Call JioSaavn's own web API."""

        payload = {
            "__call": call,
            "_format": "json",
            "_marker": 0,
            "ctx": "web6dot0",
            "api_version": 4,
        }
        payload.update(params or {})

        try:
            response = requests.get(
                self.WEB_API,
                params=payload,
                headers=self.HEADERS,
                timeout=self.timeout,
            )
            response.raise_for_status()
            data = response.json()
        except requests.exceptions.RequestException as error:
            return {
                "success": False,
                "error": f"JioSaavn network error: {error}",
            }
        except ValueError as error:
            return {
                "success": False,
                "error": f"Invalid JioSaavn response: {error}",
            }

        if not isinstance(data, dict):
            return {"success": False, "error": "Invalid JioSaavn response."}

        error = data.get("error")
        if error:
            if isinstance(error, dict):
                message = error.get("msg") or error.get("message")
            else:
                message = str(error)
            return {
                "success": False,
                "error": message or "JioSaavn request failed.",
            }

        if str(data.get("status", "")).lower() == "failure":
            return {
                "success": False,
                "error": self._clean(data.get("msg")) or "JioSaavn request failed.",
            }

        return {"success": True, "data": data}

    def _mirror_get(
        self,
        path: str,
        params: Optional[dict] = None,
    ) -> Dict[str, Any]:
        """Fallback to the public community mirror."""

        url = f"{self.API_BASE}{path}"

        try:
            response = requests.get(url, params=params, timeout=self.timeout)
            response.raise_for_status()
            data = response.json()
        except requests.exceptions.RequestException as error:
            return {
                "success": False,
                "error": f"JioSaavn network error: {error}",
            }
        except ValueError as error:
            return {
                "success": False,
                "error": f"Invalid JioSaavn response: {error}",
            }

        if not isinstance(data, dict) or not data.get("success"):
            message = (
                data.get("message", "JioSaavn request failed.")
                if isinstance(data, dict)
                else "JioSaavn request failed."
            )
            return {"success": False, "error": message}

        return {"success": True, "data": data.get("data")}

    # ------------------------------------------------------------------
    # Normalization
    # ------------------------------------------------------------------

    @staticmethod
    def _best_image(images: Any) -> Optional[str]:
        if not isinstance(images, list):
            return None

        preferred = ("500x500", "150x150", "50x50")

        for quality in preferred:
            for image in images:
                if isinstance(image, dict) and image.get("quality") == quality:
                    return image.get("url")

        for image in images:
            if isinstance(image, dict) and image.get("url"):
                return image.get("url")

        return None

    @classmethod
    def _web_thumbnail(cls, value: Any) -> Optional[str]:
        url = cls._clean(value)
        if not url:
            return None

        # The web API returns 150x150 artwork; JioSaavn serves the same image
        # at 500x500 by changing the suffix.
        return re.sub(
            r"-(\d+)x(\d+)\.(jpg|jpeg|png|webp)$",
            r"-500x500.\3",
            url,
            flags=re.IGNORECASE,
        )

    @classmethod
    def _web_artist(cls, song: Dict[str, Any]) -> str:
        more = song.get("more_info")
        artist_map = more.get("artistMap") if isinstance(more, dict) else None

        if isinstance(artist_map, dict):
            primary = (
                artist_map.get("primary_artists")
                or artist_map.get("primary")
                or []
            )
            if isinstance(primary, list) and primary:
                first = primary[0]
                if isinstance(first, dict) and first.get("name"):
                    return cls._clean(first["name"])

        subtitle = cls._clean(song.get("subtitle"))
        if " - " in subtitle:
            return subtitle.split(" - ", 1)[0].strip()

        return cls._clean(song.get("primary_artists")) or "Unknown Artist"

    @classmethod
    def _web_album(cls, song: Dict[str, Any]) -> Optional[str]:
        more = song.get("more_info")
        album = cls._clean(more.get("album")) if isinstance(more, dict) else ""
        if album:
            return album

        subtitle = cls._clean(song.get("subtitle"))
        if " - " in subtitle:
            parts = subtitle.split(" - ", 1)
            if len(parts) > 1 and parts[1].strip():
                return parts[1].strip()

        return None

    @classmethod
    def _duration(cls, value: Any) -> Optional[int]:
        try:
            duration = int(value)
        except (TypeError, ValueError):
            return None
        return duration if duration > 0 else None

    def _normalize_web(self, song: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(song, dict):
            return None

        song_id = song.get("id")
        title = self._clean(song.get("title") or song.get("song"))

        if not song_id or not title:
            return None

        more = song.get("more_info") if isinstance(song.get("more_info"), dict) else {}
        normalized = {
            "id": str(song_id),
            "title": title,
            "artist": self._web_artist(song),
            "album": self._web_album(song),
            "thumbnail": self._web_thumbnail(song.get("image")),
            "duration": self._duration(more.get("duration") or song.get("duration")),
            "language": self._clean(song.get("language")) or None,
            "year": self._clean(song.get("year")) or None,
            "provider": self.name,
            "source_url": self._clean(song.get("perma_url")) or None,
        }

        self._song_cache[normalized["id"]] = song
        return normalized

    def _normalize(self, song: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Normalize the community mirror's song shape."""

        if not isinstance(song, dict):
            return None

        song_id = song.get("id")
        title = song.get("name")

        if not song_id or not title:
            return None

        artists = song.get("artists") or {}
        primary = artists.get("primary") if isinstance(artists, dict) else []
        artist = "Unknown Artist"

        if isinstance(primary, list) and primary:
            first = primary[0]
            if isinstance(first, dict) and first.get("name"):
                artist = first["name"]

        album = song.get("album")
        album_name = album.get("name") if isinstance(album, dict) else None

        normalized = {
            "id": str(song_id),
            "title": str(title),
            "artist": artist,
            "album": album_name,
            "thumbnail": self._best_image(song.get("image")),
            "duration": self._duration(song.get("duration")),
            "language": song.get("language"),
            "year": song.get("year"),
            "provider": self.name,
            "source_url": song.get("url"),
        }

        self._song_cache[normalized["id"]] = song
        return normalized

    # ------------------------------------------------------------------
    # Albums, artists, charts and genres
    # ------------------------------------------------------------------

    @staticmethod
    def _token_from_url(value: Any) -> Optional[str]:
        url = str(value or "").strip()
        if not url:
            return None

        path = urlsplit(url).path.rstrip("/")
        return path.rsplit("/", 1)[-1] or None

    @classmethod
    def _normalize_web_album(cls, raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None

        album_id = raw.get("id")
        title = cls._clean(raw.get("title") or raw.get("name"))
        if not album_id or not title:
            return None

        more = raw.get("more_info") if isinstance(raw.get("more_info"), dict) else {}
        artist_map = more.get("artistMap") if isinstance(more.get("artistMap"), dict) else {}
        primary = (
            artist_map.get("primary_artists")
            or artist_map.get("primary")
            or []
        )

        artist = ""
        if isinstance(primary, list) and primary and isinstance(primary[0], dict):
            artist = cls._clean(primary[0].get("name"))

        if not artist:
            subtitle = cls._clean(raw.get("subtitle"))
            artist = subtitle.split(" - ", 1)[0].strip() if subtitle else ""

        track_count = cls._duration(
            more.get("song_count") or raw.get("list_count")
        )

        return {
            "id": str(album_id),
            "title": title,
            "artist": artist or "Unknown Artist",
            "thumbnail": cls._web_thumbnail(raw.get("image")),
            "token": cls._token_from_url(raw.get("perma_url")),
            "track_count": track_count,
            "language": cls._clean(raw.get("language")) or None,
            "year": cls._clean(raw.get("year")) or None,
            "type": "album",
            "source_url": cls._clean(raw.get("perma_url")) or None,
        }

    @classmethod
    def _normalize_web_artist(cls, raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None

        artist_id = raw.get("id") or raw.get("artistId")
        name = cls._clean(raw.get("name") or raw.get("title"))
        if not artist_id or not name:
            return None

        more = raw.get("more_info") if isinstance(raw.get("more_info"), dict) else {}
        urls = raw.get("urls") if isinstance(raw.get("urls"), dict) else {}
        source = (
            cls._clean(raw.get("perma_url"))
            or cls._clean(urls.get("overview"))
            or cls._clean(urls.get("songs"))
            or None
        )
        listeners = cls._duration(
            raw.get("follower_count")
            or raw.get("fan_count")
            or more.get("follower_count")
        )

        return {
            "id": str(artist_id),
            "name": name,
            "title": name,
            "thumbnail": cls._web_thumbnail(raw.get("image")),
            "token": cls._token_from_url(source),
            "listeners": listeners,
            "verified": bool(raw.get("isVerified")),
            "type": "artist",
            "source_url": source,
        }

    @classmethod
    def _normalize_web_collection(cls, raw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None

        collection_id = raw.get("id")
        title = cls._clean(raw.get("title") or raw.get("name"))
        if not collection_id or not title:
            return None

        more = raw.get("more_info") if isinstance(raw.get("more_info"), dict) else {}
        tags = more.get("tags") if isinstance(more.get("tags"), dict) else {}

        return {
            "id": str(collection_id),
            "title": title,
            "subtitle": cls._clean(raw.get("subtitle")) or None,
            "thumbnail": cls._web_thumbnail(raw.get("image")),
            "token": cls._token_from_url(raw.get("perma_url")),
            "count": cls._duration(raw.get("count") or raw.get("list_count")),
            "tags": {
                "genre": list(tags.get("genre") or []),
                "mood": list(tags.get("mood") or []),
            },
            "type": cls._clean(raw.get("type")) or "playlist",
            "source_url": cls._clean(raw.get("perma_url")) or None,
        }

    def _normalize_track_items(
        self,
        items: Any,
        limit: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        seen = set()

        for item in items if isinstance(items, list) else []:
            if self.is_low_quality(item):
                continue

            track = self._normalize_web(item)
            if track is None or track["id"] in seen:
                continue

            seen.add(track["id"])
            results.append(track)

            if limit is not None and len(results) >= limit:
                break

        return results

    def _launch_data(self, refresh: bool = False) -> Dict[str, Any]:
        now = time.monotonic()

        if (
            not refresh
            and self._discovery_cache is not None
            and now - self._discovery_cached_at < 900
        ):
            return {"success": True, "data": self._discovery_cache}

        response = self._web_get(
            "webapi.getLaunchData",
            {"is_server_side_load": "true"},
        )

        if response.get("success") and isinstance(response.get("data"), dict):
            self._discovery_cache = response["data"]
            self._discovery_cached_at = now

        return response

    def search_albums(
        self,
        query: str,
        limit: int = 20,
        page: int = 1,
    ) -> Dict[str, Any]:
        if not isinstance(query, str) or not query.strip():
            return {"success": False, "results": [], "error": "Query cannot be empty."}

        response = self._web_get(
            "search.getAlbumResults",
            {
                "q": query.strip(),
                "p": max(1, int(page)),
                "n": max(1, min(int(limit), 50)),
                "cc": "in",
            },
        )

        if not response.get("success"):
            return response

        raw = response["data"]
        items = raw.get("results", []) if isinstance(raw, dict) else []
        albums = []

        for item in items if isinstance(items, list) else []:
            album = self._normalize_web_album(item)
            if album is not None:
                albums.append(album)

        albums = albums[: max(1, min(int(limit), 50))]

        return {"success": bool(albums), "results": albums, "count": len(albums)}

    def search_artists(
        self,
        query: str,
        limit: int = 20,
        page: int = 1,
    ) -> Dict[str, Any]:
        if not isinstance(query, str) or not query.strip():
            return {"success": False, "results": [], "error": "Query cannot be empty."}

        response = self._web_get(
            "search.getArtistResults",
            {
                "q": query.strip(),
                "p": max(1, int(page)),
                "n": max(1, min(int(limit), 50)),
                "cc": "in",
            },
        )

        if not response.get("success"):
            return response

        raw = response["data"]
        items = raw.get("results", []) if isinstance(raw, dict) else []
        artists = []

        for item in items if isinstance(items, list) else []:
            artist = self._normalize_web_artist(item)
            if artist is not None:
                artists.append(artist)

        artists = artists[: max(1, min(int(limit), 50))]

        return {"success": bool(artists), "results": artists, "count": len(artists)}

    def get_album(
        self,
        album_id: Optional[str] = None,
        token: Optional[str] = None,
        limit: int = 50,
    ) -> Dict[str, Any]:
        if album_id:
            response = self._web_get(
                "content.getAlbumDetails",
                {"albumid": album_id},
            )
        elif token:
            response = self._web_get(
                "webapi.get",
                {"type": "album", "token": token, "p": 1, "n": limit},
            )
        else:
            return {"success": False, "error": "An album ID or token is required."}

        if not response.get("success"):
            return response

        raw = response["data"]
        if not isinstance(raw, dict):
            return {"success": False, "error": "Invalid album response."}

        album = self._normalize_web_album(raw)
        tracks = self._normalize_track_items(raw.get("list"), limit)

        return {
            "success": bool(album or tracks),
            "album": album,
            "tracks": tracks,
            "count": len(tracks),
        }

    def _artist_token(self, artist_id: str) -> Optional[str]:
        result = self.get_artist(artist_id=artist_id, kind="overview")
        artist = result.get("artist") or {}
        return artist.get("token")

    def get_artist(
        self,
        artist_id: Optional[str] = None,
        token: Optional[str] = None,
        page: int = 0,
        limit: int = 20,
        kind: str = "overview",
    ) -> Dict[str, Any]:
        limit = max(1, min(int(limit), 50))
        page = max(0, int(page))

        if kind == "overview" or (not token and artist_id):
            if not artist_id:
                return {"success": False, "error": "An artist ID is required."}

            response = self._web_get(
                "artist.getArtistPageDetails",
                {"artistId": artist_id},
            )

            if not response.get("success"):
                return response

            raw = response["data"]
            if not isinstance(raw, dict):
                return {"success": False, "error": "Invalid artist response."}

            artist = self._normalize_web_artist(raw)

            if kind != "overview":
                token = artist.get("token") if artist else None
                if not token:
                    return {"success": False, "error": "Artist token was not found."}
            else:
                urls = raw.get("urls") if isinstance(raw.get("urls"), dict) else {}
                similar = []

                for item in raw.get("similarArtists") or []:
                    entry = self._normalize_web_artist(item)
                    if entry is not None:
                        similar.append(entry)

                playlists = []

                for item in raw.get("featured_artist_playlist") or []:
                    entry = self._normalize_web_collection(item)
                    if entry is not None:
                        playlists.append(entry)

                return {
                    "success": artist is not None,
                    "artist": artist,
                    "songs": self._normalize_track_items(raw.get("topSongs"), limit),
                    "albums": [
                        norm
                        for norm in (
                            self._normalize_web_album(item)
                            for item in raw.get("topAlbums") or []
                        )
                        if norm is not None
                    ][:limit],
                    "singles": [
                        norm
                        for norm in (
                            self._normalize_web_album(item)
                            for item in raw.get("singles") or []
                        )
                        if norm is not None
                    ][:limit],
                    "similar_artists": similar[:limit],
                    "playlists": playlists[:limit],
                    "count": len(self._normalize_track_items(raw.get("topSongs"), limit)),
                    "bio": self._clean(raw.get("bio")) or None,
                    "source_url": (
                        self._clean(urls.get("overview"))
                        or self._clean(raw.get("perma_url"))
                        or None
                    ),
                }

        if not token:
            return {"success": False, "error": "An artist token is required."}

        sub_type = "albums" if kind == "albums" else "songs"
        response = self._web_get(
            "webapi.get",
            {
                "type": "artist",
                "token": token,
                "p": page,
                "n_song": limit if sub_type == "songs" else 0,
                "n_album": limit if sub_type == "albums" else 0,
                "sub_type": sub_type,
                "category": "",
                "sort_order": "desc",
            },
        )

        if not response.get("success"):
            return response

        raw = response["data"]
        if not isinstance(raw, dict):
            return {"success": False, "error": "Invalid artist response."}

        artist = self._normalize_web_artist(raw)

        if sub_type == "albums":
            albums = [
                norm
                for norm in (
                    self._normalize_web_album(item)
                    for item in raw.get("topAlbums") or []
                )
                if norm is not None
            ][:limit]
            return {
                "success": bool(albums),
                "artist": artist,
                "albums": albums,
                "songs": [],
                "count": len(albums),
            }

        songs = self._normalize_track_items(raw.get("topSongs"), limit)
        return {
            "success": bool(songs),
            "artist": artist,
            "songs": songs,
            "albums": [],
            "count": len(songs),
        }

    def get_artist_songs(
        self,
        artist_id: str,
        page: int = 0,
        limit: int = 20,
    ) -> Dict[str, Any]:
        return self.get_artist(
            artist_id=artist_id,
            page=page,
            limit=limit,
            kind="songs",
        )

    def get_artist_albums(
        self,
        artist_id: str,
        page: int = 0,
        limit: int = 20,
    ) -> Dict[str, Any]:
        return self.get_artist(
            artist_id=artist_id,
            page=page,
            limit=limit,
            kind="albums",
        )

    def get_chart_collections(self, limit: int = 10) -> Dict[str, Any]:
        response = self._web_get("content.getCharts")

        if not response.get("success"):
            return response

        raw = response["data"]
        items = raw if isinstance(raw, list) else []

        charts = []
        for item in items:
            chart = self._normalize_web_collection(item)
            if chart is not None:
                charts.append(chart)

        charts = charts[: max(1, min(int(limit), 50))]

        return {"success": bool(charts), "results": charts, "count": len(charts)}

    def get_featured_playlists(
        self,
        page: int = 1,
        limit: int = 20,
        language: Optional[str] = None,
    ) -> Dict[str, Any]:
        params = {
            "p": max(1, int(page)),
            "n": max(1, min(int(limit), 50)),
            "fetch_from_serialized_files": 1,
        }
        if language:
            params["languages"] = language

        response = self._web_get("content.getFeaturedPlaylists", params)

        if not response.get("success"):
            return response

        raw = response["data"]
        items = raw.get("data", []) if isinstance(raw, dict) else []
        playlists = []

        for item in items if isinstance(items, list) else []:
            playlist = self._normalize_web_collection(item)
            if playlist is not None:
                playlists.append(playlist)

        playlists = playlists[: max(1, min(int(limit), 50))]

        return {"success": bool(playlists), "results": playlists, "count": len(playlists)}

    def get_collection_tracks(
        self,
        token: str,
        page: int = 1,
        limit: int = 50,
    ) -> Dict[str, Any]:
        if not isinstance(token, str) or not token.strip():
            return {"success": False, "error": "Invalid playlist token."}

        response = self._web_get(
            "webapi.get",
            {
                "type": "playlist",
                "token": token.strip(),
                "p": max(1, int(page)),
                "n": max(1, min(int(limit), 100)),
            },
        )

        if not response.get("success"):
            return response

        raw = response["data"]
        if not isinstance(raw, dict):
            return {"success": False, "error": "Invalid playlist response."}

        collection = self._normalize_web_collection(raw)
        tracks = self._normalize_track_items(raw.get("list"), limit)

        return {
            "success": bool(tracks),
            "collection": collection,
            "tracks": tracks,
            "count": len(tracks),
        }

    def get_genres(self, limit: int = 24) -> Dict[str, Any]:
        """Return mood/genre cards that map to real, playable playlists."""

        launch = self._launch_data()
        if not launch.get("success"):
            return launch

        data = launch["data"]

        # Curated playlists all have working tokens; channel tokens do not.
        pools = []
        for key in ("promo:vx:data:76", "top_playlists"):
            for item in data.get(key) or []:
                collection = self._normalize_web_collection(item)
                if collection and collection.get("token"):
                    pools.append(collection)

        for language in ("english", "hindi"):
            playlists = self.get_featured_playlists(
                page=1,
                limit=20,
                language=language,
            )
            if playlists.get("success"):
                pools.extend(playlists["results"])

        keywords = {
            "romance": ("romance", "love", "heartbeat"),
            "happy": ("happy", "khushiyaan", "feel good", "good"),
            "chill": ("chill", "beats", "indie"),
            "hip hop": ("hip hop", "rap", "cypher"),
            "desi hip hop": ("hip hop", "desi", "rap"),
            "edm": ("dance", "drop", "house", "edm"),
            "devotional": ("devotional", "bhakti"),
            "ghazal": ("ghazal",),
            "sufi": ("sufi",),
            "pop": ("pop",),
            "alternative": ("indie", "alternative"),
            "k-pop": ("k-pop", "kpop"),
            "rock": ("rock",),
            "r&b": ("r&b", "r and b"),
            "indie": ("indie",),
            "folk": ("folk", "indie"),
            "retro": ("retro", "90s", "2000s", "classics"),
            "dance": ("dance", "party", "dance hits"),
            "workout": ("workout",),
        }

        results: List[Dict[str, Any]] = []
        seen_tokens = set()

        for item in data.get("browse_discover") or []:
            card = self._normalize_web_collection(item)
            if card is None or not card.get("token"):
                continue

            title = card["title"].lower().strip()
            tags = " ".join(card["tags"].get("genre", []) + card["tags"].get("mood", [])).lower()
            needle = f"{title} {tags}"
            terms = keywords.get(title, (title,))

            match = None
            for pool in pools:
                pool_text = f"{pool['title']} {pool.get('subtitle') or ''}".lower()
                if any(term in pool_text for term in terms):
                    match = pool
                    break

            if match is None:
                continue
            if match["token"] in seen_tokens:
                continue

            seen_tokens.add(match["token"])
            results.append({
                "id": card["id"],
                "title": card["title"],
                "subtitle": match["title"],
                "thumbnail": card["thumbnail"] or match["thumbnail"],
                "token": match["token"],
                "type": "genre",
                "source_url": match["source_url"],
                "tags": card["tags"],
            })

            if len(results) >= max(1, min(int(limit), 40)):
                break

        # Add a few playable playlists as genre/mood cards if mapping was thin.
        for pool in pools:
            if len(results) >= max(1, min(int(limit), 40)):
                break

            if pool["token"] in seen_tokens:
                continue

            seen_tokens.add(pool["token"])
            results.append({
                "id": pool["id"],
                "title": pool["title"],
                "subtitle": pool.get("subtitle") or "Curated playlist",
                "thumbnail": pool["thumbnail"],
                "token": pool["token"],
                "type": "genre",
                "source_url": pool["source_url"],
                "tags": {"genre": [], "mood": []},
            })

        return {"success": bool(results), "results": results, "count": len(results)}

    def get_discovery_shelves(self, refresh: bool = False) -> Dict[str, Any]:
        """Return everything the Discover page needs in one cached response."""

        launch = self._launch_data(refresh=refresh)
        if not launch.get("success"):
            return launch

        data = launch["data"]

        def albums_from(items: Any, limit: int) -> List[Dict[str, Any]]:
            albums = []
            seen = set()
            for item in items if isinstance(items, list) else []:
                album = self._normalize_web_album(item)
                if album and album["id"] not in seen:
                    seen.add(album["id"])
                    albums.append(album)
                if len(albums) >= limit:
                    break
            return albums

        def artists_from(items: Any, limit: int) -> List[Dict[str, Any]]:
            artists = []
            seen = set()
            for item in items if isinstance(items, list) else []:
                artist = self._normalize_web_artist(item)
                if artist and artist["id"] not in seen:
                    seen.add(artist["id"])
                    artists.append(artist)
                if len(artists) >= limit:
                    break
            return artists

        trending = self._normalize_track_items(data.get("new_trending"), 16)

        def curated_album(query_pair):
            query, artist_name = query_pair
            result = self.search_albums(query, limit=4)

            for album in result.get("results", []):
                if artist_name.lower() in album["artist"].lower():
                    return album

            return result.get("results", [None])[0]

        curated = []
        curated_ids = set()
        with ThreadPoolExecutor(max_workers=len(self.ALBUM_QUERIES)) as pool:
            for album in pool.map(curated_album, self.ALBUM_QUERIES):
                if album is not None and album["id"] not in curated_ids:
                    curated_ids.add(album["id"])
                    curated.append(album)

        new_albums = albums_from(data.get("new_albums"), 10)
        new_albums.extend(albums_from(data.get("new_trending"), 10))

        seen_albums = set(curated_ids)
        for album in new_albums:
            if album["id"] not in seen_albums and len(curated) < 16:
                seen_albums.add(album["id"])
                curated.append(album)

        new_albums = curated[:16]

        charts = []
        for item in data.get("charts") or []:
            chart = self._normalize_web_collection(item)
            if chart is not None:
                charts.append(chart)
        charts = charts[:12]

        artists = artists_from(data.get("artist_recos"), 16)

        genres_result = self.get_genres(limit=24)
        genres = genres_result.get("results", []) if genres_result.get("success") else []

        return {
            "success": True,
            "trending": trending,
            "albums": new_albums,
            "artists": artists,
            "charts": charts,
            "genres": genres,
            "count": {
                "trending": len(trending),
                "albums": len(new_albums),
                "artists": len(artists),
                "charts": len(charts),
                "genres": len(genres),
            },
        }

    @classmethod
    def is_low_quality(cls, song: Dict[str, Any]) -> bool:
        """True for karaoke/cover/emulation versions of a song."""

        if not isinstance(song, dict):
            return True

        parts = [
            cls._clean(song.get(key))
            for key in ("name", "title", "song", "subtitle", "artist")
        ]

        artists = song.get("artists")
        if isinstance(artists, dict):
            for key in ("primary", "featured"):
                group = artists.get(key)
                if isinstance(group, list):
                    for artist in group:
                        if isinstance(artist, dict):
                            parts.append(cls._clean(artist.get("name")))

        more = song.get("more_info")
        if isinstance(more, dict):
            parts.append(cls._clean(song.get("primary_artists")))
            artist_map = more.get("artistMap")
            if isinstance(artist_map, dict):
                for key in (
                    "primary_artists",
                    "featured_artists",
                    "primary",
                    "featured",
                ):
                    group = artist_map.get(key)
                    if isinstance(group, list):
                        for artist in group:
                            if isinstance(artist, dict):
                                parts.append(cls._clean(artist.get("name")))

        text = " ".join(part for part in parts if part).lower()
        return any(marker in text for marker in cls.LOW_QUALITY_MARKERS)

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def _search_web(
        self,
        query: str,
        limit: int,
    ) -> Dict[str, Any]:
        response = self._web_get(
            "search.getResults",
            {
                "q": query,
                "p": 1,
                "n": max(1, min(int(limit), 50)),
                "cc": "in",
                "includeMetaTags": 1,
            },
        )

        if not response["success"]:
            return response

        data = response["data"]
        raw_results = data.get("results", []) if isinstance(data, dict) else []

        results = []
        hidden_count = 0

        for song in raw_results if isinstance(raw_results, list) else []:
            if self.is_low_quality(song):
                hidden_count += 1
                continue

            normalized = self._normalize_web(song)
            if normalized is not None:
                results.append(normalized)

        return {
            "success": bool(results),
            "results": results,
            "count": len(results),
            "hidden_count": hidden_count,
        }

    def _search_mirror(
        self,
        query: str,
        limit: int,
    ) -> Dict[str, Any]:
        response = self._mirror_get(
            "/search/songs",
            {"query": query, "limit": max(1, min(int(limit), 50))},
        )

        if not response["success"]:
            return response

        data = response["data"]
        raw_results = data.get("results", []) if isinstance(data, dict) else []

        results = []
        hidden_count = 0

        for song in raw_results if isinstance(raw_results, list) else []:
            if self.is_low_quality(song):
                hidden_count += 1
                continue

            normalized = self._normalize(song)
            if normalized is not None:
                results.append(normalized)

        return {
            "success": bool(results),
            "results": results,
            "count": len(results),
            "hidden_count": hidden_count,
        }

    def search(self, query: str, limit: int = 20) -> Dict[str, Any]:
        if not isinstance(query, str) or not query.strip():
            return {
                "success": False,
                "results": [],
                "error": "Search query cannot be empty.",
            }

        query = query.strip()
        hidden_count = 0

        for backend in (self._search_web, self._search_mirror):
            result = backend(query, limit)
            hidden_count += result.get("hidden_count", 0)

            if result.get("success"):
                return {
                    "success": True,
                    "results": result["results"],
                    "count": len(result["results"]),
                }

        if hidden_count:
            return {
                "success": False,
                "results": [],
                "error": (
                    "JioSaavn only has cover or karaoke versions of this "
                    "song. Switch to YouTube to play the original."
                ),
                "only_low_quality": True,
            }

        return {
            "success": False,
            "results": [],
            "error": "No JioSaavn songs found for that search.",
        }

    # ------------------------------------------------------------------
    # Song details and streams
    # ------------------------------------------------------------------

    def get_song(self, track_id: str) -> Dict[str, Any]:
        """Return raw song data, using an in-memory cache when possible."""

        if not isinstance(track_id, str) or not track_id.strip():
            return {"success": False, "error": "Invalid track ID."}

        track_id = track_id.strip()

        cached = self._song_cache.get(track_id)
        if cached is not None:
            return {"success": True, "song": cached}

        web = self._web_get(
            "song.getDetails",
            {
                "pids": track_id,
                "cc": "in",
                "_marker": "0?_marker=0",
            },
        )

        if web["success"]:
            data = web["data"]
            song = data.get(track_id)

            if not isinstance(song, dict):
                songs = data.get("songs")
                song = songs[0] if isinstance(songs, list) and songs else None

            if isinstance(song, dict):
                self._song_cache[track_id] = song
                return {"success": True, "song": song}

        mirror = self._mirror_get(f"/songs/{track_id}")
        if not mirror["success"]:
            return mirror

        data = mirror["data"]

        if isinstance(data, list):
            song = data[0] if data else None
        elif isinstance(data, dict):
            song = data.get("songs", [None])[0] if isinstance(data.get("songs"), list) else data
        else:
            song = None

        if not isinstance(song, dict):
            return {"success": False, "error": "Song details were not found."}

        self._song_cache[track_id] = song
        return {"success": True, "song": song}

    @staticmethod
    def _quality_from_url(url: str) -> Optional[str]:
        match = re.search(r"_(\d+)\.(?:mp4|m4a|mp3)(?:\?|$)", url, re.IGNORECASE)
        if not match:
            return None
        return f"{match.group(1)}kbps"

    @staticmethod
    def _playable_stream_url(url: str) -> str:
        """Return a URL VLC can open.

        JioSaavn's auth token endpoint returns a signed `web.saavncdn.com`
        URL. Akamai rejects VLC's user agent with HTTP 403, but the same audio
        is available without a signature on `aac.saavncdn.com` (the host used
        by the public API and by JioSaavn's own player).
        """

        parts = urlsplit(url)

        if parts.netloc.lower() == "web.saavncdn.com":
            return urlunsplit(
                ("https", "aac.saavncdn.com", parts.path, "", "")
            )

        return url

    def _get_stream_web(
        self,
        track_id: str,
        quality: str,
    ) -> Dict[str, Any]:
        song_result = self.get_song(track_id)
        if not song_result.get("success"):
            return song_result

        song = song_result["song"]

        more = song.get("more_info") if isinstance(song.get("more_info"), dict) else {}
        encrypted_url = more.get("encrypted_media_url") or song.get("encrypted_media_url")

        if not encrypted_url:
            return {
                "success": False,
                "error": "JioSaavn did not provide an audio stream for this song.",
            }

        requested = self._duration(quality.replace("kbps", "")) if isinstance(quality, str) else None
        bitrates = list(self.BITRATES)

        if requested and requested in bitrates:
            bitrates.remove(requested)
            bitrates.insert(0, requested)

        metadata = self._normalize(song) or self._normalize_web(song) or {}

        for bitrate in bitrates:
            response = self._web_get(
                "song.generateAuthToken",
                {
                    "url": encrypted_url,
                    "bitrate": bitrate,
                    "pid": track_id,
                },
            )

            if not response["success"]:
                continue

            data = response["data"]
            stream_url = data.get("auth_url") if isinstance(data, dict) else None

            if not isinstance(stream_url, str) or not stream_url:
                continue

            if stream_url.startswith("//"):
                stream_url = f"https:{stream_url}"
            elif not stream_url.lower().startswith(("http://", "https://")):
                stream_url = f"https://{stream_url}"

            stream_url = self._playable_stream_url(stream_url)

            metadata.update(
                {
                    "stream_url": stream_url,
                    "quality": self._quality_from_url(stream_url) or f"{bitrate}kbps",
                }
            )
            return {"success": True, "track": metadata}

        return {
            "success": False,
            "error": "JioSaavn could not generate an audio stream link.",
        }

    def _get_stream_mirror(
        self,
        track_id: str,
        quality: str,
    ) -> Dict[str, Any]:
        song_result = self.get_song(track_id)
        if not song_result.get("success"):
            return song_result

        song = song_result["song"]
        metadata = self._normalize(song) or self._normalize_web(song) or {}

        options = song.get("downloadUrl")

        if not isinstance(options, list) or not options:
            return {
                "success": False,
                "error": "JioSaavn did not provide an audio stream for this song.",
            }

        by_quality = {
            str(option.get("quality")): option.get("url")
            for option in options
            if isinstance(option, dict) and option.get("url")
        }

        if quality in by_quality:
            stream_url = by_quality[quality]
            selected_quality = quality
        else:
            selected_quality = next(
                (item for item in self.QUALITY_ORDER if item in by_quality),
                None,
            )
            if selected_quality is None:
                return {
                    "success": False,
                    "error": "No supported audio quality is available.",
                }
            stream_url = by_quality[selected_quality]

        metadata.update(
            {
                "stream_url": stream_url,
                "quality": selected_quality,
            }
        )

        return {"success": True, "track": metadata}

    def get_stream(
        self,
        track_id: str,
        quality: str = "320kbps",
    ) -> Dict[str, Any]:
        """Resolve a track ID to a directly playable audio URL."""

        result = self._get_stream_web(track_id, quality)
        if result.get("success"):
            return result

        return self._get_stream_mirror(track_id, quality)

    def get_audio_source(self, track_id: str) -> Optional[AudioSource]:
        """Expose a stream AudioSource for callers that need one."""

        result = self.get_stream(track_id)

        if not result.get("success"):
            return None

        track = result["track"]

        return AudioSource(
            url=track["stream_url"],
            mime_type="audio/mp4",
            extension=".m4a",
            download_allowed=False,
            authorization_type="public_stream",
            authorization_reference=f"jiosaavn:{track['id']}",
            media_type="audio",
        )

    def charts(self, per_query: int = 1) -> Dict[str, Any]:
        """Return a curated mainstream shelf from well-known search terms."""

        results: List[Dict[str, Any]] = []
        seen = set()
        errors = []

        for query in self.CHART_QUERIES:
            response = self.search(query, limit=per_query)

            if not response.get("success"):
                errors.append(response.get("error", f"Failed to load {query}."))
                continue

            for song in response["results"]:
                if song["id"] not in seen:
                    seen.add(song["id"])
                    results.append(song)

        if not results:
            return {
                "success": False,
                "results": [],
                "error": errors[0] if errors else "Could not load trending songs.",
            }

        return {
            "success": True,
            "results": results,
            "count": len(results),
        }

    def get_capabilities(self) -> Dict[str, Any]:
        return {
            "search": True,
            "audio_source": False,
            "streaming": True,
            "download": True,
            "embed_playback": False,
        }
