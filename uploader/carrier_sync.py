"""Учёт авианосцев на сайте проекта: сбор событий журнала и отправка на сервер.

Зачем
-----
Оверлей брал груз авианосца только из Raven Colonial, куда уходили одни
аддитивные дельты. Цифры расходились с реальностью, а без Raven блок CARRIER
пустел. Теперь сайт проекта сам ведёт учёт каждого носителя (личного и
эскадренного): статус, систему и прыжок, службы, груз поимённо. Helper
отправляет туда журнальные события (``POST /api/carriers/sync``), а оверлей
читает готовое состояние (``GET /api/carriers/mine``).

Алгоритм отбора — тот же, что ``src/lib/fleetCarrierCollector.ts`` у загрузчика
журналов на сайте: одинаковые поля событий и одинаковый контекст стоянки.
Хеши грузовых дельт считает сервер из полей события, поэтому один и тот же
журнал, загруженный и через сайт, и через Helper, не задваивает груз.

Банк эскадры
------------
У эскадренного носителя (Javelin-Class) нет журнального события для взноса в
банк эскадры или изъятия из него — меняется только трюм корабля. Как и
SrvSurvey (эталонный клиент Raven Colonial), считаем дифф трюма между
событиями ``Cargo`` у такого носителя. Известные операции (покупка/продажа,
перевод груза) вычитаются из ожидаемого трюма заранее, а не «пропускают»
следующее событие целиком — иначе взнос в той же пятисекундной пачке журнала
терялся бы. Дроны (limpets) в учёт не входят.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional

FC_MARKET_MIN = 3_700_000_000
FC_MARKET_MAX = 3_800_000_000

COMMON_FIELDS = ("event", "timestamp", "CarrierType")
STATION_FIELDS = ("Docked", "MarketID", "StationType", "StationName", "StationServices",
                  "StarSystem", "SystemAddress", "StarPos", "Body", "BodyID")
#: Какие поля события нужны серверу — тот же список, что CARRIER_EVENT_FIELDS на сайте.
CARRIER_EVENT_FIELDS: Dict[str, tuple] = {
    "CarrierStats": ("CarrierID", "Callsign", "Name", "DockingAccess", "AllowNotorious", "FuelLevel",
                     "JumpRangeCurr", "JumpRangeMax", "PendingDecommission", "SpaceUsage", "Finance", "Crew"),
    "CarrierBuy": ("CarrierID", "Callsign", "Location", "StarSystem", "SystemAddress"),
    "CarrierLocation": ("CarrierID", "StarSystem", "SystemAddress", "BodyID"),
    "CarrierJump": STATION_FIELDS,
    "Docked": STATION_FIELDS,
    "Location": STATION_FIELDS,
    "CarrierJumpRequest": ("CarrierID", "SystemName", "SystemAddress", "Body", "BodyID", "DepartureTime"),
    "CarrierJumpCancelled": ("CarrierID",),
    "CarrierNameChanged": ("CarrierID", "Name", "Callsign"),
    "CarrierNameChange": ("CarrierID", "Name", "Callsign"),
    "CarrierDecommission": ("CarrierID",),
    "CarrierCancelDecommission": ("CarrierID",),
    "CarrierDockingPermission": ("CarrierID", "DockingAccess", "AllowNotorious"),
    "CarrierCrewServices": ("CarrierID", "CrewRole", "Operation", "CrewName"),
    "CarrierTradeOrder": ("CarrierID", "Commodity", "Commodity_Localised", "PurchaseOrder", "SaleOrder",
                          "CancelTrade", "Price", "BlackMarket"),
    "MarketBuy": ("MarketID", "Type", "Type_Localised", "Count", "BuyPrice", "TotalCost"),
    "MarketSell": ("MarketID", "Type", "Type_Localised", "Count", "SellPrice", "TotalSale", "AvgPricePaid"),
    "CargoTransfer": ("Transfers",),
}

#: События, меняющие трюм корабля не через банк эскадры и без точной дельты:
#: следующий дифф трюма у эскадренного носителя целиком считается «не банком».
UNKNOWN_CARGO_CHANGES = frozenset({
    "MissionCompleted", "MissionAccepted", "MissionAbandoned", "MissionFailed", "CargoDepot",
    "CollectCargo", "EjectCargo", "MiningRefined", "Died", "Resurrect", "EngineerContribution",
    "TechnologyBroker", "PowerplayCollect", "PowerplayDeliver", "SearchAndRescue",
})
#: Дроны (limpets) — не груз носителя.
IGNORED_COMMODITIES = frozenset({"drones", "limpet", "limpets"})

MAX_OUTBOX = 50_000
BATCH_SIZE = 500
SAVE_INTERVAL_SECONDS = 3.0


def _as_int(value) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def is_carrier_market(value) -> bool:
    parsed = _as_int(value)
    return parsed is not None and FC_MARKET_MIN <= parsed < FC_MARKET_MAX


def canonical_commodity(value) -> str:
    """Ключ товара как у сервера: строчные a-z0-9 без $…_name;."""
    name = str(value or "").strip().lower()
    if name.startswith("$"):
        name = name[1:]
    for suffix in ("_name;", "_name"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return "".join(ch for ch in name if ch.isascii() and ch.isalnum())[:80]


def project(event: Mapping[str, Any], name: str) -> dict:
    fields = CARRIER_EVENT_FIELDS.get(name, ())
    return {key: event[key] for key in (*COMMON_FIELDS, *fields) if key in event and event[key] is not None}


def _services(event: Mapping[str, Any]) -> List[str]:
    services = event.get("StationServices")
    if not isinstance(services, list):
        return []
    return [str(entry).strip().lower() for entry in services if isinstance(entry, str)]


def inventory_from_cargo(data) -> Dict[str, int]:
    """Cargo.json / событие Cargo → {товар: тонны} без дронов."""
    result: Dict[str, int] = {}
    items = data.get("Inventory") if isinstance(data, Mapping) else data
    if not isinstance(items, list):
        return result
    for item in items:
        if not isinstance(item, Mapping):
            continue
        key = canonical_commodity(item.get("Name"))
        count = _as_int(item.get("Count")) or 0
        if not key or key in IGNORED_COMMODITIES or count <= 0:
            continue
        result[key] = result.get(key, 0) + count
    return result


class CarrierEventCollector:
    """Отбор событий авианосца + outbox на диске + отправка на сервер."""

    def __init__(self, outbox_path=None,
                 inventory_reader: Optional[Callable[[], Optional[Dict[str, int]]]] = None):
        self.path = Path(outbox_path) if outbox_path else None
        self.lock = threading.RLock()
        self.pending: List[dict] = []
        self.inventory_reader = inventory_reader
        self.collected = 0
        self.sent = 0
        self.last_result: dict = {}
        self.last_error: str = ""
        self._dirty = False
        self._saved_at = 0.0
        self._context: Dict[str, Any] = {
            "market_id": None, "station_type": "", "system": "", "star_pos": None, "squadron": False,
        }
        # Банк эскадры: ожидаемый трюм корабля у эскадренного носителя.
        self._bank_expected: Optional[Dict[str, int]] = None
        self._bank_unknown_change = False
        if self.path:
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(value, list):
                    self.pending = [entry for entry in value if isinstance(entry, dict)][-MAX_OUTBOX:]
            except (OSError, ValueError):
                pass

    # -- outbox ---------------------------------------------------------------
    def _push(self, event: dict) -> None:
        with self.lock:
            self.pending.append(event)
            if len(self.pending) > MAX_OUTBOX:
                del self.pending[: len(self.pending) - MAX_OUTBOX]
            self.collected += 1
            self._dirty = True
        self._save_if_due()

    def _save_if_due(self, force: bool = False) -> None:
        if not self.path:
            return
        now = time.monotonic()
        with self.lock:
            if not self._dirty or (not force and now - self._saved_at < SAVE_INTERVAL_SECONDS):
                return
            snapshot = list(self.pending)
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

    @property
    def pending_count(self) -> int:
        with self.lock:
            return len(self.pending)

    def pending_carrier_ids(self) -> set:
        """Носители, по которым ещё не отправлены грузовые события.

        Пока они в outbox, снимок груза с сайта старше наших переводов —
        подставлять его в оверлей нельзя, иначе свежая погрузка «откатится».
        """
        ids = set()
        with self.lock:
            snapshot = list(self.pending)
        for event in snapshot:
            name = event.get("event")
            if name in ("MarketBuy", "MarketSell", "SquadronBankTransfer"):
                value = _as_int(event.get("MarketID"))
            elif name == "CargoTransfer":
                value = _as_int(event.get("_MarketID"))
            else:
                continue
            if value:
                ids.add(value)
        return ids

    def flush(self, api, max_batches: int = 2) -> dict:
        """Отправить накопленное. Неудачная пачка остаётся в outbox до следующей попытки."""
        if not getattr(api, "is_connected", False):
            return {"ok": False, "error": "Not connected", "sent": 0}
        total = {"ok": True, "sent": 0, "applied": 0, "duplicates": 0, "carriers": []}
        carriers = set()
        for _ in range(max(1, int(max_batches))):
            with self.lock:
                batch = list(self.pending[:BATCH_SIZE])
            if not batch:
                break
            result = api.sync_carrier_events(batch) or {}
            if not result.get("ok"):
                self.last_error = str(result.get("error") or "Сервер не принял события авианосца")
                total.update(ok=False, error=self.last_error)
                break
            with self.lock:
                # Удаляем ровно отправленное: пока шёл запрос, могли прийти новые события.
                if self.pending[: len(batch)] == batch:
                    del self.pending[: len(batch)]
                self._dirty = True
            self.sent += len(batch)
            total["sent"] += len(batch)
            total["applied"] += int(result.get("applied") or 0)
            total["duplicates"] += int(result.get("duplicates") or 0)
            carriers.update(str(item) for item in (result.get("carriers") or []))
            self.last_error = ""
        total["carriers"] = sorted(carriers)
        self.last_result = total
        self._save_if_due(force=True)
        return total

    # -- контекст стоянки -------------------------------------------------------
    def _docked_at_carrier(self) -> bool:
        market_id = self._context["market_id"]
        return market_id is not None and (
            "carrier" in str(self._context["station_type"]).lower() or is_carrier_market(market_id))

    def _set_system(self, event: Mapping[str, Any]) -> None:
        system = event.get("StarSystem")
        if not isinstance(system, str) or not system:
            return
        if system != self._context["system"]:
            self._context["star_pos"] = None
        self._context["system"] = system
        pos = event.get("StarPos")
        if isinstance(pos, list) and len(pos) == 3:
            self._context["star_pos"] = pos

    def _dock(self, event: Mapping[str, Any], live: bool) -> None:
        self._context["market_id"] = _as_int(event.get("MarketID"))
        self._context["station_type"] = str(event.get("StationType") or "")
        self._context["squadron"] = (
            str(event.get("CarrierType") or "") == "SquadronCarrier" or "squadronbank" in _services(event))
        self._bank_expected = None
        self._bank_unknown_change = False
        if live and self._context["squadron"] and self._docked_at_carrier():
            self._bank_expected = self._read_inventory()

    def _undock(self) -> None:
        self._context.update(market_id=None, station_type="", squadron=False)
        self._bank_expected = None
        self._bank_unknown_change = False

    def _read_inventory(self) -> Optional[Dict[str, int]]:
        if not self.inventory_reader:
            return None
        try:
            value = self.inventory_reader()
        except Exception:
            return None
        if not isinstance(value, dict):
            return None
        # Ключи — как у сервера, дроны не учитываются (что бы ни вернул читатель).
        result: Dict[str, int] = {}
        for name, count in value.items():
            key = canonical_commodity(name)
            amount = _as_int(count) or 0
            if key and key not in IGNORED_COMMODITIES and amount > 0:
                result[key] = result.get(key, 0) + amount
        return result

    # -- банк эскадры -------------------------------------------------------------
    def _bank_adjust(self, commodity, ship_delta: int) -> None:
        """Известная операция поменяла трюм корабля — учесть её в ожидании."""
        if self._bank_expected is None:
            return
        key = canonical_commodity(commodity)
        if not key or key in IGNORED_COMMODITIES or not ship_delta:
            return
        self._bank_expected[key] = max(0, self._bank_expected.get(key, 0) + int(ship_delta))
        if not self._bank_expected[key]:
            self._bank_expected.pop(key, None)

    def _bank_cargo(self, event: Mapping[str, Any]) -> None:
        if str(event.get("Vessel") or "Ship") != "Ship":
            return
        current = inventory_from_cargo(event) if isinstance(event.get("Inventory"), list) else self._read_inventory()
        if current is None:
            return
        expected = self._bank_expected
        self._bank_expected = dict(current)
        if expected is None or self._bank_unknown_change:
            self._bank_unknown_change = False
            return
        transfers = []
        for key in sorted(set(expected) | set(current)):
            change = current.get(key, 0) - expected.get(key, 0)
            if change < 0:
                transfers.append({"Type": key, "Count": -change, "Direction": "tocarrier"})
            elif change > 0:
                transfers.append({"Type": key, "Count": change, "Direction": "toship"})
        if transfers:
            self._push({
                "timestamp": event.get("timestamp"),
                "event": "SquadronBankTransfer",
                "MarketID": self._context["market_id"],
                "Transfers": transfers,
            })

    # -- вход ---------------------------------------------------------------------
    def feed(self, event: Mapping[str, Any], live: bool = False) -> None:
        """Хук разбора журнала. `live=False` — история: банк эскадры не считаем
        (в старых журналах нет содержимого трюма), остальное отправляем —
        сервер идемпотентен и упорядочивает по времени события."""
        if not isinstance(event, Mapping):
            return
        name = str(event.get("event") or "")
        try:
            self._feed(event, name, live)
        except Exception:
            # Сбой учёта носителя не должен ломать разбор журнала.
            return

    def _feed(self, event: Mapping[str, Any], name: str, live: bool) -> None:
        if name in ("LoadGame", "Shutdown", "Undocked"):
            self._undock()
            return
        if name == "FSDJump":
            self._set_system(event)
            self._undock()
            return
        if name == "Location":
            self._set_system(event)
            if event.get("Docked") is True:
                self._dock(event, live)
            else:
                self._undock()
            if self._docked_at_carrier():
                self._push(project(event, name))
            return
        if name == "Docked":
            self._set_system(event)
            self._dock(event, live)
            if not self._docked_at_carrier():
                return
            projected = project(event, name)
            if self._context["star_pos"] and event.get("StarSystem") == self._context["system"]:
                projected["_StarPos"] = self._context["star_pos"]
            self._push(projected)
            return
        if name == "CarrierJump":
            self._set_system(event)
            if event.get("Docked") is not False:
                self._dock(event, live)
            self._push(project(event, name))
            return
        if name in ("MarketBuy", "MarketSell"):
            market_id = _as_int(event.get("MarketID"))
            same_dock = market_id is not None and market_id == self._context["market_id"]
            if same_dock:
                count = _as_int(event.get("Count")) or 0
                self._bank_adjust(event.get("Type"), count if name == "MarketBuy" else -count)
            if not is_carrier_market(market_id) and not (
                    same_dock and "carrier" in str(self._context["station_type"]).lower()):
                return
            projected = project(event, name)
            if same_dock and self._context["station_type"]:
                projected["_StationType"] = self._context["station_type"]
            self._push(projected)
            return
        if name == "CargoTransfer":
            for transfer in event.get("Transfers") or []:
                if not isinstance(transfer, Mapping):
                    continue
                direction = str(transfer.get("Direction") or "").lower()
                count = _as_int(transfer.get("Count")) or 0
                if direction == "tocarrier":
                    self._bank_adjust(transfer.get("Type"), -count)
                elif direction == "toship":
                    self._bank_adjust(transfer.get("Type"), count)
            if not self._docked_at_carrier():
                return
            projected = project(event, name)
            projected["_MarketID"] = self._context["market_id"]
            projected["_StationType"] = self._context["station_type"]
            self._push(projected)
            return
        if name in ("BuyDrones", "SellDrones"):
            return  # дроны не учитываются ни в трюме носителя, ни в диффе
        if name in UNKNOWN_CARGO_CHANGES:
            self._bank_unknown_change = True
            return
        if name == "Cargo":
            if live and self._context["squadron"] and self._docked_at_carrier():
                self._bank_cargo(event)
            return
        if name.startswith("Carrier") and name in CARRIER_EVENT_FIELDS:
            self._push(project(event, name))


# ---------------------------------------------------------------------------
#  Рынок авианосца → исправление груза в Raven Colonial
# ---------------------------------------------------------------------------
def carrier_market_cargo(items) -> Dict[str, int]:
    """Что по снимку рынка FC лежит на борту — правило SrvSurvey/Raven Colonial.

    Товар на продажу (Producer) — его Stock и есть количество на борту;
    распроданная позиция (ни продажи, ни закупки) — ноль; ордер на закупку
    (Consumer) о трюме ничего не говорит. Без флагов (старые снимки):
    Stock > 0 — продажа, только Demand — закупка.
    """
    result: Dict[str, int] = {}
    for item in items or []:
        if not isinstance(item, Mapping):
            continue
        key = canonical_commodity(item.get("Name") or item.get("name"))
        if not key:
            continue
        stock = max(0, _as_int(item.get("Stock", item.get("stock"))) or 0)
        demand = max(0, _as_int(item.get("Demand", item.get("demand"))) or 0)
        producer = item.get("Producer", item.get("producer"))
        consumer = item.get("Consumer", item.get("consumer"))
        if producer is None:
            producer = stock > 0
        if consumer is None:
            consumer = (not producer) and demand > 0
        if producer or (not producer and not consumer):
            result[key] = stock
    return result
