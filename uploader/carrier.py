"""Груз на авианосце (Fleet Carrier): сколько уже завезено и сколько осталось.

Блок «CARRIER» в оверлее отвечает на два вопроса командира-логиста:

1. **Сколько груза сейчас на авианосце** — по тоннам (достоверно, из
   `CarrierStats.SpaceUsage`) и по товарам поимённо.
2. **Сколько осталось туда завезти** — разница между потребностью
   стройплощадки колонизации и тем, что уже лежит на борту.

Источники данных (только журнал + Raven Colonial, ничего не выдумываем):

=========================  =====================================================
Событие                    Что даёт
=========================  =====================================================
``CarrierStats``           Вместимость трюма и сколько занято грузом. Пишется,
                           когда владелец открывает Carrier Management —
                           единственный достоверный источник тоннажа.
``Docked`` / ``Location``  У какого авианосца стоим: ``MarketID`` (у FC он
``CarrierJump``            равен ``CarrierID``), имя, система.
``CargoTransfer``          Погрузка через экран Inventory → Transfer
                           (``Direction: tocarrier`` / ``toship``). Основной
                           способ завозить груз на свой FC.
``MarketBuy`` /            Торговля на борту авианосца: продажа FC
``MarketSell``             добавляет груз, покупка с FC — забирает.
``CarrierNameChanged``     Переименование.
``CarrierDecommission``    Авианосец списан — состояние очищаем.
Raven Colonial             ``GET /api/fc/{marketId}/cargo`` — товары поимённо,
                           если клиент уже отправлял груз туда (см.
                           ``CarrierTracker.merge_remote``).
=========================  =====================================================

Поимённый учёт из журнала честен ровно настолько, насколько полон журнал:
``CargoTransfer``/``Market*`` дают только дельты с момента разбора. Поэтому
``CarrierState.remote_seen`` показывает, откуда взялись цифры по товарам —
из Raven Colonial (достоверно) или из локального учёта (примерно).

Тоннаж из ``CarrierStats`` — всегда достоверный: он не зависит от того,
видели мы дельты или нет.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Mapping, Optional

from event_dispatch import (
    FLEET_CARRIER_MARKET_MAX,
    FLEET_CARRIER_MARKET_MIN,
    normalize_commodity,
)

#: Какие события журнала вообще смотрит трекер.
CARRIER_EVENTS = frozenset({
    "CarrierStats",
    "CarrierNameChanged",
    "CarrierDecommission",
    "CarrierCancelDecommission",
    "CarrierBuy",
    "Docked",
    "Undocked",
    "Location",
    "CarrierJump",
    "CargoTransfer",
    "MarketBuy",
    "MarketSell",
})


def _as_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def is_carrier_market(market_id) -> bool:
    """MarketID лежит в диапазоне авианосцев (3.7 … 3.8 млрд)."""
    value = _as_int(market_id)
    return FLEET_CARRIER_MARKET_MIN <= value < FLEET_CARRIER_MARKET_MAX


class CarrierState:
    """Снимок состояния авианосца.

    `stored`/`capacity`/`free` — из `CarrierStats` (тонны, достоверно).
    `commodities` — товары поимённо: либо из Raven Colonial, либо по дельтам
    журнала. `tracked_total` — сумма того, что удалось посчитать поимённо;
    она может не совпадать со `stored`, и это нормально (см. модуль).
    """

    def __init__(self) -> None:
        self.carrier_id: int = 0
        self.market_id: int = 0
        self.name: str = ""
        self.callsign: str = ""
        self.system_name: str = ""
        self.system_address: int = 0
        self.at_carrier: bool = False
        self.stats_seen: bool = False
        self.remote_seen: bool = False
        self.pending_decommission: bool = False
        # SpaceUsage
        self.capacity: int = 0
        self.stored: int = 0
        self.reserved: int = 0
        self.free: int = 0
        self.crew_space: int = 0
        self.fuel_level: float = 0.0
        # Товары поимённо: нормализованное имя -> тонны
        self.commodities: Dict[str, int] = {}
        # Как товар подписать в оверлее (локализованное имя из журнала).
        self.names: Dict[str, str] = {}
        self.last_event: str = ""

    # -- производные величины ---------------------------------------------
    @property
    def known(self) -> bool:
        """Знаем ли мы вообще, о каком авианосце речь."""
        return bool(self.carrier_id or self.market_id)

    @property
    def cargo_capacity(self) -> int:
        """Сколько тонн груза влезет: занятое + свободное место.

        `TotalCapacity` включает экипаж, ангары и модульные паки, поэтому
        «вместимость под груз» — это `Cargo + FreeSpace`.
        """
        if self.stats_seen:
            return max(0, self.stored + self.free)
        return 0

    @property
    def fill_percent(self) -> int:
        capacity = self.cargo_capacity
        if capacity <= 0:
            return 0
        return max(0, min(100, int(round(self.stored * 100 / capacity))))

    @property
    def tracked_total(self) -> int:
        return sum(int(v) for v in self.commodities.values() if v > 0)

    def display_name(self) -> str:
        if self.name:
            return self.name
        if self.callsign:
            return f"FC {self.callsign}"
        return ""

    def summary(self) -> str:
        """Одна строка для лога/подсказки."""
        name = self.display_name() or "Fleet Carrier"
        if not self.stats_seen:
            return f"{name}: данные CarrierStats ещё не встречались"
        return (
            f"{name}: груз {self.stored} t / {self.cargo_capacity} t "
            f"(свободно {self.free} t)"
        )

    def remaining(self, need: Mapping[str, int]) -> Dict[str, int]:
        """Сколько ещё завезти по каждому товару из потребности `need`.

        Ключи `need` приводятся к тому же виду, что и учёт (нижний регистр,
        без локализационных токенов), иначе `$steel_name;` и `steel`
        считались бы разными товарами.
        """
        result: Dict[str, int] = {}
        for raw, amount in (need or {}).items():
            key = normalize_commodity(raw)
            if not key:
                continue
            try:
                want = int(amount)
            except (TypeError, ValueError):
                continue
            have = int(self.commodities.get(key, 0) or 0)
            result[key] = max(0, want - have)
        return result

    def get_state_dict(self, need: Optional[Mapping[str, int]] = None) -> Dict[str, Any]:
        """Словарь для оверлея и для хеша данных (см. `_hash_data`)."""
        need = dict(need or {})
        rows = []
        for key in sorted(set(self.commodities) | {normalize_commodity(k) for k in need if k}):
            if not key:
                continue
            want = 0
            for raw, amount in need.items():
                if normalize_commodity(raw) == key:
                    want = _as_int(amount)
                    break
            rows.append({
                "key": key,
                "name": self.names.get(key) or key,
                "amount": int(self.commodities.get(key, 0) or 0),
                "need": want,
                "remaining": max(0, want - int(self.commodities.get(key, 0) or 0)),
            })
        rows.sort(key=lambda row: (-row["remaining"], -row["need"], row["name"]))
        return {
            "carrier_id": self.carrier_id,
            "market_id": self.market_id,
            "name": self.display_name(),
            "callsign": self.callsign,
            "system_name": self.system_name,
            "at_carrier": bool(self.at_carrier),
            "stats_seen": bool(self.stats_seen),
            "remote_seen": bool(self.remote_seen),
            "pending_decommission": bool(self.pending_decommission),
            "stored": int(self.stored),
            "capacity": int(self.capacity),
            "cargo_capacity": int(self.cargo_capacity),
            "free": int(self.free),
            "reserved": int(self.reserved),
            "fuel_level": float(self.fuel_level or 0.0),
            "fill_percent": int(self.fill_percent),
            "tracked_total": int(self.tracked_total),
            "commodities": rows,
            "need_total": sum(max(0, _as_int(v)) for v in need.values()),
        }


class CarrierTracker:
    """Собирает состояние авианосца из потока событий журнала."""

    def __init__(self) -> None:
        self.state = CarrierState()

    # -- входная точка -----------------------------------------------------
    def handle(self, event: Mapping[str, Any]) -> bool:
        """Обработать событие журнала. Возвращает True, если состояние менялось."""
        if not isinstance(event, Mapping):
            return False
        name = str(event.get("event") or "")
        if name not in CARRIER_EVENTS:
            return False
        handler = {
            "CarrierStats": self._absorb_stats,
            "CarrierNameChanged": self._absorb_rename,
            "CarrierDecommission": self._absorb_decommission,
            "CarrierBuy": self._absorb_buy,
            "Docked": self._absorb_docked,
            "Location": self._absorb_docked,
            "CarrierJump": self._absorb_docked,
            "Undocked": self._absorb_undocked,
            "CargoTransfer": self._absorb_transfer,
            "MarketBuy": self._absorb_market,
            "MarketSell": self._absorb_market,
        }.get(name)
        if handler is None:
            return False
        try:
            changed = bool(handler(event))
        except Exception:
            return False
        if changed:
            self.state.last_event = name
        return changed

    def reset(self) -> None:
        self.state = CarrierState()

    # -- события ------------------------------------------------------------
    def _absorb_stats(self, event: Mapping[str, Any]) -> bool:
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id:
            return False
        state = self.state
        state.carrier_id = carrier_id
        # У авианосца MarketID == CarrierID.
        state.market_id = carrier_id
        if event.get("Name"):
            state.name = str(event["Name"])
        if event.get("Callsign"):
            state.callsign = str(event["Callsign"])
        usage = event.get("SpaceUsage") or {}
        if isinstance(usage, Mapping):
            state.capacity = _as_int(usage.get("TotalCapacity"))
            state.stored = _as_int(usage.get("Cargo"))
            state.reserved = _as_int(usage.get("CargoSpaceReserved"))
            state.free = _as_int(usage.get("FreeSpace"))
            state.crew_space = _as_int(usage.get("Crew"))
        try:
            state.fuel_level = float(event.get("FuelLevel") or 0.0)
        except (TypeError, ValueError):
            state.fuel_level = 0.0
        state.pending_decommission = bool(event.get("PendingDecommission"))
        state.stats_seen = True
        return True

    def _absorb_rename(self, event: Mapping[str, Any]) -> bool:
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id or not event.get("Name"):
            return False
        self.state.carrier_id = carrier_id
        self.state.market_id = carrier_id
        self.state.name = str(event["Name"])
        return True

    def _absorb_buy(self, event: Mapping[str, Any]) -> bool:
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id:
            return False
        state = self.state
        state.carrier_id = carrier_id
        state.market_id = carrier_id
        if event.get("Callsign"):
            state.callsign = str(event["Callsign"])
        if event.get("Location"):
            state.system_name = str(event["Location"])
        if event.get("SystemAddress"):
            state.system_address = _as_int(event["SystemAddress"])
        state.pending_decommission = False
        return True

    def _absorb_decommission(self, event: Mapping[str, Any]) -> bool:
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id:
            return False
        self.state.pending_decommission = True
        return True

    def _absorb_docked(self, event: Mapping[str, Any]) -> bool:
        """Docked / Location / CarrierJump: где мы сейчас стоим."""
        station_type = str(event.get("StationType") or "")
        if "carrier" not in station_type.lower():
            # Пристыковались к обычной станции — авианосец больше не «мы».
            if self.state.at_carrier:
                self.state.at_carrier = False
                return True
            return False
        market_id = _as_int(event.get("MarketID"))
        if not market_id:
            return False
        state = self.state
        state.market_id = market_id
        state.carrier_id = state.carrier_id or market_id
        # Имя из `CarrierStats`/`CarrierNameChanged` достовернее: `StationName`
        # у непереименованного авианосца — это «FC L14X1J» по позывному.
        if event.get("StationName") and not state.name:
            state.name = str(event["StationName"])
        if event.get("StarSystem"):
            state.system_name = str(event["StarSystem"])
        if event.get("SystemAddress"):
            state.system_address = _as_int(event["SystemAddress"])
        changed = not state.at_carrier or state.market_id != market_id
        state.at_carrier = True
        # Стоим у чужого авианосца — наши цифры по товарам к нему не относятся.
        if changed and state.carrier_id and state.carrier_id != market_id:
            state.commodities.clear()
            state.remote_seen = False
        return True

    def _absorb_undocked(self, event: Mapping[str, Any]) -> bool:
        if not self.state.at_carrier:
            return False
        market_id = _as_int(event.get("MarketID"))
        if market_id and self.state.market_id and market_id != self.state.market_id:
            return False
        self.state.at_carrier = False
        return True

    def _absorb_transfer(self, event: Mapping[str, Any]) -> bool:
        """Inventory → Transfer: ship <-> авианосец."""
        transfers = event.get("Transfers")
        if not isinstance(transfers, Iterable) or isinstance(transfers, (str, bytes)):
            return False
        market_id = _as_int(event.get("MarketID")) or self.state.market_id
        if not is_carrier_market(market_id) and not self.state.carrier_id:
            return False
        if market_id:
            self.state.market_id = market_id
            self.state.carrier_id = self.state.carrier_id or market_id
        changed = False
        for transfer in transfers:
            if not isinstance(transfer, Mapping):
                continue
            direction = str(transfer.get("Direction") or "").lower()
            if direction == "tocarrier":
                delta = _as_int(transfer.get("Count"))
            elif direction == "toship":
                delta = -_as_int(transfer.get("Count"))
            else:
                continue  # tosrv / tomultiplier — к авианосцу не относятся
            key = normalize_commodity(transfer.get("Type") or transfer.get("Type_Localised"))
            if not key or not delta:
                continue
            self._add_commodity(key, delta, transfer.get("Type_Localised"))
            changed = True
        return changed

    def _absorb_market(self, event: Mapping[str, Any]) -> bool:
        """MarketSell на борту FC — груз прибыл, MarketBuy — убыл."""
        market_id = _as_int(event.get("MarketID"))
        if not market_id:
            return False
        # На своём/чужом авианосце рынок и есть его трюм; обычную станцию
        # не трогаем — иначе «груз авианосца» превратится в лог торговли.
        if not (is_carrier_market(market_id) or market_id == self.state.market_id):
            return False
        count = _as_int(event.get("Count"))
        if not count:
            return False
        key = normalize_commodity(event.get("Type") or event.get("Type_Localised"))
        if not key:
            return False
        if not self.state.carrier_id:
            self.state.carrier_id = market_id
            self.state.market_id = market_id
        delta = count if str(event.get("event")) == "MarketSell" else -count
        self._add_commodity(key, delta, event.get("Type_Localised"))
        return True

    # -- служебное ----------------------------------------------------------
    def _add_commodity(self, key: str, delta: int, label=None) -> None:
        """Прибавить дельту к товару (ниже нуля не опускаемся)."""
        current = int(self.state.commodities.get(key, 0) or 0)
        self.state.commodities[key] = max(0, current + int(delta))
        if not self.state.commodities[key]:
            self.state.commodities.pop(key, None)
        if label and key not in self.state.names:
            self.state.names[key] = str(label)
        # Появилась локальная дельта — цифры Raven перестали быть полными.
        self.state.remote_seen = False

    def merge_remote(self, cargo: Mapping[str, Any], capacity: Optional[int] = None,
                     name: str = "") -> bool:
        """Подставить поимённый груз из Raven Colonial.

        ``cargo`` — карта «товар -> тонны» (имена в нижнем регистре, как их
        хранит Raven). Локальный учёт по дельтам журнала заменяется целиком:
        Raven видел груз всех клиентов, а не только наши переводы.
        """
        if not isinstance(cargo, Mapping) or not cargo:
            return False
        merged: Dict[str, int] = {}
        for raw, amount in cargo.items():
            key = normalize_commodity(raw)
            if not key:
                continue
            value = _as_int(amount)
            if value > 0:
                merged[key] = value
        if not merged:
            return False
        self.state.commodities = merged
        self.state.remote_seen = True
        if capacity:
            self.state.capacity = _as_int(capacity) or self.state.capacity
        if name and not self.state.name:
            self.state.name = str(name)
        return True

    def get_state_dict(self, need: Optional[Mapping[str, int]] = None) -> Dict[str, Any]:
        return self.state.get_state_dict(need)
