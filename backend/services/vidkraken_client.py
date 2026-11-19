
import re
from urllib.parse import urlparse

import requests

from backend.services.config import settings


class VidKrakenClient:

    BASE_URL = "https://vidkraken.com/api/v2"

    SUPPORTED_FORMATS = {
        "audio",
        "audio-mp3",
        "audio-aac",
        "360",
        "480",
        "720",
        "1080"
    }

    ALLOWED_HOSTS = {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be"
    }

    def __init__(self):
        self.api_key = settings.VIDKRAKEN_API_KEY
        self.session = requests.Session()

    def _get_headers(self):
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json"
        }

    def _check_api_key(self):
        if not self.api_key:
            return {
                "success": False,
                "error": "VidKraken API key is not configured."
            }

        return None

    def _parse_response(self, response):

        if response.status_code == 401:
            return {
                "success": False,
                "error": "VidKraken authentication failed."
            }

        if not response.ok:
            return {
                "success": False,
                "error": f"VidKraken API returned HTTP {response.status_code}."
            }

        try:
            data = response.json()
        except ValueError:
            return {
                "success": False,
                "error": "VidKraken returned invalid JSON."
            }

        if not isinstance(data, dict):
            return {
                "success": False,
                "error": "VidKraken returned an unexpected response."
            }

        return {
            "success": True,
            "data": data
        }

    def _validate_youtube_url(self, url):

        if not isinstance(url, str) or not url.strip():
            return False

        try:
            parsed = urlparse(url)

            if parsed.scheme != "https":
                return False

            if parsed.hostname not in self.ALLOWED_HOSTS:
                return False

            if parsed.username or parsed.password:
                return False

            if parsed.port not in (None, 443):
                return False

            if parsed.hostname == "youtu.be":
                return bool(parsed.path.strip("/"))

            if parsed.path == "/watch":
                return bool(
                    re.search(r"(?:^|&)v=[A-Za-z0-9_-]+(?:&|$)", parsed.query)
                )

            if parsed.path.startswith(("/shorts/", "/embed/")):
                return bool(parsed.path.split("/")[2])

            return False

        except ValueError:
            return False

    def get_account(self):
        """Retrieve account information."""

        error = self._check_api_key()

        if error:
            return error

        try:
            response = self.session.get(
                f"{self.BASE_URL}/me",
                headers=self._get_headers(),
                timeout=15
            )

            result = self._parse_response(response)

            if not result["success"]:
                return result

            return {
                "success": True,
                "account": result["data"]
            }

        except requests.RequestException:
            return {
                "success": False,
                "error": "Could not connect to VidKraken."
            }

    def start_download(self, url, format="audio", authorized=False):
        """Submit an authorized media download job."""

        error = self._check_api_key()

        if error:
            return error

        if not authorized:
            return {
                "success": False,
                "error": "Download authorization must be confirmed."
            }

        if not self._validate_youtube_url(url):
            return {
                "success": False,
                "error": "Invalid YouTube URL."
            }

        if format not in self.SUPPORTED_FORMATS:
            return {
                "success": False,
                "error": "Unsupported download format."
            }

        try:
            response = self.session.post(
                f"{self.BASE_URL}/download",
                headers=self._get_headers(),
                json={
                    "url": url,
                    "format": format
                },
                timeout=20
            )

            result = self._parse_response(response)

            if not result["success"]:
                return result

            data = result["data"]

            job_id = data.get("jobId")

            if not isinstance(job_id, str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{1,128}", job_id
            ):
                return {
                    "success": False,
                    "error": "VidKraken did not return a valid job ID."
                }

            return {
                "success": True,
                "job_id": job_id,
                "status": data.get("status"),
                "info": data
            }

        except requests.RequestException:
            return {
                "success": False,
                "error": "Could not submit the VidKraken download job."
            }

    def get_download_status(self, job_id):
        """Retrieve the status of an existing download job."""

        error = self._check_api_key()

        if error:
            return error

        if not isinstance(job_id, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{1,128}", job_id
        ):
            return {
                "success": False,
                "error": "Invalid download job ID."
            }

        try:
            response = self.session.get(
                f"{self.BASE_URL}/download/{job_id}",
                headers=self._get_headers(),
                timeout=15
            )

            result = self._parse_response(response)

            if not result["success"]:
                return result

            data = result["data"]

            return {
                "success": True,
                "job_id": job_id,
                "status": data.get("status"),
                "progress": data.get("progress"),
                "download_url": data.get("downloadUrl"),
                "actual_format": data.get("actualFormat"),
                "info": data
            }

        except requests.RequestException:
            return {
                "success": False,
                "error": "Could not retrieve VidKraken download status."
            }
