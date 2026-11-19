import vlc
import os
import math
import sys
import time
from backend.services.download_service import DownloadService


class MusicPlayer:

    def __init__(self):
        # Linux needed an explicit PulseAudio module; Windows and macOS should
        # let VLC choose its native output (WASAPI / CoreAudio) automatically.
        if sys.platform.startswith("linux"):
            vlc_args = ["--aout=pulse"]
        elif sys.platform == "darwin":
            vlc_args = ["--aout=coreaudio"]
        else:
            vlc_args = []
        self.instance = vlc.Instance(*vlc_args)
        self.player = self.instance.media_player_new()
        self.video_player = self.instance.media_player_new()
        self.video_handle = None
        self.current_video = None
        self.video_playback_state = "stopped"

        self.current_song = None
        self.playback_state = "stopped"

        self.is_playing = False
        self.is_paused = False

        # A network stream can briefly report Ended/Error while it is still
        # opening. Only treat those states as a real track ending after VLC has
        # actually reported Playing at least once.
        self._reached_playing = False
        self._playback_started_at = None

        # DownloadService now manages ChunkLoader.
        self.download_service = DownloadService()

    def _begin_playback(self, target):
        """Mark a new media target as loading and reset startup guards."""

        self.current_song = target
        self.playback_state = "loading"
        self.is_playing = False
        self.is_paused = False
        self._reached_playing = False
        self._playback_started_at = time.monotonic()

    def _fail_playback(self):
        """Mark the current media target as failed to start."""

        self.current_song = None
        self.playback_state = "error"
        self.is_playing = False
        self.is_paused = False
        self._reached_playing = False
        self._playback_started_at = None

    def _cleanup_download(self):
        """Clean up previously downloaded audio."""

        if self.download_service.loader is not None:
            self.player.stop()
            self.player.set_media(None)

            self.download_service.cleanup()

    def set_video_handle(self, handle):
        """Attach VLC video output to the native Qt video surface."""

        if not isinstance(handle, int) or handle <= 0:
            return False

        try:
            self.video_handle = handle
            self.video_player.set_xwindow(handle)
            return True

        except Exception as error:
            print("Video handle setup error:", error)
            return False

    def _cleanup_video(self):
        """Stop video playback and clean up downloaded media."""

        self.video_player.stop()
        self.video_player.set_media(None)

        self.download_service.cleanup()

        self.current_video = None
        self.video_playback_state = "stopped"

    def _start_file(self, file_path):
        """Open and start a local audio file using VLC."""

        if not os.path.isfile(file_path):
            return {
                "success": False,
                "message": "Music file does not exist"
            }

        self._begin_playback(file_path)

        try:
            self.player.stop()

            media = self.instance.media_new_path(file_path)
            self.player.set_media(media)

            result = self.player.play()

            if result == -1:
                self.player.stop()
                self.player.set_media(None)

                self._fail_playback()

                return {
                    "success": False,
                    "message": "VLC could not start playback."
                }

            # VLC is still opening the file here. get_progress() promotes the
            # state to "playing" once VLC actually starts decoding audio.
            return {
                "success": True,
                "message": "Playback requested"
            }

        except Exception as error:
            self.player.stop()
            self.player.set_media(None)

            self._fail_playback()

            return {
                "success": False,
                "message": str(error)
            }

    def play(self, file_path):
        """Play an existing local music file."""

        try:
            self._cleanup_video()
            self._cleanup_download()

            return self._start_file(file_path)

        except Exception as error:
            return {
                "success": False,
                "message": str(error)
            }

    def play_url(self, url):
        """Stream a remote audio URL (for example a JioSaavn media URL)."""

        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            return {
                "success": False,
                "message": "Invalid stream URL."
            }

        try:
            self._cleanup_video()
            self.download_service.cleanup()

            # A single stop is enough. The old code also stopped the player
            # from _cleanup_download(), which could leave teardown racing the
            # next play() call. Clearing the old media also stops VLC's
            # preparser from carrying a stale seek offset into the new stream.
            self.player.stop()
            self.player.set_media(None)

            self._begin_playback(url)

            media = self.instance.media_new(url)

            # JioSaavn's CDN expects normal browser request headers. Passing
            # them to VLC avoids transient 403/range errors during startup.
            media.add_option(
                ":http-user-agent=Mozilla/5.0 (X11; Linux x86_64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            )
            media.add_option(":http-referrer=https://www.jiosaavn.com/")

            # JioSaavn serves AAC inside an MP4 container. VLC's built-in MP4
            # demuxer tries to seek to the end of the file to locate the moov
            # atom; some CDN responses reject that seek and VLC then waits for
            # a long sequential scan before audio starts. FFmpeg's demuxer
            # handles the same stream progressively (verified with ffplay), so
            # force it here. The low cache values shorten the startup buffer.
            media.add_option(":demux=avformat")
            media.add_option(":network-caching=250")
            media.add_option(":file-caching=150")
            media.add_option(":clock-jitter=0")
            media.add_option(":clock-synchro=0")
            media.add_option(":http-reconnect")

            self.player.set_media(media)

            result = self.player.play()

            if result == -1:
                self.player.stop()
                self.player.set_media(None)

                self._fail_playback()

                return {
                    "success": False,
                    "message": "VLC could not start the stream."
                }

            # Stay in "loading" until VLC reports Playing. The frontend must
            # not auto-advance from a transient Ended state during buffering.
            return {
                "success": True,
                "message": "Stream playback requested"
            }

        except Exception as error:
            self.player.stop()
            self.player.set_media(None)

            self._fail_playback()

            return {
                "success": False,
                "message": str(error)
            }

    def play_downloaded(self, source):
        """Download an authorized AudioSource and play it."""

        try:
            self._cleanup_video()
            self._cleanup_download()

            result = self.download_service.download(source)

            if not result["success"]:
                return {
                    "success": False,
                    "message": result.get(
                        "error",
                        "Audio download failed"
                    )
                }

            playback = self._start_file(
                result["file_path"]
            )

            if not playback["success"]:
                self.download_service.cleanup()
                return playback

            return {
                "success": True,
                "message": "Downloaded audio playback requested",
                "chunk_count": result["chunk_count"]
            }

        except Exception as error:
            self.download_service.cleanup()

            return {
                "success": False,
                "message": str(error)
            }

    def play_downloaded_video(self, source):
        """Download an authorized video and play it inside NeonWave."""

        try:
            # Stop existing audio playback.
            self.player.stop()
            self.player.set_media(None)

            self.current_song = None
            self.playback_state = "stopped"
            self.is_playing = False
            self.is_paused = False

            # Clean up any previous downloaded media.
            self._cleanup_video()

            # Require an initialized native video surface.
            if self.video_handle is None:
                return {
                    "success": False,
                    "message": "Video surface is not initialized."
                }

            # Download the validated video source.
            result = self.download_service.download(source)

            if not result["success"]:
                return {
                    "success": False,
                    "message": result.get(
                        "error",
                        "Video download failed."
                    )
                }

            file_path = result["file_path"]

            if not os.path.isfile(file_path):
                self.download_service.cleanup()

                return {
                    "success": False,
                    "message": "Downloaded video file does not exist."
                }

            # Open the downloaded video through VLC.
            media = self.instance.media_new_path(file_path)
            self.video_player.set_media(media)

            result_code = self.video_player.play()

            if result_code == -1:
                self._cleanup_video()

                self.video_playback_state = "error"

                return {
                    "success": False,
                    "message": "VLC could not start video playback."
                }

            self.current_video = file_path
            self.video_playback_state = "playing"

            return {
                "success": True,
                "message": "Video playback requested.",
                "chunk_count": result["chunk_count"]
            }

        except Exception as error:
            self._cleanup_video()
            self.video_playback_state = "error"

            return {
                "success": False,
                "message": str(error)
            }

    def get_progress(self):
        """Return playback progress and synchronize VLC state."""

        state = self.player.get_state()

        current_time = self.player.get_time()
        total_time = self.player.get_length()

        if self.current_song is not None:

            if state == vlc.State.Playing:
                self._reached_playing = True
                self._playback_started_at = None

                self.playback_state = "playing"
                self.is_playing = True
                self.is_paused = False

            elif state == vlc.State.Paused:
                self.playback_state = "paused"
                self.is_playing = False
                self.is_paused = True

            elif state in (
                vlc.State.Opening,
                vlc.State.Buffering
            ):
                self.playback_state = "loading"
                self.is_playing = False
                self.is_paused = False

            elif state == vlc.State.Ended:
                if self._reached_playing:
                    self.current_song = None
                    self.playback_state = "ended"
                    self.is_playing = False
                    self.is_paused = False
                elif (
                    self._playback_started_at is not None
                    and time.monotonic() - self._playback_started_at > 8
                ):
                    # Never reached audio; report a failed start instead of an
                    # ended track so the frontend does not skip to the next one.
                    self._fail_playback()
                else:
                    # Transient network state while the stream is opening.
                    self.playback_state = "loading"
                    self.is_playing = False
                    self.is_paused = False

            elif state == vlc.State.Error:
                self._fail_playback()

            elif state == vlc.State.Stopped:
                if self._reached_playing:
                    self.current_song = None
                    self.playback_state = "stopped"
                else:
                    self.playback_state = "loading"
                self.is_playing = False
                self.is_paused = False

        return {
            "current_time": max(0, current_time // 1000),
            "total_time": max(0, total_time // 1000),
            "playback_state": self.playback_state
        }
    def seek(self, seconds):
        """Seek to a valid playback position."""

        if self.current_song is None:
            return False

        try:
            seconds = float(seconds)

            if not math.isfinite(seconds) or seconds < 0:
                return False

            milliseconds = int(seconds * 1000)

            duration = self.player.get_length()

            if duration > 0 and milliseconds > duration:
                return False

            result = self.player.set_time(milliseconds)

            return result != -1

        except (TypeError, ValueError, OverflowError):
            return False

    def pause(self):
        """Pause playback if a track is currently playing."""

        if (
            self.current_song is None
            or self.playback_state != "playing"
        ):
            return False

        try:
            self.player.pause()

            self.playback_state = "paused"
            self.is_paused = True
            self.is_playing = False

            return True

        except Exception:
            return False

    def resume(self):
        """Resume playback if a track is paused."""

        if (
            self.current_song is None
            or self.playback_state != "paused"
        ):
            return False

        try:
            result = self.player.play()

            if result == -1:
                return False

            self.playback_state = "playing"
            self.is_playing = True
            self.is_paused = False

            return True

        except Exception:
            return False

    def stop(self):
        """Stop audio and video playback and clean up temporary media."""

        try:
            self.player.stop()
            self.player.set_media(None)

            self.video_player.stop()
            self.video_player.set_media(None)

            self.download_service.cleanup()

            self.current_song = None
            self.playback_state = "stopped"
            self.is_playing = False
            self.is_paused = False
            self._reached_playing = False
            self._playback_started_at = None

            self.current_video = None
            self.video_playback_state = "stopped"

            return True

        except Exception as error:
            print("Playback stop error:", error)
            return False

    def set_volume(self, volume):
        """Set volume using a normalized value between 0.0 and 1.0."""

        try:
            volume = float(volume)

            if not math.isfinite(volume):
                return False

            volume = max(0.0, min(1.0, volume))
            volume = int(volume * 100)

            result = self.player.audio_set_volume(volume)

            if result == -1:
                return False

            return volume

        except (TypeError, ValueError, OverflowError):
            return False


    def get_video_progress(self):
        """Return video progress and synchronize VLC video state."""
        if self.current_video is None:
            self.video_playback_state = "stopped"

            return {
                "current_time": 0,
                "total_time": 0,
                "playback_state": "stopped"
            }

        state = self.video_player.get_state()

        current_time = self.video_player.get_time()
        total_time = self.video_player.get_length()

        if self.current_video is not None:

            if state == vlc.State.Ended:
                self._cleanup_video()
                self.video_playback_state = "ended"

            elif state == vlc.State.Playing:
                self.video_playback_state = "playing"

            elif state == vlc.State.Paused:
                self.video_playback_state = "paused"

            elif state in (
                vlc.State.Opening,
                vlc.State.Buffering
            ):
                self.video_playback_state = "loading"

            elif state == vlc.State.Error:
                self._cleanup_video()
                self.video_playback_state = "error"

            elif state == vlc.State.Stopped:
                self.video_playback_state = "stopped"

        return {
            "current_time": max(0, current_time // 1000),
            "total_time": max(0, total_time // 1000),
            "playback_state": self.video_playback_state
        }
