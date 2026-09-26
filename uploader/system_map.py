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

import json
import math
import os
import time
from datetime import datetime, timezone
from dataclasses import dataclass, field
from pathlib import Path
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

#: Сигналы на телах (FSSBodySignals/SAASignalsFound). Ключи — те же, что у
#: сайта в `src/lib/bodySignals.ts`, чтобы карта в окне и карта на сайте
#: показывали одно и то же.
SIGNAL_ATTRIBUTES: Dict[str, str] = {
    "bio": "bio_signals",
    "geo": "geo_signals",
    "human": "human_signals",
    "thargoid": "thargoid_signals",
    "guardian": "guardian_signals",
    "other": "other_signals",
}


def classify_body_signal(signal_type: object) -> str:
    """Вид сигнала НА ТЕЛЕ по типу из журнала (ключ или его перевод).

    Не путать с `classify_signal` ниже: та разбирает сигналы системы
    (станции, точки интереса), а эта — находки сканера на поверхности.
    """
    value = str(signal_type or "").lower()
    if "biolog" in value or "биолог" in value:
        return "bio"
    if "geolog" in value or "геолог" in value:
        return "geo"
    if "thargoid" in value or "таргоид" in value:
        return "thargoid"
    if "guardian" in value or "страж" in value:
        return "guardian"
    if "human" in value or "человеч" in value or "люд" in value:
        return "human"
    return "other"


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

#: Тела Raven v2, которые на карту не попадают: барицентры и пояса астероидов.
#: Это служебные записи (`"type": "bc"`, `"ac"`), а не то, что видит пилот.
RAVEN_SKIP_BODY_TYPES = {"bc", "ac"}
#: Код звезды в `type` ответа Raven v2.
RAVEN_STAR_TYPE = "st"

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
    "ShipyardBuy", "ShipyardSwap", "SAASignalsFound", "FSSBodySignals",
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
    due_at: str = ""                        # дедлайн проекта Raven (timeDue)
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
    orbit_ls: float = 0.0        # большая полуось: у лун — вокруг планеты
    radius_m: float = 0.0
    parent_ids: List[int] = field(default_factory=list)
    parent_name: str = ""
    landable: bool = False
    scanned: bool = False
    mapped: bool = False
    terraformable: bool = False
    atmosphere: str = ""
    gravity: float = 0.0
    surface_temp_k: float = 0.0
    bio_signals: int = 0
    # Остальные сигналы тела: геология, следы людей, стражи, таргоиды и
    # прочее. Раньше журнал разбирался только на биологию, и карта не могла
    # показать, что рядом с будущей стройкой уже кто-то есть.
    geo_signals: int = 0
    human_signals: int = 0
    thargoid_signals: int = 0
    guardian_signals: int = 0
    other_signals: int = 0
    bio_genuses: List[str] = field(default_factory=list)
    first_discovered_by: str = ""
    first_mapped_by: str = ""
    first_footfall_by: str = ""
    semi_major_axis_ls: float = 0.0
    eccentricity: float = 0.0
    orbital_inclination: float = 0.0
    arg_of_periapsis: float = 0.0
    # Полный набор элементов нужен карте: по эксцентриситету, наклонению и
    # аргументу перицентра строится настоящий эллипс, по средней аномалии —
    # положение тела на нём, по периоду — подпись в подсказке.
    orbital_period_days: float = 0.0
    mean_anomaly_deg: float = 0.0
    axial_tilt_deg: float = 0.0
    rings: List[Dict[str, Any]] = field(default_factory=list)
    from_raven: bool = False              # тело из Raven v2, журнал его не видел
    from_external: bool = False           # тело из EDSM / базы проекта
    source: str = "journal"
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

    def find_body(self, system: str, name: str) -> Optional[MapBody]:
        """Найти тело в системе без автоматического создания нового объекта."""
        return self._bodies.get(system, {}).get(name)

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
        semi_major_m = _as_float(event.get("SemiMajorAxis"), 0.0)
        if semi_major_m > 0:
            # У планет полуось почти равна дистанции от звезды, у лун — это
            # радиус орбиты вокруг планеты: из него строим кольцо луны.
            body.orbit_ls = semi_major_m / METERS_PER_LS
        body.radius_m = _as_float(event.get("Radius"), body.radius_m)
        if "Landable" in event:
            body.landable = bool(event.get("Landable"))
        if "Atmosphere" in event or "AtmosphereType" in event:
            body.atmosphere = str(event.get("Atmosphere") or event.get("AtmosphereType") or "")
        if "SurfaceGravity" in event:
            body.gravity = _as_float(event.get("SurfaceGravity"), 0.0) / 9.80665
        elif "Gravity" in event:
            body.gravity = _as_float(event.get("Gravity"), 0.0)
        if "SurfaceTemperature" in event:
            body.surface_temp_k = _as_float(event.get("SurfaceTemperature"), 0.0)
        if "Eccentricity" in event:
            body.eccentricity = _as_float(event.get("Eccentricity"), 0.0)
        if "OrbitalInclination" in event:
            body.orbital_inclination = _as_float(event.get("OrbitalInclination"), 0.0)
        if "Periapsis" in event:
            body.arg_of_periapsis = _as_float(event.get("Periapsis"), 0.0)
        if "OrbitalPeriod" in event:
            # Журнал отдаёт период в секундах.
            body.orbital_period_days = _as_float(event.get("OrbitalPeriod"), 0.0) / 86400.0
        if "MeanAnomaly" in event:
            body.mean_anomaly_deg = _as_float(event.get("MeanAnomaly"), 0.0)
        if "AxialTilt" in event:
            body.axial_tilt_deg = _as_float(event.get("AxialTilt"), 0.0)
        if "Rings" in event and isinstance(event.get("Rings"), list):
            body.rings = [r for r in event["Rings"] if isinstance(r, dict)]
        if event.get("WasDiscovered") is False:
            body.first_discovered_by = "Вы"
        elif not body.first_discovered_by and event.get("WasDiscovered"):
            body.first_discovered_by = "Другой пилот"
        if event.get("WasMapped") is False:
            body.first_mapped_by = "Вы"
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
        if event.get("WasMapped") is False:
            body.first_mapped_by = "Вы"
        body.updated_at = str(event.get("timestamp") or body.updated_at)
        return True

    def _on_saasignalsfound(self, event: dict) -> bool:
        system = self.player.system or self.current_system
        name = str(event.get("BodyName") or "").strip()
        if not system or not name:
            return False
        body = self._body(system, name)
        for sig in event.get("Signals") or []:
            if not isinstance(sig, dict):
                continue
            kind = classify_body_signal(f"{sig.get('Type') or ''} {sig.get('Type_Localised') or ''}")
            count = _as_int(sig.get("Count"), 0)
            attribute = SIGNAL_ATTRIBUTES[kind]
            setattr(body, attribute, max(getattr(body, attribute, 0), count))
        genuses = [str(g.get("Genus_Localised") or g.get("Genus") or "")
                   for g in (event.get("Genuses") or []) if isinstance(g, dict)]
        if genuses:
            body.bio_genuses = genuses
        return True

    def _on_fssbodysignals(self, event: dict) -> bool:
        return self._on_saasignalsfound(event)

    def load_external_bodies(self, bodies: list, source: str = "edsm") -> bool:
        """Подгрузить тела системы из внешнего источника (EDSM или БД проекта).

        Позволяет показать полную структуру системы, даже если локальный игрок
        ещё не просканировал все планеты сам.
        """
        system = self.player.system or self.current_system
        if not system or not isinstance(bodies, list) or not bodies:
            return False

        changed = False
        existing = self._bodies.get(system, {})

        for entry in bodies:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("body_name") or entry.get("name") or "").strip()
            if not name:
                continue

            body = self._body(system, name)

            # Если тело уже было полноценно отсканировано в журнале — не затираем
            if body.scanned and not body.from_external:
                # Только дополняем биосигналами / первооткрывателем при их отсутствии
                if (not body.first_discovered_by or body.first_discovered_by == "Другой пилот") and entry.get("first_discovered_by"):
                    body.first_discovered_by = str(entry.get("first_discovered_by"))
                if not body.first_mapped_by and entry.get("first_mapped_by"):
                    body.first_mapped_by = str(entry.get("first_mapped_by"))
                continue

            b_type = str(entry.get("body_type") or entry.get("type") or "").strip().lower()
            sub_type = str(entry.get("sub_type") or entry.get("subType") or entry.get("planet_class") or "").strip()

            if "star" in b_type or (sub_type and "star" in sub_type.lower()):
                body.kind = KIND_STAR
                body.star_type = sub_type or body.star_type or "Star"
            else:
                parents = entry.get("parents") or []
                moon = any(isinstance(p, dict) and "Planet" in p for p in parents) if isinstance(parents, list) else False
                body.kind = KIND_MOON if moon else KIND_PLANET

            if sub_type:
                body.body_class = sub_type
            dist = _as_float(entry.get("distance_ls") or entry.get("distanceToArrival"), 0.0)
            if dist > 0 or not body.distance_ls:
                body.distance_ls = dist

            semi_major = _as_float(entry.get("semiMajorAxis") or entry.get("semi_major_axis_ls"), 0.0)
            if semi_major > 0:
                body.orbit_ls = semi_major if semi_major < 1e10 else (semi_major / METERS_PER_LS)

            rad = _as_float(entry.get("radius_m") or entry.get("radius"), 0.0)
            if rad > 0:
                body.radius_m = rad if rad > 1e4 else (rad * 1000.0)

            if "is_landable" in entry or "isLandable" in entry or "landable" in entry:
                body.landable = bool(entry.get("is_landable") or entry.get("isLandable") or entry.get("landable"))

            body.atmosphere = str(entry.get("atmosphere") or entry.get("atmosphereType") or body.atmosphere or "")
            body.gravity = _as_float(entry.get("gravity"), body.gravity)
            body.surface_temp_k = _as_float(entry.get("surface_temp_k") or entry.get("surfaceTemperature"), body.surface_temp_k)
            body.first_discovered_by = str(entry.get("first_discovered_by") or body.first_discovered_by or "")
            body.first_mapped_by = str(entry.get("first_mapped_by") or body.first_mapped_by or "")
            body.first_footfall_by = str(entry.get("first_footfall_by") or body.first_footfall_by or "")
            body.bio_signals = _as_int(entry.get("bio_signals_count") or entry.get("bio_signals"), body.bio_signals)
            for kind, attribute in SIGNAL_ATTRIBUTES.items():
                if kind == "bio":
                    continue
                body_value = getattr(body, attribute, 0)
                setattr(body, attribute, _as_int(
                    entry.get(f"{kind}_signals_count") or entry.get(f"{kind}_signals"), body_value))
            if "rings" in entry and isinstance(entry["rings"], list):
                body.rings = [r for r in entry["rings"] if isinstance(r, dict)]
            body.source = source
            body.from_external = True
            body.scanned = True
            changed = True

        if len(bodies) > self.known_body_counts.get(system, 0):
            self.known_body_counts[system] = len(bodies)

        self._resolve_parents(system)
        return changed

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
        """body_id -> имя родителя: луны рисуются рядом со своей планетой.

        Проходов несколько: родитель сам может оказаться луной (суб-луны вроде
        «HIP 22460 13 e a»), а порядок тел не гарантирован ни журналом, ни
        Raven v2. `body_id == 0` допустим — так Raven нумерует звезду.
        """
        bodies = self._bodies.get(system, {})
        by_id = {body.body_id: body for body in bodies.values()
                 if body.body_id is not None}
        for _attempt in range(3):
            changed = False
            for body in bodies.values():
                if not body.parent_ids:
                    continue
                parent = None
                for parent_id in body.parent_ids:
                    candidate = by_id.get(parent_id)
                    if candidate is not None and candidate is not body:
                        parent = candidate
                        break
                if parent is None:
                    continue
                if not body.parent_name and parent.name:
                    body.parent_name = parent.name
                    changed = True
                if body.kind == KIND_STAR or parent.kind == KIND_UNKNOWN:
                    continue
                # планету, чей родитель — планета или луна, показываем луной
                wanted = (KIND_MOON if parent.kind in (KIND_PLANET, KIND_MOON)
                          else KIND_PLANET)
                if body.kind != wanted:
                    body.kind = wanted
                    changed = True
            if not changed:
                break

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
        wanted = int(body_num or 0)
        if not wanted:
            # Иначе стройка с неизвестным BodyNum «прилипнет» к звезде Raven (num 0).
            return ""
        for body in self._bodies.get(system, {}).values():
            if body.body_id == wanted:
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
            due = str(project.get("timeDue") or "").strip()
            if due and station.due_at != due:
                station.due_at = due
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
    def _raven_radius_m(value) -> float:
        """Радиус тела в метрах: Raven v2 отдаёт километры и -1 вместо «не знаю».

        Журнальный `Radius` приходит сразу в метрах, поэтому различаем единицы
        по порядку величины: больше 250 000 км тел не бывает.
        """
        number = _as_float(value, 0.0)
        if number <= 0:
            return 0.0
        return number if number > 250000.0 else number * 1000.0

    @classmethod
    def _raven_body_fields(cls, raw: dict) -> dict:
        """Поля тела из ответа Raven v2 (`GET /api/v2/system/{system}`).

        Реальный ответ выглядит так (проверено на HIP 22460)::

            {"name": "HIP 22460 1", "num": 5, "distLS": 45.87, "parents": [0],
             "type": "hmc", "subType": "High metal content world",
             "features": ["landable", "geo", "rings"], "radius": 9284.4,
             "temp": 967.0, "gravity": 1.18}

        то есть `num` вместо BodyID, `distLS` вместо DistanceFromArrivalLS,
        класс — в `subType` (а `type` — короткий код), посадка — в `features`,
        радиус — в километрах. Звезда приходит с `"type": "st"` и `num: 0`.
        Журнальные варианты ключей тоже понимаем: вдруг ответ изменится.
        """
        def pick(*keys):
            for key in keys:
                if key in raw and raw[key] not in (None, ""):
                    return raw[key]
            return None

        name = str(pick("name", "Name", "bodyName", "BodyName") or "").strip()
        code = str(pick("type", "Type") or "").strip().lower()
        sub_type = str(pick("subType", "SubType", "planetClass", "PlanetClass",
                            "bodyClass") or "").strip()
        star_type = str(pick("starType", "StarType") or "").strip()
        is_star = code == RAVEN_STAR_TYPE or bool(star_type)
        if is_star and not star_type and sub_type:
            # "F (White) Star" -> "F": подпись звезды короткая.
            star_type = sub_type.split(" ", 1)[0]
        # Короткие коды v2 ("hmc", "gg", "rb") — не название класса, их не показываем.
        body_class = "" if is_star else sub_type
        if body_class and len(body_class) <= 4 and " " not in body_class:
            body_class = ""

        features = pick("features", "Features")
        feature_set = {str(item).strip().lower() for item in features} \
            if isinstance(features, list) else set()
        if feature_set:
            landable = "landable" in feature_set
        else:
            value = pick("isLandable", "Landable", "landable")
            landable = bool(value) if isinstance(value, bool) else None

        parents = pick("parents", "Parents")
        parent_ids: List[int] = []
        if isinstance(parents, list):
            for entry in parents:
                if isinstance(entry, dict):
                    # Журнальная форма: [{"Planet": 4}] или [{"Star": 1}].
                    parent_ids.extend(_as_int(value, 0) for value in entry.values()
                                      if _as_int(value, 0))
                else:
                    # Raven v2: [прямой родитель, ..., звезда]; звезда бывает с num 0.
                    parent_id = _as_int(entry, None)
                    if parent_id is not None:
                        parent_ids.append(parent_id)

        # `num: 0` у звезды Raven — валидный идентификатор, поэтому None отличаем от 0.
        raw_id = pick("num", "bodyId", "BodyID")
        return {
            "name": name,
            "body_id": None if raw_id is None else _as_int(raw_id, 0),
            "is_star": is_star,
            "star_type": star_type,
            "body_class": body_class,
            "distance_ls": _as_float(pick("distLS", "distanceToArrival",
                                          "distanceFromArrivalLS",
                                          "DistanceFromArrivalLS", "distanceLS",
                                          "distance"), 0.0),
            "radius_m": cls._raven_radius_m(pick("radius", "Radius", "radiusKM",
                                                 "radiusM")),
            "landable": landable,
            "terraformable": ("terraformable" in feature_set
                              or "terraformable" in sub_type.lower()),
            "parent_ids": parent_ids,
            # Барицентры и пояса — служебные записи, на карту их не несём.
            "skip": bool(code in RAVEN_SKIP_BODY_TYPES
                         or "barycentre" in name.lower()),
        }

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
            if not name or fields["skip"]:
                continue
            body = self._bodies.get(system, {}).get(name)
            if body is None:
                if len(self._bodies.get(system, {})) >= MAX_BODIES_PER_SYSTEM:
                    continue
                body = self._body(system, name)
                body.from_raven = True
                changed = True
            for key, value in (
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
            # `num == 0` у звезды Raven — валидный идентификатор, поэтому None.
            if fields["body_id"] is not None and body.body_id is None:
                body.body_id = fields["body_id"]
                changed = True
            if fields["landable"] is not None and not body.scanned:
                if body.landable != fields["landable"]:
                    body.landable = fields["landable"]
                    changed = True
            if fields["terraformable"] and not body.terraformable:
                body.terraformable = True
                changed = True
            if fields["parent_ids"] and not body.parent_ids:
                body.parent_ids = fields["parent_ids"]
                changed = True
            if body.kind == KIND_UNKNOWN:
                # Луну из планеты сделает _resolve_parents: у Raven parents есть
                # и у планет ([звезда]), поэтому по наличию родителей не угадать.
                body.kind = KIND_STAR if fields["is_star"] else KIND_PLANET
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
    orbit_cx: Optional[float] = None  # центр кольца: None — центр карты (звезда)
    orbit_cy: Optional[float] = None
    label_dy: float = 0.0           # сдвиг подписи: расталкивание наложений
    pan_x: float = 0.0              # панорама всей карты (центр не на звезде)
    pan_y: float = 0.0
    ref: object = None
    selected: bool = False
    depth: float = 0.0              # глубина z (для сортировки в 3D)
    plane_x: float = 0.0            # проекция на базовую плоскость орбиты
    plane_y: float = 0.0
    orbit_a: float = 0.0            # большая полуось эллипса (3D Orrery)
    orbit_b: float = 0.0            # малая полуось эллипса (3D Orrery)
    orbit_tilt: float = 0.0         # наклон орбиты
    distance_ls: float = 0.0        # дистанция в LS
    landable: bool = False
    bio_signals: int = 0
    first_discovered_by: str = ""
    orbit_color: str = ""           # цвет кольца: у планет — по своей звезде
    zone_inner: float = 0.0         # внутренняя граница обитаемой зоны, px
    zone_outer: float = 0.0         # внешняя граница обитаемой зоны, px
    zone_ls: Tuple[float, float] = (0.0, 0.0)   # те же границы в световых секундах

    @property
    def bar_width(self) -> int:
        return 46


#: Цвета орбит по номеру звезды: в двойной системе сразу видно, чьи это тела.
ORBIT_PALETTE = ("#4a7fb5", "#b58a4a", "#5fa87a", "#a86fa8", "#b55a5a", "#5aa8b5")


def orbit_color_for(index: int) -> str:
    """Цвет орбиты кластера: у каждой звезды свой оттенок."""
    if index <= 0:
        return ORBIT_PALETTE[0]
    return ORBIT_PALETTE[index % len(ORBIT_PALETTE)]


#: Цвет полосы обитаемой зоны (совпадает с сайтом и со сценой в окне).
ZONE_COLOR = "#2ecc71"


def habitable_zone_ls(body: Any) -> Tuple[float, float]:
    """Обитаемая зона звезды в световых секундах.

    Формула та же, что в `orrery.habitable_zone_ls` (0.75–1.77 а.е. × √L):
    сводка, холст приложения и 3D-карта обязаны показывать одну зону.
    """
    if body is None or getattr(body, "kind", "") != KIND_STAR:
        return (0.0, 0.0)
    radius_m = _as_float(getattr(body, "radius_m", 0.0), 0.0)
    temp_k = _as_float(getattr(body, "surface_temp_k", 0.0), 0.0)
    radius_sol = radius_m / 6.957e8 if radius_m > 0 else 1.0
    temp_sol = temp_k / 5778.0 if temp_k > 0 else 1.0
    luminosity = max(1e-4, radius_sol * radius_sol * temp_sol ** 4)
    sqrt_l = math.sqrt(luminosity)
    inner = 0.75 * sqrt_l * 499.00478
    outer = max(inner + 5.0, 1.77 * sqrt_l * 499.00478)
    return (inner, outer)


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

#: Типы объектов, которые стоят НА ПОВЕРХНОСТИ тела (а не летают вокруг него).
#: До этого все станции рисовались на фиксированном кольце в 20–22 px от центра
#: планеты — для наземного поселения это выглядело как «постройка в космосе».
GROUND_STATION_KINDS = frozenset({
    STATION_SITE, STATION_PRIMARY_PORT, STATION_SETTLEMENT, STATION_INSTALLATION,
})

#: Насколько наземный маркер отстоит от видимого края тела (px) и с каким шагом
#: расходятся несколько построек одного тела.
GROUND_LIFT_PX = 4.0
GROUND_STEP_PX = 1.6
#: Орбитальные объекты (порты, аванпосты, авианосцы) — чуть дальше от лимба.
ORBIT_LIFT_PX = 15.0
ORBIT_STEP_PX = 4.0

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
METERS_PER_LS = 299792458.0   # журнал даёт SemiMajorAxis в метрах


def _find_center_item(items: List[PlacedItem], center_on: str):
    """Объект, на который просили отцентровать: тело по имени, станция по id."""
    wanted = str(center_on or "").strip()
    if not wanted:
        return None
    for item in items:
        ref = item.ref
        if isinstance(ref, MapStation):
            if wanted in (str(ref.build_id or ""), str(ref.name or ""),
                          str(ref.title or ""), str(item.label or "")):
                return item
        elif str(item.label or "") == wanted:
            return item
    return None


def _layout_3d(snapshot: MapSnapshot, width: int, height: int, zoom: float = 1.0,
               show_moons: bool = True, selected: str = "",
               center_on: str = "", pitch_deg: float = 38.0,
               yaw_deg: float = -20.0) -> List[PlacedItem]:
    """Разложить снимок системы в 3D Orrery (аксонометрическая проекция)."""
    width = max(80, int(width or 0))
    height = max(80, int(height or 0))
    zoom = max(0.4, min(4.0, _as_float(zoom, 1.0) or 1.0))
    center_x = width / 2.0
    center_y = height / 2.0
    max_radius = max(30.0, min(center_x, center_y) - 46.0) * zoom

    pitch = math.radians(max(10.0, min(85.0, _as_float(pitch_deg, 38.0))))
    yaw = math.radians(_as_float(yaw_deg, -20.0))
    sin_p, cos_p = math.sin(pitch), math.cos(pitch)
    sin_y, cos_y = math.sin(yaw), math.cos(yaw)

    items: List[PlacedItem] = []
    positions: Dict[str, Tuple[float, float, float]] = {}
    body_radius: Dict[str, float] = {}

    star = snapshot.star
    if star is not None:
        star_radius = max(10.0, min(24.0, 10.0 + math.log10(max(1.0, star.radius_m) / 1.0e8) * 3.0))
        items.append(PlacedItem(
            kind="star", x=center_x, y=center_y, radius=star_radius,
            label=star.name, caption=star.body_class or star.star_type,
            color=BODY_COLORS["star"], orbit_radius=0.0, ref=star,
            selected=(selected == star.name),
            depth=0.0, plane_x=center_x, plane_y=center_y,
            distance_ls=0.0,
        ))
        positions[star.name] = (center_x, center_y, 0.0)
    else:
        items.append(PlacedItem(
            kind="star", x=center_x, y=center_y, radius=5.0,
            label="", caption="звезда не отсканирована",
            color="#555555", orbit_radius=0.0,
            depth=0.0, plane_x=center_x, plane_y=center_y,
        ))

    planets = [body for body in snapshot.bodies if body.kind not in (KIND_STAR, KIND_MOON)]
    by_name = {body.name: body for body in snapshot.bodies}
    stars = [body for body in snapshot.bodies if body.kind == KIND_STAR]
    second_stars = [body for body in stars if star is not None and body.name != star.name]

    def orbit_of(body) -> float:
        if body.orbit_ls > 0:
            return body.orbit_ls
        if body.kind == KIND_MOON:
            parent = by_name.get(body.parent_name or "")
            if parent is not None and parent.distance_ls > 0:
                return max(1e-4, abs(body.distance_ls - parent.distance_ls))
            return 1e-4
        return max(0.0, body.distance_ls)

    # Границы обитаемых зон входят в шкалу колец: иначе полоса зоны сжалась бы
    # в пару пикселей (кольца логарифмические) и её не было бы видно.
    zone_bounds = [bound for body in stars for bound in habitable_zone_ls(body) if bound > 0]
    distances = sorted({orbit_of(body) for body in planets}
                       | {orbit_of(body) for body in second_stars}
                       | set(zone_bounds))
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

    def moon_ring_px(body, siblings) -> float:
        inner, outer = 16.0, 36.0
        orbits = [math.log10(max(1e-4, orbit_of(item))) for item in siblings]
        if len(orbits) < 2:
            return (inner + outer) / 2.0
        low_m, high_m = min(orbits), max(orbits)
        span_m = high_m - low_m
        if span_m <= 1e-9:
            return (inner + outer) / 2.0
        scale = (math.log10(max(1e-4, orbit_of(body))) - low_m) / span_m
        return inner + (outer - inner) * max(0.0, min(1.0, scale))

    # Вторые звёзды
    for index, body in enumerate(second_stars):
        orbit_r = ring_radius(orbit_of(body))
        angle = math.pi / 3.0 + index * GOLDEN_ANGLE
        xw = orbit_r * math.cos(angle)
        zw = orbit_r * math.sin(angle)
        yw = 0.0
        xr = xw * cos_y - zw * sin_y
        zr = xw * sin_y + zw * cos_y
        sx = center_x + xr
        sy = center_y - (yw * cos_p - zr * sin_p)
        px = center_x + xr
        py = center_y + zr * sin_p
        depth = zr * cos_p + yw * sin_p
        radius = max(9.0, min(22.0, 9.0 + math.log10(max(1.0, body.radius_m) / 1.0e8) * 3.0))

        items.append(PlacedItem(
            kind="star", x=sx, y=sy, radius=radius, label=body.name,
            caption=body.body_class or body.star_type, color=BODY_COLORS["star"],
            orbit_radius=orbit_r, orbit_cx=center_x, orbit_cy=center_y,
            orbit_a=orbit_r, orbit_b=orbit_r * sin_p,
            plane_x=px, plane_y=py, depth=depth,
            distance_ls=body.distance_ls,
            ref=body, selected=(selected == body.name),
        ))
        positions[body.name] = (sx, sy, depth)
        body_radius[body.name] = radius

    # Планеты
    for index, body in enumerate(planets):
        orbit_r = ring_radius(orbit_of(body))
        angle = index * GOLDEN_ANGLE
        xw = orbit_r * math.cos(angle)
        zw = orbit_r * math.sin(angle)
        yw = math.sin(angle * 2.0) * 16.0 if abs(body.orbital_inclination) < 1e-3 else (body.orbital_inclination * 4.0)
        xr = xw * cos_y - zw * sin_y
        zr = xw * sin_y + zw * cos_y
        sx = center_x + xr
        sy = center_y - (yw * cos_p - zr * sin_p)
        px = center_x + xr
        py = center_y + zr * sin_p
        depth = zr * cos_p + yw * sin_p
        radius = max(4.5, min(15.0, 4.5 + math.log10(max(1.0, body.radius_m) / 1.0e6) * 2.0))

        star_index = next((position for position, star_body in enumerate(stars)
                           if star_body.name == (body.parent_name or "")), 0)
        items.append(PlacedItem(
            kind="body", x=sx, y=sy, radius=radius, label=body.name,
            caption=body.body_class or body.star_type, color=body_color(body),
            orbit_radius=orbit_r, orbit_cx=center_x, orbit_cy=center_y,
            orbit_a=orbit_r, orbit_b=orbit_r * sin_p,
            orbit_color=orbit_color_for(star_index),
            plane_x=px, plane_y=py, depth=depth,
            distance_ls=body.distance_ls, landable=body.landable,
            bio_signals=body.bio_signals, first_discovered_by=body.first_discovered_by,
            ref=body, selected=(selected == body.name),
        ))
        positions[body.name] = (sx, sy, depth)
        body_radius[body.name] = radius

    # Луны
    moons = sorted((body for body in snapshot.bodies if body.kind == KIND_MOON),
                   key=lambda b: (b.parent_name, orbit_of(b), b.name))
    if show_moons:
        for body in moons:
            siblings = [item for item in moons if item.parent_name == body.parent_name]
            index = siblings.index(body) if body in siblings else 0
            anchor = positions.get(body.parent_name)
            if anchor is None:
                orbit_r = ring_radius(body.distance_ls)
                angle = (len(planets) + index) * GOLDEN_ANGLE
                xw = orbit_r * math.cos(angle)
                zw = orbit_r * math.sin(angle)
                yw = 0.0
                xr = xw * cos_y - zw * sin_y
                zr = xw * sin_y + zw * cos_y
                sx = center_x + xr
                sy = center_y + zr * sin_p
                px, py = sx, sy
                depth = zr * cos_p
                oa, ob = orbit_r, orbit_r * sin_p
                ocx, ocy = center_x, center_y
            else:
                ring_px = moon_ring_px(body, siblings)
                angle = index * GOLDEN_ANGLE
                sx = anchor[0] + ring_px * math.cos(angle)
                sy = anchor[1] + ring_px * sin_p * math.sin(angle)
                px, py = sx, sy
                depth = anchor[2] + 0.1
                oa, ob = ring_px, ring_px * sin_p
                ocx, ocy = anchor[0], anchor[1]

            items.append(PlacedItem(
                kind="body", x=sx, y=sy, radius=3.5, label=body.name,
                caption=body.body_class, color=body_color(body),
                orbit_radius=oa, orbit_cx=ocx, orbit_cy=ocy,
                orbit_a=oa, orbit_b=ob, plane_x=px, plane_y=py, depth=depth,
                distance_ls=body.distance_ls, landable=body.landable,
                bio_signals=body.bio_signals, first_discovered_by=body.first_discovered_by,
                ref=body, selected=(selected == body.name),
            ))
            positions[body.name] = (sx, sy, depth)

    # Обитаемые зоны: в 3D кольцо проецируется в эллипс, как и орбиты.
    for body in stars:
        zone_ls = habitable_zone_ls(body)
        if zone_ls[0] <= 0:
            continue
        anchor = positions.get(body.name, (center_x, center_y, 0.0))
        inner_px = ring_radius(zone_ls[0])
        outer_px = max(inner_px + 6.0, ring_radius(zone_ls[1]))
        items.append(PlacedItem(
            kind="zone", x=anchor[0], y=anchor[1], radius=0.0,
            label="", caption="", color=ZONE_COLOR,
            orbit_cx=anchor[0], orbit_cy=anchor[1],
            zone_inner=inner_px, zone_outer=outer_px, zone_ls=zone_ls,
            plane_x=anchor[0], plane_y=anchor[1], depth=-1.0,
            ref=body,
        ))

    # Станции и стройплощадки
    floating_index = 0
    for station in snapshot.stations:
        anchor = positions.get(station.body_name) if station.body_name else None
        if anchor is None:
            angle = math.pi / 2.0 + floating_index * 0.55
            orbit_r = max_radius * 0.98
            xw = orbit_r * math.cos(angle)
            zw = orbit_r * math.sin(angle)
            xr = xw * cos_y - zw * sin_y
            zr = xw * sin_y + zw * cos_y
            sx = center_x + xr
            sy = center_y + zr * sin_p
            depth = zr * cos_p
            floating_index += 1
        else:
            siblings = [item for item in snapshot.stations if item.body_name == station.body_name]
            index = siblings.index(station) if station in siblings else 0
            angle = math.pi / 2.0 + (2.0 * math.pi * index / max(1, len(siblings)))
            lift = _station_lift_px(station, body_radius.get(station.body_name or "", 5.0))
            sx = anchor[0] + lift * math.cos(angle) * 0.55
            sy = anchor[1] - lift * sin_p * math.sin(angle)
            depth = anchor[2] + 0.2

        items.append(PlacedItem(
            kind="station", x=sx, y=sy,
            radius=7.0 if station.is_site else 5.0,
            label=station.title, caption=station.caption,
            color=station_color(station),
            progress=station.percent_delivered if station.is_site and not station.planned else None,
            depth=depth, plane_x=sx, plane_y=sy,
            ref=station,
            selected=(selected in (station.name, station.title, station.build_name, station.build_id)),
        ))

    # Отметка пилота
    player = snapshot.player
    anchor = None
    if player.docked and player.station_name:
        anchor = positions.get(player.station_name)
        if anchor is None:
            for item in items:
                if item.kind == "station" and isinstance(item.ref, MapStation) and item.ref.name == player.station_name:
                    anchor = (item.x, item.y, item.depth)
                    break
    if anchor is None and player.body_name:
        anchor = positions.get(player.body_name)
    if anchor is None:
        anchor = (center_x, center_y - max_radius * 0.35, 0.0)

    items.append(PlacedItem(
        kind="player", x=anchor[0], y=anchor[1], radius=12.0,
        label="Вы здесь", caption=player.place, color=PLAYER_COLOR, ref=player,
        depth=anchor[2] + 0.5, plane_x=anchor[0], plane_y=anchor[1],
    ))

    if center_on:
        anchor_item = _find_center_item(items, center_on)
        if anchor_item is not None:
            dx = center_x - anchor_item.x
            dy = center_y - anchor_item.y
            for item in items:
                item.x += dx
                item.y += dy
                item.plane_x += dx
                item.plane_y += dy
                if item.orbit_cx is not None:
                    item.orbit_cx += dx
                if item.orbit_cy is not None:
                    item.orbit_cy += dy
                item.pan_x = dx
                item.pan_y = dy

    _spread_labels(items, height)
    return items


def _station_lift_px(station: "MapStation", body_radius_px: float) -> float:
    """Насколько от центра тела отрисовать маркер станции, px.

    Наземные постройки — на видимом крае тела (радиус тела + пара пикселей),
    орбитальные — кольцом чуть дальше. Так «поселение на поверхности» больше не
    выглядит как объект, висящий в пустоте рядом с планетой.
    """
    base = max(3.0, float(body_radius_px or 0.0))
    if getattr(station, "kind", "") in GROUND_STATION_KINDS:
        return base + GROUND_LIFT_PX
    return base + ORBIT_LIFT_PX


def layout(snapshot: MapSnapshot, width: int, height: int, zoom: float = 1.0,
           show_moons: bool = True, selected: str = "",
           center_on: str = "", mode: str = "2d",
           pitch_deg: float = 38.0, yaw_deg: float = -20.0) -> List[PlacedItem]:
    """Разложить снимок системы по координатам холста.

    Поддерживает два режима:
    * "2d" — классическая плоская схема с круговыми орбитами;
    * "3d" — 3D Orrery с перспективой, наклоном плоскости орбит и дроп-линиями.
    """
    if str(mode or "").lower() == "3d":
        return _layout_3d(snapshot, width, height, zoom=zoom,
                          show_moons=show_moons, selected=selected,
                          center_on=center_on, pitch_deg=pitch_deg,
                          yaw_deg=yaw_deg)

    width = max(80, int(width or 0))
    height = max(80, int(height or 0))
    zoom = max(0.4, min(4.0, _as_float(zoom, 1.0) or 1.0))
    center_x = width / 2.0
    center_y = height / 2.0
    max_radius = max(30.0, min(center_x, center_y) - 46.0) * zoom

    items: List[PlacedItem] = []
    positions: Dict[str, Tuple[float, float]] = {}
    #: Видимый радиус тела в px — по нему сажаем наземные постройки на лимб.
    body_radius: Dict[str, float] = {}

    star = snapshot.star
    if star is not None:
        star_radius = max(9.0, min(22.0, 9.0 + math.log10(max(1.0, star.radius_m) / 1.0e8) * 3.0))
        items.append(PlacedItem(
            kind="star", x=center_x, y=center_y, radius=star_radius,
            label=star.name, caption=star.body_class or star.star_type,
            color=BODY_COLORS["star"], orbit_radius=0.0, ref=star,
            selected=(selected == star.name),
            plane_x=center_x, plane_y=center_y, distance_ls=0.0,
        ))
        positions[star.name] = (center_x, center_y)
        body_radius[star.name] = star_radius
    else:
        items.append(PlacedItem(kind="star", x=center_x, y=center_y, radius=4.0,
                                label="", caption="звезда не отсканирована",
                                color="#555555", orbit_radius=0.0,
                                plane_x=center_x, plane_y=center_y))

    # Планеты (без лун): у планеты родитель — звезда, у луны — планета.
    planets = [body for body in snapshot.bodies
               if body.kind not in (KIND_STAR, KIND_MOON)]
    by_name = {body.name: body for body in snapshot.bodies}
    stars = [body for body in snapshot.bodies if body.kind == KIND_STAR]
    second_stars = [body for body in stars if star is not None
                    and body.name != star.name]

    def orbit_of(body) -> float:
        """Большая полуось тела в LS: журнал, иначе оценка по Raven v2.

        Raven v2 полуосей не даёт, только дистанцию от точки прибытия, поэтому
        для лун берём |distLS луны − distLS планеты| (проекция радиуса орбиты),
        для планет и звёзд — саму distLS.
        """
        if body.orbit_ls > 0:
            return body.orbit_ls
        if body.kind == KIND_MOON:
            parent = by_name.get(body.parent_name or "")
            if parent is not None and parent.distance_ls > 0:
                return max(1e-4, abs(body.distance_ls - parent.distance_ls))
            return 1e-4
        return max(0.0, body.distance_ls)

    # Шкала колец строится по полуосям ВОКРУГ РОДИТЕЛЯ: у планет и вторых звёзд
    # это орбита вокруг главной звезды, поэтому широкая двойная система не
    # сжимает кольца планет в точку.
    zone_bounds = [bound for body in stars for bound in habitable_zone_ls(body) if bound > 0]
    distances = sorted({orbit_of(body) for body in planets}
                       | {orbit_of(body) for body in second_stars}
                       | set(zone_bounds))
    if distances:
        low = math.log10(max(0.05, distances[0]))
        high = math.log10(max(0.05, distances[-1]))
    else:
        low = high = 0.0
    span = max(1e-6, high - low)

    def moon_ring_px(body, siblings) -> float:
        inner, outer = 15.0, 34.0
        orbits = [math.log10(max(1e-4, orbit_of(item))) for item in siblings]
        if len(orbits) < 2:
            return (inner + outer) / 2.0
        low, high = min(orbits), max(orbits)
        span = high - low
        if span <= 1e-9:
            return (inner + outer) / 2.0
        scale = (math.log10(max(1e-4, orbit_of(body))) - low) / span
        return inner + (outer - inner) * max(0.0, min(1.0, scale))

    def ring_radius(distance_ls: float) -> float:
        inner = max_radius * 0.22
        if len(distances) <= 1:
            return max_radius * 0.6
        scale = (math.log10(max(0.05, distance_ls)) - low) / span
        return inner + (max_radius - inner) * max(0.0, min(1.0, scale))

    # Вторые и третьи звёзды: собственное кольцо вокруг главной. Без этого
    # двойная система рисовалась как одиночная: лишние звёзды пропадали.
    star_positions = {}
    if star is not None:
        star_positions[star.name] = (center_x, center_y)
    for index, body in enumerate(second_stars):
        orbit = ring_radius(orbit_of(body))
        angle = math.pi / 3.0 + index * GOLDEN_ANGLE
        x = center_x + orbit * math.cos(angle)
        y = center_y + orbit * math.sin(angle)
        radius = max(9.0, min(22.0, 9.0 + math.log10(max(1.0, body.radius_m) / 1.0e8) * 3.0))
        items.append(PlacedItem(
            kind="star", x=x, y=y, radius=radius, label=body.name,
            caption=body.body_class or body.star_type, color=BODY_COLORS["star"],
            orbit_radius=orbit, orbit_cx=center_x, orbit_cy=center_y,
            orbit_color=orbit_color_for(index + 1),
            ref=body, selected=(selected == body.name),
        ))
        positions[body.name] = (x, y)
        star_positions[body.name] = (x, y)

    for index, body in enumerate(planets):
        orbit = ring_radius(orbit_of(body))
        angle = index * GOLDEN_ANGLE
        # Планета двойной системы кружит вокруг СВОЕЙ звезды: центр кольца —
        # позиция родительской звезды, а не всегда середина холста.
        anchor = star_positions.get(body.parent_name or "", (center_x, center_y))
        x = anchor[0] + orbit * math.cos(angle)
        y = anchor[1] + orbit * math.sin(angle)
        radius = max(4.0, min(14.0, 4.0 + math.log10(max(1.0, body.radius_m) / 1.0e6) * 2.0))
        star_index = next((position for position, star_body in enumerate(stars)
                           if star_body.name == (body.parent_name or "")), 0)
        items.append(PlacedItem(
            kind="body", x=x, y=y, radius=radius, label=body.name,
            caption=body.body_class or body.star_type, color=body_color(body),
            orbit_radius=orbit, orbit_cx=anchor[0], orbit_cy=anchor[1],
            orbit_color=orbit_color_for(star_index),
            distance_ls=body.distance_ls, landable=body.landable,
            bio_signals=body.bio_signals, first_discovered_by=body.first_discovered_by,
            ref=body, selected=(selected == body.name),
        ))
        positions[body.name] = (x, y)
        body_radius[body.name] = radius

    # Луны — рядом со своей планетой; если планеты на карте нет, ставим луну
    # на её собственное кольцо, чтобы тело не пропало.
    moons = sorted((body for body in snapshot.bodies if body.kind == KIND_MOON),
                   key=lambda body: (body.parent_name, orbit_of(body), body.name))
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
                ring_cx, ring_cy, ring_px = center_x, center_y, orbit
            else:
                # Кольцо луны вокруг планеты: радиус монотонно растёт с большой
                # полуосью (лог-шкала между ближайшей и дальней луной родителя),
                # угол — золотой, чтобы луны не слипались в одну точку.
                ring_px = moon_ring_px(body, siblings)
                angle = index * GOLDEN_ANGLE
                x = anchor[0] + ring_px * math.cos(angle)
                y = anchor[1] + ring_px * math.sin(angle)
                ring_cx, ring_cy = anchor
            x = max(14.0, min(width - 14.0, x))
            y = max(14.0, min(height - 14.0, y))
            items.append(PlacedItem(
                kind="body", x=x, y=y, radius=3.5, label=body.name,
                caption=body.body_class, color=body_color(body),
                orbit_radius=ring_px, orbit_cx=ring_cx, orbit_cy=ring_cy,
                distance_ls=body.distance_ls, landable=body.landable,
                bio_signals=body.bio_signals, first_discovered_by=body.first_discovered_by,
                ref=body, selected=(selected == body.name),
            ))
            positions[body.name] = (x, y)
            body_radius[body.name] = 3.5

    # Обитаемые зоны звёзд: «где искать землеподобные планеты» — по ним видно,
    # какая планета попала в зону, а какая мимо (та же полоса, что на сайте).
    for body in stars:
        zone_ls = habitable_zone_ls(body)
        if zone_ls[0] <= 0:
            continue
        zx, zy = star_positions.get(body.name, (center_x, center_y))
        inner_px = ring_radius(zone_ls[0])
        outer_px = max(inner_px + 6.0, ring_radius(zone_ls[1]))
        items.append(PlacedItem(
            kind="zone", x=zx, y=zy, radius=0.0, label="", caption="",
            color=ZONE_COLOR, orbit_cx=zx, orbit_cy=zy,
            zone_inner=inner_px, zone_outer=outer_px, zone_ls=zone_ls,
            ref=body,
        ))

    # Станции и стройплощадки.
    #
    # Наземные объекты (поселения, стройплощадки, планетарные инсталляции)
    # ставим на видимый край тела — сразу за ним, веером, чтобы несколько
    # построек одного тела не сливались. Орбитальные (порты, аванпосты,
    # авианосцы) остаются на своём маленьком кольце вокруг планеты.
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
            siblings = [item for item in snapshot.stations if item.body_name == station.body_name]
            index = siblings.index(station) if station in siblings else 0
            angle = math.pi / 2.0 + (2.0 * math.pi * index / max(1, len(siblings)))
            lift = _station_lift_px(station, body_radius.get(station.body_name or "", 5.0))
            x = anchor[0] + lift * math.cos(angle) * 0.45
            y = anchor[1] - lift * math.sin(angle)
        x = max(30.0, min(width - 30.0, x))
        y = max(26.0, min(height - 34.0, y))
        items.append(PlacedItem(
            kind="station", x=x, y=y,
            radius=4.2 if station.is_site else 3.2,
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
    if center_on:
        # Двойной клик по объекту: вся карта сдвигается так, чтобы он встал в
        # центр холста. Орбитальные кольца едут вместе с картой (pan_x/pan_y).
        anchor = _find_center_item(items, center_on)
        if anchor is not None:
            dx = center_x - anchor.x
            dy = center_y - anchor.y
            for item in items:
                item.x += dx
                item.y += dy
                if item.orbit_cx is not None:
                    item.orbit_cx += dx
                if item.orbit_cy is not None:
                    item.orbit_cy += dy
                item.pan_x = dx
                item.pan_y = dy
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


#: Русские названия товаров колонизации для сводки: ключи Raven Colonial —
#: строчные «слепые» имена (`liquidoxygen`), в чат крыла такое кидать неудобно.
#: Неизвестные ключи сводка показывает как есть — выдумывать имена нельзя.
COMMODITY_LABELS_RU = {
    "steel": "Сталь", "titanium": "Титан", "copper": "Медь",
    "aluminium": "Алюминий", "lithium": "Литий", "cobalt": "Кобальт",
    "gallium": "Галлий", "indium": "Индий", "tantalum": "Тантал",
    "uranium": "Уран", "silver": "Серебро", "gold": "Золото",
    "platinum": "Платина", "palladium": "Палладий", "osmium": "Осмий",
    "thorium": "Торий", "beryllium": "Бериллий", "zirconium": "Цирконий",
    "hafnium": "Гафний", "antimony": "Сурьма", "tellurium": "Теллур",
    "germanium": "Германий", "yttrium": "Иттрий", "niobium": "Ниобий",
    "thallium": "Таллий", "scandium": "Скандий",
    "liquidoxygen": "Жидкий кислород", "water": "Вода", "ice": "Лёд",
    "hydrogenperoxide": "Пероксид водорода", "biowaste": "Биоотходы",
}


def due_timestamp(due_at: str) -> float:
    """Дедлайн как epoch-секунды; пустой или битый срок — бесконечность.

    Список объектов сортируется по сроку, аinf уводит «бессрочные» стройки
    в конец, не ломая сортировку мусором.
    """
    text = str(due_at or "").strip()
    if not text:
        return math.inf
    try:
        due = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return math.inf
    if due.tzinfo is None:
        due = due.replace(tzinfo=timezone.utc)
    return due.timestamp()


def due_note(due_at: str, now=None) -> str:
    """Человеческая строка дедлайна проекта Raven для сводки.

    `timeDue` приходит ISO-строкой; пустое значение и мусор дают пустую
    строку — лучше ничего, чем выдуманный срок.
    """
    text = str(due_at or "").strip()
    if not text:
        return ""
    try:
        due = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if due.tzinfo is None:
        due = due.replace(tzinfo=timezone.utc)
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    delta_days = (due - moment).total_seconds() / 86400.0
    if delta_days < 0:
        over = max(1, int(-delta_days))
        return f"дедлайн просрочен на {over} дн ({due:%d.%m})"
    days = int(delta_days)
    if days == 0:
        return f"дедлайн сегодня ({due:%d.%m})"
    return f"дедлайн через {days} дн ({due:%d.%m})"


def commodity_label(key: str) -> str:
    """`liquidoxygen` -> «Жидкий кислород»; неизвестный ключ не трогаем."""
    name = str(key or "").strip()
    return COMMODITY_LABELS_RU.get(name.lower(), name)


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
            note = due_note(station.due_at)
            if note:
                line += f" · {note}"
            if station.remaining_by_commodity:
                top = sorted(station.remaining_by_commodity.items(),
                             key=lambda pair: pair[1], reverse=True)[:4]
                line += ": " + ", ".join(
                    f"{commodity_label(name)} {amount:,}".replace(",", " ")
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
    star_count = len([body for body in snapshot.bodies if body.kind == KIND_STAR])
    if star_count > 1:
        parts.append(f"звёзд: {star_count}")
    bodies = len(snapshot.bodies)
    if snapshot.known_body_count and snapshot.known_body_count > bodies:
        parts.append(f"тел {bodies} из {snapshot.known_body_count}")
    elif bodies:
        parts.append(f"тел: {bodies}")
    else:
        parts.append("тела не отсканированы")
    unscanned = len([body for body in snapshot.bodies if not body.scanned])
    if unscanned:
        # Подсказка сканеру: сколько тел системы журнал ещё не видел.
        parts.append(f"без скана: {unscanned}")
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


class MapRavenCache:
    """Последний удачный ответ Raven по системам — на диске.

    Карта открывается мгновенно даже без сети: тела, проекты и планы
    прошлого визита подставляются сразу, а фоновый запрос подтверждает или
    обновляет их. В строке состояния возраст кэша показывается честно, так
    что «данные от 12.09 21:40» не выглядят свежими. Файл держим маленьким:
    только последние `max_systems` систем.
    """

    def __init__(self, path, max_systems: int = 24):
        self.path = Path(path) if path else None
        self.max_systems = max(1, int(max_systems))

    def load(self, system: str) -> dict:
        """Запись кэша системы: ``{"ts", "bodies", "projects", "plans"}`` или ``{}``."""
        entry = self._read().get(str(system or "").strip())
        return entry if isinstance(entry, dict) else {}

    def store(self, system: str, bodies=None, projects=None, plans=None) -> bool:
        system = str(system or "").strip()
        if not system or self.path is None:
            return False
        if not (bodies or projects or plans):
            return False
        data = self._read()
        data[system] = {
            "ts": time.time(),
            "bodies": [item for item in (bodies or []) if isinstance(item, dict)],
            "projects": [item for item in (projects or []) if isinstance(item, dict)],
            "plans": [item for item in (plans or []) if isinstance(item, dict)],
        }
        # Свежие системы важнее старых: файл не должен расти бесконечно.
        ordered = sorted(data.items(),
                         key=lambda kv: _as_float(kv[1].get("ts") if isinstance(kv[1], dict) else None, 0.0),
                         reverse=True)
        return self._write(dict(ordered[:self.max_systems]))

    def _read(self) -> dict:
        if self.path is None or not self.path.exists():
            return {}
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            # Битый кэш — не причина падать: карта просто начнёт с журнала.
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data: dict) -> bool:
        if self.path is None:
            return False
        # Вторая попытка — на случай занятого файла (антивирус на Windows
        # успевает схватить .tmp прямо во время os.replace).
        for attempt in range(2):
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_name(self.path.name + ".tmp")
                with open(tmp, "w", encoding="utf-8") as handle:
                    json.dump(data, handle, ensure_ascii=False)
                os.replace(tmp, self.path)
                return True
            except Exception:
                if attempt:
                    return False
                time.sleep(0.05)
        return False
