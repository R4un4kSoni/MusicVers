import time
import unittest
from unittest.mock import patch

import vlc

from backend.player import MusicPlayer


class TestMusicPlayerStartupState(unittest.TestCase):

    STREAM = "https://aac.saavncdn.com/test/audio_320.mp4"

    def setUp(self):
        self.player = MusicPlayer()
        self.player.current_song = self.STREAM
        self.player.playback_state = "loading"
        self.player._reached_playing = False
        self.player._playback_started_at = time.monotonic()

    def tearDown(self):
        self.player.stop()

    def _progress_for(self, state):
        with patch.object(self.player.player, "get_state", return_value=state), \
             patch.object(self.player.player, "get_time", return_value=1000), \
             patch.object(self.player.player, "get_length", return_value=418000):
            return self.player.get_progress()

    def test_transient_ended_during_startup_is_not_a_track_end(self):
        progress = self._progress_for(vlc.State.Ended)

        self.assertEqual(progress["playback_state"], "loading")
        self.assertEqual(self.player.current_song, self.STREAM)
        self.assertFalse(self.player._reached_playing)

    def test_playing_state_marks_startup_complete(self):
        progress = self._progress_for(vlc.State.Playing)

        self.assertEqual(progress["playback_state"], "playing")
        self.assertTrue(self.player._reached_playing)

    def test_ended_after_real_playback_finishes_the_track(self):
        self.player._reached_playing = True

        progress = self._progress_for(vlc.State.Ended)

        self.assertEqual(progress["playback_state"], "ended")
        self.assertIsNone(self.player.current_song)


if __name__ == "__main__":
    unittest.main()
