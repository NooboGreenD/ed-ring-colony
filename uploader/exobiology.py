"""Экзобиология: состояние тел и предсказание образцов.

ВАЖНО ПРО ЛИЦЕНЗИЮ
------------------

Критерии «какой вид где растёт» живут в проекте SrvSurvey (GPL-3.0).
Репозиторий `ed-ring-colony` распространяется без лицензии, поэтому **ни
одна строка кода и ни один файл данных оттуда сюда не переносились**.

Здесь своя, заведомо упрощённая модель, построенная на общих правилах игры,
известных игрокам:

* большинство родов требуют **тонкой атмосферы** — именно поэтому биосигналы
  на карте системы видны в основном на телах с thin-атмосферой;
* часть родов растёт **только на телах без атмосферы** (Amphora Plant,
  Bark Mounds, Conchas, Shards);
* несколько родов привязаны к **геологической активности** (Conchas,
  Electricae, Fumerola, Shards);
* Bacterium — самый всеядный род, встречается почти везде.

Модель предсказывает **род**, а не вид/вариант: точные правила по вариантам
(какой именно Tussock или Bacterium) требуют тех самых таблиц критериев,
которые мы сознательно не копируем. Все правила лежат в одной таблице
`GENUS_RULES` — её легко уточнить, дописав поля `temp`, `gravity`, `materials`
и элементы атмосферы.

Данные берутся **из журнала самого игрока**: `Scan`, `SAAScanComplete`,
`SAASignalsFound`, `FSSBodySignals`, `ScanOrganic`, `CodexEntry`, а также
локального кэша ранее посещённых систем. Всё работает офлайн.
"""

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

# В журнале тип биосигнала приходит в виде локализационного токена.
BIO_SIGNAL_TOKENS = (
    "$SAA_SignalType_Biological;",
    "SAA_SignalType_Biological",
    "Biological",
    "биологическ",
)

# Тела, на которые можно сесть (Odyssey: посадка возможна только на безатмосферные тела
# или тела с разреженной атмосферой следующих классов). На водные, аммиачные и землеподобные
# планеты, а также газовые гиганты посадка невозможна.
LANDABLE_PLANET_CLASSES = {
    "Metal rich body",
    "High metal content body",
    "Rocky body",
    "Rocky ice body",
    "Icy body",
}


def is_landable(body: dict) -> bool:
    """Определяет, возможна ли посадка на тело (Odyssey exobiology)."""
    if not isinstance(body, dict) or not body:
        return False
    if "landable" in body:
        return bool(body.get("landable"))
    pclass = body.get("planet_class")
    if pclass:
        return pclass in LANDABLE_PLANET_CLASSES
    return True


# Стадии взятия образца в журнале (ScanOrganic.ScanType).
SAMPLE_STAGES = ("Log", "Analyse", "Sample")
# Полный кредит за вид — 3 образца с разных точек.
SAMPLES_FOR_FULL_CREDIT = 3

# После каждого образца организм «закрывается», и следующий снимок удаётся
# сделать не сразу. Точного значения в документации нет — это эмпирическая
# пауза, которую называют игроки (~30 с). Оверлей показывает обратный отсчёт
# до неё как подсказку, а не как гарантию: считать можно и раньше.
SAMPLE_COOLDOWN_SECONDS = 30.0

# Множители выплаты за биологические образцы (актуальные правила Odyssey с Update 14):
# ×5 — бонус первопроходца (First Footfall / First Logged).
# Бонус карты поверхности (DSS) в Vista Genomics не начисляется (множитель 1.0).
FIRST_DISCOVERY_BONUS = 5.0
MAPPED_BONUS = 1.0

# Оценка стоимости полного комплекта (3 образца) по роду, кр (Odyssey Update 14+).
# Базовые выплаты без учета бонуса первопроходца (бонус ×5 добавляется при no_first_footfall).
GENUS_VALUE_CR: Dict[str, int] = {
    "Aleoida": 6_650_000,
    "Amphora Plant": 3_626_400,
    "Anemone": 1_740_000,
    "Bacterium": 3_200_000,
    "Bark Mounds": 1_471_900,
    "Brain Trees": 2_820_000,
    "Cactoida": 5_700_000,
    "Clypeus": 12_160_000,
    "Conchas": 8_420_000,
    "Crystalline Shards": 3_626_400,
    "Electricae": 6_284_600,
    "Fonticulua": 8_440_000,
    "Frutexa": 4_400_000,
    "Fumerola": 9_070_000,
    "Fungoida": 2_850_000,
    "Osseus": 5_620_000,
    "Recepta": 14_480_000,
    "Sinuous Tubers": 1_750_000,
    "Stratum": 5_800_000,
    "Tubus": 6_060_000,
    "Tussock": 5_200_000,
}

# Базовые выплаты Vista Genomics по конкретным видам (Odyssey Update 14+).
SPECIES_VALUE_CR: Dict[str, int] = {
    # Aleoida
    "Aleoida Arcus": 7_252_500,
    "Aleoida Coronamus": 6_284_600,
    "Aleoida Gravis": 12_934_900,
    "Aleoida Laminiae": 3_385_200,
    "Aleoida Spica": 3_385_200,
    # Amphora Plant
    "Amphora Plant": 3_626_400,
    # Anemone
    "Anemone Croceum": 3_399_800,
    "Anemone Blatteum": 1_499_900,
    "Anemone Luteolum": 1_499_900,
    "Anemone Prasinum": 1_499_900,
    "Anemone Puniceum": 1_499_900,
    "Anemone Roseum": 1_499_900,
    "Anemone Rubeum": 1_499_900,
    "Anemone Imperator": 1_499_900,
    # Bacterium
    "Bacterium Acies": 1_000_000,
    "Bacterium Aurasus": 1_000_000,
    "Bacterium Vesicula": 1_000_000,
    "Bacterium Bullaris": 1_152_500,
    "Bacterium Alcyoneum": 1_658_500,
    "Bacterium Cerbrus": 1_689_800,
    "Bacterium Tela": 1_949_000,
    "Bacterium Verrata": 3_897_000,
    "Bacterium Omentum": 4_638_900,
    "Bacterium Volu": 7_774_700,
    "Bacterium Informem": 8_418_000,
    "Bacterium Scopulum": 8_633_800,
    "Bacterium Nebulus": 9_116_600,
    # Bark Mounds
    "Bark Mounds": 1_471_900,
    # Brain Trees
    "Brain Trees Roseum": 1_593_700,
    "Brain Trees Viride": 1_593_700,
    "Brain Trees Lividum": 1_593_700,
    "Brain Trees Aureum": 3_565_100,
    "Brain Trees Gypseeum": 3_565_100,
    "Brain Trees Lindigoticum": 3_565_100,
    "Brain Trees Ostrinum": 3_565_100,
    "Brain Trees Puniceum": 3_565_100,
    "Brain Tree Roseum": 1_593_700,
    "Brain Tree Viride": 1_593_700,
    "Brain Tree Lividum": 1_593_700,
    "Brain Tree Aureum": 3_565_100,
    "Brain Tree Gypseeum": 3_565_100,
    "Brain Tree Lindigoticum": 3_565_100,
    "Brain Tree Ostrinum": 3_565_100,
    "Brain Tree Puniceum": 3_565_100,
    # Cactoida
    "Cactoida Lapis": 2_483_600,
    "Cactoida Peperatis": 2_483_600,
    "Cactoida Cortexum": 3_667_600,
    "Cactoida Pullulanta": 3_667_600,
    "Cactoida Vermis": 16_202_800,
    # Clypeus
    "Clypeus Lacrimam": 8_418_000,
    "Clypeus Margaritus": 11_873_200,
    "Clypeus Speculumi": 16_202_800,
    # Concha
    "Conchas Labiata": 2_352_400,
    "Conchas Renibus": 4_572_400,
    "Conchas Aureolas": 7_774_700,
    "Conchas Biconcavis": 19_010_800,
    "Concha Labiata": 2_352_400,
    "Concha Renibus": 4_572_400,
    "Concha Aureolas": 7_774_700,
    "Concha Biconcavis": 19_010_800,
    # Crystalline Shards
    "Crystalline Shards": 3_626_400,
    # Electricae
    "Electricae Pluma": 6_284_600,
    "Electricae Radialem": 6_284_600,
    # Fonticulua
    "Fonticulua Campestris": 1_000_000,
    "Fonticulua Digitos": 1_804_100,
    "Fonticulua Lapida": 3_111_000,
    "Fonticulua Upupam": 5_727_600,
    "Fonticulua Fluctus": 20_000_000,
    "Fonticulua Segmentatus": 19_010_800,
    # Frutexa
    "Frutexa Metallicum": 1_632_500,
    "Frutexa Fera": 1_632_500,
    "Frutexa Collum": 1_639_800,
    "Frutexa Flabellum": 1_808_900,
    "Frutexa Sponsae": 5_988_000,
    "Frutexa Acus": 7_774_700,
    "Frutexa Flammasis": 10_326_000,
    # Fumerola
    "Fumerola Aquatis": 6_284_600,
    "Fumerola Carbosis": 6_284_600,
    "Fumerola Nitris": 7_500_900,
    "Fumerola Extremus": 16_202_800,
    # Fungoida
    "Fungoida Setisis": 1_670_100,
    "Fungoida Stabitis": 2_680_300,
    "Fungoida Gelata": 3_330_300,
    "Fungoida Bullarum": 3_703_200,
    # Osseus
    "Osseus Cornibus": 1_483_000,
    "Osseus Spiralis": 2_404_700,
    "Osseus Pumice": 3_156_300,
    "Osseus Fractus": 4_027_800,
    "Osseus Pellebantus": 9_739_000,
    "Osseus Discus": 12_934_900,
    # Recepta
    "Recepta Umbrux": 12_934_900,
    "Recepta Conditivus": 14_313_700,
    "Recepta Deltahedronix": 16_202_800,
    # Sinuous Tubers
    "Sinuous Tubers Albidum": 3_425_600,
    "Sinuous Tubers": 1_514_500,
    # Stratum
    "Stratum Limaxus": 1_362_000,
    "Stratum Paleas": 1_362_000,
    "Stratum Araneamus": 2_448_900,
    "Stratum Excutitus": 2_448_900,
    "Stratum Frigus": 2_637_500,
    "Stratum Laminamus": 2_788_300,
    "Stratum Cucumisis": 16_202_800,
    "Stratum Tectonicas": 19_010_800,
    # Tubus
    "Tubus Conifer": 2_415_500,
    "Tubus Rosarium": 2_637_500,
    "Tubus Sororibus": 5_727_600,
    "Tubus Compagibus": 7_774_700,
    "Tubus Cavas": 11_873_200,
    # Tussock
    "Tussock Pennatis": 1_000_000,
    "Tussock Propagito": 1_000_000,
    "Tussock Catena": 1_766_600,
    "Tussock Cultro": 1_766_600,
    "Tussock Divisa": 1_766_600,
    "Tussock Ignis": 1_849_000,
    "Tussock Albata": 3_252_500,
    "Tussock Ventusa": 3_277_700,
    "Tussock Caputus": 3_472_400,
    "Tussock Serrati": 4_447_100,
    "Tussock Pennata": 5_853_800,
    "Tussock Capillum": 7_025_800,
    "Tussock Triticum": 7_774_700,
    "Tussock Virgam": 14_313_700,
    "Tussock Stigmasis": 19_010_800,
}

#: Старые/разговорные названия родов → имена, которые даёт журнал
#: (`SAASignalsFound.Genuses`, `ScanOrganic.Genus`). Без этой таблицы оценка
#: «Crystalline Shard»/«Sinuous Tuber» давала ноль, и оверлей молчал.
GENUS_ALIASES: Dict[str, str] = {
    "shards": "Crystalline Shards",
    "crystalline shard": "Crystalline Shards",
    "tubers": "Sinuous Tubers",
    "sinuous tuber": "Sinuous Tubers",
    "sinuous tubers": "Sinuous Tubers",
    "concha": "Conchas",
    "concha renibus": "Conchas",
    "brain tree": "Brain Trees",
    "bark mound": "Bark Mounds",
    "amphora": "Amphora Plant",
    "anemones": "Anemone",
    "amphora plants": "Amphora Plant",
    "crystalline shards": "Crystalline Shards",
}


def normalize_genus(name: object) -> str:
    """Привести название рода к каноническому (как в журнале)."""
    text = str(name or "").strip()
    if not text:
        return ""
    if text in GENUS_RULES:
        return text
    alias = GENUS_ALIASES.get(text.lower())
    if alias:
        return alias
    head = text.split()[0].lower() if text.split() else ""
    return GENUS_ALIASES.get(head, text)


# Сколько тел держим в памяти (увеличено для исследователей и длинных экспедиций).
MAX_TRACKED_BODIES = 10_000


def _as_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def atmosphere_category(body: dict) -> str:
    """none / thin / thick / unknown — по данным события Scan."""
    if not isinstance(body, dict):
        return "unknown"
    atmosphere = str(body.get("atmosphere") or "").strip().lower()
    atmosphere_type = str(body.get("atmosphere_type") or "").strip().lower()
    combined = f"{atmosphere} {atmosphere_type}".strip()
    if not combined:
        return "unknown"
    if "no atmosphere" in combined or combined in ("none", ""):
        return "none"
    if "thick" in combined or "hot" in combined or "rich" in combined:
        return "thick"
    if "thin" in combined:
        return "thin"
    # В Elite Dangerous Odyssey посадка разрешена исключительно на тела с тонкой (tenuous) атмосферой.
    # Если планета landable и имеет атмосферу — в рамках игры это тонкая атмосфера:
    if body.get("landable"):
        return "thin"
    # Проверка давления: в журнале SurfacePressure в Паскалях (1 атм ~ 101325 Па).
    # Тонкие атмосферы Odyssey обычно <= 15 000 Па (~0.15 атм).
    pressure = _as_float(body.get("surface_pressure"), 0.0)
    if 0 < pressure <= 15000:
        return "thin"
    if pressure > 15000:
        return "thick"
    # Если указан конкретный газ или есть слово atmosphere:
    if "atmosphere" in combined or (atmosphere_type and atmosphere_type not in ("none", "unknown")):
        return "thin"
    return "unknown"


def body_props(event: dict, system: str = "") -> Optional[dict]:
    """Собрать свойства тела из события `Scan` (None, если это не тело)."""
    planet_class = str(event.get("PlanetClass") or "").strip()
    if not planet_class:
        return None
    name = str(event.get("BodyName") or event.get("Body") or "").strip()
    if not name:
        return None

    materials = event.get("Materials") or []
    material_names = set()
    if isinstance(materials, list):
        for item in materials:
            if isinstance(item, dict):
                material = item.get("Name_Localised") or item.get("Name")
                if material:
                    material_names.add(str(material).strip().lower())
    composition = event.get("AtmosphereComposition") or []
    atmosphere_elements = set()
    if isinstance(composition, list):
        for item in composition:
            if isinstance(item, dict):
                element = item.get("Name")
                if element:
                    atmosphere_elements.add(str(element).strip().lower())

    parents = event.get("Parents") or []
    star_types: List[str] = []
    if isinstance(parents, list):
        for parent in parents:
            if isinstance(parent, dict) and parent.get("Star"):
                star_types.append(str(parent.get("StarType") or ""))

    landable = planet_class in LANDABLE_PLANET_CLASSES
    if "Landable" in event:
        landable = landable and bool(event.get("Landable"))

    was_discovered = event.get("WasDiscovered")
    no_first_footfall = False
    if was_discovered is False:
        no_first_footfall = True
    if event.get("no_first_footfall") is not None:
        no_first_footfall = bool(event.get("no_first_footfall"))
    first_footfall_by = str(event.get("first_footfall_by") or event.get("FirstFootfallBy") or "").strip()
    if first_footfall_by and first_footfall_by not in ("Вы", "You"):
        no_first_footfall = False

    return {
        "system": system or str(event.get("StarSystem") or "").strip(),
        "name": name,
        "body_id": event.get("BodyID"),
        "planet_class": planet_class,
        "landable": landable,
        "atmosphere": str(event.get("Atmosphere") or ""),
        "atmosphere_type": str(event.get("AtmosphereType") or ""),
        "atmosphere_elements": sorted(atmosphere_elements),
        "surface_gravity": _as_float(event.get("SurfaceGravity"), 0.0),
        "surface_temperature": _as_float(event.get("SurfaceTemperature"), 0.0),
        "surface_pressure": _as_float(event.get("SurfacePressure"), 0.0),
        "volcanism": str(event.get("Volcanism") or "").strip(),
        "distance_ls": _as_float(event.get("DistanceFromArrivalLS"), 0.0),
        "materials": sorted(material_names),
        "star_types": star_types,
        "mapped": False,
        "bio_signals": 0,
        "confirmed_genera": [],
        "was_discovered": was_discovered,
        "no_first_footfall": no_first_footfall,
        "first_footfall_by": first_footfall_by,
    }


def estimate_value(name: object, mapped: bool = False,
                   first_discovery: bool = False) -> int:
    """Оценка стоимости полного комплекта образцов (3 штуки), кр.

    `name` может быть названием конкретного вида («Stratum Tectonicas») или рода («Stratum»).
    `first_discovery=True` применяет бонус первопроходца (×5).
    """
    if not name:
        return 0
    text = str(name).strip()
    base = 0

    # 1. Прямое или case-insensitive совпадение с видом
    if text in SPECIES_VALUE_CR:
        base = SPECIES_VALUE_CR[text]
    else:
        text_lower = text.lower()
        for sp_name, val in SPECIES_VALUE_CR.items():
            if sp_name.lower() == text_lower:
                base = val
                break

    # 2. Если вид не найден, проверяем по роду (с учетом алиасов)
    if not base:
        norm = normalize_genus(text)
        if norm in SPECIES_VALUE_CR:
            base = SPECIES_VALUE_CR[norm]
        elif norm in GENUS_VALUE_CR:
            base = GENUS_VALUE_CR[norm]
        elif text in GENUS_VALUE_CR:
            base = GENUS_VALUE_CR[text]
        else:
            first_word = text.split()[0] if " " in text else ""
            if first_word:
                norm_first = normalize_genus(first_word)
                if norm_first in GENUS_VALUE_CR:
                    base = GENUS_VALUE_CR[norm_first]

    if not base:
        return 0

    value = float(base)
    if first_discovery:
        value *= FIRST_DISCOVERY_BONUS
    if mapped:
        value *= MAPPED_BONUS
    return int(round(value))


def format_credits(value) -> str:
    """«1.2 млн» / «850 тыс» — в оверлее мало места на полные числа."""
    try:
        value = float(value or 0)
    except (TypeError, ValueError):
        return "0"
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f} млн".replace(".0 млн", " млн")
    if value >= 1_000:
        return f"{value / 1_000:.0f} тыс"
    return f"{value:.0f}"


# ============================================================
#  Поиск планет по параметрам
# ============================================================
# Отдельная задача пользователя: «поиск планет с параметрами — при нахождении
# такой планеты в системе выводить информацию в оверлей (например планета
# каменистая с атмосферой и посадкой, ледяная с посадкой и т.д.)».
#
# Критерии намеренно описаны данными, а не кодом: пресет — это словарь, его
# можно дополнить одной строкой, не трогая функцию поиска.

#: Группы типов планет: `PlanetClass` из журнала собран в понятные наборы.
PLANET_CLASS_GROUPS: Dict[str, Tuple[str, ...]] = {
    "rocky": ("Rocky body",),
    "icy": ("Icy body",),
    "rocky_ice": ("Rocky ice body",),
    "metal_rich": ("Metal rich body",),
    "high_metal": ("High metal content body",),
    "earthlike": ("Earthlike body",),
    "water": ("Water world",),
    "ammonia": ("Ammonia world",),
}

#: Русские подписи групп — для вкладки настроек.
PLANET_GROUP_LABELS: Dict[str, str] = {
    "rocky": "Каменистая",
    "icy": "Ледяная",
    "rocky_ice": "Каменисто-ледяная",
    "metal_rich": "Богатая металлом",
    "high_metal": "Высокое содержание металла",
    "earthlike": "Землеподобная",
    "water": "Мир с водой",
    "ammonia": "Аммиачный мир",
}

#: Готовые наборы критериев. `classes` пусто — подходит любой тип.
#: `atmosphere`: "any" / "none" / "present" / "thin" / "thick".
PLANET_SEARCH_PRESETS: Tuple[Dict[str, Any], ...] = (
    {
        "id": "rocky_atmo_land",
        "label": "Каменистая с атмосферой и посадкой",
        "classes": ("rocky",), "landable": True, "atmosphere": "present",
    },
    {
        "id": "rocky_land_noatmo",
        "label": "Каменистая с посадкой, без атмосферы",
        "classes": ("rocky",), "landable": True, "atmosphere": "none",
    },
    {
        "id": "high_metal_atmo_land",
        "label": "Высокое содержание металла с атмосферой и посадкой",
        "classes": ("high_metal",), "landable": True, "atmosphere": "present",
    },
    {
        "id": "high_metal_land",
        "label": "Высокое содержание металла, с посадкой",
        "classes": ("high_metal",), "landable": True, "atmosphere": "any",
    },
    {
        "id": "icy_atmo_land",
        "label": "Ледяная с атмосферой и посадкой",
        "classes": ("icy",), "landable": True, "atmosphere": "present",
    },
    {
        "id": "icy_land",
        "label": "Ледяная с посадкой",
        "classes": ("icy",), "landable": True, "atmosphere": "any",
    },
    {
        "id": "rocky_ice_atmo_land",
        "label": "Каменисто-ледяная с атмосферой и посадкой",
        "classes": ("rocky_ice",), "landable": True, "atmosphere": "present",
    },
    {
        "id": "rocky_ice_land",
        "label": "Каменисто-ледяная с посадкой",
        "classes": ("rocky_ice",), "landable": True, "atmosphere": "any",
    },
    {
        "id": "metal_rich_land",
        "label": "Богатая металлом с посадкой",
        "classes": ("metal_rich",), "landable": True, "atmosphere": "any",
    },
    {
        "id": "earthlike",
        "label": "Землеподобная",
        "classes": ("earthlike",), "landable": None, "atmosphere": "any",
    },
    {
        "id": "water_world",
        "label": "Мир с водой",
        "classes": ("water",), "landable": None, "atmosphere": "any",
    },
    {
        "id": "ammonia_world",
        "label": "Аммиачный мир",
        "classes": ("ammonia",), "landable": None, "atmosphere": "any",
    },
    {
        "id": "volcanic_land",
        "label": "С вулканизмом и посадкой",
        "classes": (), "landable": True, "atmosphere": "any", "volcanism": True,
    },
    {
        "id": "any_landable",
        "label": "Любая, на которую можно сесть",
        "classes": (), "landable": True, "atmosphere": "any",
    },
    {
        "id": "bio_signals",
        "label": "С биосигналами",
        "classes": (), "landable": None, "atmosphere": "any", "min_signals": 1,
    },
    {
        "id": "bio_landable",
        "label": "С биосигналами и посадкой",
        "classes": (), "landable": True, "atmosphere": "any", "min_signals": 1,
    },
)

#: Быстрый доступ к пресету по id.
PLANET_PRESETS_BY_ID: Dict[str, Dict[str, Any]] = {
    str(row.get("id")): row for row in PLANET_SEARCH_PRESETS
}


def _preset_classes(criteria: dict) -> set:
    """Множество `PlanetClass` из критериев (пусто — подходит любой тип)."""
    result = set()
    for group in criteria.get("classes") or ():
        result.update(PLANET_CLASS_GROUPS.get(str(group), ()))
    # Допускаем и прямые названия классов из журнала, не только группы.
    for group in criteria.get("classes") or ():
        text = str(group)
        if text not in PLANET_CLASS_GROUPS:
            result.add(text)
    return result


def body_matches(body: dict, criteria: dict) -> bool:
    """Подходит ли тело под один набор критериев поиска."""
    if not isinstance(body, dict) or not isinstance(criteria, dict):
        return False

    wanted = _preset_classes(criteria)
    if wanted and str(body.get("planet_class") or "") not in wanted:
        return False

    landable = criteria.get("landable")
    if landable is not None and bool(body.get("landable")) != bool(landable):
        return False

    mode = str(criteria.get("atmosphere") or "any").lower()
    if mode != "any":
        category = atmosphere_category(body)
        if mode == "present":
            # «С атмосферой» — тонкая или плотная. unknown не годится, если нет данных
            if category == "none":
                return False
            if category in ("thin", "thick"):
                pass
            elif not (body.get("atmosphere") or body.get("atmosphere_type")
                      or body.get("atmosphere_elements")
                      or float(body.get("surface_pressure") or 0.0) > 0):
                return False
        elif mode == "thin":
            if category != "thin":
                return False
        elif mode == "none":
            if category != "none":
                return False
        elif mode == "thick":
            if category != "thick":
                return False
        elif category != mode:
            return False

    volcanism = criteria.get("volcanism")
    if volcanism is not None:
        has = bool(str(body.get("volcanism") or "").strip().lower()
                   not in ("", "no volcanism", "none"))
        if has != bool(volcanism):
            return False

    min_signals = int(criteria.get("min_signals") or 0)
    if min_signals and int(body.get("bio_signals") or 0) < min_signals:
        return False

    return True


def search_planets(bodies, criteria_list, limit: int = 6) -> List[Dict[str, Any]]:
    """Найти в списке тел те, что подходят хотя бы под один набор критериев.

    Возвращает строки для оверлея: имя, тип, признаки и какие именно наборы
    совпали (игроку важно понимать, почему планета попала в список).
    """
    active = [row for row in (criteria_list or []) if isinstance(row, dict)]
    if not active:
        return []
    rows: List[Dict[str, Any]] = []
    for body in bodies or []:
        if not isinstance(body, dict):
            continue
        matched = [str(rule.get("label") or rule.get("id") or "")
                   for rule in active if body_matches(body, rule)]
        if not matched:
            continue
        rows.append({
            "body": str(body.get("name") or ""),
            "planet_class": str(body.get("planet_class") or ""),
            "landable": bool(body.get("landable")),
            "atmosphere_category": atmosphere_category(body),
            "atmosphere": str(body.get("atmosphere") or body.get("atmosphere_type") or ""),
            "volcanism": str(body.get("volcanism") or ""),
            "bio_signals": int(body.get("bio_signals") or 0),
            "mapped": bool(body.get("mapped")),
            "distance_ls": _as_float(body.get("distance_ls"), 0.0),
            "matched": matched,
        })
    # Сначала тела с биосигналами, затем близкие: туда полетят в первую очередь.
    rows.sort(key=lambda row: (not row["bio_signals"],
                               row["distance_ls"] if row["distance_ls"] > 0 else 1e9,
                               row["body"]))
    return rows[:max(1, int(limit))]


def filter_predictions(rows, allowed) -> List[Dict[str, Any]]:
    """Оставить в предсказаниях только выбранные роды.

    `allowed` пусто или None — фильтр выключен, показываем всё.
    """
    if not allowed:
        return list(rows or [])
    wanted = {str(item).strip() for item in allowed if str(item).strip()}
    if not wanted:
        return list(rows or [])
    return [row for row in (rows or []) if str(row.get("genus") or "") in wanted]


# ============================================================
#  Правила предсказания: роды и виды
# ============================================================
# Своя модель, собранная по публичным условиям залегания организмов (страницы
# родов в Elite Dangerous Wiki и сводная таблица «Conditions of occurrence of
# species»). Код SrvSurvey и его таблицы сюда не переносились — здесь только
# факты игры, записанные своим форматом.
#
# Поля правила рода:
#   atmos    — подходящие категории атмосферы (none / thin / thick);
#   gases    — газы (подстрока AtmosphereType / AtmosphereComposition);
#   classes  — допустимые PlanetClass;
#   geology  — "require" (нужна активность/гейзеры) | "bonus" | None;
#   max_g    — предел гравитации в g (или None);
#   temp     — (min, max) средней температуры поверхности, K;
#   species  — виды: (название, {уточняющие условия}).
#
# Жёстко отсекается то, чего не бывает: атмосфера не того типа, другой газ,
# чужой класс тела, требуемая геология при известном «нет». Числовые пределы
# (гравитация, температура вида) — мягкие: они снижают процент, но не убивают
# род совсем, потому что скан бывает неполным.
GENUS_RULES: Dict[str, Dict[str, Any]] = {
    "Bacterium": {
        "atmos": ("none", "thin", "thick"), "geology": "bonus",
        "note": "самый всеядный род: вид зависит от газа и геологии",
        "species": (
            ("Bacterium aurasus", {"gases": ("carbon dioxide", "water")}),
            ("Bacterium alcyoneum", {"gases": ("ammonia",)}),
            ("Bacterium cerbrus", {"gases": ("sulphur dioxide", "water")}),
            ("Bacterium informem", {"gases": ("nitrogen",)}),
            ("Bacterium vesicula", {"gases": ("argon",)}),
            ("Bacterium bullaris", {"gases": ("methane",)}),
            ("Bacterium nebulus", {"gases": ("helium",)}),
            ("Bacterium acies", {"gases": ("neon",)}),
            ("Bacterium volu", {"gases": ("oxygen",)}),
            ("Bacterium tela", {"geology": True}),
        ),
    },
    "Aleoida": {
        "atmos": ("thin",), "gases": ("ammonia", "carbon dioxide"),
        "classes": ("Rocky body", "High metal content body"), "max_g": 0.27,
        "species": (
            ("Aleoida laminiae", {"gases": ("ammonia",)}),
            ("Aleoida spica", {"gases": ("ammonia",)}),
            ("Aleoida arcus", {"gases": ("carbon dioxide",), "temp": (175, 180)}),
            ("Aleoida coronamus", {"gases": ("carbon dioxide",), "temp": (180, 190)}),
            ("Aleoida gravis", {"gases": ("carbon dioxide",), "temp": (190, 195)}),
        ),
    },
    "Amphora Plant": {
        "atmos": ("none",),
        "note": "нужна звезда типа A и тело с водой в системе (ELW, аммиачный или водный гигант)",
        "species": (("Amphora Plant", {}),),
    },
    "Anemone": {
        "atmos": ("none", "thin"), "geology": "require",
        "note": "обычно тела без атмосферы; рядом должны быть гейзеры",
        "species": tuple((f"Anemone {name}", {}) for name in
                         ("Imperator", "Puniceum", "Croceum", "Luteolum",
                          "Prasinum", "Rubeum", "Roseum", "Blatteum")),
    },
    "Bark Mounds": {
        "atmos": ("none",),
        "note": "внутри туманности (≈150 св. лет от её центра)",
        "species": (("Bark Mounds", {}),),
    },
    "Brain Trees": {
        "atmos": ("none",), "geology": "require",
        "note": "только тела с вулканизмом/активностью",
        "species": tuple((f"Brain Trees {name}", {}) for name in
                         ("Gloriosum", "Praestans", "Alveus", "Bos",
                          "Cono", "Fragus", "Infestis", "Seditio")),
    },
    "Cactoida": {
        "atmos": ("thin",), "gases": ("ammonia", "carbon dioxide", "water"),
        "classes": ("Rocky body", "High metal content body"), "max_g": 0.27,
        "species": (
            ("Cactoida lapis", {"gases": ("ammonia",)}),
            ("Cactoida peperatis", {"gases": ("ammonia",)}),
            ("Cactoida cortexum", {"gases": ("carbon dioxide",), "temp": (180, 195)}),
            ("Cactoida pullulanta", {"gases": ("carbon dioxide",), "temp": (180, 195)}),
            ("Cactoida vermis", {"gases": ("water",)}),
        ),
    },
    "Clypeus": {
        "atmos": ("thin",), "gases": ("carbon dioxide", "water"),
        "classes": ("Rocky body", "High metal content body"), "max_g": 0.27,
        "temp": (190, 1000), "note": "только горячие тела: выше ~190 K",
        "species": (
            ("Clypeus lacrimam", {"temp": (190, 1000)}),
            ("Clypeus margaritus", {"temp": (190, 1000)}),
            ("Clypeus speculumi", {"temp": (190, 1000), "min_distance_ls": 2500}),
        ),
    },
    "Conchas": {
        "atmos": ("thin",), "gases": ("ammonia", "nitrogen", "water", "carbon dioxide"),
        "max_g": 0.27,
        "species": (
            ("Concha aureolas", {"gases": ("ammonia",)}),
            ("Concha biconcavis", {"gases": ("nitrogen",)}),
            ("Concha labiata", {"gases": ("carbon dioxide",), "temp": (0, 190)}),
            ("Concha renibus", {"gases": ("carbon dioxide", "water"), "temp": (180, 195)}),
        ),
    },
    "Crystalline Shards": {
        "atmos": ("none",), "min_distance_ls": 12000,
        "note": "не ближе 12 000 св. с от звезды; в системе нужна вода (ELW/гигант)",
        "species": (("Crystalline Shards", {}),),
    },
    "Electricae": {
        "atmos": ("thin",), "gases": ("helium", "neon", "argon"),
        "classes": ("Icy body", "Rocky ice body"), "max_g": 0.27, "geology": "bonus",
        "species": (
            ("Electricae vagos", {}),
            ("Electricae peritos", {}),
            ("Electricae leyi", {"gases": ("neon", "argon")}),
            ("Electricae onkylii", {"gases": ("argon",)}),
        ),
    },
    "Fonticulua": {
        "atmos": ("thin",), "gases": ("argon", "neon", "nitrogen", "oxygen", "methane"),
        "classes": ("Icy body", "Rocky ice body"), "max_g": 0.27,
        "species": (
            ("Fonticulua campestris", {"gases": ("argon",)}),
            ("Fonticulua upupam", {"gases": ("argon",)}),
            ("Fonticulua digitos", {"gases": ("methane",)}),
            ("Fonticulua lapida", {"gases": ("nitrogen",)}),
            ("Fonticulua fluctus", {"gases": ("oxygen",)}),
            ("Fonticulua segmentatus", {"gases": ("neon",)}),
        ),
    },
    "Frutexa": {
        "atmos": ("thin",), "gases": ("ammonia", "carbon dioxide", "water", "sulphur dioxide"),
        "classes": ("Rocky body", "High metal content body"),
        "species": (
            ("Frutexa flabellum", {"gases": ("ammonia",)}),
            ("Frutexa flammasis", {"gases": ("ammonia",)}),
            ("Frutexa metallicum", {"gases": ("ammonia", "carbon dioxide"),
                                     "classes": ("High metal content body",)}),
            ("Frutexa acus", {"gases": ("carbon dioxide",)}),
            ("Frutexa fera", {"gases": ("carbon dioxide",)}),
            ("Frutexa sponsae", {"gases": ("water",)}),
            ("Frutexa collum", {"gases": ("sulphur dioxide",)}),
        ),
    },
    "Fumerola": {
        "atmos": ("none", "thin", "thick"), "geology": "require",
        "note": "вид повторяет тип вулканизма тела",
        "species": (
            ("Fumerola aquatis", {"volcanism": ("water",)}),
            ("Fumerola carbosis", {"volcanism": ("carbon", "methane", "dioxide")}),
            ("Fumerola extremus", {"volcanism": ("silicate", "iron", "rocky", "magma")}),
            ("Fumerola nitris", {"volcanism": ("nitrogen", "ammonia")}),
        ),
    },
    "Fungoida": {
        "atmos": ("thin",), "gases": ("argon", "methane", "carbon dioxide", "water", "ammonia"),
        "classes": ("Rocky body", "High metal content body"),
        "species": (
            ("Fungoida bullarum", {"gases": ("argon",)}),
            ("Fungoida setisis", {"gases": ("methane", "ammonia")}),
            ("Fungoida gelata", {"gases": ("carbon dioxide", "water"), "temp": (180, 195)}),
            ("Fungoida stabitis", {"gases": ("carbon dioxide", "water"), "temp": (180, 195)}),
        ),
    },
    "Osseus": {
        "atmos": ("thin",), "gases": ("argon", "methane", "carbon dioxide", "water", "ammonia"),
        "classes": ("Rocky body", "High metal content body"),
        "species": (
            ("Osseus pumice", {"gases": ("argon", "methane")}),
            ("Osseus spiralis", {"gases": ("ammonia",)}),
            ("Osseus cornibus", {"gases": ("carbon dioxide",), "temp": (180, 195)}),
            ("Osseus fractus", {"gases": ("carbon dioxide",), "temp": (180, 195)}),
            ("Osseus pellebantus", {"gases": ("carbon dioxide",), "temp": (190, 195)}),
            ("Osseus discus", {"gases": ("water",)}),
        ),
    },
    "Recepta": {
        "atmos": ("thin",), "gases": ("sulphur dioxide",), "max_g": 0.27,
        "species": (
            ("Recepta umbrux", {}),
            ("Recepta deltahedronix", {"classes": ("Rocky body", "High metal content body",
                                                    "Icy body", "Rocky ice body")}),
            ("Recepta conditivus", {"classes": ("Icy body", "Rocky ice body")}),
        ),
    },
    "Sinuous Tubers": {
        "atmos": ("none",), "geology": "require",
        "note": "без атмосферы и обязательно с вулканизмом; чаще в ядре Галактики",
        "species": (
            ("Sinuous Tuber albidum", {"classes": ("Rocky body",)}),
            ("Sinuous Tuber caeruleum", {"classes": ("Rocky body",)}),
            ("Sinuous Tuber lindigoticum", {"classes": ("Rocky body",)}),
            ("Sinuous Tuber blatteum", {"classes": ("Metal rich body", "High metal content body")}),
            ("Sinuous Tuber prasinum", {"classes": ("Metal rich body", "High metal content body")}),
            ("Sinuous Tuber violaceum", {"classes": ("Metal rich body", "High metal content body")}),
            ("Sinuous Tuber viride", {"classes": ("Metal rich body", "High metal content body")}),
            ("Sinuous Tuber roseus", {"volcanism": ("silicate", "magma", "iron")}),
        ),
    },
    "Stratum": {
        "atmos": ("thin",), "gases": ("ammonia", "carbon dioxide", "sulphur dioxide", "water", "oxygen"),
        "classes": ("Rocky body", "High metal content body"), "max_g": 0.62,
        "temp": (57, 450),
        "species": (
            ("Stratum laminamus", {"gases": ("ammonia",), "temp": (57, 177)}),
            ("Stratum paleas", {"gases": ("ammonia", "carbon dioxide", "water"), "temp": (158, 450)}),
            ("Stratum excutitus", {"gases": ("carbon dioxide", "sulphur dioxide"), "temp": (165, 190)}),
            ("Stratum limaxus", {"gases": ("carbon dioxide", "sulphur dioxide"), "temp": (165, 190)}),
            ("Stratum frigus", {"gases": ("carbon dioxide", "sulphur dioxide"), "temp": (191, 450)}),
            ("Stratum cucumisis", {"gases": ("carbon dioxide", "sulphur dioxide"), "temp": (190, 450)}),
            ("Stratum araneamus", {"gases": ("sulphur dioxide",), "temp": (165, 450)}),
            ("Stratum tectonicas", {"classes": ("High metal content body",), "temp": (61, 450)}),
        ),
    },
    "Tubus": {
        "atmos": ("thin",), "gases": ("carbon dioxide", "ammonia"),
        "classes": ("Rocky body", "High metal content body"), "max_g": 0.15,
        "temp": (160, 195), "note": "только очень лёгкие тела: гравитация ниже 0.15 g",
        "species": (
            ("Tubus rosarium", {"gases": ("ammonia",)}),
            ("Tubus sororibus", {"gases": ("ammonia", "carbon dioxide")}),
            ("Tubus cavas", {"gases": ("carbon dioxide",), "temp": (160, 190)}),
            ("Tubus compagibus", {"gases": ("carbon dioxide",), "temp": (160, 190)}),
            ("Tubus conifer", {"gases": ("carbon dioxide",), "temp": (160, 190)}),
        ),
    },
    "Tussock": {
        "atmos": ("thin",),
        "gases": ("argon", "methane", "carbon dioxide", "ammonia", "water", "sulphur dioxide"),
        "classes": ("Rocky body", "High metal content body"),
        "species": (
            ("Tussock capillum", {"gases": ("argon", "methane"), "classes": ("Rocky body",)}),
            ("Tussock catena", {"gases": ("ammonia",)}),
            ("Tussock cultro", {"gases": ("ammonia",)}),
            ("Tussock divisa", {"gases": ("ammonia",)}),
            ("Tussock pennata", {"gases": ("carbon dioxide",), "temp": (145, 155)}),
            ("Tussock ventusa", {"gases": ("carbon dioxide",), "temp": (155, 160)}),
            ("Tussock ignis", {"gases": ("carbon dioxide",), "temp": (160, 170)}),
            ("Tussock serrati", {"gases": ("carbon dioxide",), "temp": (170, 175)}),
            ("Tussock albata", {"gases": ("carbon dioxide",), "temp": (175, 180)}),
            ("Tussock caputus", {"gases": ("carbon dioxide",), "temp": (180, 190)}),
            ("Tussock triticum", {"gases": ("carbon dioxide",), "temp": (190, 195)}),
            ("Tussock propagito", {"gases": ("carbon dioxide",)}),
            ("Tussock pennatis", {"gases": ("carbon dioxide",)}),
            ("Tussock virgam", {"gases": ("water",)}),
            ("Tussock stigmasis", {"gases": ("sulphur dioxide",)}),
        ),
    },
}

#: Разговорные/старые названия родов → канонические (журнал и кэш могли
#: хранить и те и другие).
GENUS_ALIASES: Dict[str, str] = {
    "shards": "Crystalline Shards",
    "crystalline shard": "Crystalline Shards",
    "tubers": "Sinuous Tubers",
    "sinuous tuber": "Sinuous Tubers",
    "concha": "Conchas",
    "brain tree": "Brain Trees",
    "bark mound": "Bark Mounds",
    "amphora": "Amphora Plant",
    "anemones": "Anemone",
}


def normalize_genus(name: object) -> str:
    """Привести название рода к каноническому."""
    text = str(name or "").strip()
    if not text or text in GENUS_RULES:
        return text
    alias = GENUS_ALIASES.get(text.lower())
    if alias:
        return alias
    words = text.split()
    if not words:
        return text
    return GENUS_ALIASES.get(words[0].lower(), text)


# Веса совпадений (сумма даёт «уверенность» предсказания).
WEIGHT_ATMOSPHERE = 3.0
WEIGHT_GEOLOGY = 2.0
WEIGHT_GAS = 2.0
WEIGHT_CLASS = 1.5
WEIGHT_TEMP = 1.0
WEIGHT_GRAVITY = 1.0
WEIGHT_MATERIAL = 1.0

#: Ниже этого порога род в оверлей не попадает: лучше пусто, чем мусор.
MIN_PREDICTION_PERCENT = 25


#: Атмосферы в журнале пишут то «sulfur», то «sulphur», то «SulfurDioxide», то
#: «$Atmosphere_SulfurDioxide_Name;» — любое сравнение по подстроке на этом
#: ломается, поэтому газы приводятся к набору токенов.
_GAS_SYNONYMS: Dict[str, str] = {
    "sulphur": "sulfur",
    "co2": "carbon",
    "h2o": "water",
    "ch4": "methane",
    "n2": "nitrogen",
    "o2": "oxygen",
}
_GAS_NOISE = re.compile(
    r"\b(thin|thick|hot|dense|opaque|global|surface|atmosphere|rich|rich\d*|"
    r"none|no|atmospheric|name|gas|\$?[a-z]+atom[a-z]*)\b")


def _gas_tokens(text: object) -> set:
    """Набор токенов газа из произвольной строки журнала."""
    raw = str(text or "")
    # «SulfurDioxide» → «sulfur dioxide»
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", raw)
    lowered = spaced.lower()
    lowered = re.sub(r"\$|_name;?|;", " ", lowered)
    cleaned = _GAS_NOISE.sub(" ", lowered)
    cleaned = re.sub(r"[^a-z0-9 ]+", " ", cleaned)
    words = [word for word in cleaned.split() if len(word) > 1]
    tokens = set()
    for index, word in enumerate(words):
        token = _GAS_SYNONYMS.get(word, word)
        tokens.add(token)
        if index + 1 < len(words):
            following = _GAS_SYNONYMS.get(words[index + 1], words[index + 1])
            tokens.add(f"{token} {following}")
    return tokens


def _gas_set(body: dict) -> set:
    """Все газы тела: из подписи атмосферы, AtmosphereType и состава."""
    tokens: set = set()
    tokens |= _gas_tokens(body.get("atmosphere"))
    tokens |= _gas_tokens(body.get("atmosphere_type"))
    for element in body.get("atmosphere_elements") or []:
        tokens |= _gas_tokens(element)
    for entry in body.get("atmosphere_composition") or []:
        if isinstance(entry, dict):
            tokens |= _gas_tokens(entry.get("Name") or entry.get("name"))
        else:
            tokens |= _gas_tokens(entry)
    return tokens


def _has_any_gas(tokens: set, needles: Sequence[str]) -> bool:
    if not tokens:
        return False
    for needle in needles:
        needle_tokens = _gas_tokens(needle)
        if needle_tokens & tokens:
            return True
    return False


def _volcanism_text(body: dict) -> str:
    text = str(body.get("volcanism") or "").strip().lower()
    if text in ("", "no volcanism", "none", "нет"):
        return ""
    return text


def _temp_of(body: dict) -> float:
    return _as_float(body.get("surface_temperature") or body.get("temperature"), 0.0)


def _gravity_g(body: dict) -> float:
    """Гравитация в g: журнал отдаёт м/с²."""
    return _as_float(body.get("surface_gravity") or body.get("gravity"), 0.0) / 9.80665


def _conditions_miss(body: dict, conditions: dict) -> bool:
    """Противоречат ли данные тела условиям вида (жёсткая часть)."""
    tokens = _gas_set(body)
    gases = conditions.get("gases") or ()
    if gases and tokens and not _has_any_gas(tokens, gases):
        return True
    classes = conditions.get("classes") or ()
    planet_class = str(body.get("planet_class") or "")
    if classes and planet_class and planet_class not in classes:
        return True
    volcanic = conditions.get("volcanism") or ()
    volcanism = _volcanism_text(body)
    if volcanic and volcanism and not _has_any_gas(_gas_tokens(volcanism), volcanic):
        return True
    if conditions.get("geology") and not volcanism and body.get("volcanism") is not None:
        return True
    return False


def _species_soft_miss(body: dict, conditions: dict) -> bool:
    temperature = _temp_of(body)
    temp_range = conditions.get("temp")
    if temp_range and temperature > 0:
        low, high = temp_range
        if not (low <= temperature <= high):
            return True
    min_ls = conditions.get("min_distance_ls")
    distance = _as_float(body.get("distance_ls"), 0.0)
    if min_ls and distance > 0 and distance < min_ls:
        return True
    return False


def species_candidates(body: dict, genus: str, limit: int = 6) -> List[str]:
    """Виды рода, которые не противоречат данным тела."""
    rule = GENUS_RULES.get(genus) or {}
    species = rule.get("species") or ()
    if not species:
        return []
    matched: List[str] = []
    fallback: List[str] = []
    for name, conditions in species:
        if _conditions_miss(body, conditions):
            continue
        if _species_soft_miss(body, conditions):
            fallback.append(name)
        else:
            matched.append(name)
    return (matched or fallback)[:limit]


def score_genus(body: dict, genus: str) -> Optional[Tuple[float, float, List[str], List[str]]]:
    """Оценка рода для тела: `(score, max, notes, species)` или None.

    None — род противоречит данным (атмосфера/газ/класс/геология): показывать
    его нельзя. Иначе `score / max` даёт честный процент: в знаменатель
    попадают только те критерии, которые вообще проверяемы по этому телу.
    """
    rule = GENUS_RULES.get(genus)
    if not rule or not body:
        return None
    category = atmosphere_category(body)
    notes: List[str] = []
    score = 0.0
    maximum = 0.0

    allowed_atmos = rule.get("atmos") or ()
    if allowed_atmos:
        if category == "unknown":
            # Принцип модели без изменений: без данных об атмосфере не гадаем —
            # «возможные роды» из одного только класса тела это шум.
            return None
        maximum += WEIGHT_ATMOSPHERE
        if category in allowed_atmos:
            score += WEIGHT_ATMOSPHERE
            notes.append(f"атмосфера: {category}")
        else:
            return None

    gas_tokens = _gas_set(body)
    gases = rule.get("gases") or ()
    if gases:
        if gas_tokens:
            maximum += WEIGHT_GAS
            if _has_any_gas(gas_tokens, gases):
                score += WEIGHT_GAS
                matched_gas = next((gas for gas in gases
                                    if _gas_tokens(gas) & gas_tokens), gases[0])
                notes.append(f"газ: {matched_gas}")
            else:
                return None
        else:
            notes.append("состав атмосферы неизвестен")

    classes = rule.get("classes") or ()
    planet_class = str(body.get("planet_class") or "")
    if classes:
        if planet_class:
            maximum += WEIGHT_CLASS
            if planet_class in classes:
                score += WEIGHT_CLASS
            else:
                return None
        else:
            notes.append("класс тела неизвестен")

    if rule.get("geology"):
        maximum += WEIGHT_GEOLOGY
        volcanism = _volcanism_text(body)
        if volcanism:
            score += WEIGHT_GEOLOGY
            notes.append("геология есть")
        elif rule["geology"] == "require":
            return None

    max_g = rule.get("max_g")
    gravity = _gravity_g(body)
    if max_g is not None:
        maximum += WEIGHT_GRAVITY
        if gravity <= 0:
            notes.append("гравитация неизвестна")
        elif gravity <= max_g:
            score += WEIGHT_GRAVITY
        else:
            notes.append(f"гравитация {gravity:.2f} g выше предела {max_g} g")

    temp_range = rule.get("temp")
    temperature = _temp_of(body)
    if temp_range:
        maximum += WEIGHT_TEMP
        if temperature > 0:
            low, high = temp_range
            if low <= temperature <= high:
                score += WEIGHT_TEMP
            else:
                notes.append(f"температура {temperature:.0f} K вне {low}–{high} K")

    material = rule.get("materials")
    if material:
        maximum += WEIGHT_MATERIAL
        if material in {str(item).lower() for item in (body.get("materials") or [])}:
            score += WEIGHT_MATERIAL
            notes.append(f"материал: {material}")

    if rule.get("note"):
        notes.append(str(rule["note"]))
    species = species_candidates(body, genus)
    return score, maximum, notes, species


def predict_genera(body: dict, limit: Optional[int] = None) -> List[Tuple[str, float, List[str]]]:
    """Предсказать вероятные роды для тела.

    Возвращает `(род, оценка, пояснения)`; оценка абсолютная — сумма весов
    совпавших правил. Роды, противоречащие данным тела, не возвращаются вовсе.
    На телах без посадки био-прогноз отключен.
    """
    if not body or not is_landable(body):
        return []
    results: List[Tuple[str, float, List[str]]] = []
    for genus in GENUS_RULES:
        scored = score_genus(body, genus)
        if scored is None:
            continue
        score, _maximum, notes, _species = scored
        if score <= 0:
            continue
        results.append((genus, score, notes))
    results.sort(key=lambda row: (-row[1], row[0]))
    return results[:limit] if limit else results


def prediction_rows(body: dict, limit: Optional[int] = None,
                    first_discovery: Optional[bool] = None) -> List[Dict[str, Any]]:
    """То же, что `predict_genera`, но с процентом, видом и оценкой выплаты.

    Процент считается от максимума, достижимого именно для этого рода при
    данных конкретного тела, — «6» у Osseus и «3» у Bacterium иначе не
    сравнимы. Всё, что ниже `MIN_PREDICTION_PERCENT`, игроку не показывается.
    На телах без посадки био-прогноз отключен.
    """
    if not body or not is_landable(body):
        return []

    if first_discovery is None:
        first_discovery = bool(body.get("no_first_footfall"))
        if not first_discovery and body.get("was_discovered") is False:
            first_discovery = True
        ff_by = str(body.get("first_footfall_by") or "").strip()
        if ff_by and ff_by not in ("Вы", "You"):
            first_discovery = False

    rows: List[Dict[str, Any]] = []
    confirmed = {normalize_genus(item) for item in (body.get("confirmed_genera") or [])}
    for genus in GENUS_RULES:
        scored = score_genus(body, genus)
        if scored is None:
            continue
        score, maximum, notes, species = scored
        percent = int(round(100 * score / maximum)) if maximum else 0
        if genus in confirmed:
            percent = 100
            notes = list(notes) + ["подтверждено DSS"]
        percent = max(0, min(100, percent))
        if percent < MIN_PREDICTION_PERCENT and genus not in confirmed:
            continue
        cand_species = list(species or [])
        row_val = 0
        if cand_species:
            vals = [estimate_value(s, mapped=bool(body.get("mapped")),
                                   first_discovery=first_discovery)
                    for s in cand_species if estimate_value(s)]
            if vals:
                row_val = max(vals)
        if not row_val:
            row_val = estimate_value(genus, mapped=bool(body.get("mapped")),
                                     first_discovery=first_discovery)
        rows.append({
            "genus": genus,
            "score": score,
            "percent": percent,
            "notes": notes,
            "species": cand_species,
            "value_cr": row_val,
            "confirmed": genus in confirmed,
            "first_footfall_bonus": bool(first_discovery),
        })

    seen = {row["genus"] for row in rows}
    for genus in confirmed:
        if genus in seen or genus not in GENUS_RULES:
            continue
        cand_species = species_candidates(body, genus)
        row_val = 0
        if cand_species:
            vals = [estimate_value(s, mapped=bool(body.get("mapped")),
                                   first_discovery=first_discovery)
                    for s in cand_species if estimate_value(s)]
            if vals:
                row_val = max(vals)
        if not row_val:
            row_val = estimate_value(genus, mapped=bool(body.get("mapped")),
                                     first_discovery=first_discovery)
        rows.append({
            "genus": genus,
            "score": WEIGHT_ATMOSPHERE + WEIGHT_GAS,
            "percent": 100,
            "notes": ["подтверждено DSS"],
            "species": cand_species,
            "value_cr": row_val,
            "confirmed": True,
            "first_footfall_bonus": bool(first_discovery),
        })

    rows.sort(key=lambda row: (not row["confirmed"], -row["percent"], -row["value_cr"], row["genus"]))
    return rows[:limit] if limit else rows


# ============================================================
#  Отслеживание по журналу
# ============================================================
class ExobiologyTracker:
    """Собирает состояние экзобиологии из событий журнала.

    Используется как хук `parse_events()`, поэтому не должен бросать
    исключения и должен быть дешёвым: обрабатываются только нужные события.
    """

    def __init__(self):
        self.current_system: str = ""
        self.current_body: str = ""
        # system|body -> свойства тела
        self.bodies: Dict[str, dict] = {}
        # system|body -> {species: {"stage": str, "samples": int, "first": str}}
        self.organics: Dict[str, Dict[str, dict]] = {}
        # system -> int (число тел в системе из FSSDiscoveryScan / NavBeaconScan)
        self.known_body_counts: Dict[str, int] = {}
        # Роды/виды, найденные когда-либо (для подсветки «уже встречалось»)
        self.seen_species: Dict[str, int] = {}
        # Подписи уже учтённых «счётных» событий (ScanOrganic/CodexEntry):
        self._recent_sigs: Dict[tuple, None] = {}

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _key(system: str, body: str) -> str:
        return f"{system}|{body}"

    def _body_key(self, event: dict, body_name: str = "") -> str:
        system = str(event.get("StarSystem") or self.current_system or "").strip()
        body = body_name or str(event.get("Body") or event.get("BodyName") or self.current_body or "").strip()
        return self._key(system, body)

    def _ensure_body(self, key: str, system: str, body_name: str) -> dict:
        body = self.bodies.get(key)
        if body is None:
            body = {
                "system": system,
                "name": body_name,
                "planet_class": "",
                "atmosphere": "",
                "atmosphere_type": "",
                "atmosphere_elements": [],
                "surface_gravity": 0.0,
                "surface_temperature": 0.0,
                "volcanism": "",
                "materials": [],
                "mapped": False,
                "bio_signals": 0,
                "landable": False,
                "confirmed_genera": [],
            }
            self.bodies[key] = body
        return body

    def _event_system(self, event: dict) -> str:
        """Система события: своя, если указана, иначе текущая."""
        return str(event.get("StarSystem") or event.get("SystemName") or self.current_system or "").strip()

    @staticmethod
    def _event_time(event: dict) -> float:
        """Момент события в секундах epoch."""
        raw = str(event.get("timestamp") or "").strip()
        if raw:
            from datetime import datetime

            text = raw.replace("Z", "+00:00")
            try:
                return datetime.fromisoformat(text).timestamp()
            except ValueError:
                pass
        return time.time()

    # -- журнал ------------------------------------------------------------
    #: Сколько подписей событий держать в памяти (защита от роста).
    MAX_RECENT_SIGS = 8192

    def _seen_once(self, sig: tuple) -> bool:
        """True, если событие с такой подписью уже учтено (иначе запоминает)."""
        if sig in self._recent_sigs:
            return True
        self._recent_sigs[sig] = None
        while len(self._recent_sigs) > self.MAX_RECENT_SIGS:
            self._recent_sigs.pop(next(iter(self._recent_sigs)), None)
        return False

    def _trim(self):
        """Ограничить память: удаляем самые старые записи (dict сохраняет порядок)."""
        while len(self.bodies) > MAX_TRACKED_BODIES:
            self.bodies.pop(next(iter(self.bodies)), None)
        while len(self.organics) > MAX_TRACKED_BODIES:
            self.organics.pop(next(iter(self.organics)), None)

    def handle(self, event: dict) -> None:
        """Обработать одно событие журнала."""
        if not isinstance(event, dict):
            return
        try:
            name = event.get("event")
            if name in ("Location", "FSDJump", "Docked", "CarrierJump", "ApproachBody",
                        "LeaveBody", "Touchdown", "Liftoff", "SupercruiseExit", "Disembark"):
                system = str(event.get("StarSystem") or event.get("SystemName") or "").strip()
                if system:
                    if system != self.current_system:
                        self.current_system = system
                        self.current_body = ""

                if name in ("ApproachBody", "Touchdown", "Disembark"):
                    body = str(event.get("Body") or event.get("BodyName") or "").strip()
                    if body:
                        self.current_body = body
                    if event.get("FirstFootfall") is True and (body or self.current_body):
                        target_b = body or self.current_body
                        b_key = self._key(self.current_system, target_b)
                        if b_key in self.bodies:
                            self.bodies[b_key]["no_first_footfall"] = True
                            self.bodies[b_key]["first_footfall_by"] = "Вы"
                elif name == "LeaveBody":
                    self.current_body = ""
                elif name in ("Location", "SupercruiseExit"):
                    body = str(event.get("Body") or event.get("BodyName") or "").strip()
                    body_type = str(event.get("BodyType") or "").strip().lower()
                    if body and body_type != "star":
                        self.current_body = body
                return

            if name == "Scan":
                system = str(event.get("StarSystem") or self.current_system or "").strip()
                if system:
                    if system != self.current_system:
                        self.current_system = system
                        self.current_body = ""
                props = body_props(event, system)
                if props is None:
                    return
                key = self._key(props["system"], props["name"])
                existing = self.bodies.get(key, {})
                # Уже известные факты (карта поверхности, число биосигналов, подтверждённые роды, первопроходец)
                # не должны теряться при повторном скане тела.
                props["mapped"] = bool(existing.get("mapped", False)) or bool(props.get("mapped", False))
                props["bio_signals"] = max(int(existing.get("bio_signals") or 0), int(props.get("bio_signals") or 0))
                if existing.get("confirmed_genera"):
                    props["confirmed_genera"] = sorted(set(
                        existing.get("confirmed_genera", []) + props.get("confirmed_genera", [])))
                if "no_first_footfall" in existing and "no_first_footfall" not in props:
                    props["no_first_footfall"] = existing["no_first_footfall"]
                if existing.get("first_footfall_by") and not props.get("first_footfall_by"):
                    props["first_footfall_by"] = existing["first_footfall_by"]
                self.bodies[key] = props
                self.current_body = props["name"]
                self._trim()
                return

            if name == "SAAScanComplete":
                body_name = str(event.get("BodyName") or event.get("Body")
                                or self.current_body or "").strip()
                if not body_name:
                    return
                system = self._event_system(event)
                body = self._ensure_body(self._key(system, body_name), system, body_name)
                body["mapped"] = True
                self.current_body = body_name
                return

            if name == "SAASignalsFound":
                signals = event.get("Signals") or []
                count = 0
                if isinstance(signals, list):
                    for signal in signals:
                        if not isinstance(signal, dict):
                            continue
                        signal_type = str(signal.get("Type") or "").lower()
                        type_loc = str(signal.get("Type_Localised") or "").lower()
                        if (any(token.lower() in signal_type for token in BIO_SIGNAL_TOKENS)
                                or "biological" in signal_type
                                or "biological" in type_loc
                                or "биолог" in type_loc):
                            count += int(signal.get("Count") or 0)
                body_name = str(event.get("BodyName") or event.get("Body")
                                or self.current_body or "").strip()
                if not body_name:
                    return
                system = self._event_system(event)
                body = self._ensure_body(self._key(system, body_name), system, body_name)
                body["bio_signals"] = max(int(body.get("bio_signals") or 0), count)
                genuses = event.get("Genuses") or []
                if isinstance(genuses, list):
                    found_genuses = []
                    for g in genuses:
                        if isinstance(g, dict):
                            gname = g.get("Genus_Localised") or g.get("Genus")
                            if gname:
                                found_genuses.append(str(gname).strip())
                if found_genuses:
                    body["confirmed_genera"] = sorted(set(
                        body.get("confirmed_genera", []) + found_genuses))
                    body["genuses"] = list(body["confirmed_genera"])
                self.current_body = body_name
                return

            if name == "FSSBodySignals":
                signals = event.get("Signals") or []
                count = 0
                if isinstance(signals, list):
                    for signal in signals:
                        if not isinstance(signal, dict):
                            continue
                        signal_type = str(signal.get("Type") or "").lower()
                        type_loc = str(signal.get("Type_Localised") or "").lower()
                        if (any(token.lower() in signal_type for token in BIO_SIGNAL_TOKENS)
                                or "biological" in signal_type
                                or "biological" in type_loc
                                or "биолог" in type_loc):
                            count += int(signal.get("Count") or 0)
                body_name = str(event.get("BodyName") or event.get("Body")
                                or self.current_body or "").strip()
                if not body_name:
                    return
                system = self._event_system(event)
                body = self._ensure_body(self._key(system, body_name), system, body_name)
                body["bio_signals"] = max(int(body.get("bio_signals") or 0), count)
                return

            if name == "FSSDiscoveryScan":
                count = _as_int(event.get("BodyCount"), 0)
                system = self._event_system(event)
                if system and count:
                    self.known_body_counts[system] = count
                return

            if name == "NavBeaconScan":
                count = _as_int(event.get("NumBodies"), 0)
                system = self._event_system(event)
                if system and count:
                    self.known_body_counts[system] = count
                return

            if name == "ScanOrganic":
                body_name = str(event.get("Body") or event.get("BodyName")
                                or self.current_body or "").strip()
                system = self._event_system(event)
                key = self._body_key(event, body_name)
                species = (
                    event.get("Species_Localised")
                    or event.get("Species")
                    or event.get("Genus_Localised")
                    or event.get("Genus")
                    or ""
                )
                species = str(species).strip()
                if not species:
                    return
                stage = str(event.get("ScanType") or event.get("Type") or "").strip()
                ts = str(event.get("timestamp") or "").strip()
                if ts and self._seen_once(("organic", key, species, stage, ts)):
                    return
                entry = self.organics.setdefault(key, {}).setdefault(
                    species, {"stage": "", "samples": 0, "first": "", "body": body_name,
                              "system": system, "last_ts": 0.0}
                )
                if stage == "Sample":
                    entry["samples"] = int(entry.get("samples") or 0) + 1
                    entry["stage"] = "Sample"
                    entry["last_ts"] = self._event_time(event)
                elif stage:
                    entry["stage"] = stage
                    entry["last_ts"] = self._event_time(event)
                self.seen_species[species] = self.seen_species.get(species, 0) + 1
                return

            if name == "CodexEntry":
                if str(event.get("Category") or "").lower().startswith("$codex_categorytype_biology"):
                    species = str(event.get("Name_Localised") or event.get("Name") or "").strip()
                    if species:
                        ts = str(event.get("timestamp") or "").strip()
                        if not ts or not self._seen_once(
                                ("codex", species, str(event.get("Region") or ""), ts)):
                            self.seen_species[species] = self.seen_species.get(species, 0) + 1
        except Exception:
            return

    # -- выдача ------------------------------------------------------------
    def set_body_footfall(self, system: str, body_name: str,
                          no_first_footfall: bool = True,
                          first_footfall_by: str = "") -> None:
        """Обновить статус первопроходца для тела."""
        if not system or not body_name:
            return
        key = self._key(system, body_name)
        body = self.bodies.get(key)
        if body is not None:
            body["no_first_footfall"] = bool(no_first_footfall)
            if first_footfall_by:
                body["first_footfall_by"] = str(first_footfall_by).strip()
            elif no_first_footfall:
                body["first_footfall_by"] = ""

    def current_body_state(self, now: Optional[float] = None) -> Optional[dict]:
        """Состояние текущего тела (с предсказанием и прогрессом образцов)."""
        key = self._key(self.current_system, self.current_body)
        return self.body_state(key, now=now)

    def body_state(self, key: str, now: Optional[float] = None) -> Optional[dict]:
        body = self.bodies.get(key)
        if body is None:
            return None
        now = time.time() if now is None else float(now)
        mapped = bool(body.get("mapped"))
        landable = is_landable(body)
        organics = self.organics.get(key, {})

        no_first_footfall = bool(body.get("no_first_footfall"))
        if not no_first_footfall and body.get("was_discovered") is False:
            no_first_footfall = True
        first_footfall_by = str(body.get("first_footfall_by") or "").strip()
        if first_footfall_by and first_footfall_by not in ("Вы", "You"):
            no_first_footfall = False

        rows = []
        total_value = 0
        for species, data in sorted(organics.items()):
            samples = int(data.get("samples") or 0)
            complete = samples >= SAMPLES_FOR_FULL_CREDIT
            last_ts = float(data.get("last_ts") or 0.0)
            wait = 0.0
            if last_ts and not complete:
                wait = max(0.0, SAMPLE_COOLDOWN_SECONDS - (now - last_ts))
            value = estimate_value(species, mapped=mapped, first_discovery=no_first_footfall)
            if not value:
                value = estimate_value(self._genus_of(species), mapped=mapped, first_discovery=no_first_footfall)
            total_value += value
            rows.append({
                "species": species,
                "stage": data.get("stage", ""),
                "samples": samples,
                "samples_left": max(0, SAMPLES_FOR_FULL_CREDIT - samples),
                "complete": complete,
                "wait_seconds": int(round(wait)),
                "value_cr": value,
                "seen_before": int(self.seen_species.get(species, 0) or 0) > samples,
            })

        predictions = prediction_rows(body, first_discovery=no_first_footfall) if landable else []

        return {
            "system": body.get("system", ""),
            "body": body.get("name", ""),
            "planet_class": body.get("planet_class", ""),
            "landable": landable,
            "atmosphere": body.get("atmosphere") or body.get("atmosphere_type") or "нет",
            "atmosphere_category": atmosphere_category(body),
            "temperature": body.get("surface_temperature", 0.0),
            "gravity": body.get("surface_gravity", 0.0),
            "volcanism": body.get("volcanism") or "нет",
            "materials": body.get("materials", []),
            "mapped": mapped,
            "bio_signals": int(body.get("bio_signals") or 0),
            "confirmed_genera": list(body.get("confirmed_genera") or []),
            "no_first_footfall": no_first_footfall,
            "first_footfall_by": first_footfall_by,
            "first_footfall_bonus": 5.0 if no_first_footfall else 1.0,
            # Предсказания с процентом совпадения правил и оценкой в кр.
            "predictions": predictions,
            "organics": rows,
            "value_cr": total_value,
            "samples_done": sum(row["samples"] for row in rows),
            "samples_total": sum(SAMPLES_FOR_FULL_CREDIT for _ in rows),
        }

    @staticmethod
    def _genus_of(species: str) -> str:
        """Из названия вида — род (первое слово): «Tussock Poxtop» → «Tussock»."""
        text = str(species or "").strip()
        if not text:
            return ""
        head = text.split()[0]
        if head in GENUS_VALUE_CR:
            return head
        return text if text in GENUS_VALUE_CR else head

    def search_system_planets(self, criteria_list, limit: int = 6) -> List[dict]:
        """Тела текущей системы, подходящие под выбранные наборы критериев."""
        if not criteria_list:
            return []
        bodies = [body for key, body in self.bodies.items()
                  if key.startswith(f"{self.current_system}|")]
        return search_planets(bodies, criteria_list, limit=limit)

    def system_bodies(self, limit: int = 10) -> List[dict]:
        """Тела текущей системы, у которых есть биосигналы (важные сверху)."""
        rows = []
        for key, body in self.bodies.items():
            if not key.startswith(f"{self.current_system}|"):
                continue
            signals = int(body.get("bio_signals") or 0)
            rows.append({
                "body": str(body.get("name") or ""),
                "planet_class": str(body.get("planet_class") or ""),
                "bio_signals": signals,
                "mapped": bool(body.get("mapped")),
                "landable": bool(body.get("landable")),
                "has_organics": bool(self.organics.get(key)),
            })
        rows.sort(key=lambda row: (-row["bio_signals"], not row["mapped"], row["body"]))
        rows = [row for row in rows if row["bio_signals"] or row["has_organics"]]
        return rows[:limit]

    def system_body_count(self) -> int:
        """Сколько тел текущей системы знает журнал."""
        prefix = f"{self.current_system}|"
        return sum(1 for key in self.bodies if key.startswith(prefix))

    def system_scanned_count(self, system: str = "") -> int:
        """Сколько тел заданной системы реально отсканировано в журнале."""
        sys_name = system or self.current_system
        prefix = f"{sys_name}|"
        return sum(1 for key in self.bodies if key.startswith(prefix))

    def system_known_body_count(self, system: str = "") -> int:
        """Всего тел в системе (из FSSDiscoveryScan / NavBeaconScan)."""
        sys_name = system or self.current_system
        return int(self.known_body_counts.get(sys_name, 0) or 0)

    def system_bio_signals_total(self, system: str = "") -> int:
        """Суммарное число биосигналов во всей системе."""
        sys_name = system or self.current_system
        prefix = f"{sys_name}|"
        return sum(int(b.get("bio_signals") or 0) for k, b in self.bodies.items() if k.startswith(prefix))

    def system_bio_bodies_count(self, system: str = "") -> int:
        """Число тел в системе, где найдены биосигналы."""
        sys_name = system or self.current_system
        prefix = f"{sys_name}|"
        return sum(1 for k, b in self.bodies.items() if k.startswith(prefix) and int(b.get("bio_signals") or 0) > 0)

    def recent_bodies(self, limit: int = 8) -> List[dict]:
        """Последние отсканированные тела текущей системы (свежие сверху)."""
        keys = [key for key in self.bodies if key.startswith(f"{self.current_system}|")]
        result = []
        for key in reversed(keys[-limit:]):
            state = self.body_state(key)
            if state:
                result.append(state)
        return result

    # -- кэш ---------------------------------------------------------------
    def export_system_data(self, system: str) -> dict:
        """Собрать данные системы для сохранения в дисковый кэш."""
        sys_name = str(system or self.current_system or "").strip()
        if not sys_name:
            return {}
        prefix = f"{sys_name}|"
        bodies = {}
        for key, body in self.bodies.items():
            if key.startswith(prefix):
                bname = key[len(prefix):]
                bodies[bname] = dict(body)
        organics = {}
        for key, orgs in self.organics.items():
            if key.startswith(prefix):
                bname = key[len(prefix):]
                organics[bname] = dict(orgs)
        return {
            "bodies": bodies,
            "organics": organics,
            "known_body_count": int(self.known_body_counts.get(sys_name, 0) or 0),
        }

    def import_system_data(self, system: str, data: dict) -> int:
        """Импортировать данные системы из кэша. Возвращает число загруженных тел."""
        if not system or not isinstance(data, dict):
            return 0
        bodies = data.get("bodies") or {}
        count = 0
        prefix = f"{system}|"
        for bname, bprops in bodies.items():
            if not isinstance(bprops, dict):
                continue
            key = f"{prefix}{bname}"
            existing = self.bodies.get(key, {})
            merged = dict(bprops)
            merged["system"] = system
            merged["name"] = bname
            if existing:
                merged["mapped"] = bool(existing.get("mapped")) or bool(merged.get("mapped"))
                merged["bio_signals"] = max(int(existing.get("bio_signals") or 0), int(merged.get("bio_signals") or 0))
                if existing.get("confirmed_genera"):
                    merged["confirmed_genera"] = sorted(set(
                        existing.get("confirmed_genera", []) + merged.get("confirmed_genera", [])))
            self.bodies[key] = merged
            count += 1
        organics = data.get("organics") or {}
        for bname, orgs in organics.items():
            if isinstance(orgs, dict):
                key = f"{prefix}{bname}"
                self.organics.setdefault(key, {}).update(orgs)
        known = int(data.get("known_body_count") or 0)
        if known:
            self.known_body_counts[system] = max(int(self.known_body_counts.get(system, 0) or 0), known)
        return count

    def load_from_cache(self, cache) -> int:
        """Загрузить все системы из ExobiologyCache."""
        if not cache:
            return 0
        data = cache.load()
        count = 0
        for sys_name, sys_data in data.items():
            if isinstance(sys_data, dict):
                self.import_system_data(sys_name, sys_data)
                count += 1
        return count

    def save_to_cache(self, cache) -> int:
        """Сохранить все накопленные системы в ExobiologyCache."""
        if not cache:
            return 0
        systems = set()
        for key in self.bodies:
            if "|" in key:
                systems.add(key.split("|", 1)[0])
        if self.current_system:
            systems.add(self.current_system)
        count = 0
        for sys_name in systems:
            sys_data = self.export_system_data(sys_name)
            if sys_data.get("bodies") or sys_data.get("organics") or sys_data.get("known_body_count"):
                cache.store_system(sys_name, sys_data.get("bodies"), sys_data.get("organics"),
                                   sys_data.get("known_body_count", 0))
                count += 1
        cache.save()
        return count


# ============================================================
#  Дисковый кэш экзобиологии
# ============================================================
class ExobiologyCache:
    """Кэш данных экзобиологии на диске (~/.colonial_helper_exobio_cache.json).

    Хранит тела, сигналы и образцы посещённых систем за все игровые сессии, а также
    список проиндексированных файлов журналов.
    """

    def __init__(self, path: Optional[Path] = None, max_systems: int = 2000):
        self.path = Path(path) if path else None
        self.max_systems = max(10, int(max_systems))
        self._data: Dict[str, dict] = {}
        self._indexed_files: Dict[str, float] = {}  # filename -> mtime
        self._loaded = False

    def load(self) -> Dict[str, dict]:
        if self._loaded:
            return self._data
        if not self.path or not self.path.exists():
            self._loaded = True
            return self._data
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                content = json.load(f)
            if isinstance(content, dict):
                if "_meta" in content and isinstance(content["_meta"], dict):
                    self._indexed_files = dict(content["_meta"].get("indexed_files") or {})
                    self._data = {k: v for k, v in content.items() if k != "_meta" and isinstance(v, dict)}
                else:
                    self._data = {k: v for k, v in content.items() if k != "_meta" and isinstance(v, dict)}
        except Exception:
            self._data = {}
            self._indexed_files = {}
        self._loaded = True
        return self._data

    def save(self) -> bool:
        if not self.path:
            return False
        try:
            if len(self._data) > self.max_systems:
                items = sorted(
                    self._data.items(),
                    key=lambda item: float((item[1] if isinstance(item[1], dict) else {}).get("ts") or 0.0),
                    reverse=True
                )[:self.max_systems]
                self._data = dict(items)
            payload = dict(self._data)
            payload["_meta"] = {
                "version": 2,
                "indexed_files": self._indexed_files,
            }
            tmp_path = self.path.with_name(f"{self.path.name}.tmp.{os.getpid()}")
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=1)
            tmp_path.replace(self.path)
            return True
        except Exception:
            return False

    def is_file_indexed(self, filename: str, mtime: float) -> bool:
        self.load()
        prev = self._indexed_files.get(filename)
        return prev is not None and abs(prev - mtime) < 0.01

    def mark_files_indexed(self, files_mtimes: Dict[str, float]) -> None:
        self.load()
        self._indexed_files.update(files_mtimes)

    def get_system(self, system: str) -> Optional[dict]:
        self.load()
        sys_name = str(system or "").strip()
        if not sys_name or sys_name == "_meta":
            return None
        return self._data.get(sys_name)

    def all_systems(self) -> Dict[str, dict]:
        self.load()
        return {k: v for k, v in self._data.items() if k != "_meta"}

    def clear_system(self, system: str) -> bool:
        sys_name = str(system or "").strip()
        self.load()
        if sys_name in self._data:
            del self._data[sys_name]
            self.save()
            return True
        return False

    def store_system(self, system: str, bodies: dict = None, organics: dict = None,
                     known_body_count: int = 0) -> bool:
        sys_name = str(system or "").strip()
        if not sys_name or sys_name == "_meta":
            return False
        self.load()
        existing = self._data.get(sys_name, {})
        merged_bodies = dict(existing.get("bodies") or {})
        for bname, bdata in (bodies or {}).items():
            if isinstance(bdata, dict):
                if bname in merged_bodies:
                    prev = merged_bodies[bname]
                    bdata["mapped"] = bool(prev.get("mapped")) or bool(bdata.get("mapped"))
                    bdata["bio_signals"] = max(int(prev.get("bio_signals") or 0), int(bdata.get("bio_signals") or 0))
                    if prev.get("confirmed_genera"):
                        bdata["confirmed_genera"] = sorted(set(
                            prev.get("confirmed_genera", []) + bdata.get("confirmed_genera", [])))
                merged_bodies[bname] = bdata

        merged_organics = dict(existing.get("organics") or {})
        for bname, orgs in (organics or {}).items():
            if isinstance(orgs, dict):
                merged_organics.setdefault(bname, {}).update(orgs)

        self._data[sys_name] = {
            "ts": time.time(),
            "bodies": merged_bodies,
            "organics": merged_organics,
            "known_body_count": max(int(existing.get("known_body_count") or 0), int(known_body_count or 0)),
        }
        return self.save()


# ============================================================
#  Поиск сканов в истории журналов
# ============================================================
EXOBIO_JOURNAL_EVENTS = frozenset({
    "FSDJump", "Location", "CarrierJump",
    "Scan", "FSSBodySignals", "SAASignalsFound", "SAAScanComplete",
    "ScanOrganic", "CodexEntry", "FSSDiscoveryScan", "NavBeaconScan",
    "ApproachBody", "LeaveBody", "Touchdown", "Liftoff",
})


def scan_journals_for_system(journal_path, system_name: str, handle_func=None) -> List[dict]:
    """Быстрый поиск событий экзобиологии для заданной системы во ВСЕХ файлах журналов.

    Ищет данные за все сессии игры, не ограничиваясь последней сессией.
    """
    if not journal_path or not system_name:
        return []
    path = Path(journal_path)
    if not path.exists():
        return []
    sys_clean = str(system_name).strip()
    sys_lower = sys_clean.lower()
    system_bytes = f'"{sys_clean}"'.encode("utf-8")
    raw_system_bytes = sys_clean.encode("utf-8")
    sys_lower_bytes = sys_lower.encode("utf-8")
    try:
        files = sorted(path.glob("Journal.*.log"), key=lambda f: f.stat().st_mtime, reverse=True)
    except OSError:
        return []

    found_events: List[dict] = []
    for fpath in files:
        try:
            with open(fpath, "rb") as fh:
                content = fh.read()
            # Быстрая проверка наличия упоминания системы в файле
            if (system_bytes not in content and raw_system_bytes not in content
                    and sys_lower_bytes not in content.lower()):
                continue
            current_sys = None
            for line in content.splitlines():
                matched_ev = None
                for ev_name in EXOBIO_JOURNAL_EVENTS:
                    if f'"{ev_name}"'.encode("utf-8") in line:
                        matched_ev = ev_name
                        break
                if not matched_ev:
                    continue
                try:
                    ev = json.loads(line.decode("utf-8", errors="replace"))
                except Exception:
                    continue
                ev_name = ev.get("event")
                if ev_name in ("FSDJump", "Location", "CarrierJump"):
                    current_sys = str(ev.get("StarSystem") or "").strip()
                    if current_sys.lower() == sys_lower:
                        found_events.append(ev)
                    continue

                ev_sys = str(ev.get("StarSystem") or ev.get("SystemName") or "").strip()
                if not ev_sys and current_sys:
                    ev_sys = current_sys

                if (ev_sys.lower() == sys_lower or
                    (not ev_sys and (system_bytes in line or raw_system_bytes in line
                                     or sys_lower_bytes in line.lower()))):
                    if not ev.get("StarSystem"):
                        ev["StarSystem"] = sys_clean
                    found_events.append(ev)
        except Exception:
            continue

    found_events.sort(key=lambda ev: str(ev.get("timestamp") or ""))
    if handle_func:
        for ev in found_events:
            try:
                handle_func(ev)
            except Exception:
                pass
    return found_events


def scan_all_journals_for_exobio(journal_path, handle_func=None, on_progress=None, cache=None) -> int:
    """Полное сканирование всех журналов на события экзобиологии для наполнения кэша.

    Если передан cache, пропускает уже проиндексированные файлы журналов с неизменившимся mtime.
    """
    if not journal_path:
        return 0
    path = Path(journal_path)
    if not path.exists():
        return 0
    try:
        files = sorted(path.glob("Journal.*.log"), key=lambda f: f.stat().st_mtime)
    except OSError:
        return 0

    files_to_scan = []
    for f in files:
        try:
            mtime = f.stat().st_mtime
            if cache and cache.is_file_indexed(f.name, mtime):
                continue
            files_to_scan.append((f, mtime))
        except OSError:
            continue

    total = len(files_to_scan)
    count = 0
    indexed_batch: Dict[str, float] = {}
    for idx, (fpath, mtime) in enumerate(files_to_scan):
        if on_progress:
            try:
                on_progress(idx + 1, total)
            except Exception:
                pass
        try:
            with open(fpath, "rb") as fh:
                content = fh.read()
            if not any(f'"{ev}"'.encode("utf-8") in content for ev in EXOBIO_JOURNAL_EVENTS):
                indexed_batch[fpath.name] = mtime
                continue
            current_sys = None
            for line in content.splitlines():
                for ev_name in EXOBIO_JOURNAL_EVENTS:
                    if f'"{ev_name}"'.encode("utf-8") in line:
                        try:
                            ev = json.loads(line.decode("utf-8", errors="replace"))
                            name = ev.get("event")
                            if name in ("FSDJump", "Location", "CarrierJump"):
                                current_sys = str(ev.get("StarSystem") or "").strip()
                            elif current_sys and not ev.get("StarSystem"):
                                ev["StarSystem"] = current_sys
                            if handle_func:
                                handle_func(ev)
                            count += 1
                        except Exception:
                            pass
                        break
            indexed_batch[fpath.name] = mtime
        except Exception:
            continue

    if cache and indexed_batch:
        cache.mark_files_indexed(indexed_batch)
        cache.save()
    return count
