"""Парсер журналов Elite Dangerous."""
import json
from typing import List, Dict, Any, Optional, Tuple


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


def parse_journal(
    text: str,
    current_system: str = None,
    last_cargo: dict = None,
    last_depot_state: dict = None,
    last_contribution_state: dict = None,
    seen_events: set = None,
) -> Tuple[Optional[str], List[dict], dict, dict, dict, set]:
    """Разобрать текст Journal.*.log.

    Возвращает (cmdr_name, deliveries, last_cargo, last_depot_state,
                last_contribution_state, seen_events).

    Args:
        text: Текст журнала.
        current_system: Текущая система из внешнего трекера (ship_tracker).
        last_cargo: Предыдущий инвентарь для разностного метода Cargo.
        last_depot_state: Snapshot ColonisationConstructionDepot для отображения прогресса.
        last_contribution_state: { (market_id, resource_name): prev_amount }
            для вычисления diff ColonisationContribution (накопительный Amount).
        seen_events: Set ключей уже обработанных событий (не строк).
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

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or not line.startswith("{"):
            continue

        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Дедупликация по событию (timestamp + market_id + amount), не по строке
        ekey = _event_key(ev)
        if ekey in seen_events:
            continue
        seen_events.add(ekey)

        event = ev.get("event")
        if event == "Commander" and ev.get("Name"):
            cmdr_name = ev["Name"]
        elif event == "LoadGame" and not cmdr_name and ev.get("Commander"):
            cmdr_name = ev["Commander"]
        elif event in ("Location", "FSDJump", "Docked", "CarrierJump"):
            if ev.get("StarSystem"):
                current_system = ev["StarSystem"]
        elif event in (
            "MarketBuy", "MarketSell", "BuyDrones", "SellDrones",
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
                            "is_hub": None,
                            "route_system_id": None,
                            "source_hash": "",
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
                        "is_hub": None,
                        "route_system_id": None,
                        "source_hash": "",
                    })
                    cargo_depot_items.add(str(ev.get("CargoType", "")).lower())
        elif event == "ColonisationConstructionDepot":
            # Обновляем snapshot для отображения прогресса, НО НЕ создаём доставки.
            # ProvidedAmount включает груз ВСЕХ игроков — diff считал бы чужой груз.
            if current_system:
                new_depot_state = {}
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
                            "is_hub": None,
                            "route_system_id": None,
                            "source_hash": "",
                        })
            last_cargo = inv
            cargo_depot_items.clear()

    return cmdr_name, deliveries, last_cargo, last_depot_state, last_contribution_state, seen_events


def parse_file(
    filepath: str,
    current_system: str = None,
    last_cargo: dict = None,
    last_depot_state: dict = None,
    last_contribution_state: dict = None,
    seen_events: set = None,
) -> Tuple[Optional[str], List[dict], dict, dict, dict, set]:
    """Разобрать файл журнала."""
    with open(filepath, "r", encoding="utf-8") as f:
        return parse_journal(f.read(), current_system, last_cargo, last_depot_state, last_contribution_state, seen_events)
