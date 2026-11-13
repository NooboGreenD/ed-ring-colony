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
from i18n import tr

from http_errors import apply_client_headers, describe_bad_response, short_body


#: Состояния подключения Inara для страницы «Подключение» Helper'а.
INARA_STATUS_NOT_CONFIGURED = "not_configured"   # нет ключа
INARA_STATUS_NEED_NAME = "need_name"             # ключ есть, имени командира нет
INARA_STATUS_NOT_WHITELISTED = "not_whitelisted"  # «no access allowed»
INARA_STATUS_INVALID_KEY = "invalid_key"         # «Invalid API key»
INARA_STATUS_ENABLED = "enabled"


def resolve_commander_name(known: str = "", typed: str = "", current: str = "") -> str:
    """Имя командира для заголовка Inara.

    Inara просит брать его из журналов, а не от пользователя: «get this from
    journals or cAPI to ensure it is a correct in-game name». Поэтому имя,
    известное игре, приоритетнее введённого руками; введённое — запасной
    вариант, пока журнала не было (первый запуск до игры).
    """
    for value in (known, typed, current):
        text = str(value or "").strip()
        if text:
            return text
    return ""


def connection_status(has_key: bool, has_name: bool, error_kind: str = "") -> str:
    """Что показывать рядом с полями Inara.

    `error_kind` — последний отказ сервиса (`inara_not_whitelisted`,
    `inara_invalid_key`). Без него статус «включена» врал бы: ключ заполнен,
    а Inara отвечает отказом.
    """
    if not has_key:
        return INARA_STATUS_NOT_CONFIGURED
    if not has_name:
        return INARA_STATUS_NEED_NAME
    if error_kind == "inara_not_whitelisted":
        return INARA_STATUS_NOT_WHITELISTED
    if error_kind == "inara_invalid_key":
        return INARA_STATUS_INVALID_KEY
    return INARA_STATUS_ENABLED


class InaraAPI:
    URL = "https://inara.cz/inapi/v1/"

    #: Сколько раз пробуем отправить «временную» ошибку (HTML от Cloudflare,
    #: 5xx, 429, обрыв соединения) и пауза между попытками — как у EDSM.
    MAX_ATTEMPTS = 3
    RETRY_DELAY = 1.5

    #: Правила dev-guide Inara (https://inara.cz/elite/inara-api-devguide/):
    #: события отправляются пакетами, а не по одному в отдельных запросах, и не
    #: чаще двух запросов в минуту. Значения читает и диспетчер
    #: (`event_dispatch.ThirdPartyDispatcher`), поэтому объявлены на классе.
    MAX_BATCH = 25
    MIN_REQUEST_INTERVAL = 30.0
    BATCH_LINGER = 5.0
    #: Диспетчер по этому признаку понимает, что клиент умеет пакеты.
    supports_batching = True

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

        Одиночная отправка остаётся для ручных действий и тестов; обычный путь
        Helper'а — `submit_batch`, потому что dev-guide просит батчинг.
        """
        if not self.enabled:
            return {"ok": False, "skipped": True}
        payload = self._build_payload([(event_name, event_data, timestamp)])
        return self._post_with_retries(payload)

    def submit_batch(self, events) -> dict:
        """Отправить несколько событий одним запросом.

        `events` — список `{"eventName", "eventData", "eventTimestamp"}` (как их
        собирает диспетчер) или кортежей `(event_name, event_data, timestamp)`.
        Возвращает тот же результат, что `submit`, плюс `count` — сколько
        событий ушло в запросе. Inara отвечает статусом на каждое событие:
        пакет считается успешным, только если приняты все.
        """
        if not self.enabled:
            return {"ok": False, "skipped": True}
        prepared = []
        for item in events or []:
            if isinstance(item, dict):
                name = item.get("eventName") or item.get("event_name") or ""
                data = item.get("eventData")
                if data is None:
                    data = item.get("data")
                timestamp = item.get("eventTimestamp") or item.get("timestamp") or ""
            else:
                parts = list(item)
                name = parts[0] if len(parts) > 0 else ""
                data = parts[1] if len(parts) > 1 else None
                timestamp = parts[2] if len(parts) > 2 else ""
            if not name:
                continue
            prepared.append((str(name), data if isinstance(data, dict) else {},
                             str(timestamp or "")))
        if not prepared:
            return {"ok": False, "skipped": True}
        payload = self._build_payload(prepared)
        result = self._post_with_retries(payload)
        result["count"] = len(prepared)
        return result

    def _build_payload(self, events) -> dict:
        """Тело запроса: заголовок приложения и пакет событий."""
        return {
            "header": {
                "appName": self.app_name,
                "appVersion": self.app_version,
                "isBeingDeveloped": True,
                "APIkey": self.api_key,
                "commanderName": self.commander_name,
            },
            "events": [
                {
                    "eventName": name,
                    "eventTimestamp": timestamp,
                    "eventData": data,
                }
                for name, data, timestamp in events
            ],
        }

    def _post_with_retries(self, payload: dict) -> dict:
        """Повторить запрос при «временных» ошибках (см. `MAX_ATTEMPTS`)."""
        result: dict = {"ok": False, "error": tr("Inara: не отправлено")}
        for attempt in range(1, max(1, self.MAX_ATTEMPTS) + 1):
            result = self._post(payload)
            if result.get("ok") or not result.get("retryable"):
                return result
            if attempt < self.MAX_ATTEMPTS:
                time.sleep(self.RETRY_DELAY)
        result["attempts"] = max(1, self.MAX_ATTEMPTS)
        return result

    def _submit_once(self, event_name: str, event_data: dict,
                     timestamp: str = "") -> dict:
        """Одна попытка отправки одного события (оставлено для совместимости)."""
        return self._post(
            self._build_payload([(event_name, event_data, timestamp)])
        )

    def _post(self, payload: dict) -> dict:
        """Одна попытка отправки готового тела запроса."""
        try:
            response = self._session.post(self.URL, json=payload, timeout=15)
        except Exception as exc:
            # Клиент внешнего сервиса не должен ронять ни поток диспетчера,
            # ни разбор журнала.
            return {
                "ok": False,
                "status": 0,
                "retryable": True,
                "error": tr("Inara: нет соединения ({error}); событие будет повторено",
                            error=exc),
            }

        try:
            data = response.json()
        except ValueError:
            data = None

        if not isinstance(data, dict):
            # HTML от Cloudflare / пустое тело: короткое описание вместо
            # куска разметки в логе.
            return describe_bad_response("Inara", response,
                                         detail=tr("нет JSON в ответе"))

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
                "error": tr("Inara отклонила запрос: {reason}",
                            reason=text or tr("ошибка авторизации")),
            }
            if "invalid api key" in text.lower():
                # Ключ отозван или перепутан: повторять бессмысленно, но и
                # «приложение не в белом списке» здесь неверно — причина другая.
                result["error_kind"] = "inara_invalid_key"
            elif "no access allowed" in text.lower():
                # Личный ключ Inara работает только в паре с приложением,
                # внесённым в белый список администрацией: иначе любой запрос
                # отклоняется с «This application has no access allowed.».
                result["error_kind"] = "inara_not_whitelisted"
                result["error"] = tr(
                    "Inara: приложению «{app}» не разрешён доступ — ключ действителен, "
                    "но приложение не в белом списке Inara. Доступ запрашивает автор "
                    "приложения у администрации Inara; до одобрения события Inara можно "
                    "отключить в настройках — на EDSM и Raven Colonial это не влияет",
                    app=self.app_name)
            return result

        events = data.get("events") or []
        if not isinstance(events, list) or not events:
            return {
                "ok": False,
                "status": response.status_code,
                "data": data,
                "error": tr("Inara: нет eventStatus в ответе ({detail})",
                            detail=short_body(response)),
            }

        # Inara отвечает статусом на каждое событие пакета. Пакет успешен только
        # если приняты все: иначе диспетчер посчитает отправленными и те
        # события, которые сервис отклонил, и не повторит их.
        statuses = []
        failure = None
        for item in events:
            status = item.get("eventStatus") if isinstance(item, dict) else None
            if status is None:
                return {
                    "ok": False,
                    "status": response.status_code,
                    "data": data,
                    "error": tr("Inara: нет eventStatus в ответе ({detail})",
                                detail=short_body(response)),
                }
            status = int(status)
            statuses.append(status)
            if status >= 400 and failure is None:
                failure = (status, str(item.get("eventStatusText") or ""))

        base = {
            "status": response.status_code,
            "event_statuses": statuses,
            "count": len(statuses),
            "data": data,
        }
        if len(statuses) == 1:
            base["event_status"] = statuses[0]

        # 200 OK, 202 предупреждение, 204 «мягкая» ошибка (нет результата,
        # но формально всё верно). Всё, что 400 и выше — реальная ошибка.
        if failure is not None:
            status, text = failure
            base.update({
                "ok": False,
                "error": text or f"Inara: eventStatus {status}",
            })
            return base
        base.update({"ok": True, "error": None})
        return base
