"""Необязательная отправка навигационных событий в EDSM.

Справка: https://www.edsm.net/en/api-journal-v1

Что важно и раньше игнорировалось
---------------------------------

1. EDSM требует **обязательные** поля `fromSoftware`, `fromSoftwareVersion`,
   `fromGameVersion` и `fromGameBuild`. С 29.11.2022 (UPDATE 14) версия и
   сборка игры обязательны: без них EDSM отвечает `msgnum` 204 («Software/
   Software version not found») или 207 («Game/Build version not found») и
   **ничего не сохраняет**.
2. EDSM отвечает **HTTP 200 даже при ошибке**: статус события приходит в теле
   в поле `msgnum`. Раньше успехом считался любой `response.ok`, поэтому
   отклонённые события молча попадали в счётчик «отправлено».
   Теперь разбираем `msgnum`:
     * 100 — OK;
     * 101 — событие уже сохранено;
     * 102 — событие старше сохранённого;
     * 103 — дубль (кеш ~300 с);
     * 104 — сессия в чужом экипаже (не ошибка, но и не сохраняется);
     * >= 200 — ошибка (нет имени/ключа, неверный софт, битый JSON...).
3. Для одиночной отправки EDSM рекомендует добавлять «transient state»
   (`_systemAddress`, `_systemName`, `_systemCoordinates`, `_marketId`,
   `_stationName`, `_shipId`): без них сервер не всегда может понять, где и на
   чём командир был в момент события.
"""

import json
import time

import requests
from typing import Optional

from http_errors import apply_client_headers, describe_bad_response, short_body


class EDSMAPI:
    URL = "https://www.edsm.net/api-journal-v1"

    # Коды, которые считаем успешной (или штатной) обработкой события.
    OK_MSGNUMS = frozenset({100, 101, 102, 103, 104})

    #: Сколько раз пробуем отправить «временную» ошибку (HTML от Cloudflare,
    #: 5xx, 429, обрыв соединения) и пауза между попытками.
    MAX_ATTEMPTS = 3
    RETRY_DELAY = 1.5

    def __init__(self, api_key: str = "", commander_name: str = "",
                 app_name: str = "ED Ring Colony Uploader", app_version: str = "0.0.0"):
        self.api_key = api_key
        self.commander_name = commander_name
        self.app_name = app_name
        self.app_version = app_version
        # Версия и сборка игры — обязательные поля EDSM. Приходят из
        # Fileheader/LoadGame, но если журнал ещё не встретился, отправляем
        # актуальную «живую» версию, иначе EDSM вернёт 207/208.
        self.game_version = "4.0.0.1"
        self.game_build = "live"
        self._session = requests.Session()
        # Без осмысленного User-Agent Cloudflare перед EDSM отдаёт
        # HTML-страницу вместо JSON — выглядит как «сервис сломался».
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

    def set_game_version(self, version: str = "", build: str = ""):
        """Запомнить версию и сборку игры из журнала (Fileheader / LoadGame)."""
        if version:
            self.game_version = str(version).strip()
        if build:
            self.game_build = str(build).strip()

    def submit_event(self, event: dict) -> dict:
        """Отправить одно событие журнала. Возвращает {"ok", "msgnum", "msg"|"error"}.

        Временные сбои (HTML-страница Cloudflare, 5xx, 429, обрыв соединения)
        повторяем `MAX_ATTEMPTS` раз с паузой: потерять событие журнала из-за
        секундной недоступности EDSM обиднее, чем подождать.
        """
        if not self.enabled:
            return {"ok": False, "skipped": True}
        result: dict = {"ok": False, "error": "EDSM: не отправлено"}
        for attempt in range(1, max(1, self.MAX_ATTEMPTS) + 1):
            result = self._submit_once(event)
            if result.get("ok") or not result.get("retryable"):
                return result
            if attempt < self.MAX_ATTEMPTS:
                time.sleep(self.RETRY_DELAY)
        result["attempts"] = max(1, self.MAX_ATTEMPTS)
        return result

    def _submit_once(self, event: dict) -> dict:
        """Одна попытка отправки."""
        try:
            response = self._session.post(
                self.URL,
                data={
                    "commanderName": self.commander_name,
                    "apiKey": self.api_key,
                    "fromSoftware": self.app_name,
                    "fromSoftwareVersion": self.app_version,
                    "fromGameVersion": self.game_version,
                    "fromGameBuild": self.game_build,
                    "message": json.dumps(event, ensure_ascii=False, separators=(",", ":")),
                },
                timeout=15,
            )
        except Exception as exc:
            # Клиент внешнего сервиса не должен ронять ни поток диспетчера,
            # ни разбор журнала.
            return {
                "ok": False,
                "status": 0,
                "retryable": True,
                "error": f"EDSM: нет соединения ({exc}); событие будет повторено",
            }

        # EDSM всегда отвечает 200, даже когда событие отклонено: статус живёт
        # в теле ответа. Поэтому `response.ok` здесь недостаточно.
        msgnum = None
        msg = ""
        try:
            payload = response.json()
            if isinstance(payload, dict):
                msgnum = payload.get("msgnum")
                msg = str(payload.get("msg") or "")
        except ValueError:
            payload = None

        if msgnum is None:
            # Не JSON: HTML от Cloudflare, пустое тело, страница ошибки.
            # Сырую разметку в лог не кладём — только короткое описание.
            return describe_bad_response(
                "EDSM", response, detail="нет JSON в ответе"
            )

        try:
            msgnum = int(msgnum)
        except (TypeError, ValueError):
            return {
                "ok": False,
                "status": response.status_code,
                "error": f"EDSM: неожиданный msgnum {msgnum!r} ({msg or short_body(response)})",
            }

        if msgnum in self.OK_MSGNUMS:
            return {"ok": True, "msgnum": msgnum, "msg": msg, "status": response.status_code}
        return {
            "ok": False,
            "msgnum": msgnum,
            "status": response.status_code,
            "error": f"EDSM {msgnum}: {msg or 'отклонено'}",
        }

    def fetch_system_bodies(self, system_name: str) -> dict:
        """Получить список тел системы из EDSM API.

        Возвращает {"ok": True, "bodies": [...]} или {"ok": False, "error": ...}.
        """
        name = str(system_name or "").strip()
        if not name:
            return {"ok": False, "error": "Пустое имя системы"}
        try:
            url = f"https://www.edsm.net/api-system-v1/bodies?systemName={requests.utils.quote(name)}"
            resp = self._session.get(url, timeout=10)
            if not resp.ok:
                return {"ok": False, "error": f"EDSM HTTP {resp.status_code}"}
            data = resp.json()
            if isinstance(data, dict):
                return {"ok": True, "bodies": data.get("bodies") or []}
            return {"ok": True, "bodies": []}
        except Exception as exc:
            return {"ok": False, "error": f"Сбой запроса к EDSM: {exc}"}

