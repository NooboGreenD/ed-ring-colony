"""Привязка лаунчера к учётной записи на сайте и перенос настроек.

Здесь нет ни Qt, ни Tk: окно лаунчера только показывает то, что вернули эти
функции, поэтому привязку, обмен настройками и отзыв устройства можно
проверять без графики — сетевой слой подменяется.

Пароль на компьютере не хранится ни в каком виде. Пилот получает в профиле
на сайте короткий код на десять минут, лаунчер меняет его на токен
устройства, а токен лежит в отдельном файле `~/.colonial_helper_account.json`
с правами 0600. Отдельный файл — не прихоть: общий `~/.colonial_helper.json`
Helper перезаписывает целиком из памяти при каждом сохранении, и ключ, о
котором он не знает, оттуда бы пропал. Отозвать устройство можно и в
лаунчере, и в профиле на сайте.

Что переносится: профили раскладки оверлея и позиции блоков. Токены EDSM,
Inara и Raven остаются на том компьютере, где их вводили.
"""
from __future__ import annotations

import socket
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

import launcher_settings
import settings_sync
from i18n import tr
from site_config import DEFAULT_SITE_URL, normalize_site_url

#: Имя файла привязки рядом с общим файлом настроек Helper.
ACCOUNT_FILE_NAME = ".colonial_helper_account.json"
#: Ключи внутри файла привязки: само устройство и время последнего обмена.
ACCOUNT_KEY = "account"
SYNC_KEY = "synced_at"

Requester = Optional[Callable[..., Any]]


# --------------------------------------------------------------- привязка
def account_path(path: Optional[Path] = None) -> Path:
    """Где лежит привязка: рядом с общим файлом настроек Helper.

    Аргумент — путь общего файла (`~/.colonial_helper.json`): тесты и
    переносимые сборки подменяют его, и файл привязки переезжает следом.
    """
    if path is None:
        base = launcher_settings.settings_path(None)
        return base.with_name(ACCOUNT_FILE_NAME)
    base = Path(path)
    return base.with_name(ACCOUNT_FILE_NAME)


def _load_file(path: Optional[Path] = None) -> Dict[str, Any]:
    return launcher_settings.load_settings(account_path(path))


def _save_file(payload: Dict[str, Any], path: Optional[Path] = None) -> bool:
    return launcher_settings.save_settings(payload, account_path(path))


def _account_raw(path: Optional[Path] = None) -> Dict[str, Any]:
    account = _load_file(path).get(ACCOUNT_KEY)
    return dict(account) if isinstance(account, dict) else {}


def read_account(path: Optional[Path] = None) -> Dict[str, Any]:
    """Текущая привязка: токен устройства и профиль для верхней панели."""
    account = _account_raw(path)
    return {
        "token": str(account.get("token") or ""),
        "device_id": str(account.get("device_id") or ""),
        "device_name": str(account.get("device_name") or ""),
        "site_url": str(account.get("site_url") or ""),
        "profile": dict(account.get("profile") or {}),
        "linked_at": str(account.get("linked_at") or ""),
    }


def is_linked(path: Optional[Path] = None) -> bool:
    return bool(read_account(path)["token"])


def site_url(path: Optional[Path] = None) -> str:
    """Адрес сайта: тот же, что настроен у Helper, иначе официальный."""
    configured = str(launcher_settings.load_settings(path).get("site_url") or "")
    try:
        return normalize_site_url(configured or DEFAULT_SITE_URL)
    except ValueError:
        return DEFAULT_SITE_URL


def device_name() -> str:
    """Имя компьютера — по нему пилот узнаёт устройство в профиле на сайте."""
    try:
        return (socket.gethostname() or "").strip()[:64] or "Colonial Helper"
    except OSError:
        return "Colonial Helper"


def profile_title(account: Optional[Dict[str, Any]] = None) -> str:
    """Имя для верхней панели лаунчера: то же, что в профиле на сайте."""
    profile = (account or {}).get("profile") or {}
    for key in ("nick", "cmdrName", "cmdr_name"):
        value = str(profile.get(key) or "").strip()
        if value:
            return value
    return ""


CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"


def normalize_code(value: str) -> str:
    """Код вводят руками: с дефисом, строчными, иногда с пробелами.

    К лишним символам относимся спокойно — их просто нет, а не «код неверный».
    Оставляем только латиницу и цифры: кириллическая «А» в коде не встречается
    и служит признаком того, что включена не та раскладка клавиатуры.
    """
    return "".join(char for char in str(value or "").upper() if char in CODE_ALPHABET)


def initials(title: str) -> str:
    """Две буквы для аватара, пока картинка не загрузилась."""
    words = [word for word in str(title or "").split() if word]
    if not words:
        return "?"
    if len(words) == 1:
        return words[0][:2].upper()
    return (words[0][0] + words[1][0]).upper()


def avatar_url(account: Optional[Dict[str, Any]] = None,
               base_url: str = "") -> str:
    """Полный адрес аватара: на сайте он может быть относительным."""
    raw = str(((account or {}).get("profile") or {}).get("avatarUrl") or "").strip()
    if not raw:
        return ""
    if raw.startswith(("http://", "https://")):
        return raw
    if raw.startswith("/"):
        return f"{(base_url or DEFAULT_SITE_URL).rstrip('/')}{raw}"
    return ""


def _store_account(path: Optional[Path], account: Optional[Dict[str, Any]]) -> bool:
    if account is None:
        return _save_file({}, path)
    payload = _load_file(path)
    payload[ACCOUNT_KEY] = account
    return _save_file(payload, path)


def link_with_code(code: str, path: Optional[Path] = None, *,
                   base_url: str = "", name: str = "",
                   requester: Requester = None) -> Dict[str, Any]:
    """Обменять код из профиля на токен устройства и сохранить привязку."""
    claim = requester or settings_sync.claim_code
    base = (base_url or site_url(path)).rstrip("/")
    payload = claim(base, normalize_code(code), name or device_name())
    token = str(payload.get("token") or "")
    if not token:
        raise settings_sync.SyncError(tr("Сайт не выдал токен устройства."))
    account = {
        "token": token,
        "device_id": str(payload.get("deviceId") or ""),
        "device_name": name or device_name(),
        "site_url": base,
        "profile": dict(payload.get("profile") or {}),
        "linked_at": str(payload.get("linkedAt") or ""),
    }
    if not _store_account(path, account):
        raise settings_sync.SyncError(
            tr("Не удалось сохранить привязку: файл настроек недоступен для записи."))
    return read_account(path)


def refresh_profile(path: Optional[Path] = None, *,
                    requester: Requester = None) -> Dict[str, Any]:
    """Обновить имя и аватар в верхней панели по данным сайта."""
    account = read_account(path)
    if not account["token"]:
        return account
    fetch = requester or settings_sync.fetch_profile
    payload = fetch(account["site_url"] or site_url(path), account["token"])
    stored = dict(account)
    stored["profile"] = dict(payload.get("profile") or account["profile"])
    device = payload.get("device") or {}
    if device.get("id"):
        stored["device_id"] = str(device["id"])
    if device.get("name"):
        stored["device_name"] = str(device["name"])
    _store_account(path, stored)
    return read_account(path)


def unlink(path: Optional[Path] = None, *, requester: Requester = None) -> bool:
    """Отвязать компьютер.

    Сайт оповещаем по возможности: локальная привязка снимается всегда, даже
    если сети нет — иначе токен остался бы на компьютере, который отвязывают.
    В профиле на сайте устройство всё равно можно отозвать отдельно.
    """
    account = read_account(path)
    if account["token"]:
        drop = requester or settings_sync.unlink_device
        try:
            drop(account["site_url"] or site_url(path), account["token"])
        except (settings_sync.SyncError, OSError):
            pass
    return _store_account(path, None)


# ------------------------------------------------------------- настройки
def synced_at(path: Optional[Path] = None) -> str:
    """Время раскладки на сайте, которое этот компьютер уже видел."""
    return str(_load_file(path).get(SYNC_KEY) or "")


def _remember_sync(path: Optional[Path], updated_at: str) -> None:
    payload = _load_file(path)
    payload[SYNC_KEY] = str(updated_at or "")
    _save_file(payload, path)


def push(settings: Dict[str, Any], path: Optional[Path] = None, *,
         requester: Requester = None) -> str:
    """Отправить раскладку оверлея на сайт. Возвращает время сохранения."""
    account = read_account(path)
    if not account["token"]:
        raise settings_sync.SyncError(tr("Лаунчер не привязан к учётной записи."))
    send = requester or settings_sync.upload_settings
    snapshot = settings_sync.collect_snapshot(settings)
    updated_at = send(account["site_url"] or site_url(path), account["token"], snapshot)
    _remember_sync(path, updated_at)
    return updated_at


def pull(settings: Dict[str, Any], path: Optional[Path] = None, *,
         requester: Requester = None) -> Tuple[int, str]:
    """Забрать раскладку с сайта и применить к словарю настроек оверлея.

    Возвращает число перенесённых ключей и время сохранения на сайте. Пустой
    снимок — не ошибка обмена, но и применять нечего: так сайт отвечает, когда
    на нём ещё ничего не сохраняли.
    """
    account = read_account(path)
    if not account["token"]:
        raise settings_sync.SyncError(tr("Лаунчер не привязан к учётной записи."))
    fetch = requester or settings_sync.fetch_settings
    payload = fetch(account["site_url"] or site_url(path), account["token"])
    snapshot = payload.get("settings")
    if not isinstance(snapshot, dict) or not snapshot:
        raise settings_sync.SyncError(tr("На сайте пока нет сохранённых настроек."))
    changed = settings_sync.apply_snapshot(settings, snapshot)
    updated_at = str(payload.get("updatedAt") or "")
    _remember_sync(path, updated_at)
    return changed, updated_at


def pull_into_file(path: Optional[Path] = None, *, requester: Requester = None) -> Tuple[int, str]:
    """Скачать настройки с сайта и записать их в общий файл настроек."""
    settings = launcher_settings.load_settings(path)
    changed, updated_at = pull(settings, path, requester=requester)
    # Пишем только после успешного разбора снимка: чужой формат не должен
    # оставить в файле полуприменённую раскладку.
    launcher_settings.save_settings(settings, path)
    return changed, updated_at


def push_from_file(path: Optional[Path] = None, *, requester: Requester = None) -> str:
    """Отправить на сайт раскладку, которая сейчас лежит в файле настроек."""
    return push(launcher_settings.load_settings(path), path, requester=requester)


def auto_pull(path: Optional[Path] = None, *, requester: Requester = None,
              force: bool = False) -> Optional[int]:
    """Подтянуть настройки после входа/привязки — без вопросов и без падения.

    Забираем, только если на сайте лежит что-то новее того, что этот компьютер
    уже видел: иначе локальная правка раскладки затиралась бы при каждом
    запуске лаунчера. Сбой сети намеренно не превращается в диалог об ошибке —
    привязка не должна мешать запуску Helper.

    Возвращает число перенесённых ключей или ``None``, если брать нечего.
    """
    if not is_linked(path):
        return None
    account = read_account(path)
    base = account["site_url"] or site_url(path)
    fetch = requester or settings_sync.fetch_settings
    try:
        payload = fetch(base, account["token"])
        snapshot = payload.get("settings")
        if not isinstance(snapshot, dict) or not snapshot:
            return None
        remote_stamp = str(payload.get("updatedAt") or "")
        if not force and remote_stamp and remote_stamp == synced_at(path):
            return None
        settings = launcher_settings.load_settings(path)
        changed = settings_sync.apply_snapshot(settings, snapshot)
        launcher_settings.save_settings(settings, path)
        _remember_sync(path, remote_stamp)
        return changed
    except (settings_sync.SyncError, OSError, ValueError):
        return None


def device_label(account: Optional[Dict[str, Any]] = None) -> str:
    """Строка «это устройство» для верхней панели и диалога."""
    name = str((account or {}).get("device_name") or "").strip()
    return name or device_name()


__all__ = [
    "ACCOUNT_FILE_NAME", "ACCOUNT_KEY", "CODE_ALPHABET", "SYNC_KEY",
    "account_path", "auto_pull", "avatar_url",
    "device_label", "device_name", "initials", "is_linked", "link_with_code",
    "normalize_code", "profile_title",
    "pull", "pull_into_file", "push", "push_from_file", "read_account",
    "refresh_profile", "site_url", "synced_at", "unlink",
]
