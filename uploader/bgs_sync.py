"""Минорные фракции на сайте проекта: состояние посещённых систем из журнала.

Зачем
-----
Во вкладке «Фракции» карты Atlas сайт показывает все населённые системы и
системы выбранных минорных фракций. Полный набор сайт берёт из ночного дампа
EDSM, но он обновляется раз в несколько дней, а влияние фракций меняется
каждые сутки. Helper сразу после прыжка (FSDJump), входа в игру (Location) или
прыжка авианосца (CarrierJump) отправляет состояние фракций этой системы:
контролирующую фракцию, влияние, состояния, принадлежность, правительство,
экономику, безопасность и население — ``POST /api/factions/sync``.

Алгоритм отбора — тот же, что ``src/lib/bgsJournal.ts`` (``projectBgsEvent``)
у загрузчика журналов на сайте: одинаковые поля, личного (MyReputation,
SquadronFaction, HomeSystem, HappiestSystem) и локализованных подписей нет.
Сервер применяет наблюдение, только если оно свежее сохранённого, поэтому
повтор пачки и один журнал, загруженный и с сайта, и из Helper'а, безопасны.
Хеши доставок (``source_hash``) этот модуль не трогает.

Outbox на диске: по одной (самой свежей) записи на систему, так что даже
полная история журналов не раздувает очередь.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

#: События, которые несут состояние фракций системы.
BGS_EVENTS = ("FSDJump", "Location", "CarrierJump")
#: Поля события — тот же список, что BGS_SYSTEM_FIELDS в src/lib/bgsJournal.ts.
BGS_SYSTEM_FIELDS = (
    "event", "timestamp", "StarSystem", "SystemAddress", "StarPos", "SystemAllegiance", "SystemGovernment",
    "SystemEconomy", "SystemSecondEconomy", "SystemSecurity", "Population", "SystemFaction", "FactionState",
)
#: Поля элемента ``Factions`` — тот же список, что BGS_FACTION_FIELDS на сайте.
BGS_FACTION_FIELDS = (
    "Name", "FactionState", "Government", "Influence", "Allegiance", "Happiness",
    "ActiveStates", "PendingStates", "RecoveringStates",
)
STATE_LISTS = frozenset({"ActiveStates", "PendingStates", "RecoveringStates"})

MAX_OUTBOX = 5_000
BATCH_SIZE = 200
SAVE_INTERVAL_SECONDS = 10.0
#: Та же система с тем же состоянием фракций повторно не отправляется столько.
RESEND_AFTER_SECONDS = 3600.0
MAX_SENT_MEMORY = 4_000


def _project_states(value) -> List[dict]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        state = item.get("State") if isinstance(item, Mapping) else None
        if isinstance(state, str) and state:
            out.append({"State": state})
    return out


def _project_faction(value) -> Optional[dict]:
    if not isinstance(value, Mapping):
        return None
    name = value.get("Name")
    if not isinstance(name, str) or not name.strip():
        return None
    out = {}
    for key in BGS_FACTION_FIELDS:
        if key not in value or value[key] is None:
            continue
        out[key] = _project_states(value[key]) if key in STATE_LISTS else value[key]
    return out


def project_bgs_event(event: Mapping[str, Any]) -> Optional[dict]:
    """Проекция события для сервера или None (ненаселённая система, другое событие)."""
    if not isinstance(event, Mapping):
        return None
    if event.get("event") not in BGS_EVENTS:
        return None
    factions = event.get("Factions")
    if not isinstance(factions, list) or not factions:
        return None
    system = event.get("StarSystem")
    if not isinstance(system, str) or not system:
        return None
    out: Dict[str, Any] = {}
    for key in BGS_SYSTEM_FIELDS:
        if key not in event or event[key] is None:
            continue
        value = event[key]
        if key == "SystemFaction" and isinstance(value, Mapping):
            projected = {}
            if isinstance(value.get("Name"), str):
                projected["Name"] = value["Name"]
            if isinstance(value.get("FactionState"), str):
                projected["FactionState"] = value["FactionState"]
            out[key] = projected
            continue
        out[key] = value
    # Адрес системы шире 2^53 — на сайт строкой, иначе JavaScript потеряет разряды.
    address = out.get("SystemAddress")
    if isinstance(address, int) and not isinstance(address, bool):
        out["SystemAddress"] = str(address)
    projected_factions = [item for item in (_project_faction(f) for f in factions) if item]
    if not projected_factions:
        return None
    out["Factions"] = projected_factions
    return out


def _signature(event: Mapping[str, Any]) -> str:
    """Состояние системы без времени: одинаковое повторно не шлём."""
    body = {key: value for key, value in event.items() if key not in ("timestamp", "event")}
    return json.dumps(body, sort_keys=True, ensure_ascii=False, default=str)


def _system_key(event: Mapping[str, Any]) -> str:
    return str(event.get("SystemAddress") or event.get("StarSystem") or "")


def _timestamp(event: Mapping[str, Any]) -> str:
    value = event.get("timestamp")
    return value if isinstance(value, str) else ""


class BgsSnapshotCollector:
    """Отбор наблюдений фракций + outbox на диске + отправка на сайт проекта."""

    def __init__(self, outbox_path=None):
        self.path = Path(outbox_path) if outbox_path else None
        self.lock = threading.RLock()
        self.pending: "OrderedDict[str, dict]" = OrderedDict()
        self._sent: "OrderedDict[str, Tuple[str, float]]" = OrderedDict()
        self.collected = 0
        self.sent = 0
        self.applied = 0
        self.last_result: dict = {}
        self.last_error = ""
        self._dirty = False
        self._saved_at = 0.0
        if self.path:
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(value, list):
                    for item in value[-MAX_OUTBOX:]:
                        if isinstance(item, dict) and _system_key(item):
                            self.pending[_system_key(item)] = item
            except (OSError, ValueError):
                pass

    # -- outbox -----------------------------------------------------------------
    @property
    def pending_count(self) -> int:
        with self.lock:
            return len(self.pending)

    def _save_if_due(self, force: bool = False) -> None:
        if not self.path:
            return
        now = time.monotonic()
        with self.lock:
            if not self._dirty or (not force and now - self._saved_at < SAVE_INTERVAL_SECONDS):
                return
            snapshot = list(self.pending.values())
            self._dirty = False
            self._saved_at = now
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temp = self.path.with_suffix(self.path.suffix + ".tmp")
            temp.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
            os.replace(temp, self.path)
        except OSError:
            with self.lock:
                self._dirty = True

    def save(self) -> None:
        self._save_if_due(force=True)

    # -- вход -------------------------------------------------------------------
    def feed(self, event: Mapping[str, Any], live: bool = False) -> bool:
        """Хук разбора журнала. True — наблюдение поставлено в очередь."""
        try:
            projected = project_bgs_event(event)
        except Exception:
            # Сбой отбора фракций не должен ломать разбор журнала.
            return False
        if not projected:
            return False
        key = _system_key(projected)
        if not key:
            return False
        signature = _signature(projected)
        now = time.monotonic()
        with self.lock:
            current = self.pending.get(key)
            if current is not None and _timestamp(current) > _timestamp(projected):
                return False  # в очереди уже более свежее наблюдение
            last = self._sent.get(key)
            if current is None and last and last[0] == signature and now - last[1] < RESEND_AFTER_SECONDS:
                return False  # только что отправили то же самое
            self.pending[key] = projected
            self.pending.move_to_end(key)
            while len(self.pending) > MAX_OUTBOX:
                self.pending.popitem(last=False)
            self.collected += 1
            self._dirty = True
        self._save_if_due()
        return True

    # -- отправка ---------------------------------------------------------------
    def flush(self, api, max_batches: int = 2) -> dict:
        """Отправить накопленное. Неудачная пачка остаётся в outbox до следующей попытки."""
        if not getattr(api, "is_connected", False):
            return {"ok": False, "error": "Not connected", "sent": 0}
        total = {"ok": True, "sent": 0, "applied": 0, "stale": 0, "created": 0, "systems": []}
        for _ in range(max(1, int(max_batches))):
            with self.lock:
                batch = list(self.pending.items())[:BATCH_SIZE]
            if not batch:
                break
            result = api.sync_bgs_snapshots([item for _, item in batch]) or {}
            if not result.get("ok"):
                self.last_error = str(result.get("error") or "Сервер не принял данные о фракциях")
                total.update(ok=False, error=self.last_error)
                break
            now = time.monotonic()
            with self.lock:
                for key, item in batch:
                    # Удаляем ровно отправленное: пока шёл запрос, могло прийти свежее.
                    if self.pending.get(key) is item:
                        del self.pending[key]
                    self._sent[key] = (_signature(item), now)
                    self._sent.move_to_end(key)
                while len(self._sent) > MAX_SENT_MEMORY:
                    self._sent.popitem(last=False)
                self._dirty = True
            self.sent += len(batch)
            applied = int(result.get("applied") or 0)
            self.applied += applied
            total["sent"] += len(batch)
            total["applied"] += applied
            total["stale"] += int(result.get("stale") or 0)
            total["created"] += int(result.get("created") or 0)
            for name in result.get("systems") or []:
                if isinstance(name, str) and name not in total["systems"]:
                    total["systems"].append(name)
            self.last_error = ""
        self.last_result = total
        self._save_if_due(force=True)
        return total
