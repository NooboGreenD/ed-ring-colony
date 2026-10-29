"""Настройки Helper на сайте проекта: снимок раскладки оверлея.

Пилот привязывает компьютер к учётной записи кодом из профиля, и после этого
раскладка оверлея (профили раскладки и позиции блоков) может лежать на сайте.
На другом компьютере достаточно привязаться — настройки подтянутся сами.

Что НЕ уезжает на сайт: токены EDSM/Inara, путь к журналам, настройки каналов
обновлений и всё остальное, что относится к конкретной установке. Только
раскладка и её профили — этого достаточно, чтобы пересесть на другое
устройство, и этого мало, чтобы навредить, если снимок кто-то увидит.

Модуль не знает ни про Qt, ни про Tk: снимок собирается из словаря настроек,
поэтому его легко проверять без запуска оверлея.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

#: Версия формата снимка. Если раскладка когда-нибудь переедет, старая
#: версия на сайте не будет молча применена к новой программе.
SNAPSHOT_VERSION = 1

#: Ключи, которые переносятся между устройствами. Позиции блоков хранятся
#: парами `<ключ>_x/_y/_width/_height/_anchor`, поэтому проверяем по префиксу.
_BLOCK_KEYS = (
    "route",
    "status",
    "ship",
    "cargo",
    "session",
    "events",
    "exobio",
    "carrier",
    "footmap",
)
_BLOCK_FIELDS = ("x", "y", "width", "height", "anchor")
_SCALAR_KEYS = ("active_profile", "layout_margin")
_LIST_KEYS = ("block_order",)


class SyncError(RuntimeError):
    """Обмен с сайтом не удался. Текст предназначен для показа пилоту."""


def collect_snapshot(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Собрать снимок раскладки из настроек оверлея.

    Копия глубокая там, где нужно: профили раскладки — вложенные словари, и
    отдавать их по ссылке значило бы разрешить сайту менять живые настройки.
    """
    profiles = settings.get("profiles")
    snapshot: Dict[str, Any] = {
        "version": SNAPSHOT_VERSION,
        "profiles": json.loads(json.dumps(profiles)) if isinstance(profiles, dict) else {},
    }
    for key in _SCALAR_KEYS:
        if key in settings:
            snapshot[key] = settings[key]
    for key in _LIST_KEYS:
        value = settings.get(key)
        if isinstance(value, (list, tuple)):
            snapshot[key] = list(value)
    for block in _BLOCK_KEYS:
        for field in _BLOCK_FIELDS:
            name = f"{block}_{field}"
            if name in settings:
                snapshot[name] = settings[name]
        for field in ("visible", "scale", "opacity"):
            name = f"{block}_{field}"
            if name in settings:
                snapshot[name] = settings[name]
    return snapshot


def apply_snapshot(settings: Dict[str, Any], snapshot: Any) -> int:
    """Перенести снимок с сайта в настройки. Возвращает число ключей.

    Чужой формат игнорируется целиком: лучше оставить текущую раскладку, чем
    получить полуприменённый набор, в котором половина блоков уехала за экран.
    """
    if not isinstance(snapshot, dict):
        raise SyncError("Сайт вернул настройки неизвестного вида.")
    version = snapshot.get("version", SNAPSHOT_VERSION)
    try:
        version = int(version)
    except (TypeError, ValueError):
        raise SyncError("Сайт вернул настройки неизвестной версии.") from None
    if version != SNAPSHOT_VERSION:
        raise SyncError(
            f"На сайте лежат настройки версии {version}, эта программа понимает {SNAPSHOT_VERSION}. "
            "Обновите Helper."
        )

    changed = 0
    profiles = snapshot.get("profiles")
    if isinstance(profiles, dict):
        settings["profiles"] = json.loads(json.dumps(profiles))
        changed += 1
    for key in _SCALAR_KEYS + _LIST_KEYS:
        if key in snapshot:
            settings[key] = snapshot[key]
            changed += 1
    for block in _BLOCK_KEYS:
        for field in _BLOCK_FIELDS + ("visible", "scale", "opacity"):
            name = f"{block}_{field}"
            if name in snapshot:
                settings[name] = snapshot[name]
                changed += 1
    return changed


def _request(url: str, token: str, method: str, body: Optional[dict] = None,
             timeout: float = 15.0) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read().decode("utf-8", "replace") or "{}")
            detail = str(payload.get("error") or "")
        except Exception:
            detail = ""
        raise SyncError(detail or f"Сайт ответил ошибкой {exc.code}.") from None
    except urllib.error.URLError as exc:
        raise SyncError(f"Нет связи с сайтом: {exc.reason}") from None
    except OSError as exc:
        raise SyncError(f"Нет связи с сайтом: {exc}") from None
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise SyncError("Сайт вернул не JSON.") from None


def claim_code(base_url: str, code: str, device_name: str, timeout: float = 15.0) -> dict:
    """Обменять код из профиля на токен устройства."""
    payload = _request(
        f"{base_url.rstrip('/')}/api/uploader/link/claim",
        "",
        "POST",
        {"code": code, "device": device_name},
        timeout,
    )
    token = str(payload.get("token") or "")
    if not payload.get("ok") or not token:
        raise SyncError(str(payload.get("error") or "Код не принят."))
    return payload


def fetch_profile(base_url: str, token: str, timeout: float = 15.0) -> dict:
    payload = _request(f"{base_url.rstrip('/')}/api/uploader/link/me", token, "GET", None, timeout)
    if not payload.get("ok"):
        raise SyncError(str(payload.get("error") or "Не удалось получить профиль."))
    return payload


def unlink_device(base_url: str, token: str, timeout: float = 15.0) -> None:
    _request(f"{base_url.rstrip('/')}/api/uploader/link/me", token, "DELETE", None, timeout)


def fetch_settings(base_url: str, token: str, timeout: float = 20.0) -> Dict[str, Any]:
    """Ответ сайта целиком: снимок и время его сохранения.

    Время нужно лаунчеру, чтобы на старте не затирать локальную правку
    раскладки тем, что и так уже лежит на сайте с прошлого раза.
    """
    payload = _request(f"{base_url.rstrip('/')}/api/uploader/settings", token, "GET", None, timeout)
    if not payload.get("ok"):
        raise SyncError(str(payload.get("error") or "Не удалось скачать настройки."))
    settings = payload.get("settings")
    return {
        "settings": settings if isinstance(settings, dict) else {},
        "updatedAt": str(payload.get("updatedAt") or ""),
        "deviceName": str(payload.get("deviceName") or ""),
    }


def download_settings(base_url: str, token: str, timeout: float = 20.0) -> Dict[str, Any]:
    """Только снимок настроек — без метаданных."""
    return fetch_settings(base_url, token, timeout)["settings"]


def upload_settings(base_url: str, token: str, snapshot: Dict[str, Any],
                    timeout: float = 20.0) -> str:
    payload = _request(
        f"{base_url.rstrip('/')}/api/uploader/settings",
        token,
        "PUT",
        {"settings": snapshot},
        timeout,
    )
    if not payload.get("ok"):
        raise SyncError(str(payload.get("error") or "Не удалось отправить настройки."))
    return str(payload.get("updatedAt") or "")
