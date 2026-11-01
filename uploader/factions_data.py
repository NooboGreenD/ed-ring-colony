"""Фракции текущей системы: снимок из журнала игры и карточка с сайта проекта.

Зачем отдельный модуль
----------------------
Вкладка «Фракции» умеет рисовать список минорных фракций, но раньше состояние
приходило только из живых событий ``FSDJump``/``Location``/``CarrierJump``:
если Helper запустили уже в игре (или журнал старый, а событие о прыжке так и не
пришло), вкладка показывала «Ожидание данных о системе…». Здесь собирается всё,
что можно показать без свежего события:

* снимок из самого журнала — последнее событие с ``Factions`` для этой системы
  (файлы читаются с конца, поэтому шариться по гигабайтам истории не нужно);
* карточка системы из базы проекта (``GET /api/factions/system``) — там
  состояние фракций, которое Helper и сайт уже отправили раньше;
* выбор между ними: свежее наблюдение перекрывает старое, при равном времени
  приоритет у журнала (это первичный источник, сайт — его копия).

Модуль намеренно без Qt и без пользовательских подписей: его можно проверять
обычными тестами и звать из фонового потока.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, List, Mapping, Optional

from bgs_sync import project_bgs_event

#: Откуда пришёл снимок: живое событие журнала, архив журналов или сайт.
SOURCE_JOURNAL = "journal"
SOURCE_JOURNAL_ARCHIVE = "journal-archive"
SOURCE_SITE = "site"

#: Сколько последних файлов журнала просматривать в поисках фракций системы.
JOURNAL_SCAN_FILES = 6
#: Сколько байт от конца файла читать: одного прыжка с фракциями хватает с запасом.
JOURNAL_SCAN_BYTES = 4 * 1024 * 1024


def _as_float(value: Any) -> float:
    """Влияние из журнала и с сайта: доля 0…1, мусор — 0."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if number != number:                       # NaN из битого JSON
        return 0.0
    return max(0.0, min(1.0, number))


def _state_names(value: Any) -> List[str]:
    """``[{"State": "Boom"}]`` (журнал) и ``["Boom"]`` (сайт) — один список."""
    out: List[str] = []
    for item in value or []:
        state = item.get("State") if isinstance(item, Mapping) else item
        text = str(state or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _sort_factions(rows: Iterable[dict]) -> List[dict]:
    """Как в игре и на сайте: по убыванию влияния, дальше по имени."""
    return sorted(rows, key=lambda item: (-item["influence"], item["name"].casefold()))


def snapshot_from_event(event: Mapping[str, Any], source: str = SOURCE_JOURNAL) -> Optional[dict]:
    """Снимок фракций из события журнала (``FSDJump``/``Location``/``CarrierJump``).

    Возвращает ``None``, если событие не о состоянии фракций или система
    ненаселённая. Поля — ровно те, что рисует вкладка, плюс служебные
    ``address``/``observed_at``/``source``.
    """
    projected = project_bgs_event(event)
    if not projected:
        return None
    rows: List[dict] = []
    for faction in projected.get("Factions") or []:
        name = _text(faction.get("Name"))
        if not name:
            continue
        rows.append({
            "name": name,
            "influence": _as_float(faction.get("Influence")),
            "allegiance": _text(faction.get("Allegiance")),
            "government": _text(faction.get("Government")),
            "state": _text(faction.get("FactionState")),
            "active_states": _state_names(faction.get("ActiveStates")),
            "is_player": False,
        })
    if not rows:
        return None
    controlling = projected.get("SystemFaction")
    return {
        "system": _text(projected.get("StarSystem")),
        "address": str(projected.get("SystemAddress") or ""),
        "controlling": _text(controlling.get("Name")) if isinstance(controlling, Mapping) else "",
        "observed_at": _text(projected.get("timestamp")),
        "source": source,
        "factions": _sort_factions(rows),
    }


def snapshot_from_site(payload: Mapping[str, Any]) -> Optional[dict]:
    """Снимок фракций из ответа ``GET /api/factions/system`` (``readBgsSystem``).

    Сервер отдаёт ``{system: {...}, factions: [...]}``; ключи системы —
    ``snake_case`` как в таблице ``bgs_systems``.
    """
    if not isinstance(payload, Mapping):
        return None
    system = payload.get("system")
    if not isinstance(system, Mapping):
        return None
    name = _text(system.get("name"))
    rows: List[dict] = []
    for faction in payload.get("factions") or []:
        if not isinstance(faction, Mapping):
            continue
        faction_name = _text(faction.get("name"))
        if not faction_name:
            continue
        rows.append({
            "name": faction_name,
            "influence": _as_float(faction.get("influence")),
            "allegiance": _text(faction.get("allegiance")),
            "government": _text(faction.get("government")),
            "state": _text(faction.get("state")),
            "active_states": _state_names(faction.get("active_states")),
            "is_player": bool(faction.get("is_player")),
        })
    if not name and not rows:
        return None
    return {
        "system": name,
        "address": _text(system.get("id64")),
        "controlling": _text(system.get("controlling_faction")) or _text(system.get("controlling")),
        "observed_at": _text(system.get("observed_at")),
        "source": SOURCE_SITE,
        "factions": _sort_factions(rows),
    }


def parse_timestamp(value: Any) -> Optional[datetime]:
    """Время наблюдения строкой → ``datetime`` в UTC (``None``, если не разобрать)."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def snapshot_timestamp(snapshot: Optional[Mapping[str, Any]]) -> str:
    """Время наблюдения снимка строкой ISO — для сравнения и подписи."""
    if not isinstance(snapshot, Mapping):
        return ""
    return _text(snapshot.get("observed_at"))


def format_timestamp(value: Any) -> str:
    """``2026-10-31T22:14:03Z`` → ``31.10.2026 22:14`` по местному времени."""
    moment = parse_timestamp(value)
    if moment is None:
        return ""
    return moment.astimezone().strftime("%d.%m.%Y %H:%M")


def prefer_snapshot(journal: Optional[Mapping[str, Any]],
                    site: Optional[Mapping[str, Any]]) -> Optional[dict]:
    """Что показать: свежее из двух наблюдений, при равном времени — журнал.

    Журнал первичен: сайт лишь хранит то, что Helper и загрузчик журналов уже
    отправили, поэтому ответ сайта не должен перекрывать более свежий прыжок
    из журнала. Снимок без времени считаем старее любого со временем.
    """
    if journal and not site:
        return dict(journal)
    if site and not journal:
        return dict(site)
    if not journal and not site:
        return None
    journal_at = parse_timestamp(snapshot_timestamp(journal))
    site_at = parse_timestamp(snapshot_timestamp(site))
    if journal_at is not None and (site_at is None or journal_at >= site_at):
        return dict(journal)
    if site_at is not None:
        return dict(site)
    return dict(journal)


def _matches(snapshot: Mapping[str, Any], system: str, address: str) -> bool:
    own_address = _text(snapshot.get("address"))
    if address and own_address:
        return own_address == address
    own_name = _text(snapshot.get("system"))
    if system and own_name:
        return own_name.casefold() == system.casefold()
    return False


def scan_journal_for_factions(journal_dir: Any, system: str = "", address: Any = "",
                              files: int = JOURNAL_SCAN_FILES,
                              max_bytes: int = JOURNAL_SCAN_BYTES) -> Optional[dict]:
    """Последнее событие с фракциями этой системы в свежих журналах игры.

    Читаются только хвосты последних файлов (по ``max_bytes`` от конца, от
    свежего файла к старому), а строки разбираются с конца — так первое
    найденное событие и есть самое свежее. Полная история в сотни мегабайт
    сюда не попадает.
    """
    directory = Path(journal_dir) if journal_dir else None
    wanted_address = _text(str(address or ""))
    wanted_name = _text(system)
    if directory is None or not (wanted_address or wanted_name):
        return None
    try:
        logs = sorted(directory.glob("Journal.*.log"),
                      key=lambda item: item.stat().st_mtime, reverse=True)
    except OSError:
        return None
    for path in logs[: max(1, int(files))]:
        try:
            size = path.stat().st_size
            with open(path, "rb") as handle:
                if size > max_bytes:
                    handle.seek(size - max_bytes)
                    handle.readline()             # неполная строка после сдвига
                raw = handle.read()
        except OSError:
            continue
        for line in reversed(raw.decode("utf-8", errors="replace").splitlines()):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            snapshot = snapshot_from_event(event, source=SOURCE_JOURNAL_ARCHIVE)
            if snapshot and _matches(snapshot, wanted_name, wanted_address):
                return snapshot
    return None


def snapshot_system(snapshot: Optional[Mapping[str, Any]]) -> str:
    """Имя системы снимка (пустая строка, если его нет)."""
    return _text(snapshot.get("system")) if isinstance(snapshot, Mapping) else ""


def system_key(system: str = "", address: Any = "") -> str:
    """Ключ системы для кэша: адрес надёжнее имени (имя могут переименовать)."""
    return _text(str(address or "")) or _text(system).casefold()
