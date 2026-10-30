"""Миникарта пешехода: где командир, где его корабль и что рядом.

Источник позиции — `Status.json`: игра пишет туда `Latitude`, `Longitude`,
`Altitude`, `Heading` и `PlanetRadius`, пока командир на поверхности (пешком
или в SRV), а вместе с ними `BodyName`, `Oxygen`, `Health`, `Temperature`,
`Gravity` и `SelectedWeapon`. Журнал позицию непрерывно не пишет, поэтому
`Status.json` здесь единственный честный источник «где я сейчас», а события
журнала (`Touchdown`, `Liftoff`, `Location`, `ApproachSettlement`) дают точки
интереса: корабль, поселения, планетарные порты.

Модуль без Qt и без сети: считает и хранит, рисует — блок HUD.
"""
from __future__ import annotations

import json
import math
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Optional, Sequence, Tuple

#: Шаг, с которым точка попадает в след: мельче — след «пухнет» на месте.
TRAIL_MIN_STEP_M = 8.0
#: Сколько точек следа помним (при 8 м это ~4,8 км прогулки).
TRAIL_MAX_POINTS = 600
#: Круги сетки миникарты: метры, ближайший подходящий по обзору.
SCALE_STEPS = (25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000)
#: Дальше этого точки интереса не рисуем: в масштабе они всё равно слипнутся.
POI_MAX_DRAW_M = 40000.0
#: Радиус планеты, если игра его не сообщила (у планет земного типа ~6371 км).
DEFAULT_PLANET_RADIUS = 6_371_000.0

#: Виды точек на карте.
POI_SHIP = "ship"
POI_SRV = "srv"
POI_SETTLEMENT = "settlement"
POI_STATION = "station"

#: Сколько точек интереса храним (поселения вокруг — не бесконечны).
POI_LIMIT = 24
#: Корабль и ровер не вытесняются новыми поселениями: к ним возвращаются.
POI_KEEP = (POI_SHIP, POI_SRV)

#: Образцов в полном комплекте: столько нужно, чтобы сдать вид в Vista.
#: Больше трёх за раз игра не держит — комплект собран, канистра снимается.
SAMPLES_PER_SPECIES = 3
#: Ближе этого новая точка образца не ставится: это тот же куст, а не новый.
SAMPLE_MIN_STEP_M = 5.0
#: Сколько ждём координату для образца, снятого до первого `Status.json`.
SAMPLE_PENDING_SECONDS = 30.0

#: Радиус клональной колонии по роду, метры.
#:
#: Это ровно то расстояние, на которое надо отойти от прошлого образца того же
#: вида, чтобы игра засчитала следующий: в Кодексе оно называется clonal
#: colony range. Значения из таблицы Genetic Sampler; придумывать «на глаз»
#: нельзя — ошибка в сотню метров превращает подсказку в неправду.
CLONAL_RANGE_M: Dict[str, int] = {
    "Aleoida": 150,
    "Amphora Plant": 100,
    "Anemone": 100,
    "Bacterium": 500,
    "Bark Mound": 100,
    "Brain Tree": 100,
    "Cactoida": 300,
    "Clypeus": 150,
    "Concha": 150,
    "Crystalline Shard": 100,
    "Electricae": 1000,
    "Fonticulua": 500,
    "Frutexa": 150,
    "Fumerola": 100,
    "Fungoida": 300,
    "Osseus": 800,
    "Recepta": 150,
    "Sinuous Tuber": 100,
    "Stratum": 500,
    "Tubus": 800,
    "Tussock": 200,
}
#: Род не из таблицы (новый патч, незнакомое имя) — самое частое значение.
DEFAULT_CLONAL_RANGE_M = 500
#: Игра называет часть родов во множественном числе (`Conchas`, `Brain Trees`),
#: а в таблице они в единственном: сравниваем по этим парам.
GENUS_ALIASES: Dict[str, str] = {
    "conchas": "concha",
    "brain trees": "brain tree",
    "bark mounds": "bark mound",
    "sinuous tubers": "sinuous tuber",
    "crystalline shards": "crystalline shard",
    "amphora plants": "amphora plant",
}
_CLONAL_BY_NAME = {name.casefold(): meters for name, meters in CLONAL_RANGE_M.items()}


def codex_name(*values: Any) -> str:
    """Название из Кодекса в читаемом виде; пусто — перевода нет.

    Игра пишет ``$Codex_Ent_Bacterial_01_Name;`` — такую строку показывать
    нельзя. Берём первое значение, которое не похоже на внутренний ключ.
    """
    for value in values:
        text = str(value or "").strip()
        if not text or text.startswith("$"):
            continue
        return text
    return ""


def clonal_range(*names: Any) -> int:
    """Радиус клональной колонии по названию рода или вида, метры.

    Журнал даёт род в ``ScanOrganic.Genus`` (``Bacterium``) и вид в
    ``Species`` (``Bacterium Cerbrus``); локальные названия родов в таблице не
    встречаются, поэтому перебираем всё, что пришло, и сравниваем по началу
    строки: вид начинается с рода.
    """
    for raw in names:
        text = str(raw or "").strip()
        if not text or text.startswith("$"):
            continue
        folded = " ".join(text.casefold().replace("_", " ").split())
        for name, meters in _CLONAL_BY_NAME.items():
            if folded == name or folded.startswith(name + " "):
                return int(meters)
        alias = GENUS_ALIASES.get(folded)
        if alias and alias in _CLONAL_BY_NAME:
            return int(_CLONAL_BY_NAME[alias])
    return DEFAULT_CLONAL_RANGE_M


# ---------------------------------------------------------------------------
#  Геометрия поверхности
# ---------------------------------------------------------------------------
def normalize_heading(value: Any) -> float:
    """Курс в градусах, приведённый к ``0..360``; мусор -> 0."""
    try:
        heading = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(heading):
        return 0.0
    return heading % 360.0


def _coordinate(value: Any) -> Optional[float]:
    """Широта/долгота из журнала; ``None`` — координаты нет или она битая."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def local_offsets(lat: float, lon: float, ref_lat: float, ref_lon: float,
                  radius_m: float = DEFAULT_PLANET_RADIUS) -> Tuple[float, float]:
    """Смещение точки от опорной в метрах: ``(восток, север)``.

    Для прогулки в несколько километров равноугольная проекция в касательной
    плоскости — это сантиметры ошибки, а считается без тригонометрии сферы.
    """
    radius = float(radius_m or DEFAULT_PLANET_RADIUS)
    dlat = math.radians(float(lat) - float(ref_lat))
    dlon = math.radians(float(lon) - float(ref_lon))
    north = dlat * radius
    east = dlon * radius * math.cos(math.radians((float(lat) + float(ref_lat)) / 2.0))
    return east, north


def distance_m(lat: float, lon: float, ref_lat: float, ref_lon: float,
               radius_m: float = DEFAULT_PLANET_RADIUS) -> float:
    """Расстояние по поверхности между точками, метры."""
    east, north = local_offsets(lat, lon, ref_lat, ref_lon, radius_m)
    return math.hypot(east, north)


def bearing_deg(lat: float, lon: float, ref_lat: float, ref_lon: float,
                radius_m: float = DEFAULT_PLANET_RADIUS) -> float:
    """Азимут на точку: 0 — север, 90 — восток."""
    east, north = local_offsets(lat, lon, ref_lat, ref_lon, radius_m)
    return math.degrees(math.atan2(east, north)) % 360.0


def to_screen(east: float, north: float, heading: float,
              px_per_m: float, center_x: float, center_y: float) -> Tuple[float, float]:
    """Экранные координаты точки: карта развёрнута по курсу (впереди — вверх).

    Курс 0 — командир смотрит на север: север вверху. Курс 90 — на восток:
    восток уходит вверх. Поворот делаем на ``-heading`` вокруг центра.
    """
    angle = math.radians(normalize_heading(heading))
    sin_a, cos_a = math.sin(angle), math.cos(angle)
    # Вперёд (по курсу) и вправо (по правому борту) в метрах.
    forward = east * sin_a + north * cos_a
    right = east * cos_a - north * sin_a
    return center_x + right * px_per_m, center_y - forward * px_per_m


def pick_scale(reach_m: float) -> int:
    """Радиус обзора миникарты: ближайшая ступень не меньше достигнутого."""
    reach = max(0.0, float(reach_m or 0.0))
    for step in SCALE_STEPS:
        if step >= reach:
            return int(step)
    return int(SCALE_STEPS[-1])


def split_distance(meters: float) -> Tuple[float, str]:
    """Расстояние в удобных единицах: ``(число, 'm'|'km')``.

    Подпись «м»/«км» ставит блок HUD на текущем языке.
    """
    meters = max(0.0, float(meters or 0.0))
    if meters < 1000.0:
        return round(meters), "m"
    return round(meters / 1000.0, 1), "km"


# ---------------------------------------------------------------------------
#  Состояние миникарты
# ---------------------------------------------------------------------------
def empty_state() -> Dict[str, Any]:
    """Состояние «позиции с поверхности нет» — блок покажет подсказку."""
    return {
        "known": False,
        "body": "",
        "system": "",
        "lat": None,
        "lon": None,
        "heading": 0.0,
        "altitude": None,
        "radius": DEFAULT_PLANET_RADIUS,
        "on_foot": False,
        "vehicle": "",
        "oxygen": None,
        "health": None,
        "temperature": None,
        "gravity": None,
        "weapon": "",
        "trail": [],
        "pois": [],
        "ship": None,
        "srv": None,
        "samples": [],
        "sample": None,
        "scale": pick_scale(100),
        "updated_at": "",
        "age_seconds": None,
    }


class FootMap:
    """Позиция командира на поверхности, след и точки интереса.

    Класс один на приложение: его кормят событием журнала (`handle`) и
    содержимым `Status.json` (`update_status` / `poll`), а блок HUD забирает
    готовое состояние (`state`). Потоки разные, поэтому состояние под замком.
    """

    def __init__(self, *, trail_step: float = TRAIL_MIN_STEP_M,
                 trail_limit: int = TRAIL_MAX_POINTS) -> None:
        self._lock = threading.RLock()
        self._trail_step = float(trail_step)
        self._trail_limit = int(trail_limit)
        self._trail: Deque[Tuple[float, float]] = deque(maxlen=self._trail_limit)
        self._lat: Optional[float] = None
        self._lon: Optional[float] = None
        self._heading = 0.0
        self._altitude: Optional[float] = None
        self._radius = DEFAULT_PLANET_RADIUS
        self._body = ""
        self._system = ""
        self._on_foot = False
        self._vehicle = ""
        self._oxygen: Optional[float] = None
        self._health: Optional[float] = None
        self._temperature: Optional[float] = None
        self._gravity: Optional[float] = None
        self._weapon = ""
        self._ship: Optional[Tuple[float, float]] = None
        self._pois: Dict[str, Dict[str, Any]] = {}
        # Образцы биосигналов: игра держит комплект только одного вида, поэтому
        # список всегда про текущий вид и обнуляется при смене вида.
        self._samples: List[Dict[str, Any]] = []
        self._sample_species = ""
        self._sample_genus = ""
        self._sample_radius = DEFAULT_CLONAL_RANGE_M
        # Образец, снятый до первого `Status.json`: ждём координату.
        self._pending_sample: Optional[Dict[str, Any]] = None
        self._pending_at: Optional[float] = None
        self._updated_at = ""
        self._position_at: Optional[float] = None
        self._file_key: Optional[Tuple[float, int]] = None
        self._signature: Optional[tuple] = None

    # -- журнал -------------------------------------------------------------
    def handle(self, event: Dict[str, Any]) -> bool:
        """Обработать событие журнала. ``True`` — состояние изменилось."""
        if not isinstance(event, dict):
            return False
        name = str(event.get("event") or "")
        if name in ("LoadGame", "NewCommander", "Commander"):
            return self.reset()
        if name in ("FSDJump", "SupercruiseExit", "SupercruiseEntry", "Died",
                    "Resurrect", "Shutdown"):
            # Смена системы или смерть: позиция и след больше не про это место.
            return self.reset()
        with self._lock:
            before = self._signature
            changed = False
            if name in ("Location", "Touchdown", "Liftoff", "Docked", "Undocked"):
                changed |= self._take_place(event)
            if name in ("Location", "Touchdown", "Liftoff"):
                changed |= self._take_ship_point(event, lift_off=(name == "Liftoff"))
            if name in ("ApproachSettlement", "Docked", "Location"):
                changed |= self._take_poi(event)
            if name in ("Embark", "Disembark"):
                # Вышел из ровера — запомнили, где он стоит; сел обратно —
                # точка снята. Из корабля выходят там же, где он приземлился.
                changed |= self._take_vehicle_point(event, boarding=(name == "Embark"))
            if name == "DockSRV":
                # Ровер убран в корабль: отдельной точки на карте больше нет.
                changed |= self._forget_srv()
            if name == "ScanOrganic":
                changed |= self._take_sample(event)
            if name == "Disembark":
                changed |= self._set_vehicle(on_foot=True)
            elif name == "Embark":
                changed |= self._set_vehicle(on_foot=False)
            if changed:
                self._refresh_signature()
            return bool(changed and self._signature != before)

    def _take_place(self, event: Dict[str, Any]) -> bool:
        """Система и тело: смена тела обнуляет след и точки интереса."""
        system = str(event.get("StarSystem") or "")
        body = str(event.get("BodyName") or event.get("Body") or "")
        changed = False
        if system and system != self._system:
            self._system = system
            changed = True
        if body and body != self._body:
            self._body = body
            self._trail.clear()
            self._pois.clear()
            self._ship = None
            self._forget_samples()
            changed = True
        return changed

    def _take_ship_point(self, event: Dict[str, Any], *, lift_off: bool) -> bool:
        """Где стоит корабль: ``Touchdown``/``Location`` дают его координаты."""
        if lift_off:
            if self._ship is None:
                return False
            self._ship = None
            self._pois.pop(POI_SHIP, None)
            return True
        lat = _coordinate(event.get("Latitude"))
        lon = _coordinate(event.get("Longitude"))
        if lat is None or lon is None:
            return False
        if self._ship == (lat, lon):
            return False
        self._ship = (lat, lon)
        self._pois[POI_SHIP] = {"kind": POI_SHIP, "name": "", "lat": lat, "lon": lon}
        return True

    def _take_vehicle_point(self, event: Dict[str, Any], *, boarding: bool) -> bool:
        """Ровер и корабль: где осталась машина, когда командир пошёл пешком."""
        is_srv = bool(event.get("SRV"))
        if boarding:
            # Сел в ровер — он теперь под рукой, отдельная точка не нужна.
            return self._forget_srv() if is_srv else False
        lat = _coordinate(event.get("Latitude"))
        lon = _coordinate(event.get("Longitude"))
        if lat is None or lon is None:
            # Координат в событии нет — остаётся то, что записал `Touchdown`.
            return False
        if not is_srv:
            # Вышел из корабля: он стоит ровно здесь (`Touchdown` может не быть).
            return self._set_poi(POI_SHIP, POI_SHIP, "", lat, lon)
        return self._set_poi(POI_SRV, POI_SRV, "", lat, lon)

    def _forget_srv(self) -> bool:
        if POI_SRV not in self._pois:
            return False
        self._pois.pop(POI_SRV, None)
        return True

    def _set_poi(self, key: str, kind: str, name: str, lat: float, lon: float) -> bool:
        """Поставить точку интереса, не плодя одинаковых записей."""
        record = {"kind": kind, "name": name, "lat": lat, "lon": lon}
        if self._pois.get(key) == record:
            return False
        if key not in self._pois and len(self._pois) >= POI_LIMIT:
            self._drop_farthest_poi()
        self._pois[key] = record
        return True

    def _take_sample(self, event: Dict[str, Any]) -> bool:
        """Образец биосигнала: где снят и на сколько отойти до следующего.

        Журнал присылает три события на один куст: `Log` (вид впервые в
        Кодексе), `Sample` (собственно образец) и `Analyse` (анализ готов).
        Точку ставит только `Sample` — иначе на карте было бы три метки в
        одном месте.
        """
        if str(event.get("ScanType") or "") != "Sample":
            return False
        species = codex_name(event.get("Species_Localised"), event.get("Species"))
        genus = codex_name(event.get("Genus_Localised"), event.get("Genus"))
        if not species and not genus:
            return False
        radius = clonal_range(event.get("Genus"), event.get("Species"), genus, species)
        if self._lat is None or self._lon is None:
            # `Status.json` ещё не прочитан: запомним и поставим точку, как
            # только появится координата (командир всё ещё стоит на месте).
            self._pending_sample = {"species": species, "genus": genus, "radius": radius}
            self._pending_at = time.monotonic()
            return False
        return self._place_sample(species, genus, radius, self._lat, self._lon)

    def _place_sample(self, species: str, genus: str, radius: int,
                      lat: float, lon: float) -> bool:
        """Добавить точку образца к текущему комплекту."""
        # Смена вида стирает недособранный комплект — так делает и игра.
        if species and self._sample_species and species != self._sample_species:
            self._samples.clear()
        # Комплект собран: следующий образец того же вида начинает новый.
        if len(self._samples) >= SAMPLES_PER_SPECIES:
            self._samples.clear()
        for row in self._samples:
            if distance_m(row["lat"], row["lon"], lat, lon, self._radius) < SAMPLE_MIN_STEP_M:
                return False                      # это тот же куст, а не новый
        self._samples.append({"species": species, "genus": genus, "radius": int(radius),
                              "lat": float(lat), "lon": float(lon)})
        self._sample_species = species or self._sample_species
        self._sample_genus = genus or self._sample_genus
        self._sample_radius = int(radius)
        return True

    def _forget_samples(self, *, keep_pending: bool = True) -> None:
        """Забыть образцы текущего тела.

        Отложенный образец (снятый до первого `Status.json`) при смене тела
        остаётся: он взят уже здесь, а координату как раз и ждём. Сбрасывается
        он только вместе с установкой — при смерти, прыжке и новой сессии.
        """
        self._samples.clear()
        self._sample_species = ""
        self._sample_genus = ""
        self._sample_radius = DEFAULT_CLONAL_RANGE_M
        if not keep_pending:
            self._pending_sample = None
            self._pending_at = None

    def _place_pending_sample(self) -> bool:
        """Поставить отложенный образец, когда появилась координата."""
        pending = self._pending_sample
        if not pending:
            return False
        if self._pending_at is not None and \
                time.monotonic() - self._pending_at > SAMPLE_PENDING_SECONDS:
            self._pending_sample = None
            return False
        if self._lat is None or self._lon is None:
            return False
        self._pending_sample = None
        self._pending_at = None
        return self._place_sample(pending["species"], pending["genus"],
                                  int(pending["radius"]), self._lat, self._lon)

    def _take_poi(self, event: Dict[str, Any]) -> bool:
        """Поселение или планетарный порт: имя и координаты на карту."""
        lat = _coordinate(event.get("Latitude"))
        lon = _coordinate(event.get("Longitude"))
        if lat is None or lon is None:
            return False
        # У планетарного порта имя лежит в StationName, у поселения — в Name.
        station_name = str(event.get("StationName_Localised")
                           or event.get("StationName") or "").strip()
        place_name = str(event.get("Name_Localised") or event.get("Name") or "").strip()
        if station_name:
            kind, name = POI_STATION, station_name
        elif place_name:
            kind, name = POI_SETTLEMENT, place_name
        elif event.get("MarketID") and str(event.get("event") or "") == "ApproachSettlement":
            # Имя не переведено — точка на карте всё равно нужна, подпись пустая.
            kind, name = POI_SETTLEMENT, ""
        else:
            # `Location` в космосе (без станции) — это не объект на поверхности.
            return False
        if name.startswith("$"):
            name = ""
        key = f"{kind}:{event.get('MarketID') or name or f'{lat:.5f},{lon:.5f}'}"
        record = {"kind": kind, "name": name, "lat": lat, "lon": lon}
        if self._pois.get(key) == record:
            return False
        if len(self._pois) >= POI_LIMIT and key not in self._pois:
            # Новая точка остаётся всегда, а место освобождает самая дальняя из
            # уже известных: иначе первый же новый объект вдали (поселение,
            # которое только что проехали) вытеснял бы сам себя.
            self._drop_farthest_poi()
        self._pois[key] = record
        return True

    def _drop_farthest_poi(self) -> None:
        """Освободить место под новую точку самой дальней из старых.

        Корабль и ровер не вытесняются: это точки, к которым возвращаются, и
        потерять их из-за десятка поселений рядом — худшее, что может сделать
        карта.
        """
        candidates = [key for key in self._pois if key not in POI_KEEP] or list(self._pois)
        if self._lat is None or self._lon is None:
            self._pois.pop(candidates[0], None)
            return
        farthest = max(
            candidates,
            key=lambda key: distance_m(self._pois[key]["lat"], self._pois[key]["lon"],
                                       self._lat, self._lon, self._radius),
        )
        self._pois.pop(farthest, None)

    def _set_vehicle(self, *, on_foot: bool) -> bool:
        if self._on_foot == bool(on_foot) and self._vehicle:
            return False
        self._on_foot = bool(on_foot)
        self._vehicle = "foot" if on_foot else ""
        return True

    def reset(self) -> bool:
        """Забыть поверхность (смена системы, новая сессия, смерть)."""
        with self._lock:
            before = self._signature
            self._lat = self._lon = None
            self._altitude = None
            self._heading = 0.0
            self._trail.clear()
            self._pois.clear()
            self._ship = None
            self._forget_samples(keep_pending=False)
            self._on_foot = False
            self._vehicle = ""
            self._oxygen = self._health = self._temperature = self._gravity = None
            self._weapon = ""
            self._position_at = None
            self._file_key = None
            self._refresh_signature()
            return self._signature != before

    # -- Status.json --------------------------------------------------------
    def update_status(self, status: Dict[str, Any], *, timestamp: str = "") -> bool:
        """Координаты и жизненные показатели из `Status.json`."""
        if not isinstance(status, dict):
            return False
        with self._lock:
            before = self._signature
            changed = False
            self._take_place({"StarSystem": status.get("StarSystem"),
                              "BodyName": status.get("BodyName")})
            radius = _coordinate(status.get("PlanetRadius"))
            if radius and radius > 0 and radius != self._radius:
                self._radius = float(radius)
                changed = True
            flags2 = status.get("Flags2")
            if isinstance(flags2, int):
                on_foot = bool(flags2 & 0x1)
                if on_foot != self._on_foot:
                    self._on_foot = on_foot
                    self._vehicle = "foot" if on_foot else ""
                    changed = True
            lat = _coordinate(status.get("Latitude"))
            lon = _coordinate(status.get("Longitude"))
            if lat is not None and lon is not None:
                changed |= self._move_to(lat, lon)
                altitude = _coordinate(status.get("Altitude"))
                if altitude is not None and altitude != self._altitude:
                    self._altitude = altitude
                    changed = True
                heading = normalize_heading(status.get("Heading"))
                if heading != self._heading:
                    self._heading = heading
                    changed = True
                self._position_at = time.monotonic()
                self._updated_at = str(timestamp or status.get("timestamp") or "")
            if self._lat is not None and self._lon is not None:
                changed |= self._place_pending_sample()
            changed |= self._take_vitals(status)
            if changed:
                self._refresh_signature()
            return self._signature != before

    def _take_vitals(self, status: Dict[str, Any]) -> bool:
        """Кислород, здоровье, температура, гравитация и оружие в руках."""
        changed = False
        options = (("_oxygen", "Oxygen", 100.0), ("_health", "Health", 100.0),
                   ("_temperature", "Temperature", 1.0), ("_gravity", "Gravity", 1.0))
        for attribute, key, factor in options:
            if key not in status:
                continue
            value = _coordinate(status.get(key))
            value = None if value is None else round(value * factor, 2)
            if getattr(self, attribute) != value:
                setattr(self, attribute, value)
                changed = True
        weapon = str(status.get("SelectedWeapon_Localised")
                     or status.get("SelectedWeapon") or "")
        if weapon.startswith("$"):
            weapon = ""
        if weapon and weapon != self._weapon:
            self._weapon = weapon
            changed = True
        return changed

    def _move_to(self, lat: float, lon: float) -> bool:
        """Новая позиция: точка следа добавляется только на заметном шаге."""
        if self._lat == lat and self._lon == lon:
            return False
        first = self._lat is None or self._lon is None
        moved = (first or
                 distance_m(lat, lon, self._lat, self._lon, self._radius) >= self._trail_step)
        self._lat, self._lon = float(lat), float(lon)
        if moved and not first:
            self._trail.append((self._lat, self._lon))
        if first:
            self._trail.clear()
            self._trail.append((self._lat, self._lon))
        return True

    def poll(self, journal_dir: Optional[Path]) -> bool:
        """Прочитать `Status.json`, если файл изменился с прошлого раза.

        Зовётся раз в секунду из цикла оверлея: файл маленький, а по mtime и
        размеру видно, писать ли что-то вообще.
        """
        if not journal_dir:
            return False
        path = Path(journal_dir) / "Status.json"
        try:
            stat = path.stat()
        except OSError:
            return False
        key = (stat.st_mtime, stat.st_size)
        if key == self._file_key:
            return False
        self._file_key = key
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return False
        if not isinstance(data, dict):
            return False
        return self.update_status(data)

    # -- состояние для блока HUD -------------------------------------------
    def _refresh_signature(self) -> None:
        self._signature = (self._lat, self._lon, round(self._heading, 1),
                           len(self._trail), len(self._pois), self._body,
                           self._on_foot, self._ship, self._oxygen, self._health,
                           self._temperature, self._gravity, self._weapon,
                           self._altitude, len(self._samples), self._sample_species,
                           self._sample_radius, self._pois.get(POI_SRV))

    def state(self) -> Dict[str, Any]:
        """Всё, что рисует блок миникарты: позиция, след, точки, показатели."""
        with self._lock:
            state = empty_state()
            state.update({
                "body": self._body,
                "system": self._system,
                "heading": round(self._heading, 1),
                "radius": self._radius,
                "on_foot": self._on_foot,
                "vehicle": self._vehicle,
                "oxygen": self._oxygen,
                "health": self._health,
                "temperature": self._temperature,
                "gravity": self._gravity,
                "weapon": self._weapon,
                "updated_at": self._updated_at,
            })
            if self._position_at is not None:
                state["age_seconds"] = round(time.monotonic() - self._position_at, 1)
            if self._lat is None or self._lon is None:
                return state

            state["known"] = True
            state["lat"] = self._lat
            state["lon"] = self._lon
            state["altitude"] = self._altitude

            trail = []
            for lat, lon in self._trail:
                east, north = local_offsets(lat, lon, self._lat, self._lon, self._radius)
                trail.append((round(east, 1), round(north, 1)))
            state["trail"] = trail

            pois = self._pois_list()
            state["pois"] = pois
            state["ship"] = next((poi for poi in pois if poi["kind"] == POI_SHIP), None)
            state["srv"] = next((poi for poi in pois if poi["kind"] == POI_SRV), None)

            samples = self._samples_list()
            state["samples"] = samples
            state["sample"] = self._sample_summary(samples)

            reach = max((poi["distance"] for poi in pois
                         if poi["distance"] <= POI_MAX_DRAW_M), default=0.0)
            reach = max(reach, max((math.hypot(e, n) for e, n in trail), default=0.0))
            # Пока комплект не собран, круг образца должен быть виден целиком:
            # именно по нему видно, куда ещё нельзя ставить следующий образец.
            if samples and not state["sample"]["complete"]:
                reach = max(reach, min(row["distance"] + row["radius"] for row in samples))
            state["scale"] = pick_scale(max(reach * 1.05, 60.0))
            return state

    def _samples_list(self) -> List[Dict[str, Any]]:
        """Образцы в метрах от командира: точка, вид и радиус колонии."""
        rows = []
        for index, record in enumerate(self._samples, start=1):
            east, north = local_offsets(record["lat"], record["lon"],
                                        self._lat, self._lon, self._radius)
            rows.append({
                "index": index,
                "species": record.get("species") or "",
                "genus": record.get("genus") or "",
                "radius": int(record.get("radius") or DEFAULT_CLONAL_RANGE_M),
                "east": round(east, 1),
                "north": round(north, 1),
                "distance": round(math.hypot(east, north), 1),
                "bearing": round(math.degrees(math.atan2(east, north)) % 360.0, 1),
            })
        rows.sort(key=lambda row: row["distance"])
        return rows

    def _sample_summary(self, rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Комплект текущего вида: сколько собрано и можно ли брать следующий.

        ``allowed`` — командир уже вышел за радиус колонии всех прошлых
        образцов; ``need_m`` — сколько метров до этого осталось.
        """
        if not rows and not self._sample_species:
            return None
        radius = int(self._sample_radius or DEFAULT_CLONAL_RANGE_M)
        nearest = min((row["distance"] for row in rows), default=None)
        allowed = nearest is None or nearest >= radius
        return {
            "species": self._sample_species,
            "genus": self._sample_genus,
            "radius": radius,
            "count": len(rows),
            "total": SAMPLES_PER_SPECIES,
            "complete": len(rows) >= SAMPLES_PER_SPECIES,
            "allowed": bool(allowed),
            "need_m": 0.0 if allowed else round(radius - float(nearest), 1),
            "nearest_m": nearest,
        }

    def _pois_list(self) -> List[Dict[str, Any]]:
        rows = []
        for record in self._pois.values():
            east, north = local_offsets(record["lat"], record["lon"],
                                        self._lat, self._lon, self._radius)
            rows.append({
                "kind": record["kind"],
                "name": record.get("name") or "",
                "east": round(east, 1),
                "north": round(north, 1),
                "distance": round(math.hypot(east, north), 1),
                "bearing": round(math.degrees(math.atan2(east, north)) % 360.0, 1),
            })
        rows.sort(key=lambda row: row["distance"])
        return rows

    # -- отладка и тесты ----------------------------------------------------
    def trail_points(self) -> List[Tuple[float, float]]:
        """След как он есть (широта, долгота) — для проверок без Qt."""
        with self._lock:
            return list(self._trail)

    def poi_keys(self) -> Iterable[str]:
        with self._lock:
            return tuple(self._pois)

    def sample_points(self) -> List[Dict[str, Any]]:
        """Образцы как они есть (широта, долгота, вид, радиус) — для проверок."""
        with self._lock:
            return [dict(row) for row in self._samples]


def trail_offsets(trail: Sequence[Tuple[float, float]], lat: float, lon: float,
                  radius_m: float = DEFAULT_PLANET_RADIUS) -> List[Tuple[float, float]]:
    """След в метрах относительно точки — удобно рисовать и проверять."""
    return [local_offsets(point_lat, point_lon, lat, lon, radius_m)
            for point_lat, point_lon in trail]
