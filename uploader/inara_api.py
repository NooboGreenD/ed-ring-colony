"""Минимальный клиент Inara API v2, совместимый с моделью EDDiscovery."""
import requests
from typing import Optional


class InaraAPI:
    URL = "https://inara.cz/inara-api.php"

    def __init__(self, api_key: str = "", commander_name: str = "", app_name: str = "ED Ring Colony Uploader"):
        self.api_key = api_key.strip()
        self.commander_name = commander_name.strip()
        self.app_name = app_name
        self._session = requests.Session()

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.commander_name)

    def set_credentials(self, api_key: str, commander_name: str):
        self.api_key = api_key.strip()
        self.commander_name = commander_name.strip()

    def submit(self, event_name: str, event_data: dict, timestamp: str = "") -> dict:
        if not self.enabled:
            return {"ok": False, "skipped": True}
        payload = {
            "header": {
                "appName": self.app_name,
                "appVersion": "1.0.0",
                "isDeveloped": True,
                "APIkey": self.api_key,
                "commanderName": self.commander_name,
            },
            "events": [{
                "eventName": event_name,
                "eventTimestamp": timestamp,
                "eventData": event_data,
            }],
        }
        try:
            response = self._session.post(self.URL, json=payload, timeout=15)
            try:
                data = response.json()
            except ValueError:
                data = None
            return {"ok": response.ok, "status": response.status_code, "data": data, "error": response.text[:300] if not response.ok else None}
        except requests.RequestException as exc:
            return {"ok": False, "error": str(exc)}
