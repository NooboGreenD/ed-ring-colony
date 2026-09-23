"""Карта системы в окне приложения: сцена на холсте Tk.

Движок сайта — three.js (`src/lib/orrery3d/`), в окно приложения он не влезает:
tkinter не умеет WebGL, а тащить в EXE второй браузер незачем. Поэтому здесь
рисуется **тот же пакет данных** (`system_view.build_view_payload`) на холсте:
та же раскладка, те же орбиты, зона обитаемости, постройки на поверхности тел,
подписи, фокус и уровни приближения. Математика камеры — зеркало
`src/lib/orrery3d/camera.ts`, движение тел — зеркало `motion.ts`, поэтому карта
в приложении и карта на сайте показывают одно и то же, только разными руками.

Модуль намеренно не импортирует tkinter: холст приходит аргументом и
используется как duck-typed виджет (`create_oval`, `create_line`, …). Из этого
следует приятное: всю математику и раскладку можно проверять юнит-тестами с
холстом-заглушкой, без графики и без дисплея.

Координаты: пакет живёт в своих unit'ах с Z вверх (плоскость орбит — XY),
экран — X вправо, Y вниз, как у Tk.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from system_map import ZONE_COLOR, orbit_color_for

Vec3 = Tuple[float, float, float]

#: Базовый угол обзора камеры — тот же, что у сайта (`camera.ts`).
CAMERA_FOV_DEG = 42.0
#: Виды камеры: (имя, подпись). «Свободный» получается перетаскиванием мыши.
VIEW_PRESETS: Tuple[Tuple[str, str], ...] = (
    ("iso", "3D"),
    ("top", "Сверху"),
    ("side", "Сбоку"),
)
#: Азимут и наклон камеры для видов-пресетов (градусы).
VIEW_ANGLES: Dict[str, Tuple[float, float]] = {
    "iso": (-33.0, 40.0),
    "top": (-90.0, 88.0),
    "side": (0.0, 6.0),
}
#: Уровни приближения — те же четыре, что на сайте и в кнопках вкладки.
ZOOM_LEVELS: Tuple[Tuple[int, str, str], ...] = (
    (0, "Система", "вся система целиком"),
    (1, "Кластер", "тела выбранной звезды"),
    (2, "Окрестность", "тело и его соседи"),
    (3, "Поверхность", "постройки на поверхности тела"),
)
#: Скорости проигрывания движения: суток за секунду реального времени.
MOTION_SPEEDS: Tuple[float, ...] = (0.25, 1.0, 4.0, 16.0, 64.0)
MOTION_SPEED_LABELS: Tuple[str, ...] = ("×0.25", "×1", "×4", "×16", "×64")

#: Палитра сцены: тёмный космос, как у сайта и в остальных панелях приложения.
BG_COLOR = "#05070d"
GRID_COLOR = "#101d2c"
TEXT_COLOR = "#e8eef7"
MUTED_COLOR = "#93a5bd"
ORANGE_COLOR = "#e67e22"
CYAN_COLOR = "#00c8ff"
PANEL_BG = "#0a121c"
PANEL_LINE = "#1d3b58"
STARFIELD_SEED = 20260923


# ────────────────────────────── векторная арифметика ───────────────────────
def _vec(point: Sequence[Any]) -> Vec3:
    values = list(point or ())[:3]
    while len(values) < 3:
        values.append(0.0)
    return (float(values[0] or 0.0), float(values[1] or 0.0), float(values[2] or 0.0))


def sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def mul(a: Vec3, k: float) -> Vec3:
    return (a[0] * k, a[1] * k, a[2] * k)


def dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Vec3, b: Vec3) -> Vec3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(point: Vec3) -> float:
    return math.sqrt(dot(point, point))


def normalize(point: Vec3) -> Vec3:
    size = length(point) or 1.0
    return (point[0] / size, point[1] / size, point[2] / size)


def clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


def direction_from_angles(yaw_deg: float, pitch_deg: float) -> Vec3:
    """Направление «от цели к камере» по азимуту и наклону (Z вверх)."""
    yaw = math.radians(yaw_deg)
    pitch = math.radians(clamp(pitch_deg, -88.0, 88.0))
    horizontal = math.cos(pitch)
    return normalize((horizontal * math.cos(yaw), horizontal * math.sin(yaw), math.sin(pitch)))


def angles_for_view(view: str) -> Tuple[float, float]:
    return VIEW_ANGLES.get(str(view), VIEW_ANGLES["iso"])


# ───────────────────────────────── кадр камеры ─────────────────────────────
@dataclass
class CameraFrame:
    """Что должно попасть в кадр: цель, полуразмер и уровень приближения."""

    target: Vec3 = (0.0, 0.0, 0.0)
    half_span: float = 1.0
    distance: float = 1.0
    zoom: int = 0
    focus: str = ""


def fit_distance(half_span: float, fov_deg: float = CAMERA_FOV_DEG,
                 aspect: float = 1.0, pad: float = 1.06) -> float:
    """Расстояние камеры, при котором полуразмер попадает в кадр (зеркало сайта).

    Учитываются оба угла: на узком окне сцена обязана влезать по ширине.
    """
    half = max(float(half_span), 1e-4)
    fov = math.radians(fov_deg)
    vertical = half / math.tan(fov / 2.0)
    safe_aspect = aspect if aspect > 0.05 else 0.05
    horizontal_fov = 2.0 * math.atan(math.tan(fov / 2.0) * safe_aspect)
    horizontal = half / math.tan(horizontal_fov / 2.0)
    return max(vertical, horizontal) * pad


def _body_by_name(payload: Dict[str, Any], name: str) -> Optional[Dict[str, Any]]:
    for body in payload.get("bodies") or []:
        if body.get("name") == name:
            return body
    return None


def display_radius(payload: Dict[str, Any], body: Optional[Dict[str, Any]]) -> float:
    """Радиус тела в unit'ах сцены: у звёзд он спрятан в размере маркера."""
    span = float(payload.get("span") or 240.0)
    if not body:
        return span * 0.005
    radius = float(body.get("radius") or 0.0)
    if radius > 0:
        return radius
    return max(span * 0.003, float(body.get("marker") or 8.0) * 0.05)


def nearest_distance(payload: Dict[str, Any], name: str) -> float:
    """Расстояние до ближайшего соседа: им кадрируется «окрестность» тела."""
    origin = _body_by_name(payload, name)
    span = float(payload.get("span") or 240.0)
    if not origin:
        return span * 0.2
    best = float("inf")
    origin_point = _vec(origin.get("position"))
    for body in payload.get("bodies") or []:
        if body.get("name") == name:
            continue
        distance = length(sub(_vec(body.get("position")), origin_point))
        if 1e-4 < distance < best:
            best = distance
    return best if math.isfinite(best) else span * 0.2


def frame_for(payload: Dict[str, Any], focus: str = "", zoom: int = 0,
              aspect: float = 1.0, fov_deg: float = CAMERA_FOV_DEG) -> CameraFrame:
    """Кадр камеры для фокуса и уровня приближения (зеркало `camera.ts`).

    ``focus`` — пустая строка для обзора системы. Сначала выбирается кадр, потом
    считается расстояние: «зум» не может привести к пустому экрану.
    """
    span = max(1.0, float(payload.get("span") or 240.0))
    body = _body_by_name(payload, focus) if focus else None
    level = int(clamp(float(zoom or 0), 0.0, 3.0)) if body else 0
    center: Vec3 = (0.0, 0.0, 0.0)
    half_span = span

    if body:
        position = _vec(body.get("position"))
        if level == 0:
            center = position
        elif level == 1:
            cluster = next((row for row in payload.get("clusters") or []
                            if row.get("star") == body.get("name")
                            or body.get("name") in (row.get("bodies") or [])), None)
            center = _vec(cluster.get("center")) if cluster else position
            extent = 0.0
            for member in (cluster.get("bodies") if cluster else None) or []:
                point = _body_by_name(payload, member)
                if point:
                    extent = max(extent, length(sub(_vec(point.get("position")), center)))
            half_span = min(span, max(extent * 1.18 + span * 0.02,
                                      display_radius(payload, body) * 6.0, span * 0.06))
        elif level == 2:
            center = position
            half_span = max(display_radius(payload, body) * 6.0,
                            min(span * 0.35, nearest_distance(payload, body.get("name")) * 0.62),
                            span * 0.02)
        else:
            center = position
            half_span = max(display_radius(payload, body) * 2.4, span * 0.012)

    return CameraFrame(
        target=center,
        half_span=half_span,
        distance=fit_distance(half_span, fov_deg, aspect),
        zoom=level,
        focus=str(body.get("name")) if body else "",
    )


class SceneCamera:
    """Перспективная камера: мир пакета (Z вверх) → пиксели холста."""

    def __init__(self, frame: CameraFrame, view: str, width: float, height: float,
                 angles: Optional[Tuple[float, float]] = None,
                 fov_deg: float = CAMERA_FOV_DEG):
        self.width = float(width or 1.0)
        self.height = float(height or 1.0)
        self.fov_deg = float(fov_deg)
        if angles is None:
            angles = angles_for_view(view)
        self.yaw_deg, self.pitch_deg = float(angles[0]), float(angles[1])
        self.target = frame.target
        self.distance = max(1e-3, float(frame.distance))
        direction = direction_from_angles(self.yaw_deg, self.pitch_deg)
        self.eye = add(self.target, mul(direction, self.distance))
        self.forward = normalize(sub(self.target, self.eye))
        up_hint = (0.0, 0.0, 1.0)
        right = cross(self.forward, up_hint)
        if length(right) < 1e-4:
            # Вид строго сверху: «верх» экрана задаёт азимут камеры.
            yaw = math.radians(self.yaw_deg)
            up_hint = (-math.cos(yaw), -math.sin(yaw), 0.0)
            right = cross(self.forward, up_hint)
        self.right = normalize(right)
        self.up = cross(self.right, self.forward)
        self.focal = (self.height / 2.0) / math.tan(math.radians(self.fov_deg) / 2.0)

    def project(self, point: Sequence[Any]) -> Optional[Tuple[float, float, float, float]]:
        """Точка → (экран X, экран Y, глубина, масштаб unit→пиксель)."""
        delta = sub(_vec(point), self.eye)
        depth = dot(delta, self.forward)
        if depth <= 1e-4:
            return None
        x = dot(delta, self.right)
        y = dot(delta, self.up)
        scale = self.focal / depth
        return (self.width / 2.0 + x * scale, self.height / 2.0 - y * scale, depth, scale)

    def polyline(self, points: Iterable[Sequence[Any]], limit: float = 4.0) -> List[float]:
        """Готовая последовательность координат для `create_line` (с отсечением)."""
        coords: List[float] = []
        for point in points or ():
            projected = self.project(point)
            if projected is None:
                continue
            if not (-limit * self.width <= projected[0] <= (1.0 + limit) * self.width
                    and -limit * self.height <= projected[1] <= (1.0 + limit) * self.height):
                continue
            coords.extend((projected[0], projected[1]))
        return coords


# ────────────────────────── движение тел по орбитам ────────────────────────
def orbit_basis(orbit: Dict[str, Any]) -> Optional[Tuple[Vec3, Vec3, Vec3]]:
    """Плоскость орбиты по её полилинии (зеркало `orbitBasis` из `motion.ts`)."""
    points = [_vec(point) for point in (orbit.get("points") or [])]
    if len(points) < 3:
        return None
    center = _vec(orbit.get("center"))
    first = sub(points[0], center)
    if length(first) < 1e-6:
        return None
    u = normalize(first)
    normal: Optional[Vec3] = None
    for point in points:
        # Ищем точку, не лежащую на прямой «центр → первая точка».
        candidate = cross(u, sub(point, center))
        if length(candidate) > 1e-6:
            normal = normalize(candidate)
            break
    if normal is None:
        return None
    return (center, u, normalize(cross(normal, u)))


def angle_in_basis(basis: Tuple[Vec3, Vec3, Vec3], point: Sequence[Any]) -> float:
    center, u, v = basis
    delta = sub(_vec(point), center)
    return math.atan2(dot(delta, v), dot(delta, u))


def point_at_angle(basis: Tuple[Vec3, Vec3, Vec3], angle: float, radius: float) -> Vec3:
    center, u, v = basis
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    return add(center, (
        radius * (cos_a * u[0] + sin_a * v[0]),
        radius * (cos_a * u[1] + sin_a * v[1]),
        radius * (cos_a * u[2] + sin_a * v[2]),
    ))


def position_at_time(body: Dict[str, Any], orbit: Optional[Dict[str, Any]],
                     time_days: float) -> Vec3:
    """Где тело окажется через `time_days` суток (зеркало `positionAtTime`).

    Тело с настоящими элементами идёт по своему эллипсу (уравнение Кеплера,
    светило в фокусе), тело без элементов — по нарисованной окружности в её
    собственной плоскости. Поэтому движущаяся точка не сходит с орбиты.
    """
    position = _vec(body.get("position"))
    if not orbit or abs(time_days) < 1e-9:
        return position
    elements = body.get("elements") or {}
    period = float(elements.get("periodDays") or 0.0)
    phase = time_days / max(0.01, period if period > 0 else 400.0)

    if elements.get("real") and period > 0:
        import orrery

        eccentricity = clamp(float(elements.get("eccentricity") or 0.0), 0.0, 0.98)
        mean_anomaly = math.radians(float(elements.get("meanAnomalyDeg") or 0.0)) + phase * 2.0 * math.pi
        return orrery.orbit_point(
            float(orbit.get("radius") or 0.0),
            orrery.true_anomaly(mean_anomaly, eccentricity),
            eccentricity,
            math.radians(float(elements.get("inclinationDeg") or 0.0)),
            math.radians(float(elements.get("periapsisDeg") or 0.0)),
            _vec(orbit.get("center")),
        )

    basis = orbit_basis(orbit)
    if basis is None:
        return position
    angle = angle_in_basis(basis, position) + phase * 2.0 * math.pi
    return point_at_angle(basis, angle, float(orbit.get("radius") or 0.0))


# ──────────────────────────── цвета и оформление ───────────────────────────
def shade(color: str, factor: float) -> str:
    """Осветлить (factor > 0) или затемнить (factor < 0) цвет ``#rrggbb``."""
    text = str(color or "").lstrip("#")
    if len(text) != 6:
        return color if str(color).startswith("#") else "#8d99ae"
    try:
        channels = [int(text[index:index + 2], 16) for index in (0, 2, 4)]
    except ValueError:
        return "#8d99ae"
    if factor >= 0:
        channels = [int(channel + (255 - channel) * factor) for channel in channels]
    else:
        channels = [int(channel * (1.0 + factor)) for channel in channels]
    return "#%02x%02x%02x" % tuple(clamp(channel, 0, 255) for channel in channels)


def structure_color(structure: Dict[str, Any]) -> str:
    """Цвет постройки: та же палитра, что у сайта и у сцены вкладки."""
    try:
        from system_view import structure_color as shared

        return shared(float(structure.get("progress") or 0.0),
                      bool(structure.get("complete")),
                      float(structure.get("requiredTons") or 0.0))
    except Exception:
        return "#2ecc71" if structure.get("complete") else "#e67e22"


def ring_color(ring_class: str) -> str:
    try:
        from system_view import get_ring_color as shared

        return shared(ring_class)
    except Exception:
        return "#c7b299"


def _tons(value: Any) -> str:
    try:
        amount = float(value or 0.0)
    except (TypeError, ValueError):
        return "—"
    return f"{amount:,.0f}".replace(",", " ") + " t"


def _number(value: Any, digits: int = 1) -> str:
    try:
        amount = float(value or 0.0)
    except (TypeError, ValueError):
        return "—"
    text = f"{amount:,.{digits}f}".replace(",", " ")
    return text


def _radius_km(value: Any) -> str:
    try:
        metres = float(value or 0.0)
    except (TypeError, ValueError):
        return "—"
    if metres <= 0:
        return "—"
    return f"{_number(metres / 1000.0, 0)} км"


def _light_seconds(value: Any) -> str:
    try:
        amount = float(value or 0.0)
    except (TypeError, ValueError):
        return "—"
    if amount >= 1_000_000:
        return f"{_number(amount / 499.00478, 2)} а.е."
    return f"{_number(amount, 1)} св. с"


# ─────────────────────────── объект сцены (для мыши) ───────────────────────
@dataclass
class MapMarker:
    """Нарисованный объект в экранных координатах — для клика и подсказок."""

    kind: str                       # "star" | "body" | "station" | "player"
    key: str = ""                   # ключ выбора: имя тела или id постройки
    label: str = ""                 # имя «как в списке объектов»
    caption: str = ""               # класс/тип для подсказки
    x: float = 0.0
    y: float = 0.0
    radius: float = 6.0
    progress: Optional[int] = None
    ref: object = None
    selected: bool = False
    depth: float = 0.0
    data: Dict[str, Any] = field(default_factory=dict)


# ─────────────────────────────── сама сцена ────────────────────────────────
class TkOrreryView:
    """Сцена карты системы на холсте Tk: рисование, камера и мышь.

    Вид живёт во вкладке «Карта системы»: `colonial_helper` создаёт его один раз
    на холст вкладки и дальше только подкладывает свежий пакет (`set_payload`).
    """

    #: Насколько близко к курсору должен быть объект, чтобы он считался наведённым.
    PICK_MIN_PX = 9.0
    #: С какого числа тел подписи лун прячем на общем плане.
    MOON_LABELS_LIMIT = 40
    #: Пределы приближения колесом: «долли» поверх кадра уровня.
    DOLLY_MIN = 0.35
    DOLLY_MAX = 4.0

    def __init__(self, canvas: Any, on_select: Optional[Callable[[str], None]] = None,
                 on_hint: Optional[Callable[[str], None]] = None):
        self.canvas = canvas
        self.on_select = on_select
        self.on_hint = on_hint
        self.payload: Dict[str, Any] = {}
        self.markers: List[MapMarker] = []
        self.view = "iso"
        self.yaw_deg, self.pitch_deg = angles_for_view(self.view)
        self.zoom = 0
        self.focus = ""
        self.selected = ""
        self.hover_key = ""
        self.labels = True
        self.moons = True
        self.zones = True
        self.only_sites = False
        self.motion = False
        self.motion_speed = MOTION_SPEEDS[1]
        self.motion_offset_days = 0.0
        self.zoom_scale = 1.0
        self.pan_offset: Vec3 = (0.0, 0.0, 0.0)
        self.stations: Dict[str, Any] = {}
        self._camera: Optional[SceneCamera] = None
        self._hover_px: Optional[Tuple[float, float]] = None
        self._orbit_by_name: Dict[str, Dict[str, Any]] = {}
        self._body_by_name: Dict[str, Dict[str, Any]] = {}
        self._cluster_index: Dict[str, int] = {}
        self._structure_by_id: Dict[str, Dict[str, Any]] = {}

    # ----------------------------- данные -----------------------------
    def set_payload(self, payload: Optional[Dict[str, Any]]):
        """Подложить свежий пакет (`system_view.build_view_payload`)."""
        self.payload = dict(payload or {})
        self._body_by_name = {body.get("name"): body for body in self.payload.get("bodies") or []}
        self._orbit_by_name = {}
        for orbit in (self.payload.get("orbits") or []) + (self.payload.get("moonOrbits") or []):
            name = orbit.get("name") or orbit.get("owner")
            if name:
                self._orbit_by_name.setdefault(str(name), orbit)
        self._cluster_index = {}
        for index, cluster in enumerate(self.payload.get("clusters") or []):
            self._cluster_index[str(cluster.get("star") or "")] = index
            for name in cluster.get("bodies") or []:
                self._cluster_index[str(name)] = index
        self._structure_by_id = {str(structure.get("id")): structure
                                 for structure in self.payload.get("structures") or []}
        if self.focus and self.focus not in self._body_by_name:
            self.focus = ""

    def set_stations(self, stations: Dict[str, Any]):
        """Станции и стройплощадки по id — чтобы подсказка знала детали."""
        self.stations = dict(stations or {})

    @property
    def has_payload(self) -> bool:
        return bool(self.payload.get("bodies"))

    def cluster_index(self, name: str) -> int:
        return int(self._cluster_index.get(str(name), 0))

    # ----------------------------- состояние -----------------------------
    def set_view(self, view: str):
        self.view = view if view in VIEW_ANGLES else "iso"
        self.yaw_deg, self.pitch_deg = angles_for_view(self.view)

    def rotate(self, yaw_deg: float, pitch_deg: float):
        """Поворот камеры мышью: вид становится свободным от пресетов."""
        self.yaw_deg = float(yaw_deg) % 360.0
        self.pitch_deg = clamp(float(pitch_deg), 2.0, 88.0)
        self.view = "free"

    def set_zoom(self, zoom: int):
        self.zoom = int(clamp(float(zoom or 0), 0.0, 3.0))

    def set_focus(self, name: str):
        """Куда смотрит камера: пустая строка — вся система."""
        matched = str(name or "")
        self.focus = matched if matched in self._body_by_name else ""

    def focus_on(self, name: str, zoom: Optional[int] = None):
        """Навести камеру на тело: оно же становится выбранным."""
        self.set_focus(name)
        self.selected = self.focus or self.selected
        if zoom is not None:
            self.set_zoom(zoom)

    def clear_focus(self):
        """Вернуть камеру к обзору системы: фокус, панорама и приближение."""
        self.focus = ""
        self.zoom = 0
        self.zoom_scale = 1.0
        self.pan_offset = (0.0, 0.0, 0.0)

    def dolly(self, factor: float) -> float:
        """Приближение колесом: множитель к кадру текущего уровня."""
        self.zoom_scale = clamp(self.zoom_scale * float(factor), self.DOLLY_MIN, self.DOLLY_MAX)
        return self.zoom_scale

    def pan_by(self, dx_px: float, dy_px: float):
        """Сдвиг цели камеры в её собственной плоскости (правая кнопка мыши)."""
        camera = self._camera
        if camera is None:
            return
        # Знак «наоборот»: карта едет за курсором, а не против него.
        per_pixel = camera.distance / max(1.0, camera.focal)
        self.pan_offset = add(self.pan_offset,
                              add(mul(camera.right, -float(dx_px) * per_pixel),
                                  mul(camera.up, float(dy_px) * per_pixel)))

    def reset_view(self):
        self.set_view("iso")
        self.clear_focus()
        self.motion_offset_days = 0.0

    def toggle_motion(self, enabled: Optional[bool] = None) -> bool:
        self.motion = (not self.motion) if enabled is None else bool(enabled)
        return self.motion

    def tick(self, seconds: float):
        """Продвинуть время анимации: `seconds` реального времени."""
        if not self.motion:
            return False
        self.motion_offset_days += max(0.0, float(seconds)) * float(self.motion_speed)
        return True

    def reset_time(self):
        """«К сканам»: вернуть тела в точки, где их застал последний скан."""
        self.motion_offset_days = 0.0

    def zoom_label(self) -> str:
        for level, label, _hint in ZOOM_LEVELS:
            if level == self.zoom:
                return label
        return ZOOM_LEVELS[0][1]

    def view_label(self) -> str:
        for name, label in VIEW_PRESETS:
            if name == self.view:
                return label
        return "Свободный"

    # ----------------------------- движение -----------------------------
    def body_position(self, body: Dict[str, Any]) -> Vec3:
        if not self.motion_offset_days:
            return _vec(body.get("position"))
        orbit = self._orbit_by_name.get(str(body.get("name")))
        return position_at_time(body, orbit, self.motion_offset_days)

    def structure_position(self, structure: Dict[str, Any]) -> Vec3:
        """Постройка едет вместе со своим телом — иначе она «отрывается»."""
        position = _vec(structure.get("position"))
        if not self.motion_offset_days:
            return position
        body = self._body_by_name.get(str(structure.get("body")))
        if body is None:
            return position
        delta = sub(self.body_position(body), _vec(body.get("position")))
        return add(position, delta)

    def player_position(self) -> Optional[Vec3]:
        player = self.payload.get("player")
        if not player:
            return None
        position = _vec(player.get("position"))
        if not self.motion_offset_days:
            return position
        body = self._body_by_name.get(str(player.get("body")))
        if body is None:
            return position
        return add(position, sub(self.body_position(body), _vec(body.get("position"))))

    # ----------------------------- видимость -----------------------------
    def site_bodies(self) -> set:
        """Тела, на которых есть стройки или станции (для фильтра «только стройки»)."""
        names = {str(structure.get("body") or "") for structure in self.payload.get("structures") or []
                 if str(structure.get("body") or "")}
        player = self.payload.get("player") or {}
        if player.get("body"):
            names.add(str(player["body"]))
        return names

    def visible_bodies(self) -> List[Dict[str, Any]]:
        bodies = list(self.payload.get("bodies") or [])
        if not self.moons:
            bodies = [body for body in bodies if body.get("kind") != "moon"]
        if self.only_sites:
            keep = self.site_bodies()
            if keep:
                bodies = [body for body in bodies
                          if body.get("kind") == "star" or str(body.get("name")) in keep]
        return bodies

    def visible_structures(self) -> List[Dict[str, Any]]:
        keep = {str(body.get("name")) for body in self.visible_bodies()}
        return [structure for structure in self.payload.get("structures") or []
                if str(structure.get("body") or "") in keep or not structure.get("body")]

    # ----------------------------- рисование -----------------------------
    def canvas_size(self) -> Tuple[int, int]:
        canvas = self.canvas
        try:
            width = int(canvas.winfo_width())
            height = int(canvas.winfo_height())
        except Exception:
            return 0, 0
        if width <= 1 or height <= 1:
            return 0, 0
        return width, height

    def draw(self) -> bool:
        """Нарисовать сцену. Возвращает False, если холст ещё без размеров."""
        width, height = self.canvas_size()
        if not width or not height:
            return False
        canvas = self.canvas
        canvas.delete("all")
        self.markers = []
        self._draw_starfield(width, height)
        if not self.has_payload:
            self._panel(width, height)
            canvas.create_text(width / 2.0, height / 2.0,
                               text="Нет данных о системе — карта появится после прыжка или скана",
                               fill=MUTED_COLOR, font=("Segoe UI", 11), anchor="center")
            return True

        aspect = float(width) / float(height or 1)
        frame = frame_for(self.payload, self.focus, self.zoom, aspect)
        # «Долли» колесом сужает кадр, панорама сдвигает цель: камера смотрит
        # то же самое, но ближе и левее/правее.
        if self.zoom_scale != 1.0:
            frame.half_span = max(1e-3, frame.half_span / self.zoom_scale)
            frame.distance = fit_distance(frame.half_span, CAMERA_FOV_DEG, aspect)
        if self.pan_offset != (0.0, 0.0, 0.0):
            frame.target = add(frame.target, self.pan_offset)
        camera = SceneCamera(frame, self.view, width, height,
                             angles=(self.yaw_deg, self.pitch_deg))
        self._camera = camera

        bodies = self.visible_bodies()
        visible_names = {str(body.get("name")) for body in bodies}
        structures = self.visible_structures()

        if self.zones:
            self._draw_zones(canvas, camera)
        self._draw_orbits(canvas, camera, visible_names, bodies)
        self._draw_sprites(canvas, camera, bodies, structures, visible_names)
        self._draw_hud(canvas, width, height)
        return True

    def _draw_starfield(self, width: int, height: int):
        """Звёздная пыль: детерминированная, чтобы кадры не «кипели»."""
        canvas = self.canvas
        canvas.create_rectangle(0, 0, width, height, fill=BG_COLOR, outline="")
        seed = STARFIELD_SEED
        for _ in range(90):
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            x = (seed % max(1, width))
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            y = (seed % max(1, height))
            seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
            bright = 0.25 + (seed % 100) / 200.0
            radius = 0.6 if seed % 7 else 1.3
            canvas.create_oval(x - radius, y - radius, x + radius, y + radius,
                               fill=shade("#7f8ea3", bright), outline="")

    def _draw_zones(self, canvas: Any, camera: SceneCamera):
        """Полоса обитаемой зоны: то же кольцо, что на схеме и на сайте."""
        for zone in self.payload.get("zones") or []:
            center = _vec(zone.get("center"))
            inner = float(zone.get("inner") or 0.0)
            outer = float(zone.get("outer") or 0.0)
            if inner <= 0 or outer <= inner:
                continue
            steps = 72
            band: List[float] = []
            ring_inner: List[float] = []
            ring_outer: List[float] = []
            for step in range(steps + 1):
                angle = 2.0 * math.pi * step / steps
                cos_a, sin_a = math.cos(angle), math.sin(angle)
                for radius, ring in ((inner, ring_inner), (outer, ring_outer)):
                    point = (center[0] + radius * cos_a, center[1] + radius * sin_a, center[2])
                    projected = camera.project(point)
                    if projected is None:
                        continue
                    ring.extend((projected[0], projected[1]))
                    band.extend((projected[0], projected[1]))
            if len(band) < 6:
                continue
            canvas.create_polygon(band, fill=ZONE_COLOR, stipple="gray12",
                                  outline="", width=0)
            for ring in (ring_inner, ring_outer):
                if len(ring) >= 6:
                    canvas.create_line(*ring, fill=ZONE_COLOR, width=1, dash=(3, 5))

    def _draw_orbits(self, canvas: Any, camera: SceneCamera, visible_names: set,
                     bodies: Sequence[Dict[str, Any]]):
        """Орбиты: у каждой звезды свой оттенок — как в списке объектов."""
        moon_orbits = self.payload.get("moonOrbits") or []
        rows: List[Tuple[float, Dict[str, Any], bool]] = []
        for orbit in self.payload.get("orbits") or []:
            owner = str(orbit.get("name") or orbit.get("owner") or "")
            if visible_names and owner and owner not in visible_names:
                continue
            # Ближе к камере — позже: орбиты дальних тел уходят под ближние.
            rows.append((self._orbit_depth(camera, orbit), orbit, False))
        for orbit in moon_orbits:
            owner = str(orbit.get("name") or "")
            if not visible_names or owner not in visible_names:
                continue
            rows.append((self._orbit_depth(camera, orbit), orbit, True))
        rows.sort(key=lambda row: -row[0])

        for _depth, orbit, is_moon in rows:
            coords = camera.polyline(orbit.get("points") or [], limit=2.0)
            if len(coords) < 4:
                continue
            owner = str(orbit.get("name") or orbit.get("owner") or "")
            if is_moon:
                color, width, dash = "#3d4a5c", 1, (2, 4)
            else:
                color = orbit_color_for(self.cluster_index(owner))
                width = 2 if orbit.get("real") else 1
                dash = () if orbit.get("real") else (6, 4)
            canvas.create_line(*coords, fill=color, width=width, dash=dash,
                               smooth=True)

    @staticmethod
    def _orbit_depth(camera: SceneCamera, orbit: Dict[str, Any]) -> float:
        """Глубина орбиты: по ней орбиты сортируются «дальние → ближние»."""
        depths = [projected[2] for projected in
                  (camera.project(point) for point in orbit.get("points") or [])]
        return min((depth for depth in depths if depth is not None), default=0.0)

    def _draw_sprites(self, canvas: Any, camera: SceneCamera, bodies: Sequence[Dict[str, Any]],
                      structures: Sequence[Dict[str, Any]], visible_names: set):
        """Тела, постройки и отметка пилота — от дальних к ближним."""
        sprites: List[Tuple[float, str, Any]] = []
        for body in bodies:
            projected = camera.project(self.body_position(body))
            if projected is None:
                continue
            sprites.append((projected[2], "body", (body, projected)))
        for structure in structures:
            projected = camera.project(self.structure_position(structure))
            if projected is None:
                continue
            sprites.append((projected[2], "station", (structure, projected)))
        player_point = self.player_position()
        player_projected = camera.project(player_point) if player_point else None
        if player_projected is not None:
            sprites.append((player_projected[2], "player", (player_projected,)))
        sprites.sort(key=lambda row: -row[0])

        body_labels: List[Tuple[float, str, float, float, str]] = []
        for _depth, kind, payload in sprites:
            if kind == "body":
                body, projected = payload
                radius = self._draw_body(canvas, body, projected)
                if self._body_label_visible(body):
                    body_labels.append((projected[2], self._body_label(body),
                                        projected[0], projected[1] - radius - 3.0,
                                        str(body.get("color") or TEXT_COLOR)))
                self._register(MapMarker(
                    kind="star" if body.get("kind") == "star" else "body",
                    key=str(body.get("name")), label=str(body.get("name")),
                    caption=str(body.get("cls") or body.get("kind") or ""),
                    x=projected[0], y=projected[1], radius=radius,
                    selected=str(body.get("name")) == self.selected,
                    depth=projected[2], data=body))
            elif kind == "station":
                structure, projected = payload
                radius = self._draw_structure(canvas, structure, projected)
                station = self.stations.get(str(structure.get("id")))
                self._register(MapMarker(
                    kind="station",
                    key=str(getattr(station, "build_id", "") or structure.get("id") or ""),
                    label=str(structure.get("name") or "Объект"),
                    caption=str(structure.get("type") or ""),
                    x=projected[0], y=projected[1], radius=radius,
                    progress=int(round(float(structure.get("progress") or 0.0))),
                    ref=station, depth=projected[2],
                    selected=str(structure.get("id")) == self.selected
                    or str(getattr(station, "build_id", "")) == self.selected,
                    data=structure))
            else:
                (projected,) = payload
                self._draw_player(canvas, projected)

        # Подписи: дальние рисуем раньше, ближние перекрывают их.
        if self.labels:
            for _depth, text, x, y, color in sorted(body_labels, key=lambda row: -row[0]):
                canvas.create_text(x, y, text=text, fill=shade(color, 0.55),
                                   font=("Consolas", 8), anchor="s")

        selected = next((marker for marker in self.markers if marker.selected), None)
        if selected is not None:
            self._draw_brackets(canvas, selected)

    def _body_label_visible(self, body: Dict[str, Any]) -> bool:
        if not self.labels:
            return False
        if body.get("kind") == "moon" and not self.only_sites:
            return len(self.payload.get("bodies") or []) <= self.MOON_LABELS_LIMIT or self.zoom >= 1
        return True

    @staticmethod
    def _body_label(body: Dict[str, Any]) -> str:
        return str(body.get("shortName") or body.get("name") or "")

    def _draw_body(self, canvas: Any, body: Dict[str, Any],
                   projected: Tuple[float, float, float, float]) -> float:
        """Диск тела со подсветкой, кольцами, дымкой и признаками стройки."""
        x, y, _depth, scale = projected
        span = float(self.payload.get("span") or 240.0)
        width = float(getattr(self._camera, "width", 1000.0))
        radius = clamp(display_radius(self.payload, body) * scale,
                       max(2.2, span * 0.0016), width * 0.14)
        color = str(body.get("color") or "#8d99ae")
        if body.get("kind") == "star":
            canvas.create_oval(x - radius * 2.4, y - radius * 2.4, x + radius * 2.4, y + radius * 2.4,
                               fill=shade(color, 0.15), outline="", stipple="gray12")
            canvas.create_oval(x - radius * 1.5, y - radius * 1.5, x + radius * 1.5, y + radius * 1.5,
                               fill=shade(color, 0.35), outline="", stipple="gray12")
            canvas.create_oval(x - radius, y - radius, x + radius, y + radius,
                               fill=color, outline=shade(color, 0.6), width=1)
            return radius

        self._draw_rings(canvas, body, x, y, radius)
        canvas.create_oval(x - radius, y - radius, x + radius, y + radius,
                           fill=color, outline=shade(color, -0.45), width=1)
        # Свет: блик смещён «к солнцу», тень — противоположный край диска.
        highlight = radius * 0.45
        canvas.create_oval(x - highlight * 1.6, y - highlight * 1.6,
                           x + highlight * 0.4, y + highlight * 0.4,
                           fill=shade(color, 0.4), outline="")
        if body.get("atmosphere") and float(body.get("pressureAtm") or 0.0) > 0:
            canvas.create_oval(x - radius * 1.18, y - radius * 1.18,
                               x + radius * 1.18, y + radius * 1.18,
                               fill=shade(color, 0.5), outline="", stipple="gray12")
        if body.get("structures"):
            canvas.create_oval(x - radius - 3.0, y - radius - 3.0,
                               x + radius + 3.0, y + radius + 3.0,
                               outline=ORANGE_COLOR, width=1, dash=(2, 3))
        return radius

    def _draw_rings(self, canvas: Any, body: Dict[str, Any], x: float, y: float,
                    radius: float):
        body_radius_m = float(body.get("radiusM") or 0.0)
        for ring in body.get("rings") or []:
            outer_km = float(ring.get("outerKm") or 0.0)
            inner_km = float(ring.get("innerKm") or 0.0)
            if body_radius_m <= 0 or outer_km <= 0:
                continue
            body_km = body_radius_m / 1000.0
            outer_scale = outer_km / body_km
            inner_scale = (inner_km / body_km) if inner_km > 0 else outer_scale * 0.92
            outer = clamp(outer_scale, 1.0, 4.5) * radius
            inner = clamp(inner_scale, 1.0, 4.5) * radius
            color = ring_color(str(ring.get("ringClass") or ""))
            squash = 0.22
            canvas.create_oval(x - outer, y - outer * squash, x + outer, y + outer * squash,
                               outline=color, width=2)
            if inner < outer:
                canvas.create_oval(x - inner, y - inner * squash, x + inner, y + inner * squash,
                                   outline=shade(color, -0.3), width=1, dash=(2, 3))

    def _draw_structure(self, canvas: Any, structure: Dict[str, Any],
                        projected: Tuple[float, float, float, float]) -> float:
        """Ромб постройки с дугой прогресса — как на схеме и на сайте."""
        x, y, _depth, scale = projected
        _ = scale
        progress = clamp(float(structure.get("progress") or 0.0), 0.0, 100.0)
        color = structure_color(structure)
        # Маркеры построек — в экранных пикселях: на любом приближении они
        # читаются одинаково, как значки в оверлее, а не растворяются в теле.
        size = 6.0 if scale >= 0.2 else 4.5
        radius = 8.0
        halo = radius
        if progress > 0:
            canvas.create_arc(x - radius, y - radius, x + radius, y + radius,
                              start=90, extent=-3.6 * progress, style="arc",
                              outline=color, width=2)
        canvas.create_oval(x - radius, y - radius, x + radius, y + radius,
                           outline=shade(color, -0.35), width=1, dash=(2, 4))
        canvas.create_polygon(x, y - size, x + size, y, x, y + size, x - size, y,
                              fill=ORANGE_COLOR if not structure.get("complete") else color,
                              outline=shade(color, -0.4), width=1)
        if structure.get("complete"):
            canvas.create_polygon(x, y - size, x + size, y, x, y + size, x - size, y,
                                  fill=color, outline="")
        if self.labels:
            canvas.create_text(x, y + halo + 2.0, text=f"{int(round(progress))}%",
                               fill=color, font=("Consolas", 8, "bold"), anchor="n")
        return radius

    def _draw_player(self, canvas: Any, projected: Tuple[float, float, float, float]):
        x, y, _depth, _scale = projected
        canvas.create_line(x - 9.0, y, x - 3.0, y, fill=CYAN_COLOR, width=1)
        canvas.create_line(x + 3.0, y, x + 9.0, y, fill=CYAN_COLOR, width=1)
        canvas.create_line(x, y - 9.0, x, y - 3.0, fill=CYAN_COLOR, width=1)
        canvas.create_line(x, y + 3.0, x, y + 9.0, fill=CYAN_COLOR, width=1)
        canvas.create_polygon(x, y - 3.0, x + 3.0, y + 3.0, x - 3.0, y + 3.0,
                              fill=CYAN_COLOR, outline="")
        player = self.payload.get("player") or {}
        caption = str(player.get("station") or player.get("name") or "Вы здесь")
        text = f"Вы здесь · {caption}" if player.get("station") else "Вы здесь"
        canvas.create_text(x + 12.0, y, text=text, fill=CYAN_COLOR,
                           font=("Consolas", 8, "bold"), anchor="w")
        self._register(MapMarker(kind="player", key="player", label="Вы здесь",
                                 caption=caption, x=x, y=y, radius=9.0, depth=_depth))

    def _draw_brackets(self, canvas: Any, marker: MapMarker):
        """Прицел вокруг выбранного объекта: видно, что именно открыто в карточке."""
        reach = max(marker.radius + 7.0, 15.0)
        arm = 5.0
        x, y = marker.x, marker.y
        color = ORANGE_COLOR
        for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
            canvas.create_line(x + sx * reach, y + sy * reach - sy * arm,
                               x + sx * reach, y + sy * reach,
                               x + sx * reach - sx * arm, y + sy * reach,
                               fill=color, width=2)
        distance = float(marker.data.get("distanceLs") or 0.0) if marker.kind != "station" else 0.0
        if distance > 0:
            canvas.create_text(x, y + reach + 7.0, text=_light_seconds(distance),
                               fill=color, font=("Consolas", 8), anchor="n")

    def _register(self, marker: MapMarker):
        self.markers.append(marker)

    # ------------------------------ панели -------------------------------
    def subject(self) -> Optional[MapMarker]:
        """Что показывать в карточке: наведение важнее выбора."""
        if self.hover_key:
            for marker in self.markers:
                if marker.key == self.hover_key:
                    return marker
        if self.selected:
            for marker in self.markers:
                if marker.key == self.selected:
                    return marker
        return None

    def card_rows(self, marker: MapMarker) -> Tuple[str, str, List[Tuple[str, str]], List[str]]:
        """(заголовок, подзаголовок, факты, теги) — как в подсказке на сайте."""
        if marker.kind == "station":
            structure = marker.data
            rows = [("Тип", str(structure.get("type") or "постройка")),
                    ("Тело", str(structure.get("body") or "—")),
                    ("Завезено", f"{int(round(float(structure.get('progress') or 0.0)))}%")]
            if float(structure.get("requiredTons") or 0.0) > 0:
                rows.append(("Осталось", _tons(structure.get("remainingTons"))))
            tags = ["готово" if structure.get("complete") else "стройка"]
            return marker.label, "стройка" if not structure.get("complete") else "объект", rows, tags
        if marker.kind == "player":
            return "Вы здесь", marker.caption, [], []
        body = marker.data
        kind = {"star": "звезда", "moon": "луна"}.get(str(body.get("kind")), "планета")
        rows: List[Tuple[str, str]] = []
        if body.get("cls"):
            rows.append(("Класс", str(body["cls"])))
        if body.get("star") and body.get("star") != body.get("name"):
            rows.append(("Звезда", str(body["star"])))
        if float(body.get("distanceLs") or 0.0) > 0:
            rows.append(("От входа", _light_seconds(body.get("distanceLs"))))
        if float(body.get("orbitLs") or 0.0) > 0 and body.get("kind") != "star":
            rows.append(("Полуось", _light_seconds(body.get("orbitLs"))))
        if float(body.get("radiusM") or 0.0) > 0:
            rows.append(("Радиус", _radius_km(body.get("radiusM"))))
        if float(body.get("gravity") or 0.0) > 0:
            rows.append(("Гравитация", f"{_number(body.get('gravity'), 2)} g"))
        if float(body.get("tempK") or 0.0) > 0:
            rows.append(("Температура", f"{_number(body.get('tempK'), 0)} K"))
        if body.get("atmosphere"):
            rows.append(("Атмосфера", str(body["atmosphere"])))
        if body.get("volcanism"):
            rows.append(("Вулканизм", str(body["volcanism"])))
        band = body.get("habitableBand")
        if band == "habitable":
            rows.append(("Зона", "в обитаемой зоне ★"))
        elif band == "inner":
            rows.append(("Зона", "ближе обитаемой зоны"))
        elif band == "outer":
            rows.append(("Зона", "дальше обитаемой зоны"))
        tags: List[str] = []
        if body.get("landable"):
            tags.append("посадка")
        if int(body.get("bioSignals") or 0) > 0:
            tags.append(f"сигналов: {int(body['bioSignals'])}")
        if body.get("rings"):
            tags.append(f"колец: {len(body['rings'])}")
        if not body.get("scanned", True):
            tags.append("нет подробного скана")
        for name, value in (("первооткрыватель", body.get("firstDiscoveredBy")),
                            ("первый шаг", body.get("firstFootfallBy"))):
            if value:
                tags.append(f"{name}: {value}")
        return str(body.get("name") or marker.label), kind, rows, tags

    def hint_text(self, marker: Optional[MapMarker]) -> str:
        if marker is None:
            return ("ЛКМ — выбрать · перетаскивание — поворот камеры · колесо — уровень · "
                    "двойной клик — к телу · 1/2/3 — вид · P — движение")
        title, subtitle, rows, tags = self.card_rows(marker)
        parts = [title, subtitle]
        parts.extend(f"{key}: {value}" for key, value in rows[:3])
        if tags:
            parts.append(", ".join(tags))
        return " · ".join(part for part in parts if part)

    def _panel(self, width: int, height: int):
        """Фон HUD-панелей: рисуется первым, поверх — текст."""
        canvas = self.canvas
        canvas.create_rectangle(10, 10, 250, 92, fill=PANEL_BG, outline=PANEL_LINE, width=1)
        canvas.create_line(10, 30, 250, 30, fill=PANEL_LINE, width=1)

    def _draw_hud(self, canvas: Any, width: int, height: int):
        """Сводка системы слева, карточка объекта справа, подсказка снизу."""
        summary = self.payload.get("summary") or {}
        system = str(self.payload.get("system") or "Система")
        self._panel(width, height)
        canvas.create_text(18, 20, text=system, fill=ORANGE_COLOR,
                           font=("Consolas", 10, "bold"), anchor="w")
        sites = len(self.payload.get("structures") or [])
        rows = [
            f"Звёзд: {summary.get('stars', 0)} · планет: {summary.get('planets', 0)}"
            f" · лун: {summary.get('moons', 0)}",
            f"Строек: {summary.get('activeSites', 0)} активн. из {sites}",
            f"Био: тел {summary.get('bioBodies', 0)} · сигналов {summary.get('bioSignals', 0)}",
            f"Вид: {self.view_label()} · {self.zoom_label()}",
        ]
        if self.motion:
            rows.append(f"Время: {'+' if self.motion_offset_days >= 0 else '−'}"
                        f"{abs(self.motion_offset_days):,.1f} сут".replace(",", " "))
        for index, row in enumerate(rows):
            canvas.create_text(18, 42 + index * 15, text=row, fill=TEXT_COLOR if index < 2 else MUTED_COLOR,
                               font=("Consolas", 8), anchor="w")

        marker = self.subject()
        if marker is not None:
            self._draw_card(canvas, marker, width)

        self._draw_legend(canvas, height)
        hint = self.hint_text(marker)
        canvas.create_text(width / 2.0, height - 14.0, text=hint, fill=MUTED_COLOR,
                           font=("Segoe UI", 8), anchor="center")

    def _draw_card(self, canvas: Any, marker: MapMarker, width: int):
        title, subtitle, rows, tags = self.card_rows(marker)
        structures = ([marker.data] if marker.kind == "station" else
                      [self._structure_by_id[str(identifier)]
                       for identifier in (marker.data.get("structures") or [])
                       if str(identifier) in self._structure_by_id])
        card_width = 254.0
        card_height = 58.0 + 14.0 * len(rows) + (16.0 if tags else 0.0) + 26.0 * len(structures)
        x = max(266.0, width - card_width - 12.0)
        y = 10.0
        canvas.create_rectangle(x, y, x + card_width, y + card_height,
                                fill=PANEL_BG,
                                outline=ORANGE_COLOR if marker.selected else PANEL_LINE, width=1)
        canvas.create_line(x, y + 26.0, x + card_width, y + 26.0, fill=PANEL_LINE, width=1)
        canvas.create_text(x + 8.0, y + 13.0, text=title[:38], fill=ORANGE_COLOR,
                           font=("Consolas", 9, "bold"), anchor="w")
        canvas.create_text(x + 8.0, y + 36.0, text=subtitle, fill=MUTED_COLOR,
                           font=("Consolas", 8), anchor="w")
        cursor = y + 50.0
        for key, value in rows:
            canvas.create_text(x + 8.0, cursor, text=str(key)[:16], fill=MUTED_COLOR,
                               font=("Consolas", 8), anchor="w")
            canvas.create_text(x + card_width - 8.0, cursor, text=str(value)[:26], fill=TEXT_COLOR,
                               font=("Consolas", 8), anchor="e")
            cursor += 14.0
        if tags:
            canvas.create_text(x + 8.0, cursor, text=" · ".join(tags)[:52], fill=CYAN_COLOR,
                               font=("Consolas", 8), anchor="w")
            cursor += 16.0
        for structure in structures:
            progress = clamp(float(structure.get("progress") or 0.0), 0.0, 100.0)
            color = structure_color(structure)
            bar_width = card_width - 16.0
            canvas.create_text(x + 8.0, cursor + 6.0, text=str(structure.get("name") or "")[:30],
                               fill=TEXT_COLOR, font=("Consolas", 8), anchor="w")
            canvas.create_text(x + 8.0 + bar_width, cursor + 6.0,
                               text="готово" if structure.get("complete") else f"{int(round(progress))}%",
                               fill=color, font=("Consolas", 8, "bold"), anchor="e")
            canvas.create_rectangle(x + 8.0, cursor + 12.0, x + 8.0 + bar_width, cursor + 18.0,
                                    fill="#16202e", outline=PANEL_LINE, width=1)
            if progress > 0:
                canvas.create_rectangle(x + 8.0, cursor + 12.0,
                                        x + 8.0 + bar_width * progress / 100.0, cursor + 18.0,
                                        fill=color, outline="")
            cursor += 26.0

    def _draw_legend(self, canvas: Any, height: int):
        """Легенда: что означает полоса, ромб и перекрестие на сцене."""
        items = [
            (ZONE_COLOR, "обитаемая зона"),
            (ORANGE_COLOR, "стройка: дуга — процент завезённого"),
            (CYAN_COLOR, "вы здесь"),
            (orbit_color_for(0), "орбиты: у каждой звезды свой оттенок"),
        ]
        y = height - 74.0
        for index, (color, text) in enumerate(items):
            canvas.create_rectangle(14, y + index * 15.0, 26, y + 6.0 + index * 15.0,
                                    fill=color, outline="")
            canvas.create_text(32, y + 3.0 + index * 15.0, text=text, fill=MUTED_COLOR,
                               font=("Segoe UI", 8), anchor="w")

    # ------------------------------- мышь --------------------------------
    def marker_at(self, x: float, y: float) -> Optional[MapMarker]:
        """Объект под курсором: сначала по расстоянию, потом по типу."""
        priority = {"station": 0, "player": 1, "body": 2, "star": 3}
        best: Optional[MapMarker] = None
        best_key: Optional[Tuple[float, int, float]] = None
        for marker in self.markers:
            reach = max(self.PICK_MIN_PX, float(marker.radius) + 5.0)
            distance = math.hypot(float(marker.x) - float(x), float(marker.y) - float(y))
            if distance > reach:
                continue
            key = (round(distance / 2.0), priority.get(marker.kind, 9), distance)
            if best_key is None or key < best_key:
                best_key, best = key, marker
        return best

    def on_motion(self, x: float, y: float) -> Optional[MapMarker]:
        """Курсор двинулся: запомнить наведение для подсказки и карточки."""
        self._hover_px = (float(x), float(y))
        marker = self.marker_at(x, y)
        key = marker.key if marker is not None else ""
        changed = key != self.hover_key
        self.hover_key = key
        if self.on_hint is not None and changed:
            self.on_hint(self.hint_text(marker))
        return marker

    def on_leave(self):
        self._hover_px = None
        self.hover_key = ""

    def on_click(self, x: float, y: float) -> Optional[MapMarker]:
        marker = self.marker_at(x, y)
        if marker is None or marker.kind == "player":
            return marker
        self.selected = marker.key
        if self.on_select is not None:
            self.on_select(marker.key)
        return marker

    def pointer_px(self) -> Optional[Tuple[float, float]]:
        return self._hover_px
