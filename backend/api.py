import html
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

from backend.library import scan_music_folder
from backend.metadata import get_metadata
from backend.settings_store import (
    get_music_folder,
    set_music_folder,
    get_theme,
    set_theme,
    get_profile_picture,
    set_profile_picture,
)
from backend.player import MusicPlayer
from backend.services.vidkraken_client import VidKrakenClient
from backend.services.permanent_download_service import PermanentDownloadService
from backend.database import (
    create_tables,
    get_connection,
    save_songs,
    get_all_songs,
)
from backend.services.providers.audio_source import AudioSource
from backend.playlist import (
    create_playlist as db_create_playlist,
    get_all_playlists,
    add_song_to_playlist,
    get_playlist_songs as db_get_playlist_songs,
    remove_song_from_playlist,
    delete_playlist as db_delete_playlist,
    rename_playlist as db_rename_playlist,
    get_liked_song_ids,
    toggle_like_song,
    LIKED_PLAYLIST_NAME,
)

from backend.services.music_service import MusicService
from backend.services.providers.jiosaavn_provider import JioSaavnProvider
from backend.saved_albums import (
    get_saved_albums,
    save_album as db_save_album,
    remove_saved_album as db_remove_saved_album,
)

AUTHORIZED_VIDEO_IDS = set()

class NeonWaveAPI:

    def __init__(self):
        self.player = MusicPlayer()

        create_tables()

        self.music_service = MusicService()
        self.jiosaavn = JioSaavnProvider()
        self.music_service.register_provider(self.jiosaavn.name, self.jiosaavn)
        self.music_service.set_provider(self.jiosaavn.name)

        self.vidkraken = VidKrakenClient()
        self.permanent_download_service = PermanentDownloadService(get_music_folder())
        # Tracks jobs started during this application session.
        self._vidkraken_jobs = {}
        self._youtube_metadata = {}
        self._jiosaavn_metadata = {}
        self._mainstream_picks = None
        self._discovery_shelves = None

    # Curated mainstream artists/songs. JioSaavn's own web API carries the
    # original recordings for these, so the Discover shelf uses real audio
    # streams instead of YouTube embeds.
    MAINSTREAM_QUERIES = (
        "Bruno Mars",
        "Alan Walker",
        "Imagine Dragons Believer",
        "Ed Sheeran Shape of You",
        "The Weeknd Starboy",
        "Maroon 5 Sugar",
    )

    def set_video_handle(self, handle):
        if not isinstance(handle, int) or handle <= 0:
            return False

        self.player.set_video_handle(handle)
        return True

    # ==========================================
    # CONNECTION
    # ==========================================

    def ping(self):
        return "Python backend connected successfully!"

    # ==========================================
    # USER SETTINGS
    # ==========================================

    def get_music_folder(self):
        return {
            "success": True,
            "folder": get_music_folder()
        }

    def set_music_folder(self, folder_path):
        if not isinstance(folder_path, str) or not folder_path.strip():
            return {
                "success": False,
                "message": "Please choose a valid music folder."
            }

        folder = Path(folder_path).expanduser()

        if not folder.is_dir():
            return {
                "success": False,
                "message": "That folder does not exist."
            }

        if not set_music_folder(str(folder)):
            return {
                "success": False,
                "message": "Could not save that folder."
            }

        return {
            "success": True,
            "folder": str(folder.resolve())
        }

    def choose_music_folder(self):
        """Open a native folder picker and store the selected folder."""

        try:
            import webview

            windows = getattr(webview, "windows", [])
            if not windows:
                return {
                    "success": False,
                    "message": "The desktop window is not available."
                }

            selection = windows[0].create_file_dialog(
                webview.FOLDER_DIALOG,
                directory=get_music_folder()
            )

            if not selection:
                return {
                    "success": False,
                    "message": "No folder was selected.",
                    "cancelled": True
                }

            folder = selection[0] if isinstance(selection, (list, tuple)) else selection
            return self.set_music_folder(str(folder))

        except Exception as error:
            return {
                "success": False,
                "message": str(error)
            }

    def scan_music_folder(self):
        """Scan the configured local music folder and refresh the library."""

        folder = get_music_folder()

        if not Path(folder).is_dir():
            return {
                "success": False,
                "songs": [],
                "count": 0,
                "error": f"Music folder does not exist: {folder}"
            }

        return self.get_song(folder)


    # ==========================================
    # APPEARANCE
    # ==========================================

    def get_theme(self):
        return {"success": True, "theme": get_theme()}

    def set_theme(self, theme):
        if set_theme(theme):
            return {"success": True, "theme": get_theme()}

        return {
            "success": False,
            "message": "Theme must be 'light' or 'dark'."
        }

    def get_profile_picture(self):
        return {"success": True, "picture": get_profile_picture()}

    def set_profile_picture(self, picture):
        if set_profile_picture(picture):
            return {"success": True, "picture": get_profile_picture()}

        return {"success": False, "message": "Choose a valid image file."}


    # ==========================================
    # SAVED ALBUMS
    # ==========================================

    def get_saved_albums(self):
        try:
            albums = get_saved_albums()
            return {"success": True, "albums": albums, "count": len(albums)}
        except Exception as error:
            return {"success": False, "albums": [], "error": str(error)}

    def save_album(self, album):
        try:
            saved = db_save_album(album)
            return {
                "success": bool(saved),
                "message": "Album saved to your library." if saved else "Invalid album."
            }
        except Exception as error:
            return {"success": False, "message": str(error)}

    def remove_saved_album(self, album_key):
        try:
            db_remove_saved_album(album_key)
            return {"success": True, "message": "Album removed from saved."}
        except Exception as error:
            return {"success": False, "message": str(error)}


    # ==========================================
    # PLAYLIST COVER
    # ==========================================

    def set_playlist_cover(self, playlist_id, cover):
        try:
            from backend.database import get_connection

            connection = get_connection()
            try:
                cursor = connection.execute(
                    "UPDATE playlists SET cover = ? WHERE id = ?",
                    (cover or None, int(playlist_id)),
                )
                connection.commit()
                updated = cursor.rowcount > 0
            finally:
                connection.close()

            return {
                "success": updated,
                "message": "Cover updated." if updated else "Playlist not found."
            }
        except Exception as error:
            return {"success": False, "message": str(error)}


    # ==========================================
    # VIDKRAKEN ACCOUNT STATUS
    # ==========================================



    def get_vidkraken_status(self):
        try:
            result = self.vidkraken.get_account()

            if not result.get("success"):
                return result

            account = result.get("account", {})

            if not isinstance(account, dict):
                return {
                    "success": False,
                    "error": "Invalid account response."
                }

            plan = account.get("plan", {})
            balances = account.get("balances", {})

            if not isinstance(plan, dict):
                plan = {}

            if not isinstance(balances, dict):
                balances = {}

            def normalize_quota(quota):
                if not isinstance(quota, dict):
                    return {
                        "granted": None,
                        "used": None,
                        "remaining": None,
                        "unlimited": False,
                        "resets_at": None
                    }

                return {
                    "granted": quota.get("granted"),
                    "used": quota.get("used"),
                    "remaining": quota.get("remaining"),
                    "unlimited": quota.get("unlimited", False),
                    "resets_at": quota.get("resetsAt")
                }

            return {
                "success": True,

                "plan": {
                    "id": plan.get("id")
                },

                "usage": {
                    "download_count": normalize_quota(
                        balances.get("download_count")
                    ),

                    "bandwidth_mb": normalize_quota(
                        balances.get("bandwidth_mb")
                    ),

                    "info": normalize_quota(
                        balances.get("info")
                    )
                }
            }

        except Exception as error:
            print("VIDKRAKEN STATUS ERROR:", error)

            return {
                "success": False,
                "error": "Could not retrieve VidKraken account status."
            }


    # ==========================================
    # VIDKRAKEN DOWNLOAD MANAGEMENT
    # ==========================================


    def start_vidkraken_download(
        self,
        url,
        media_format="audio"
    ):
        """Start a download only for a manually approved video ID."""

        import re
        from urllib.parse import urlparse, parse_qs

        try:
            if not isinstance(url, str) or not url.strip():
                return {
                    "success": False,
                    "error": "A valid YouTube URL is required."
                }

            parsed = urlparse(url)

            allowed_hosts = {
                "youtube.com",
                "www.youtube.com",
                "m.youtube.com",
                "youtu.be"
            }

            if parsed.scheme != "https":
                return {
                    "success": False,
                    "error": "Only HTTPS YouTube URLs are accepted."
                }

            if parsed.hostname not in allowed_hosts:
                return {
                    "success": False,
                    "error": "Invalid YouTube URL."
                }

            if parsed.username or parsed.password:
                return {
                    "success": False,
                    "error": "Invalid URL credentials."
                }

            if parsed.port not in (None, 443):
                return {
                    "success": False,
                    "error": "Invalid URL port."
                }

            video_id = None

            if parsed.hostname == "youtu.be":
                parts = parsed.path.strip("/").split("/")
                if len(parts) == 1:
                    video_id = parts[0]

            elif parsed.path == "/watch":
                video_id = parse_qs(
                    parsed.query
                ).get("v", [None])[0]

            elif parsed.path.startswith(("/shorts/", "/embed/")):
                parts = parsed.path.strip("/").split("/")
                if len(parts) == 2:
                    video_id = parts[1]

            if not video_id or not re.fullmatch(
                r"[A-Za-z0-9_-]{11}",
                video_id
            ):
                return {
                    "success": False,
                    "error": "Invalid YouTube video ID."
                }

            if video_id not in AUTHORIZED_VIDEO_IDS:
                return {
                    "success": False,
                    "error": "This video ID is not in your authorized download list."
                }

            # This workflow currently supports audio only.
            allowed_formats = {
                "audio",
                "audio-mp3",
                "audio-aac"
            }

            if media_format not in allowed_formats:
                return {
                    "success": False,
                    "error": "Unsupported audio format."
                }

            result = self.vidkraken.start_download(
                url=url,
                format=media_format,
                authorized=True
            )

            if not isinstance(result, dict) or not result.get("success"):
                return result

            job_id = result.get("job_id")

            if not isinstance(job_id, str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{1,128}",
                job_id
            ):
                return {
                    "success": False,
                    "error": "VidKraken returned an invalid job ID."
                }

            # Only jobs started by this backend are registered.
            self._vidkraken_jobs[job_id] = {
                "video_id": video_id,
                "saved": False,
                "processing": False,
                "save_result": None
            }

            return result

        except Exception as error:
            print("VIDKRAKEN DOWNLOAD ERROR:", error)

            return {
                "success": False,
                "error": "Could not start VidKraken download."
            }


    def get_vidkraken_download_status(self, job_id):
        """Check a registered job and permanently save completed audio."""

        try:
            if not isinstance(job_id, str):
                return {
                    "success": False,
                    "error": "Invalid VidKraken job ID."
                }

            job = self._vidkraken_jobs.get(job_id)

            if not isinstance(job, dict):
                return {
                    "success": False,
                    "error": "Unknown VidKraken job. Start the job through NeonWave first."
                }

            video_id = job.get("video_id")

            # Recheck the manual authorization list.
            if video_id not in AUTHORIZED_VIDEO_IDS:
                return {
                    "success": False,
                    "error": "This video is no longer in your authorized download list."
                }

            # Avoid downloading the same completed job more than once.
            if job.get("saved"):
                return {
                    "success": True,
                    "status": "COMPLETED",
                    "saved": True,
                    "song": job["save_result"].get("song")
                }

            if job.get("processing"):
                return {
                    "success": True,
                    "status": "SAVING",
                    "saved": False
                }

            result = self.vidkraken.get_download_status(job_id)

            if not isinstance(result, dict) or not result.get("success"):
                return result

            status = result.get("status")

            if not isinstance(status, str):
                return {
                    "success": False,
                    "error": "VidKraken returned an invalid job status."
                }

            status = status.upper()

            # Job is not finished yet.
            if status != "COMPLETED":
                return {
                    "success": True,
                    "status": status,
                    "progress": result.get("progress"),
                    "saved": False
                }

            download_url = result.get("download_url")
            actual_format = result.get("actual_format")

            if not isinstance(download_url, str) or not download_url:
                return {
                    "success": False,
                    "error": "VidKraken did not provide a download URL."
                }

            # Only accept formats supported by the local music library.
            format_map = {
                "mp3": (".mp3", "audio/mpeg"),
                "audio-mp3": (".mp3", "audio/mpeg"),
                "aac": (".aac", "audio/aac"),
                "audio-aac": (".aac", "audio/aac"),
                "m4a": (".m4a", "audio/mp4")
            }

            format_details = format_map.get(
                str(actual_format).lower()
            )

            if format_details is None:
                return {
                    "success": False,
                    "error": f"Unsupported VidKraken audio format: {actual_format}"
                }

            extension, mime_type = format_details

            # The job is registered and its video is still authorized.
            # Record that authorization in the source object.
            source = AudioSource(
                url=download_url,
                mime_type=mime_type,
                extension=extension,
                download_allowed=True,
                authorization_type="manual_allowlist",
                authorization_reference=f"manual_allowlist:{video_id}",
                media_type="audio"
            )

            job["processing"] = True

            try:
                save_result = self.permanent_download_service.download_and_save(
                    source,
                    metadata={}
                )
            finally:
                job["processing"] = False

            if not save_result.get("success"):
                return {
                    "success": False,
                    "status": "COMPLETED",
                    "saved": False,
                    "error": save_result.get(
                        "error",
                        "Could not save the completed audio."
                    )
                }

            job["saved"] = True
            job["save_result"] = save_result

            return {
                "success": True,
                "status": "COMPLETED",
                "saved": True,
                "song": save_result.get("song"),
                "file_path": save_result.get("file_path")
            }

        except Exception as error:
            print("VIDKRAKEN STATUS ERROR:", error)

            return {
                "success": False,
                "error": "Could not process VidKraken download status."
            }




    # ==========================================
    # LOCAL MUSIC LIBRARY
    # ==========================================

    def get_song(self, folder_path):
        try:
            songs = scan_music_folder(folder_path)

            saved_count = save_songs(songs)

            return {
                "success": True,
                "songs": songs,
                "count": len(songs),
                "saved": saved_count
            }

        except Exception as error:
            return {
                "success": False,
                "songs": [],
                "count": 0,
                "error": str(error)
            }

    def get_saved_songs(self):
        try:
            songs = get_all_songs()

            return {
                "success": True,
                "songs": songs,
                "count": len(songs)
            }

        except Exception as error:
            return {
                "success": False,
                "songs": [],
                "count": 0,
                "error": str(error)
            }

    # ==========================================
    # PLAYLIST MANAGEMENT
    # ==========================================

    def create_playlist(self, name, cover=None):
        try:
            playlist_id = db_create_playlist(name, cover)

            if playlist_id is None:
                return {
                    "success": False,
                    "message": "Playlist name cannot be empty."
                }

            return {
                "success": True,
                "playlist_id": playlist_id,
                "message": "Playlist created successfully."
            }

        except Exception as error:
            return {
                "success": False,
                "message": str(error)
            }

    def get_playlists(self):
        try:
            playlists = get_all_playlists()

            return {
                "success": True,
                "playlists": playlists,
                "count": len(playlists)
            }

        except Exception as error:
            return {
                "success": False,
                "playlists": [],
                "count": 0,
                "error": str(error)
            }

    # ------------------------------------------------------------------
    # STREAMING TRACKS IN THE EXISTING LIBRARY MODEL
    # ------------------------------------------------------------------
    # Likes and playlists use integer `songs.id` values through a foreign key.
    # Streaming tracks arrive with provider IDs, so we give them a stable,
    # synthetic library path the first time they are liked or playlist-added.
    # Playback recognises that path and routes back to the online provider.

    @staticmethod
    def _stream_track_path(track):
        if not isinstance(track, dict):
            return None

        provider = str(track.get("provider") or "youtube").strip().lower()
        track_id = track.get("id")

        if track_id in (None, ""):
            return None

        return f"stream:{provider}:{track_id}"

    @staticmethod
    def _stream_track_key(track):
        if not isinstance(track, dict):
            return ""

        provider = str(track.get("provider") or "youtube").strip().lower()
        track_id = track.get("id")

        if track_id in (None, ""):
            return ""

        return f"{provider}:{track_id}"

    def resolve_saved_tracks(self, tracks):
        """Return existing library IDs for streaming tracks without creating rows."""

        if not isinstance(tracks, list):
            return {"success": False, "tracks": [], "error": "Invalid track list."}

        wanted = {}
        for track in tracks:
            key = self._stream_track_key(track)
            path = self._stream_track_path(track)
            if key and path:
                wanted[path] = key

        if not wanted:
            return {"success": True, "tracks": []}

        resolved = []
        try:
            connection = get_connection()
            try:
                cursor = connection.cursor()
                placeholders = ",".join("?" for _ in wanted)
                rows = cursor.execute(
                    f"SELECT id, path FROM songs WHERE path IN ({placeholders})",
                    tuple(wanted.keys()),
                ).fetchall()

                for row in rows:
                    resolved.append({
                        "key": wanted.get(row["path"], ""),
                        "id": row["id"],
                    })
            finally:
                connection.close()

            return {"success": True, "tracks": resolved}

        except Exception as error:
            return {"success": False, "tracks": [], "error": str(error)}

    def ensure_saved_track(self, track):
        """Ensure a streaming track has a numeric library row for likes/playlists."""

        if not isinstance(track, dict) or track.get("id") in (None, ""):
            return {"success": False, "error": "A track with an ID is required."}

        try:
            track_id = track.get("id")
            path = self._stream_track_path(track)
            key = self._stream_track_key(track)

            # Local library rows already have numeric IDs and real paths.
            if path is None:
                saved = get_all_songs()
                for song in saved:
                    if str(song.get("id")) == str(track_id):
                        return {"success": True, "song": song, "key": key}

                return {"success": False, "error": "Local song was not found."}

            connection = get_connection()
            try:
                row = connection.execute(
                    "SELECT * FROM songs WHERE path = ?",
                    (path,),
                ).fetchone()
                existing = dict(row) if row else None
            finally:
                connection.close()

            if existing is None:
                duration = track.get("duration", "0:00")
                if isinstance(duration, (int, float)):
                    duration = self._format_duration(int(duration))

                save_songs([{
                    "title": track.get("title") or "Unknown Title",
                    "artist": track.get("artist") or "Unknown Artist",
                    "album": track.get("album") or "Unknown Album",
                    "duration": duration or "0:00",
                    "path": path,
                }])

                connection = get_connection()
                try:
                    row = connection.execute(
                        "SELECT * FROM songs WHERE path = ?",
                        (path,),
                    ).fetchone()
                    existing = dict(row) if row else None
                finally:
                    connection.close()

            if existing is None:
                return {"success": False, "error": "Could not save this track."}

            return {"success": True, "song": existing, "key": key}

        except Exception as error:
            return {"success": False, "error": str(error)}

    def add_to_playlist(self, playlist_id, song_id):
        try:
            add_song_to_playlist(playlist_id, song_id)

            return {
                "success": True,
                "message": "Song added to playlist."
            }

        except Exception as error:
            return {
                "success": False,
                "message": str(error)
            }

    def get_playlist_songs(self, playlist_id):
        try:
            songs = db_get_playlist_songs(playlist_id)

            return {
                "success": True,
                "songs": songs,
                "count": len(songs)
            }

        except Exception as error:
            return {
                "success": False,
                "songs": [],
                "count": 0,
                "error": str(error)
            }

    def remove_from_playlist(self, playlist_id, song_id):
        try:
            remove_song_from_playlist(playlist_id, song_id)

            return {
                "success": True,
                "message": "Song removed from playlist."
            }

        except Exception as error:
            return {
                "success": False,
                "message": str(error)
            }

    def delete_playlist(self, playlist_id):
        try:
            # Protect the special Liked Songs playlist.
            playlists = get_all_playlists()

            target = next(
                (
                    playlist for playlist in playlists
                    if playlist["id"] == int(playlist_id)
                ),
                None
            )

            if target is None:
                return {
                    "success": False,
                    "message": "Playlist not found."
                }

            if target["name"] == LIKED_PLAYLIST_NAME:
                return {
                    "success": False,
                    "message": "Liked Songs cannot be deleted."
                }

            deleted = db_delete_playlist(playlist_id)

            if deleted:
                return {
                    "success": True,
                    "message": "Playlist deleted successfully."
                }

            return {
                "success": False,
                "message": "Playlist not found."
            }

        except Exception as error:
            return {
                "success": False,
                "message": str(error)
            }

    def rename_playlist(self, playlist_id, new_name):
        try:
            playlists = get_all_playlists()

            target = next(
                (
                    playlist for playlist in playlists
                    if playlist["id"] == int(playlist_id)
                ),
                None
            )

            if target is None:
                return {
                    "success": False,
                    "message": "Playlist not found."
                }

            if target["name"] == LIKED_PLAYLIST_NAME:
                return {
                    "success": False,
                    "message": "Liked Songs cannot be renamed."
                }

            renamed = db_rename_playlist(playlist_id, new_name)

            if renamed:
                return {
                    "success": True,
                    "message": "Playlist renamed successfully."
                }

            return {
                "success": False,
                "message": "Invalid playlist or empty name."
            }

        except Exception as error:
            return {
                "success": False,
                "message": str(error)
            }

    # ==========================================
    # LIKED SONGS
    # ==========================================

    def get_liked_song_ids(self):
        try:
            song_ids = get_liked_song_ids()

            return {
                "success": True,
                "song_ids": song_ids
            }

        except Exception as error:
            return {
                "success": False,
                "song_ids": [],
                "error": str(error)
            }

    def toggle_like_song(self, song_id):
        try:
            return toggle_like_song(int(song_id))

        except Exception as error:
            return {
                "success": False,
                "liked": False,
                "message": str(error)
            }

    # ==========================================
    # LOCAL MUSIC PLAYBACK
    # ==========================================

    def play_song(self, file_path):
        print("Received local music path:", repr(file_path))

        if not isinstance(file_path, str) or not os.path.isfile(file_path):
            return {
                "success": False,
                "message": "Invalid music file path."
            }

        return self.player.play(file_path)

    # ==========================================
    # DOWNLOADED AUDIO PLAYBACK
    # ==========================================

    
    # ==========================================
    # PLAYER CONTROLS
    # ==========================================

    def pause_song(self):
        return self.player.pause()

    def resume_song(self):
        return self.player.resume()

    def stop_song(self):
        return self.player.stop()

    def set_volume(self, volume):
        return self.player.set_volume(volume)

    def get_progress(self):
        return self.player.get_progress()

    def get_video_progress(self):
        return self.player.get_video_progress()

    def seek_song(self, seconds):
        return self.player.seek(seconds)

    # ==========================================
    # ONLINE MUSIC SEARCH
    # ==========================================

    def search_online_music(self, query, provider=None):
        """Search online music and cache YouTube metadata."""

        if not isinstance(query, str) or not query.strip():
            return {
                "success": False,
                "results": [],
                "count": 0,
                "error": "Search query cannot be empty."
            }

        if provider:
            if not self.music_service.set_provider(provider):
                return {
                    "success": False,
                    "results": [],
                    "count": 0,
                    "error": f"Provider '{provider}' is not available."
                }

        result = self.music_service.search_music(query.strip())

        if not isinstance(result, dict):
            return result

        # JioSaavn also has real album and artist catalogues. Keep songs in
        # `results` for playback/queue compatibility, and return the other
        # matches alongside them so search can show one complete result page.
        result.setdefault("albums", [])
        result.setdefault("artists", [])

        if self.music_service.provider_name == "jiosaavn":

            def safe_search(method, *args):
                try:
                    return method(*args)
                except Exception:
                    return {"success": False, "results": []}

            with ThreadPoolExecutor(max_workers=2) as pool:
                album_future = pool.submit(
                    safe_search,
                    self.jiosaavn.search_albums,
                    query.strip(),
                    6,
                )
                artist_future = pool.submit(
                    safe_search,
                    self.jiosaavn.search_artists,
                    query.strip(),
                    6,
                )

                album_result = album_future.result()
                artist_result = artist_future.result()

            result["albums"] = (
                album_result.get("results", [])
                if album_result.get("success")
                else []
            )
            result["artists"] = (
                artist_result.get("results", [])
                if artist_result.get("success")
                else []
            )

            songs = result.get("results", [])
            if not isinstance(songs, list):
                songs = []
                result["results"] = songs

            if not result.get("success") and (
                result["albums"] or result["artists"]
            ):
                result["success"] = True
                result["error"] = None

            result["counts"] = {
                "songs": len(songs),
                "albums": len(result["albums"]),
                "artists": len(result["artists"]),
            }

        results = result.get("results", [])

        if isinstance(results, list):
            for track in results:
                if not isinstance(track, dict):
                    continue

                track_id = track.get("id")

                if not isinstance(track_id, str) or not track_id:
                    continue

                if track.get("provider") == "youtube":
                    self._youtube_metadata[track_id] = {
                        "title": track.get("title") or "Unknown Title",
                        "artist": track.get("artist") or "Unknown Artist",
                        "album": track.get("album")
                    }
                elif track.get("provider") == "jiosaavn":
                    self._jiosaavn_metadata[track_id] = track

        return result

    def play_provider_track(self, track_id):
        """Play a track through the configured music provider."""

        if not isinstance(track_id, str) or not track_id.strip():
            return {
                "success": False,
                "error": "Invalid track ID."
            }

        try:
            return self.music_service.play_provider_track(
                self.player,
                track_id.strip()
            )

        except Exception as error:
            print("PROVIDER PLAYBACK ERROR:", error)

            return {
                "success": False,
                "error": str(error)
            }

    # ==========================================
    # JIOSAAVN STREAMING
    # ==========================================

    @staticmethod
    def _format_duration(seconds):
        try:
            seconds = int(seconds)
        except (TypeError, ValueError):
            return "0:00"

        minutes, remainder = divmod(max(0, seconds), 60)
        return f"{minutes}:{remainder:02d}"

    def play_jiosaavn_track(self, track_id, quality="320kbps"):
        """Resolve and stream a JioSaavn track directly through VLC."""

        if not isinstance(track_id, str) or not track_id.strip():
            return {
                "success": False,
                "error": "Invalid JioSaavn track ID."
            }

        quality = quality if quality in self.jiosaavn.QUALITY_ORDER else "320kbps"

        try:
            result = self.jiosaavn.get_stream(track_id.strip(), quality)

            if not result.get("success"):
                return result

            track = result["track"]
            playback = self.player.play_url(track["stream_url"])

            if not playback.get("success"):
                return playback

            self._jiosaavn_metadata[track["id"]] = track

            return {
                "success": True,
                "track": track,
                "quality": track.get("quality"),
                "message": "JioSaavn stream started."
            }

        except Exception as error:
            print("JIOSAAVN PLAYBACK ERROR:", error)

            return {
                "success": False,
                "error": str(error)
            }

    def get_jiosaavn_charts(self, limit=1):
        """Return a curated list of mainstream JioSaavn tracks."""

        try:
            result = self.jiosaavn.charts(per_query=max(1, min(int(limit), 3)))

            if result.get("success"):
                for track in result.get("results", []):
                    self._jiosaavn_metadata[track["id"]] = track

            return result

        except Exception as error:
            return {
                "success": False,
                "results": [],
                "error": str(error)
            }

    def _cache_jiosaavn_tracks(self, tracks):
        """Remember normalized tracks so card clicks need no extra lookup."""

        for track in tracks or []:
            if isinstance(track, dict) and track.get("id"):
                self._jiosaavn_metadata[str(track["id"])] = track

    def get_jiosaavn_discovery(self, refresh=False):
        """Return all Discover shelves (genres, albums, artists, charts)."""

        if self._discovery_shelves is not None and not refresh:
            return self._discovery_shelves

        try:
            result = self.jiosaavn.get_discovery_shelves(refresh=bool(refresh))
        except Exception as error:
            return {
                "success": False,
                "error": str(error),
                "trending": [],
                "albums": [],
                "artists": [],
                "charts": [],
                "genres": [],
            }

        if result.get("success"):
            for key in ("trending", "albums", "artists", "charts", "genres"):
                self._cache_jiosaavn_tracks(result.get(key))

            self._discovery_shelves = result

        return result

    def search_jiosaavn_albums(self, query, limit=20, page=1):
        try:
            return self.jiosaavn.search_albums(query, limit, page)
        except Exception as error:
            return {"success": False, "results": [], "error": str(error)}

    def search_jiosaavn_artists(self, query, limit=20, page=1):
        try:
            return self.jiosaavn.search_artists(query, limit, page)
        except Exception as error:
            return {"success": False, "results": [], "error": str(error)}

    def get_jiosaavn_album(self, album_id, limit=50):
        try:
            result = self.jiosaavn.get_album(album_id=album_id, limit=limit)
            if result.get("success"):
                self._cache_jiosaavn_tracks(result.get("tracks"))
            return result
        except Exception as error:
            return {"success": False, "tracks": [], "error": str(error)}

    def get_jiosaavn_artist(self, artist_id, page=0, limit=20, kind="overview"):
        try:
            result = self.jiosaavn.get_artist(
                artist_id=artist_id,
                page=page,
                limit=limit,
                kind=kind,
            )
            if result.get("success"):
                self._cache_jiosaavn_tracks(result.get("songs"))
            return result
        except Exception as error:
            return {"success": False, "songs": [], "error": str(error)}

    def get_jiosaavn_artist_songs(self, artist_id, page=0, limit=20):
        return self.get_jiosaavn_artist(
            artist_id,
            page=page,
            limit=limit,
            kind="songs",
        )

    def get_jiosaavn_chart_collections(self, limit=10):
        try:
            return self.jiosaavn.get_chart_collections(limit)
        except Exception as error:
            return {"success": False, "results": [], "error": str(error)}

    def get_jiosaavn_featured_playlists(self, page=1, limit=20, language=None):
        try:
            return self.jiosaavn.get_featured_playlists(page, limit, language)
        except Exception as error:
            return {"success": False, "results": [], "error": str(error)}

    def get_jiosaavn_genres(self, limit=24):
        try:
            return self.jiosaavn.get_genres(limit)
        except Exception as error:
            return {"success": False, "results": [], "error": str(error)}

    def get_jiosaavn_genre_tracks(self, token, page=1, limit=50):
        return self.get_jiosaavn_collection_tracks(token, page, limit)

    def get_jiosaavn_collection_tracks(self, token, page=1, limit=50):
        try:
            result = self.jiosaavn.get_collection_tracks(token, page, limit)
            if result.get("success"):
                self._cache_jiosaavn_tracks(result.get("tracks"))
            return result
        except Exception as error:
            return {"success": False, "tracks": [], "error": str(error)}

    def get_mainstream_picks(self):
        """Return real mainstream tracks for the Discover shelf.

        The shelf reuses JioSaavn launch data already fetched for Discover, so
        it stays fast and always plays direct audio instead of a YouTube embed.
        """

        if self._mainstream_picks is not None:
            return {
                "success": True,
                "results": self._mainstream_picks,
                "count": len(self._mainstream_picks),
            }

        discovery = self.get_jiosaavn_discovery()
        tracks = discovery.get("trending", []) if discovery.get("success") else []

        if not tracks:
            return {
                "success": False,
                "results": [],
                "error": discovery.get(
                    "error",
                    "Could not load mainstream songs. Check your connection.",
                ),
            }

        picks = tracks[:8]
        self._mainstream_picks = picks

        return {
            "success": True,
            "results": picks,
            "count": len(picks),
        }

    def get_jiosaavn_track(self, track_id):
        """Return cached or freshly resolved metadata for a JioSaavn track."""

        if not isinstance(track_id, str) or not track_id.strip():
            return {"success": False, "error": "Invalid JioSaavn track ID."}

        track_id = track_id.strip()

        cached = self._jiosaavn_metadata.get(track_id)
        if cached is not None:
            return {"success": True, "track": cached}

        result = self.jiosaavn.get_song(track_id)

        if not result.get("success"):
            return result

        track = self.jiosaavn._normalize(result["song"])

        if track is None:
            return {"success": False, "error": "Could not read song metadata."}

        self._jiosaavn_metadata[track_id] = track
        return {"success": True, "track": track}

    def get_jiosaavn_lyrics(self, track_id):
        """Return JioSaavn's own public lyric snippet for a track.

        JioSaavn does not expose full lyrics through its public web API. When
        `has_lyrics` is set, the response contains a short excerpt; we surface
        exactly that instead of inventing or scraping lyrics from elsewhere.
        """

        if not isinstance(track_id, str) or not track_id.strip():
            return {"success": False, "available": False, "lyrics": ""}

        track_id = track_id.strip()

        try:
            result = self.jiosaavn.get_song(track_id)

            if not result.get("success"):
                return {
                    "success": False,
                    "available": False,
                    "lyrics": "",
                    "error": result.get("error", "Could not load lyrics."),
                }

            song = result.get("song") or {}
            more_info = song.get("more_info") or {}

            raw_lyrics = ""
            if isinstance(more_info, dict):
                raw_lyrics = (
                    more_info.get("lyrics_snippet")
                    or more_info.get("lyrics")
                    or ""
                )

            if isinstance(raw_lyrics, str):
                lyrics = html.unescape(
                    re.sub(r"<[^>]+>", " ", raw_lyrics)
                )
                lyrics = re.sub(r"\s+", " ", lyrics).strip()
            else:
                lyrics = ""

            has_lyrics = bool(
                isinstance(more_info, dict) and more_info.get("has_lyrics")
            ) and bool(lyrics)

            return {
                "success": True,
                "available": has_lyrics,
                "lyrics": lyrics if has_lyrics else "",
                "source": "JioSaavn",
                "title": song.get("title") or "",
                "artist": self.jiosaavn._web_artist(song) if isinstance(song, dict) else "",
            }

        except Exception as error:
            return {
                "success": False,
                "available": False,
                "lyrics": "",
                "error": str(error),
            }

    def download_jiosaavn_track(self, track_id, quality="320kbps"):
        """Save a JioSaavn track into the local library for offline playback."""

        if not isinstance(track_id, str) or not track_id.strip():
            return {
                "success": False,
                "message": "Invalid JioSaavn track ID."
            }

        quality = quality if quality in self.jiosaavn.QUALITY_ORDER else "320kbps"

        try:
            result = self.jiosaavn.get_stream(track_id.strip(), quality)

            if not result.get("success"):
                return {
                    "success": False,
                    "message": result.get("error", "Could not resolve the audio stream.")
                }

            track = result["track"]
            artist = str(track.get("artist") or "Unknown Artist")
            title = str(track.get("title") or "Unknown Title")

            safe_name = re.sub(r"[^\w.\- ]+", "", f"{artist} - {title}")
            safe_name = re.sub(r"\s+", " ", safe_name).strip(" .")[:140] or "Unknown Song"

            target_dir = Path(get_music_folder()) / "JioSaavn"
            target_dir.mkdir(parents=True, exist_ok=True)

            destination = target_dir / f"{safe_name}.m4a"
            temporary = destination.with_suffix(".part")

            if not destination.exists():
                response = requests.get(
                    track["stream_url"],
                    stream=True,
                    timeout=(15, 60),
                )
                response.raise_for_status()

                content_type = response.headers.get("Content-Type", "").lower()

                if content_type and not (
                    content_type.startswith("audio/")
                    or content_type.startswith("video/mp4")
                    or content_type.startswith("application/octet-stream")
                ):
                    return {
                        "success": False,
                        "message": f"Unexpected media type: {content_type}"
                    }

                with temporary.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 256):
                        if chunk:
                            handle.write(chunk)

                os.replace(temporary, destination)

            song_data = {
                "title": title,
                "artist": artist,
                "album": track.get("album") or "JioSaavn",
                "duration": self._format_duration(track.get("duration")),
                "path": str(destination),
            }

            tags = get_metadata(destination)

            if isinstance(tags, dict):
                song_data.update({
                    key: value
                    for key, value in tags.items()
                    if key in ("title", "artist", "album", "duration") and value
                })

            save_songs([song_data])

            saved = next(
                (
                    song for song in get_all_songs()
                    if song.get("path") == str(destination)
                ),
                song_data,
            )

            self._jiosaavn_metadata[track["id"]] = track

            return {
                "success": True,
                "message": "Saved to your local library.",
                "song": saved,
                "path": str(destination)
            }

        except Exception as error:
            temporary = locals().get("temporary")

            if temporary is not None:
                try:
                    Path(temporary).unlink(missing_ok=True)
                except OSError:
                    pass

            print("JIOSAAVN DOWNLOAD ERROR:", error)

            return {
                "success": False,
                "message": str(error)
            }

    def get_music_providers(self):
        """Return available music providers and the active provider."""

        return {
            "providers": self.music_service.list_providers(),
            "active": self.music_service.provider_name
        }


    def set_music_provider(self, name):
        """Change the active music provider."""

        success = self.music_service.set_provider(name)

        if not success:
            return {
                "success": False,
                "error": f"Provider '{name}' is not available."
            }

        return {
            "success": True,
            "active": self.music_service.provider_name
        }

    def get_music_provider_capabilities(self):

        return {
            "provider": self.music_service.provider_name,
            "capabilities": self.music_service.get_active_provider_capabilities()
        }