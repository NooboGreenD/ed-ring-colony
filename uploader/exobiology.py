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
                body = self._ensure_body(self._key(self.current_system, body_name),
                                         self.current_system, body_name)
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
                body = self._ensure_body(self._key(self.current_system, body_name),
                                         self.current_system, body_name)
                body["bio_signals"] = max(int(body.get("bio_signals") or 0), count)
                return

            if name == "ScanOrganic":
                key = self._body_key(event)
                body_name = str(event.get("Body") or self.current_body or "")
                system = self.current_system
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
                    species, {"stage": "", "samples": 0, "first": "", "body": body_name, "system": system}
                )
                if stage == "Sample":
                    entry["samples"] = int(entry.get("samples") or 0) + 1
                    entry["stage"] = "Sample"
                elif stage:
                    entry["stage"] = stage
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
    def current_body_state(self) -> Optional[dict]:
        """Состояние текущего тела (с предсказанием и прогрессом образцов)."""
        key = self._key(self.current_system, self.current_body)
        return self.body_state(key)

    def body_state(self, key: str) -> Optional[dict]:
        body = self.bodies.get(key)
        if body is None:
            return None
        predictions = predict_genera(body)
        organics = self.organics.get(key, {})
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
            "mapped": bool(body.get("mapped")),
            "bio_signals": int(body.get("bio_signals") or 0),
            "predictions": [
                {"genus": genus, "score": score, "notes": notes}
                for genus, score, notes in predictions
            ],
            "organics": [
                {
                    "species": species,
                    "stage": data.get("stage", ""),
                    "samples": int(data.get("samples") or 0),
                    "complete": int(data.get("samples") or 0) >= SAMPLES_FOR_FULL_CREDIT,
                }
                for species, data in sorted(organics.items())
            ],
        }

    def recent_bodies(self, limit: int = 8) -> List[dict]:
        """Последние отсканированные тела текущей системы (свежие сверху)."""
        keys = [key for key in self.bodies if key.startswith(f"{self.current_system}|")]
        result = []
        for key in reversed(keys[-limit:]):
            state = self.body_state(key)
            if state:
                result.append(state)
        return result
