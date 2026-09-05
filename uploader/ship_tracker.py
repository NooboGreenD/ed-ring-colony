"""Отслеживание состояния корабля Elite Dangerous."""
import json
from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field


@dataclass
class ShipModule:
    """Модуль корабля."""
    slot: str
    name: str
    health: float = 1.0  # 0.0 - 1.0
    priority: int = 0
    on: bool = True
    engineered: bool = False
    power: float = 0.0


@dataclass
class ShipState:
    """Состояние корабля."""
    ship_type: str = "Unknown"
    ship_name: str = ""
    ship_ident: str = ""
    current_system: str = ""
    system_address: int = 0
    hull_health: float = 1.0  # 0.0 - 1.0
    shield_health: float = 1.0
    fuel_level: float = 0.0
    fuel_capacity: float = 0.0
    fuel_reservoir: float = 0.0
    cargo_capacity: int = 0
    cargo_count: int = 0
    rebuy: int = 0
    balance: int = 0
    legal_state: str = "Clean"
    pips_sys: int = 0
    pips_eng: int = 0
    pips_wep: int = 0
    fire_group: int = 0
    gui_focus: int = 0
    destination_system: str = ""
    destination_body: str = ""
    destination_name: str = ""
    power_used: float = 0.0
    power_capacity: float = 0.0
    flags: int = 0
    flags2: int = 0
    modules: Dict[str, ShipModule] = field(default_factory=dict)
    inventory: List[Dict[str, Any]] = field(default_factory=list)
    last_update: str = ""

    @property
    def hull_percent(self) -> int:
        return int(self.hull_health * 100)

    @property
    def shield_percent(self) -> int:
        return int(self.shield_health * 100)

    @property
    def fuel_percent(self) -> int:
        try:
            cap = float(self.fuel_capacity)
            if cap > 0:
                return int((float(self.fuel_level) / cap) * 100)
        except (TypeError, ValueError):
            pass
        return 0

    @property
    def power_percent(self) -> int:
        if self.power_capacity > 0:
            return int((self.power_used / self.power_capacity) * 100)
        return 0

    @property
    def damaged_modules(self) -> List[ShipModule]:
        return [m for m in self.modules.values() if m.health < 1.0]

    @property
    def critical_modules(self) -> List[ShipModule]:
        return [m for m in self.modules.values() if m.health < 0.5]


# ED Status flags
STATUS_FLAGS = {
    0: "Docked",
    1: "Landed",
    2: "Gear",
    3: "Shields",
    4: "Supercruise",
    5: "FAOff",
    6: "Hardpoints",
    7: "Wing",
    8: "Lights",
    9: "CargoScoop",
    10: "Silent",
    11: "Scooping",
    12: "SRVBrake",
    13: "SRVTurret",
    14: "SRVBay",
    15: "SRVAssist",
    16: "MassLock",
    17: "FsdCharging",
    18: "FsdCooldown",
    19: "LowFuel",
    20: "Overheat",
    21: "LatLong",
    22: "Danger",
    23: "Interdicted",
    24: "MainShip",
    25: "Fighter",
    26: "SRV",
    27: "Analysis",
    28: "NV",
    29: "AltRadius",
    30: "FsdJump",
    31: "SRVBeam",
}

STATUS_FLAGS2 = {
    0: "OnFoot",
    1: "Taxi",
    2: "MultiCrew",
    3: "FootStation",
    4: "FootPlanet",
    5: "ADS",
    6: "LowO2",
    7: "LowHealth",
    8: "Cold",
    9: "Hot",
    10: "VeryCold",
    11: "VeryHot",
    12: "Glide",
    13: "FootHangar",
    14: "FootSocial",
    15: "FootExterior",
    16: "Atmosphere",
    17: "Telepresence",
    18: "PhysicalMC",
    19: "FsdHyper",
    20: "FsdTransit",
}


def decode_status_flags(flags: int, flags2: int = 0) -> List[str]:
    """Декодировать флаги состояния в список строк."""
    result = []
    for bit, name in STATUS_FLAGS.items():
        if flags & (1 << bit):
            result.append(name)
    for bit, name in STATUS_FLAGS2.items():
        if flags2 & (1 << bit):
            result.append(name)
    return result


class ShipTracker:
    """Отслеживает состояние корабля из журналов и JSON-файлов."""

    def __init__(self):
        self.state = ShipState()
        self._callbacks: List[callable] = []

    def on_update(self, callback: callable):
        self._callbacks.append(callback)

    def _notify(self):
        for cb in self._callbacks:
            try:
                cb(self.state)
            except Exception:
                pass

    def parse_event(self, ev: dict):
        """Обработать одно событие журнала."""
        event = ev.get("event")
        if not event:
            return

        # Отслеживание текущей системы
        if event in ("Location", "FSDJump", "Docked", "CarrierJump"):
            sys_name = ev.get("StarSystem")
            if sys_name:
                self.state.current_system = sys_name
            sys_addr = ev.get("SystemAddress")
            if sys_addr:
                self.state.system_address = int(sys_addr)

        updated = False

        if event == "Loadout":
            updated |= self._handle_loadout(ev)
        elif event == "Status":
            updated |= self._handle_status(ev)
        elif event == "ModuleInfo":
            updated |= self._handle_module_info(ev)
        elif event == "HullDamage":
            updated |= self._handle_hull_damage(ev)
        elif event == "HeatDamage":
            updated |= self._handle_heat_damage(ev)
        elif event == "ShieldState":
            updated |= self._handle_shield_state(ev)
        elif event == "ModuleDamage":
            updated |= self._handle_module_damage(ev)
        elif event == "CockpitBreached":
            updated |= self._handle_cockpit_breached(ev)
        elif event == "Repair":
            updated |= self._handle_repair(ev)
        elif event == "RepairAll":
            updated |= self._handle_repair_all(ev)
        elif event == "AfmuRepairs":
            updated |= self._handle_afmu_repair(ev)
        elif event == "RebootRepair":
            updated |= self._handle_reboot_repair(ev)
        elif event == "LoadGame":
            updated |= self._handle_load_game(ev)
        elif event == "ShipTargeted":
            pass
        elif event == "ModuleBuy":
            updated |= self._handle_module_buy(ev)
        elif event == "ModuleSell":
            updated |= self._handle_module_sell(ev)
        elif event == "ModuleSwap":
            updated |= self._handle_module_swap(ev)
        elif event == "Cargo":
            updated |= self._handle_cargo(ev)
        elif event == "ReservoirReplenished":
            updated |= self._handle_reservoir_replenished(ev)
        elif event == "RefuelAll":
            updated |= self._handle_refuel_all(ev)
        elif event == "RefuelPartial":
            updated |= self._handle_refuel_partial(ev)

        if updated:
            self.state.last_update = ev.get("timestamp", "")
            self._notify()

    def _handle_loadout(self, ev: dict) -> bool:
        self.state.ship_type = ev.get("Ship", self.state.ship_type)
        name = ev.get("ShipName", self.state.ship_name)
        if isinstance(name, str):
            self.state.ship_name = name.strip()
        self.state.ship_ident = ev.get("ShipIdent", self.state.ship_ident)
        self.state.hull_health = ev.get("HullHealth", self.state.hull_health)
        # ShieldHealth: если в Loadout нет, определим по наличию ShieldGenerator
        sh = ev.get("ShieldHealth")
        if sh is not None:
            self.state.shield_health = float(sh)
        self.state.fuel_level = ev.get("FuelLevel", self.state.fuel_level)
        # FuelCapacity может быть dict {"Main": X, "Reserve": Y} или float
        fc = ev.get("FuelCapacity", self.state.fuel_capacity)
        if isinstance(fc, dict):
            self.state.fuel_capacity = float(fc.get("Main", 0))
        elif isinstance(fc, (int, float)):
            self.state.fuel_capacity = float(fc)
        self.state.cargo_capacity = ev.get("CargoCapacity", self.state.cargo_capacity)
        self.state.rebuy = ev.get("Rebuy", self.state.rebuy)

        modules = ev.get("Modules", [])
        self.state.modules.clear()
        for m in modules:
            slot = str(m.get("Slot", "Unknown"))
            name = str(m.get("Item", "Unknown"))
            health = float(m.get("Health", 1.0))
            priority = int(m.get("Priority", 0))
            on = bool(m.get("On", True))
            engineered = bool(m.get("Engineering"))
            power = float(m.get("Power", 0.0))

            self.state.modules[slot] = ShipModule(
                slot=slot,
                name=name,
                health=health,
                priority=priority,
                on=on,
                engineered=engineered,
                power=power,
            )
        # Если ShieldHealth не было в Loadout, проверяем наличие ShieldGenerator
        if sh is None:
            has_shield = any(
                "shieldgenerator" in m.name.lower() or m.slot == "Slot08_Size3"
                for m in self.state.modules.values()
            )
            if not has_shield:
                self.state.shield_health = 0.0
        self._recalc_power()
        return True

    def _handle_status(self, ev: dict) -> bool:
        """Обработать событие Status из журнала или Status.json."""
        updated = False
        hull = ev.get("HullHealth")
        if hull is not None:
            self.state.hull_health = float(hull)
            updated = True

        pips = ev.get("Pips")
        if pips and isinstance(pips, list) and len(pips) >= 3:
            self.state.pips_sys = int(pips[0])
            self.state.pips_eng = int(pips[1])
            self.state.pips_wep = int(pips[2])
            updated = True

        fuel = ev.get("Fuel")
        if fuel and isinstance(fuel, dict):
            main = fuel.get("FuelMain")
            if main is not None:
                self.state.fuel_level = float(main)
                updated = True
            res = fuel.get("FuelReservoir")
            if res is not None:
                self.state.fuel_reservoir = float(res)
                updated = True
        elif "Fuel" in ev and isinstance(ev["Fuel"], (int, float)):
            self.state.fuel_level = float(ev["Fuel"])
            updated = True

        cargo = ev.get("Cargo")
        if cargo is not None:
            self.state.cargo_count = int(cargo)
            updated = True

        legal = ev.get("LegalState")
        if legal:
            self.state.legal_state = str(legal)
            updated = True

        balance = ev.get("Balance")
        if balance is not None:
            self.state.balance = int(balance)
            updated = True

        fg = ev.get("FireGroup")
        if fg is not None:
            self.state.fire_group = int(fg)
            updated = True

        gui = ev.get("GuiFocus")
        if gui is not None:
            self.state.gui_focus = int(gui)
            updated = True

        dest = ev.get("Destination")
        if dest and isinstance(dest, dict):
            self.state.destination_system = str(dest.get("System", ""))
            self.state.destination_body = str(dest.get("Body", ""))
            self.state.destination_name = str(dest.get("Name", ""))
            updated = True

        flags = ev.get("Flags")
        if flags is not None:
            self.state.flags = int(flags)
            updated = True

        flags2 = ev.get("Flags2")
        if flags2 is not None:
            self.state.flags2 = int(flags2)
            updated = True

        return updated

    def _handle_module_info(self, ev: dict) -> bool:
        modules = ev.get("Modules", [])
        for m in modules:
            slot = str(m.get("Slot", ""))
            if not slot:
                continue
            # Создать модуль, если его ещё нет (например, из ModulesInfo.json)
            if slot not in self.state.modules:
                name = str(m.get("Item", "Unknown"))
                self.state.modules[slot] = ShipModule(slot=slot, name=name)
            # Обновить поля
            health = m.get("Health")
            if health is not None:
                new_health = float(health)
                current_health = self.state.modules[slot].health
                # Не "чиним" модули из устаревших данных:
                # ModuleInfo в журнале — snapshot при старте игры (все health=1.0),
                # а ModulesInfo.json обновляется редко. Принимаем health только
                # если оно <= текущего (модуль повредился дальше) или модуль
                # только что создан (default health=1.0).
                if new_health <= current_health:
                    self.state.modules[slot].health = new_health
            power = m.get("Power")
            if power is not None:
                self.state.modules[slot].power = float(power)
            priority = m.get("Priority")
            if priority is not None:
                self.state.modules[slot].priority = int(priority)
            item = m.get("Item")
            if item is not None:
                self.state.modules[slot].name = str(item)
        self._recalc_power()
        return bool(modules)

    def _recalc_power(self):
        """Пересчитать потребление энергии и мощность PowerPlant."""
        used = 0.0
        for m in self.state.modules.values():
            if m.on and m.power > 0:
                used += m.power
        self.state.power_used = round(used, 3)
        pp = self.state.modules.get("PowerPlant")
        if pp and "size" in pp.name:
            try:
                size = int(pp.name.split("size")[1].split("_")[0])
                # Класс: 1=E, 2=D, 3=C, 4=B, 5=A
                cls = 1
                if "class" in pp.name:
                    cls = int(pp.name.split("class")[1].split("_")[0])
                # Базовая мощность по размеру (E класс)
                base = {1: 1.20, 2: 1.50, 3: 2.00, 4: 3.00,
                        5: 5.00, 6: 7.00, 7: 10.00, 8: 12.00}.get(size, size * 1.5)
                # Множитель класса: E=1.0, D=1.166, C=1.333, B=1.5, A=1.666
                mult = 1.0 + (cls - 1) * (1.0 / 6.0)
                self.state.power_capacity = round(base * mult, 2)
            except (IndexError, ValueError):
                pass

    def _handle_hull_damage(self, ev: dict) -> bool:
        # Пропускаем урон fighter/SRV — это не наш основной корабль
        if ev.get("Fighter") or ev.get("SRV"):
            return False
        health = ev.get("Health")
        if health is not None:
            self.state.hull_health = float(health)
            return True
        return False

    def _handle_heat_damage(self, ev: dict) -> bool:
        """Урон корпусу и модулям от перегрева."""
        updated = False
        # Урон корпусу
        health = ev.get("Health")
        if health is not None:
            self.state.hull_health = float(health)
            updated = True
        else:
            # Если Health нет, уменьшаем на 2% (стандартный урон от перегрева)
            self.state.hull_health = max(0.0, self.state.hull_health - 0.02)
            updated = True
        # Урон модулям от перегрева (список слотов в поле Modules)
        modules = ev.get("Modules", [])
        for slot in modules:
            if slot and slot in self.state.modules:
                # Перегрев обычно наносит ~5% урон модулю
                self.state.modules[slot].health = max(0.0, self.state.modules[slot].health - 0.05)
                updated = True
        return updated

    def _handle_shield_state(self, ev: dict) -> bool:
        """Щиты упали или восстановились."""
        up = ev.get("ShieldsUp")
        if up is not None:
            self.state.shield_health = 1.0 if up else 0.0
            return True
        return False

    def _handle_module_damage(self, ev: dict) -> bool:
        """Урон конкретному модулю (столкновение, перегрев, бой)."""
        # Slot — основной идентификатор, Module — fallback
        slot = ev.get("Slot") or ev.get("Module")
        health = ev.get("Health")
        if slot and slot in self.state.modules and health is not None:
            self.state.modules[slot].health = float(health)
            return True
        return False

    def _handle_cockpit_breached(self, ev: dict) -> bool:
        """Пробоина кабины — урон корпусу."""
        self.state.hull_health = max(0.0, self.state.hull_health - 0.05)
        return True

    def _handle_repair(self, ev: dict) -> bool:
        slot = ev.get("Module")
        if slot and slot in self.state.modules:
            self.state.modules[slot].health = 1.0
            return True
        return False

    def _handle_repair_all(self, ev: dict) -> bool:
        for m in self.state.modules.values():
            m.health = 1.0
        self.state.hull_health = 1.0
        return True

    def _handle_afmu_repair(self, ev: dict) -> bool:
        slot = ev.get("Module")
        health = ev.get("Health")
        if slot and slot in self.state.modules and health is not None:
            self.state.modules[slot].health = float(health)
            return True
        return False

    def _handle_reboot_repair(self, ev: dict) -> bool:
        slots = ev.get("Modules", [])
        for slot in slots:
            if slot in self.state.modules:
                self.state.modules[slot].health = 1.0
        return bool(slots)

    def _handle_load_game(self, ev: dict) -> bool:
        ship = ev.get("Ship")
        if ship:
            self.state.ship_type = str(ship)
        return bool(ship)

    def _handle_module_buy(self, ev: dict) -> bool:
        slot = ev.get("Slot")
        if slot:
            name = ev.get("BuyItem", "Unknown")
            self.state.modules[slot] = ShipModule(slot=slot, name=name, health=1.0)
            self._recalc_power()
            return True
        return False

    def _handle_module_sell(self, ev: dict) -> bool:
        slot = ev.get("Slot")
        if slot and slot in self.state.modules:
            del self.state.modules[slot]
            self._recalc_power()
            return True
        return False

    def _handle_module_swap(self, ev: dict) -> bool:
        from_slot = ev.get("FromSlot")
        to_slot = ev.get("ToSlot")
        if from_slot and from_slot in self.state.modules:
            mod = self.state.modules.pop(from_slot)
            mod.slot = to_slot
            self.state.modules[to_slot] = mod
            return True
        return False

    def _handle_cargo(self, ev: dict) -> bool:
        count = ev.get("Count")
        if count is not None:
            self.state.cargo_count = int(count)
            return True
        return False

    def _handle_reservoir_replenished(self, ev: dict) -> bool:
        fuel_main = ev.get("FuelMain")
        if fuel_main is not None:
            self.state.fuel_level = float(fuel_main)
        fuel_res = ev.get("FuelReservoir")
        if fuel_res is not None:
            self.state.fuel_reservoir = float(fuel_res)
        return True

    def _handle_refuel_all(self, ev: dict) -> bool:
        amount = ev.get("Amount")
        if amount is not None:
            added = self.state.fuel_level + float(amount)
            if self.state.fuel_capacity > 0:
                self.state.fuel_level = min(added, self.state.fuel_capacity)
            else:
                self.state.fuel_level = added
        return True

    def _handle_refuel_partial(self, ev: dict) -> bool:
        amount = ev.get("Amount")
        if amount is not None:
            added = self.state.fuel_level + float(amount)
            if self.state.fuel_capacity > 0:
                self.state.fuel_level = min(added, self.state.fuel_capacity)
            else:
                self.state.fuel_level = added
        return True

    def parse_journal_text(self, text: str):
        """Разобрать текст журнала и обновить состояние."""
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
                self.parse_event(ev)
            except json.JSONDecodeError:
                continue

    def parse_status_json(self, data: dict):
        """Разобрать Status.json файл."""
        data["event"] = "Status"
        self.parse_event(data)

    def parse_modules_info_json(self, data: dict):
        """Разобрать ModulesInfo.json файл."""
        data["event"] = "ModuleInfo"
        self.parse_event(data)

    def parse_cargo_json(self, data: dict):
        """Разобрать Cargo.json файл."""
        data["event"] = "Cargo"
        self.parse_event(data)

    def reset(self):
        """Сбросить состояние."""
        self.state = ShipState()
        self._notify()

    def get_state_dict(self) -> dict:
        """Получить состояние как словарь для оверлея."""
        flags_list = decode_status_flags(self.state.flags, self.state.flags2)
        return {
            "ship_type": self.state.ship_type,
            "ship_name": self.state.ship_name,
            "ship_ident": self.state.ship_ident,
            "hull_percent": self.state.hull_percent,
            "shield_percent": self.state.shield_percent,
            "fuel_percent": self.state.fuel_percent,
            "fuel_level": round(self.state.fuel_level, 2),
            "fuel_capacity": round(self.state.fuel_capacity, 2),
            "fuel_reservoir": round(self.state.fuel_reservoir, 3),
            "cargo_capacity": self.state.cargo_capacity,
            "cargo_count": self.state.cargo_count,
            "rebuy": self.state.rebuy,
            "balance": self.state.balance,
            "legal_state": self.state.legal_state,
            "pips_sys": self.state.pips_sys,
            "pips_eng": self.state.pips_eng,
            "pips_wep": self.state.pips_wep,
            "fire_group": self.state.fire_group,
            "gui_focus": self.state.gui_focus,
            "destination_system": self.state.destination_system,
            "destination_body": self.state.destination_body,
            "destination_name": self.state.destination_name,
            "power_used": self.state.power_used,
            "power_capacity": self.state.power_capacity,
            "power_percent": self.state.power_percent,
            "flags": self.state.flags,
            "flags2": self.state.flags2,
            "flags_list": flags_list,
            "damaged_count": len(self.state.damaged_modules),
            "critical_count": len(self.state.critical_modules),
            "modules": [
                {
                    "slot": m.slot,
                    "name": m.name,
                    "health": round(m.health * 100),
                    "health_float": round(m.health, 3),
                    "priority": m.priority,
                    "on": m.on,
                    "engineered": m.engineered,
                    "power": m.power,
                }
                for m in sorted(self.state.modules.values(), key=lambda x: x.slot)
            ],
            "damaged_modules": [
                {
                    "slot": m.slot,
                    "name": m.name,
                    "health": round(m.health * 100),
                    "power": m.power,
                }
                for m in sorted(self.state.damaged_modules, key=lambda x: x.health)
            ],
            "inventory": self.state.inventory,
            "last_update": self.state.last_update,
        }
