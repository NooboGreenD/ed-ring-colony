"""Снаряжение пилота на ногах: костюм, оружие, модификации, рюкзак.

Откуда данные
-------------
Только из журнала игры (Odyssey), без сетевых запросов:

* ``SuitLoadout`` / ``SwitchSuitLoadout`` / ``CreateSuitLoadout`` — полный набор:
  костюм, грейд, оружие в слотах с модификациями, модификации костюма;
* ``DeleteSuitLoadout`` / ``RenameSuitLoadout`` — правки списка наборов;
* ``LoadoutEquipModule`` / ``LoadoutRemoveModule`` — смена оружия в слоте;
* ``Backpack`` / ``BackpackChange`` (и файл ``Backpack.json``) — рюкзак;
* ``BuySuit`` / ``SellSuit`` / ``UpgradeSuit`` — грейд костюма по ``SuitID``.

Важно: грейд костюма лежит в ``SuitName`` (``utilitysuit_class3``), а НЕ в
``SuitName_Localised`` — в локализованной строке грейд бывает неверным. Это же
правило используют EDCD/EDMarketConnector и EDDI.

Характеристики
--------------
Сопротивления, щит, батарею, ёмкости рюкзака и запас воздуха журнал не пишет —
это параметры экрана игры. Они взяты из открытого каталога Elite Dangerous
Almanac (``data/equipment/suits.jsonc``, ``weapons.jsonc``,
``modifications.jsonc``, ``tools.jsonc``), где значения сведены из Odyssey
Materials Helper и наблюдений в игре; символы предметов сверены с журналом по
EDCD/EDMarketConnector. Модификации считаются по тем же таблицам (например,
«Improved Battery Capacity» — это ×1.5 к батарее), поэтому цифры совпадают с
игрой. Если модификация незнакома, она всё равно показывается в списке, но
цифры не трогает — выдумывать эффект нельзя.

Модуль чистый: ни Qt, ни сети. Поэтому страница «Пилот» рисует ровно то, что
проверено тестами, и «в тестах зелено, в окне пусто» невозможно.
"""
from __future__ import annotations

import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: Слоты оружия в журнале и их вид. ``PrimaryWeapon2`` есть только у Dominator.
SLOT_KINDS = {
    "PrimaryWeapon1": "primary",
    "PrimaryWeapon2": "primary",
    "SecondaryWeapon": "secondary",
}
SLOT_ORDER = ("PrimaryWeapon1", "PrimaryWeapon2", "SecondaryWeapon")

#: Инструменты костюма. Frontier не публикует символ предмета для инструмента,
#: поэтому ключ здесь свой (как в каталоге Almanac), а название переводится.
TOOLS: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("energylink", "Energylink",
     ("utilitysuit", "tacticalsuit", "explorationsuit", "flightsuit")),
    ("profile-analyser", "Profile Analyser",
     ("utilitysuit", "tacticalsuit", "explorationsuit", "flightsuit")),
    ("arc-cutter", "Arc Cutter", ("utilitysuit",)),
    ("genetic-sampler", "Genetic Sampler", ("explorationsuit",)),
)

#: Разряды урона и режимы стрельбы — ключи для перевода.
DAMAGE_TYPES = ("kinetic", "thermal", "plasma", "explosive")
WEAPON_CLASSES = ("pistol", "rifle", "carbine", "shotgun", "sniper", "launcher")
FIRE_MODES = ("automatic", "semi-automatic", "burst")

#: Категории рюкзака: ключ журнала -> ключ состояния.
BACKPACK_KINDS = (("Items", "items"), ("Components", "components"),
                  ("Data", "data"), ("Consumables", "consumables"))
BACKPACK_TYPE_KEYS = {"item": "items", "component": "components",
                      "data": "data", "consumable": "consumables"}

#: Сколько секунд между записями кэша на диск: рюкзак меняется часто.
SAVE_INTERVAL = 10.0

#: Производитель костюма (EDCD/EDDI, DataDefinitions/Suit.cs).
SUIT_MANUFACTURERS = {
    "flightsuit": "Remlok",
    "utilitysuit": "Remlok",          # Maverick
    "tacticalsuit": "Manticore",      # Dominator
    "explorationsuit": "Supratech",   # Artemis
}

#: Каталог костюмов: семейство -> модель, слоты, ёмкости и характеристики по грейдам.
#: Источник: Elite Dangerous Almanac, data/equipment/suits.jsonc.
#: Сопротивления — доли: 0.15 значит «15 % урона не проходит».
SUITS: Dict[str, Dict[str, Any]] = {
    'utilitysuit': {
        'name': 'Maverick Suit',
        'mounts': ('PrimaryWeapon1', 'SecondaryWeapon',),
        'health': 30,
        'battery': 13.5,
        'oxygen': 60,
        'goods': 40, 'assets': 60, 'data': 20,
        'shield': {'kinetic': 0.6, 'thermal': -0.5, 'plasma': 0, 'explosive': 0.5},
        'grades': {
            1: {'slots': 0, 'shield': 13.5, 'regen': 0.99, 'kinetic': -0.6, 'thermal': 0.5, 'plasma': -0.1, 'explosive': 0},
            2: {'slots': 1, 'shield': 16.5, 'regen': 1.21, 'kinetic': -0.34, 'thermal': 0.58, 'plasma': 0.08, 'explosive': 0.16},
            3: {'slots': 2, 'shield': 20.3, 'regen': 1.49, 'kinetic': -0.14, 'thermal': 0.64, 'plasma': 0.22, 'explosive': 0.29},
            4: {'slots': 3, 'shield': 24.9, 'regen': 1.82, 'kinetic': 0.06, 'thermal': 0.7, 'plasma': 0.35, 'explosive': 0.41},
            5: {'slots': 4, 'shield': 30.4, 'regen': 2.23, 'kinetic': 0.2, 'thermal': 0.75, 'plasma': 0.45, 'explosive': 0.5},
        },
    },
    'tacticalsuit': {
        'name': 'Dominator Suit',
        'mounts': ('PrimaryWeapon1', 'PrimaryWeapon2', 'SecondaryWeapon',),
        'health': 30,
        'battery': 10,
        'oxygen': 60,
        'goods': 10, 'assets': 20, 'data': 10,
        'shield': {'kinetic': 0.6, 'thermal': -0.5, 'plasma': 0, 'explosive': 0.5},
        'grades': {
            1: {'slots': 0, 'shield': 15, 'regen': 1.1, 'kinetic': -0.5, 'thermal': 0.6, 'plasma': 0, 'explosive': 0},
            2: {'slots': 1, 'shield': 18.3, 'regen': 1.34, 'kinetic': -0.26, 'thermal': 0.66, 'plasma': 0.16, 'explosive': 0.16},
            3: {'slots': 2, 'shield': 22.5, 'regen': 1.65, 'kinetic': -0.07, 'thermal': 0.72, 'plasma': 0.29, 'explosive': 0.29},
            4: {'slots': 3, 'shield': 27.6, 'regen': 2.02, 'kinetic': 0.11, 'thermal': 0.76, 'plasma': 0.41, 'explosive': 0.41},
            5: {'slots': 4, 'shield': 33.8, 'regen': 2.48, 'kinetic': 0.25, 'thermal': 0.8, 'plasma': 0.5, 'explosive': 0.5},
        },
    },
    'explorationsuit': {
        'name': 'Artemis Suit',
        'mounts': ('PrimaryWeapon1', 'SecondaryWeapon',),
        'health': 30,
        'battery': 17,
        'oxygen': 60,
        'goods': 20, 'assets': 40, 'data': 10,
        'shield': {'kinetic': 0.6, 'thermal': -0.5, 'plasma': 0, 'explosive': 0.5},
        'grades': {
            1: {'slots': 0, 'shield': 12, 'regen': 0.88, 'kinetic': -0.7, 'thermal': 0.4, 'plasma': -0.2, 'explosive': 0},
            2: {'slots': 1, 'shield': 14.7, 'regen': 1.07, 'kinetic': -0.43, 'thermal': 0.5, 'plasma': -0.01, 'explosive': 0.16},
            3: {'slots': 2, 'shield': 18, 'regen': 1.32, 'kinetic': -0.21, 'thermal': 0.57, 'plasma': 0.15, 'explosive': 0.29},
            4: {'slots': 3, 'shield': 22.1, 'regen': 1.62, 'kinetic': 0, 'thermal': 0.65, 'plasma': 0.29, 'explosive': 0.41},
            5: {'slots': 4, 'shield': 27, 'regen': 1.98, 'kinetic': 0.15, 'thermal': 0.7, 'plasma': 0.4, 'explosive': 0.5},
        },
    },
    'flightsuit': {
        'name': 'Flight Suit',
        'mounts': ('SecondaryWeapon',),
        'health': 30,
        'battery': 7,
        'oxygen': 60,
        'goods': 5, 'assets': 10, 'data': 10,
        'shield': {'kinetic': 0.6, 'thermal': -0.5, 'plasma': 0, 'explosive': 0.5},
        'grades': {
            1: {'slots': 0, 'shield': 7.5, 'regen': 0.55, 'kinetic': -0.7, 'thermal': 0.4, 'plasma': -0.2, 'explosive': 0},
        },
    },
}

#: Каталог ручного оружия: символ журнала -> класс, тип урона, магазин, грейды.
#: Источник: Elite Dangerous Almanac, data/equipment/weapons.jsonc.
#: В грейдах: (урон за выстрел, число ячеек модификаций).
WEAPONS: Dict[str, Dict[str, Any]] = {
    'wpn_s_pistol_kinetic_sauto': {
        'name': 'Karma P-15', 'class': 'pistol', 'slot': 'secondary',
        'damage': 'kinetic', 'fire': 'semi-automatic',
        'magazine': 24, 'reserve': 240, 'range': 25,
        'grades': {1: (1.38, 0), 2: (1.808, 1), 3: (2.387, 2), 4: (3.133, 3), 5: (4.112, 4)},
    },
    'wpn_m_assaultrifle_kinetic_fauto': {
        'name': 'Karma AR-50', 'class': 'rifle', 'slot': 'primary',
        'damage': 'kinetic', 'fire': 'automatic',
        'magazine': 50, 'reserve': 250, 'range': 50,
        'grades': {1: (0.95, 0), 2: (1.244, 1), 3: (1.643, 2), 4: (2.156, 3), 5: (2.831, 4)},
    },
    'wpn_m_submachinegun_kinetic_fauto': {
        'name': 'Karma C-44', 'class': 'carbine', 'slot': 'primary',
        'damage': 'kinetic', 'fire': 'automatic',
        'magazine': 45, 'reserve': 360, 'range': 25,
        'grades': {1: (0.65, 0), 2: (0.852, 1), 3: (1.125, 2), 4: (1.476, 3), 5: (1.937, 4)},
    },
    'wpn_m_launcher_rocket_sauto': {
        'name': 'Karma L-6', 'class': 'launcher', 'slot': 'primary',
        'damage': 'explosive', 'fire': 'automatic',
        'magazine': 2, 'reserve': 8, 'range': 300,
        'grades': {1: (40, 0), 2: (52.4, 1), 3: (69.2, 2), 4: (90.8, 3), 5: (119.2, 4)},
    },
    'wpn_m_assaultrifle_laser_fauto': {
        'name': 'TK Aphelion', 'class': 'rifle', 'slot': 'primary',
        'damage': 'thermal', 'fire': 'automatic',
        'magazine': 25, 'reserve': 150, 'range': 70,
        'grades': {1: (1.572, 0), 2: (2.059, 1), 3: (2.72, 2), 4: (3.568, 3), 5: (4.685, 4)},
    },
    'wpn_m_submachinegun_laser_fauto': {
        'name': 'TK Eclipse', 'class': 'carbine', 'slot': 'primary',
        'damage': 'thermal', 'fire': 'automatic',
        'magazine': 45, 'reserve': 315, 'range': 25,
        'grades': {1: (0.85, 0), 2: (1.113, 1), 3: (1.47, 2), 4: (1.929, 3), 5: (2.533, 4)},
    },
    'wpn_s_pistol_laser_sauto': {
        'name': 'TK Zenith', 'class': 'pistol', 'slot': 'secondary',
        'damage': 'thermal', 'fire': 'burst',
        'magazine': 18, 'reserve': 180, 'range': 35,
        'grades': {1: (1.668, 0), 2: (2.185, 1), 3: (2.886, 2), 4: (3.786, 3), 5: (4.971, 4)},
    },
    'wpn_m_sniper_plasma_charged': {
        'name': 'Manticore Executioner', 'class': 'sniper', 'slot': 'primary',
        'damage': 'plasma', 'fire': 'semi-automatic',
        'magazine': 3, 'reserve': 30, 'range': 100,
        'grades': {1: (15, 0), 2: (19.65, 1), 3: (25.95, 2), 4: (34.05, 3), 5: (44.7, 4)},
    },
    'wpn_s_pistol_plasma_charged': {
        'name': 'Manticore Tormentor', 'class': 'pistol', 'slot': 'secondary',
        'damage': 'plasma', 'fire': 'semi-automatic',
        'magazine': 6, 'reserve': 72, 'range': 15,
        'grades': {1: (7.5, 0), 2: (9.825, 1), 3: (12.975, 2), 4: (17.025, 3), 5: (22.35, 4)},
    },
    'wpn_m_shotgun_plasma_doublebarrel': {
        'name': 'Manticore Intimidator', 'class': 'shotgun', 'slot': 'primary',
        'damage': 'plasma', 'fire': 'semi-automatic',
        'magazine': 2, 'reserve': 24, 'range': 7,
        'grades': {1: (1.75, 0), 2: (2.292, 1), 3: (3.027, 2), 4: (3.973, 3), 5: (5.215, 4)},
    },
    'wpn_m_assaultrifle_plasma_fauto': {
        'name': 'Manticore Oppressor', 'class': 'rifle', 'slot': 'primary',
        'damage': 'plasma', 'fire': 'automatic',
        'magazine': 50, 'reserve': 300, 'range': 35,
        'grades': {1: (1.1, 0), 2: (1.441, 1), 3: (1.903, 2), 4: (2.497, 3), 5: (3.278, 4)},
    },
}

#: Модификации снаряжения: символ -> название, цель и множители характеристик.
#: Источник: Elite Dangerous Almanac, data/equipment/modifications.jsonc.
#: Множитель к сопротивлению применяется к получаемому урону, не к самой доле.
MODIFICATIONS: Dict[str, Dict[str, Any]] = {
    'suit_increasedmeleedamage': {'name': 'Added Melee Damage', 'target': 'suit', 'effects': (('meleeDamage', 2.5, False),)},
    'suit_adsmovementspeed': {'name': 'Combat Movement Speed', 'target': 'suit', 'effects': ()},
    'suit_improvedarmourrating': {'name': 'Damage Resistance', 'target': 'suit', 'effects': (('armourKineticResistance', 0.9, False), ('armourThermalResistance', 0.9, False), ('armourPlasmaResistance', 0.9, False), ('armourExplosiveResistance', 0.9, False),)},
    'suit_improvedradar': {'name': 'Enhanced Tracking', 'target': 'suit', 'effects': (('losAnalysisRange', 2, False), ('losAnalysisTime', 0.001, False),)},
    'suit_increasedammoreserves': {'name': 'Extra Ammo Capacity', 'target': 'suit', 'effects': (('reserveAmmo', 1.5, False),)},
    'suit_backpackcapacity': {'name': 'Extra Backpack Capacity', 'target': 'suit', 'effects': (('goodsCapacity', 2, False), ('assetsCapacity', 2, False), ('dataCapacity', 2, False),)},
    'suit_increasedshieldregen': {'name': 'Faster Shield Regen', 'target': 'suit', 'effects': (('shieldRegeneration', 1.25, False),)},
    'suit_increasedbatterycapacity': {'name': 'Improved Battery Capacity', 'target': 'suit', 'effects': (('batteryCapacity', 1.5, False),)},
    'suit_improvedjumpassist': {'name': 'Improved Jump Assist', 'target': 'suit', 'effects': ()},
    'suit_increasedo2capacity': {'name': 'Increased Air Reserves', 'target': 'suit', 'effects': (('oxygenTime', 5, False),)},
    'suit_increasedsprintduration': {'name': 'Increased Sprint Duration', 'target': 'suit', 'effects': (('sprintDuration', 2, False),)},
    'suit_nightvision': {'name': 'Night Vision', 'target': 'suit', 'effects': ()},
    'suit_quieterfootsteps': {'name': 'Quieter Footsteps', 'target': 'suit', 'effects': (('footstepAudibleRange', 0.5, False),)},
    'suit_reducedtoolbatteryconsumption': {'name': 'Reduced Tool Battery Consumption', 'target': 'suit', 'effects': (('toolEnergyDrain', 0.5, False),)},
    'weapon_suppression_unpressurised': {'name': 'Audio Masking', 'target': 'weapon', 'effects': (('unpressurisedFiringAudibleRange', 0.05, False),)},
    'weapon_handling': {'name': 'Faster Handling', 'target': 'weapon', 'effects': ()},
    'weapon_range_kinetic': {'name': 'Greater Range', 'target': 'weapon', 'effects': (('effectiveRange', 1.5, False),)},
    'weapon_range_laser': {'name': 'Greater Range', 'target': 'weapon', 'effects': (('effectiveRange', 1.5, False),)},
    'weapon_range_plasma': {'name': 'Greater Range', 'target': 'weapon', 'effects': (('effectiveRange', 1.5, False),)},
    'weapon_headshotdamage_kinetic': {'name': 'Headshot Damage', 'target': 'weapon', 'effects': (('headshotMultiplier', 1.5, False),)},
    'weapon_headshotdamage_laser': {'name': 'Headshot Damage', 'target': 'weapon', 'effects': (('headshotMultiplier', 1.5, False),)},
    'weapon_headshotdamage_plasma': {'name': 'Headshot Damage', 'target': 'weapon', 'effects': (('headshotMultiplier', 1.5, False),)},
    'weapon_accuracy_kinetic': {'name': 'Improved Hip Fire Accuracy', 'target': 'weapon', 'effects': ()},
    'weapon_accuracy_laser': {'name': 'Improved Hip Fire Accuracy', 'target': 'weapon', 'effects': ()},
    'weapon_accuracy_plasma': {'name': 'Improved Hip Fire Accuracy', 'target': 'weapon', 'effects': ()},
    'weapon_clipsize': {'name': 'Magazine Size', 'target': 'weapon', 'effects': (('magazineSize', 1.5, True),)},
    'weapon_suppression_pressurised': {'name': 'Noise Suppressor', 'target': 'weapon', 'effects': (('pressurisedFiringAudibleRange', 0.05, False),)},
    'weapon_reloadspeed': {'name': 'Reload Speed', 'target': 'weapon', 'effects': ()},
    'weapon_scope': {'name': 'Scope', 'target': 'weapon', 'effects': ()},
    'weapon_stability': {'name': 'Stability', 'target': 'weapon', 'effects': ()},
    'weapon_backpackreloading': {'name': 'Stowed reloading', 'target': 'weapon', 'effects': ()},
}


# ---------------------------------------------------------------------------
#  Символы журнала
# ---------------------------------------------------------------------------
def symbol_key(value: Any) -> str:
    """``$suit_nightvision_name;`` -> ``suit_nightvision``.

    Игра пишет модификации то символом с оболочкой ``$…;``, то голым именем,
    поэтому нормализуем в одном месте, а не в каждом разборе.
    """
    key = str(value or "").strip().lower()
    if key.startswith("$"):
        key = key[1:]
    if key.endswith(";"):
        key = key[:-1]
    if key.endswith("_name"):
        key = key[:-5]
    return key


def suit_from_symbol(value: Any) -> Tuple[Optional[str], int]:
    """``utilitysuit_class3`` -> ``('utilitysuit', 3)``; неизвестное -> ``(None, 1)``.

    Грейд берём из символа: в ``SuitName_Localised`` он бывает неверным.
    """
    key = symbol_key(value)
    match = re.match(r"^([a-z]+?)(?:_class([1-9]))?$", key)
    family = match.group(1) if match else key
    grade = int(match.group(2)) if match and match.group(2) else 1
    if family not in SUITS:
        return None, grade
    return family, grade


def weapon_from_symbol(value: Any) -> Optional[str]:
    """Символ оружия из журнала; ``None`` — оружия нет в каталоге."""
    key = symbol_key(value)
    return key if key in WEAPONS else None


def modification(symbol: Any) -> Optional[Dict[str, Any]]:
    """Описание модификации по символу, с запасным путём без суффикса технологии.

    У девяти рецептов оружия в каталоге символ с технологией
    (``weapon_range_kinetic``), а журнал пишет общий ``weapon_range``.
    """
    key = symbol_key(symbol)
    found = MODIFICATIONS.get(key)
    if found:
        return found
    bare = re.sub(r"_(kinetic|laser|plasma)$", "", key)
    if bare != key:
        return MODIFICATIONS.get(bare)
    # Обратный случай: журнал пишет общий ``weapon_range``, а в каталоге
    # рецепт есть только по технологиям — берём первый подходящий.
    for suffix in ("_kinetic", "_laser", "_plasma"):
        found = MODIFICATIONS.get(bare + suffix)
        if found:
            return found
    return None


def modification_name(symbol: Any) -> str:
    """Человеческое имя модификации; для незнакомой — сам символ без оболочки."""
    found = modification(symbol)
    if found:
        return str(found["name"])
    key = symbol_key(symbol)
    return key.replace("_", " ").strip()[:1].upper() + key.replace("_", " ").strip()[1:]


def tools_for(family: Optional[str]) -> List[Dict[str, str]]:
    """Инструменты костюма этого семейства — в порядке каталога."""
    if not family:
        return []
    return [{"key": key, "name": name} for key, name, families in TOOLS
            if family in families]


# ---------------------------------------------------------------------------
#  Характеристики
# ---------------------------------------------------------------------------
def _percent(value: float) -> int:
    """Доля сопротивления -> проценты, как на экране игры."""
    return int(round(float(value) * 100))


def _suit_grade(model: Dict[str, Any], grade: int) -> Dict[str, Any]:
    grades = model.get("grades") or {}
    if not grades:
        return {}
    return dict(grades.get(int(grade)) or grades[max(grades)])


def suit_stats(family: str, grade: int, mods: Sequence[Any] = ()) -> Dict[str, Any]:
    """Параметры костюма с учётом установленных модификаций.

    Возвращает то, что показывает экран игры: щит и его восстановление,
    сопротивления брони, батарею, воздух и ёмкости рюкзака. Числа — игровые
    константы каталога; модификации применяются только известные, незнакомые
    попадают в ``mods_unknown`` и ни на что не влияют.
    """
    model = SUITS.get(family)
    if not model:
        return {}
    current = _suit_grade(model, grade)
    stats: Dict[str, Any] = {
        "family": family,
        "model": model["name"],
        "grade": int(grade),
        "mounts": tuple(model["mounts"]),
        "slots": int(current.get("slots", 0)),
        "shield": float(current.get("shield", 0) or 0),
        "regen": float(current.get("regen", 0) or 0),
        "battery": float(model.get("battery", 0) or 0),
        "oxygen": float(model.get("oxygen", 0) or 0),
        "goods": int(model.get("goods", 0) or 0),
        "assets": int(model.get("assets", 0) or 0),
        "data": int(model.get("data", 0) or 0),
        "resistances": {
            "kinetic": _percent(current.get("kinetic", 0) or 0),
            "thermal": _percent(current.get("thermal", 0) or 0),
            "plasma": _percent(current.get("plasma", 0) or 0),
            "explosive": _percent(current.get("explosive", 0) or 0),
        },
        "manufacturer": SUIT_MANUFACTURERS.get(family, ""),
        "mods_applied": [],
        "mods_unknown": [],
    }
    # Ключи модификаций каталога -> ключи наших характеристик.
    targets = {
        "batteryCapacity": "battery",
        "shieldRegeneration": "regen",
        "oxygenTime": "oxygen",
        "goodsCapacity": "goods",
        "assetsCapacity": "assets",
        "dataCapacity": "data",
    }
    resistance_keys = {
        "armourKineticResistance": "kinetic",
        "armourThermalResistance": "thermal",
        "armourPlasmaResistance": "plasma",
        "armourExplosiveResistance": "explosive",
    }
    for symbol in mods:
        entry = modification(symbol)
        if not entry or entry.get("target") != "suit":
            stats["mods_unknown"].append(modification_name(symbol))
            continue
        name = str(entry["name"])
        if name in stats["mods_applied"]:
            continue                     # дважды одну модификацию не ставим
        stats["mods_applied"].append(name)
        for stat, multiplier, _round_up in entry.get("effects") or ():
            if stat in targets:
                stats[targets[stat]] = stats[targets[stat]] * float(multiplier)
            elif stat in resistance_keys:
                # Множитель относится к получаемому урону, а не к доле.
                key = resistance_keys[stat]
                share = float(multiplier)
                before = stats["resistances"][key] / 100.0
                stats["resistances"][key] = _percent(1.0 - (1.0 - before) * share)
    return stats


def weapon_stats(symbol: Any, grade: int = 1, mods: Sequence[Any] = ()) -> Dict[str, Any]:
    """Параметры оружия с учётом модификаций; пустой словарь — оружия нет в каталоге."""
    key = weapon_from_symbol(symbol)
    if not key:
        return {}
    base = WEAPONS[key]
    grades = base.get("grades") or {}
    grade = max(1, min(5, int(grade or 1)))
    damage, slots = grades.get(grade) or grades[max(grades)]
    names = [modification_name(mod) for mod in mods]
    keys = [symbol_key(mod) for mod in mods]
    magazine = float(base.get("magazine", 0) or 0)
    if "weapon_clipsize" in keys:
        # Единственный эффект каталога с округлением вверх — как в игре.
        magazine = float(math.ceil(magazine * 1.5))
    reach = float(base.get("range", 0) or 0)
    if any(key.startswith("weapon_range") for key in keys):
        reach = reach * 1.5
    return {
        "symbol": key,
        "name": base["name"],
        "class": base["class"],
        "slot": base["slot"],
        "damage_type": base["damage"],
        "fire": base["fire"],
        "grade": grade,
        "damage": float(damage),
        "slots": int(slots),
        "magazine": int(magazine),
        "reserve": int(base.get("reserve", 0) or 0),
        "range": round(reach, 1),
        "mods": names,
    }


# ---------------------------------------------------------------------------
#  Состояние снаряжения
# ---------------------------------------------------------------------------
def empty_state() -> Dict[str, Any]:
    """Состояние «снаряжение ещё не приходило» — страница покажет подсказку."""
    return {
        "known": False,
        "loadouts": [],
        "loadout": None,
        "suit": None,
        "weapons": [],
        "suit_mods": [],
        "tools": [],
        "backpack": {"items": [], "components": [], "data": [], "consumables": [],
                     "totals": {"items": 0, "components": 0, "data": 0, "consumables": 0}},
        "updated_at": None,
    }


def _entry_name(row: Dict[str, Any]) -> str:
    """Название предмета: локализованное, иначе разобранный символ."""
    localized = str(row.get("Name_Localised") or "").strip()
    if localized:
        return localized
    raw = symbol_key(row.get("Name"))
    pretty = raw.replace("_", " ").strip()
    return pretty[:1].upper() + pretty[1:] if pretty else ""


def _counts(rows: Any) -> List[Dict[str, Any]]:
    """Строки рюкзака -> список ``{name, count}``, крупное сверху."""
    merged: Dict[str, int] = {}
    order: List[str] = []
    for row in rows or ():
        if not isinstance(row, dict):
            continue
        name = _entry_name(row)
        if not name:
            continue
        try:
            count = int(row.get("Count") or 0)
        except (TypeError, ValueError):
            continue
        if name not in merged:
            order.append(name)
        merged[name] = merged.get(name, 0) + count
        if merged[name] <= 0:
            merged.pop(name, None)
            order.remove(name)
    return [{"name": name, "count": merged[name]}
            for name in sorted(order, key=lambda item: (-merged[item], item))
            if name in merged]


class PilotEquipment:
    """Наборы снаряжения пилота, рюкзак и расходники; кэш переживает перезапуск.

    Класс не знает ни про Qt, ни про сеть: приложение кормит его событиями
    журнала (``handle``) и рисует ``state()``.
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path) if path else None
        #: Наборы: ``str(LoadoutID)`` -> запись набора.
        self.loadouts: Dict[str, Dict[str, Any]] = {}
        self.current = ""
        #: Какой набор показывает страница (может отличаться от надетого).
        self.selected = ""
        self.backpack: Dict[str, Dict[str, Dict[str, Any]]] = {
            "items": {}, "components": {}, "data": {}, "consumables": {}}
        self.updated_at: Optional[str] = None
        self._saved_at = 0.0
        self._dirty = False
        self.load()

    # -- журнал -------------------------------------------------------------
    def handle(self, event: Dict[str, Any]) -> bool:
        """Обработать событие журнала. ``True`` — состояние изменилось."""
        if not isinstance(event, dict):
            return False
        name = str(event.get("event") or "")
        if name in ("SuitLoadout", "SwitchSuitLoadout"):
            changed = self._store_loadout(event, active=True)
        elif name == "CreateSuitLoadout":
            # Создание набора в игре не надевает его: активным остаётся прежний.
            changed = self._store_loadout(event, active=False)
        elif name == "DeleteSuitLoadout":
            changed = self._delete_loadout(event)
        elif name == "RenameSuitLoadout":
            changed = self._rename_loadout(event)
        elif name == "LoadoutEquipModule":
            changed = self._equip_module(event)
        elif name == "LoadoutRemoveModule":
            changed = self._remove_module(event)
        elif name == "Backpack":
            changed = self._replace_backpack(event)
        elif name == "BackpackChange":
            changed = self._change_backpack(event)
        elif name in ("BuySuit", "UpgradeSuit"):
            # Грейд костюма меняется покупкой/улучшением: обновляем наборы,
            # в которых этот костюм лежит.
            changed = self._upgrade_suit(event)
        elif name in ("SellSuit", "BuyWeapon", "UpgradeWeapon"):
            changed = False     # покупки оружия наборы не меняют
        else:
            return False
        if changed:
            self.updated_at = str(event.get("timestamp") or self.updated_at or "")
            self.save()
        return changed

    # -- наборы -------------------------------------------------------------
    def _store_loadout(self, event: Dict[str, Any], active: bool = False) -> bool:
        loadout_id = str(event.get("LoadoutID") or "").strip()
        if not loadout_id:
            return False
        family, grade = suit_from_symbol(event.get("SuitName"))
        previous = self.loadouts.get(loadout_id) or {}
        # Журнал не всегда присылает модули и модификации целиком (например,
        # при простом переключении набора) — тогда сохраняем прежние.
        if "Modules" in event:
            weapons = self._weapons_from_event(event.get("Modules"))
        else:
            weapons = dict(previous.get("weapons") or {})
        if "SuitMods" in event:
            suit_mods = list(event.get("SuitMods") or ())
        else:
            suit_mods = list(previous.get("suit_mods") or ())
        record = {
            "id": loadout_id,
            "name": str(event.get("LoadoutName") or "").strip(),
            "suit_id": str(event.get("SuitID") or "").strip(),
            "family": family or "",
            "suit_symbol": symbol_key(event.get("SuitName")),
            "suit_localized": str(event.get("SuitName_Localised") or "").strip(),
            "grade": int(grade or 1),
            "suit_mods": suit_mods,
            "weapons": weapons,
            "updated_at": str(event.get("timestamp") or ""),
        }
        changed = previous != record
        self.loadouts[loadout_id] = record
        # Пока командир не выбрал набор вручную, страница показывает надетый.
        follow = not self.selected or self.selected == self.current
        if active and self.current != loadout_id:
            self.current = loadout_id
            changed = True
        if not self.selected:
            self.selected = loadout_id
        elif active and follow:
            self.selected = loadout_id
        return changed

    def _upgrade_suit(self, event: Dict[str, Any]) -> bool:
        """Покупка или улучшение костюма: обновить грейд в его наборах."""
        suit_id = str(event.get("SuitID") or "").strip()
        family, grade = suit_from_symbol(event.get("SuitName"))
        if not suit_id or not family:
            return False
        try:
            announced = int(event.get("Class") or 0)
        except (TypeError, ValueError):
            announced = 0
        if announced:
            grade = announced
        changed = False
        for record in self.loadouts.values():
            if str(record.get("suit_id") or "") != suit_id:
                continue
            if record.get("family") == family and int(record.get("grade") or 1) == grade:
                continue
            record["family"] = family
            record["grade"] = int(grade)
            record["suit_symbol"] = symbol_key(event.get("SuitName"))
            record["updated_at"] = str(event.get("timestamp") or "")
            changed = True
        return changed

    def _weapons_from_event(self, modules: Any) -> Dict[str, Dict[str, Any]]:
        weapons: Dict[str, Dict[str, Any]] = {}
        for row in modules or ():
            if not isinstance(row, dict):
                continue
            slot = str(row.get("SlotName") or "").strip()
            if not slot:
                continue
            weapons[slot] = {
                "symbol": symbol_key(row.get("ModuleName")),
                "name": str(row.get("ModuleName_Localised") or "").strip(),
                "grade": int(row.get("Class") or 1),
                "mods": list(row.get("WeaponMods") or ()),
            }
        return weapons

    def _delete_loadout(self, event: Dict[str, Any]) -> bool:
        loadout_id = str(event.get("LoadoutID") or "").strip()
        if loadout_id not in self.loadouts:
            return False
        self.loadouts.pop(loadout_id)
        if self.current == loadout_id:
            self.current = ""
        if self.selected == loadout_id:
            self.selected = self.current or next(iter(self.loadouts), "")
        return True

    def _rename_loadout(self, event: Dict[str, Any]) -> bool:
        loadout_id = str(event.get("LoadoutID") or "").strip()
        record = self.loadouts.get(loadout_id)
        if record is None:
            return False
        name = str(event.get("LoadoutName") or "").strip()
        if record.get("name") == name:
            return False
        record["name"] = name
        record["updated_at"] = str(event.get("timestamp") or "")
        return True

    def _equip_module(self, event: Dict[str, Any]) -> bool:
        loadout_id = str(event.get("LoadoutID") or "").strip()
        slot = str(event.get("SlotName") or "").strip()
        if not loadout_id or not slot:
            return False
        record = self.loadouts.get(loadout_id)
        if record is None:
            # Набор мог не попасть в журнал этого запуска — создаём по факту.
            self._store_loadout(event)
            record = self.loadouts[loadout_id]
        record.setdefault("weapons", {})[slot] = {
            "symbol": symbol_key(event.get("ModuleName")),
            "name": str(event.get("ModuleName_Localised") or "").strip(),
            "grade": int(event.get("Class") or 1),
            "mods": list(event.get("WeaponMods") or ()),
        }
        record["updated_at"] = str(event.get("timestamp") or "")
        return True

    def _remove_module(self, event: Dict[str, Any]) -> bool:
        loadout_id = str(event.get("LoadoutID") or "").strip()
        slot = str(event.get("SlotName") or "").strip()
        record = self.loadouts.get(loadout_id)
        if record is None or slot not in (record.get("weapons") or {}):
            return False
        record["weapons"].pop(slot)
        record["updated_at"] = str(event.get("timestamp") or "")
        return True

    # -- рюкзак -------------------------------------------------------------
    def _replace_backpack(self, event: Dict[str, Any]) -> bool:
        self.backpack = {key: {} for key in self.backpack}
        for journal_key, state_key in BACKPACK_KINDS:
            for row in _counts(event.get(journal_key)):
                self.backpack[state_key][row["name"]] = int(row["count"])
        return True

    def _change_backpack(self, event: Dict[str, Any]) -> bool:
        changed = False
        for direction, sign in (("Added", 1), ("Removed", -1)):
            for row in event.get(direction) or ():
                if not isinstance(row, dict):
                    continue
                kind = BACKPACK_TYPE_KEYS.get(symbol_key(row.get("Type")))
                if kind is None:
                    kind = "items"
                name = _entry_name(row)
                if not name:
                    continue
                try:
                    amount = int(row.get("Count") or 0) * sign
                except (TypeError, ValueError):
                    continue
                bucket = self.backpack.setdefault(kind, {})
                total = int(bucket.get(name, 0)) + amount
                if total > 0:
                    bucket[name] = total
                else:
                    bucket.pop(name, None)
                changed = True
        return changed

    def read_backpack_file(self, journal_dir: Optional[Path]) -> bool:
        """Прочитать ``Backpack.json`` из папки журналов.

        Игра пишет этот файл сама, поэтому рюкзак виден сразу после запуска
        Helper — без прогона всей истории журналов.
        """
        if not journal_dir:
            return False
        path = Path(journal_dir) / "Backpack.json"
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return False
        if not isinstance(data, dict):
            return False
        changed = self._replace_backpack(data)
        if changed:
            self.save(force=True)
        return changed

    # -- выбор набора -------------------------------------------------------
    def select(self, loadout_id: str) -> bool:
        """Показать другой набор (страница не переключает снаряжение в игре)."""
        loadout_id = str(loadout_id or "")
        if loadout_id not in self.loadouts or loadout_id == self.selected:
            return False
        self.selected = loadout_id
        return True

    def shown_id(self) -> str:
        """Какой набор показывать: выбранный, иначе надетый, иначе первый."""
        if self.selected in self.loadouts:
            return self.selected
        if self.current in self.loadouts:
            return self.current
        return next(iter(self.loadouts), "")

    # -- состояние для интерфейса -------------------------------------------
    def state(self) -> Dict[str, Any]:
        """Всё, что рисует страница «Пилот»: наборы, костюм, оружие, рюкзак."""
        if not self.loadouts and not any(self.backpack.values()):
            return empty_state()
        shown_id = self.shown_id()
        record = self.loadouts.get(shown_id) or {}
        family = record.get("family") or ""
        grade = int(record.get("grade") or 1)
        suit_mods = list(record.get("suit_mods") or ())
        stats = suit_stats(family, grade, suit_mods) if family else {}
        weapons = []
        for slot in SLOT_ORDER:
            row = (record.get("weapons") or {}).get(slot)
            if not row:
                continue
            weapon = weapon_stats(row.get("symbol"), row.get("grade") or 1, row.get("mods") or ())
            if not weapon:
                # Оружия нет в каталоге (мод или новая модель) — показываем то,
                # что дал журнал, без выдуманных характеристик.
                weapon = {"symbol": row.get("symbol") or "", "name": "",
                          "class": "", "slot": slot, "damage_type": "", "fire": "",
                          "grade": int(row.get("grade") or 1), "damage": 0.0,
                          "slots": 0, "magazine": 0, "reserve": 0, "range": 0.0,
                          "mods": [modification_name(mod) for mod in row.get("mods") or ()]}
            weapon.update({
                "slot": slot,
                "kind": SLOT_KINDS.get(slot, "primary"),
                "label": row.get("name") or weapon.get("name", ""),
            })
            weapons.append(weapon)
        loadouts = []
        for loadout_id, item in self.loadouts.items():
            loadout_id = str(loadout_id)
            item_family = item.get("family") or ""
            item_grade = int(item.get("grade") or 1)
            item_stats = suit_stats(item_family, item_grade) if item_family else {}
            loadouts.append({
                "id": loadout_id,
                "name": item.get("name") or "",
                "model": item_stats.get("model", ""),
                "family": item_family,
                "grade": item_grade,
                "active": loadout_id == self.current,
                "shown": loadout_id == shown_id,
                "weapons": len(item.get("weapons") or {}),
                "mods": len(item.get("suit_mods") or ()),
            })
        loadouts.sort(key=lambda item: (not item["active"], item["name"].lower()))
        totals = {key: sum(int(value) for value in bucket.values())
                  for key, bucket in self.backpack.items()}
        return {
            "known": bool(self.loadouts),
            "loadouts": loadouts,
            "loadout": {
                "id": shown_id,
                "name": record.get("name") or "",
                "suit_localized": record.get("suit_localized") or "",
                "active": shown_id == self.current,
                "updated_at": record.get("updated_at") or "",
            } if record else None,
            "suit": stats or None,
            "weapons": weapons,
            "suit_mods": [{"name": modification_name(symbol)} for symbol in suit_mods],
            "tools": tools_for(family),
            "backpack": {
                key: [{"name": name, "count": count} for name, count in
                      sorted(bucket.items(), key=lambda pair: (-pair[1], pair[0]))]
                for key, bucket in self.backpack.items()
            } | {"totals": totals},
            "updated_at": self.updated_at,
        }

    # -- сохранение ---------------------------------------------------------
    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": 1,
            "current": self.current,
            "selected": self.selected,
            "updated_at": self.updated_at,
            "loadouts": self.loadouts,
            "backpack": self.backpack,
        }

    def from_dict(self, data: Dict[str, Any]) -> None:
        if not isinstance(data, dict):
            return
        loadouts = data.get("loadouts")
        if isinstance(loadouts, dict):
            self.loadouts = {str(key): value for key, value in loadouts.items()
                             if isinstance(value, dict)}
        backpack = data.get("backpack")
        if isinstance(backpack, dict):
            for key in self.backpack:
                bucket = backpack.get(key)
                if isinstance(bucket, dict):
                    self.backpack[key] = {str(name): int(value or 0)
                                          for name, value in bucket.items()}
        self.current = str(data.get("current") or "")
        self.selected = str(data.get("selected") or "")
        self.updated_at = data.get("updated_at") or None

    def load(self) -> bool:
        if self.path is None:
            return False
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return False
        self.from_dict(data)
        return True

    def save(self, force: bool = False) -> None:
        """Записать кэш на диск; не чаще ``SAVE_INTERVAL`` секунд без ``force``."""
        if self.path is None:
            return
        now = time.time()
        self._dirty = True
        if not force and now - self._saved_at < SAVE_INTERVAL:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(self.path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.to_dict(), fh, ensure_ascii=False)
            os.replace(tmp, self.path)
        except OSError:
            return
        self._saved_at = now
        self._dirty = False
