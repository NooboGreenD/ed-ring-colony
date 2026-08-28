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


def parse_journal(text: str) -> Tuple[Optional[str], List[dict]]:
    """Разобрать текст Journal.*.log. Возвращает (cmdr_name, deliveries)."""
    cmdr_name = None
    current_system = None
    last_cargo = None
    skip_next_cargo = False
    deliveries = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue

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
        ):
            skip_next_cargo = True
        elif event == "Cargo":
            if skip_next_cargo:
                skip_next_cargo = False
                last_cargo = build_inventory(ev.get("Inventory"))
                continue
            inv = build_inventory(ev.get("Inventory"))
            if last_cargo and current_system:
                for key, prev in last_cargo.items():
                    now = inv.get(key, {"count": 0})
                    now_count = now["count"]
                    if now_count < prev["count"]:
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

    return cmdr_name, deliveries


def parse_file(filepath: str) -> Tuple[Optional[str], List[dict]]:
    """Разобрать файл журнала."""
    with open(filepath, "r", encoding="utf-8") as f:
        return parse_journal(f.read())
