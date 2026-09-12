"""Необязательная отправка навигационных событий в EDSM."""
import json
import requests
from typing import Optional


class EDSMAPI:
    URL = "https://www.edsm.net/api-journal-v1"

    def __init__(self, api_key: str = "", commander_name: str = ""):
        self.api_key = api_key
        self.commander_name = commander_name
        self._session = requests.Session()

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.commander_name)

    def set_credentials(self, api_key: str, commander_name: str):
        self.api_key = api_key.strip()
        self.commander_name = commander_name.strip()

    def submit_event(self, event: dict) -> dict:
        if not self.enabled:
            return {"ok": False, "skipped": True}
        try:
            response = self._session.post(
                self.URL,
                data={
                    "commanderName": self.commander_name,
                    "apiKey": self.api_key,
                    "message": json.dumps(event, ensure_ascii=False, separators=(",", ":")),
                },
                timeout=15,
            )
            return {"ok": response.ok, "status": response.status_code, "error": response.text[:200] if not response.ok else None}
        except requests.RequestException as exc:
            return {"ok": False, "error": str(exc)}
