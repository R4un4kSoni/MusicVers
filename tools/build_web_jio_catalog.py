"""Build the static JioSaavn ID map used by the browser build.

The browser cannot call JioSaavn's private web API directly because that API
does not send CORS headers. The Python desktop app can, which is why main.py
finds the original full-length recordings for mainstream songs and albums.

This build-time tool calls the same JioSaavn web API, stores the discovered
song IDs in a small JavaScript asset, and asks the public CORS-enabled mirror
for the matching full-length stream URLs. The generated map is only a fast
fallback: the web app also resolves songs dynamically at runtime through a
CORS-compatible JioSaavn search API, so it is not limited to these IDs.
"""

import html
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlencode

import requests

WEB = "https://www.jiosaavn.com/api.php"
MIRROR = "https://saavn.sumit.co/api"
ROOT = "/home/raunak/personal/My_Files/Codes/Python/Project/music_app"
OUT = ROOT + "/docs/js/web-jio-catalog.js"
SEED = ROOT + "/docs/js/web-seed.js"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.jiosaavn.com/",
}

QUALITY_ORDER = ["160kbps", "320kbps", "96kbps", "48kbps", "12kbps"]

EXTRA_SONGS = [
    ("Die For You", "Joji"),
    ("Time", "Hans Zimmer"),
    ("Glimpse of Us", "Joji"),
    ("Nights", "Frank Ocean"),
    ("Ivy", "Frank Ocean"),
    ("Space Song", "Beach House"),
    ("Sunflower", "Post Malone"),
    ("Yellow", "Coldplay"),
    ("Imagine", "John Lennon"),
    ("Bohemian Rhapsody", "Queen"),
    ("Die With A Smile", "Lady Gaga Bruno Mars"),
    ("Espresso", "Sabrina Carpenter"),
    ("Birds of a Feather", "Billie Eilish"),
    ("Good Luck Babe", "Chappell Roan"),
    ("Not Like Us", "Kendrick Lamar"),
    ("Lose Control", "Teddy Swims"),
    ("A Bar Song Tipsy", "Shaboozey"),
    ("Beautiful Things", "Benson Boone"),
    ("Too Sweet", "Hozier"),
    ("End of Beginning", "Djo"),
]

# (album title, primary artist, search query).
ALBUMS = [
    ("SMITHEREENS", "Joji", "SMITHEREENS Joji"),
    ("After Hours", "The Weeknd", "After Hours The Weeknd"),
    ("Blonde", "Frank Ocean", "Blonde Frank Ocean"),
    ("Harry's House", "Harry Styles", "Harry's House Harry Styles"),
    ("Future Nostalgia", "Dua Lipa", "Future Nostalgia Dua Lipa"),
    ("Hollywood's Bleeding", "Post Malone", "Hollywood's Bleeding Post Malone"),
    ("Evolve", "Imagine Dragons", "Evolve Imagine Dragons"),
    ("Divide", "Ed Sheeran", "Divide Ed Sheeran"),
    ("reputation", "Taylor Swift", "reputation Taylor Swift"),
    ("When We All Fall Asleep, Where Do We Go?", "Billie Eilish",
     "When We All Fall Asleep Billie Eilish"),
    ("Inception", "Hans Zimmer", "Inception Hans Zimmer"),
    ("Interstellar", "Hans Zimmer", "Interstellar Hans Zimmer"),
    ("Bohemian Rhapsody", "Queen", "Bohemian Rhapsody Queen"),
    ("Starboy", "The Weeknd", "Starboy The Weeknd"),
]

# JioSaavn search sometimes ranks a similarly named single above the original
# soundtrack. These IDs pin the full album we want.
ALBUM_ID_OVERRIDES = {
    "bohemian rhapsody": "77003227",
}

session = requests.Session()
session.headers.update(HEADERS)


def clean(value):
    return html.unescape(str(value or "")).strip()


def norm(value):
    text = clean(value).lower()
    text = re.sub(r"\([^)]*feat[^)]*\)", " ", text)
    text = re.sub(r"\[[^\]]*feat[^\]]*\]", " ", text)
    text = re.sub(r"[^a-z0-9\u0900-\u097f]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def web(call, params):
    payload = {
        "__call": call,
        "_format": "json",
        "_marker": 0,
        "ctx": "web6dot0",
        "api_version": 4,
    }
    payload.update(params)
    try:
        response = session.get(WEB, params=payload, timeout=25)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {}
    except Exception as error:  # network/format failures are non-fatal
        print("  web error", call, error)
        return {}


def best_image(value):
    if isinstance(value, list):
        image = next((item for item in value
                      if isinstance(item, dict) and "500" in str(item.get("quality"))), None)
        image = image or (value[-1] if value and isinstance(value[-1], dict) else None)
        return clean(image.get("url")) if image else ""
    if isinstance(value, dict):
        return clean(value.get("url"))
    return clean(value)


def primary_artist(raw):
    more = raw.get("more_info") if isinstance(raw.get("more_info"), dict) else {}
    artist_map = more.get("artistMap") if isinstance(more.get("artistMap"), dict) else {}
    primary = artist_map.get("primary_artists") or artist_map.get("primary") or []
    if isinstance(primary, list) and primary and isinstance(primary[0], dict):
        return clean(primary[0].get("name"))
    subtitle = clean(raw.get("subtitle"))
    return subtitle.split(" - ", 1)[0] if " - " in subtitle else ""


def song_info(raw):
    more = raw.get("more_info") if isinstance(raw.get("more_info"), dict) else {}
    try:
        duration = int(more.get("duration") or raw.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0
    return {
        "id": str(raw.get("id") or ""),
        "title": clean(raw.get("title") or raw.get("song")),
        "artist": primary_artist(raw),
        "album": clean(more.get("album")),
        "duration": duration,
        "cover": best_image(raw.get("image")),
    }


def aliases(title, artist):
    keys = set()
    for candidate in {
        title,
        re.sub(r"\([^)]*\)", " ", title),
        re.sub(r"\[[^\]]*\]", " ", title),
    }:
        name = norm(candidate)
        by = norm(artist)
        if name and by:
            keys.add(name + "|" + by)
    return keys


def mirror_streams(track_id):
    try:
        response = requests.get(MIRROR + "/songs/" + track_id,
                                headers=HEADERS, timeout=25)
        response.raise_for_status()
        data = response.json()
        items = data.get("data") if isinstance(data.get("data"), list) else []
        song = items[0] if items and isinstance(items[0], dict) else {}
        options = song.get("downloadUrl") if isinstance(song.get("downloadUrl"), list) else []
        by_quality = {
            str(option.get("quality")): clean(option.get("url"))
            for option in options
            if isinstance(option, dict) and option.get("url")
        }
        streams = [by_quality[q] for q in QUALITY_ORDER if q in by_quality]
        return streams
    except Exception:
        return []


songs = {}
entries = {}
featured = []
misses = []


def add_song(raw):
    info = song_info(raw)
    if not info["id"] or not info["title"]:
        return None
    haystack = " ".join(clean(raw.get(key)) for key in ("title", "song", "subtitle")).lower()
    if any(word in haystack for word in (
        "karaoke", "cover", "instrumental", "tribute", "emulation",
        "sped up", "slowed", "nightcore", "performs",
    )):
        return None
    for key in aliases(info["title"], info["artist"]):
        songs[key] = info["id"]
    entries[info["id"]] = info
    return info["id"]


def search_song(title, artist):
    data = web("search.getResults", {
        "q": title + " " + artist, "p": 1, "n": 12, "cc": "in",
    })
    results = data.get("results") if isinstance(data.get("results"), list) else []
    wanted_title = norm(title)
    wanted_artist = norm(artist)
    candidates = []
    for raw in results:
        info = song_info(raw)
        name = norm(info["title"])
        by = norm(info["artist"])
        score = 0
        if name == wanted_title:
            score += 5
        elif wanted_title and (wanted_title in name or name in wanted_title):
            score += 3
        if by == wanted_artist:
            score += 4
        elif wanted_artist and (wanted_artist in by or by in wanted_artist):
            score += 2
        if score >= 5:
            candidates.append((score, raw))
    candidates.sort(key=lambda item: -item[0])
    for _, raw in candidates:
        found = add_song(raw)
        if found:
            if found not in featured:
                featured.append(found)
            return found
    for raw in results[:5]:
        found = add_song(raw)
        if found:
            if found not in featured:
                featured.append(found)
            return found
    misses.append(title + " - " + artist)
    return None


def load_seed():
    text = open(SEED, encoding="utf-8").read()
    marker = "MV.webSeed = "
    start = text.index(marker) + len(marker)
    end = text.index(";", start)
    for item in json.loads(text[start:end]):
        if str(item.get("id", "")).startswith("itunes-"):
            yield item.get("title", ""), item.get("artist", "")


print("Generating JioSaavn browser ID map...")
seed_pairs = list(load_seed())
resolved = 0
for title, artist in seed_pairs + EXTRA_SONGS:
    if search_song(title, artist):
        resolved += 1
    time.sleep(0.12)
print("songs resolved:", resolved, "of", len(seed_pairs) + len(EXTRA_SONGS))

albums = {}
for wanted_title, wanted_artist, query in ALBUMS:
    data = web("search.getAlbumResults", {
        "q": query, "p": 1, "n": 8, "cc": "in",
    })
    results = data.get("results") if isinstance(data.get("results"), list) else []
    candidates = []
    wanted = norm(wanted_title)
    wanted_by = norm(wanted_artist)
    for raw in results:
        title = clean(raw.get("title"))
        artist = primary_artist(raw)
        name = norm(title)
        by = norm(artist)
        score = 0
        if name == wanted:
            score += 6
            if by != wanted_by:
                score -= 2
        elif wanted and (wanted in name or name in wanted):
            score += 3
        if by == wanted_by:
            score += 4
        elif wanted_by and by.startswith(wanted_by + " ") and len(by) <= len(wanted_by) + 8:
            score += 2
        if any(word in name for word in ("performs", "tribute", "dj mix", "karaoke")):
            score -= 5
        candidates.append((score, raw))
    candidates.sort(key=lambda item: -item[0])
    best = candidates[0][1] if candidates else (results[0] if results else None)
    album_id = ALBUM_ID_OVERRIDES.get(norm(wanted_title)) or str((best or {}).get("id") or "")
    if not album_id:
        misses.append("album " + query)
        continue
    detail = web("content.getAlbumDetails", {"albumid": album_id})
    tracks = detail.get("list") if isinstance(detail.get("list"), list) else []
    track_ids = []
    for raw in tracks:
        track_id = add_song(raw)
        if track_id and track_id not in track_ids:
            track_ids.append(track_id)
    override = ALBUM_ID_OVERRIDES.get(norm(wanted_title))
    title = (wanted_title if override else clean((best or {}).get("title"))) or wanted_title
    album_entry = {
        "id": album_id,
        "title": title,
        "artist": wanted_artist if override else (primary_artist(best or {}) or wanted_artist),
        "tracks": track_ids,
    }
    for key in {norm(title), norm(wanted_title), norm(query)}:
        if key:
            albums[key] = album_entry
    print(" album", title, "tracks", len(track_ids))
    time.sleep(0.15)

print("albums resolved:", len(albums))

print("Resolving full-length stream URLs from public mirror...")
with ThreadPoolExecutor(max_workers=8) as pool:
    futures = {
        pool.submit(mirror_streams, track_id): track_id
        for track_id in entries
    }
    for future in as_completed(futures):
        track_id = futures[future]
        streams = future.result()
        if streams:
            entries[track_id]["streams"] = streams
            entries[track_id]["stream"] = streams[0]
print("streams resolved:", sum(1 for item in entries.values() if item.get("stream")),
      "of", len(entries))
print("misses:", misses)

payload = {
    "version": 2,
    "source": "JioSaavn web API (build-time ID discovery); public mirror streams at runtime",
    "songs": songs,
    "albums": albums,
    "entries": entries,
    "featured": featured,
}
body = (
    "/* Generated by tools/build_web_jio_catalog.py — do not edit by hand. */\n"
    "(function (MV) {\n  'use strict';\n  MV.webJioCatalog = "
    + json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    + ";\n})(window.MV = window.MV || {});\n"
)
open(OUT, "w", encoding="utf-8").write(body)
print("wrote", OUT, len(body), "bytes;", len(songs), "keys")
