"""Persistent library of albums saved with the ↓ button."""

from backend.database import get_connection


def get_saved_albums():
    connection = get_connection()
    try:
        rows = connection.execute(
            """
            SELECT album_key, title, artist, cover, year, language
            FROM saved_albums
            ORDER BY created_at DESC, id DESC
            """
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def save_album(album):
    if not isinstance(album, dict) or not album.get("album_key"):
        return False

    connection = get_connection()
    try:
        connection.execute(
            """
            INSERT INTO saved_albums
                (album_key, title, artist, cover, year, language)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(album_key) DO UPDATE SET
                title = excluded.title,
                artist = excluded.artist,
                cover = excluded.cover,
                year = excluded.year,
                language = excluded.language
            """,
            (
                str(album["album_key"]),
                str(album.get("title") or "Unknown Album"),
                str(album.get("artist") or "Unknown Artist"),
                album.get("cover") or None,
                album.get("year") or None,
                album.get("language") or None,
            ),
        )
        connection.commit()
        return True
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def remove_saved_album(album_key):
    connection = get_connection()
    try:
        connection.execute(
            "DELETE FROM saved_albums WHERE album_key = ?",
            (str(album_key),),
        )
        connection.commit()
        return True
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
