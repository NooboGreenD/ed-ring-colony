"""Мониторы: список экранов и перенос окна с одного экрана на другой.

Зачем отдельный модуль
----------------------

Блок HUD можно отвязать от игры и вынести на другой монитор (см.
`OverlayManager.move_block_to_monitor`). Для этого нужно знать, какие экраны
вообще есть, на каком из них сейчас стоит окно и куда его поставить на новом
экране, чтобы оно не уехало за край.

Геометрия здесь — чистые функции без Tk и без Win32: их легко проверить
тестами на любой машине. Список мониторов на Windows берётся через
`EnumDisplayMonitors`; на остальных платформах `list_monitors()` честно
возвращает пустой список, и вызывающий код подставляет один экран размером
с `winfo_screenwidth()` x `winfo_screenheight()`.

Прямоугольники:

* `Rect` — (left, top, right, bottom), как в Win32 (`RECT`);
* `Area` — (x, y, width, height), как в раскладке оверлея
  (`compute_anchored_position`, `OverlayManager.overlay_area`).
"""

import sys
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Tuple
from i18n import tr

IS_WINDOWS = sys.platform == "win32"

Rect = Tuple[int, int, int, int]
Area = Tuple[int, int, int, int]

#: Сколько пикселей шапки блока должно оставаться на экране, чтобы за неё
#: можно было ухватиться мышью. Меньше — блок считаем потерянным за краем.
MIN_VISIBLE_W = 60
MIN_VISIBLE_H = 20


@dataclass(frozen=True)
class MonitorInfo:
    """Один экран: номер для UI, рабочая область и полный прямоугольник."""

    index: int
    #: Рабочая область без панели задач: (left, top, right, bottom).
    work: Rect
    #: Весь экран: (left, top, right, bottom).
    bounds: Rect
    primary: bool = False
    name: str = ""

    @property
    def work_area(self) -> Area:
        left, top, right, bottom = self.work
        return int(left), int(top), max(1, int(right - left)), max(1, int(bottom - top))

    @property
    def size(self) -> Tuple[int, int]:
        left, top, right, bottom = self.bounds
        return max(0, int(right - left)), max(0, int(bottom - top))

    def label(self) -> str:
        """«Экран 2 · 2560×1440» (+ «основной» у главного монитора)."""
        width, height = self.size
        if self.primary:
            return tr("Экран {index} · {width}×{height} · основной",
                      index=self.index, width=width, height=height)
        return tr("Экран {index} · {width}×{height}",
                  index=self.index, width=width, height=height)


def order_monitors(raw: Iterable[Tuple[Rect, Rect, bool, str]]) -> List[MonitorInfo]:
    """Пронумеровать экраны: основной — первый, остальные слева направо.

    `raw` — (work, bounds, primary, name) в любом порядке. Так номер экрана
    стабилен между запусками и совпадает с тем, что пользователь видит:
    «Экран 1» — основной, дальше по расположению.
    """
    items = []
    for work, bounds, primary, name in raw:
        try:
            work = tuple(int(v) for v in work)
            bounds = tuple(int(v) for v in bounds)
        except (TypeError, ValueError):
            continue
        if len(work) != 4 or len(bounds) != 4:
            continue
        if bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
            continue
        if work[2] <= work[0] or work[3] <= work[1]:
            work = bounds
        items.append((work, bounds, bool(primary), str(name or "")))
    items.sort(key=lambda item: (not item[2], item[1][0], item[1][1]))
    return [
        MonitorInfo(index=position, work=work, bounds=bounds, primary=primary, name=name)
        for position, (work, bounds, primary, name) in enumerate(items, start=1)
    ]


def _intersection(area: Area, rect: Rect) -> Tuple[int, int]:
    """Ширина и высота пересечения области (x, y, w, h) с прямоугольником."""
    x, y, w, h = area
    left, top, right, bottom = rect
    width = min(x + w, right) - max(x, left)
    height = min(y + h, bottom) - max(y, top)
    return max(0, width), max(0, height)


def monitor_for_area(area: Area, monitors: Sequence[MonitorInfo]) -> Optional[MonitorInfo]:
    """Экран, на котором стоит окно: с наибольшей площадью пересечения.

    Если окно не задевает ни один экран (уехало за край после смены
    мониторов), берём ближайший по расстоянию между центрами.
    """
    if not monitors:
        return None
    best = None
    best_overlap = 0
    for monitor in monitors:
        width, height = _intersection(area, monitor.bounds)
        overlap = width * height
        if overlap > best_overlap:
            best, best_overlap = monitor, overlap
    if best is not None:
        return best
    x, y, w, h = area
    cx, cy = x + w / 2.0, y + h / 2.0

    def distance(monitor: MonitorInfo) -> float:
        left, top, right, bottom = monitor.bounds
        mx = min(max(cx, left), right)
        my = min(max(cy, top), bottom)
        return (mx - cx) ** 2 + (my - cy) ** 2

    return min(monitors, key=distance)


def header_visible(area: Area, monitors: Sequence[MonitorInfo], header: int = 30) -> bool:
    """Видна ли шапка окна хоть на одном экране настолько, чтобы её схватить."""
    x, y, w, _h = area
    strip = (x, y, w, max(1, min(header, area[3])))
    for monitor in monitors:
        width, height = _intersection(strip, monitor.bounds)
        if width >= min(MIN_VISIBLE_W, w) and height >= min(MIN_VISIBLE_H, strip[3]):
            return True
    return False


def fit_into_area(x: int, y: int, w: int, h: int, area: Area) -> Tuple[int, int]:
    """Сдвинуть окно внутрь области; не влезает — прижать к левому/верхнему краю."""
    ax, ay, aw, ah = area
    x = max(ax, min(int(x), ax + max(0, aw - int(w))))
    y = max(ay, min(int(y), ay + max(0, ah - int(h))))
    return int(x), int(y)


def translate_between_areas(x: int, y: int, w: int, h: int,
                            source: Optional[Area], target: Area) -> Tuple[int, int]:
    """Где поставить окно на другом экране, сохранив его место «по смыслу».

    Положение пересчитывается пропорционально свободному месту: блок у правого
    края первого экрана окажется у правого края второго, блок по центру — по
    центру, даже если у экранов разное разрешение. Без исходного экрана
    (окно было за краем) ставим в левый верхний угол цели.
    """
    tx, ty, tw, th = target
    if not source:
        return fit_into_area(tx + 24, ty + 24, w, h, target)
    sx, sy, sw, sh = source

    def remap(pos: int, size: int, origin: int, span: int,
              new_origin: int, new_span: int) -> float:
        free = span - size
        new_free = max(0, new_span - size)
        if free <= 0:
            return new_origin
        ratio = min(1.0, max(0.0, (pos - origin) / float(free)))
        return new_origin + ratio * new_free

    nx = remap(int(x), int(w), sx, sw, tx, tw)
    ny = remap(int(y), int(h), sy, sh, ty, th)
    return fit_into_area(int(round(nx)), int(round(ny)), w, h, target)


# ============================================================
#  Win32: список мониторов
# ============================================================
def list_monitors() -> List[MonitorInfo]:
    """Все подключённые экраны (Windows). Вне Windows — пустой список.

    Вызывается из потока Tk при открытии меню и раскладке блоков — это
    дёшево (`EnumDisplayMonitors` не шлёт сообщений окнам), но результат всё
    равно кэширует `OverlayManager.monitors()`.
    """
    if not IS_WINDOWS:
        return []
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)

        class MONITORINFOEXW(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("rcMonitor", wintypes.RECT),
                ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD),
                ("szDevice", wintypes.WCHAR * 32),
            ]

        MONITORINFOF_PRIMARY = 0x00000001
        enum_proc_type = ctypes.WINFUNCTYPE(
            wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC,
            ctypes.POINTER(wintypes.RECT), wintypes.LPARAM,
        )
        user32.EnumDisplayMonitors.argtypes = [
            wintypes.HDC, ctypes.POINTER(wintypes.RECT), enum_proc_type, wintypes.LPARAM,
        ]
        user32.EnumDisplayMonitors.restype = wintypes.BOOL
        user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFOEXW)]
        user32.GetMonitorInfoW.restype = wintypes.BOOL

        found = []

        def on_monitor(hmonitor, _hdc, _rect, _lparam):
            info = MONITORINFOEXW()
            info.cbSize = ctypes.sizeof(MONITORINFOEXW)
            if user32.GetMonitorInfoW(hmonitor, ctypes.byref(info)):
                bounds = info.rcMonitor
                work = info.rcWork
                found.append((
                    (int(work.left), int(work.top), int(work.right), int(work.bottom)),
                    (int(bounds.left), int(bounds.top), int(bounds.right), int(bounds.bottom)),
                    bool(info.dwFlags & MONITORINFOF_PRIMARY),
                    str(info.szDevice or ""),
                ))
            return True

        callback = enum_proc_type(on_monitor)
        user32.EnumDisplayMonitors(None, None, callback, 0)
        return order_monitors(found)
    except Exception:
        return []
