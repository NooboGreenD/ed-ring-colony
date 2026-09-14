"""Фоновая отправка событий журнала во внешние сервисы.

Сервисы: EDSM, Inara и Raven Colonial (Fleet Carrier cargo).

Почему этот код вынесен в отдельный модуль
------------------------------------------

Раньше отправка была вшита прямо в поток обработки журналов:

* EDSM  — `threading.Thread(...).start()` на **каждое** событие;
* Inara — **синхронный** HTTP-запрос на каждое подходящее событие;
* Raven — **синхронный** HTTP-запрос на каждый MarketSell/MarketBuy на
  Fleet Carrier.

Живой watcher обрабатывает по несколько событий в секунду, и там это почти
незаметно. Но при **первичной загрузке всей истории** (сотни файлов, десятки
и сотни тысяч событий) получалось (замер на тестовом наборе из 800 файлов,
22 МБ, см. CHANGES.md):

* ~37 000 одновременных потоков под EDSM — распухание памяти и исчерпание
  пула соединений;
* ~55 000 последовательных запросов в Inara — часы ожидания;
* ~12 000 последовательных запросов в Raven.

Внешние сервисы вдобавок начинают отвечать 429 (rate limit), запросы
повторяются с таймаутом 15 с, и загрузка встаёт окончательно.

Как работает теперь
-------------------

Один или несколько фоновых воркеров + очередь ограниченного размера:

* `submit()` никогда не блокирует поток обработки — только кладёт задачу в
  очередь (или выбрасывает её, если сервис не успевает, а очередь забита);
* исторические события (первичная загрузка журналов или ручной импорт
  файлов) по умолчанию **не** уходят во внешние сервисы: это живые трекеры,
  им нужны только текущие события. Включается флагом `backfill_enabled`;
* дедупликация событий живёт здесь же, поэтому повторный проход по журналу
  не создаёт повторных запросов.

Модуль не зависит от Tkinter — его можно импортировать и тестировать
отдельно от GUI.
"""

import queue
import threading
import time
from typing import Callable, Optional

# Какие события журнала уходят в EDSM (навигация и сканирование).
# CarrierJump и Undocked добавлены: без них на EDSM рвётся цепочка
# «прыгнул — пристыковался — отстыковался», а перелёты авианосца не
# попадают в журнал полётов вовсе.
EDSM_EVENTS = frozenset({
    "Location", "FSDJump", "Docked", "Undocked", "CarrierJump",
    "Scan", "FSSDiscoveryScan", "SAAScanComplete",
})

# Диапазон MarketID, в котором живут Fleet Carrier.
# Общеизвестная эвристика (ею же пользуются EDMC/EDDiscovery): MarketID
# авианосца лежит в 3 700 000 000 … 3 800 000 000. Она позволяет понять, что
# торговля идёт на авианосце, даже если мы не видели событий Docked/Market
# (например, программа запущена, когда командир уже давно стоит на FC).
FLEET_CARRIER_MARKET_MIN = 3_700_000_000
FLEET_CARRIER_MARKET_MAX = 3_800_000_000

# Грузовые операции на Fleet Carrier уходят в Raven Colonial (/api/fc/...).
#
# CargoTransfer добавлен отдельно: погрузка авианосца через экран «Inventory →
# Transfer» пишется именно им (`Direction: tocarrier`), а не MarketSell. Пока
# это событие игнорировалось, прогресс погрузки в Raven Colonial не менялся
# вообще — ровно то, на что жаловался пользователь.
RAVEN_CARGO_EVENTS = frozenset({"MarketSell", "MarketBuy", "CargoTransfer"})


def normalize_commodity(value) -> str:
    """Имя товара в том виде, в каком его ждут внешние API.

    Журнал даёт три варианта: `steel` (FDName), `$steel_name;` (токен) и
    `Steel` (Type_Localised). Raven Colonial принимает только нижний регистр и
    языкозависимые токены reject: «`liquidoxygen` not `LiquidOxygen` or
    `$liquidoxygen_name;`». Inara принимает имя «as is in the journals».
    """
    name = str(value or "").strip().lower()
    if name.startswith("$"):
        name = name[1:]
    for suffix in ("_name;", "_name"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return name


def is_fleet_carrier(event: dict, station_type: str = "") -> bool:
    """Это операция на Fleet Carrier?

    Проверяем по трём признакам — любого достаточно:

    * MarketID в диапазоне авианосцев (работает даже без событий стыковки);
    * в событии есть `CarrierID` (например, CarrierJump/CarrierStats);
    * `StationType` (или тип станции, где мы сейчас) — FleetCarrier.
    """
    if not isinstance(event, dict):
        return False
    try:
        market_id = int(event.get("MarketID") or 0)
    except (TypeError, ValueError):
        market_id = 0
    if FLEET_CARRIER_MARKET_MIN <= market_id < FLEET_CARRIER_MARKET_MAX:
        return True
    if event.get("CarrierID"):
        return True
    station = str(event.get("StationType") or station_type or "").lower()
    return "carrier" in station


# ---------------------------------------------------------------------------
#  Inara: имена событий и поля в формате Inara API
#
#  Раньше отправлялись имена вида `cmdrFSDJump` и сырые поля журнала. В Inara
#  API таких событий нет: правильные имена — `addCommanderTravelFSDJump`,
#  `addCommanderTravelDock`, `setCommanderTravelLocation`, а поля называются
#  `starsystemName`, `stationName`, `marketID`, `shipType`, `shipGameID`
#  (не `StarSystem`/`StationName`/...). Список событий сверен с
#  https://inara.cz/elite/inara-api-docs/ и с EDDiscovery (InaraSync.cs):
#  событий сканирования Inara не принимает вовсе.
# ---------------------------------------------------------------------------
def _coords(event: dict):
    """Координаты системы для Inara: массив [X, Y, Z] или ничего."""
    star_pos = event.get("StarPos")
    if isinstance(star_pos, (list, tuple)) and len(star_pos) == 3:
        return list(star_pos)
    return None


def _body_coords(event: dict):
    """Координаты посадки [LAT, LON] — Inara зовёт их starsystemBodyCoords."""
    latitude, longitude = event.get("Latitude"), event.get("Longitude")
    if latitude is None or longitude is None:
        return None
    try:
        return [float(latitude), float(longitude)]
    except (TypeError, ValueError):
        return None


def _inara_location(event: dict) -> dict:
    data = {"starsystemName": event.get("StarSystem") or event.get("SystemName")}
    if event.get("StationName"):
        data["stationName"] = event["StationName"]
    if event.get("MarketID"):
        data["marketID"] = event["MarketID"]
    coords = _coords(event)
    if coords:
        data["starsystemCoords"] = coords
    if event.get("Body"):
        data["starsystemBodyName"] = event["Body"]
    body_coords = _body_coords(event)
    if body_coords:
        data["starsystemBodyCoords"] = body_coords
    return {key: value for key, value in data.items() if value not in (None, "")}


def _inara_dock(event: dict) -> dict:
    data = _inara_location(event)
    if event.get("ShipType"):
        data["shipType"] = event["ShipType"]
    # shipGameID — внутренний номер корабля из журнала. Без него Inara не
    # может привязать стыковку к конкретному кораблю командира.
    if event.get("ShipID") is not None:
        data["shipGameID"] = event["ShipID"]
    return data


def _inara_jump(event: dict) -> dict:
    data = {"starsystemName": event.get("StarSystem")}
    coords = _coords(event)
    if coords:
        data["starsystemCoords"] = coords
    if event.get("JumpDist"):
        data["jumpDistance"] = event["JumpDist"]
    if event.get("ShipType"):
        data["shipType"] = event["ShipType"]
    if event.get("ShipID") is not None:
        data["shipGameID"] = event["ShipID"]
    return {key: value for key, value in data.items() if value not in (None, "")}


def _inara_carrier_jump(event: dict) -> dict:
    """CarrierJump: Inara ждёт ещё и имя авианосца с его MarketID."""
    data = _inara_jump(event)
    if event.get("StationName"):
        data["stationName"] = event["StationName"]
    if event.get("MarketID"):
        data["marketID"] = event["MarketID"]
    return data


def _inara_land(event: dict) -> dict:
    """Touchdown/DropShipDeploy -> addCommanderTravelLand.

    Раньше посадки в Inara не уходили вовсе: для колонизатора это самое
    заметное событие полёта — именно посадкой на площадку начинается сдача
    груза.
    """
    data = {"starsystemName": event.get("StarSystem")}
    coords = _coords(event)
    if coords:
        data["starsystemCoords"] = coords
    body = event.get("NearestDestination") or event.get("Body")
    if body:
        data["starsystemBodyName"] = body
    body_coords = _body_coords(event)
    if body_coords:
        data["starsystemBodyCoords"] = body_coords
    if event.get("ShipID") is not None:
        data["shipGameID"] = event["ShipID"]
    return {key: value for key, value in data.items() if value not in (None, "")}


def _inara_cargo_item(event: dict) -> dict:
    """Товар из MarketBuy/MarketSell — в формате Inara (дельта по cargo)."""
    count = event.get("Count") or 0
    return {
        "itemName": normalize_commodity(event.get("Type") or event.get("Type_Localised")),
        "itemCount": abs(int(count)),
    }


# Журнальное событие -> (имя события Inara, сборщик eventData)
INARA_EVENTS = {
    "Location": ("setCommanderTravelLocation", _inara_location),
    "FSDJump": ("addCommanderTravelFSDJump", _inara_jump),
    "Docked": ("addCommanderTravelDock", _inara_dock),
    "CarrierJump": ("addCommanderTravelCarrierJump", _inara_carrier_jump),
    # Посадка на тело: Touchdown пишет игра, DropShipDeploy — высадка из
    # десантного корабля (Odyssey).
    "Touchdown": ("addCommanderTravelLand", _inara_land),
    "DropShipDeploy": ("addCommanderTravelLand", _inara_land),
    # Покупка кладёт товар в трюм, продажа — забирает: дельтовые события
    # точнее, чем set-события (не нужно знать остаток по каждому товару).
    "MarketBuy": ("addCommanderInventoryCargoItem", _inara_cargo_item),
    "MarketSell": ("delCommanderInventoryCargoItem", _inara_cargo_item),
}


# Результат постановки события в очередь.
_QUEUED = "queued"
_SKIPPED = "skipped"   # дубль или событие сервису не интересно
_DROPPED = "dropped"   # очередь переполнена


class ThirdPartyDispatcher:
    """Отправка событий журнала во внешние API из фоновых потоков."""

    def __init__(
        self,
        edsm_api=None,
        inara_api=None,
        raven_api=None,
        logger: Optional[Callable[[str], None]] = None,
        max_queue: int = 2000,
        workers: int = 2,
        backfill_enabled: bool = False,
    ):
        self.edsm_api = edsm_api
        self.inara_api = inara_api
        self.raven_api = raven_api
        self.logger = logger
        self.backfill_enabled = bool(backfill_enabled)
        self.max_queue = max(1, int(max_queue))
        self.workers = max(1, int(workers))

        self._queue: "queue.Queue" = queue.Queue(maxsize=self.max_queue)
        self._threads = []
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._started = False

        # Дедупликация: ключи уже отправленных событий по каждому сервису.
        self._seen = {"edsm": set(), "inara": set(), "raven": set()}

        # Статистика для UI/лога.
        self.stats = {
            "queued": 0,
            "sent": 0,
            "failed": 0,
            "dropped": 0,            # очередь переполнена — событие выброшено
            "skipped_backfill": 0,   # историческое событие, внешние API не нужны
            "duplicate": 0,
        }

        # Опциональный колбэк: on_result(service, ok, message)
        self.on_result: Optional[Callable[[str, bool, str], None]] = None
        self._last_drop_warning = 0.0

        # Сколько раз подряд сервис не принял событие. Нужно, чтобы одна
        # недоступность EDSM не превратилась в тысячи одинаковых строк в логе.
        self._fail_streak = {"edsm": 0, "inara": 0, "raven": 0}
        # Последнее отправленное состояние потребности по marketId: depot-
        # события приходят пачками, а Raven не любит бессмысленные ProjectUpdate.
        self._raven_supply_state: dict = {}
        # «Приложение не в белом списке Inara» не лечится повторами: пишем один
        # раз, иначе каждое событие журнала добавляло бы простыню в лог.
        self._inara_access_notified = False

        # «Transient state» для EDSM: сам по себе журнал часто не знает, где и
        # на чём был командир в момент события (например, в Scan нет системы).
        # EDSM просит докладывать это отдельными полями.
        self._game_state = {
            "system_address": None,
            "system_name": None,
            "coordinates": None,
            "market_id": None,
            "station_name": None,
            "ship_id": None,
        }
        # Ограничение на множества дедупликации: на длинной сессии они иначе
        # растут бесконечно (по множеству на каждый сервис).
        self.max_seen = 50000

    # -- контекст ----------------------------------------------------------
    def set_game_version(self, version: str = "", build: str = ""):
        """Версия и сборка игры — обязательные поля EDSM (msgnum 207/208)."""
        if self.edsm_api is not None and hasattr(self.edsm_api, "set_game_version"):
            try:
                self.edsm_api.set_game_version(version, build)
            except Exception:
                pass

    def _is_seen(self, service: str, key) -> bool:
        """Уже отправляли? (без пометки — для сервисов с повтором при ошибке)."""
        with self._lock:
            seen = self._seen[service]
            if key in seen:
                self.stats["duplicate"] += 1
                return True
            return False

    def _remember_seen(self, service: str, key) -> bool:
        """True, если ключ уже отправляли. Множество ограничено по размеру."""
        with self._lock:
            seen = self._seen[service]
            if key in seen:
                self.stats["duplicate"] += 1
                return True
            if len(seen) >= self.max_seen:
                # Жертвуем идеальной дедупликацией ради памяти: внешние сервисы
                # и сами отсекают дубли (у EDSM кеш на 300 с).
                seen.clear()
            seen.add(key)
            return False

    def _update_game_state(self, event: dict, event_name: str):
        """Обновить «transient state» по образцу из документации EDSM."""
        state = self._game_state
        if event_name == "LoadGame":
            state.update({"coordinates": None, "market_id": None, "station_name": None})
        elif event_name == "Undocked":
            state["market_id"] = None
            state["station_name"] = None
        elif event_name in ("Location", "FSDJump", "Docked", "CarrierJump"):
            system = event.get("StarSystem")
            if system:
                if system != state["system_name"]:
                    state["coordinates"] = None
                state["system_name"] = system
            if event.get("SystemAddress") is not None:
                state["system_address"] = event.get("SystemAddress")
            if event.get("StarPos") is not None:
                state["coordinates"] = event.get("StarPos")
            if event.get("MarketID") is not None:
                state["market_id"] = event.get("MarketID")
            if event.get("StationName") is not None:
                state["station_name"] = event.get("StationName")
        if event_name in ("Loadout", "SetUserShipName", "ShipyardSwap", "ShipyardNew"):
            ship_id = event.get("ShipID") or event.get("ShipIdent")
            if ship_id:
                state["ship_id"] = ship_id

    def _transient_fields(self) -> dict:
        state = self._game_state
        return {
            "_systemAddress": state["system_address"],
            "_systemName": state["system_name"],
            "_systemCoordinates": state["coordinates"],
            "_marketId": state["market_id"],
            "_stationName": state["station_name"],
            "_shipId": state["ship_id"],
        }

    # -- настройка ---------------------------------------------------------
    def configure(
        self,
        edsm_api=None,
        inara_api=None,
        raven_api=None,
        backfill_enabled: bool = None,
        logger: Callable[[str], None] = None,
    ):
        """Пере-привязать клиентов API (GUI-поля создаются позже клиентов)."""
        if edsm_api is not None:
            self.edsm_api = edsm_api
        if inara_api is not None:
            self.inara_api = inara_api
        if raven_api is not None:
            self.raven_api = raven_api
        if backfill_enabled is not None:
            self.backfill_enabled = bool(backfill_enabled)
        if logger is not None:
            self.logger = logger

    def _log(self, message: str):
        if not self.logger:
            return
        try:
            self.logger(message)
        except Exception:
            pass

    #: Как часто напоминать о длящемся сбое (каждая N-я неудача).
    FAIL_NOTICE_EVERY = 25

    def _notify_failure(self, service: str, message: str):
        """Сообщить о неудаче, не засоряя лог.

        Первая неудача в серии попадает в лог целиком, дальше — только каждая
        `FAIL_NOTICE_EVERY`-я, с накопленным счётчиком. Как только сервис
        снова отвечает, пишем об этом (иначе пользователь не узнает, что
        отправка восстановилась).
        """
        streak = self._fail_streak.get(service, 0) + 1
        self._fail_streak[service] = streak
        if streak == 1:
            self._notify(service, False, message)
        elif streak % self.FAIL_NOTICE_EVERY == 0:
            self._notify(
                service, False,
                f"{service.upper()}: сервис по-прежнему не принимает события — "
                f"{streak} неудач подряд (последняя: {message})",
            )

    def _notify_success(self, service: str):
        """Сбросить счётчик сбоев и сообщить о восстановлении."""
        streak = self._fail_streak.get(service, 0)
        self._fail_streak[service] = 0
        if streak > 1:
            self._notify(
                service, True,
                f"{service.upper()}: отправка восстановлена "
                f"(до этого {streak} событий не ушло)",
            )

    def _notify(self, service: str, ok: bool, message: str):
        if not self.on_result:
            return
        try:
            self.on_result(service, ok, message)
        except Exception:
            pass

    # -- отправка ----------------------------------------------------------
    def submit(self, event: dict, live: bool = True, station_type: str = "") -> bool:
        """Поставить событие в очередь внешних API.

        Возвращает False только если событие выброшено из-за переполнения
        очереди (внешние сервисы не успевают); иначе True.

        `live=False` — исторический разбор (первичная загрузка журналов или
        ручной импорт файлов). Такие события по умолчанию во внешние сервисы
        не уходят — см. `backfill_enabled`.
        """
        if not isinstance(event, dict):
            return True
        if not live and not self.backfill_enabled:
            self.stats["skipped_backfill"] += 1
            return True

        event_name = str(event.get("event", ""))

        # Версия игры нужна EDSM: без неё события отклоняются (msgnum 207).
        if event_name in ("Fileheader", "LoadGame"):
            self.set_game_version(
                event.get("GameVersion") or event.get("gameversion"),
                event.get("Build") or event.get("build"),
            )
        # Transient state обновляем до отправки: событие должно уйти уже с
        # актуальной системой/станцией, иначе EDSM привяжет его не туда.
        self._update_game_state(event, event_name)

        results = []

        # ВАЖНО: раньше Inara и Raven вызывались только при включённом EDSM
        # (общий `if not self.edsm_api.enabled: return`). Проверяем каждый
        # сервис по отдельности.
        if self._edsm_enabled() and event_name in EDSM_EVENTS:
            results.append(self._submit_edsm(event, event_name))
        if self._inara_enabled() and event_name in INARA_EVENTS:
            results.append(self._submit_inara(event, event_name))
        if self._raven_enabled() and event_name in RAVEN_CARGO_EVENTS:
            results.append(self._submit_raven(event, event_name, station_type))
        # ProjectUpdate потребности шлём только за живыми событиями: при
        # пакетном разборе истории depot-события дублируются из каждого файла,
        # а тестовые прогонки журнала не должны делать лишних запросов.
        if (self._raven_enabled() and live
                and event_name == "ColonisationConstructionDepot"):
            results.append(self._submit_raven_supply(event))

        return _DROPPED not in results

    # -- проверки сервисов -------------------------------------------------
    def _edsm_enabled(self) -> bool:
        return bool(self.edsm_api is not None and getattr(self.edsm_api, "enabled", False))

    def _inara_enabled(self) -> bool:
        return bool(self.inara_api is not None and getattr(self.inara_api, "enabled", False))

    def _raven_enabled(self) -> bool:
        return bool(self.raven_api is not None and getattr(self.raven_api, "is_connected", False))

    # -- постановка в очередь по сервисам ----------------------------------
    def _submit_edsm(self, event: dict, event_name: str) -> str:
        key = (
            event.get("timestamp", ""),
            event_name,
            event.get("SystemAddress", ""),
            event.get("BodyID", ""),
        )
        if self._remember_seen("edsm", key):
            return _SKIPPED
        payload = dict(event)
        # Transient state: EDSM сам просит докладывать систему/станцию/корабль
        # для одиночных событий (без этого, например, Scan не привяжется).
        payload.update(self._transient_fields())
        return self._enqueue("edsm", {"event": payload})

    def _submit_inara(self, event: dict, event_name: str) -> str:
        key = (
            event.get("timestamp", ""),
            event_name,
            event.get("SystemAddress", ""),
            event.get("BodyID", ""),
            event.get("MarketID", ""),
        )
        if self._remember_seen("inara", key):
            return _SKIPPED
        event_api_name, builder = INARA_EVENTS[event_name]
        # Часть событий (Touchdown, DropShipDeploy) приходит без системы и
        # координат: Inara такие отклоняет. Подставляем известное нам текущее
        # положение — оно уже отслеживается для EDSM.
        if not event.get("StarSystem") or not event.get("StarPos"):
            enriched = dict(event)
            if not enriched.get("StarSystem") and self._game_state["system_name"]:
                enriched["StarSystem"] = self._game_state["system_name"]
            if not enriched.get("StarPos") and self._game_state["coordinates"]:
                enriched["StarPos"] = self._game_state["coordinates"]
            event = enriched
        try:
            data = builder(event)
        except Exception:
            data = {}
        if not data:
            # Нечего отправлять: например, в событии нет системы.
            return _SKIPPED
        return self._enqueue(
            "inara",
            {
                "event_name": event_api_name,
                "data": data,
                "timestamp": str(event.get("timestamp", "")),
            },
        )

    def _submit_raven_supply(self, event: dict) -> str:
        """Потребность площадки из depot-события — в ProjectUpdate для Raven.

        Журнальное `ColonisationConstructionDepot` несёт Required/Provided по
        каждому материалу: остаток (Required − Provided) и есть то, что сайт
        показывает в колонке Need. Сам Raven из доставок его не пересчитывает.
        """
        needed: dict = {}
        max_need = 0
        for item in event.get("ResourcesRequired") or []:
            if not isinstance(item, dict):
                continue
            name = normalize_commodity(item.get("Name") or "")
            required = int(item.get("RequiredAmount") or 0)
            provided = int(item.get("ProvidedAmount") or 0)
            if name and required > 0:
                needed[name] = max(0, required - provided)
                max_need += required
        if not needed:
            return _SKIPPED
        try:
            market_id = int(event.get("MarketID") or 0)
        except (TypeError, ValueError):
            market_id = 0
        if not market_id:
            return _SKIPPED
        address = int(event.get("SystemAddress") or 0) or \
            int(self._game_state.get("system_address") or 0)
        return self.submit_supply_update(market_id, address, needed, max_need)

    def submit_supply_update(self, market_id: int, system_address: int,
                             commodities: dict, max_need: int) -> str:
        """Поставить ProjectUpdate потребности в очередь (один раз на состояние).

        Возвращает «queued» / «skipped» (состояние не изменилось или отправить
        нечего) / «dropped» (очередь переполнена).
        """
        try:
            key = int(market_id or 0)
        except (TypeError, ValueError):
            return _SKIPPED
        if not key or not commodities:
            return _SKIPPED
        if self._raven_supply_state.get(key) == commodities:
            return _SKIPPED
        self._raven_supply_state[key] = dict(commodities)
        return self._enqueue("raven", {
            "kind": "supply",
            "market_id": key,
            "system_address": int(system_address or 0),
            "commodities": dict(commodities),
            "max_need": int(max_need or 0),
        })

    def _submit_raven(self, event: dict, event_name: str, station_type: str = "") -> str:
        """Fleet Carrier cargo: продажа на FC добавляет груз, покупка — забирает.

        Тип станции больше не единственный признак авианосца: если программа
        запущена, когда командир уже стоит на FC, событий `Docked`/`Market`
        в новых строках журнала нет, `_station_type` пуст, и прогресс погрузки
        не уходил в Raven Colonial вовсе. Теперь сначала проверяем MarketID
        (диапазон авианосцев) и `CarrierID`.
        """
        if event_name == "CargoTransfer":
            return self._submit_raven_transfer(event, station_type)

        market_id = event.get("MarketID")
        count = event.get("Count")
        # Raven Colonial требует имя товара в нижнем регистре и без
        # локализационных токенов: `steel`, а не `Steel` и не `$steel_name;`.
        commodity = normalize_commodity(event.get("Type") or event.get("Type_Localised"))
        if not market_id or not count or not commodity:
            return _SKIPPED
        if not is_fleet_carrier(event, station_type):
            return _SKIPPED

        key = "|".join(
            str(event.get(field, ""))
            for field in ("event", "timestamp", "MarketID", "Type", "Type_Localised", "Count", "CarrierID")
        )
        # Raven: ключ попадает в `seen` только ПОСЛЕ успешной отправки (см.
        # `_do_raven`), чтобы неудачный запрос был предпринят ещё раз. Здесь
        # только проверяем дубли, ничего не помечая.
        if self._is_seen("raven", key):
            return _SKIPPED
        delta = int(count) if event_name == "MarketSell" else -int(count)
        return self._enqueue(
            "raven",
            {
                "market_id": int(market_id),
                "commodity": str(commodity),
                "delta": delta,
                "key": key,
            },
        )

    def _submit_raven_transfer(self, event: dict, station_type: str = "") -> str:
        """Перенос груза через экран Transfer: ship <-> авианосец.

        Событие `CargoTransfer` не содержит MarketID, поэтому авианосец
        определяем по рынку текущей стоянки (мы уже знаем её из Location/
        Docked/CarrierJump) — перекидывать груз можно только находясь у FC.
        """
        transfers = event.get("Transfers")
        if not isinstance(transfers, list) or not transfers:
            return _SKIPPED
        # MarketID берём из события, а если его нет — из последней стоянки.
        market_id = event.get("MarketID") or self._game_state.get("market_id")
        try:
            market_id = int(market_id or 0)
        except (TypeError, ValueError):
            market_id = 0
        if not market_id or not is_fleet_carrier({"MarketID": market_id}, station_type):
            return _SKIPPED

        result = _SKIPPED
        for index, transfer in enumerate(transfers):
            if not isinstance(transfer, dict):
                continue
            direction = str(transfer.get("Direction") or "").lower()
            if direction == "tocarrier":
                delta = int(transfer.get("Count") or 0)
            elif direction == "toship":
                delta = -int(transfer.get("Count") or 0)
            else:
                continue  # tosrv / прочие — к авианосцу не относятся
            commodity = normalize_commodity(transfer.get("Type") or transfer.get("Type_Localised"))
            if not commodity or not delta:
                continue
            key = "|".join(str(part) for part in (
                "CargoTransfer", event.get("timestamp", ""), market_id, index,
                transfer.get("Type", ""), transfer.get("Count", ""), direction,
            ))
            if self._is_seen("raven", key):
                result = _SKIPPED if result == _SKIPPED else result
                continue
            outcome = self._enqueue(
                "raven",
                {
                    "market_id": market_id,
                    "commodity": commodity,
                    "delta": delta,
                    "key": key,
                },
            )
            if outcome != _SKIPPED:
                result = outcome
        return result

    def _enqueue(self, service: str, payload: dict) -> str:
        self._start_locked()
        try:
            self._queue.put_nowait((service, payload))
        except queue.Full:
            # Очередь переполнена — внешний сервис не успевает. Выбрасываем
            # событие, но НЕ блокируем разбор журнала: внешние API вторичны,
            # а подвисшая первичная загрузка — ровно то, на что жаловался
            # пользователь.
            self.stats["dropped"] += 1
            now = time.monotonic()
            if now - self._last_drop_warning > 30:
                self._last_drop_warning = now
                self._log(
                    f"Внешние API не успевают: очередь переполнена, "
                    f"пропущено событий — {self.stats['dropped']}"
                )
            return _DROPPED
        self.stats["queued"] += 1
        return _QUEUED

    # -- воркеры -----------------------------------------------------------
    def _start_locked(self):
        with self._lock:
            if self._started:
                return
            self._started = True
            for index in range(self.workers):
                thread = threading.Thread(
                    target=self._worker_loop,
                    name=f"third-party-dispatch-{index}",
                    daemon=True,
                )
                thread.start()
                self._threads.append(thread)

    def _worker_loop(self):
        while True:
            try:
                service, payload = self._queue.get(timeout=0.5)
            except queue.Empty:
                if self._stop_event.is_set():
                    return
                continue
            try:
                if service == "edsm":
                    self._do_edsm(payload)
                elif service == "inara":
                    self._do_inara(payload)
                elif service == "raven":
                    self._do_raven(payload)
            except Exception as exc:  # воркер не должен умирать из-за одного события
                self.stats["failed"] += 1
                self._log(f"Ошибка отправки в {service}: {exc}")
            finally:
                self._queue.task_done()

    def _do_edsm(self, payload: dict):
        if not self._edsm_enabled():
            return
        result = self.edsm_api.submit_event(payload["event"]) or {}
        if result.get("ok"):
            self.stats["sent"] += 1
            self._notify_success("edsm")
        else:
            self.stats["failed"] += 1
            self._notify_failure("edsm", str(result.get("error") or "EDSM отклонил событие"))

    def _do_inara(self, payload: dict):
        if not self._inara_enabled():
            return
        result = self.inara_api.submit(
            payload["event_name"], payload["data"], payload["timestamp"]
        ) or {}
        if result.get("ok"):
            self.stats["sent"] += 1
            self._notify_success("inara")
        elif result.get("error_kind") == "inara_not_whitelisted":
            self.stats["failed"] += 1
            if not self._inara_access_notified:
                self._inara_access_notified = True
                self._notify("inara", False, str(result.get("error") or ""))
        else:
            self.stats["failed"] += 1
            self._notify_failure("inara", str(result.get("error") or "Inara отклонила событие"))

    def _do_raven(self, payload: dict):
        if not self._raven_enabled():
            return
        if payload.get("kind") == "supply":
            self._do_raven_supply(payload)
            return
        result = self.raven_api.supply_fc(
            payload["market_id"], payload["commodity"], payload["delta"]
        ) or {}
        if result.get("ok"):
            self.stats["sent"] += 1
            with self._lock:
                self._seen["raven"].add(payload["key"])
            if result.get("already_exists"):
                self._notify(
                    "raven",
                    True,
                    f"Raven FC cargo: событие уже принято ранее "
                    f"({payload['commodity']} {payload['delta']:+d})",
                )
        else:
            self.stats["failed"] += 1
            self._notify("raven", False, str(result.get("error") or "Raven Colonial отклонил событие"))

    def _do_raven_supply(self, payload: dict):
        project = self.raven_api.get_project(
            payload.get("system_address") or 0, payload.get("market_id") or 0)
        build_id = str((project or {}).get("buildId") or "")
        if not build_id:
            self.stats["failed"] += 1
            self._notify("raven", False,
                         "Raven Colonial: не нашёл проект для обновления потребности")
            return
        result = self.raven_api.update_supply(
            build_id, payload.get("commodities") or {}, payload.get("max_need") or 0) or {}
        if result.get("ok"):
            self.stats["sent"] += 1
            self._notify("raven", True,
                         "Raven Colonial: потребность площадки обновлена по журналу")
        else:
            self.stats["failed"] += 1
            self._notify_failure("raven", str(result.get("error")
                                              or "Raven Colonial отклонил ProjectUpdate"))

    # -- состояние ---------------------------------------------------------
    def pending(self) -> int:
        return self._queue.qsize()

    def flush(self, timeout: float = None) -> bool:
        """Дождаться опустошения очереди. Возвращает True, если успели."""
        if not self._started:
            return True
        try:
            if timeout is None:
                self._queue.join()
                return True
            deadline = time.monotonic() + timeout
            while self._queue.unfinished_tasks:
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.05)
            return True
        except Exception:
            return False

    def snapshot_stats(self) -> dict:
        with self._lock:
            stats = dict(self.stats)
        stats["pending"] = self.pending()
        return stats

    def reset_stats(self):
        with self._lock:
            for key in self.stats:
                self.stats[key] = 0

    def stop(self, wait: bool = False, timeout: float = 2.0):
        self._stop_event.set()
        if wait:
            self.flush(timeout=timeout)
