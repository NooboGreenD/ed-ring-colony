"""Типы построек для Raven Colonial (`buildType`) — фиксированный справочник.

Зачем это нужно
---------------
Raven Colonial при открытии проекта ищет тип постройки в собственном
справочнике. Если в `buildType` стоит незнакомая строка (опечатка, свободный
ввод, игровой токен вроде `$Coriolis_Starport;`), страница проекта падает с
ошибкой `Cannot read properties of undefined (reading 'buildClass')` и не
открывается. Поэтому тип выбирается только из этого списка, а значения из
планов Raven и журнала приводятся к нему через `normalize_build_type()`.

Коды совпадают с `id` каталога «Архитектора» (`src/lib/architect/catalogue.ts`)
и с его псевдонимами (`BUILD_TYPE_ALIASES` в `src/lib/architect/progress.ts`).
Если Raven введёт новый код, добавьте его сюда и в каталог сайта.

Журнал игры тип постройки не содержит, поэтому автоматически он берётся
только из плана системы Raven (`GET /api/v2/system/{system}/sites`).
"""
import re
from typing import Dict, List, Optional, Tuple

# (код Raven, название RU, название EN) — порядок как в каталоге «Архитектора».
BUILD_TYPES: List[Tuple[str, str, str]] = [
    ("no_truss", "Кориолис (звёздный порт)", "Coriolis Starport"),
    ("asteroid", "Астероидная база", "Asteroid Base"),
    ("dodec", "Додекаэдр (звёздный порт)", "Dodec Starport"),
    ("ocellus", "Оцеллус (звёздный порт)", "Ocellus Starport"),
    ("apollo", "Орбис (звёздный порт)", "Orbis Starport"),
    ("plutus", "Коммерческий аванпост", "Commercial Outpost"),
    ("vulcan", "Промышленный аванпост", "Industrial Outpost"),
    ("dysnomia", "Пиратский аванпост", "Pirate Outpost"),
    ("vesta", "Гражданский аванпост", "Civilian Outpost"),
    ("prometheus", "Научный аванпост", "Scientific Outpost"),
    ("nemesis", "Военный аванпост", "Military Outpost"),
    ("hermes", "Спутник", "Satellite Installation"),
    ("pistis", "Станция связи", "Comms Installation"),
    ("demeter", "Космическая ферма", "Agricultural Installation"),
    ("apate", "Пиратская база", "Pirate Installation"),
    ("euthenia", "Добывающая установка", "Industrial Installation"),
    ("enodia", "Ретранслятор", "Relay Installation"),
    ("vacuna", "Военная установка", "Military Installation"),
    ("dicaeosyne", "Охранная станция", "Security Installation"),
    ("harmonia", "Правительственная установка", "Government Installation"),
    ("asclepius", "Медицинская установка", "Medical Installation"),
    ("astraeus", "Исследовательская станция", "Scientific Installation"),
    ("hedone", "Туристическая установка", "Tourist Installation"),
    ("dionysus", "Космический бар", "Space Bar"),
    ("hestia", "Гражданское поселение", "Civilian Settlement"),
    ("hephaestus", "Промышленное поселение", "Industrial Settlement"),
    ("necessitas", "Научное поселение", "Scientific Settlement"),
    ("zeus", "Планетарный порт", "Port Surface Outpost"),
    ("consus", "Сельхозпоселение (малое)", "Agricultural Settlement - Small"),
    ("picumnus", "Сельхозпоселение (среднее)", "Agricultural Settlement - Medium"),
    ("ceres", "Сельхозпоселение (большое)", "Agricultural Settlement - Large"),
    ("ourea", "Добывающее поселение (малое)", "Extraction Settlement - Small"),
    ("mantus", "Добывающее поселение (среднее)", "Extraction Settlement - Medium"),
    ("erebus", "Добывающее поселение (большое)", "Extraction Settlement - Large"),
    ("fontus", "Индустриальное поселение (малое)", "Industrial Settlement - Small"),
    ("meteope", "Индустриальное поселение (среднее)", "Industrial Settlement - Medium"),
    ("gaea", "Индустриальное поселение (большое)", "Industrial Settlement - Large"),
    ("ioke", "Военное поселение (малое)", "Military Settlement - Small"),
    ("bellona", "Военное поселение (среднее)", "Military Settlement - Medium"),
    ("minerva", "Военное поселение (большое)", "Military Settlement - Large"),
    ("pheobe", "Хайтек-поселение (малое)", "High Tech Settlement - Small"),
    ("asteria", "Хайтек-поселение (среднее)", "High Tech Settlement - Medium"),
    ("chronos", "Хайтек-поселение (большое)", "High Tech Settlement - Large"),
    ("aergia", "Турпоселение (малое)", "Tourism Settlement - Small"),
    ("comus", "Турпоселение (среднее)", "Tourism Settlement - Medium"),
    ("fufluns", "Турпоселение (большое)", "Tourism Settlement - Large"),
    ("tartarus", "Добывающий хаб", "Extraction Hub"),
    ("aegle", "Гражданский хаб", "Civilian Hub"),
    ("tellus", "Исследовательский хаб", "Exploration Hub"),
    ("io", "Аванпост-хаб", "Outpost Hub"),
    ("athena", "Научный хаб", "Scientific Hub"),
    ("alala", "Военный хаб", "Military Hub"),
    ("silenus", "Перерабатывающий хаб", "Refinery Hub"),
    ("janus", "Хайтек-хаб", "High Tech Hub"),
    ("molae", "Индустриальный хаб", "Industrial Hub"),
]

BUILD_TYPE_CODES = frozenset(code for code, _ru, _en in BUILD_TYPES)

# Игровые токены и устаревшие имена → код справочника (зеркало
# BUILD_TYPE_ALIASES из progress.ts; ключи без разделителей, в нижнем регистре).
_ALIASES: Dict[str, str] = {
    "coriolis": "no_truss", "dualtruss": "no_truss", "quadtruss": "no_truss",
    "notruss": "no_truss", "asteroid": "asteroid", "dodec": "dodec",
    "quinttruss": "dodec", "dectruss": "dodec", "ocellus": "ocellus",
    "apollo": "apollo", "artemis": "apollo", "orbis": "apollo",
    "plutus": "plutus", "vulcan": "vulcan", "dysnomia": "dysnomia",
    "vesta": "vesta", "prometheus": "prometheus", "nemesis": "nemesis",
    "hermes": "hermes", "angelia": "hermes", "eirene": "hermes",
    "pistis": "pistis", "soter": "pistis", "aletheia": "pistis",
    "demeter": "demeter", "apate": "apate", "taverna": "apate",
    "io": "io", "athena": "athena", "caelus": "athena",
    "alala": "alala", "ares": "alala", "silenus": "silenus", "janus": "janus",
}

_NAMES: Dict[str, str] = {code: ru for code, ru, _en in BUILD_TYPES}

# Суффиксы класса: `Coriolis Starport` → `coriolis`, `Ceres Settlement` → `ceres`.
_CLASS_SUFFIXES = ("starport", "settlement", "installation", "outpost", "hub", "port")


def build_type_label(code: str) -> str:
    """`zeus` → «Планетарный порт [zeus]» — подпись в списке выбора."""
    code = str(code or "")
    name = _NAMES.get(code, "")
    return f"{name} [{code}]" if name else code


def _lookup(key: str) -> Optional[str]:
    if key in BUILD_TYPE_CODES:
        return key
    for code in BUILD_TYPE_CODES:
        if code.replace("_", "") == key:
            return code
    return _ALIASES.get(key)


def normalize_build_type(value) -> Optional[str]:
    """Привести значение из Raven или журнала к коду справочника.

    Неизвестное значение возвращает None — такой тип в проект не отправляем.
    `$Coriolis_Starport; (primary)` → `no_truss`, `Orbis Starport` → `apollo`.
    """
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"\s*\(primary\)\s*$", "", value.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"^\$+", "", cleaned)
    cleaned = re.sub(r"_name;?$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"[^a-z0-9]+", "", cleaned.lower())
    if not cleaned:
        return None
    direct = _lookup(cleaned)
    if direct:
        return direct
    for suffix in _CLASS_SUFFIXES:
        if cleaned.endswith(suffix) and len(cleaned) > len(suffix):
            found = _lookup(cleaned[: -len(suffix)])
            if found:
                return found
    return None
