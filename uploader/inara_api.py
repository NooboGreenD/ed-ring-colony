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

import time

import requests
from typing import Optional

from http_errors import apply_client_headers, describe_bad_response, short_body


class InaraAPI:
    URL = "https://inara.cz/inapi/v1/"

    #: Сколько раз пробуем отправить «временную» ошибку (HTML от Cloudflare,
    #: 5xx, 429, обрыв соединения) и пауза между попытками — как у EDSM.
    MAX_ATTEMPTS = 3
    RETRY_DELAY = 1.5

    def __init__(self, api_key: str = "", commander_name: str = "",
                 app_name: str = "ED Ring Colony Uploader", app_version: str = "0.0.0"):
        self.api_key = api_key.strip()
        self.commander_name = commander_name.strip()
        self.app_name = app_name
        self.app_version = app_version
        self._session = requests.Session()
        # Inara тоже за Cloudflare: без User-Agent вместо JSON приходит
        # HTML-страница, и событие молча теряется.
        apply_client_headers(self._session, app_name, app_version)

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.commander_name)

    def set_credentials(self, api_key: str, commander_name: str):
        self.api_key = api_key.strip()
        self.commander_name = commander_name.strip()

    def set_app_version(self, version: str):
        if version:
            self.app_version = str(version).strip()
            apply_client_headers(self._session, self.app_name, self.app_version)

    def submit(self, event_name: str, event_data: dict, timestamp: str = "") -> dict:
        """Отправить одно событие. Возвращает {"ok", "status", "data", "error"}.

        Временные сбои (HTML-страница Cloudflare, 5xx, 429, обрыв соединения)
        повторяем `MAX_ATTEMPTS` раз — Inara за тем же Cloudflare, что и EDSM.
        """
        if not self.enabled:
            return {"ok": False, "skipped": True}
        result: dict = {"ok": False, "error": "Inara: не отправлено"}
        for attempt in range(1, max(1, self.MAX_ATTEMPTS) + 1):
            result = self._submit_once(event_name, event_data, timestamp)
            if result.get("ok") or not result.get("retryable"):
                return result
            if attempt < self.MAX_ATTEMPTS:
                time.sleep(self.RETRY_DELAY)
        result["attempts"] = max(1, self.MAX_ATTEMPTS)
        return result

    def _submit_once(self, event_name: str, event_data: dict,
                     timestamp: str = "") -> dict:
        """Одна попытка отправки."""
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
            return {
                "ok": False,
                "status": 0,
                "retryable": True,
                "error": f"Inara: нет соединения ({exc}); событие будет повторено",
            }

        try:
            data = response.json()
        except ValueError:
            data = None

        if not isinstance(data, dict):
            # HTML от Cloudflare / пустое тело: короткое описание вместо
            # куска разметки в логе.
            return describe_bad_response("Inara", response, detail="нет JSON в ответе")

        header = data.get("header") or {}
        header_status = header.get("eventStatus")
        # 400 в заголовке — проблема авторизации: весь пакет отменён. Повторять
        # бесполезно (retryable=False): ключ не «отлипнет» сам.
        if header_status is not None and int(header_status) >= 400:
            text = str(header.get("eventStatusText") or "")
            result = {
                "ok": False,
                "status": response.status_code,
                "retryable": False,
                "header_status": header_status,
                "data": data,
                "error": f"Inara: {text or 'ошибка авторизации'}",
            }
            if "no access allowed" in text.lower():
                # Личный ключ Inara работает только в паре с приложением,
                # внесённым в белый список администрацией: иначе любой запрос
                # отклоняется с «This application has no access allowed.».
                result["error_kind"] = "inara_not_whitelisted"
                result["error"] = (
                    f"Inara: приложению «{self.app_name}» не разрешён доступ — "
                    f"ключ действителен, но приложение не в белом списке Inara. "
                    f"Доступ запрашивает автор приложения у администрации Inara; "
                    f"до одобрения события Inara можно отключить в настройках — "
                    f"на EDSM и Raven Colonial это не влияет"
                )
            return result

        events = data.get("events") or []
        first = events[0] if events else {}
        event_status = first.get("eventStatus")
        text = str(first.get("eventStatusText") or "")

        if event_status is None:
            return {
                "ok": False,
                "status": response.status_code,
                "data": data,
                "error": f"Inara: нет eventStatus в ответе ({short_body(response)})",
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
