import time
from urllib.parse import urlparse


def validate_media_source(source):
    """Validate an authorized audio or video source."""

    if source is None:
        return False, "No media source provided"

    media_type = getattr(source, "media_type", "audio")

    if media_type not in ("audio", "video"):
        return False, "Unsupported media type"

    if not source.download_allowed:
        return False, "Provider does not authorize downloading"

    if not source.authorization_type:
        return False, "Authorization type is missing"

    if not source.authorization_reference:
        return False, "Authorization reference is missing"

    if not source.url:
        return False, "Media URL is missing"

    parsed = urlparse(source.url)

    if parsed.scheme != "https" or not parsed.hostname:
        return False, "Invalid HTTPS media URL"

    expected_prefix = f"{media_type}/"

    if (
        not source.mime_type
        or not source.mime_type.startswith(expected_prefix)
    ):
        return False, f"Invalid {media_type} MIME type"

    if not source.extension:
        return False, "Media extension is missing"

    if source.expires_at is not None and source.expires_at <= time.time():
        return False, "Media URL has expired"

    return True, "Media source validated"
