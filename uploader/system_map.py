"""Карта системы: тела, станции, стройплощадки и где сейчас пилот.

Вкладка «Карта системы» показывает всё, что известно о системе, в которой
находится пилот: звезду, планеты и луны, станции, поселения, авианосцы и —
главное — колонизационные стройплощадки с процентом завезённого груза.

Данные собираются из трёх источников и складываются в одну картину:

1. **Журнал** (первоисточник, работает и без сети): `Scan`,
   `SAAScanComplete`, `FSSDiscoveryScan`, `FSSSignalDiscovered`, `Docked`,
   `Undocked`, `Location`, `CarrierJump`, `ApproachBody`/`LeaveBody`,
   `Touchdown`/`Liftoff`, `CarrierStats`, `ColonisationConstructionDepot`.
2. **Raven Colonial** `/api/system/{systemAddress}` — активные проекты системы:
   `buildId`, `buildName`, потребность и сколько уже завезли (включая груз
   других командиров).
3. **Raven Colonial** `/api/v2/system/{system}/sites` — планы площадок: что в
   системе задумано, даже если стройки ещё физически нет.

Модуль намеренно не знает про tkinter: он строит снимок системы
(`SystemMapBuilder.snapshot()`) и раскладывает его по координатам
(`layout()`), а рисует уже вкладка. Так раскладку и арифметику прогресса можно
тестировать без GUI.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from colonisation import (
    default_project_name,
    is_construction_site,
    is_primary_port_station,
)
from event_dispatch import normalize_commodity

# ---------------------------------------------------------------------------
# Типы объектов
# ---------------------------------------------------------------------------
KIND_STAR = "star"
KIND_PLANET = "planet"
KIND_MOON = "moon"
KIND_UNKNOWN = "unknown"

STATION_SITE = "construction_site"     # колонизационная стройплощадка
STATION_PORT = "port"                  # станция/порт (построенный объект)
STATION_PRIMARY_PORT = "primary_port"  # основной порт системы
STATION_OUTPOST = "outpost"
STATION_SETTLEMENT = "settlement"
STATION_INSTALLATION = "installation"
STATION_CARRIER = "carrier"            # Fleet Carrier
STATION_MEGASHIP = "megaship"
STATION_OTHER = "other"

#: Подписи объектов для вкладки и легенды карты.
STATION_LABELS = {
    STATION_SITE: "стройплощадка",
    STATION_PORT: "станция",
    STATION_PRIMARY_PORT: "основной порт",
    STATION_OUTPOST: "аванпост",
    STATION_SETTLEMENT: "поселение",
    STATION_INSTALLATION: "установка",
    STATION_CARRIER: "авианосец",
    STATION_MEGASHIP: "мегакорабль",
    STATION_OTHER: "объект",
}

BODY_LABELS = {
    KIND_STAR: "звезда",
    KIND_PLANET: "планета",
    KIND_MOON: "луна",
    KIND_UNKNOWN: "тело",
}

#: `StationType` из журнала -> наш тип объекта. Ключи в нижнем регистре.
STATION_TYPE_KINDS = {
    "fleetcarrier": STATION_CARRIER,
    "carrier": STATION_CARRIER,
    "orbis starport": STATION_PORT,
    "coriolis starport": STATION_PORT,
    "ocellus starport": STATION_PORT,
    "bernal starport": STATION_PORT,
    "asteroid base": STATION_PORT,
    "station": STATION_PORT,
    "outpost": STATION_OUTPOST,
    "planetary outpost": STATION_OUTPOST,
    "civilian outpost": STATION_OUTPOST,
    "commercial outpost": STATION_OUTPOST,
    "industrial outpost": STATION_OUTPOST,
    "scientific outpost": STATION_OUTPOST,
    "military outpost": STATION_OUTPOST,
    "settlement": STATION_SETTLEMENT,
    "planetary settlement": STATION_SETTLEMENT,
    "installation": STATION_INSTALLATION,
    "planetaryinstallation": STATION_INSTALLATION,
    "planetary installation": STATION_INSTALLATION,
    "megaship": STATION_MEGASHIP,
    "mega ship": STATION_MEGASHIP,
}

#: `$SAA_SignalType_...;` из `FSSSignalDiscovered` -> тип объекта.
SIGNAL_KINDS = {
    "station": STATION_PORT,
    "carrier": STATION_CARRIER,
    "installation": STATION_INSTALLATION,
    "settlement": STATION_SETTLEMENT,
    "megaship": STATION_MEGASHIP,
    "notable": STATION_OTHER,
    "salvage": STATION_OTHER,
}

#: Сколько систем держим в памяти: текущая плюс несколько предыдущих, чтобы
#: возврат по тому же маршруту не пересобирал карту с нуля.
MAX_SYSTEMS = 4
MAX_BODIES_PER_SYSTEM = 400
MAX_STATIONS_PER_SYSTEM = 150

#: События журнала, которые что-то меняют на карте.
MAP_EVENTS = frozenset({
    "Location", "FSDJump", "CarrierJump", "SupercruiseEntry", "SupercruiseExit",
    "Docked", "Undocked", "ApproachBody", "LeaveBody", "Touchdown", "Liftoff",
    "Scan", "FSSDiscoveryScan", "SAAScanComplete", "FSSSignalDiscovered",
    "CarrierStats", "ColonisationConstructionDepot", "LoadGame", "Loadout",
    "ShipyardBuy", "ShipyardSwap",
})


def _as_float(value, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(result) or math.isinf(result):
        return default
    return result


def _as_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def better_kind(current: str, candidate: str) -> str:
    """Какой тип объекта оставить.

    События журнала не всегда несут `StationType`: `Undocked` и часть
    `Docked` приходят без него, и `classify_station` отвечает «объект».
    Такой ответ не должен стирать уже известный тип — иначе станция, которую
    мы видели портом, после отстыковки превращалась бы в безымянный «объект».
    """
    if candidate == STATION_OTHER and current and current != STATION_OTHER:
        return current
    return candidate or current or STATION_OTHER


def merged_source(current: str) -> str:
    """Откуда объект известен после подмешивания данных Raven.

    Повторное слияние не должно «переключать» источник туда-сюда: иначе вкладка
    считает, что карта изменилась, и перерисовывается на ровном месте.
    """
    if current == "journal":
        return "both"
    return current or "raven"


def classify_station(name: str, station_type: str = "",
                     services: Optional[List[str]] = None) -> str:
    """Тип станции/объекта по имени, `StationType` и сервисам из журнала."""
    if is_construction_site(name, services):
        return STATION_PRIMARY_PORT if is_primary_port_station(name) else STATION_SITE
    lowered = str(station_type or "").strip().lower()
    kind = STATION_TYPE_KINDS.get(lowered)
    if kind:
        return kind
    if "carrier" in lowered:
        return STATION_CARRIER
    if "outpost" in lowered:
        return STATION_OUTPOST
    if "settlement" in lowered:
        return STATION_SETTLEMENT
    if "installation" in lowered:
        return STATION_INSTALLATION
    if "port" in lowered or "starport" in lowered:
        return STATION_PORT
    return STATION_OTHER


def classify_signal(signal_name: str) -> Optional[str]:
    """Тип объекта из `$SAA_SignalType_Station;`-токена FSS-сигнала."""
    token = str(signal_name or "").strip()
    if not token:
        return None
    if token.startswith("$") and token.endswith(";"):
        token = token[1:-1]
    parts = [part for part in token.replace("SAA_SignalType_", "").split("_") if part]
    key = parts[-1].lower() if parts else ""
    return SIGNAL_KINDS.get(key)


# ---------------------------------------------------------------------------
# Модель
# ---------------------------------------------------------------------------
@dataclass
class MapStation:
    """Станция, поселение, авианосец или колонизационная стройплощадка."""

    name: str = ""
    market_id: int = 0
    station_type: str = ""
    kind: str = STATION_OTHER
    body_name: str = ""
    body_num: Optional[int] = None
    system: str = ""
    # Стройка / проект.
    progress: Optional[float] = None        # 0..1 из журнала (ConstructionProgress)
    required_tons: int = 0                  # всего нужно завезти
    provided_tons: int = 0                  # сколько завезено (все командиры)
    build_id: str = ""
    build_name: str = ""
    build_type: str = ""
    remaining_by_commodity: Dict[str, int] = field(default_factory=dict)
    complete: bool = False
    planned: bool = False                   # план Raven: физической стройки ещё нет
    source: str = "journal"                 # journal | raven | both
    updated_at: str = ""

    # -- производные ------------------------------------------------------
    @property
    def remaining_tons(self) -> int:
        if self.required_tons > 0:
            return max(0, self.required_tons - self.provided_tons)
        return sum(max(0, int(value)) for value in self.remaining_by_commodity.values())

    @property
    def percent_delivered(self) -> Optional[int]:
        """Сколько процентов груза завезено — то, что рисуется в прогресс-баре."""
        if self.complete:
            return 100
        if self.required_tons > 0:
            share = self.provided_tons / float(self.required_tons)
            return max(0, min(100, int(round(share * 100))))
        if self.progress is not None:
            return max(0, min(100, int(round(_as_float(self.progress) * 100))))
        return None

    @property
    def is_site(self) -> bool:
        return self.kind in (STATION_SITE, STATION_PRIMARY_PORT)

    @property
    def title(self) -> str:
        """Имя для подписи на карте: у стройки — название проекта, если есть."""
        if self.build_name:
            return default_project_name(self.build_name) or self.build_name
        if self.is_site and self.name:
            return default_project_name(self.name) or self.name
        return self.name or STATION_LABELS.get(self.kind, "объект")

    @property
    def caption(self) -> str:
        """Строка под иконкой: тип + прогресс (или остаток, если % неизвестен)."""
        label = STATION_LABELS.get(self.kind, "объект")
        percent = self.percent_delivered
        if self.planned and percent is None:
            return f"{label} · план"
        if percent is not None:
            rest = self.remaining_tons
            return f"{label} · {percent}%" + (f" · осталось {rest:,} t".replace(",", " ")
                                              if rest else "")
        if self.remaining_tons:
            tons = f"{self.remaining_tons:,}".replace(",", " ")
            return f"{label} · осталось {tons} t"
        return label


@dataclass
class MapBody:
    """Тело системы: звезда, планета или луна."""

    name: str
    system: str = ""
    body_id: Optional[int] = None
    kind: str = KIND_UNKNOWN
    body_class: str = ""
    star_type: str = ""
    distance_ls: float = 0.0
    radius_m: float = 0.0
    parent_ids: List[int] = field(default_factory=list)
    parent_name: str = ""
    landable: bool = False
    scanned: bool = False
    mapped: bool = False
    terraformable: bool = False
    from_raven: bool = False              # тело из Raven v2, журнал его не видел
    stations: List[MapStation] = field(default_factory=list)
    updated_at: str = ""

    @property
    def is_star(self) -> bool:
        return self.kind == KIND_STAR

    @property
    def is_moon(self) -> bool:
        return self.kind == KIND_MOON

    @property
    def label(self) -> str:
        parts = [self.name or "тело"]
        detail = self.body_class or self.star_type
        if detail:
            parts.append(detail)
        return " · ".join(parts)

    @property
    def site(self) -> Optional[MapStation]:
        for station in self.stations:
            if station.is_site:
                return station
        return None


@dataclass
class PlayerPosition:
    """Где сейчас пилот — то, ради чего карта и рисуется."""

    system: str = ""
    system_address: int = 0
    body_name: str = ""
    station_name: str = ""
    market_id: int = 0
    docked: bool = False
    on_surface: bool = False
    in_supercruise: bool = False
    near_body: bool = False
    ship_type: str = ""
    ship_name: str = ""
    star_pos: List[float] = field(default_factory=list)
    updated_at: str = ""

    @property
    def place(self) -> str:
        """Короткое описание места для подписи «вы здесь»."""
        if self.docked and self.station_name:
            return f"на станции {self.station_name}"
        if self.on_surface and self.body_name:
            return f"на поверхности {self.body_name}"
        if self.near_body and self.body_name:
            return f"у тела {self.body_name}"
        if self.in_supercruise:
            return "в суперкруизе"
        return "в космосе"


@dataclass
class MapSnapshot:
    """Всё, что нужно вкладке для отрисовки одного кадра."""

    system: str = ""
    system_address: int = 0
    bodies: List[MapBody] = field(default_factory=list)
    stations: List[MapStation] = field(default_factory=list)
    player: PlayerPosition = field(default_factory=PlayerPosition)
    known_body_count: int = 0       # BodyCount из FSSDiscoveryScan
    updated_at: str = ""

    @property
    def star(self) -> Optional[MapBody]:
        for body in self.bodies:
            if body.is_star:
                return body
        return None

    @property
    def planets(self) -> List[MapBody]:
        return [body for body in self.bodies if body.kind == KIND_PLANET]

    @property
    def moons(self) -> List[MapBody]:
        return [body for body in self.bodies if body.kind == KIND_MOON]

    @property
    def sites(self) -> List[MapStation]:
        """Стройплощадки и проекты системы — то, что важнее всего на карте."""
        return [station for station in self.stations if station.is_site]

    @property
    def building(self) -> List[MapStation]:
        """Незавершённые стройки: им нужен прогресс-бар."""
        return [station for station in self.sites
                if not station.complete and not station.planned]

    @property
    def built(self) -> List[MapStation]:
        """Построенные объекты системы."""
        return [station for station in self.stations
                if not station.is_site or station.complete]


# ---------------------------------------------------------------------------
# Сборщик
# ---------------------------------------------------------------------------
class SystemMapBuilder:
    """Собирает карту системы из журнала и данных Raven Colonial."""

    def __init__(self, max_systems: int = MAX_SYSTEMS):
        self.max_systems = max(1, int(max_systems))
        # system -> name -> MapBody
        self._bodies: Dict[str, Dict[str, MapBody]] = {}
        # system -> key -> MapStation (key: market_id или имя)
        self._stations: Dict[str, Dict[str, MapStation]] = {}
        self._order: List[str] = []
        self.known_body_counts: Dict[str, int] = {}
        self.current_system: str = ""
        self.current_system_address: int = 0
        self.player = PlayerPosition()
        self.updated_at: str = ""

    # -- служебное --------------------------------------------------------
    def reset(self) -> None:
        self._bodies.clear()
        self._stations.clear()
        self._order.clear()
        self.known_body_counts.clear()
        self.current_system = ""
        self.current_system_address = 0
        self.player = PlayerPosition()

    def _touch_system(self, system: str) -> None:
        if not system:
            return
        if system in self._order:
            self._order.remove(system)
        self._order.insert(0, system)
        while len(self._order) > self.max_systems:
            dropped = self._order.pop()
            self._bodies.pop(dropped, None)
            self._stations.pop(dropped, None)
            self.known_body_counts.pop(dropped, None)
        self._bodies.setdefault(system, {})
        self._stations.setdefault(system, {})

    def _body(self, system: str, name: str) -> MapBody:
        self._touch_system(system)
        bodies = self._bodies[system]
        body = bodies.get(name)
        if body is None:
            body = MapBody(name=name, system=system)
            bodies[name] = body
            if len(bodies) > MAX_BODIES_PER_SYSTEM:
                bodies.pop(next(iter(bodies)), None)
        return body

    def _station(self, system: str, name: str, market_id: int = 0,
                 source: str = "journal") -> MapStation:
        self._touch_system(system)
        stations = self._stations[system]
        key = f"m{market_id}" if market_id else f"n{name.strip().lower()}"
        station = stations.get(key)
        if station is None and market_id:
            # Ту же станцию могли запомнить по имени (FSS-сигнал, посадка без
            # MarketID) — объединяем, иначе на карте будет два значка.
            alias = stations.get(f"n{name.strip().lower()}")
            if alias is not None and alias.name == name:
                stations.pop(f"n{name.strip().lower()}", None)
                alias.market_id = market_id
                stations[key] = alias
                return alias
        if station is None:
            station = MapStation(name=name, market_id=int(market_id or 0),
                                 system=system, source=source)
            stations[key] = station
            if len(stations) > MAX_STATIONS_PER_SYSTEM:
                stations.pop(next(iter(stations)), None)
        return station

    # -- события журнала --------------------------------------------------
    def handle(self, event: dict) -> bool:
        """Обработать одно событие журнала. Возвращает True, если карта изменилась."""
        if not isinstance(event, dict):
            return False
        name = str(event.get("event") or "")
        if name not in MAP_EVENTS:
            return False
        handler = getattr(self, f"_on_{name.lower()}", None)
        if handler is None:
            return False
        try:
            ship_changed = self._absorb_ship(event)
            changed = bool(handler(event)) or ship_changed
        except Exception:
            return False
        timestamp = str(event.get("timestamp") or "")
        if timestamp:
            self.updated_at = timestamp
            if self.player.system:
                self.player.updated_at = timestamp
        return bool(changed)

    # -- положение --------------------------------------------------------
    def _absorb_system(self, event: dict) -> Tuple[str, int]:
        system = str(event.get("StarSystem") or event.get("SystemName") or "").strip()
        address = _as_int(event.get("SystemAddress"), 0)
        if system:
            self.current_system = system
            self.player.system = system
            self._touch_system(system)
        elif self.current_system:
            system = self.current_system
        if address:
            self.current_system_address = address
            self.player.system_address = address
        elif self.current_system_address:
            address = self.current_system_address
        star_pos = event.get("StarPos")
        if isinstance(star_pos, (list, tuple)) and len(star_pos) == 3:
            self.player.star_pos = [_as_float(value) for value in star_pos]
        return system, address

    def _absorb_ship(self, event: dict) -> bool:
        """Корабль пилота: его несут и LoadGame, и Location/FSDJump/Docked."""
        ship = str(event.get("Ship") or "").strip()
        ship_name = str(event.get("ShipName") or event.get("ShipIdent") or "").strip()
        changed = False
        if ship and ship != self.player.ship_type:
            self.player.ship_type = ship
            changed = True
        if ship_name and ship_name != self.player.ship_name:
            self.player.ship_name = ship_name
            changed = True
        return changed

    def _set_body(self, event: dict) -> str:
        body = str(event.get("BodyName") or event.get("Body") or "").strip()
        if body:
            self.player.body_name = body
            self.player.near_body = True
        return body

    def _absorb_station_fields(self, event: dict, system: str) -> Optional[MapStation]:
        """Станция из `Docked`/`Location`/`CarrierJump`: имя, тип, MarketID, тело."""
        station_name = str(event.get("StationName") or "").strip()
        if not station_name:
            return None
        station_type = str(event.get("StationType") or "")
        services = event.get("StationServices") or []
        market_id = _as_int(event.get("MarketID"), 0)
        station = self._station(system, station_name, market_id)
        station.station_type = station_type or station.station_type
        station.kind = better_kind(station.kind,
                                   classify_station(station_name, station_type, services))
        if market_id:
            station.market_id = market_id
        body_name = str(event.get("BodyName") or event.get("Body") or "").strip()
        if body_name:
            station.body_name = body_name
        if event.get("BodyID") is not None:
            station.body_num = _as_int(event.get("BodyID"), station.body_num or 0)
        station.updated_at = str(event.get("timestamp") or station.updated_at)
        self._attach(system, station)
        return station

    def _attach(self, system: str, station: MapStation) -> None:
        """Привязать станцию к телу, если тело известно."""
        if not station.body_name:
            return
        body = self._bodies.get(system, {}).get(station.body_name)
        if body is None:
            body = self._body(system, station.body_name)
        if not any(item is station for item in body.stations):
            body.stations.append(station)

    def _on_location(self, event: dict) -> bool:
        system, _address = self._absorb_system(event)
        self.player.docked = bool(event.get("Docked"))
        self.player.in_supercruise = bool(event.get("InSupercruise"))
        self.player.on_surface = False
        body_type = str(event.get("BodyType") or "").strip().lower()
        body = self._set_body(event)
        if body and body_type == "star":
            self.player.near_body = True
        station_name = str(event.get("StationName") or "").strip()
        self.player.station_name = station_name
        self.player.market_id = _as_int(event.get("MarketID"), 0)
        station = self._absorb_station_fields(event, system)
        if station is not None:
            self.player.station_name = station.name
        if event.get("Docked"):
            self.player.docked = True
        # Тело из Location — тоже объект карты (пусть без Scan).
        if body and system:
            known = self._body(system, body)
            known.updated_at = str(event.get("timestamp") or known.updated_at)
        return True

    def _on_loadgame(self, event: dict) -> bool:
        self._absorb_ship(event)
        return True

    def _on_loadout(self, event: dict) -> bool:
        self._absorb_ship(event)
        return True

    def _on_shipyardbuy(self, event: dict) -> bool:
        self._absorb_ship(event)
        return True

    def _on_shipyardswap(self, event: dict) -> bool:
        self._absorb_ship(event)
        return True

    def _on_fsdjump(self, event: dict) -> bool:
        system, _address = self._absorb_system(event)
        self.player.docked = False
        self.player.on_surface = False
        self.player.in_supercruise = True     # выход из прыжка — в суперкруизе
        self.player.station_name = ""
        self.player.market_id = 0
        self.player.body_name = ""
        self.player.near_body = False
        self._touch_system(system)
        return True

    def _on_carrierjump(self, event: dict) -> bool:
        system, _address = self._absorb_system(event)
        self.player.docked = bool(event.get("Docked"))
        self.player.on_surface = False
        self.player.in_supercruise = False
        station = self._absorb_station_fields(event, system)
        self.player.station_name = station.name if station else ""
        self.player.market_id = station.market_id if station else 0
        self._set_body(event)
        return True

    def _on_supercruiseentry(self, event: dict) -> bool:
        self._absorb_system(event)
        self.player.in_supercruise = True
        self.player.near_body = False
        self.player.body_name = ""
        # В суперкруизе нельзя быть пристыкованным: если `Undocked` потерялся
        # (обрыв журнала), отметка пилота всё равно уходит со станции.
        self.player.docked = False
        self.player.station_name = ""
        self.player.market_id = 0
        return True

    def _on_supercruiseexit(self, event: dict) -> bool:
        self._absorb_system(event)
        self.player.in_supercruise = False
        body = self._set_body(event)
        system = self.player.system
        if body and system:
            self._body(system, body).updated_at = str(
                event.get("timestamp") or self.updated_at)
        return True

    def _on_approachbody(self, event: dict) -> bool:
        self._absorb_system(event)
        self._set_body(event)
        self.player.in_supercruise = False
        self.player.near_body = True
        return True

    def _on_leavebody(self, event: dict) -> bool:
        self._absorb_system(event)
        self.player.near_body = False
        self.player.on_surface = False
        return True

    def _on_touchdown(self, event: dict) -> bool:
        self._absorb_system(event)
        self.player.on_surface = True
        self.player.near_body = bool(self.player.body_name)
        self.player.in_supercruise = False
        if str(event.get("NearestDestination") or "").strip():
            self.player.on_surface = True
        return True

    def _on_liftoff(self, event: dict) -> bool:
        self._absorb_system(event)
        self.player.on_surface = False
        return True

    def _on_docked(self, event: dict) -> bool:
        system, _address = self._absorb_system(event)
        station = self._absorb_station_fields(event, system)
        self.player.docked = True
        self.player.on_surface = False
        self.player.in_supercruise = False
        self.player.station_name = station.name if station else ""
        self.player.market_id = station.market_id if station else 0
        self._set_body(event)
        return True

    def _on_undocked(self, event: dict) -> bool:
        system, _address = self._absorb_system(event)
        # Станция остаётся на карте — уходит только отметка «вы здесь».
        station_name = str(event.get("StationName") or "").strip()
        if station_name:
            station = self._station(system, station_name, _as_int(event.get("MarketID"), 0))
            station.kind = better_kind(station.kind, classify_station(
                station_name, str(event.get("StationType") or ""),
                event.get("StationServices") or []))
            self._attach(system, station)
        self.player.docked = False
        self.player.station_name = ""
        self.player.market_id = 0
        return True

    def _on_carrierstats(self, event: dict) -> bool:
        system = self.player.system or self.current_system
        if not system:
            return False
        name = str(event.get("Name") or "").strip()
        if not name:
            return False
        station = self._station(system, name, _as_int(event.get("MarketID"), 0))
        station.kind = STATION_CARRIER
        station.station_type = station.station_type or "FleetCarrier"
        station.updated_at = str(event.get("timestamp") or station.updated_at)
        self._attach(system, station)
        return True

    # -- тела -------------------------------------------------------------
    @staticmethod
    def _has_planet_parent(event: dict) -> bool:
        """Parents: [{Star:1}] — планета, [{Planet:4}] — луна этой планеты."""
        parents = event.get("Parents")
        if not isinstance(parents, list):
            return False
        return any(isinstance(entry, dict) and "Planet" in entry for entry in parents)

    def _on_scan(self, event: dict) -> bool:
        system, _address = self._absorb_system(event)
        name = str(event.get("BodyName") or "").strip()
        if not name:
            return False
        body = self._body(system, name)
        body.body_id = _as_int(event.get("BodyID"), 0) or body.body_id
        star_type = str(event.get("StarType") or "").strip()
        planet_class = str(event.get("PlanetClass") or "").strip()
        moon = self._has_planet_parent(event)
        if star_type:
            body.kind = KIND_STAR
            body.star_type = star_type
            body.body_class = planet_class or body.body_class
        elif planet_class:
            body.body_class = planet_class
            body.terraformable = "terraformable" in planet_class.lower()
            if body.kind in (KIND_UNKNOWN, KIND_PLANET):
                body.kind = KIND_MOON if moon else KIND_PLANET
        elif body.kind == KIND_UNKNOWN:
            body.kind = KIND_MOON if moon else KIND_PLANET
        parents = event.get("Parents") or []
        parent_ids = []
        if isinstance(parents, list):
            for parent in parents:
                if isinstance(parent, dict):
                    for value in parent.values():
                        parent_id = _as_int(value, 0)
                        if parent_id:
                            parent_ids.append(parent_id)
        if parent_ids:
            body.parent_ids = parent_ids
        body.distance_ls = _as_float(event.get("DistanceFromArrivalLS"), body.distance_ls)
        body.radius_m = _as_float(event.get("Radius"), body.radius_m)
        if "Landable" in event:
            body.landable = bool(event.get("Landable"))
        body.scanned = True
        body.updated_at = str(event.get("timestamp") or body.updated_at)
        self._resolve_parents(system)
        return True

    def _on_saascancomplete(self, event: dict) -> bool:
        system = self.player.system or self.current_system
        name = str(event.get("BodyName") or "").strip()
        if not system or not name:
            return False
        body = self._body(system, name)
        body.body_id = _as_int(event.get("BodyID"), 0) or body.body_id
        body.mapped = True
        body.updated_at = str(event.get("timestamp") or body.updated_at)
        return True

    def _on_fssdiscoveryscan(self, event: dict) -> bool:
        system, _address = self._absorb_system(event)
        count = _as_int(event.get("BodyCount"), 0)
        if system and count:
            self.known_body_counts[system] = count
        return bool(count)

    def _on_fsssignaldiscovered(self, event: dict) -> bool:
        """FSS-сигнал: станция/поселение/авианосец видны ещё до стыковки."""
        system, _address = self._absorb_system(event)
        if not bool(event.get("IsStation")):
            return False
        kind = classify_signal(str(event.get("SignalName") or ""))
        if kind is None:
            return False
        name = str(event.get("SignalName_Localised") or event.get("SignalName") or "").strip()
        # Сигналы без имени («Station») не добавляем: значок без подписи
        # засорял бы карту, а настоящая станция придёт из Docked/Location.
        if not name or name.lower() in {"station", "carrier", "installation", "settlement"}:
            return False
        station = self._station(system, name)
        if station.kind == STATION_OTHER or station.kind == STATION_PORT:
            station.kind = kind
        # Сигнал FSS — данные журнала; если объект уже пришёл из Raven, он
        # известен из обоих источников.
        station.source = "both" if station.source == "raven" else (station.source or "journal")
        station.updated_at = str(event.get("timestamp") or station.updated_at)
        return True

    def _resolve_parents(self, system: str) -> None:
        """body_id -> имя родителя: луны рисуются рядом со своей планетой."""
        bodies = self._bodies.get(system, {})
        by_id = {body.body_id: body for body in bodies.values() if body.body_id}
        for body in bodies.values():
            if not body.parent_ids:
                continue
            parent = None
            for parent_id in body.parent_ids:
                candidate = by_id.get(parent_id)
                if candidate is not None and candidate is not body:
                    parent = candidate
                    break
            if parent is None or parent.kind == KIND_MOON:
                continue
            if not body.parent_name:
                body.parent_name = parent.name
            # планету, чей родитель — планета, показываем луной (и наоборот)
            if body.kind != KIND_STAR:
                body.kind = KIND_MOON if parent.kind == KIND_PLANET else KIND_PLANET

    # -- стройплощадки ----------------------------------------------------
    def _on_colonisationconstructiondepot(self, event: dict) -> bool:
        """Главный источник прогресса стройки: потребность и сколько завезли."""
        system, _address = self._absorb_system(event)
        market_id = _as_int(event.get("MarketID"), 0)
        name = str(event.get("ConstructionName") or event.get("StationName") or "").strip()
        if not name:
            name = (f"Construction site {event.get('ConstructionID')}"
                    if event.get("ConstructionID") else "")
        if not name and not market_id:
            return False
        station = self._station(system, name, market_id)
        station.kind = STATION_SITE if station.kind in (
            STATION_OTHER, STATION_INSTALLATION, STATION_PORT) else station.kind
        if not station.is_site:
            station.kind = STATION_SITE
        station.station_type = station.station_type or "PlanetaryInstallation"

        required = 0
        provided = 0
        remaining: Dict[str, int] = {}
        for item in event.get("ResourcesRequired") or []:
            if not isinstance(item, dict):
                continue
            commodity = normalize_commodity(
                item.get("Name") or item.get("Name_Localised") or "")
            need = _as_int(item.get("RequiredAmount"), 0)
            have = _as_int(item.get("ProvidedAmount"), 0)
            required += max(0, need)
            provided += max(0, min(have, need) if need else have)
            if commodity and need - have > 0:
                remaining[commodity] = need - have
        if required:
            station.required_tons = required
            station.provided_tons = provided
        if remaining:
            station.remaining_by_commodity = remaining
        elif required:
            station.remaining_by_commodity = {}

        progress = event.get("ConstructionProgress", event.get("Progress"))
        if progress is not None:
            station.progress = _as_float(progress, 0.0)
        station.complete = bool(event.get("ConstructionComplete") or station.complete)
        station.planned = False
        # Площадка, уже известная из Raven, теперь подтверждена журналом.
        station.source = ("both" if station.source == "raven"
                          else (station.source or "journal"))
        station.updated_at = str(event.get("timestamp") or station.updated_at)
        if not station.name and name:
            station.name = name
        body_name = str(event.get("BodyName") or event.get("Body") or "").strip()
        if body_name:
            station.body_name = body_name
        body_num = event.get("BodyNum", event.get("BodyID"))
        if body_num is not None:
            station.body_num = _as_int(body_num, station.body_num or 0)
        if station.body_num and not station.body_name:
            station.body_name = self._body_name_by_num(system, station.body_num)
        self._attach(system, station)
        return True

    def _body_name_by_num(self, system: str, body_num: int) -> str:
        for body in self._bodies.get(system, {}).values():
            if body.body_id == int(body_num or 0):
                return body.name
        return ""

    # -- данные Raven Colonial -------------------------------------------
    def merge_projects(self, system: str, projects: List[dict]) -> bool:
        """Активные проекты системы (`GET /api/system/{systemAddress}`).

        Оттуда берётся то, чего журнал не знает: сколько груза завезли ДРУГИЕ
        командиры (`sumNeed`/`sumTotal` или `commodities` — остаток
        потребности), имя проекта и его `buildId`.
        """
        system = str(system or self.current_system or "").strip()
        if not system or not isinstance(projects, list):
            return False
        changed = False
        for project in projects:
            if not isinstance(project, dict):
                continue
            build_id = str(project.get("buildId") or "").strip()
            market_id = _as_int(project.get("marketId"), 0)
            name = str(project.get("buildName") or "").strip()
            if not (build_id or market_id or name):
                continue
            station = self._project_station(system, market_id, name)
            if build_id and station.build_id != build_id:
                station.build_id = build_id
                changed = True
            build_type = str(project.get("buildType") or "").strip()
            if build_type and station.build_type != build_type:
                station.build_type = build_type
                changed = True
            if name and station.build_name != name:
                station.build_name = name
                changed = True
            body_num = project.get("bodyNum", project.get("bodyId"))
            if body_num is not None:
                number = _as_int(body_num, 0)
                if number and station.body_num != number:
                    station.body_num = number
                    if not station.body_name:
                        station.body_name = self._body_name_by_num(system, number)
                    changed = True
            if station.body_name:
                self._attach(system, station)

            total = _as_int(project.get("sumTotal"), 0)
            has_need = any(key in project for key in ("sumNeed", "sumRemaining"))
            need = _as_int(project.get("sumNeed", project.get("sumRemaining")), 0)
            delivered = _as_int(project.get("sumDelivered", project.get("sumProvided")), -1)
            commodities = project.get("commodities")
            remaining: Dict[str, int] = {}
            if isinstance(commodities, dict):
                for key, value in commodities.items():
                    commodity = normalize_commodity(key)
                    amount = _as_int(value, 0)
                    if commodity and amount > 0:
                        remaining[commodity] = amount
            # Сколько завезено по данным Raven (включая груз других командиров).
            # `sumNeed` отсутствует — не угадываем: иначе проект без остатка
            # выглядел бы завезённым на 100%.
            raven_provided = -1
            if total > 0:
                if delivered >= 0:
                    raven_provided = delivered
                elif has_need:
                    raven_provided = max(0, total - max(0, need))
            if raven_provided >= 0:
                # Потребность берём из журнала (это состояние игры), а завезено —
                # максимум из двух источников: прогресс не должен откатываться
                # назад, если Raven отстаёт, и должен расти, если другие
                # командиры уже довезли груз.
                required = station.required_tons or total
                provided = min(max(station.provided_tons, raven_provided), required)
                if (station.required_tons, station.provided_tons) != (required, provided):
                    station.required_tons = required
                    station.provided_tons = provided
                    changed = True
            if remaining and remaining != station.remaining_by_commodity:
                station.remaining_by_commodity = remaining
                changed = True
            complete = bool(project.get("complete") or project.get("isComplete"))
            if complete != station.complete:
                station.complete = complete
                changed = True
            if station.kind not in (STATION_SITE, STATION_PRIMARY_PORT):
                station.kind = (STATION_PRIMARY_PORT
                                if is_primary_port_station(station.name) else STATION_SITE)
                changed = True
            if station.planned:
                station.planned = False
                changed = True
            source = merged_source(station.source)
            if station.source != source:
                station.source = source
                changed = True
        return changed

    def _project_station(self, system: str, market_id: int, name: str) -> MapStation:
        """Найти станцию проекта: по market_id, по имени стройки или создать."""
        self._touch_system(system)
        stations = self._stations[system]
        if market_id:
            found = stations.get(f"m{market_id}")
            if found is not None:
                return found
        if name:
            lowered = name.strip().lower()
            for station in stations.values():
                if str(station.build_name or "").strip().lower() == lowered:
                    return station
                if default_project_name(station.name).strip().lower() == lowered:
                    return station
        return self._station(system, name or f"Проект {market_id}", market_id,
                             source="raven")

    def merge_site_plans(self, system: str, plans: List[dict]) -> bool:
        """Планы площадок (`GET /api/v2/system/{system}/sites`).

        План — это будущая стройка: на карте она показывается отдельно
        (`planned`), без прогресс-бара, потому что завозить туда ещё нечего.
        """
        system = str(system or self.current_system or "").strip()
        if not system or not isinstance(plans, list):
            return False
        changed = False
        for plan in plans:
            if not isinstance(plan, dict):
                continue
            status = str(plan.get("status") or "").lower()
            if status in ("demolish", "demolished"):
                continue
            name = str(plan.get("name") or "").strip()
            body_num = plan.get("bodyNum", plan.get("bodyId"))
            body_name = str(plan.get("bodyName") or "").strip()
            if not name and body_num is None:
                continue
            existing = self._find_plan_station(system, name, body_num, body_name)
            if existing is not None and not existing.planned:
                # Реальная стройка уже известна — план её не перекрывает.
                if str(plan.get("buildType") or "") and not existing.build_type:
                    existing.build_type = str(plan.get("buildType"))
                    changed = True
                continue
            station = existing or self._station(
                system, name or body_name or "Площадка",
                _as_int(plan.get("marketId"), 0), source="raven")
            if not station.planned:
                station.planned = True
                changed = True
            complete = status in ("complete", "completed")
            if station.complete != complete:
                station.complete = complete
                changed = True
            if str(plan.get("buildType") or "") and station.build_type != str(plan.get("buildType")):
                station.build_type = str(plan.get("buildType"))
                changed = True
            if station.kind not in (STATION_SITE, STATION_PRIMARY_PORT):
                station.kind = STATION_SITE
                changed = True
            if body_name and station.body_name != body_name:
                station.body_name = body_name
                self._attach(system, station)
                changed = True
            if body_num is not None and not station.body_num:
                station.body_num = _as_int(body_num, 0)
                if not station.body_name and station.body_num:
                    station.body_name = self._body_name_by_num(system, station.body_num)
                    if station.body_name:
                        self._attach(system, station)
                changed = True
            source = merged_source(station.source)
            if station.source != source:
                station.source = source
                changed = True
        return changed

    # -- тела из Raven Colonial v2 ----------------------------------------
    @staticmethod
    def _raven_body_fields(raw: dict) -> dict:
        """Поля тела из ответа Raven v2: ключи приходят в разном регистре."""
        def pick(*keys):
            for key in keys:
                if key in raw and raw[key] not in (None, ""):
                    return raw[key]
            return None

        fields = {
            "name": str(pick("bodyName", "BodyName", "name", "Name") or "").strip(),
            "body_id": _as_int(pick("bodyId", "BodyID"), 0),
            "star_type": str(pick("starType", "StarType") or "").strip(),
            "body_class": str(pick("planetClass", "PlanetClass", "type", "Type")
                              or "").strip(),
            "distance_ls": _as_float(pick("distanceFromArrivalLS",
                                          "DistanceFromArrivalLS", "distanceLS"), 0.0),
            "radius_m": _as_float(pick("radius", "Radius", "radiusM"), 0.0),
        }
        landable = pick("isLandable", "Landable", "landable")
        fields["landable"] = bool(landable) if isinstance(landable, bool) else None
        parents = pick("parents", "Parents")
        parent_ids: List[int] = []
        if isinstance(parents, list):
            for entry in parents:
                if isinstance(entry, dict):
                    parent_ids.extend(_as_int(value, 0) for value in entry.values()
                                      if _as_int(value, 0))
                elif _as_int(entry, 0):
                    parent_ids.append(_as_int(entry, 0))
        fields["parent_ids"] = parent_ids
        return fields

    def merge_bodies(self, system: str, bodies: List[dict]) -> bool:
        """Тела системы из Raven Colonial v2 (`/v2/system/{system}`).

        Зачем: до сканирования карта знала бы только станции и «звезда не
        отсканирована», а пилоту хочется видеть систему сразу по прилёту.
        Raven даёт имена, классы и расстояния всех тел; журнал остаётся
        главным источником — его поля (скан, карта, посадка, класс) мы не
        затираем, а только дополняем пробелы.
        """
        system = str(system or self.current_system or "").strip()
        if not system or not isinstance(bodies, list):
            return False
        changed = False
        for raw in bodies:
            if not isinstance(raw, dict):
                continue
            fields = self._raven_body_fields(raw)
            name = fields["name"]
            if not name:
                continue
            body = self._bodies.get(system, {}).get(name)
            if body is None:
                body = self._body(system, name)
                body.from_raven = True
                changed = True
            for key, value in (
                ("body_id", fields["body_id"]),
                ("star_type", fields["star_type"]),
                ("body_class", fields["body_class"]),
                ("distance_ls", fields["distance_ls"]),
                ("radius_m", fields["radius_m"]),
            ):
                if not value:
                    continue
                if not getattr(body, key):
                    # Журнал главнее: дополняем только пробелы.
                    setattr(body, key, value)
                    changed = True
            if fields["landable"] is not None and not body.scanned:
                if body.landable != fields["landable"]:
                    body.landable = fields["landable"]
                    changed = True
            if fields["parent_ids"] and not body.parent_ids:
                body.parent_ids = fields["parent_ids"]
                changed = True
            if body.kind == KIND_UNKNOWN:
                if fields["star_type"]:
                    body.kind = KIND_STAR
                elif fields["parent_ids"]:
                    body.kind = KIND_MOON
                else:
                    body.kind = KIND_PLANET
                changed = True
            if "terraformable" in str(fields["body_class"]).lower():
                if not body.terraformable:
                    body.terraformable = True
                    changed = True
        if changed:
            self._resolve_parents(system)
        return changed

    def _find_plan_station(self, system: str, name: str, body_num, body_name: str):
        """Станция, которая уже соответствует этому плану."""
        lowered = str(name or "").strip().lower()
        number = _as_int(body_num, 0)
        for station in self._stations.get(system, {}).values():
            if lowered and (
                str(station.build_name or "").strip().lower() == lowered
                or default_project_name(station.name).strip().lower() == lowered
                or station.name.strip().lower() == lowered
            ):
                return station
            if number and station.body_num == number and station.is_site:
                return station
            if body_name and station.body_name == body_name and station.is_site:
                return station
        return None

    # -- снимок -----------------------------------------------------------
    def snapshot(self, system: str = "") -> MapSnapshot:
        """Карта системы: тела (звезда, планеты, луны), объекты, позиция пилота."""
        system = str(system or self.current_system or "").strip()
        bodies = list(self._bodies.get(system, {}).values())
        self._resolve_parents(system)
        stations = list(self._stations.get(system, {}).values())

        # Тела сортируются так, как их рисует игра: звезда, затем планеты по
        # удалённости, луны — сразу за своей планетой.
        by_parent: Dict[str, List[MapBody]] = {}
        for body in bodies:
            if body.parent_name and body.kind == KIND_MOON:
                by_parent.setdefault(body.parent_name, []).append(body)
        for items in by_parent.values():
            items.sort(key=lambda item: (item.distance_ls or 0.0, item.name))

        ordered: List[MapBody] = []
        stars = [body for body in bodies if body.kind == KIND_STAR]
        stars.sort(key=lambda body: (body.distance_ls or 0.0, body.name))
        ordered.extend(stars)
        # Планеты — всё, что не звезда и не луна: у планеты родитель-звезда.
        planets = [body for body in bodies if body.kind not in (KIND_STAR, KIND_MOON)]
        planets.sort(key=lambda body: (body.distance_ls or 0.0, body.name))
        for planet in planets:
            ordered.append(planet)
            ordered.extend(by_parent.get(planet.name, []))
        seen = {body.name for body in ordered}
        for body in sorted(bodies, key=lambda item: (item.distance_ls or 0.0, item.name)):
            if body.name not in seen:
                ordered.append(body)

        station_order = {
            STATION_SITE: 0, STATION_PRIMARY_PORT: 0, STATION_CARRIER: 1,
            STATION_PORT: 2, STATION_OUTPOST: 3, STATION_MEGASHIP: 4,
            STATION_INSTALLATION: 5, STATION_SETTLEMENT: 6, STATION_OTHER: 7,
        }
        stations.sort(key=lambda station: (
            station_order.get(station.kind, 9),
            -(station.percent_delivered if station.percent_delivered is not None else -1),
            station.name.lower(),
        ))

        return MapSnapshot(
            system=system,
            system_address=self.current_system_address if system == self.current_system else 0,
            bodies=ordered,
            stations=stations,
            player=PlayerPosition(**{
                key: value for key, value in self.player.__dict__.items()
            }),
            known_body_count=int(self.known_body_counts.get(system, 0) or 0),
            updated_at=self.updated_at,
        )


# ---------------------------------------------------------------------------
# Раскладка (чистая геометрия — её рисует вкладка)
# ---------------------------------------------------------------------------
@dataclass
class PlacedItem:
    """Объект карты с координатами: что рисовать и где."""

    kind: str                       # "star" | "body" | "station" | "player"
    x: float = 0.0
    y: float = 0.0
    radius: float = 6.0
    label: str = ""
    caption: str = ""
    color: str = "#eeeeee"
    progress: Optional[int] = None
    orbit_radius: float = 0.0       # радиус орбитального кольца (для тел)
    label_dy: float = 0.0           # сдвиг подписи: расталкивание наложений
    ref: object = None
    selected: bool = False

    @property
    def bar_width(self) -> int:
        return 46


#: Цвета тел по классу (те же, что использует оверлей EXOBIO/CARRIER).
BODY_COLORS = {
    "star": "#ffd166",
    "rocky": "#9c8f7f",
    "icy": "#9fd8ef",
    "gas": "#e0a458",
    "water": "#4aa3df",
    "earth": "#5fbf7f",
    "metal": "#c9a227",
    "ammonia": "#b39ddb",
    "helium": "#8ecae6",
    "default": "#8d99ae",
}

SITE_COLOR = "#e67e22"
SITE_DONE_COLOR = "#2ecc71"
SITE_PLAN_COLOR = "#8d99ae"
CARRIER_COLOR = "#3498db"
STATION_COLOR = "#eeeeee"
PLAYER_COLOR = "#2ecc71"


def body_color(body: MapBody) -> str:
    if body.is_star:
        return BODY_COLORS["star"]
    lowered = (body.body_class or "").lower()
    for key, color in (
        ("earthlike", BODY_COLORS["earth"]),
        ("terraform", BODY_COLORS["earth"]),
        ("water", BODY_COLORS["water"]),
        ("gas", BODY_COLORS["gas"]),
        ("icy", BODY_COLORS["icy"]),
        ("metal", BODY_COLORS["metal"]),
        ("ammonia", BODY_COLORS["ammonia"]),
        ("helium", BODY_COLORS["helium"]),
        ("rocky", BODY_COLORS["rocky"]),
    ):
        if key in lowered:
            return color
    return BODY_COLORS["default"]


def station_color(station: MapStation) -> str:
    if station.kind == STATION_CARRIER:
        return CARRIER_COLOR
    if station.is_site:
        if station.complete:
            return SITE_DONE_COLOR
        return SITE_PLAN_COLOR if station.planned else SITE_COLOR
    return STATION_COLOR


GOLDEN_ANGLE = math.pi * (3.0 - math.sqrt(5.0))   # ~137.5°, раскладка без наложений


def layout(snapshot: MapSnapshot, width: int, height: int, zoom: float = 1.0,
           show_moons: bool = True, selected: str = "") -> List[PlacedItem]:
    """Разложить снимок системы по координатам холста.

    Карта схематическая (реальных орбитальных позиций журнал не даёт): звезда в
    центре, планеты на кольцах, радиус которых логарифмически зависит от
    `DistanceFromArrivalLS`, угол — по золотому углу, поэтому тела не
    накладываются друг на друга. Луны рисуются рядом со своей планетой,
    станции — рядом со своим телом, стройплощадки получают прогресс-бар.

    Функция детерминирована: один и тот же снимок даёт те же координаты, что
    позволяет тестировать раскладку без tkinter.
    """
    width = max(80, int(width or 0))
    height = max(80, int(height or 0))
    zoom = max(0.4, min(4.0, _as_float(zoom, 1.0) or 1.0))
    center_x = width / 2.0
    center_y = height / 2.0
    max_radius = max(30.0, min(center_x, center_y) - 46.0) * zoom

    items: List[PlacedItem] = []
    positions: Dict[str, Tuple[float, float]] = {}

    star = snapshot.star
    if star is not None:
        star_radius = max(9.0, min(22.0, 9.0 + math.log10(max(1.0, star.radius_m) / 1.0e8) * 3.0))
        items.append(PlacedItem(
            kind="star", x=center_x, y=center_y, radius=star_radius,
            label=star.name, caption=star.body_class or star.star_type,
            color=BODY_COLORS["star"], orbit_radius=0.0, ref=star,
            selected=(selected == star.name),
        ))
        positions[star.name] = (center_x, center_y)
    else:
        items.append(PlacedItem(kind="star", x=center_x, y=center_y, radius=4.0,
                                label="", caption="звезда не отсканирована",
                                color="#555555", orbit_radius=0.0))

    # Планеты (без лун): у планеты родитель — звезда, у луны — планета.
    planets = [body for body in snapshot.bodies
               if body.kind not in (KIND_STAR, KIND_MOON)]
    distances = sorted({max(0.0, body.distance_ls) for body in planets})
    if distances:
        low = math.log10(max(0.05, distances[0]))
        high = math.log10(max(0.05, distances[-1]))
    else:
        low = high = 0.0
    span = max(1e-6, high - low)

    def ring_radius(distance_ls: float) -> float:
        inner = max_radius * 0.22
        if len(distances) <= 1:
            return max_radius * 0.6
        scale = (math.log10(max(0.05, distance_ls)) - low) / span
        return inner + (max_radius - inner) * max(0.0, min(1.0, scale))

    for index, body in enumerate(planets):
        orbit = ring_radius(body.distance_ls)
        angle = index * GOLDEN_ANGLE
        x = center_x + orbit * math.cos(angle)
        y = center_y + orbit * math.sin(angle)
        radius = max(4.0, min(14.0, 4.0 + math.log10(max(1.0, body.radius_m) / 1.0e6) * 2.0))
        items.append(PlacedItem(
            kind="body", x=x, y=y, radius=radius, label=body.name,
            caption=body.body_class or body.star_type, color=body_color(body),
            orbit_radius=orbit, ref=body, selected=(selected == body.name),
        ))
        positions[body.name] = (x, y)

    # Луны — рядом со своей планетой; если планеты на карте нет, ставим луну
    # на её собственное кольцо, чтобы тело не пропало.
    moons = sorted((body for body in snapshot.bodies if body.kind == KIND_MOON),
                   key=lambda body: (body.parent_name, body.distance_ls, body.name))
    if show_moons:
        for body in moons:
            siblings = [item for item in moons if item.parent_name == body.parent_name]
            index = siblings.index(body) if body in siblings else 0
            anchor = positions.get(body.parent_name)
            if anchor is None:
                orbit = ring_radius(body.distance_ls)
                angle = (len(planets) + index) * GOLDEN_ANGLE
                x = center_x + orbit * math.cos(angle)
                y = center_y + orbit * math.sin(angle)
            else:
                offset = 20.0 + 9.0 * index
                angle = -math.pi / 4 + index * 0.9
                x = anchor[0] + offset * math.cos(angle)
                y = anchor[1] + offset * math.sin(angle)
            x = max(14.0, min(width - 14.0, x))
            y = max(14.0, min(height - 14.0, y))
            items.append(PlacedItem(
                kind="body", x=x, y=y, radius=3.5, label=body.name,
                caption=body.body_class, color=body_color(body), orbit_radius=0.0,
                ref=body, selected=(selected == body.name),
            ))
            positions[body.name] = (x, y)

    # Станции и стройплощадки.
    floating_index = 0
    for station in snapshot.stations:
        anchor = positions.get(station.body_name) if station.body_name else None
        if anchor is None:
            # Тело неизвестно: выносим объект на внешнее кольцо, чтобы он не
            # потерялся (авианосцы и сигналы FSS часто без привязки к телу).
            angle = math.pi / 2 + floating_index * 0.55
            orbit = max_radius * 0.98
            x = center_x + orbit * math.cos(angle)
            y = center_y + orbit * math.sin(angle)
            floating_index += 1
        else:
            angle = math.pi / 3 + 0.7 * len([
                item for item in snapshot.stations if item.body_name == station.body_name])
            x = anchor[0] + 20.0 * math.cos(angle)
            y = anchor[1] + 20.0 * math.sin(angle)
        x = max(30.0, min(width - 30.0, x))
        y = max(26.0, min(height - 34.0, y))
        items.append(PlacedItem(
            kind="station", x=x, y=y,
            radius=7.0 if station.is_site else 5.0,
            label=station.title, caption=station.caption,
            color=station_color(station),
            progress=station.percent_delivered if station.is_site and not station.planned else None,
            ref=station,
            selected=(selected in (station.name, station.title, station.build_name,
                                   station.build_id)),
        ))

    # Отметка пилота — на том объекте, где он сейчас.
    player = snapshot.player
    anchor = None
    if player.docked and player.station_name:
        anchor = positions.get(player.station_name)
        if anchor is None:
            for item in items:
                if item.kind == "station" and isinstance(item.ref, MapStation) \
                        and item.ref.name == player.station_name:
                    anchor = (item.x, item.y)
                    break
    if anchor is None and player.body_name:
        anchor = positions.get(player.body_name)
    if anchor is None:
        anchor = (center_x, center_y - max_radius * 0.35)
    items.append(PlacedItem(
        kind="player", x=anchor[0], y=anchor[1], radius=12.0,
        label="Вы здесь", caption=player.place, color=PLAYER_COLOR, ref=player,
    ))
    _spread_labels(items, height)
    return items


def _rects_overlap(first, second, margin: float = 0.0) -> bool:
    return not (first[2] + margin < second[0] or second[2] + margin < first[0]
                or first[3] + margin < second[1] or second[3] + margin < first[1])


def _label_size(item: PlacedItem):
    """Ширина и высота блока подписи: текст, полоса прогресса, пояснение.

    Ширины считаем по тем шрифтам, которыми рисует вкладка (Consolas 8 для
    имени, 7 для пояснения): завышенная рамка заставляла бы расталкивание
    раздвигать подписи, которые на экране и не касались.
    """
    label_px = 4.9 * len(item.label or "")
    caption_px = 4.3 * len(item.caption or "")
    progress_px = (float(item.bar_width) + 42.0) if item.progress is not None else 0.0
    width = max(label_px, caption_px, progress_px) + 8.0
    height = 16.0
    if item.progress is not None:
        height += 14.0
    if item.caption:
        height += 12.0
    return max(30.0, width), height


def label_box(item: PlacedItem) -> Tuple[float, float, float, float]:
    """Прямоугольник, который займёт подпись объекта на холсте."""
    width, height = _label_size(item)
    extra = 22.0 if item.kind in ("star", "player") else 0.0
    top = item.y + item.radius + 4.0 + float(getattr(item, "label_dy", 0.0) or 0.0) - extra
    return (item.x - width / 2.0, top, item.x + width / 2.0, top + height)


def _icon_box(item: PlacedItem) -> Tuple[float, float, float, float]:
    """Значок объекта: подпись не должна ложиться поверх чужого значка."""
    if item.kind == "star":
        radius = max(6.0, item.radius) * 1.9
    elif item.kind == "station":
        radius = max(5.0, item.radius) + 3.0
    else:
        radius = max(3.0, item.radius)
    return (item.x - radius - 2.0, item.y - radius - 2.0,
            item.x + radius + 2.0, item.y + radius + 2.0)


def _spread_labels(items: List[PlacedItem], height: float) -> None:
    """Развести подписи, чтобы они не наезжали друг на друга.

    В плотных системах (несколько станций у одного тела) подписи иначе
    сливаются в кашу: каждая следующая пробует сдвинуться вниз/вверх, пока не
    найдёт свободное место. Порядок важен: сначала важное — стройплощадки и
    отметка пилота, потом тела.
    """
    order = {"station": 0, "player": 1, "star": 2, "body": 3}
    # Значки неподвижны: они — препятствия для подписей, включая свой
    # (своя подпись начинается ниже значка и с ним не пересекается).
    placed: List[Tuple[float, float, float, float]] = [_icon_box(item) for item in items]
    for item in sorted(items, key=lambda it: (order.get(it.kind, 9), it.y, it.x)):
        chosen = None
        # Шаги по 7 пикселей в обе стороны, от ближайших к дальним: в плотном
        # кластере (планета + две площадки + луна) свободная щель узкая.
        candidates = sorted(range(-112, 127, 7), key=lambda value: (abs(value), value))
        for dy in candidates:
            dy = float(dy)
            item.label_dy = dy
            box = label_box(item)
            if box[1] < 2.0 or box[3] > height - 2.0:
                continue
            if any(_rects_overlap(box, other, 2.0) for other in placed):
                continue
            chosen = box
            break
        if chosen is None:
            # Свободного места не нашлось: рисуем на месте, лучше внахлёст,
            # чем за границами холста.
            item.label_dy = 0.0
            chosen = label_box(item)
        placed.append(chosen)


def map_report(snapshot: MapSnapshot, app_version: str = "") -> str:
    """Многострочная сводка системы: её удобно кинуть в чат флот-крыла.

    В отличие от `map_summary` (одна строка состояния) здесь список строек с
    процентами и остатками по товарам, построенные объекты и где пилот.
    """
    if not snapshot.system:
        return "Система неизвестна — включите Watcher или загрузите журналы"
    head = snapshot.system
    if app_version:
        head += f" — карта системы (Colonial Helper {app_version})"
    lines = [head]
    scanned = len([body for body in snapshot.bodies if body.scanned])
    bodies_line = f"Тел: {len(snapshot.bodies)}"
    if snapshot.known_body_count:
        bodies_line += f" из {snapshot.known_body_count}"
    bodies_line += f", отсканировано {scanned}"
    lines.append(bodies_line)

    sites = [station for station in snapshot.sites if not station.complete]
    if sites:
        lines.append("Стройки:")
        for station in sites:
            percent = station.percent_delivered
            progress = f"{percent}%" if percent is not None else "процент неизвестен"
            if station.planned and percent is None:
                progress = "план"
            rest = f" (осталось {station.remaining_tons:,} t)".replace(",", " ")
            line = f"  {station.title} — {progress}{rest if station.remaining_tons else ''}"
            if station.remaining_by_commodity:
                top = sorted(station.remaining_by_commodity.items(),
                             key=lambda pair: pair[1], reverse=True)[:4]
                line += ": " + ", ".join(f"{name} {amount:,}".replace(",", " ")
                                          for name, amount in top)
            lines.append(line)
    done = [station for station in snapshot.sites if station.complete]
    built = [station for station in snapshot.built if not station.is_site]
    if done or built:
        names = [f"{station.title} (100%)" for station in done]
        names += [station.title for station in built]
        lines.append("Построено: " + ", ".join(names))
    player = snapshot.player
    ship = " ".join(part for part in (player.ship_name, player.ship_type) if part)
    lines.append(f"Пилот: {ship}, {player.place}" if ship else f"Пилот: {player.place}")
    return "\n".join(lines)


def map_summary(snapshot: MapSnapshot) -> str:
    """Одна строка состояния вкладки: система, тела, стройки, где пилот."""
    if not snapshot.system:
        return "Система неизвестна — включите Watcher или загрузите журналы"
    parts = [snapshot.system]
    bodies = len(snapshot.bodies)
    if snapshot.known_body_count and snapshot.known_body_count > bodies:
        parts.append(f"тел {bodies} из {snapshot.known_body_count}")
    elif bodies:
        parts.append(f"тел: {bodies}")
    else:
        parts.append("тела не отсканированы")
    building = [station for station in snapshot.sites if not station.complete]
    if building:
        details = []
        for station in building[:3]:
            percent = station.percent_delivered
            details.append(f"{station.title}" + (f" {percent}%" if percent is not None else ""))
        parts.append(f"строек: {len(building)} (" + ", ".join(details) + ")")
    built = len(snapshot.built)
    if built:
        parts.append(f"построенных объектов: {built}")
    parts.append(f"вы {snapshot.player.place}")
    return " · ".join(parts)
