"""Парсер журналов Elite Dangerous."""
import hashlib as _hashlib
import json as _std_json
from typing import List, Dict, Any, Optional, Tuple

# Классификация станции («это стройплощадка?») живёт в `colonisation`: там же
# её использует форма создания проекта, и там же — зеркало правил сайта
# (`src/lib/cargoScope.ts`). Парсер импортирует её, а не дублирует.
from colonisation import (
    CONSTRUCTION_STATION_KINDS,
    STATION_COLONISATION_SHIP,
    STATION_CONSTRUCTION_SITE,
    STATION_FLEET_CARRIER,
    STATION_UNKNOWN,
    classify_station,
)

# Опциональный быстрый JSON-декодер. orjson может давать заметное ускорение
# на файлах с большим числом строк (например, ColonisationConstructionDepot
# сыпется каждые несколько секунд рядом со стройплощадкой и может составлять
# многие тысячи строк в одном journal-файле). Если orjson не установлен —
# просто используем стандартный json, поведение не меняется.
try:
    import orjson as _fast_json

    def _loads(s: str):
        return _fast_json.loads(s)
except ImportError:
    def _loads(s: str):
        return _std_json.loads(s)

json = _std_json  # для обратной совместимости импортов (json.JSONDecodeError и т.п.)
# И orjson.JSONDecodeError, и json.JSONDecodeError — подклассы ValueError,
# поэтому ловим по нему, чтобы код одинаково работал с обоими декодерами.
_JSON_ERROR = ValueError

# Версия правил извлечения данных из журнала.
#
# Используется uploader'ом как часть ключа в локальном кэше «уже загруженных
# файлов»: если правила разбора меняются (новые/исправленные источники
# доставок), версия растёт, и старые записи кэша перестают подходить — файлы
# будут пере-импортированы, а не молча пропущены.
#
# 4 — появился `delivery_kind`/`station_kind`: `CargoDepot` больше не
#     считается стройкой сам по себе (это груз миссий), а стройка определяется
#     станцией, у которой сдан груз.
PARSER_VERSION = 4

#: Журнальные источники, которые считаются поставкой НА СТРОЙПЛОЩАДКУ
#: колонизационного проекта. Остальные (продажа на авианосце, грузовые
#: миссии, Powerplay, SAR) — это просто перевозимый груз: они попадают в
#: блок «всего тонн», но не в строительный тоннаж. Сайт хранит ровно это
#: же множество в `src/lib/journalParser.ts::CONSTRUCTION_SOURCES`.
#:
#: Это fallback для строк, где клиент не прислал ни `is_construction`, ни
#: `delivery_kind` (старые версии загрузчика). Сам парсер так больше не
#: решает: `cargo_depot` становится стройкой только у рынка стройплощадки.
CONSTRUCTION_SOURCES = frozenset({"colonisation_contribution", "cargo_depot"})

#: Виды сдачи груза (`deliveries.delivery_kind`). Значения обязаны совпадать
#: с `src/lib/cargoScope.ts::DeliveryKind`.
KIND_CONSTRUCTION_SITE = "construction_site"
KIND_COLONISATION_SHIP = "colonisation_ship"
KIND_FLEET_CARRIER = "fleet_carrier"
KIND_MISSION = "mission_delivery"
KIND_POWERPLAY = "powerplay_delivery"
KIND_RESCUE = "rescue_delivery"
KIND_MARKET_SALE = "market_sale"

#: Виды, попадающие в блок «завезено на стройплощадки» досье.
CONSTRUCTION_KINDS = frozenset({KIND_CONSTRUCTION_SITE, KIND_COLONISATION_SHIP})


def is_construction_source(source) -> bool:
    """Принадлежит ли источник к строительным поставкам."""
    return str(source or "").strip().lower() in CONSTRUCTION_SOURCES


def is_construction_kind(kind) -> bool:
    """Является ли вид сдачи груза строительным."""
    return str(kind or "").strip().lower() in CONSTRUCTION_KINDS


def _update_station(previous, ev) -> dict:
    """Обновить «где стоит командир» по событию журнала.

    Имя и тип станции — единственный способ отличить рынок стройплощадки от
    обычного порта, когда явного события поставки нет (груз «исчез» из трюма)
    или событие о получателе молчит (`CargoDepot`). Правила классификации —
    в `colonisation.classify_station`, общие с сайтом.
    """
    previous = previous or {}
    market_id = ev.get("MarketID")
    name = str(ev.get("StationName") or "").strip()
    stype = str(ev.get("StationType") or "").strip() or previous.get("type", "")
    kind = classify_station(
        station_name=name or previous.get("name"),
        station_type=ev.get("StationType"),
        station_services=ev.get("StationServices"),
        carrier_id=ev.get("CarrierID"),
    )
    return {
        "market_id": str(market_id or "") or previous.get("market_id", ""),
        "name": name or previous.get("name", ""),
        "type": stype,
        "kind": kind,
    }


def _station_kind_at(station, current_market_id, construction_markets) -> str:
    """Вид станции, у которой сдан груз.

    `ColonisationConstructionDepot` остаётся дополнительным признаком: рынок,
    про который журнал показывал состояние стройки, — точно стройплощадка,
    даже если `Docked` пришёл без имени станции.
    """
    kind = (station or {}).get("kind") or STATION_UNKNOWN
    if kind in CONSTRUCTION_STATION_KINDS:
        return kind
    for market in (current_market_id, (station or {}).get("market_id", "")):
        if market and str(market) in construction_markets:
            return STATION_CONSTRUCTION_SITE
    return kind


def build_inventory(inventory: list) -> dict:
    inv = {}
    if not isinstance(inventory, list):
        return inv
    for item in inventory:
        key = str(item.get("Name", "")).lower()
        if key and item.get("Count", 0) > 0:
            inv[key] = {
                "count": item["Count"],
                "display": str(item.get("Name_Localised") or item.get("Name") or key),
            }
    return inv


def _normalize_name(name: str) -> str:
    """Нормализовать имя ресурса: убрать $..._name; префикс."""
    if name.startswith("$") and "_name" in name:
        return name.split(";")[0].replace("$", "").replace("_name", "")
    return name


def _event_key(ev: dict) -> str:
    """Уникальный ключ события для дедупликации (не хеш строки)."""
    event = ev.get("event", "")
    ts = ev.get("timestamp", "")
    if event == "ColonisationContribution":
        market_id = ev.get("MarketID", 0)
        contributions = ",".join(
            f"{c.get('Name', c.get('Name_Localised', ''))}:{c.get('Amount', 0)}"
            for c in ev.get("Contributions", [])
        )
        return f"CC:{ts}:{market_id}:{contributions}"
    elif event == "CargoDepot":
        return f"CD:{ts}:{ev.get('CargoType', '')}:{ev.get('Count', 0)}"
    return f"{event}:{ts}"


def _source_hash(kind: str, line: str, *parts: object) -> str:
    """Stable, opaque id for one emitted delivery.

    The API can safely retry a bounded upload when a network/serverless request
    is interrupted. Include the raw journal line plus the emitted commodity
    context: a single ColonisationContribution event can emit several rows.
    """
    value = "\0".join([kind, line, *(str(part) for part in parts)])
    return "journal-v2-" + _hashlib.sha256(value.encode("utf-8")).hexdigest()


def iter_journal_events(text: str):
    """Однопроходный генератор пар ``(line, event)`` по тексту журнала.

    Зачем: раньше один и тот же текст журнала разбирался до трёх раз подряд —
    `parse_journal()` для доставок, `extract_construction_events()` для
    snapshots стройки и отдельный построчный цикл для отправки в EDSM/Inara.
    На первичной загрузке всей истории (сотни файлов) это многократно
    повторяло самую дорогую часть работы — JSON-разбор. Теперь файл
    разбирается один раз, и один и тот же поток событий отдаётся всем
    потребителям через hooks.
    """
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            ev = _loads(line)
        except _JSON_ERROR:
            continue
        if isinstance(ev, dict):
            yield line, ev


def parse_events(
    events,
    current_system: str = None,
    last_cargo: dict = None,
    last_depot_state: dict = None,
    last_contribution_state: dict = None,
    seen_events: set = None,
    current_system_address: int = 0,
    hooks: list = None,
) -> Tuple[Optional[str], List[dict], dict, dict, dict, set, Dict[str, int]]:
    """Разобрать поток уже распарсенных событий журнала.

    Возвращает (cmdr_name, deliveries, last_cargo, last_depot_state,
                last_contribution_state, seen_events, event_counts).

    Отличается от `parse_journal()` только источником: сюда передаётся
    итерируемый объект пар ``(line, event)`` (например, результат
    `iter_journal_events()`), поэтому разбор JSON происходит один раз на всё
    приложение, а не по разу на каждого потребителя.

    Args:
        events: Итератор пар ``(line, event)`` — см. `iter_journal_events`.
        hooks: Необязательный список callable ``hook(line, event)``, которые
            вызываются для КАЖДОГО корректного события журнала (до фильтрации
            дублей — так же, как раньше работали отдельные проходы по тексту).
            Используется, чтобы собрать snapshots стройки и отправить события
            во внешние API за тот же один проход. Исключение из hook'а не
            должно ломать разбор, поэтому гасится здесь.
        current_system: Текущая система из внешнего трекера (ship_tracker).
        last_cargo: Предыдущий инвентарь для разностного метода Cargo.
        last_depot_state: Snapshot ColonisationConstructionDepot для отображения прогресса.
        last_contribution_state: { (market_id, resource_name): prev_amount }
            для вычисления diff ColonisationContribution (накопительный Amount).
        seen_events: Set ключей уже обработанных событий (не строк).
        current_system_address: SystemAddress на момент начала обработки (из
            ship_tracker). Обновляется по ходу разбора при Location/FSDJump/
            Docked/CarrierJump и записывается в каждую доставку — так каждая
            доставка привязана к системе, в которой она реально произошла,
            а не к "текущей" системе на момент отправки батча на сервер
            (которая может быть уже другой, если игрок успел прыгнуть).

    event_counts — счётчик событий по типам (только реально обработанные,
    без дублей, отфильтрованных через seen_events) — используется для
    итоговой сводной таблицы после импорта.
    """
    cmdr_name = None
    if last_cargo is None:
        last_cargo = {}
    if last_depot_state is None:
        last_depot_state = {}
    if last_contribution_state is None:
        last_contribution_state = {}
    if seen_events is None:
        seen_events = set()
    # Площадки, по которым журнал показывал ColonisationConstructionDepot:
    # только падение Cargo рядом с таким MarketID считается сдачей на стройку.
    construction_markets = last_depot_state.get("_construction_markets")
    if not isinstance(construction_markets, set):
        construction_markets = set()
        last_depot_state["_construction_markets"] = construction_markets
    current_market_id = str(last_depot_state.get("_market_id", "") or "")

    # Станция, у которой стоит командир. Хранится в `last_depot_state`, чтобы
    # пережить ротацию `Journal.*.log`: пристыковка к стройплощадке и сдача
    # груза нередко попадают в разные файлы.
    current_station = last_depot_state.get("_station")
    if not isinstance(current_station, dict):
        current_station = {}
        last_depot_state["_station"] = current_station

    skip_next_cargo = False
    deliveries = []
    cargo_depot_items: set = set()
    event_counts: Dict[str, int] = {}

    for line, ev in events:
        # Хуки вызываются до фильтрации дублей — ровно так же, как раньше
        # работали отдельные проходы по тексту (extract_construction_events и
        # цикл отправки в EDSM/Inara видели все строки файла).
        if hooks:
            for hook in hooks:
                try:
                    hook(line, ev)
                except Exception:
                    continue

        # Дедупликация по событию (timestamp + market_id + amount), не по строке
        ekey = _event_key(ev)
        if ekey in seen_events:
            continue
        seen_events.add(ekey)

        event = ev.get("event") or "Unknown"
        event_counts[event] = event_counts.get(event, 0) + 1
        if event == "Commander" and ev.get("Name"):
            cmdr_name = ev["Name"]
        elif event == "LoadGame" and not cmdr_name and ev.get("Commander"):
            cmdr_name = ev["Commander"]
        elif event in ("Location", "FSDJump", "Docked", "CarrierJump"):
            if ev.get("StarSystem"):
                current_system = ev["StarSystem"]
            sys_addr = ev.get("SystemAddress")
            if sys_addr:
                current_system_address = int(sys_addr)
            if ev.get("StationType"):
                last_depot_state["_station_type"] = ev.get("StationType")
            if event == "Docked":
                # Рынок, к которому «пристыкован» груз: нужен, чтобы понять,
                # была ли следующая потеря Cargo сдачей на стройплощадку.
                current_market_id = str(ev.get("MarketID", "") or "")
            # Прыжок без станции — командир не у рынка: привязку к станции
            # обязательно сбрасываем, иначе следующий дифф трюма записался бы
            # на стройплощадку в системе, где игрока уже нет.
            docked_now = ev.get("Docked") is True or event in ("Docked", "CarrierJump")
            if docked_now:
                current_station = _update_station(current_station, ev)
                last_depot_state["_station"] = current_station
                if event == "Docked" and current_station.get("market_id"):
                    current_market_id = current_station["market_id"]
            else:
                current_station = {}
                last_depot_state["_station"] = current_station
                current_market_id = ""
        elif event == "Undocked":
            current_market_id = ""
            current_station = {}
            last_depot_state["_station"] = current_station
        elif event == "Market":
            last_depot_state["_station_type"] = ev.get("StationType", "")
            last_depot_state["_market_id"] = ev.get("MarketID", 0)
            current_market_id = str(ev.get("MarketID", "") or "")
            # `Market` приходит отдельно от `Docked`: без него рынок
            # стройплощадки остался бы неизвестным, если игрок открыл павильон
            # позже пристыковки.
            current_station = _update_station(current_station, ev)
            last_depot_state["_station"] = current_station
        elif event == "MarketSell":
            # Продажа груза — тоже перевезённый груз, но не поставка на стройку:
            # на стройплощадке груз сдаётся вкладом в колонизацию
            # (`ColonisationContribution`), а не продажей. На Fleet Carrier это
            # фактическая отгрузка (уходит в Raven Colonial отдельным путём),
            # в обычном павильоне — просто продажа на рынке.
            station_type = str(ev.get("StationType", "") or last_depot_state.get("_station_type", ""))
            is_carrier = bool(ev.get("CarrierID")) or "carrier" in station_type.lower()
            count = ev.get("Count", 0)
            if current_system and count > 0:
                commodity = ev.get("Type_Localised") or _normalize_name(ev.get("Type", "Unknown"))
                deliveries.append({
                    "system_name": current_system,
                    "commodity": commodity,
                    "amount": int(count),
                    "delivered_at": ev.get("timestamp"),
                    "market_id": ev.get("MarketID", 0),
                    "system_address": current_system_address,
                    "is_hub": None,
                    "route_system_id": None,
                    # `cargo_delta` для обычной продажи — тот же источник, что
                    # ставит сайт (`src/lib/journalParser.ts`): Raven Colonial
                    # его не трогает, а досье видит «перевезено».
                    "source": "carrier_delivery" if is_carrier else "cargo_delta",
                    "delivery_kind": KIND_FLEET_CARRIER if is_carrier else KIND_MARKET_SALE,
                    "station_name": current_station.get("name") or None,
                    "station_kind": current_station.get("kind") or None,
                    "is_construction": False,
                    "source_hash": _source_hash(
                        "carrier" if is_carrier else "sell", line, commodity, count
                    ),
                })
            skip_next_cargo = True
        elif event in (
            "MarketBuy", "BuyDrones", "SellDrones",
            "MiningRefined", "EjectCargo", "CollectCargo",
            "MissionCompleted", "Died", "Interdicted", "Interdiction",
            "TransferMicroResources", "TransferCargo", "CargoTransfer",
            "CommunityGoal", "CommunityGoalReward",
            "PowerplayCollect", "PowerplayDeliver", "PowerplayFastTrack",
            "LaunchSRV", "DockSRV",
            "CarrierDepositFuel", "CarrierJumpRequest",
            "ShipyardTransfer", "ShipyardSwap",
        ):
            skip_next_cargo = True
        elif event == "ColonisationContribution":
            # ПРЯМАЯ доставка игрока на колонизационную стройплощадку.
            # Amount в этом событии НАКОПИТЕЛЬНЫЙ — растёт с каждой новой доставкой.
            # Вычисляем diff с предыдущим Amount для каждого ресурса.
            if current_system:
                market_id = ev.get("MarketID", 0)
                contributions = ev.get("Contributions", [])
                for contrib in contributions:
                    # Берём `Name` — это FDName-токен («$liquidoxygen_name;»),
                    # из которого _normalize_name даёт каноническое имя, какого
                    # ждёт Raven Colonial. `Name_Localised` («Liquid oxygen»)
                    # языкозависим и содержит пробелы: после normalize_commodity
                    # он превращается в «liquid oxygen», а не в «liquidoxygen»,
                    # и доставка не зачитывается. Локализованное имя оставляем
                    # только как запасной вариант, когда токена в событии нет.
                    name = (
                        _normalize_name(contrib.get("Name") or "")
                        or contrib.get("Name_Localised")
                        or "Unknown"
                    )
                    amount = int(contrib.get("Amount", 0) or 0)
                    if amount <= 0:
                        continue
                    # SrvSurvey confirms that ColonisationContribution.Amount
                    # is the amount contributed by this event, not a cumulative
                    # project total. Subtracting the previous event caused the
                    # second and subsequent deliveries to disappear.
                    # Куда именно сдано: стройплощадка или колонизационный
                    # корабль (первый порт системы). Оба — строительный тоннаж.
                    kind = KIND_COLONISATION_SHIP if _station_kind_at(
                        current_station, current_market_id, construction_markets,
                    ) == STATION_COLONISATION_SHIP else KIND_CONSTRUCTION_SITE
                    deliveries.append({
                        "system_name": current_system,
                        "commodity": name,
                        "amount": amount,
                        "delivered_at": ev.get("timestamp"),
                        "market_id": market_id,
                        "system_address": current_system_address,
                        "is_hub": None,
                        "route_system_id": None,
                        "source": "colonisation_contribution",
                        "delivery_kind": kind,
                        "station_name": current_station.get("name") or None,
                        "station_kind": current_station.get("kind") or None,
                        "is_construction": True,
                        "source_hash": _source_hash("contribution", line, name, amount),
                    })
        elif event == "CargoDepot":
            # Грузовой склад миссии (в том числе крыльевой Cargo Run). Стройкой
            # он становится только у рынка стройплощадки/колонизационного
            # корабля: иначе тоннаж миссий молча записывался колонизационным.
            if current_system:
                update_type = ev.get("UpdateType", "")
                count = ev.get("Count", 0)
                if update_type == "Deliver" and count > 0:
                    cargo_type = ev.get("CargoType_Localised") or ev.get("CargoType", "Unknown")
                    station_kind = _station_kind_at(
                        current_station, current_market_id, construction_markets,
                    )
                    if station_kind in CONSTRUCTION_STATION_KINDS:
                        depot_kind = (
                            KIND_COLONISATION_SHIP
                            if station_kind == STATION_COLONISATION_SHIP
                            else KIND_CONSTRUCTION_SITE
                        )
                    elif station_kind == STATION_FLEET_CARRIER:
                        depot_kind = KIND_FLEET_CARRIER
                    else:
                        depot_kind = KIND_MISSION
                    deliveries.append({
                        "system_name": current_system,
                        "commodity": cargo_type,
                        "amount": count,
                        "delivered_at": ev.get("timestamp"),
                        "market_id": ev.get("MarketID", 0) or (current_market_id or None),
                        "system_address": current_system_address,
                        "is_hub": None,
                        "route_system_id": None,
                        "source": "cargo_depot",
                        "delivery_kind": depot_kind,
                        "station_name": current_station.get("name") or None,
                        "station_kind": station_kind or None,
                        "is_construction": is_construction_kind(depot_kind),
                        "source_hash": _source_hash("cargo-depot", line, cargo_type, count),
                    })
                    cargo_depot_items.add(str(ev.get("CargoType", "")).lower())
        elif event == "ColonisationConstructionDepot":
            # Обновляем snapshot для отображения прогресса, НО НЕ создаём доставки.
            # ProvidedAmount включает груз ВСЕХ игроков — diff считал бы чужой груз.
            if current_system:
                new_depot_state = {
                    key: last_depot_state[key]
                    for key in ("_station_type", "_market_id", "_construction_markets")
                    if key in last_depot_state
                }
                depot_market = str(ev.get("MarketID", "") or "")
                if depot_market:
                    new_depot_state.setdefault("_construction_markets", construction_markets)
                    construction_markets.add(depot_market)
                resources = ev.get("ResourcesRequired", [])
                for res in resources:
                    name = res.get("Name_Localised") or _normalize_name(res.get("Name", ""))
                    provided = res.get("ProvidedAmount", 0)
                    new_depot_state[name] = provided
                last_depot_state = new_depot_state
        elif event == "Cargo":
            if skip_next_cargo:
                skip_next_cargo = False
                last_cargo = build_inventory(ev.get("Inventory"))
                cargo_depot_items.clear()
                continue
            inv = build_inventory(ev.get("Inventory"))
            if last_cargo and current_system:
                for key, prev in last_cargo.items():
                    now = inv.get(key, {"count": 0})
                    now_count = now["count"]
                    if now_count < prev["count"]:
                        # Пропускаем, если уже учтено через CargoDepot
                        if key in cargo_depot_items:
                            continue
                        # Дифференциальный метод не знает, КУДА ушёл груз:
                        # решает станция, у которой стоит командир. У рынка
                        # стройплощадки или колонизационного корабля это
                        # поставка на стройку, у авианосца — отгрузка,
                        # в обычном павильоне — продажа.
                        delta_station = _station_kind_at(
                            current_station, current_market_id, construction_markets,
                        )
                        if delta_station in CONSTRUCTION_STATION_KINDS:
                            delta_kind = (
                                KIND_COLONISATION_SHIP
                                if delta_station == STATION_COLONISATION_SHIP
                                else KIND_CONSTRUCTION_SITE
                            )
                        elif delta_station == STATION_FLEET_CARRIER:
                            delta_kind = KIND_FLEET_CARRIER
                        else:
                            delta_kind = KIND_MARKET_SALE
                        deliveries.append({
                            "system_name": current_system,
                            "commodity": prev["display"],
                            "amount": prev["count"] - now_count,
                            "delivered_at": ev.get("timestamp"),
                            "system_address": current_system_address,
                            "is_hub": None,
                            "route_system_id": None,
                            "source": "cargo_delta",
                            "delivery_kind": delta_kind,
                            "station_name": current_station.get("name") or None,
                            "station_kind": delta_station or None,
                            "is_construction": is_construction_kind(delta_kind),
                            "source_hash": _source_hash("cargo-delta", line, key, prev["count"], now_count),
                        })
            last_cargo = inv
            cargo_depot_items.clear()

    return cmdr_name, deliveries, last_cargo, last_depot_state, last_contribution_state, seen_events, event_counts


def parse_journal(
    text: str,
    current_system: str = None,
    last_cargo: dict = None,
    last_depot_state: dict = None,
    last_contribution_state: dict = None,
    seen_events: set = None,
    current_system_address: int = 0,
    hooks: list = None,
) -> Tuple[Optional[str], List[dict], dict, dict, dict, set, Dict[str, int]]:
    """Разобрать текст Journal.*.log (совместимая обёртка над parse_events)."""
    return parse_events(
        iter_journal_events(text),
        current_system,
        last_cargo,
        last_depot_state,
        last_contribution_state,
        seen_events,
        current_system_address,
        hooks,
    )


def _construction_signature(event: dict) -> tuple:
    """Сигнатура состояния стройплощадки для отсева одинаковых snapshots."""
    resources = event.get("resources_total")
    if isinstance(resources, list):
        fingerprint = "|".join(
            "{0}:{1}:{2}".format(
                res.get("Name") if isinstance(res, dict) else res,
                res.get("RequiredAmount") if isinstance(res, dict) else "",
                res.get("ProvidedAmount") if isinstance(res, dict) else "",
            )
            for res in resources
        )
    else:
        fingerprint = ""
    return (
        event.get("system_name"),
        event.get("market_id"),
        event.get("construction_id"),
        event.get("construction_progress"),
        event.get("construction_name"),
        fingerprint,
    )


class ConstructionSnapshotCollector:
    """Собирает snapshots `ColonisationConstructionDepot`, отбрасывая дубли.

    Пока игрок находится у стройплощадки, журнал пишет это событие каждые
    несколько секунд. В реальном журнале из обращения пользователя их было
    4990 штук в ОДНОМ файле, а по всей истории — многие тысячи, при этом само
    состояние (прогресс + объёмы ресурсов) меняется в разы реже. Каждый такой
    snapshot уходил на сайт отдельной строкой (лимит API — 100 за запрос, т.е.
    десятки последовательных запросов только под это).

    Здесь остаются только те snapshots, у которых реально изменилось состояние
    стройки: система, MarketID, ConstructionID, прогресс, имя или объёмы
    ресурсов. Остальное — шум, который сервер всё равно схлопывает upsert'ом
    по (user, timestamp, system, construction_id).
    """

    def __init__(self):
        self.events: List[dict] = []
        self.duplicates = 0
        self.seen = 0
        self._current_system = None
        self._last_signature = None

    def __call__(self, line: str, ev: dict):
        event_name = ev.get("event")
        # Систему отслеживаем так же, как extract_construction_events():
        # она нужна как fallback, если в самом событии поля StarSystem нет.
        if event_name in ("Location", "FSDJump", "Docked", "CarrierJump") and ev.get("StarSystem"):
            self._current_system = ev.get("StarSystem")
        if event_name != "ColonisationConstructionDepot":
            return
        self.seen += 1
        event = _construction_event_from(ev, self._current_system)
        if event is None:
            return
        signature = _construction_signature(event)
        if signature == self._last_signature:
            self.duplicates += 1
            return
        self._last_signature = signature
        self.events.append(event)


def _construction_event_from(ev: dict, current_system: str = None) -> Optional[dict]:
    """Собрать один snapshot стройплощадки из события журнала."""
    system = ev.get("StarSystem") or current_system
    if not system:
        return None
    resources = ev.get("ResourcesRequired")
    if not isinstance(resources, list):
        resources = []
    return {
        "timestamp": ev.get("timestamp"),
        "system_name": str(system),
        "market_id": ev.get("MarketID"),
        "construction_name": ev.get("ConstructionName") or ev.get("Name"),
        "construction_id": ev.get("ConstructionID"),
        "construction_progress": ev.get("ConstructionProgress", ev.get("Progress")),
        "resources_total": resources,
        "raw_event": ev,
    }


def site_deliveries_from_text(
    text: str,
    market_id: Optional[int] = None,
    current_system: Optional[str] = None,
    current_system_address: int = 0,
) -> List[dict]:
    """Доставки на стройплощадку из текста журнала (`ColonisationContribution`).

    Отдельный проход нужен сверке с Raven Colonial: «что я реально завёз на
    эту площадку по журналу» против «сколько осталось завезти» по данным
    сервиса (там учтён и груз других командиров). Живой watcher собирает те же
    доставки в `parse_events()`.

    Записи получаются ровно того же вида и с тем же `source_hash`, что и у
    `parse_events()` — поэтому журнал отправленного в Raven Colonial
    (`_raven_sent`) узнаёт их и не даёт зачесть одну доставку дважды, каким бы
    путём она ни была найдена.

    Args:
        text: текст журнала (или его хвост).
        market_id: если задан — только доставки этой площадки.
        current_system: система для подписи (в событии её может не быть).
        current_system_address: SystemAddress, если в событии его нет.
    """
    wanted = 0
    if market_id:
        try:
            wanted = int(market_id)
        except (TypeError, ValueError):
            wanted = 0

    result: List[dict] = []
    for line, ev in iter_journal_events(text):
        if ev.get("event") != "ColonisationContribution":
            continue
        try:
            event_market = int(ev.get("MarketID") or 0)
        except (TypeError, ValueError):
            event_market = 0
        if wanted and event_market != wanted:
            continue
        system = ev.get("StarSystem") or current_system or ""
        address = ev.get("SystemAddress") or current_system_address or 0
        for contrib in ev.get("Contributions") or []:
            if not isinstance(contrib, dict):
                continue
            # `Name` — FDName-токен: из него получается каноническое имя,
            # которое ждёт Raven Colonial (`liquidoxygen`, а не «Liquid oxygen»).
            name = (
                _normalize_name(contrib.get("Name") or "")
                or contrib.get("Name_Localised")
                or "Unknown"
            )
            try:
                amount = int(contrib.get("Amount", 0) or 0)
            except (TypeError, ValueError):
                amount = 0
            if amount <= 0:
                continue
            result.append({
                "system_name": system,
                "commodity": name,
                "amount": amount,
                "delivered_at": ev.get("timestamp"),
                "market_id": event_market,
                "system_address": address,
                "is_hub": None,
                "route_system_id": None,
                "source": "colonisation_contribution",
                "source_hash": _source_hash("contribution", line, name, amount),
            })
    return result


def extract_construction_events_from_events(events) -> List[dict]:
    """Извлечь snapshots строительства из уже распарсенных событий.

    `events` — итератор пар (line, event), как у `parse_events()`.
    """
    result: List[dict] = []
    current_system = None
    for _line, ev in events:
        event_name = ev.get("event")
        if event_name in ("Location", "FSDJump", "Docked", "CarrierJump") and ev.get("StarSystem"):
            current_system = ev.get("StarSystem")
        if event_name != "ColonisationConstructionDepot":
            continue
        event = _construction_event_from(ev, current_system)
        if event is not None:
            result.append(event)
    return result


def extract_construction_events(text: str) -> List[dict]:
    """Извлечь публичные snapshots строительства для ED Ring Colony.

    Это не доставки игрока: ConstructionDepot содержит общий прогресс
    стройплощадки и может использоваться сайтом для графика проекта.
    """
    return extract_construction_events_from_events(iter_journal_events(text))


def parse_file(
    filepath: str,
    current_system: str = None,
    last_cargo: dict = None,
    last_depot_state: dict = None,
    last_contribution_state: dict = None,
    seen_events: set = None,
    current_system_address: int = 0,
) -> Tuple[Optional[str], List[dict], dict, dict, dict, set, Dict[str, int]]:
    """Разобрать файл журнала."""
    with open(filepath, "r", encoding="utf-8") as f:
        return parse_journal(
            f.read(), current_system, last_cargo, last_depot_state,
            last_contribution_state, seen_events, current_system_address,
        )
