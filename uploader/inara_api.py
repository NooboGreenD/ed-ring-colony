"""Минимальный клиент Inara API v1.

Справка: https://inara.cz/elite/inara-api-docs/

Что было не так
---------------

1. **Неверный адрес.** Использовался `https://inara.cz/inara-api.php`, а API
   живёт по адресу `https://inara.cz/inapi/v1/` (эндпоинт `inapi/v1/` — ровно
   как в EDDiscovery: `InaraClass` c `ServerAddress = "https://inara.cz/"`).
   Запросы уходили «в никуда», но считались успешными.
2. **Успех по HTTP-коду.** Inara так же отвечает 200 и при ошибке: статус
   события лежит в `events[].eventStatus` (400 — ошибка, 204 — «мягкая»
   ошибка). Раньше любой HTTP 200 считался удачей.
3. **Имя свойства.** Вместо устаревшего `isDeveloped` используем
   `isBeingDeveloped` (старое имя пока работает, но документация просит новое).
4. Версия приложения берётся настоящая, а не «1.0.0».
"""

import requests
from typing import Optional


class InaraAPI:
    URL = "https://inara.cz/inapi/v1/"

    def __init__(self, api_key: str = "", commander_name: str = "",
                 app_name: str = "ED Ring Colony Uploader", app_version: str = "0.0.0"):
        self.api_key = api_key.strip()
        self.commander_name = commander_name.strip()
        self.app_name = app_name
        self.app_version = app_version
        self._session = requests.Session()

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.commander_name)

    def set_credentials(self, api_key: str, commander_name: str):
        self.api_key = api_key.strip()
        self.commander_name = commander_name.strip()

    def set_app_version(self, version: str):
        if version:
            self.app_version = str(version).strip()

    def submit(self, event_name: str, event_data: dict, timestamp: str = "") -> dict:
        """Отправить одно событие. Возвращает {"ok", "status", "data", "error"}."""
        if not self.enabled:
            return {"ok": False, "skipped": True}
        payload = {
            "header": {
                "appName": self.app_name,
                "appVersion": self.app_version,
                "isBeingDeveloped": True,
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
        except Exception as exc:
            # Клиент внешнего сервиса не должен ронять ни поток диспетчера,
            # ни разбор журнала.
            return {"ok": False, "error": str(exc)}

        try:
            data = response.json()
        except ValueError:
            data = None

        if not isinstance(data, dict):
            return {
                "ok": False,
                "status": response.status_code,
                "error": f"Inara: не JSON в ответе ({response.text[:160]})",
            }

        header = data.get("header") or {}
        header_status = header.get("eventStatus")
        # 400 в заголовке — проблема авторизации: весь пакет отменён.
        if header_status is not None and int(header_status) >= 400:
            return {
                "ok": False,
                "status": response.status_code,
                "header_status": header_status,
                "data": data,
                "error": f"Inara: {header.get('eventStatusText') or 'ошибка авторизации'}",
            }

        events = data.get("events") or []
        first = events[0] if events else {}
        event_status = first.get("eventStatus")
        text = str(first.get("eventStatusText") or "")

        if event_status is None:
            return {
                "ok": False,
                "status": response.status_code,
                "data": data,
                "error": f"Inara: нет eventStatus в ответе ({response.text[:160]})",
            }

        event_status = int(event_status)
        # 200 OK, 202 предупреждение, 204 «мягкая» ошибка (нет результата,
        # но формально всё верно). Всё, что 400 и выше — реальная ошибка.
        if event_status >= 400:
            return {
                "ok": False,
                "status": response.status_code,
                "event_status": event_status,
                "data": data,
                "error": text or f"Inara: eventStatus {event_status}",
            }
        return {
            "ok": True,
            "status": response.status_code,
            "event_status": event_status,
            "data": data,
            "error": text or None,
        }
