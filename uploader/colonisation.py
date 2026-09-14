"""Стройплощадки колонизации: определение по журналу и черновик проекта Raven Colonial.

Зачем этот модуль
-----------------

Чтобы создать проект в Raven Colonial, нужны данные, которых нет ни в одном
одном событии журнала:

* `Docked`/`Location` — система, `SystemAddress`, `StarPos`, тело, фракция и
  имя станции (по нему видно, что это стройплощадка, а не обычный порт);
* `ColonisationConstructionDepot` — `MarketID` площадки и список ресурсов с
  `RequiredAmount`/`ProvidedAmount`;
* `Commander`/`LoadGame` — имя командира (архитектор по умолчанию).

Модуль собирает их в один объект `ConstructionSite` и умеет превратить его в
тело запроса `PUT /api/project` (схема `ProjectCreate`).

Что берём из журнала, а что — из API
------------------------------------

По официальному OpenAPI Raven Colonial (`/openapi/v1.json`, схема
`ProjectCreate`) **обязательные** поля — `marketId`, `systemAddress` и
`buildName`. Остальное опционально, но без `starPos`/`bodyNum`/`bodyName`
проект на сайте рисуется «в нигде», а без `colonisationConstructionDepot`
Raven не знает исходную потребность по товарам.

`buildType` в журнал не пишется вовсе: игру тип постройки интересует только
на экране планирования, а в `ColonisationConstructionDepot` его нет. Поэтому
тип остаётся выбором командира — автозаполнение подставляет его только если
в системе есть запланированная площадка
(`GET /api/v2/system/{system}/sites` возвращает `buildType` плана).

Про `commodities`
-----------------

Raven хранит два разных числа: `commodities`/`sumNeed` — **остаток
потребности**, `maxNeed` — исходный объём проекта. Поэтому при создании
отправляем остаток (`RequiredAmount - ProvidedAmount`), а в `maxNeed` —
сумму `RequiredAmount`. Если отправить исходные объёмы в `commodities`,
сайт покажет стройку «0% доставлено» там, где половина уже сдана.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from event_dispatch import normalize_commodity

# Признаки стройплощадки в `Docked.StationName`.
#
# Игра пишет три варианта: наземная площадка, орбитальная площадка и
# «System Colonisation Ship» (первый порт системы). Последний вариант в
# журнале может приходить как сырой токен локализации
# `$EXT_PANEL_ColonisationShip` — без `_Localised`, поэтому проверяем оба.
CONSTRUCTION_NAME_PREFIXES = (
    "Planetary Construction Site:",
    "Orbital Construction Site:",
    "$EXT_PANEL_ColonisationShip",
)
COLONISATION_SHIP_NAMES = ("System Colonisation Ship", "$EXT_PANEL_ColonisationShip")

# Сервис станции, который бывает только у колонизационной площадки. В
# `Docked.StationServices` имена приходят в нижнем регистре.
CONSTRUCTION_STATION_SERVICE = "colonisationcontribution"

# Сколько площадок держим в памяти: в системе может быть несколько строек,
# и форма создания должна уметь показать последнюю из них.
MAX_KNOWN_SITES = 25


def is_construction_site(station_name: str, station_services: Optional[List[str]] = None) -> bool:
    """Это колонизационная стройплощадка?

    `station_services` (из `Docked.StationServices`) необязателен: если он
    передан и непустой, требуем в нём `colonisationcontribution` — по одному
    имени станции отличить площадку от обычного наземного порта нельзя.
    """
    name = str(station_name or "").strip()
    if not name:
        return False
    lowered = name.lower()
    matches_name = (
        any(lowered.startswith(prefix.lower()) for prefix in CONSTRUCTION_NAME_PREFIXES)
        or lowered in {value.lower() for value in COLONISATION_SHIP_NAMES}
    )
    if not matches_name:
        return False
    if station_services:
        services = {str(item).strip().lower() for item in station_services}
        return CONSTRUCTION_STATION_SERVICE in services
    return True


def is_primary_port_station(station_name: str) -> bool:
    """Первый (основной) порт системы строит System Colonisation Ship."""
    lowered = str(station_name or "").strip().lower()
    return any(lowered.startswith(value.lower()) for value in COLONISATION_SHIP_NAMES)


def default_project_name(station_name: str) -> str:
    """Название проекта по имени станции.

    * System Colonisation Ship -> «Primary port»;
    * «Planetary Construction Site: Hestia Depot» -> «Hestia Depot»;
    * «$EXT_PANEL_ColonisationShip; Zeus» -> «Zeus».
    """
    name = str(station_name or "").strip()
    if not name:
        return ""
    if is_primary_port_station(name):
        # Токен может прийти с продолжением: «$EXT_PANEL_ColonisationShip; Zeus».
        tail = name.split(";", 1)[1].strip() if ";" in name else ""
        return tail or "Primary port"
    for prefix in CONSTRUCTION_NAME_PREFIXES:
        if name.lower().startswith(prefix.lower()):
            return name[len(prefix):].strip()
    return name


@dataclass
class SiteResource:
    """Один ресурс из `ColonisationConstructionDepot.ResourcesRequired`."""

    name: str            # FD-имя в нижнем регистре: «steel»
    display: str = ""    # как в игре: «Steel»
    required: int = 0
    provided: int = 0
    payment: int = 0

    @property
    def remaining(self) -> int:
        return max(0, int(self.required) - int(self.provided))

    @classmethod
    def from_journal(cls, item: dict) -> Optional["SiteResource"]:
        if not isinstance(item, dict):
            return None
        display = str(item.get("Name_Localised") or "").strip()
        name = normalize_commodity(item.get("Name") or display)
        if not name:
            return None
        def as_int(value) -> int:
            try:
                return int(value or 0)
            except (TypeError, ValueError):
                return 0

        return cls(
            name=name,
            display=display or name,
            required=as_int(item.get("RequiredAmount")),
            provided=as_int(item.get("ProvidedAmount")),
            payment=as_int(item.get("Payment")),
        )


@dataclass
class ConstructionSite:
    """Всё, что журнал знает об одной колонизационной площадке."""

    market_id: int = 0
    system_name: str = ""
    system_address: int = 0
    station_name: str = ""
    station_type: str = ""
    faction_name: str = ""
    body_num: Optional[int] = None
    body_name: str = ""
    star_pos: List[float] = field(default_factory=list)
    docked: bool = False
    docked_at: str = ""
    # Ресурсы и прогресс — из ColonisationConstructionDepot.
    resources: Dict[str, SiteResource] = field(default_factory=dict)
    progress: Optional[float] = None
    complete: bool = False
    failed: bool = False
    depot_event: Optional[dict] = None
    depot_at: str = ""

    # -- удобные срезы ----------------------------------------------------
    @property
    def is_primary_port(self) -> bool:
        return is_primary_port_station(self.station_name)

    @property
    def suggested_name(self) -> str:
        return default_project_name(self.station_name)

    @property
    def has_depot(self) -> bool:
        return bool(self.resources)

    @property
    def total_required(self) -> int:
        return sum(res.required for res in self.resources.values())

    @property
    def total_provided(self) -> int:
        return sum(res.provided for res in self.resources.values())

    @property
    def total_remaining(self) -> int:
        return sum(res.remaining for res in self.resources.values())

    @property
    def progress_percent(self) -> Optional[int]:
        if self.progress is None:
            return None
        try:
            return int(round(float(self.progress) * 100))
        except (TypeError, ValueError):
            return None

    def remaining_by_commodity(self) -> Dict[str, int]:
        """Остаток потребности по товарам — ровно то, что ждёт Raven."""
        return {
            name: res.remaining
            for name, res in sorted(self.resources.items())
            if res.remaining > 0
        }

    def summary(self) -> str:
        """Одна строка для лога и подписи под формой."""
        if not self.market_id:
            return "Стройплощадка не найдена"
        head = f"{self.system_name or '?'} · {self.station_name or 'площадка'}"
        progress = self.progress_percent
        parts = [head]
        if progress is not None:
            parts.append(f"прогресс {progress}%")
        if self.resources:
            parts.append(
                f"остаток {self.total_remaining:,} t из {self.total_required:,} t"
            )
        if not self.has_depot:
            parts.append("ресурсы ещё не получены (зайдите в Construction Services)")
        return " · ".join(parts).replace(",", " ")

    def update_from_depot(self, event: dict) -> bool:
        """Обновить площадку по `ColonisationConstructionDepot`. Возвращает True, если что-то изменилось."""
        if not isinstance(event, dict):
            return False
        changed = False
        resources: Dict[str, SiteResource] = {}
        for item in event.get("ResourcesRequired") or []:
            resource = SiteResource.from_journal(item)
            if resource is not None:
                resources[resource.name] = resource
        if resources and resources != self.resources:
            changed = True
        self.resources = resources or self.resources

        progress = event.get("ConstructionProgress", event.get("Progress"))
        try:
            new_progress = float(progress) if progress is not None else None
        except (TypeError, ValueError):
            new_progress = None
        if new_progress is not None and new_progress != self.progress:
            self.progress = new_progress
            changed = True

        for flag_name, value in (("complete", "ConstructionComplete"), ("failed", "ConstructionFailed")):
            new_value = bool(event.get(value, getattr(self, flag_name)))
            if new_value != getattr(self, flag_name):
                setattr(self, flag_name, new_value)
                changed = True

        self.depot_event = event
        self.depot_at = str(event.get("timestamp", "") or self.depot_at)
        return changed


class ConstructionSiteTracker:
    """Собирает площадку из потока событий журнала.

    Используется как hook `parse_events()` — тот же однопроходный разбор, что
    и для доставок/оверлея, отдельных чтений журнала не добавляет.
    """

    def __init__(self, max_sites: int = MAX_KNOWN_SITES):
        self.max_sites = max(1, int(max_sites))
        self._sites: Dict[int, ConstructionSite] = {}
        self._order: List[int] = []
        self.current: Optional[ConstructionSite] = None
        self.last: Optional[ConstructionSite] = None
        # Событие, которое привело к смене площадки: по нему GUI решает,
        # перезаполнять ли форму (и нужно ли показывать уведомление).
        self.last_event: str = ""
        # Командир — для `architectName`/`commanders`.
        self.commander: str = ""
        self._system_name: str = ""
        self._system_address: int = 0
        self._star_pos: List[float] = []

    # -- публичное --------------------------------------------------------
    @property
    def site(self) -> Optional[ConstructionSite]:
        """Площадка, у которой командир стоит сейчас, иначе последняя известная."""
        return self.current or self.last

    def known_sites(self) -> List[ConstructionSite]:
        return [self._sites[key] for key in self._order if key in self._sites]

    def reset(self):
        self._sites.clear()
        self._order.clear()
        self.current = None
        self.last = None
        self.last_event = ""

    def handle(self, line: str, event: dict) -> bool:
        """Одно событие журнала. Возвращает True, если площадка только что сменилась."""
        if not isinstance(event, dict):
            return False
        name = str(event.get("event", "") or "")
        changed = False

        if name in ("Commander", "LoadGame"):
            candidate = event.get("Name") or event.get("Commander")
            if candidate:
                self.commander = str(candidate)

        if name in ("Location", "FSDJump", "Docked", "CarrierJump"):
            self._absorb_position(event)

        if name in ("Docked", "Location"):
            changed = self._absorb_station(event) or changed

        if name == "Undocked":
            if self.current is not None:
                self.current.docked = False
            self.current = None
            self.last_event = "undocked"

        if name == "ColonisationConstructionDepot":
            changed = self._absorb_depot(event) or changed

        return changed

    # -- внутреннее -------------------------------------------------------
    def _absorb_position(self, event: dict):
        system = event.get("StarSystem")
        if system:
            self._system_name = str(system)
        address = event.get("SystemAddress")
        if address:
            try:
                self._system_address = int(address)
            except (TypeError, ValueError):
                pass
        star_pos = event.get("StarPos")
        if isinstance(star_pos, (list, tuple)) and len(star_pos) == 3:
            try:
                self._star_pos = [float(value) for value in star_pos]
            except (TypeError, ValueError):
                pass

    def _absorb_station(self, event: dict) -> bool:
        """`Docked`/`Location`: понять, что командир у стройплощадки."""
        station_name = str(event.get("StationName") or "")
        if not station_name:
            return False
        if not is_construction_site(station_name, event.get("StationServices")):
            # Обычная станция: «отпускаем» площадку, чтобы форма не
            # предлагала создать проект, стоя у торговца.
            if self.current is not None and self.current.docked:
                self.current.docked = False
                self.current = None
                self.last_event = "left"
                return True
            return False

        try:
            market_id = int(event.get("MarketID") or 0)
        except (TypeError, ValueError):
            market_id = 0

        existing = self._sites.get(market_id) if market_id else None
        if existing is None:
            existing = ConstructionSite(market_id=market_id)
            self._register(existing)
            self.last_event = "arrived"
        else:
            # Возврат на уже известную площадку — тоже повод обновить форму,
            # но не «новая площадка»: журнал её не перезаполнит заново.
            if self.current is not existing:
                self.last_event = "arrived"
            else:
                self.last_event = ""

        existing.station_name = station_name
        existing.station_type = str(event.get("StationType") or existing.station_type or "")
        existing.docked = True
        existing.docked_at = str(event.get("timestamp", "") or existing.docked_at)
        faction = event.get("StationFaction")
        if isinstance(faction, dict) and faction.get("Name"):
            existing.faction_name = str(faction["Name"])
        if event.get("StarSystem"):
            existing.system_name = str(event["StarSystem"])
        if event.get("SystemAddress"):
            try:
                existing.system_address = int(event["SystemAddress"])
            except (TypeError, ValueError):
                pass
        if isinstance(event.get("StarPos"), (list, tuple)):
            existing.star_pos = [float(v) for v in event["StarPos"]]
        self._fill_from_current(existing)
        body_num = event.get("BodyID")
        if body_num is not None:
            try:
                existing.body_num = int(body_num)
            except (TypeError, ValueError):
                pass
        if event.get("Body"):
            existing.body_name = str(event["Body"])

        self.current = existing
        self.last = existing
        return True

    def _absorb_depot(self, event: dict) -> bool:
        """`ColonisationConstructionDepot`: ресурсы и прогресс площадки."""
        try:
            market_id = int(event.get("MarketID") or 0)
        except (TypeError, ValueError):
            market_id = 0
        if market_id <= 0:
            # Без MarketID площадку не с чем сопоставить: ни в форме создания
            # проекта, ни в Raven Colonial она не нужна.
            return False
        site = self._sites.get(market_id)
        if site is None:
            # Приложение могло быть запущено, когда командир уже стоит у
            # площадки: `Docked` в новых строках журнала нет. Площадку
            # восстанавливаем по самому событию депота.
            site = ConstructionSite(market_id=market_id)
            self._register(site)
            self.last_event = "arrived"
        site.update_from_depot(event)
        self._fill_from_current(site)
        self.last = site
        if self.current is None or (self.current.market_id == site.market_id):
            self.current = site
        return True

    def _fill_from_current(self, site: ConstructionSite):
        """Дополнить площадку тем, что известно о текущей системе."""
        if not site.system_name and self._system_name:
            site.system_name = self._system_name
        if not site.system_address and self._system_address:
            site.system_address = self._system_address
        if not site.star_pos and self._star_pos:
            site.star_pos = list(self._star_pos)

    def _register(self, site: ConstructionSite):
        key = site.market_id or id(site)
        self._sites[key] = site
        if key in self._order:
            self._order.remove(key)
        self._order.append(key)
        # Площадки старых систем не нужны — держим список коротким.
        while len(self._order) > self.max_sites:
            oldest = self._order.pop(0)
            if oldest in self._sites and self._sites[oldest] is not self.current:
                self._sites.pop(oldest, None)


# ---------------------------------------------------------------------------
#  Черновик проекта для PUT /api/project
# ---------------------------------------------------------------------------
def build_project_draft(
    site: Optional[ConstructionSite],
    *,
    build_name: str = "",
    build_type: str = "",
    architect_name: str = "",
    discord_link: str = "",
    notes: str = "",
    is_primary_port: Optional[bool] = None,
    commanders: Optional[Dict[str, List[str]]] = None,
    system_site_id: str = "",
    include_depot: bool = True,
) -> Dict[str, Any]:
    """Собрать тело `PUT /api/project` (схема `ProjectCreate`).

    Обязательные поля Raven Colonial — `marketId`, `systemAddress`,
    `buildName`; их отсутствие проверяет `RavenColonialAPI.create_project()`.
    Пустые опциональные поля не добавляем: Raven делает merge, и явный `null`
    может затереть уже сохранённое значение.
    """
    draft: Dict[str, Any] = {}
    if site is not None:
        draft["marketId"] = int(site.market_id or 0)
        draft["systemAddress"] = int(site.system_address or 0)
        if site.system_name:
            draft["systemName"] = site.system_name
        if site.star_pos:
            draft["starPos"] = list(site.star_pos)
        if site.body_num is not None:
            draft["bodyNum"] = int(site.body_num)
        if site.body_name:
            draft["bodyName"] = site.body_name
        if is_primary_port is None:
            is_primary_port = site.is_primary_port
        if not build_name:
            build_name = site.suggested_name
        remaining = site.remaining_by_commodity()
        if remaining:
            draft["commodities"] = remaining
        if site.total_required:
            draft["maxNeed"] = int(site.total_required)
        if include_depot and isinstance(site.depot_event, dict):
            # Raven умеет принять событие журнала целиком — из него он сам
            # достанет исходную потребность, даже если часть уже сдана.
            draft["colonisationConstructionDepot"] = site.depot_event

    if build_name:
        draft["buildName"] = str(build_name).strip()
    if build_type:
        draft["buildType"] = str(build_type).strip()
    if architect_name:
        draft["architectName"] = str(architect_name).strip()
    if discord_link:
        draft["discordLink"] = str(discord_link).strip()
    if notes:
        draft["notes"] = str(notes).strip()
    if is_primary_port is not None:
        draft["isPrimaryPort"] = bool(is_primary_port)
    if commanders:
        draft["commanders"] = {
            str(cmdr): list(assigned or []) for cmdr, assigned in commanders.items() if cmdr
        }
    if system_site_id:
        draft["systemSiteId"] = str(system_site_id)
    return draft


def format_commodities(commodities: Dict[str, int]) -> str:
    """{'steel': 900} -> 'steel:900' — формат поля «Товары» на вкладке."""
    return ", ".join(f"{name}:{amount}" for name, amount in sorted((commodities or {}).items()))
