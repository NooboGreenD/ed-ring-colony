"""Парсер журналов Elite Dangerous."""
import hashlib as _hashlib
import json as _std_json
from typing import List, Dict, Any, Optional, Tuple

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
        total = sum(c.get("Amount", 0) for c in ev.get("Contributions", []))
        return f"CC:{ts}:{market_id}:{total}"
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


def parse_journal(
    text: str,
    current_system: str = None,
    last_cargo: dict = None,
    last_depot_state: dict = None,
    last_contribution_state: dict = None,
    seen_events: set = None,
    current_system_address: int = 0,
) -> Tuple[Optional[str], List[dict], dict, dict, dict, set, Dict[str, int]]:
    """Разобрать текст Journal.*.log.

    Возвращает (cmdr_name, deliveries, last_cargo, last_depot_state,
                last_contribution_state, seen_events, event_counts).

    Args:
        text: Текст журнала.
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
    skip_next_cargo = False
    deliveries = []
    cargo_depot_items: set = set()
    event_counts: Dict[str, int] = {}

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or not line.startswith("{"):
            continue

        try:
            ev = _loads(line)
        except _JSON_ERROR:
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
        elif event == "Market":
            last_depot_state["_station_type"] = ev.get("StationType", "")
            last_depot_state["_market_id"] = ev.get("MarketID", 0)
        elif event == "MarketSell":
            # Продажа груза на Fleet Carrier — это фактическая отгрузка.
            # Раньше MarketSell всегда подавлял следующий Cargo-снимок и
            # поэтому не попадал ни в основной uploader, ни в Raven Colonial.
            station_type = str(ev.get("StationType", "") or last_depot_state.get("_station_type", ""))
            is_carrier = bool(ev.get("CarrierID")) or "carrier" in station_type.lower()
            count = ev.get("Count", 0)
            if current_system and is_carrier and count > 0:
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
                    "source": "carrier_delivery",
                    "source_hash": _source_hash("carrier", line, commodity, count),
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
                    name = contrib.get("Name_Localised") or _normalize_name(contrib.get("Name", "Unknown"))
                    amount = contrib.get("Amount", 0)
                    if amount <= 0:
                        continue
                    key = (market_id, name)
                    prev_amount = last_contribution_state.get(key, 0)
                    delta = amount - prev_amount
                    if delta > 0:
                        deliveries.append({
                            "system_name": current_system,
                            "commodity": name,
                            "amount": delta,
                            "delivered_at": ev.get("timestamp"),
                            "market_id": market_id,
                            "system_address": current_system_address,
                            "is_hub": None,
                            "route_system_id": None,
                            "source": "colonisation_contribution",
                            "source_hash": _source_hash("contribution", line, name, delta),
                        })
                    last_contribution_state[key] = amount
        elif event == "CargoDepot":
            # Wing mission delivery
            if current_system:
                update_type = ev.get("UpdateType", "")
                count = ev.get("Count", 0)
                if update_type == "Deliver" and count > 0:
                    cargo_type = ev.get("CargoType_Localised") or ev.get("CargoType", "Unknown")
                    deliveries.append({
                        "system_name": current_system,
                        "commodity": cargo_type,
                        "amount": count,
                        "delivered_at": ev.get("timestamp"),
                        "system_address": current_system_address,
                        "is_hub": None,
                        "route_system_id": None,
                        "source": "cargo_depot",
                        "source_hash": _source_hash("cargo-depot", line, cargo_type, count),
                    })
                    cargo_depot_items.add(str(ev.get("CargoType", "")).lower())
        elif event == "ColonisationConstructionDepot":
            # Обновляем snapshot для отображения прогресса, НО НЕ создаём доставки.
            # ProvidedAmount включает груз ВСЕХ игроков — diff считал бы чужой груз.
            if current_system:
                new_depot_state = {
                    key: last_depot_state[key]
                    for key in ("_station_type", "_market_id")
                    if key in last_depot_state
                }
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
                        deliveries.append({
                            "system_name": current_system,
                            "commodity": prev["display"],
                            "amount": prev["count"] - now_count,
                            "delivered_at": ev.get("timestamp"),
                            "system_address": current_system_address,
                            "is_hub": None,
                            "route_system_id": None,
                            "source": "cargo_delta",
                            "source_hash": _source_hash("cargo-delta", line, key, prev["count"], now_count),
                        })
            last_cargo = inv
            cargo_depot_items.clear()

    return cmdr_name, deliveries, last_cargo, last_depot_state, last_contribution_state, seen_events, event_counts


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
