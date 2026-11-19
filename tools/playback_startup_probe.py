#!/usr/bin/env python3
"""Measure time-to-first-audio for JioSaavn streams in VLC and ffplay.

This is a standalone diagnostic, not part of the desktop app. It resolves a
JioSaavn track with the same provider NeonWave uses, then compares:

  * raw HTTP time-to-first-byte
  * VLC with baseline/default options
  * VLC with the low-latency / avformat options used by NeonWave
  * ffplay (FFmpeg's player), used as a non-VLC control

Example:

    python tools/playback_startup_probe.py --query "Kesariya" --runs 3

By default VLC uses the dummy audio output so the probe is silent and can run
on a headless machine. Pass ``--aout pulse`` to test the real desktop output.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.providers.jiosaavn_provider import JioSaavnProvider  # noqa: E402

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
REFERER = "https://www.jiosaavn.com/"
FFPLAY_START = re.compile(r"\s-?\d+\.\d+\s+M-A:", re.IGNORECASE)


def median(values: List[float]) -> Optional[float]:
    return round(statistics.median(values), 3) if values else None


def resolve_stream(query: Optional[str], track_id: Optional[str], quality: str) -> Dict[str, Any]:
    provider = JioSaavnProvider(timeout=12)

    if not track_id:
        if not query:
            raise ValueError("Provide --query or --id.")
        result = provider.search(query, limit=1)
        results = result.get("results") or []
        if not result.get("success") or not results:
            raise RuntimeError(result.get("error") or "No track found.")
        track_id = str(results[0]["id"])

    started = time.monotonic()
    result = provider.get_stream(str(track_id), quality)
    elapsed = time.monotonic() - started

    if not result.get("success"):
        raise RuntimeError(result.get("error") or "Could not resolve stream.")

    track = result["track"]
    return {
        "id": track.get("id"),
        "title": track.get("title"),
        "quality": track.get("quality"),
        "url": track["stream_url"],
        "resolve_seconds": round(elapsed, 3),
    }


def measure_http(url: str, runs: int, timeout: float) -> Dict[str, Any]:
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": REFERER,
        "Range": "bytes=0-1023",
    }
    values: List[float] = []
    statuses: List[int] = []

    for _ in range(runs):
        started = time.monotonic()
        response = requests.get(url, headers=headers, stream=True, timeout=timeout)
        next(response.iter_content(1024), b"")
        values.append(time.monotonic() - started)
        statuses.append(response.status_code)
        response.close()

    return {
        "ttfb_seconds": [round(value, 3) for value in values],
        "ttfb_median": median(values),
        "statuses": statuses,
    }


def measure_vlc(
    url: str,
    runs: int,
    timeout: float,
    aout: str,
    optimized: bool,
) -> Dict[str, Any]:
    try:
        import vlc
    except ImportError as error:
        return {"available": False, "error": str(error)}

    flags = ["--aout=" + aout, "--no-video", "--quiet"]
    instance = vlc.Instance(*flags)

    to_playing: List[float] = []
    to_time: List[float] = []
    states: List[str] = []

    for _ in range(runs):
        player = instance.media_player_new()
        media = instance.media_new(url)
        media.add_option(":http-user-agent=" + USER_AGENT)
        media.add_option(":http-referrer=" + REFERER)

        if optimized:
            # avformat avoids VLC's MP4 demuxer trying to seek to the end of
            # a signed CDN stream to locate the moov atom. The low cache and
            # clock settings shorten the initial buffer window.
            media.add_option(":demux=avformat")
            media.add_option(":network-caching=250")
            media.add_option(":file-caching=150")
            media.add_option(":clock-jitter=0")
            media.add_option(":clock-synchro=0")
            media.add_option(":http-reconnect")

        player.set_media(media)
        started = time.monotonic()
        player.play()

        playing_at: Optional[float] = None
        timer_at: Optional[float] = None
        seen: List[str] = []

        while time.monotonic() - started < timeout:
            state = player.get_state()
            label = str(state)
            if not seen or seen[-1] != label:
                seen.append(label)

            if playing_at is None and state == vlc.State.Playing:
                playing_at = time.monotonic() - started
            if playing_at is not None and player.get_time() > 0:
                timer_at = time.monotonic() - started
                break
            if state in (vlc.State.Error, vlc.State.Ended) and playing_at is None:
                break
            time.sleep(0.01)

        to_playing.append(playing_at if playing_at is not None else timeout)
        to_time.append(timer_at if timer_at is not None else timeout)
        states.append(" -> ".join(seen))

        player.stop()
        player.set_media(None)

    return {
        "available": True,
        "to_playing_seconds": [round(value, 3) for value in to_playing],
        "to_playing_median": median(to_playing),
        "to_time_seconds": [round(value, 3) for value in to_time],
        "to_time_median": median(to_time),
        "states": states,
    }


def measure_ffplay(url: str, runs: int, timeout: float) -> Dict[str, Any]:
    executable = shutil.which("ffplay")
    if not executable:
        return {"available": False, "error": "ffplay is not installed."}

    command = [
        executable,
        "-nodisp",
        "-autoexit",
        "-loglevel",
        "info",
        "-analyzeduration",
        "0",
        "-probesize",
        "32768",
        "-user_agent",
        USER_AGENT,
        "-referer",
        REFERER,
        url,
    ]

    values: List[float] = []

    for _ in range(runs):
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        started = time.monotonic()
        ready = threading.Event()

        def read_stderr(stream: Any) -> None:
            assert process.stderr is not None
            for line in iter(stream.readline, ""):
                if FFPLAY_START.search(line):
                    ready.set()
                if ready.is_set():
                    break

        reader = threading.Thread(target=read_stderr, args=(process.stderr,), daemon=True)
        reader.start()

        while not ready.is_set() and time.monotonic() - started < timeout:
            if process.poll() is not None:
                break
            time.sleep(0.01)

        values.append(time.monotonic() - started if ready.is_set() else timeout)

        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
        if process.stderr:
            process.stderr.close()

    return {
        "available": True,
        "to_audio_seconds": [round(value, 3) for value in values],
        "to_audio_median": median(values),
    }


def build_verdict(report: Dict[str, Any]) -> str:
    # to_time is the first decoded audio timestamp; to_playing only means VLC
    # has opened the stream, which can still be buffering silently.
    current = report["vlc_baseline"].get("to_time_median")
    optimized = report["vlc_optimized"].get("to_time_median")
    ffplay = report["ffplay"].get("to_audio_median")

    if current is None or optimized is None:
        return "Incomplete VLC measurements; check the reported errors."
    if ffplay is not None and ffplay > 2:
        return "ffplay is also slow, so the stream/source or network is the likely cause."
    if current > 2 and (ffplay is None or ffplay < 1):
        return "VLC is much slower than ffplay; a VLC-specific startup issue is likely."
    if optimized is not None and current >= 0.3 and optimized < current * 0.7:
        return "Low-latency/avformat VLC options clearly improve startup; keep them in play_url()."
    return "Startup is fast for all measured players; a perceived pause is likely UI-side."


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", default="Kesariya", help="Search query when --id is omitted.")
    parser.add_argument("--id", help="JioSaavn track ID to test directly.")
    parser.add_argument("--quality", default="320kbps", help="JioSaavn quality (default: 320kbps).")
    parser.add_argument("--runs", type=int, default=3, help="Measurements per player (default: 3).")
    parser.add_argument("--timeout", type=float, default=12.0, help="Seconds to wait per run.")
    parser.add_argument(
        "--aout",
        default="dummy",
        help="VLC audio output for the probe (default: dummy, so it is silent).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    runs = max(1, args.runs)

    try:
        track = resolve_stream(args.query, args.id, args.quality)
    except Exception as error:
        print(json.dumps({"error": str(error)}, indent=2))
        return 1

    report: Dict[str, Any] = {
        "track": track,
        "http": measure_http(track["url"], runs, args.timeout),
        "vlc_baseline": measure_vlc(track["url"], runs, args.timeout, args.aout, False),
        "vlc_optimized": measure_vlc(track["url"], runs, args.timeout, args.aout, True),
        "ffplay": measure_ffplay(track["url"], runs, args.timeout),
    }
    report["verdict"] = build_verdict(report)

    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
