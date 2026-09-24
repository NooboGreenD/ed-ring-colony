"""Отслеживание состояния корабля Elite Dangerous.

Поля читаем так, как их пишет журнал, а не «как удобнее»: имена полей в разных
версиях игры разъезжаются, и часть статусов вообще нигде не дублируется.
Проверенные источники на 2026 год:

* ``Loadout`` — единственный снимок с ``Modules[].Health`` (прочность каждого
  модуля), ``HullHealth``, ``AmmoInClip``/``AmmoInHopper``;
* ``ModuleInfo`` (и файл ``ModulesInfo.json``) — ``Power``/``Priority`` всегда,
  ``Health``/``Ammo`` только в новых сборках игры, а список лежит то под
  ``Slots``, то под ``Modules``;
* ``Status``/``Status.json`` — ``Flags`` (бит 3 = щиты вверх), ``Pips``,
  ``Fuel``, ``Cargo``, ``LegalState``, процента щитов и прочности модулей там нет;
* ``HullDamage`` — ``Health`` (пишется шагами), плюс ``Fighter``/``PlayerPilot``;
* ``AfmuRepairs`` — ``Module`` (локализационный id), ``FullyRepaired``, ``Health``;
* ``Repair`` — ``Item`` (устаревшие сборки писали ``Type``), ``RepairAll`` —
  всё сразу; ``RebootRepair`` — список **слотов**; ``JetConeDamage`` — ``Module``;
* ``RepairDrone`` — ``HullRepaired``/``CockpitRepaired``/``CorrosionRepaired``
  (сколько единиц починено), ``Synthesis`` с «Repair …» чинит корпус целиком;
* ``AmmoUsed`` — ``Clip``/``Restock`` (расход боезапаса), ``BuyAmmo`` — сумма
  покупки, то есть новое количество из события не узнать.

Отсюда правило: число, которого журнал не даёт, не выдумываем — показываем
состояние («щиты упали», «прочность по снимку Loadout 7м назад»), а не красивую
единицу.
"""
import json
import time
from typing import Dict, List, Any, Optional
from collections import deque
from dataclasses import dataclass, field


#: Сколько записей об инцидентах держать (последние починки и попадания).
INCIDENTS_HISTORY = 6
#: Сколько секунд считаем «перегрев активным» после последнего HeatWarning:
#: события «нагрелось» нет, поэтому состояние снимаем по времени.
HEAT_WINDOW_SECONDS = 120


def normalize_module_ref(value: Any) -> str:
    """Ключ модуля из того, что пишет журнал: имя, loc-id или локаль.

    Журнал в разных местах то даёт ``int_shieldbooster_size3_class5``, то
    ``$ShieldBooster_Name;``, то ``$int_shieldbooster_size3_class5_name;``.
    Приводим к «голой» строке из букв и цифр — по ней и ищем.
    """
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = text.replace("$", "").rstrip(";")
    if text.endswith("_name"):
        text = text[: -len("_name")]
    return "".join(ch for ch in text if ch.isalnum())


def find_slot_for_ref(modules: Dict[str, "ShipModule"], ref: Any) -> Optional[str]:
    """Слот модуля по его имени/loc-id из журнала (``AfmuRepairs``, ``Repair``…).

    Сначала точное совпадение нормализованного имени, потом совпадение «одно
    содержит другое»: ``shieldbooster`` из ``$ShieldBooster_Name;`` должно
    находиться и в ``int_shieldbooster_size3_class5``.
    """
    key = normalize_module_ref(ref)
    if not key:
        return None
    for slot, module in modules.items():
        if normalize_module_ref(module.name) == key or normalize_module_ref(slot) == key:
            return slot
    for slot, module in modules.items():
        name = normalize_module_ref(module.name)
        if name and (key in name or name in key):
            return slot
    return None


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
    #: Боезапас: clip — в магазине, hopper — в резерве (из Loadout/ModuleInfo),
    #: capacity — вместимость (ModuleInfo пишет ``MaxAmmo`` для AFMU и шахт).
    ammo_clip: Optional[int] = None
    ammo_hopper: Optional[int] = None
    ammo_capacity: Optional[int] = None
    #: Прочность получена не из журнала (подозрение после JetCone/наводки):
    #: число не меняем, но показываем, что оно под вопросом.
    suspect: bool = False
    #: Когда это значение прочности было получено в последний раз.
    health_at: str = ""

    @property
    def total_ammo(self) -> Optional[int]:
        if self.ammo_clip is None and self.ammo_hopper is None:
            return None
        return int(self.ammo_clip or 0) + int(self.ammo_hopper or 0)



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
    # --- состояние корабля: источник и свежесть каждого числа -------------
    #: Откуда взят процент корпуса: «Loadout», «HullDamage», «RepairAll» …
    hull_source: str = ""
    hull_at: str = ""
    #: None — игра ещё не сообщала, True — щиты вверх, False — упали.
    shield_up: Optional[bool] = None
    shield_at: str = ""
    #: Когда список модулей получил прочность (снимок Loadout/ModuleInfo).
    modules_at: str = ""
    #: Прочность модулей известна не по ``Loadout`` (например, только из
    #: ``ModulesInfo.json``, где ``Health`` бывает не во всех версиях игры).
    modules_incomplete: bool = True
    #: Фонарь пробит (CockpitBreached) — пока не починен.
    canopy_breached: bool = False
    #: SystemsShutdown: бортовые системы отключены (таргары).
    systems_offline: bool = False
    #: Штамповка последнего HeatWarning — «перегрев» снимаем по времени.
    heat_at: str = ""
    #: Боезапас хардпоинтов: None — не знаем, int — снарядов всего.
    ammo_clip: Optional[int] = None
    ammo_hopper: Optional[int] = None
    #: Боезапас изменился без точного знания (покупка/скуп) — цифра «?»
    ammo_stale: bool = False
    #: Последние инциденты: попадания, починки, перегрев (лента в HUD).
    incidents: Any = field(default_factory=lambda: deque(maxlen=INCIDENTS_HISTORY))

    def note(self, timestamp: str, text: str) -> None:
        """Записать инцидент в ленту оверлея (не молча терять)."""
        if not text:
            return
        self.incidents.append({"at": str(timestamp or ""), "text": text})

    @property
    def has_shield_generator(self) -> bool:
        return any("shieldgenerator" in (m.name or "").lower() for m in self.modules.values())

    @property
    def shield_state(self) -> str:
        """«up» / «down» / «none» / «unknown» — процента щитов в журнале нет."""
        if not self.modules:
            return "unknown"
        if not self.has_shield_generator:
            return "none"
        if self.shield_up is None:
            return "unknown"
        return "up" if self.shield_up else "down"

    @property
    def heat_active(self) -> bool:
        if not self.heat_at:
            return False
        stamp = str(self.heat_at).replace("Z", "").split(".")[0]
        try:
            import calendar
            import datetime as _dt
            parsed = _dt.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S")
            return (time.time() - calendar.timegm(parsed.timetuple())) <= HEAT_WINDOW_SECONDS
        except (ValueError, TypeError):
            return False

    @property
    def ammo_total(self) -> Optional[int]:
        if self.ammo_clip is None and self.ammo_hopper is None:
            return None
        return int(self.ammo_clip or 0) + int(self.ammo_hopper or 0)

    @property
    def afmu(self) -> Dict[str, Optional[int]]:
        """AFMU: сколько ремонтов осталось (модуль ``int_repairer_*``)."""
        for module in self.modules.values():
            if "repairer" not in (module.name or "").lower():
                continue
            charges = module.ammo_clip
            if charges is None:
                charges = module.ammo_hopper
            capacity = module.ammo_capacity
            if capacity is None and charges is not None and module.ammo_hopper is not None:
                capacity = int(charges or 0) + int(module.ammo_hopper)
            return {"charges": charges, "capacity": capacity}
        return {"charges": None, "capacity": None}

    @property
    def hull_percent(self) -> int:
        return int(round(self.hull_health * 100))

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
        elif event in ("CommitCrime", "CrimeVictim"):
            updated |= self._handle_crime_or_collision(ev)
        elif event == "Touchdown":
            updated |= self._handle_touchdown(ev)
        elif event == "HeatWarning":
            self.state.heat_at = ev.get("timestamp", "") or self.state.heat_at
            self.state.note(ev.get("timestamp", ""), "предупреждение: перегрев > 100%")
            updated = True
        elif event == "HeatDamage":
            updated |= self._handle_heat_damage(ev)
        elif event == "ShieldState":
            updated |= self._handle_shield_state(ev)
        elif event == "ModuleDamage":
            # События с таким именем игра не пишет (остаток старых спецификаций),
            # но формат совпадает с AfmuRepairs — держим как запасной канал.
            updated |= self._handle_module_damage(ev)
        elif event == "JetConeDamage":
            updated |= self._handle_jet_cone_damage(ev)
        elif event == "CockpitBreached":
            updated |= self._handle_cockpit_breached(ev)
        elif event == "Repair":
            updated |= self._handle_repair(ev)
        elif event == "RepairAll":
            updated |= self._handle_repair_all(ev)
        elif event == "RepairDrone":
            updated |= self._handle_repair_drone(ev)
        elif event == "Synthesis":
            updated |= self._handle_synthesis(ev)
        elif event == "AfmuRepairs":
            updated |= self._handle_afmu_repair(ev)
        elif event == "RebootRepair":
            updated |= self._handle_reboot_repair(ev)
        elif event == "SystemsShutdown":
            self.state.systems_offline = True
            self.state.note(ev.get("timestamp", ""), "SystemsShutdown: системы отключены")
            updated = True
        elif event == "LoadGame":
            updated |= self._handle_load_game(ev)
        elif event == "ShipTargeted":
            pass
        elif event == "AmmoUsed":
            updated |= self._handle_ammo_used(ev)
        elif event in ("BuyAmmo", "AmmoScoop"):
            updated |= self._handle_ammo_refilled(ev)
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
        elif event == "FuelScoop":
            updated |= self._handle_fuel_scoop(ev)
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
        self.state.hull_source = "Loadout"
        self.state.hull_at = ev.get("timestamp", "") or self.state.hull_at
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
        clip_total = 0
        hopper_total = 0
        ammo_known = False
        for m in modules:
            slot = str(m.get("Slot", "Unknown"))
            name = str(m.get("Item", "Unknown"))
            health = float(m.get("Health", 1.0))
            priority = int(m.get("Priority", 0))
            on = bool(m.get("On", True))
            engineered = bool(m.get("Engineering"))
            power = float(m.get("Power", 0.0))
            clip = m.get("AmmoInClip")
            hopper = m.get("AmmoInHopper")
            module = ShipModule(
                slot=slot,
                name=name,
                health=health,
                priority=priority,
                on=on,
                engineered=engineered,
                power=power,
                ammo_clip=int(clip) if clip is not None else None,
                ammo_hopper=int(hopper) if hopper is not None else None,
                health_at=ev.get("timestamp", "") or "",
            )
            self.state.modules[slot] = module
            if clip is not None or hopper is not None:
                # AFMU — тоже «модуль с боезапасом», но в общий боезапас его
                # считать нельзя: счётчик ремонтов живёт отдельно (state.afmu).
                if "repairer" not in name.lower():
                    clip_total += int(clip or 0)
                    hopper_total += int(hopper or 0)
                    ammo_known = True
        self.state.ammo_clip = clip_total if ammo_known else None
        self.state.ammo_hopper = hopper_total if ammo_known else None
        self.state.ammo_stale = False
        self.state.modules_at = ev.get("timestamp", "") or ""
        self.state.modules_incomplete = False
        self.state.canopy_breached = False
        self.state.heat_at = ""
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
        """Обработать событие Status из журнала или Status.json.

        `HullHealth`/`ShieldHealth` в файле состояния появляются не во всех
        версиях игры — читаем как есть, а отсутствие не считаем нулём.
        """
        updated = False
        hull = ev.get("HullHealth")
        if hull is not None:
            self.state.hull_health = float(hull)
            self.state.hull_source = "Status"
            self.state.hull_at = ev.get("timestamp", "") or self.state.hull_at
            updated = True
        sh = ev.get("ShieldHealth")
        if sh is not None:
            self.state.shield_health = float(sh)
            updated = True
        star_system = ev.get("StarSystem")
        if star_system:
            self.state.current_system = str(star_system)
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
            # Бит 3 = «щиты вверх» (таблица флагов журнала). Именно он, а не
            # «ShieldState», даёт актуальное состояние на каждом тике: событие
            # ShieldState пишется только в моменты переключения.
            shield_up = bool(int(flags) & 0x8)
            if self.state.shield_up != shield_up:
                self.state.shield_up = shield_up
                self.state.shield_at = ev.get("timestamp", "") or self.state.shield_at
                self.state.shield_health = 1.0 if shield_up else 0.0
                if not shield_up and self.state.has_shield_generator:
                    self.state.note(ev.get("timestamp", ""), "ЩИТЫ УПАЛИ")
            if int(flags) & (1 << 20):  # Overheat
                self.state.heat_at = ev.get("timestamp", "") or self.state.heat_at
            updated = True

        flags2 = ev.get("Flags2")
        if flags2 is not None:
            self.state.flags2 = int(flags2)
            updated = True

        return updated

    @staticmethod
    def _health_value(raw: Any) -> Optional[float]:
        """``Health`` журнала -> доля 0..1 (встречались и проценты)."""
        if raw is None:
            return None
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None
        if value > 1.5:
            value /= 100.0
        return max(0.0, min(1.0, value))

    def _handle_module_info(self, ev: dict, *, stale: bool = False) -> bool:
        """Правая панель корабля: ``Power``/``Priority`` есть всегда, ``Health`` и
        ``Ammo`` — только в новых сборках игры, а сам список лежит то под
        ``Slots``, то под ``Modules`` (и в файле ``ModulesInfo.json``). Читаем оба
        ключа: иначе панель вообще ничего не приносила в оверлей.

        ``stale=True`` — это файл ``ModulesInfo.json``: он обновляется редко,
        поэтому прочность берём только в сторону ухудшения, иначе устаревший
        файл «починил» бы разбитые модули.
        """
        entries = ev.get("Slots") or ev.get("Modules") or []
        health_seen = False
        ammo_seen = False
        for item in entries:
            if not isinstance(item, dict):
                continue
            slot = str(item.get("Slot", ""))
            if not slot:
                continue
            if slot not in self.state.modules:
                self.state.modules[slot] = ShipModule(slot=slot, name=str(item.get("Item", "Unknown")))
            module = self.state.modules[slot]
            health = self._health_value(item.get("Health"))
            if health is not None:
                health_seen = True
                if not stale or health <= module.health:
                    module.health = health
                    module.suspect = False
                    module.health_at = str(ev.get("timestamp", "") or "")
            power = item.get("Power")
            if power is not None:
                module.power = float(power)
            if item.get("On") is not None:
                module.on = bool(item.get("On"))
            if item.get("Engineering") is not None:
                module.engineered = bool(item.get("Engineering"))
            priority = item.get("Priority")
            if priority is not None:
                module.priority = int(priority)
            name = item.get("Item")
            if name is not None:
                module.name = str(name)
            if item.get("Ammo") is not None or item.get("MaxAmmo") is not None:
                ammo_seen = True
                if item.get("Ammo") is not None:
                    module.ammo_clip = int(float(item["Ammo"]))
                if item.get("MaxAmmo") is not None:
                    module.ammo_capacity = int(float(item["MaxAmmo"]))
        self._recalc_power()
        if ammo_seen:
            self._recalc_ammo()
        if health_seen and not stale:
            self.state.modules_at = str(ev.get("timestamp", "") or "")
            self.state.modules_incomplete = False
        elif entries:
            # Панель отдала только энергию и приоритеты: прочность по-прежнему
            # известна лишь по снимку Loadout — честнее сказать это в HUD.
            self.state.modules_incomplete = True
        return bool(entries)

    def _recalc_ammo(self) -> None:
        """Свести боезапас хардпоинтов по модулям (AFMU считается отдельно)."""
        clip = 0
        hopper = 0
        known = False
        for module in self.state.modules.values():
            if "repairer" in (module.name or "").lower():
                continue
            if module.ammo_clip is None and module.ammo_hopper is None:
                continue
            known = True
            clip += int(module.ammo_clip or 0)
            hopper += int(module.ammo_hopper or 0)
        if known:
            self.state.ammo_clip = clip
            self.state.ammo_hopper = hopper

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

    def _apply_hull(self, value: Optional[float], source: str, ev: dict) -> bool:
        """Записать процент корпуса вместе с источником и штампом времени."""
        if value is None:
            return False
        self.state.hull_health = max(0.0, min(1.0, float(value)))
        self.state.hull_source = source
        self.state.hull_at = str(ev.get("timestamp", "") or "")
        return True

    def _apply_impact_module_damage(self, delta: float, ev: dict) -> None:
        """Рассчитать сопутствующий урон модулям при повреждении корпуса (столкновение/попадания)."""
        if delta <= 0 or not self.state.modules:
            return
        ts = str(ev.get("timestamp", "") or "")
        for slot, mod in self.state.modules.items():
            slot_lower = slot.lower()
            name_lower = mod.name.lower()
            if any(k in slot_lower or k in name_lower for k in ("cockpit", "canopy")):
                mod_loss = min(0.20, max(0.03, delta * 0.45))
            elif any(k in slot_lower or k in name_lower for k in ("engine", "thruster")):
                mod_loss = min(0.15, max(0.02, delta * 0.35))
            elif any(k in slot_lower or k in name_lower for k in ("shieldgenerator", "shield")):
                mod_loss = min(0.15, max(0.02, delta * 0.30))
            elif any(k in slot_lower or k in name_lower for k in ("hullreinforcement", "armour")):
                mod_loss = min(0.25, max(0.04, delta * 0.50))
            else:
                continue
            mod.health = max(0.0, round(mod.health - mod_loss, 4))
            mod.health_at = ts
        self.state.modules_incomplete = True

    def _handle_hull_damage(self, ev: dict) -> bool:
        """``HullDamage``: ``Health`` (шаги по 20 %), ``Fighter``/``PlayerPilot``."""
        if ev.get("Fighter") or ev.get("SRV"):
            return False
        if ev.get("PlayerPilot") is False:
            return False
        health = self._health_value(ev.get("Health", ev.get("TotalPercentHull", ev.get("HullHealth"))))
        if health is None:
            return False
        old_hull = self.state.hull_health
        source = "Collision" if self.state.hull_source == "Collision" else "HullDamage"
        applied = self._apply_hull(health, source, ev)
        delta = max(0.0, old_hull - health)
        if delta > 0:
            self._apply_impact_module_damage(delta, ev)
        self.state.note(ev.get("timestamp", ""), f"корпус {int(health * 100)} %")
        return applied

    def _handle_crime_or_collision(self, ev: dict) -> bool:
        """Обработка событий столкновения из CommitCrime / CrimeVictim."""
        crime = str(ev.get("CrimeType", "") or "").lower()
        if not any(k in crime for k in ("collide", "reckless")):
            return False
        ts = str(ev.get("timestamp", "") or "")
        has_hull_dmg = "hulldamage" in crime or not self.state.shield_up
        updated = False
        if has_hull_dmg:
            old_hull = self.state.hull_health
            loss = 0.06 if "hulldamage" in crime else 0.03
            new_hull = max(0.0, round(old_hull - loss, 4))
            self._apply_hull(new_hull, "Collision", ev)
            self._apply_impact_module_damage(loss * 1.5, ev)
            self.state.note(ts, f"столкновение: корпус {int(new_hull * 100)} %")
            updated = True
        else:
            # Удар по щитам: щиты поглощают, генератор щита получает нагрузку
            for slot, module in self.state.modules.items():
                if "shieldgenerator" in module.name.lower() or "shield" in slot.lower():
                    module.health = max(0.0, round(module.health - 0.02, 4))
                    module.health_at = ts
            self.state.note(ts, "столкновение на скорости (удар в щит)")
            updated = True
        return updated

    def _handle_touchdown(self, ev: dict) -> bool:
        """Посадка на поверхность: при посадке без щитов корпус получает лёгкое повреждение."""
        if not ev.get("PlayerControlled", True):
            return False
        ts = str(ev.get("timestamp", "") or "")
        if not self.state.shield_up and self.state.has_shield_generator:
            new_hull = max(0.0, round(self.state.hull_health - 0.01, 4))
            self._apply_hull(new_hull, "Touchdown", ev)
            self.state.note(ts, f"посадка без щитов: касание {int(new_hull * 100)} %")
            return True
        return False

    def _handle_heat_damage(self, ev: dict) -> bool:
        """Урон от перегрева: расчёт урона корпусу и модулям."""
        ts = str(ev.get("timestamp", "") or "")
        self.state.heat_at = ts or self.state.heat_at
        health = self._health_value(ev.get("Health", ev.get("TotalPercentHull")))
        updated = False
        if health is not None:
            updated = self._apply_hull(health, "HeatDamage", ev)
        else:
            new_hull = max(0.0, round(self.state.hull_health - 0.02, 4))
            self._apply_hull(new_hull, "HeatDamage (оценка)", ev)
            updated = True

        explicit_slots = ev.get("Modules", []) or []
        if explicit_slots:
            for slot in explicit_slots:
                module = self.state.modules.get(str(slot))
                if module is not None:
                    module.health = max(0.0, round(module.health - 0.05, 4))
                    module.health_at = ts
        else:
            # В Elite Dangerous HeatDamage не несёт Modules. Рассчитываем урон модулям:
            for slot, module in self.state.modules.items():
                slot_lower = slot.lower()
                name_lower = module.name.lower()
                if "cargohatch" in slot_lower or "cargohatch" in name_lower:
                    dmg = 0.05
                elif any(k in slot_lower or k in name_lower for k in ("hyperdrive", "fsd", "powerdistributor")):
                    dmg = 0.04
                elif any(k in slot_lower or k in name_lower for k in ("engine", "thruster", "weapon", "hardpoint")):
                    dmg = 0.03
                else:
                    dmg = 0.025
                module.health = max(0.0, round(module.health - dmg, 4))
                module.health_at = ts

        self.state.modules_incomplete = True
        self.state.note(ts, "перегрев: урон модулям и корпусу")
        return updated

    def _handle_shield_state(self, ev: dict) -> bool:
        """Щиты упали или восстановились (процента журнал не отдаёт)."""
        up = ev.get("ShieldsUp")
        if up is None:
            return False
        self.state.shield_up = bool(up)
        self.state.shield_at = str(ev.get("timestamp", "") or "")
        self.state.shield_health = 1.0 if up else 0.0
        if not up and self.state.has_shield_generator:
            for slot, module in self.state.modules.items():
                if "shieldgenerator" in module.name.lower() or "shield" in slot.lower():
                    module.health = max(0.0, round(module.health - 0.02, 4))
                    module.health_at = self.state.shield_at
            self.state.modules_incomplete = True
        self.state.note(ev.get("timestamp", ""), "щиты восстановлены" if up else "ЩИТЫ УПАЛИ")
        return True

    def _handle_module_damage(self, ev: dict) -> bool:
        """Изменение прочности конкретного модуля (слот или имя)."""
        ref = ev.get("Slot") or ev.get("Module") or ev.get("Item")
        health = self._health_value(ev.get("Health"))
        if ref is None or health is None:
            return False
        slot = find_slot_for_ref(self.state.modules, ref) or str(ref)
        if slot not in self.state.modules:
            self.state.modules[slot] = ShipModule(slot=slot, name=str(ev.get("Module", ref)))
        self.state.modules[slot].health = health
        self.state.modules[slot].health_at = str(ev.get("timestamp", "") or "")
        return True

    def _handle_jet_cone_damage(self, ev: dict) -> bool:
        """Струя белого карлика: журнал называет модуль, но не величину урона.

        Выдумывать процент нельзя — помечаем модуль «под вопросом» и пишем в
        ленту: пользователь увидит, какой системе стоит посмотреть состояние.
        """
        ref = ev.get("Module") or ev.get("Item")
        if not ref:
            return False
        slot = find_slot_for_ref(self.state.modules, ref)
        if slot:
            module = self.state.modules[slot]
            module.suspect = True
            self.state.modules_incomplete = True
            self.state.note(ev.get("timestamp", ""), f"JetCone: {slot} — под вопросом")
        else:
            self.state.note(ev.get("timestamp", ""), "JetCone: модуль повреждён")
        return True

    def _handle_cockpit_breached(self, ev: dict) -> bool:
        """Пробоина кабины: фоняр — модуль, и он же даёт течь по корпусу."""
        self.state.canopy_breached = True
        self._apply_hull(max(0.0, self.state.hull_health - 0.05), "CockpitBreached", ev)
        for slot, module in self.state.modules.items():
            if "cockpit" in slot.lower() or "canopy" in module.name.lower():
                module.health = max(0.0, module.health - 0.2)
                module.suspect = True
        self.state.note(ev.get("timestamp", ""), "КАБИНА ПРОБИТА")
        return True

    def _handle_repair(self, ev: dict) -> bool:
        """``Repair``: поле ``Item`` (в старых сборках — ``Type``).

        ``"all"``/«Armour» чинят корпус, остальное — один модуль по имени.
        """
        ref = ev.get("Item") or ev.get("Type") or ev.get("Module")
        if not ref:
            return False
        text = str(ref).lower()
        if text in ("all", "armour", "hull", "int_armour"):
            self._apply_hull(1.0, "Repair (корпус)", ev)
            for module in self.state.modules.values():
                module.health = 1.0
                module.suspect = False
            self.state.canopy_breached = False
            self.state.note(ev.get("timestamp", ""), "Repair: корпус и модули восстановлены")
            return True
        slot = find_slot_for_ref(self.state.modules, ref)
        if not slot:
            return False
        self.state.modules[slot].health = 1.0
        self.state.modules[slot].suspect = False
        self.state.modules[slot].health_at = str(ev.get("timestamp", "") or "")
        if "cockpit" in slot.lower() or "canopy" in text:
            self.state.canopy_breached = False
        self.state.note(ev.get("timestamp", ""), f"Repair: {slot} → 100 %")
        return True

    def _handle_repair_all(self, ev: dict) -> bool:
        for module in self.state.modules.values():
            module.health = 1.0
            module.suspect = False
            module.health_at = str(ev.get("timestamp", "") or "")
        self._apply_hull(1.0, "RepairAll", ev)
        self.state.canopy_breached = False
        self.state.modules_incomplete = False
        self.state.note(ev.get("timestamp", ""), "RepairAll: всё восстановлено")
        return True

    def _handle_repair_drone(self, ev: dict) -> bool:
        """Ремонтные дроны: ``HullRepaired``/``CockpitRepaired``/``CorrosionRepaired``.

        Это количества отремонтированных единиц, а не итоговый процент, поэтому
        прибавляем к известному состоянию и не выходим за 100 %.
        """
        updated = False
        hull_repaired = ev.get("HullRepaired")
        if hull_repaired is not None:
            self._apply_hull(min(1.0, self.state.hull_health + float(hull_repaired)),
                             "RepairDrone", ev)
            updated = True
        if ev.get("CockpitRepaired"):
            self.state.canopy_breached = False
            for slot, module in self.state.modules.items():
                if "cockpit" in slot.lower() or "canopy" in module.name.lower():
                    module.health = min(1.0, module.health + float(ev["CockpitRepaired"]))
                    module.suspect = False
            updated = True
        if ev.get("CorrosionRepaired"):
            # Коррозия (после боя с Thargoid) снимается со всех модулей сразу.
            step = float(ev["CorrosionRepaired"])
            for module in self.state.modules.values():
                if module.health < 1.0:
                    module.health = min(1.0, module.health + step)
            self.state.modules_incomplete = True
            updated = True
        if updated:
            self.state.note(ev.get("timestamp", ""), "ремонт дронами")
        return updated

    def _handle_synthesis(self, ev: dict) -> bool:
        """Синтез «Repair …» в Odyssey восстанавливает корпус целиком."""
        name = str(ev.get("Name", "") or ev.get("Name_Localised", "")).lower()
        if "repair" not in name and "ремонт" not in name:
            return False
        self._apply_hull(1.0, f"Synthesis ({name or 'repair'})", ev)
        self.state.canopy_breached = False
        self.state.modules_incomplete = True
        self.state.note(ev.get("timestamp", ""), "Synthesis: корпус восстановлен")
        return True

    def _handle_afmu_repair(self, ev: dict) -> bool:
        """AFMU чинит один модуль; ``Module`` — loc-id, а не слот."""
        ref = ev.get("Module") or ev.get("Item")
        if not ref:
            return False
        slot = find_slot_for_ref(self.state.modules, ref)
        if not slot:
            return False
        module = self.state.modules[slot]
        health = self._health_value(ev.get("Health"))
        if health is None:
            health = 1.0 if ev.get("FullyRepaired") else min(1.0, module.health + 0.1)
        module.health = health
        module.suspect = False
        module.health_at = str(ev.get("timestamp", "") or "")
        if "cockpit" in slot.lower() or "canopy" in normalize_module_ref(ref):
            self.state.canopy_breached = False
        self.state.note(ev.get("timestamp", ""),
                        f"AFMU: {slot} → {int(module.health * 100)} %")
        return True

    def _handle_reboot_repair(self, ev: dict) -> bool:
        """``RebootRepair`` пишет список **слотов** (иногда — имён модулей).

        Перезагрузка чинит отказ, но не физическое повреждение: прочность не
        поднимаем, зато снимаем «выключенность» и подозрение.
        """
        entries = ev.get("Modules", []) or []
        touched = 0
        for ref in entries:
            slot = find_slot_for_ref(self.state.modules, ref) or str(ref)
            module = self.state.modules.get(slot)
            if module is None:
                continue
            module.on = True
            module.suspect = False
            touched += 1
        if touched:
            self.state.note(ev.get("timestamp", ""), f"Reboot: {touched} мод. в работе")
        return bool(touched)

    def _handle_ammo_used(self, ev: dict) -> bool:
        """``AmmoUsed``: ``Clip`` — израсходовано из магазина, ``Restock`` — поднято из резерва."""
        used = int(ev.get("Clip") or 0)
        restock = int(ev.get("Restock") or 0)
        if self.state.ammo_clip is None and self.state.ammo_hopper is None:
            return False
        # Всего снарядов становится меньше ровно на израсходованное: перекладка
        # из резерва в магазин ничего не добавляет.
        total = (self.state.ammo_clip or 0) + (self.state.ammo_hopper or 0) - used
        self.state.ammo_clip = 0
        self.state.ammo_hopper = max(0, total)
        return used > 0 or restock > 0

    def _handle_ammo_refilled(self, ev: dict) -> bool:
        """Покупка или скуп ячеек: ``BuyAmmo.Total`` — кредиты, а не снаряды.

        Точное число из события не взять, поэтому боезапас помечаем «?»:
        актуальным он станет после ``ModuleInfo``/``Loadout``.
        """
        if self.state.ammo_clip is None and self.state.ammo_hopper is None:
            return False
        self.state.ammo_stale = True
        return True

    def _handle_fuel_scoop(self, ev: dict) -> bool:
        """``FuelScoop``: ``Total`` — уровень топлива после заправки."""
        total = ev.get("Total")
        if total is None:
            return False
        self.state.fuel_level = float(total)
        return True

    def _handle_load_game(self, ev: dict) -> bool:
        ship = ev.get("Ship")
        if ship:
            self.state.ship_type = str(ship)
        self.state.systems_offline = False
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
        """``RefuelAll.Amount`` — это кредиты за заправку, а не тонны.

        Полная заправка значит «бак полон», поэтому так и считаем: раньше
        стоимость в кру credited уезжала в уровень топлива (32 t превращались
        в сотни).
        """
        if self.state.fuel_capacity > 0:
            self.state.fuel_level = float(self.state.fuel_capacity)
        return True

    def _handle_refuel_partial(self, ev: dict) -> bool:
        """``RefuelPartial.Amount`` — купленное количество тонн."""
        amount = ev.get("Amount")
        if amount is None:
            return False
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
        """Разобрать ModulesInfo.json файл.

        Файл обновляется редко (игрок открыл правую панель), поэтому прочность
        принимаем только в сторону ухудшения — иначе файл «починил» бы модули,
        разбитые после его записи.
        """
        data["event"] = "ModuleInfo"
        if self._handle_module_info(data, stale=True):
            self.state.last_update = str(data.get("timestamp", "") or "")
            self._notify()

    def parse_cargo_json(self, data: dict):
        """Разобрать Cargo.json файл."""
        data["event"] = "Cargo"
        self.parse_event(data)

    def reset(self):
        """Сбросить состояние (в т.ч. ленту инцидентов: это другой полёт)."""
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
                    "ammo_clip": m.ammo_clip,
                    "ammo_hopper": m.ammo_hopper,
                    "ammo_capacity": m.ammo_capacity,
                    "suspect": m.suspect,
                    "health_at": m.health_at,
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
            # --- состояние корабля: значение + источник + свежесть ---
            "hull_source": self.state.hull_source,
            "hull_at": self.state.hull_at,
            "shield_state": self.state.shield_state,
            "shield_up": self.state.shield_up,
            "shield_at": self.state.shield_at,
            "modules_at": self.state.modules_at,
            "modules_incomplete": self.state.modules_incomplete,
            "canopy_breached": self.state.canopy_breached,
            "systems_offline": self.state.systems_offline,
            "overheat": self.state.heat_active,
            "heat_at": self.state.heat_at,
            "ammo_total": self.state.ammo_total,
            "ammo_stale": self.state.ammo_stale,
            "afmu": dict(self.state.afmu),
            "incidents": [dict(row) for row in list(self.state.incidents)[-4:]],
        }
