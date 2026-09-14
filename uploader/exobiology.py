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

Данные берутся **только из журнала самого игрока**: `Scan`,
`SAAScanComplete`, `FSSBodySignals`, `ScanOrganic`, `CodexEntry`. Никаких
EDSM/Spansh/Canonn — всё работает офлайн.
"""

import time
from typing import Any, Dict, List, Optional, Tuple

# В журнале тип биосигнала приходит в виде локализационного токена.
BIO_SIGNAL_TOKENS = ("$SAA_SignalType_Biological;", "SAA_SignalType_Biological")

# Тела, на которые можно сесть.
LANDABLE_PLANET_CLASSES = {
    "Metal rich body",
    "High metal content body",
    "Rocky body",
    "Rocky ice body",
    "Icy body",
    "Earthlike body",
    "Ammonia world",
    "Water world",
    "Water giant",
}

# Стадии взятия образца в журнале (ScanOrganic.ScanType).
SAMPLE_STAGES = ("Log", "Analyse", "Sample")
# Полный кредит за вид — 3 образца с разных точек.
SAMPLES_FOR_FULL_CREDIT = 3

# После каждого образца организм «закрывается», и следующий снимок удаётся
# сделать не сразу. Точного значения в документации нет — это эмпирическая
# пауза, которую называют игроки (~30 с). Оверлей показывает обратный отсчёт
# до неё как подсказку, а не как гарантию: считать можно и раньше.
SAMPLE_COOLDOWN_SECONDS = 30.0

# Множители выплаты за биологические образцы (известные правила игры):
# ×2 — если система/тело открыты впервые, ×3.60246 — если тело картографировано.
FIRST_DISCOVERY_BONUS = 2.0
MAPPED_BONUS = 3.60246

# Грубая оценка стоимости полного комплекта (3 образца) по роду, кр.
# Это **порядок величины**, а не прайс: реальная цена зависит от варианта
# (какой именно Tussock или Osseus), которого журнал до сдачи образца не
# сообщает. Таблица своя, округлённая; уточняется в одном месте.
GENUS_VALUE_CR: Dict[str, int] = {
    "Bacterium": 90_000,
    "Aleoida": 500_000,
    "Amphora Plant": 500_000,
    "Anemone": 400_000,
    "Bark Mounds": 550_000,
    "Brain Trees": 800_000,
    "Cactoida": 550_000,
    "Clypeus": 600_000,
    "Conchas": 600_000,
    "Electricae": 1_000_000,
    "Fonticulua": 400_000,
    "Frutexa": 400_000,
    "Fumerola": 800_000,
    "Fungoida": 550_000,
    "Osseus": 750_000,
    "Recepta": 650_000,
    "Shards": 600_000,
    "Stratum": 950_000,
    "Tubers": 550_000,
    "Tubus": 800_000,
    "Tussock": 100_000,
}

# Сколько тел держим в памяти. При первичной загрузке всей истории журналов
# тел могут быть тысячи, а оверлею нужны только недавние.
MAX_TRACKED_BODIES = 500


def _as_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def atmosphere_category(body: dict) -> str:
    """none / thin / thick / unknown — по данным события Scan."""
    atmosphere = str(body.get("atmosphere") or "").strip().lower()
    atmosphere_type = str(body.get("atmosphere_type") or "").strip().lower()
    combined = f"{atmosphere} {atmosphere_type}".strip()
    if not combined:
        return "unknown"
    if "no atmosphere" in combined or combined in ("none", ""):
        return "none"
    if "thin" in combined:
        return "thin"
    if "thick" in combined or "hot" in combined or "rich" in combined:
        return "thick"
    return "unknown"


def body_props(event: dict, system: str = "") -> Optional[dict]:
    """Собрать свойства тела из события `Scan` (None, если это не тело)."""
    planet_class = str(event.get("PlanetClass") or "").strip()
    if not planet_class:
        return None
    name = str(event.get("BodyName") or "").strip()
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
    }


def estimate_value(genus: str, mapped: bool = False,
                   first_discovery: bool = False) -> int:
    """Грубая оценка выплаты за полный комплект образцов рода, кр.

    Формула: базовая цена рода × 2 (первооткрытие) × 3.60246 (карта тела).
    Если род неизвестен таблице — 0, и оверлей цену не показывает вовсе:
    выдуманное число вреднее пустого места.
    """
    base = GENUS_VALUE_CR.get(str(genus or "").strip(), 0)
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
        "id": "icy_land",
        "label": "Ледяная с посадкой",
        "classes": ("icy",), "landable": True, "atmosphere": "any",
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
        "id": "high_metal_land",
        "label": "Высокое содержание металла, с посадкой",
        "classes": ("high_metal",), "landable": True, "atmosphere": "any",
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
            # «С атмосферой» — тонкая или плотная. unknown не годится: данных
            # нет, и утверждать, что атмосфера есть, нельзя.
            if category not in ("thin", "thick"):
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
    # Сначала близкие тела и те, где есть биосигналы: туда полетят в первую
    # очередь. Сортировка детерминирована, иначе список прыгал бы между тиками.
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


def prediction_rows(body: dict, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """То же, что `predict_genera`, но с процентом совпадения правил.

    Оценка в `predict_genera` абсолютная (сколько правил совпало), поэтому
    «6» у Osseus и «3» у Bacterium не сравнимы напрямую: у Osseus обязательна
    геология и максимум выше. Процент считается от максимума, достижимого
    именно для этого рода при данных тела, — его и показываем игроку.
    """
    rows: List[Dict[str, Any]] = []
    for genus, score, notes in predict_genera(body):
        rule = GENUS_RULES.get(genus, {})
        max_score = WEIGHT_ATMOSPHERE if rule.get("atmos") else 0.0
        if rule.get("geology"):
            max_score += WEIGHT_GEOLOGY
        if rule.get("temp"):
            max_score += WEIGHT_TEMP
        if rule.get("gravity"):
            max_score += WEIGHT_GRAVITY
        if rule.get("materials"):
            max_score += WEIGHT_MATERIAL
        percent = int(round(100 * score / max_score)) if max_score else 0
        rows.append({
            "genus": genus,
            "score": score,
            "percent": max(0, min(100, percent)),
            "notes": list(notes or []),
            "value_cr": estimate_value(genus, mapped=bool(body.get("mapped"))),
        })
    return rows[:limit] if limit else rows


# ============================================================
#  Правила предсказания (своя упрощённая модель, уровень — род)
# ============================================================
# Поля:
#   atmos     — какие категории атмосферы подходят (none/thin/thick/unknown)
#   geology   — "require" | "bonus" | None
#   temp      — (min, max) в K или None (нет достоверных данных)
#   gravity   — (min, max) в g или None
#   materials — обязательный материал (нижний регистр) или None
GENUS_RULES: Dict[str, Dict[str, Any]] = {
    "Bacterium":      {"atmos": ("none", "thin", "thick"), "geology": "bonus"},
    "Aleoida":        {"atmos": ("thin",)},
    "Amphora Plant":  {"atmos": ("none",)},
    "Anemone":        {"atmos": ("thin",)},
    "Bark Mounds":    {"atmos": ("none",)},
    "Brain Trees":    {"atmos": ("thin",)},
    "Cactoida":       {"atmos": ("thin",)},
    "Clypeus":        {"atmos": ("thin",)},
    "Conchas":        {"atmos": ("none",), "geology": "require"},
    "Electricae":     {"atmos": ("thin",), "geology": "require"},
    "Fonticulua":     {"atmos": ("thin",)},
    "Frutexa":        {"atmos": ("thin",)},
    "Fumerola":       {"atmos": ("none", "thin"), "geology": "require"},
    "Fungoida":       {"atmos": ("thin",)},
    "Osseus":         {"atmos": ("thin",)},
    "Recepta":        {"atmos": ("thin",)},
    "Shards":         {"atmos": ("none",), "geology": "bonus"},
    "Stratum":        {"atmos": ("thin",)},
    "Tubers":         {"atmos": ("thin",)},
    "Tubus":          {"atmos": ("thin",)},
    "Tussock":        {"atmos": ("thin",)},
}

# Веса совпадений (сумма даёт «уверенность» предсказания).
WEIGHT_ATMOSPHERE = 3.0
WEIGHT_GEOLOGY = 2.0
WEIGHT_TEMP = 1.0
WEIGHT_GRAVITY = 1.0
WEIGHT_MATERIAL = 1.0


def predict_genera(body: dict, limit: Optional[int] = None) -> List[Tuple[str, float, List[str]]]:
    """Предсказать вероятные роды для тела.

    Возвращает список `(род, оценка, пояснения)`, отсортированный по убыванию.
    Оценка — абсолютная (сколько правил совпало), а не «процент успеха»: для
    грубой модели это честнее.
    """
    if not body:
        return []

    category = atmosphere_category(body)
    has_geology = bool(str(body.get("volcanism") or "").strip().lower()
                       not in ("", "no volcanism", "none"))
    temperature = _as_float(body.get("surface_temperature"), 0.0)
    gravity = _as_float(body.get("surface_gravity"), 0.0) / 10.0  # в журнале — м/с²
    materials = {str(m).lower() for m in (body.get("materials") or [])}

    results: List[Tuple[str, float, List[str]]] = []
    for genus, rule in GENUS_RULES.items():
        score = 0.0
        notes: List[str] = []

        allowed_atmos = rule.get("atmos") or ()
        if allowed_atmos:
            if category in allowed_atmos:
                score += WEIGHT_ATMOSPHERE
                notes.append(f"атмосфера: {category}")
            elif category != "unknown":
                # Атмосфера не подходит — род маловероятен, но не исключён
                # (модель грубая), поэтому просто не добираем баллы.
                continue

        geology = rule.get("geology")
        if geology == "require":
            if has_geology:
                score += WEIGHT_GEOLOGY
                notes.append("геология")
            else:
                continue
        elif geology == "bonus" and has_geology:
            score += WEIGHT_GEOLOGY
            notes.append("геология рядом")

        temp_range = rule.get("temp")
        if temp_range and temperature > 0:
            low, high = temp_range
            if low <= temperature <= high:
                score += WEIGHT_TEMP
                notes.append("температура")

        gravity_range = rule.get("gravity")
        if gravity_range and gravity > 0:
            low, high = gravity_range
            if low <= gravity <= high:
                score += WEIGHT_GRAVITY
                notes.append("гравитация")

        material = rule.get("materials")
        if material and material in materials:
            score += WEIGHT_MATERIAL
            notes.append(f"материал: {material}")

        if score > 0:
            results.append((genus, score, notes))

    # Сортировка: сначала оценка, затем алфавит — порядок детерминирован,
    # иначе список «прыгал» бы между тиками.
    results.sort(key=lambda row: (-row[1], row[0]))
    return results[:limit] if limit else results


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
        # Роды/виды, найденные когда-либо (для подсветки «уже встречалось»)
        self.seen_species: Dict[str, int] = {}

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _key(system: str, body: str) -> str:
        return f"{system}|{body}"

    def _body_key(self, event: dict, body_name: str = "") -> str:
        system = str(event.get("StarSystem") or self.current_system or "").strip()
        body = body_name or str(event.get("BodyName") or self.current_body or "").strip()
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
            }
            self.bodies[key] = body
        return body

    def _event_system(self, event: dict) -> str:
        """Система события: своя, если указана, иначе текущая."""
        return str(event.get("StarSystem") or self.current_system or "").strip()

    @staticmethod
    def _event_time(event: dict) -> float:
        """Момент события в секундах epoch.

        Для живого журнала это практически `time.time()`; timestamp из файла
        нужен, чтобы обратный отсчёт не «врал» при разборе истории.
        """
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
            if name in ("Location", "FSDJump", "Docked", "CarrierJump", "ApproachBody", "LeaveBody"):
                system = str(event.get("StarSystem") or "").strip()
                if system:
                    self.current_system = system
                if name == "ApproachBody":
                    self.current_body = str(event.get("BodyName") or "").strip()
                elif name == "LeaveBody":
                    self.current_body = ""
                return

            if name == "Scan":
                system = str(event.get("StarSystem") or self.current_system or "").strip()
                if system:
                    self.current_system = system
                props = body_props(event, system)
                if props is None:
                    return
                key = self._key(props["system"], props["name"])
                existing = self.bodies.get(key, {})
                # Уже известные факты (карта поверхности, число биосигналов)
                # не должны теряться при повторном скане тела.
                props["mapped"] = bool(existing.get("mapped", False))
                props["bio_signals"] = int(existing.get("bio_signals") or 0)
                self.bodies[key] = props
                self.current_body = props["name"]
                self._trim()
                return

            if name == "SAAScanComplete":
                body_name = str(event.get("BodyName") or self.current_body or "").strip()
                if not body_name:
                    return
                # Система — из самого события: `StarSystem` в нём есть, а
                # `current_system` к этому моменту мог уже уехать вперёд
                # (разбор истории идёт пачками).
                system = self._event_system(event)
                body = self._ensure_body(self._key(system, body_name), system, body_name)
                body["mapped"] = True
                return

            if name == "FSSBodySignals":
                signals = event.get("Signals") or []
                count = 0
                if isinstance(signals, list):
                    for signal in signals:
                        if not isinstance(signal, dict):
                            continue
                        signal_type = str(signal.get("Type") or "")
                        if any(token.lower() in signal_type.lower() for token in BIO_SIGNAL_TOKENS):
                            count += int(signal.get("Count") or 0)
                body_name = str(event.get("BodyName") or self.current_body or "").strip()
                if not body_name:
                    return
                system = self._event_system(event)
                body = self._ensure_body(self._key(system, body_name), system, body_name)
                body["bio_signals"] = max(int(body.get("bio_signals") or 0), count)
                return

            if name == "ScanOrganic":
                # В ScanOrganic тело лежит в поле `Body`, а не в `BodyName` —
                # иначе запись уходила к телу, на котором мы были до этого.
                body_name = str(event.get("Body") or event.get("BodyName")
                                or self.current_body or "")
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
                entry = self.organics.setdefault(key, {}).setdefault(
                    species, {"stage": "", "samples": 0, "first": "", "body": body_name,
                              "system": system, "last_ts": 0.0}
                )
                if stage == "Sample":
                    entry["samples"] = int(entry.get("samples") or 0) + 1
                    entry["stage"] = "Sample"
                    # Когда был последний снимок — по нему оверлей считает
                    # обратный отсчёт до следующего образца.
                    entry["last_ts"] = self._event_time(event)
                elif stage:
                    entry["stage"] = stage
                    entry["last_ts"] = self._event_time(event)
                self.seen_species[species] = self.seen_species.get(species, 0) + 1
                return

            if name == "CodexEntry":
                # Вид занесён в кодекс — значит, он точно найден на этом теле.
                if str(event.get("Category") or "").lower().startswith("$codex_categorytype_biology"):
                    species = str(event.get("Name_Localised") or event.get("Name") or "").strip()
                    if species:
                        self.seen_species[species] = self.seen_species.get(species, 0) + 1
        except Exception:
            # Хук не имеет права ронять разбор журнала.
            return

    # -- выдача ------------------------------------------------------------
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
        organics = self.organics.get(key, {})

        rows = []
        total_value = 0
        for species, data in sorted(organics.items()):
            samples = int(data.get("samples") or 0)
            complete = samples >= SAMPLES_FOR_FULL_CREDIT
            last_ts = float(data.get("last_ts") or 0.0)
            # Сколько осталось ждать до следующего снимка (0 — можно снимать).
            wait = 0.0
            if last_ts and not complete:
                wait = max(0.0, SAMPLE_COOLDOWN_SECONDS - (now - last_ts))
            value = estimate_value(self._genus_of(species), mapped=mapped)
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

        return {
            "system": body.get("system", ""),
            "body": body.get("name", ""),
            "planet_class": body.get("planet_class", ""),
            "landable": bool(body.get("landable")),
            "atmosphere": body.get("atmosphere") or body.get("atmosphere_type") or "нет",
            "atmosphere_category": atmosphere_category(body),
            "temperature": body.get("surface_temperature", 0.0),
            "gravity": body.get("surface_gravity", 0.0),
            "volcanism": body.get("volcanism") or "нет",
            "materials": body.get("materials", []),
            "mapped": mapped,
            "bio_signals": int(body.get("bio_signals") or 0),
            # Предсказания с процентом совпадения правил и оценкой в кр.
            "predictions": prediction_rows(body),
            "organics": rows,
            "value_cr": total_value,
            "samples_done": sum(row["samples"] for row in rows),
            "samples_total": sum(SAMPLES_FOR_FULL_CREDIT for _ in rows),
        }

    @staticmethod
    def _genus_of(species: str) -> str:
        """Из названия вида — род (первое слово): «Tussock Poxtop» → «Tussock».

        `ScanOrganic` отдаёт вид, а цена в таблице — по роду.
        """
        text = str(species or "").strip()
        if not text:
            return ""
        head = text.split()[0]
        if head in GENUS_VALUE_CR:
            return head
        # «Fungoida» во множественном числе приходит как «Fungoida», а вот
        # «Osseus» — как «Osseus»: проверяем и полную строку.
        return text if text in GENUS_VALUE_CR else head

    def search_system_planets(self, criteria_list, limit: int = 6) -> List[dict]:
        """Тела текущей системы, подходящие под выбранные наборы критериев.

        В отличие от `system_bodies()` сюда попадают и тела без биосигналов:
        поиск планет ищет именно параметры (тип, посадка, атмосфера), а не
        жизнь. Данные — только из журнала игрока.
        """
        if not criteria_list:
            return []
        bodies = [body for key, body in self.bodies.items()
                  if key.startswith(f"{self.current_system}|")]
        return search_planets(bodies, criteria_list, limit=limit)

    def system_bodies(self, limit: int = 10) -> List[dict]:
        """Тела текущей системы, у которых есть биосигналы (важные сверху).

        Сортировка: сначала по числу биосигналов, затем по наличию карты и по
        имени —
        порядок детерминирован, иначе список прыгал бы между тиками.
        """
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
        # Тела без биосигналов интересны только если на них уже взяты образцы.
        rows = [row for row in rows if row["bio_signals"] or row["has_organics"]]
        return rows[:limit]

    def recent_bodies(self, limit: int = 8) -> List[dict]:
        """Последние отсканированные тела текущей системы (свежие сверху)."""
        keys = [key for key in self.bodies if key.startswith(f"{self.current_system}|")]
        result = []
        for key in reversed(keys[-limit:]):
            state = self.body_state(key)
            if state:
                result.append(state)
        return result
