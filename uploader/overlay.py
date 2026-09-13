"""Оверлейные окна для Colonial Helper — HUD-стиль ED Ring Colony."""
import tkinter as tk
from tkinter import END
from typing import Dict, Any, Optional, Callable, Tuple
import threading
import time
from pathlib import Path
from collections import deque

from ship_tracker import decode_status_flags
from game_monitor import GameMonitor, GameState
from hotkeys import HotkeyManager


# ============================================================
#  Win32 API helpers для привязки оверлея к окну игры
# ============================================================
def _get_ed_hwnd() -> Optional[int]:
    """Найти HWND окна Elite Dangerous."""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        EnumWindows = user32.EnumWindows
        EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_int, ctypes.POINTER(ctypes.c_int))
        GetWindowTextW = user32.GetWindowTextW
        GetWindowTextLengthW = user32.GetWindowTextLengthW
        IsWindowVisible = user32.IsWindowVisible

        ed_hwnd = []

        def foreach_window(hwnd, _):
            if IsWindowVisible(hwnd):
                length = GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    GetWindowTextW(hwnd, buf, length + 1)
                    title = buf.value
                    if "Elite - Dangerous" in title or "Elite Dangerous" in title:
                        ed_hwnd.append(hwnd)
                        return False
            return True

        EnumWindows(EnumWindowsProc(foreach_window), 0)
        return ed_hwnd[0] if ed_hwnd else None
    except Exception:
        return None


def _is_ed_foreground() -> bool:
    """Проверить, активно ли сейчас окно Elite Dangerous."""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        fg = user32.GetForegroundWindow()
        if not fg:
            # GetForegroundWindow вернул 0 — возможно, игра запущена от админа,
            # а uploader — нет. Считаем ED активной, чтобы оверлей не пропал.
            return True
        ed = _get_ed_hwnd()
        if ed and fg == ed:
            return True
        # Fallback: проверяем по заголовку foreground окна
        length = user32.GetWindowTextLengthW(fg)
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(fg, buf, length + 1)
            title = buf.value
            return "Elite" in title and "Dangerous" in title
    except Exception:
        pass
    return True  # Fallback: считаем активной, чтобы оверлей не пропал


def _set_window_topmost(hwnd: int, topmost: bool):
    """Установить/снять WS_EX_TOPMOST для окна через Win32 API.
    
    ПРИМЕЧАНИЕ: Для overrideredirect окон tkinter Win32 API SetWindowPos
    может полностью сломать Z-order окна. Используем только tkinter.
    """
    pass


def _hwnd_of(window) -> Optional[int]:
    """HWND окна Tk (frame id -> parent window handle)."""
    try:
        import ctypes
        return ctypes.windll.user32.GetParent(window.winfo_id())
    except Exception:
        return None


def _set_click_through(hwnd: int, enabled: bool) -> bool:
    """Сделать окно прозрачным для мыши (WS_EX_TRANSPARENT | WS_EX_LAYERED).

    Нужен именно Win32: tkinter не умеет «клик насквозь». Окно остаётся
    видимым и поверх игры, но все щелчки уходят в игру.
    """
    if not hwnd:
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        GWL_EXSTYLE = -20
        WS_EX_TRANSPARENT = 0x00000020
        WS_EX_LAYERED = 0x00080000
        style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        if enabled:
            style |= WS_EX_TRANSPARENT | WS_EX_LAYERED
        else:
            style &= ~WS_EX_TRANSPARENT
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style)
        return True
    except Exception:
        return False


# ============================================================
#  Цветовая схема в стиле ED Ring Colony сайта
# ============================================================
COLOR_BG = "#0d1117"
COLOR_PANEL = "#161b22"
COLOR_PANEL_HOVER = "#1c2128"
COLOR_TEXT = "#e6edf3"
COLOR_TEXT_MUTED = "#8b949e"
COLOR_ACCENT = "#e67e22"
COLOR_ACCENT_HOVER = "#f39c12"
COLOR_CYAN = "#58a6ff"
COLOR_GREEN = "#238636"
COLOR_GREEN_TEXT = "#3fb950"
COLOR_RED = "#da3633"
COLOR_RED_TEXT = "#f85149"
COLOR_YELLOW = "#d29922"
COLOR_BORDER = "#30363d"
COLOR_BORDER_ACTIVE = "#58a6ff"
COLOR_LINE = "#21262d"


# ============================================================
#  Утилиты стиля
# ============================================================
def _make_separator(parent, color=COLOR_LINE) -> tk.Frame:
    sep = tk.Frame(parent, bg=color, height=1)
    return sep


# ============================================================
#  Настройки блоков: размеры, шрифт, прозрачность, поведение
# ============================================================
BLOCK_LABELS = {
    "route": "ROUTE — маршрут",
    "status": "STATUS — статус",
    "ship": "SHIP — корабль",
    "cargo": "CARGO — трюм",
    "session": "SESSION — сессия",
    "events": "EVENTS — события",
    "exobio": "EXOBIO — экзобиология",
}

#: Размеры по умолчанию (используются и «Сбросить позиции», и пресетами).
DEFAULT_BLOCK_POSITIONS = {
    "route": (50, 50, 280, 160),
    "status": (50, 220, 280, 220),
    "ship": (50, 450, 360, 420),
    "cargo": (400, 450, 300, 340),
    "session": (400, 50, 320, 300),
    "events": (730, 50, 320, 260),
    "exobio": (1060, 50, 330, 360),
}

#: Пресеты размера: множитель к стандартному размеру блока.
SIZE_PRESETS = (("XS", 0.75), ("S", 0.85), ("M", 1.0), ("L", 1.25), ("XL", 1.5))
SIZE_PRESET_LABELS = {
    "XS": "XS — 75%",
    "S": "S — 85%",
    "M": "M — 100%",
    "L": "L — 125%",
    "XL": "XL — 150%",
}

#: Когда блок показывать самому (поверх ручного включения).
AUTO_RULES = (
    "always", "never", "game_focused", "docked", "in_space",
    "in_srv", "on_foot", "has_cargo", "has_bio", "has_route",
)
AUTO_RULE_LABELS = {
    "always": "всегда",
    "never": "никогда (только вручную)",
    "game_focused": "когда игра в фокусе",
    "docked": "на станции / у дока",
    "in_space": "в полёте (не на станции)",
    "in_srv": "в SRV",
    "on_foot": "пешком (OnFoot)",
    "has_cargo": "когда есть груз",
    "has_bio": "когда есть биосигналы",
    "has_route": "когда задан маршрут",
}

#: Через сколько секунд без событий прятать HUD; 0 — не прятать.
IDLE_TIMEOUTS = (0, 30, 60, 120, 300, 600)


def preset_size(key: str, preset: str) -> Optional[Tuple[int, int]]:
    """Размер блока для пресета (M — стандартный)."""
    base = DEFAULT_BLOCK_POSITIONS.get(key)
    if not base:
        return None
    factor = dict(SIZE_PRESETS).get(preset)
    if not factor:
        return None
    _x, _y, width, height = base
    return int(round(width * factor)), int(round(height * factor))


def resolve_block_alpha(settings: dict, key: str) -> float:
    """Прозрачность блока: своя, если задана, иначе общая."""
    value = settings.get(f"{key}_alpha")
    if value is None:
        return float(settings.get("alpha", 0.90) or 0.90)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(settings.get("alpha", 0.90) or 0.90)


def resolve_block_font_size(settings: dict, key: str) -> int:
    """Размер шрифта блока: свой, если задан, иначе общий."""
    value = settings.get(f"{key}_font_size")
    if value in (None, ""):
        return int(settings.get("font_size", 10) or 10)
    try:
        return max(6, min(28, int(value)))
    except (TypeError, ValueError):
        return int(settings.get("font_size", 10) or 10)


def block_click_through(settings: dict, key: str) -> bool:
    """Клик-сквозь: своё значение, если задано, иначе общее."""
    value = settings.get(f"{key}_click_through")
    if value is None:
        return bool(settings.get("click_through", False))
    return bool(value)


def auto_rule_matches(rule: str, context: dict) -> bool:
    """Подходит ли текущая ситуация под правило автопоказа.

    Чистая функция: контекст собирает менеджер из состояния игры, корабля и
    данных маршрута, а здесь решается только «показывать или нет».
    """
    rule = rule or "always"
    if rule == "always":
        return True
    if rule == "never":
        return False
    flags = set(context.get("flags") or ())
    game_running = bool(context.get("game_running"))
    if rule == "game_focused":
        return game_running and bool(context.get("game_focused"))
    if rule == "docked":
        return "Docked" in flags
    if rule == "in_space":
        return game_running and not ({"Docked", "Landed", "SRV", "OnFoot"} & flags)
    if rule == "in_srv":
        return "SRV" in flags
    if rule == "on_foot":
        return "OnFoot" in flags
    if rule == "has_cargo":
        return float(context.get("cargo_count") or 0) > 0
    if rule == "has_bio":
        return int(context.get("bio_signals") or 0) > 0
    if rule == "has_route":
        return int(context.get("route_total") or 0) > 0
    return True


# ============================================================
#  Якоря и раскладка
# ============================================================
# Порядок — как в UI: сверху вниз, слева направо.
ANCHOR_KEYS = (
    "custom",
    "top_left", "top_center", "top_right",
    "mid_left", "mid_center", "mid_right",
    "bottom_left", "bottom_center", "bottom_right",
)

ANCHOR_LABELS = {
    "custom": "Свободная",
    "top_left": "↖ Верх лево",
    "top_center": "↑ Верх центр",
    "top_right": "↗ Верх право",
    "mid_left": "← Середина лево",
    "mid_center": "• Центр",
    "mid_right": "→ Середина право",
    "bottom_left": "↙ Низ лево",
    "bottom_center": "↓ Низ центр",
    "bottom_right": "↘ Низ право",
}


def compute_anchored_position(
    anchor: str,
    area_x: int,
    area_y: int,
    area_w: int,
    area_h: int,
    win_w: int,
    win_h: int,
    margin: int = 24,
) -> Optional[Tuple[int, int]]:
    """Куда поставить окно размера (win_w, win_h) внутри области по якорю.

    Чистая функция (без Tk) — её удобно тестировать и переиспользовать:
    область может быть как весь экран, так и прямоугольник окна игры.

    Возвращает None для `custom` — значит, позицией управляет пользователь.
    Координаты всегда зажимаются внутрь области, чтобы блок не оказался за
    её пределами (актуально для второго монитора и окон игры в окне).
    """
    if not anchor or anchor == "custom":
        return None

    left = area_x + margin
    top = area_y + margin
    right = area_x + area_w - win_w - margin
    bottom = area_y + area_h - win_h - margin
    center_x = area_x + (area_w - win_w) // 2
    center_y = area_y + (area_h - win_h) // 2

    position = {
        "top_left": (left, top),
        "top_center": (center_x, top),
        "top_right": (right, top),
        "mid_left": (left, center_y),
        "mid_center": (center_x, center_y),
        "mid_right": (right, center_y),
        "bottom_left": (left, bottom),
        "bottom_center": (center_x, bottom),
        "bottom_right": (right, bottom),
    }.get(anchor)

    if position is None:
        return None

    x, y = position
    # Зажимаем внутрь области (с запасом, чтобы окно не «убежало» полностью).
    x = max(area_x, min(x, area_x + max(0, area_w - win_w)))
    y = max(area_y, min(y, area_y + max(0, area_h - win_h)))
    return int(x), int(y)


def capture_layout_snapshot(settings: dict, windows: dict, blocks: tuple) -> dict:
    """Снимок текущей раскладки для профиля (чистая функция, без Tk).

    `windows`: {key: overlay|None}, `blocks`: ключи блоков.
    """
    snapshot: Dict[str, Any] = {}
    for key in blocks:
        overlay = windows.get(key)
        entry = {
            "x": settings.get(f"{key}_x"),
            "y": settings.get(f"{key}_y"),
            "width": settings.get(f"{key}_width"),
            "height": settings.get(f"{key}_height"),
            "anchor": settings.get(f"{key}_anchor", "custom"),
            "visible": settings.get(f"show_{key}", True),
            # Настройки вида и поведения блока — тоже часть раскладки:
            # «Хаул» и «Эксобиология» отличаются не только позициями.
            "alpha": settings.get(f"{key}_alpha"),
            "font_size": settings.get(f"{key}_font_size"),
            "locked": settings.get(f"{key}_locked", False),
            "click_through": settings.get(f"{key}_click_through"),
            "auto_rule": settings.get(f"{key}_auto_rule", "always"),
            "hotkey": settings.get(f"{key}_hotkey", ""),
        }
        if overlay is not None:
            # Живое окно: его фактическая геометрия актуальнее сохранённой.
            try:
                entry["x"] = overlay.window.winfo_x()
                entry["y"] = overlay.window.winfo_y()
                entry["width"] = overlay.window.winfo_width()
                entry["height"] = overlay.window.winfo_height()
                entry["anchor"] = getattr(overlay, "_anchor", entry["anchor"])
            except Exception:
                pass
        snapshot[key] = entry
    # Общие настройки вида и поведения тоже часть раскладки.
    for key in ("alpha", "font_family", "font_size", "layout_margin",
                "click_through", "idle_timeout", "auto_rules_enabled",
                "hide_when_game_off", "attach_to_game"):
        if key in settings:
            snapshot[key] = settings[key]
    return snapshot


def apply_layout_snapshot(settings: dict, snapshot: dict, blocks: tuple) -> None:
    """Записать снимок раскладки в настройки (чистая функция, без Tk)."""
    for key in blocks:
        entry = snapshot.get(key)
        if not isinstance(entry, dict):
            continue
        for suffix in (
            "x", "y", "width", "height", "anchor",
            # None означает «как везде» — важно уметь вернуть общее значение,
            # поэтому сбрасываем ключ, а не пишем None.
            "alpha", "font_size", "click_through",
        ):
            if entry.get(suffix) is not None:
                settings[f"{key}_{suffix}"] = entry[suffix]
            elif f"{key}_{suffix}" in settings:
                settings.pop(f"{key}_{suffix}", None)
        for suffix in ("locked", "auto_rule", "hotkey"):
            if suffix in entry:
                settings[f"{key}_{suffix}"] = entry[suffix]
        if entry.get("visible") is not None:
            settings[f"show_{key}"] = bool(entry["visible"])
    for key in ("alpha", "font_family", "font_size", "layout_margin",
                "click_through", "idle_timeout", "auto_rules_enabled",
                "hide_when_game_off", "attach_to_game"):
        if key in snapshot and snapshot[key] is not None:
            settings[key] = snapshot[key]


# ============================================================
#  Базовое оверлейное окно с управлением
# ============================================================
class OverlayWindow:
    """Базовое оверлейное окно: без рамки, всегда сверху, перетаскиваемое,
    с возможностью изменения размера, фиксации и привязки к экрану."""

    # Оставлено для совместимости со старыми конфигурациями: раньше позиции
    # якорей были захардкожены под размер 320x300. Теперь положение считает
    # `compute_anchored_position()` по реальному размеру окна и отступу.
    ANCHOR_POSITIONS = {}

    def __init__(
        self,
        master: tk.Tk,
        title: str,
        x: int,
        y: int,
        width: int,
        height: int,
        settings: Dict[str, Any],
        overlay_key: str,
    ):
        self.master = master
        self.settings = settings
        self.overlay_key = overlay_key
        self._alpha = settings.get("alpha", 0.90)
        self._drag_data = {"x": 0, "y": 0}
        self._resize_data = {"x": 0, "y": 0, "w": 0, "h": 0}
        self._locked = settings.get(f"{overlay_key}_locked", False)
        self._anchor = settings.get(f"{overlay_key}_anchor", "custom")
        self._min_width = 200
        self._min_height = 100
        # Клик-сквозь: окно видно, но мышь работает в игре. Включается через
        # Win32, поэтому применяется после того, как окно реально создано.
        self._click_through = block_click_through(settings, overlay_key)
        # Шрифты виджетов запоминаем после сборки contents (см. _register_fonts):
        # живая смена размера шрифта не должна пересоздавать окно.
        self._font_specs: dict = {}
        # Размер, под который собрано содержимое: от него считаем масштаб при
        # живой смене шрифта (у заголовка, строк и значений разные размеры).
        self._font_base = int(settings.get("font_size", 10) or 10)
        self._applied_font = (settings.get("font_family", "Consolas"),
                              resolve_block_font_size(settings, overlay_key))

        self.window = tk.Toplevel(master)
        self.window.title(title)
        self.window.geometry(f"{width}x{height}+{x}+{y}")
        self.window.overrideredirect(True)
        # Всегда topmost — базовое поведение для оверлея
        self.window.attributes("-topmost", True)
        self.window.attributes("-alpha", self._alpha)
        self.window.configure(bg=COLOR_BG)
        self._hwnd: Optional[int] = None
        self._is_topmost = True

        # Главный контейнер с границей
        self.outer = tk.Frame(self.window, bg=COLOR_BORDER, bd=1)
        self.outer.pack(fill=tk.BOTH, expand=True)

        # Header
        self.header = tk.Frame(self.outer, bg=COLOR_BG, height=26)
        self.header.pack(fill=tk.X, padx=1, pady=(1, 0))
        self.header.pack_propagate(False)

        # Цветной индикатор слева
        self.header_indicator = tk.Frame(self.header, bg=COLOR_ACCENT, width=4)
        self.header_indicator.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 6))

        # Заголовок
        self.title_label = tk.Label(
            self.header,
            text=title,
            font=(settings.get("font_family", "Consolas"), 9, "bold"),
            fg=COLOR_ACCENT,
            bg=COLOR_BG,
        )
        self.title_label.pack(side=tk.LEFT, padx=(0, 4))

        # Кнопки управления
        self._build_control_buttons()

        # Drag area
        self.header.bind("<Button-1>", self._on_drag_start)
        self.header.bind("<B1-Motion>", self._on_drag_motion)
        self.title_label.bind("<Button-1>", self._on_drag_start)
        self.title_label.bind("<B1-Motion>", self._on_drag_motion)

        # Content
        self.content = tk.Frame(self.outer, bg=COLOR_PANEL)
        self.content.pack(fill=tk.BOTH, expand=True, padx=1, pady=1)

        # Resize handle
        self.resize_handle = tk.Frame(self.window, bg=COLOR_BORDER, width=12, height=12, cursor="size_nw_se")
        self.resize_handle.place(relx=1.0, rely=1.0, anchor="se")
        self.resize_handle.bind("<Button-1>", self._on_resize_start)
        self.resize_handle.bind("<B1-Motion>", self._on_resize_motion)

        self._on_move_callback: Optional[Callable] = None
        self._on_resize_callback: Optional[Callable] = None

        self._area_provider: Optional[Callable[[], Optional[Tuple[int, int, int, int]]]] = None
        if self._click_through:
            self.window.after_idle(self._sync_click_through)
        self._apply_anchor()

    # -- обход виджетов ----------------------------------------------------
    @staticmethod
    def _iter_widgets(widget):
        """Все виджеты поддерева (для живой смены шрифта)."""
        pending = [widget]
        while pending:
            current = pending.pop()
            yield current
            try:
                pending.extend(current.winfo_children())
            except Exception:
                pass

    @staticmethod
    def _parse_font(font) -> Optional[Tuple[str, int, tuple]]:
        """Разобрать шрифт Tk: кортеж (семейство, размер[, стили])."""
        if isinstance(font, str):
            return None
        try:
            values = tuple(font)
        except TypeError:
            return None
        if len(values) < 2:
            return None
        try:
            size = int(values[1])
        except (TypeError, ValueError):
            return None
        return str(values[0]), size, tuple(str(v) for v in values[2:])

    def _register_fonts(self):
        """Запомнить исходные шрифты виджетов.

        Вызывается после сборки содержимого: у заголовка, строк и значений
        разные размеры, и при смене размера шрифта все они должны сдвинуться
        пропорционально, а не сравниваться.
        """
        specs = {}
        for widget in self._iter_widgets(self.window):
            try:
                font = widget.cget("font")
            except Exception:
                continue
            parsed = self._parse_font(font)
            if parsed is None:
                continue
            _family, size, styles = parsed
            specs[widget] = (size, styles)
        self._font_specs = specs

    def apply_font(self, family: str, size: int):
        """Живая смена шрифта без пересоздания окна.

        Все виджеты масштабируются от исходных размеров: у блока может быть
        свой размер шрифта, а общий размер мог меняться уже не раз.
        """
        try:
            size = max(6, min(28, int(size)))
        except (TypeError, ValueError):
            return
        if not self._font_specs:
            self._register_fonts()
            self._font_base = max(1, size)
        base = self._font_base or 10
        factor = float(size) / float(base)
        for widget, (original, styles) in self._font_specs.items():
            try:
                new_size = max(6, min(40, int(round(original * factor))))
                widget.configure(font=(family, new_size, *styles))
            except Exception:
                pass
        self._applied_font = (family, size)

    def _sync_click_through(self):
        """Применить режим «клик насквозь» (после создания окна)."""
        hwnd = self._hwnd or _hwnd_of(self.window)
        if hwnd:
            self._hwnd = hwnd
        _set_click_through(hwnd, self._click_through)

    def set_click_through(self, enabled: bool, save_key: Optional[str] = None):
        """Включить/выключить клик-сквозь.

        `save_key` — ключ настройки: свой у блока (`{key}_click_through`)
        или общий (`click_through`). None — в настройки не пишем.
        """
        self._click_through = bool(enabled)
        if save_key:
            self.settings[save_key] = bool(enabled)
        try:
            self.through_btn.config(
                text=">" if self._click_through else "<",
                fg=COLOR_CYAN if self._click_through else COLOR_TEXT_MUTED,
            )
        except Exception:
            pass
        self.window.after_idle(self._sync_click_through)
        self._flash_indicator(COLOR_CYAN if enabled else COLOR_ACCENT)

    def _toggle_click_through(self):
        """Переключатель «клик-сквозь» из меню шапки."""
        self.set_click_through(not self._click_through,
                               f"{self.overlay_key}_click_through")

    def _build_control_buttons(self):
        btn_frame = tk.Frame(self.header, bg=COLOR_BG)
        btn_frame.pack(side=tk.RIGHT, padx=(0, 4))

        lock_text = "L" if self._locked else "U"
        self.lock_btn = tk.Label(
            btn_frame, text=lock_text,
            font=("Consolas", 8), fg=COLOR_TEXT_MUTED, bg=COLOR_BG,
            cursor="hand2", width=2
        )
        self.lock_btn.pack(side=tk.LEFT, padx=(0, 4))
        self.lock_btn.bind("<Button-1>", lambda e: self._toggle_lock())

        self.through_btn = tk.Label(
            btn_frame, text=">" if self._click_through else "<",
            font=("Consolas", 8), fg=COLOR_CYAN if self._click_through else COLOR_TEXT_MUTED,
            bg=COLOR_BG, cursor="hand2", width=2
        )
        self.through_btn.pack(side=tk.LEFT, padx=(0, 4))
        self.through_btn.bind("<Button-1>", lambda e: self.set_click_through(
            not self._click_through, f"{self.overlay_key}_click_through"))

        self.edit_btn = tk.Label(
            btn_frame, text="*",
            font=("Consolas", 10), fg=COLOR_TEXT_MUTED, bg=COLOR_BG,
            cursor="hand2", width=2
        )
        self.edit_btn.pack(side=tk.LEFT, padx=(0, 4))
        self.edit_btn.bind("<Button-1>", lambda e: self._show_edit_menu())

        self.drag_label = tk.Label(
            btn_frame, text="=",
            font=("Consolas", 10), fg=COLOR_TEXT_MUTED, bg=COLOR_BG,
            cursor="fleur" if not self._locked else "no",
            width=2
        )
        self.drag_label.pack(side=tk.LEFT)
        if not self._locked:
            self.drag_label.bind("<Button-1>", self._on_drag_start)
            self.drag_label.bind("<B1-Motion>", self._on_drag_motion)

    def set_locked(self, locked: bool):
        """Заблокировать/разблокировать позицию окна (без пересоздания)."""
        self._locked = bool(locked)
        self.settings[f"{self.overlay_key}_locked"] = self._locked
        try:
            self.lock_btn.config(text="L" if self._locked else "U")
            self.drag_label.config(cursor="no" if self._locked else "fleur")
        except Exception:
            pass
        if self._locked:
            self.drag_label.unbind("<Button-1>")
            self.drag_label.unbind("<B1-Motion>")
        else:
            self.drag_label.bind("<Button-1>", self._on_drag_start)
            self.drag_label.bind("<B1-Motion>", self._on_drag_motion)
        self._flash_indicator(COLOR_GREEN_TEXT if self._locked else COLOR_ACCENT)

    def _toggle_lock(self):
        self.set_locked(not self._locked)

    def _flash_indicator(self, color: str, duration_ms: int = 300):
        self.header_indicator.config(bg=color)
        self.window.after(duration_ms, lambda: self.header_indicator.config(bg=COLOR_ACCENT))

    def _show_edit_menu(self):
        menu = tk.Menu(self.window, tearoff=0, bg=COLOR_PANEL, fg=COLOR_TEXT,
                       activebackground=COLOR_PANEL_HOVER, activeforeground=COLOR_ACCENT,
                       borderwidth=1, relief="solid")

        anchor_menu = tk.Menu(menu, tearoff=0, bg=COLOR_PANEL, fg=COLOR_TEXT,
                              activebackground=COLOR_PANEL_HOVER, activeforeground=COLOR_ACCENT)
        for pos in ANCHOR_KEYS:
            label = ANCHOR_LABELS.get(pos, pos)
            anchor_menu.add_command(
                label=f"{'[x] ' if self._anchor == pos else '[ ] '}{label}",
                command=lambda p=pos: self._set_anchor(p)
            )
        menu.add_cascade(label="Anchor", menu=anchor_menu)
        menu.add_separator()
        menu.add_command(label=f"Width: {self.window.winfo_width()}px", state="disabled")
        menu.add_command(label=f"Height: {self.window.winfo_height()}px", state="disabled")
        menu.add_command(label="Reset size", command=self._reset_size)
        menu.add_command(
            label=f"{'[x] ' if self._click_through else '[ ] '}Клик-сквозь",
            command=self._toggle_click_through,
        )
        menu.add_separator()
        alpha_menu = tk.Menu(menu, tearoff=0, bg=COLOR_PANEL, fg=COLOR_TEXT,
                             activebackground=COLOR_PANEL_HOVER, activeforeground=COLOR_ACCENT)
        for a in [0.3, 0.5, 0.7, 0.85, 0.95, 1.0]:
            alpha_menu.add_command(
                label=f"{'[x] ' if abs(self._alpha - a) < 0.05 else '[ ] '}{int(a*100)}%",
                command=lambda v=a: self.set_alpha(v)
            )
        menu.add_cascade(label="Alpha", menu=alpha_menu)
        # Персональный размер шрифта: '' — как у всех блоков.
        font_menu = tk.Menu(menu, tearoff=0, bg=COLOR_PANEL, fg=COLOR_TEXT,
                            activebackground=COLOR_PANEL_HOVER, activeforeground=COLOR_ACCENT)
        own_font = self.settings.get(f"{self.overlay_key}_font_size")
        font_menu.add_command(
            label=f"{'[x] ' if own_font in (None, '') else '[ ] '}Как у всех ({int(self.settings.get('font_size', 10) or 10)})",
            command=lambda: self._set_own_font(None),
        )
        for value in (8, 9, 10, 11, 12, 14, 16, 18):
            font_menu.add_command(
                label=f"{'[x] ' if own_font == value else '[ ] '}{value}",
                command=lambda v=value: self._set_own_font(v),
            )
        menu.add_cascade(label="Font size", menu=font_menu)
        menu.post(self.edit_btn.winfo_rootx(), self.edit_btn.winfo_rooty() + 20)

    def _set_own_font(self, size: Optional[int]):
        """Свой размер шрифта блока (None — общий)."""
        if size is None:
            self.settings.pop(f"{self.overlay_key}_font_size", None)
        else:
            self.settings[f"{self.overlay_key}_font_size"] = int(size)
        self.apply_font(self.settings.get("font_family", "Consolas"),
                        int(self.settings.get(f"{self.overlay_key}_font_size",
                                              self.settings.get("font_size", 10)) or 10))

    def _set_anchor(self, position: str):
        self._anchor = position
        self.settings[f"{self.overlay_key}_anchor"] = position
        self._apply_anchor()
        self._flash_indicator(COLOR_CYAN)

    def set_position(self, x: int, y: int, save: bool = True):
        """Переместить окно в точку (x, y) — используется якорями и профилями."""
        self.window.geometry(f"+{int(x)}+{int(y)}")
        if save:
            self.settings[f"{self.overlay_key}_x"] = int(x)
            self.settings[f"{self.overlay_key}_y"] = int(y)
        if self._on_move_callback:
            self._on_move_callback(int(x), int(y))

    def set_geometry(self, x: int, y: int, width: int, height: int):
        self.window.geometry(f"{int(width)}x{int(height)}+{int(x)}+{int(y)}")
        self.settings[f"{self.overlay_key}_x"] = int(x)
        self.settings[f"{self.overlay_key}_y"] = int(y)
        self.settings[f"{self.overlay_key}_width"] = int(width)
        self.settings[f"{self.overlay_key}_height"] = int(height)
        if self._on_move_callback:
            self._on_move_callback(int(x), int(y))

    def size(self) -> Tuple[int, int]:
        """Фактический размер окна (с откатом к сохранённому, если Tk молчит)."""
        try:
            self.window.update_idletasks()
            w = self.window.winfo_width()
            h = self.window.winfo_height()
            if w > 1 and h > 1:
                return int(w), int(h)
        except Exception:
            pass
        return (
            int(self.settings.get(f"{self.overlay_key}_width", 280) or 280),
            int(self.settings.get(f"{self.overlay_key}_height", 200) or 200),
        )

    def _apply_anchor(self, area=None):
        """Поставить окно по своему якорю.

        `area` — прямоугольник (x, y, w, h), внутри которого раскладываем:
        экран или окно игры. Если не передан, берётся область из
        `self._area_provider` (её задаёт OverlayManager) либо весь экран.
        """
        if self._anchor == "custom" or not self._anchor:
            return
        if area is None:
            area = self._area_provider() if self._area_provider else self._screen_area()
        if not area:
            return
        area_x, area_y, area_w, area_h = area
        win_w, win_h = self.size()
        margin = int(self.settings.get("layout_margin", 24) or 0)
        position = compute_anchored_position(
            self._anchor, area_x, area_y, area_w, area_h, win_w, win_h, margin
        )
        if position is None:
            return
        self.set_position(*position)

    def _screen_area(self) -> Optional[Tuple[int, int, int, int]]:
        try:
            return (
                0,
                0,
                self.master.winfo_screenwidth(),
                self.master.winfo_screenheight(),
            )
        except Exception:
            return None

    def set_area_provider(self, provider: Optional[Callable[[], Optional[Tuple[int, int, int, int]]]]):
        """Функция, возвращающая область для якорей (экран или окно игры)."""
        self._area_provider = provider

    def set_size(self, width: int, height: int, save: bool = True):
        """Задать размер окна прямо сейчас (без пересоздания)."""
        try:
            width = max(self._min_width, int(width))
            height = max(self._min_height, int(height))
        except (TypeError, ValueError):
            return
        try:
            self.window.geometry(
                f"{width}x{height}+{self.window.winfo_x()}+{self.window.winfo_y()}"
            )
        except Exception:
            pass
        if save:
            self.settings[f"{self.overlay_key}_width"] = width
            self.settings[f"{self.overlay_key}_height"] = height

    def _reset_size(self):
        default = DEFAULT_BLOCK_POSITIONS.get(self.overlay_key, (280, 200))
        self.set_size(default[2], default[3])

    def set_on_move(self, callback: Callable):
        self._on_move_callback = callback

    def set_on_resize(self, callback: Callable):
        self._on_resize_callback = callback

    def _on_drag_start(self, event):
        if self._locked:
            return
        self._drag_data["x"] = event.x_root - self.window.winfo_x()
        self._drag_data["y"] = event.y_root - self.window.winfo_y()

    def _on_drag_motion(self, event):
        if self._locked:
            return
        x = event.x_root - self._drag_data["x"]
        y = event.y_root - self._drag_data["y"]
        self.window.geometry(f"+{x}+{y}")
        if self._anchor != "custom":
            self._anchor = "custom"
            self.settings[f"{self.overlay_key}_anchor"] = "custom"
        if self._on_move_callback:
            self._on_move_callback(x, y)

    def _on_resize_start(self, event):
        if self._locked:
            return
        self._resize_data["x"] = event.x_root
        self._resize_data["y"] = event.y_root
        self._resize_data["w"] = self.window.winfo_width()
        self._resize_data["h"] = self.window.winfo_height()

    def _on_resize_motion(self, event):
        if self._locked:
            return
        dx = event.x_root - self._resize_data["x"]
        dy = event.y_root - self._resize_data["y"]
        new_w = max(self._min_width, self._resize_data["w"] + dx)
        new_h = max(self._min_height, self._resize_data["h"] + dy)
        self.window.geometry(f"{new_w}x{new_h}")
        self.settings[f"{self.overlay_key}_width"] = new_w
        self.settings[f"{self.overlay_key}_height"] = new_h
        if self._on_resize_callback:
            self._on_resize_callback(new_w, new_h)

    def set_alpha(self, alpha: float, save: bool = True):
        """Задать прозрачность окна.

        `save=False` — когда значение уже записано в настройки менеджером
        (общую или блока): окно не должно перетирать чужой ключ.
        """
        self._alpha = alpha
        if save:
            self.settings["alpha"] = alpha
        try:
            self.window.attributes("-alpha", alpha)
        except Exception:
            pass

    def set_topmost(self, topmost: bool):
        """Установить/снять topmost через tkinter (безопасно для overrideredirect)."""
        if self._is_topmost == topmost:
            return
        self._is_topmost = topmost
        self.window.attributes("-topmost", topmost)

    def show(self):
        self.window.deiconify()

    def hide(self):
        self.window.withdraw()

    def toggle(self):
        if self.window.winfo_viewable():
            self.hide()
        else:
            self.show()

    def destroy(self):
        self.window.destroy()


# ============================================================
#  RouteOverlay
# ============================================================
class RouteOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "ROUTE",
            settings.get("route_x", 50), settings.get("route_y", 50),
            settings.get("route_width", 280), settings.get("route_height", 160),
            settings, "route",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)

        self.progress_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.progress_frame.pack(fill=tk.X, pady=(4, 6))
        self.progress_bg = tk.Frame(self.progress_frame, bg=COLOR_LINE, height=6)
        self.progress_bg.pack(fill=tk.X)
        self.progress_fill = tk.Frame(self.progress_bg, bg=COLOR_ACCENT, height=6, width=0)
        self.progress_fill.place(x=0, y=0)

        tk.Label(self.content, text="CURRENT", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(anchor=tk.W)
        self.current_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.current_frame.pack(fill=tk.X, pady=(2, 0))
        self.current_dot = tk.Label(self.current_frame, text=">", font=(ff, 8), fg=COLOR_ACCENT, bg=COLOR_PANEL)
        self.current_dot.pack(side=tk.LEFT)
        self.current_label = tk.Label(self.current_frame, text="-", font=(ff, fs + 1, "bold"), fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W)
        self.current_label.pack(side=tk.LEFT, padx=(4, 0))

        tk.Label(self.content, text="NEXT", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(anchor=tk.W, pady=(6, 0))
        self.next_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.next_frame.pack(fill=tk.X, pady=(2, 0))
        self.next_dot = tk.Label(self.next_frame, text=">", font=(ff, 8), fg=COLOR_CYAN, bg=COLOR_PANEL)
        self.next_dot.pack(side=tk.LEFT)
        self.next_label = tk.Label(self.next_frame, text="-", font=(ff, fs), fg=COLOR_CYAN, bg=COLOR_PANEL, anchor=tk.W)
        self.next_label.pack(side=tk.LEFT, padx=(4, 0))

        self.stats_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.stats_frame.pack(fill=tk.X, pady=(6, 0))
        self.progress_label = tk.Label(self.stats_frame, text="0 / 0", font=(ff, fs - 1, "bold"), fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W)
        self.progress_label.pack(side=tk.LEFT)
        self.remaining_label = tk.Label(self.stats_frame, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.E)
        self.remaining_label.pack(side=tk.RIGHT)

        self.remaining_list = tk.Label(self.content, text="", font=(ff, fs - 3), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W, wraplength=260)
        self.remaining_list.pack(fill=tk.X, pady=(2, 0))

    def update_route(self, current: str, next_system: str, visited: int, total: int, remaining: Optional[list] = None, next_info: Optional[dict] = None):
        self.current_label.config(text=current[:30])
        self.next_label.config(text=next_system[:30])
        if next_info and next_info.get("name") == next_system:
            if not next_info.get("known"):
                self.next_label.config(text=f"{next_system[:24]}  [EDSM нет данных]")
            else:
                bodies = next_info.get("bodies")
                population = next_info.get("population")
                details = []
                if bodies is not None:
                    details.append(f"{bodies} тел")
                if population:
                    details.append(f"нас. {population:g}")
                if details:
                    self.next_label.config(text=f"{next_system[:20]}  ({', '.join(details)})")
        self.progress_label.config(text=f"{visited} / {total}")
        if total > 0:
            pct = visited / total
            bar_width = int(260 * pct)
            self.progress_fill.config(width=bar_width)
            self.progress_fill.config(bg=COLOR_GREEN_TEXT if pct >= 1.0 else COLOR_ACCENT)
        remaining_count = total - visited
        self.remaining_label.config(text=f"Left: {remaining_count}")
        if remaining and len(remaining) <= 4:
            text = " -> ".join(remaining[:4])
        elif remaining:
            text = " -> ".join(remaining[:4]) + f" ... (+{len(remaining) - 4})"
        else:
            text = ""
        self.remaining_list.config(text=text)


# ============================================================
#  SessionEventsOverlay
# ============================================================
class SessionEventsOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(master, "SESSION EVENTS", settings.get("events_x", 740), settings.get("events_y", 50), settings.get("events_width", 360), settings.get("events_height", 260), settings, "events")
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 9)
        self.text = tk.Text(self.content, height=12, font=(ff, fs - 1), fg=COLOR_TEXT, bg=COLOR_BG, wrap=tk.WORD, state=tk.DISABLED, highlightthickness=0, borderwidth=0, padx=6, pady=4)
        self.text.pack(fill=tk.BOTH, expand=True)

    def add_event(self, message: str, level: str = "info"):
        colors = {"info": COLOR_TEXT, "success": COLOR_GREEN_TEXT, "warn": COLOR_YELLOW, "error": COLOR_RED_TEXT}
        self.text.config(state=tk.NORMAL)
        tag = f"event_{int(time.time() * 1000) % 100000}"
        self.text.insert(tk.END, f"{time.strftime('%H:%M:%S')}  {message}\n", tag)
        self.text.tag_config(tag, foreground=colors.get(level, COLOR_TEXT))
        lines = int(self.text.index("end-1c").split(".")[0])
        if lines > 100:
            self.text.delete("1.0", "21.0")
        self.text.see(tk.END)
        self.text.config(state=tk.DISABLED)


# ============================================================
#  StatusOverlay
# ============================================================
class StatusOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "STATUS",
            settings.get("status_x", 50), settings.get("status_y", 220),
            settings.get("status_width", 280), settings.get("status_height", 220),
            settings, "status",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)

        self.status_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.status_frame.pack(fill=tk.X, pady=(4, 0))
        self.status_dot = tk.Label(self.status_frame, text="*", font=(ff, 12), fg=COLOR_RED, bg=COLOR_PANEL)
        self.status_dot.pack(side=tk.LEFT, padx=(0, 6))
        self.status_text = tk.Label(self.status_frame, text="Offline", font=(ff, fs, "bold"), fg=COLOR_RED_TEXT, bg=COLOR_PANEL, anchor=tk.W)
        self.status_text.pack(side=tk.LEFT)

        self.game_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.game_frame.pack(fill=tk.X, pady=(4, 0))
        self.game_dot = tk.Label(self.game_frame, text="o", font=(ff, 10), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.game_dot.pack(side=tk.LEFT, padx=(0, 6))
        self.game_text = tk.Label(self.game_frame, text="Игра: нет данных", font=(ff, fs - 1),
                                  fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.game_text.pack(side=tk.LEFT)

        self.watcher_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.watcher_frame.pack(fill=tk.X, pady=(4, 0))
        self.watcher_dot = tk.Label(self.watcher_frame, text="o", font=(ff, 10), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.watcher_dot.pack(side=tk.LEFT, padx=(0, 6))
        self.watcher_text = tk.Label(self.watcher_frame, text="Watcher: off", font=(ff, fs - 1), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.watcher_text.pack(side=tk.LEFT)

        self.progress_text = tk.Label(self.content, text="", font=(ff, fs - 1), fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W)
        self.progress_text.pack(fill=tk.X, pady=(4, 0))

        _make_separator(self.content).pack(fill=tk.X, pady=6)
        self.detail_text = tk.Label(
            self.content, text="Ошибок нет", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED,
            bg=COLOR_PANEL, anchor=tk.W, justify=tk.LEFT, wraplength=250,
        )
        self.detail_text.pack(fill=tk.X, pady=(2, 0))

    def set_status(self, online: bool, detail: str = ""):
        if online:
            self.status_dot.config(fg=COLOR_GREEN_TEXT)
            self.status_text.config(text=f"Online  {detail}", fg=COLOR_GREEN_TEXT)
        else:
            self.status_dot.config(fg=COLOR_RED_TEXT)
            self.status_text.config(text="Offline", fg=COLOR_RED_TEXT)

    def set_game(self, running: bool, focused: bool = False, detail: str = ""):
        """Строка «Игра: запущена / в фокусе / не запущена»."""
        if running:
            color = COLOR_GREEN_TEXT if focused else COLOR_YELLOW
            text = "Игра: в фокусе" if focused else "Игра: запущена"
            dot = "*"
        else:
            color = COLOR_RED_TEXT
            text = "Игра: не запущена"
            dot = "o"
        if detail:
            text = f"{text} ({detail})"
        self.game_dot.config(fg=color, text=dot)
        self.game_text.config(text=text, fg=color)

    def set_watcher(self, active: bool):
        self.watcher_dot.config(fg=COLOR_GREEN_TEXT if active else COLOR_TEXT_MUTED, text="*" if active else "o")
        self.watcher_text.config(text="Watcher: ON" if active else "Watcher: off", fg=COLOR_GREEN_TEXT if active else COLOR_TEXT_MUTED)

    def set_progress(self, text: str):
        self.progress_text.config(text=text)

    def add_log(self, message: str, level: str = "info"):
        # STATUS is deliberately a compact health indicator, not a second
        # journal window. Keep only actionable warnings/errors.
        if level not in ("warn", "error"):
            return
        color = COLOR_RED_TEXT if level == "error" else COLOR_YELLOW
        self.detail_text.config(text=f"{level.upper()}: {message[-180:]}", fg=color)


# ============================================================
#  ShipOverlay
# ============================================================
class ShipOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        # The module list has its own scrollbar, so the whole ship overlay
        # does not need to occupy half of a 1080p screen.
        h = max(settings.get("ship_height", 420), 300)
        super().__init__(
            master, "SHIP",
            settings.get("ship_x", 50), settings.get("ship_y", 440),
            settings.get("ship_width", 360), h,
            settings, "ship",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)
        s = settings

        self.ship_header = tk.Frame(self.content, bg=COLOR_PANEL)
        self.ship_header.pack(fill=tk.X, pady=(4, 0))
        self.ship_icon = tk.Label(self.ship_header, text="[+]", font=(ff, 10), fg=COLOR_ACCENT, bg=COLOR_PANEL)
        self.ship_icon.pack(side=tk.LEFT, padx=(0, 6))
        self.ship_name_label = tk.Label(self.ship_header, text="Unknown", font=(ff, fs + 1, "bold"), fg=COLOR_ACCENT, bg=COLOR_PANEL)
        self.ship_name_label.pack(side=tk.LEFT)

        self.flags_label = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_CYAN, bg=COLOR_PANEL, anchor=tk.W)
        self.flags_label.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_flags", True):
            self.flags_label.pack_forget()

        self.pips_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.pips_frame.pack(fill=tk.X, pady=(4, 0))
        self.pips_sys = self._make_pip_bar(self.pips_frame, "SYS", COLOR_CYAN, ff, fs)
        self.pips_eng = self._make_pip_bar(self.pips_frame, "ENG", COLOR_ACCENT, ff, fs)
        self.pips_wep = self._make_pip_bar(self.pips_frame, "WEP", COLOR_RED_TEXT, ff, fs)
        if not s.get("show_pips", True):
            self.pips_frame.pack_forget()

        _make_separator(self.content).pack(fill=tk.X, pady=4)

        self.hull_frame = self._make_stat_bar("HULL", COLOR_GREEN_TEXT)
        self.hull_frame.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_hull", True):
            self.hull_frame.pack_forget()

        self.shield_frame = self._make_stat_bar("SHIELD", COLOR_CYAN)
        self.shield_frame.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_shield", True):
            self.shield_frame.pack_forget()

        self.fuel_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.fuel_frame.pack(fill=tk.X, pady=(2, 0))
        tk.Label(self.fuel_frame, text="FUEL", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, width=10, anchor=tk.W).pack(side=tk.LEFT)
        self.fuel_text = tk.Label(self.fuel_frame, text="0.00 / 0.00", font=(ff, fs - 1), fg=COLOR_TEXT, bg=COLOR_PANEL)
        self.fuel_text.pack(side=tk.LEFT, padx=(6, 0))
        self.fuel_res_text = tk.Label(self.fuel_frame, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.fuel_res_text.pack(side=tk.RIGHT)
        if not s.get("show_fuel", True):
            self.fuel_frame.pack_forget()

        self.power_frame = self._make_stat_bar("POWER", COLOR_YELLOW)
        self.power_frame.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_power", True):
            self.power_frame.pack_forget()

        self.info_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.info_frame.pack(fill=tk.X, pady=(4, 0))
        self.cargo_text = tk.Label(self.info_frame, text="Cargo: 0 / 0 t", font=(ff, fs - 1), fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W)
        self.cargo_text.pack(side=tk.LEFT)
        self.balance_text = tk.Label(self.info_frame, text="", font=(ff, fs - 1), fg=COLOR_GREEN_TEXT, bg=COLOR_PANEL, anchor=tk.E)
        self.balance_text.pack(side=tk.RIGHT)
        if not s.get("show_cargo_info", True):
            self.cargo_text.pack_forget()
        if not s.get("show_balance", True):
            self.balance_text.pack_forget()
        if not s.get("show_cargo_info", True) and not s.get("show_balance", True):
            self.info_frame.pack_forget()

        self.legal_text = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.legal_text.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_legal", True):
            self.legal_text.pack_forget()

        self.dest_text = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.dest_text.pack(fill=tk.X, pady=(0, 2))
        if not s.get("show_destination", True):
            self.dest_text.pack_forget()

        _make_separator(self.content).pack(fill=tk.X, pady=4)

        self.mod_header = tk.Frame(self.content, bg=COLOR_PANEL)
        self.mod_header.pack(fill=tk.X)
        tk.Label(self.mod_header, text="MODULES", font=(ff, fs - 2, "bold"), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(side=tk.LEFT)
        self.mod_count_text = tk.Label(self.mod_header, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.mod_count_text.pack(side=tk.RIGHT)

        self.modules_canvas = tk.Canvas(self.content, bg=COLOR_PANEL, highlightthickness=0, height=260)
        self.modules_canvas.pack(fill=tk.BOTH, expand=True, pady=(2, 0))

        scrollbar = tk.Scrollbar(self.content, orient=tk.VERTICAL, command=self.modules_canvas.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.modules_canvas.configure(yscrollcommand=scrollbar.set)

        self.modules_inner = tk.Frame(self.modules_canvas, bg=COLOR_PANEL)
        self.modules_canvas.create_window((0, 0), window=self.modules_inner, anchor=tk.NW, width=330)
        self.modules_inner.bind("<Configure>", lambda e: self.modules_canvas.configure(scrollregion=self.modules_canvas.bbox("all")))

        self.damage_counter = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.damage_counter.pack(fill=tk.X, pady=(2, 0))

        # Кэш виджетов модулей: slot -> widget dict
        self._module_widgets: Dict[str, dict] = {}
        self._last_modules_hash = ""

        if not s.get("show_modules", True):
            self.mod_header.pack_forget()
            self.modules_canvas.pack_forget()
            scrollbar.pack_forget()
            self.damage_counter.pack_forget()

    def _make_pip_bar(self, parent, name, color, ff, fs):
        frame = tk.Frame(parent, bg=COLOR_PANEL)
        frame.pack(side=tk.LEFT, padx=(0, 10))
        tk.Label(frame, text=name, font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(side=tk.LEFT)
        bar_frame = tk.Frame(frame, bg=COLOR_LINE, width=60, height=10)
        bar_frame.pack(side=tk.LEFT, padx=(4, 0))
        bar_frame.pack_propagate(False)
        fill = tk.Frame(bar_frame, bg=color, width=0, height=10)
        fill.place(x=0, y=0)
        lbl = tk.Label(frame, text="0/8", font=(ff, fs - 2), fg=color, bg=COLOR_PANEL, width=3)
        lbl.pack(side=tk.LEFT, padx=(4, 0))
        lbl._fill = fill
        lbl._bar_frame = bar_frame
        return lbl

    def _make_stat_bar(self, label, color):
        ff = self.settings.get("font_family", "Consolas")
        fs = self.settings.get("font_size", 10)
        frame = tk.Frame(self.content, bg=COLOR_PANEL)
        tk.Label(frame, text=label, font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, width=10, anchor=tk.W).pack(side=tk.LEFT)
        bar_bg = tk.Frame(frame, bg=COLOR_LINE, height=12, width=120)
        bar_bg.pack(side=tk.LEFT, padx=(6, 0))
        bar_bg.pack_propagate(False)
        bar_fill = tk.Frame(bar_bg, bg=color, height=12, width=0)
        bar_fill.place(x=0, y=0)
        bar_text = tk.Label(frame, text="100%", font=(ff, fs - 1, "bold"), fg=color, bg=COLOR_PANEL)
        bar_text.pack(side=tk.RIGHT)
        frame._bar_fill = bar_fill
        frame._bar_text = bar_text
        frame._bar_bg = bar_bg
        return frame

    def _health_color(self, percent: int) -> str:
        if percent >= 80:
            return COLOR_GREEN_TEXT
        elif percent >= 50:
            return COLOR_YELLOW
        else:
            return COLOR_RED_TEXT

    def _modules_hash(self, modules: list) -> str:
        """Быстрый хеш списка модулей для сравнения."""
        parts = []
        for m in sorted(modules, key=lambda x: x.get("slot", "")):
            parts.append(f"{m.get('slot')}:{m.get('health',100)}:{m.get('power',0):.3f}")
        return "|".join(parts)

    def update_ship(self, data: dict):
        ship_type = data.get("ship_type", "Unknown")
        ship_name = data.get("ship_name", "")
        ident = data.get("ship_ident", "")
        display = f"{ship_type}"
        if ship_name:
            display += f"  '{ship_name}'"
        if ident:
            display += f"  [{ident}]"
        self.ship_name_label.config(text=display[:42])

        flags = data.get("flags_list", [])
        important = [f for f in flags if f in ("Supercruise", "Hardpoints", "MassLock", "FsdCharging", "FsdCooldown", "LowFuel", "Overheat", "Danger", "Interdicted", "Scooping", "FsdJump", "FsdHyper", "FsdTransit")]
        self.flags_label.config(text="  ".join(important) if important else "")

        for pips_label, pips_key in [(self.pips_sys, "pips_sys"), (self.pips_eng, "pips_eng"), (self.pips_wep, "pips_wep")]:
            pips = data.get(pips_key, 0)
            pips_label.config(text=f"{pips}/8")
            if hasattr(pips_label, '_fill'):
                fill_width = int((pips / 8) * 60)
                pips_label._fill.config(width=fill_width)

        hull = data.get("hull_percent", 100)
        hull_color = self._health_color(hull)
        if hasattr(self.hull_frame, '_bar_fill'):
            fill_w = int((hull / 100) * 120)
            self.hull_frame._bar_fill.config(width=fill_w, bg=hull_color)
            self.hull_frame._bar_text.config(text=f"{hull}%", fg=hull_color)

        shield = data.get("shield_percent", 100)
        has_shield_gen = any("shieldgenerator" in m.get("name", "").lower() for m in data.get("modules", []))
        if not has_shield_gen and shield == 100:
            if hasattr(self.shield_frame, '_bar_fill'):
                self.shield_frame._bar_fill.config(width=0)
                self.shield_frame._bar_text.config(text="NO", fg=COLOR_TEXT_MUTED)
        else:
            shield_color = self._health_color(shield)
            if hasattr(self.shield_frame, '_bar_fill'):
                fill_w = int((shield / 100) * 120)
                self.shield_frame._bar_fill.config(width=fill_w, bg=shield_color)
                self.shield_frame._bar_text.config(text=f"{shield}%", fg=shield_color)

        fuel_lvl = data.get("fuel_level", 0)
        fuel_cap = data.get("fuel_capacity", 0)
        fuel_res = data.get("fuel_reservoir", 0)
        self.fuel_text.config(text=f"{fuel_lvl:.2f} / {fuel_cap:.2f} t")
        self.fuel_res_text.config(text=f"Res: {fuel_res:.3f} t" if fuel_res > 0 else "")

        power_used = data.get("power_used", 0)
        power_cap = data.get("power_capacity", 0)
        power_pct = data.get("power_percent", 0)
        if power_cap > 0:
            pcolor = COLOR_GREEN_TEXT if power_pct < 80 else (COLOR_YELLOW if power_pct < 100 else COLOR_RED_TEXT)
            if hasattr(self.power_frame, '_bar_fill'):
                fill_w = int((min(power_pct, 100) / 100) * 120)
                self.power_frame._bar_fill.config(width=fill_w, bg=pcolor)
                self.power_frame._bar_text.config(text=f"{power_used:.2f} / {power_cap:.2f} MW ({power_pct}%)", fg=pcolor)
        elif power_used > 0:
            if hasattr(self.power_frame, '_bar_fill'):
                self.power_frame._bar_fill.config(width=0)
                self.power_frame._bar_text.config(text=f"{power_used:.2f} MW (no gen data)", fg=COLOR_YELLOW)
        else:
            if hasattr(self.power_frame, '_bar_fill'):
                self.power_frame._bar_fill.config(width=0)
                self.power_frame._bar_text.config(text="-", fg=COLOR_TEXT_MUTED)

        cargo = data.get("cargo_count", 0)
        cargo_cap = data.get("cargo_capacity", 0)
        self.cargo_text.config(text=f"Cargo: {cargo} / {cargo_cap} t")

        balance = data.get("balance", 0)
        self.balance_text.config(text=f"{balance:,} CR".replace(",", " ") if balance > 0 else "")

        legal = data.get("legal_state", "Clean")
        lcolor = COLOR_GREEN_TEXT if legal == "Clean" else COLOR_RED_TEXT
        self.legal_text.config(text=f"Legal: {legal}", fg=lcolor)

        dest = data.get("destination_name", "")
        self.dest_text.config(text=f"-> {dest}" if dest else "")

        modules = data.get("modules", [])
        show_modules = sorted(modules, key=lambda m: (m.get("health", 100), -m.get("power", 0)))

        # Проверяем, изменился ли список модулей (health/power)
        current_hash = self._modules_hash(show_modules)
        if current_hash != self._last_modules_hash:
            self._last_modules_hash = current_hash
            self._update_module_widgets(show_modules)

        self.mod_count_text.config(text=f"{len(modules)} mod." if modules else "")

        damaged_count = data.get("damaged_count", 0)
        critical_count = data.get("critical_count", 0)
        if damaged_count > 0:
            color = COLOR_RED_TEXT if critical_count > 0 else COLOR_YELLOW
            self.damage_counter.config(text=f"! Damaged: {damaged_count}  Critical: {critical_count}", fg=color)
        else:
            self.damage_counter.config(text="OK All modules functional", fg=COLOR_GREEN_TEXT)

    def _update_module_widgets(self, show_modules: list):
        """Обновить виджеты модулей: переиспользуем существующие, создаём новые, удаляем лишние."""
        ff = self.settings.get("font_family", "Consolas")
        fs = self.settings.get("font_size", 10)
        needed_slots = set()

        for m in show_modules:
            slot = m.get("slot", "")
            if not slot:
                continue
            needed_slots.add(slot)
            hp = m.get("health", 100)
            color = self._health_color(hp)
            power = m.get("power", 0)

            if slot in self._module_widgets:
                # Обновляем существующий виджет
                widgets = self._module_widgets[slot]
                widgets["bar_fill"].config(width=int((hp / 100) * 30), bg=color)
                widgets["name_label"].config(text=m['name'].replace("int_", "").replace("hpt_", "")[:20], fg=color)
                widgets["hp_label"].config(text=f"{hp:3}%", fg=color)
                if power > 0:
                    widgets["power_label"].config(text=f"{power:.2f}MW")
            else:
                # Создаём новый виджет
                row = tk.Frame(self.modules_inner, bg=COLOR_PANEL)
                row.pack(fill=tk.X, pady=1)
                bar_bg = tk.Frame(row, bg=COLOR_LINE, width=30, height=8)
                bar_bg.pack(side=tk.LEFT, padx=(0, 6))
                bar_bg.pack_propagate(False)
                fill_w = int((hp / 100) * 30)
                bar_fill = tk.Frame(bar_bg, bg=color, width=fill_w, height=8)
                bar_fill.place(x=0, y=0)
                name_text = m['name'].replace("int_", "").replace("hpt_", "")[:20]
                name_label = tk.Label(row, text=name_text, font=(ff, fs - 2), fg=color, bg=COLOR_PANEL, anchor=tk.W, width=18)
                name_label.pack(side=tk.LEFT)
                hp_label = tk.Label(row, text=f"{hp:3}%", font=(ff, fs - 2), fg=color, bg=COLOR_PANEL, anchor=tk.E, width=4)
                hp_label.pack(side=tk.LEFT)
                power_label = tk.Label(row, text=f"{power:.2f}MW" if power > 0 else "", font=(ff, fs - 3), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.E, width=6)
                power_label.pack(side=tk.RIGHT)
                self._module_widgets[slot] = {
                    "row": row,
                    "bar_fill": bar_fill,
                    "name_label": name_label,
                    "hp_label": hp_label,
                    "power_label": power_label,
                }

        # Удаляем виджеты для модулей, которых больше нет
        for slot in list(self._module_widgets.keys()):
            if slot not in needed_slots:
                widgets = self._module_widgets.pop(slot)
                widgets["row"].destroy()

        # Перепаковываем строки в правильном порядке (show_modules уже
        # отсортирован по health/power). Обновление одних только цветов/
        # текста в существующих виджетах не двигает их в списке — без
        # этого порядок застывал на первом кадре и переставал отражать
        # актуальное состояние модулей.
        for m in show_modules:
            slot = m.get("slot", "")
            widgets = self._module_widgets.get(slot)
            if widgets:
                widgets["row"].pack_forget()
                widgets["row"].pack(fill=tk.X, pady=1)

        self.modules_inner.update_idletasks()
        self.modules_canvas.configure(scrollregion=self.modules_canvas.bbox("all"))


# ============================================================
#  CargoOverlay
# ============================================================
class CargoOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "CARGO",
            settings.get("cargo_x", 50), settings.get("cargo_y", 980),
            settings.get("cargo_width", 300), settings.get("cargo_height", 340),
            settings, "cargo",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)

        header = tk.Frame(self.content, bg=COLOR_PANEL)
        header.pack(fill=tk.X, pady=(4, 0))
        self.total_label = tk.Label(header, text="0 / 0 t", font=(ff, fs + 1, "bold"), fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W)
        self.total_label.pack(side=tk.LEFT)
        self.fill_pct = tk.Label(header, text="0%", font=(ff, fs - 1), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.E)
        self.fill_pct.pack(side=tk.RIGHT)

        self.cargo_bar_bg = tk.Frame(self.content, bg=COLOR_LINE, height=6)
        self.cargo_bar_bg.pack(fill=tk.X, pady=(4, 6))
        self.cargo_bar_fill = tk.Frame(self.cargo_bar_bg, bg=COLOR_ACCENT, height=6, width=0)
        self.cargo_bar_fill.place(x=0, y=0)

        _make_separator(self.content).pack(fill=tk.X, pady=2)

        self.cargo_canvas = tk.Canvas(self.content, bg=COLOR_PANEL, highlightthickness=0, height=240)
        self.cargo_canvas.pack(fill=tk.BOTH, expand=True)

        scrollbar = tk.Scrollbar(self.content, orient=tk.VERTICAL, command=self.cargo_canvas.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.cargo_canvas.configure(yscrollcommand=scrollbar.set)

        self.cargo_inner = tk.Frame(self.cargo_canvas, bg=COLOR_PANEL)
        self.cargo_canvas.create_window((0, 0), window=self.cargo_inner, anchor=tk.NW, width=270)
        self.cargo_inner.bind("<Configure>", lambda e: self.cargo_canvas.configure(scrollregion=self.cargo_canvas.bbox("all")))

        self.empty_label = tk.Label(self.cargo_inner, text="[ Empty hold ]", font=(ff, fs), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.empty_label.pack(pady=30)

    def update_cargo(self, data: dict):
        total = data.get("cargo_count", 0)
        capacity = data.get("cargo_capacity", 0)
        self.total_label.config(text=f"{total} / {capacity} t")

        pct = int((total / capacity * 100)) if capacity > 0 else 0
        self.fill_pct.config(text=f"{pct}%")

        bar_width = int((pct / 100) * 270) if capacity > 0 else 0
        self.cargo_bar_fill.config(width=bar_width)
        self.cargo_bar_fill.config(bg=COLOR_GREEN_TEXT if pct < 80 else (COLOR_YELLOW if pct < 100 else COLOR_RED_TEXT))

        inventory = data.get("inventory", [])
        for widget in self.cargo_inner.winfo_children():
            widget.destroy()

        if not inventory:
            self.empty_label = tk.Label(
                self.cargo_inner, text="[ Empty hold ]",
                font=(self.settings.get("font_family", "Consolas"), self.settings.get("font_size", 10)),
                fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL,
            )
            self.empty_label.pack(pady=30)
        else:
            ff = self.settings.get("font_family", "Consolas")
            fs = self.settings.get("font_size", 10)
            for item in inventory:
                name = item.get("Name_Localised") or item.get("Name", "Unknown")
                count = item.get("Count", 0)
                stolen = item.get("Stolen", 0)

                row = tk.Frame(self.cargo_inner, bg=COLOR_PANEL)
                row.pack(fill=tk.X, pady=2)

                icon = "!" if stolen > 0 else "-"
                icon_color = COLOR_RED_TEXT if stolen > 0 else COLOR_ACCENT

                tk.Label(row, text=icon, font=(ff, 8), fg=icon_color, bg=COLOR_PANEL, width=2).pack(side=tk.LEFT)
                tk.Label(row, text=f"{name[:22]}", font=(ff, fs - 1), fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W, width=22).pack(side=tk.LEFT)

                count_text = f"{count:>4}"
                if stolen > 0:
                    count_text += f" ({stolen} stl)"

                tk.Label(row, text=count_text, font=(ff, fs - 1, "bold"), fg=COLOR_ACCENT if stolen > 0 else COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.E).pack(side=tk.RIGHT)

        self.cargo_inner.update_idletasks()
        self.cargo_canvas.configure(scrollregion=self.cargo_canvas.bbox("all"))


# ============================================================
#  ExobiologyOverlay
# ============================================================
class ExobiologyOverlay(OverlayWindow):
    """Экзобиология по текущему телу: параметры, сигналы и предсказание родов.

    Данные — только из журнала игрока (Scan / SAAScanComplete / FSSBodySignals /
    ScanOrganic). Предсказание уровня **род**, упрощённая собственная модель
    (`exobiology.GENUS_RULES`) — см. комментарий про лицензию в модуле.
    """

    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "EXOBIO",
            settings.get("exobio_x", 1060), settings.get("exobio_y", 50),
            settings.get("exobio_width", 330), settings.get("exobio_height", 360),
            settings, "exobio",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)
        wrap = max(160, int(settings.get("exobio_width", 330)) - 30)

        self.body_label = tk.Label(self.content, text="Тело: —", font=(ff, fs, "bold"),
                                   fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W,
                                   justify=tk.LEFT, wraplength=wrap)
        self.body_label.pack(fill=tk.X, pady=(2, 0))

        self.params_label = tk.Label(self.content, text="", font=(ff, fs - 1),
                                     fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W,
                                     justify=tk.LEFT, wraplength=wrap)
        self.params_label.pack(fill=tk.X, pady=(2, 0))

        self.signals_label = tk.Label(self.content, text="", font=(ff, fs - 1),
                                      fg=COLOR_YELLOW, bg=COLOR_PANEL, anchor=tk.W,
                                      justify=tk.LEFT, wraplength=wrap)
        self.signals_label.pack(fill=tk.X, pady=(2, 0))

        _make_separator(self.content).pack(fill=tk.X, pady=5)

        tk.Label(self.content, text="Вероятные роды:", font=(ff, fs - 1, "bold"),
                 fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W).pack(fill=tk.X)
        self.predict_label = tk.Label(self.content, text="нет данных", font=(ff, fs - 1),
                                      fg=COLOR_GREEN_TEXT, bg=COLOR_PANEL, anchor=tk.W,
                                      justify=tk.LEFT, wraplength=wrap)
        self.predict_label.pack(fill=tk.X, pady=(2, 0))

        _make_separator(self.content).pack(fill=tk.X, pady=5)

        tk.Label(self.content, text="Образцы на теле:", font=(ff, fs - 1, "bold"),
                 fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W).pack(fill=tk.X)
        self.organics_label = tk.Label(self.content, text="—", font=(ff, fs - 1),
                                       fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W,
                                       justify=tk.LEFT, wraplength=wrap)
        self.organics_label.pack(fill=tk.X, pady=(2, 0))

        tk.Label(
            self.content,
            text="Модель предсказывает род, а не вид: таблица критериев "
                 "намеренно не копируется из GPL-проектов.",
            font=(ff, max(7, fs - 2)), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL,
            anchor=tk.W, justify=tk.LEFT, wraplength=wrap,
        ).pack(fill=tk.X, pady=(6, 0))

    def update_exobiology(self, state: Optional[dict]):
        """Обновить содержимое. `state` — словарь от `ExobiologyTracker`."""
        if not state:
            self.body_label.config(text="Тело: —")
            self.params_label.config(text="Отсканируйте тело (FSS или подход)")
            self.signals_label.config(text="")
            self.predict_label.config(text="нет данных")
            self.organics_label.config(text="—")
            return

        self.body_label.config(
            text=f"{state.get('body') or '—'}  ({state.get('planet_class') or '?'})"
        )

        gravity = float(state.get("gravity") or 0.0)
        self.params_label.config(
            text=(
                f"{state.get('atmosphere') or 'нет атмосферы'}\n"
                f"T {float(state.get('temperature') or 0):.0f} K   "
                f"g {gravity / 10.0:.2f}\n"
                f"Вулканизм: {state.get('volcanism') or 'нет'}\n"
                f"{'посадка возможна' if state.get('landable') else 'посадка невозможна'}"
            )
        )

        signals = int(state.get("bio_signals") or 0)
        mapped = "карта есть" if state.get("mapped") else "карты нет (DSS)"
        self.signals_label.config(
            text=(f"Биосигналов: {signals}  |  {mapped}" if signals
                  else f"Биосигналов нет  |  {mapped}")
        )

        predictions = state.get("predictions") or []
        if predictions:
            lines = []
            for row in predictions[:6]:
                bars = "#" * int(min(float(row.get("score") or 0), 6))
                notes = ", ".join(row.get("notes") or [])
                lines.append(f"{row.get('genus')} {bars}"
                             + (f"  {notes}" if notes else ""))
            extra = len(predictions) - 6
            if extra > 0:
                lines.append(f"… и ещё {extra}")
            self.predict_label.config(text="\n".join(lines))
        else:
            self.predict_label.config(text="нет подходящих родов")

        organics = state.get("organics") or []
        if organics:
            rows = []
            for row in organics:
                samples = int(row.get("samples") or 0)
                mark = "✔" if row.get("complete") else f"{samples}/3"
                stage = row.get("stage") or ""
                rows.append(f"{row.get('species')} [{mark}] {stage}".rstrip())
            self.organics_label.config(text="\n".join(rows))
        else:
            self.organics_label.config(text="образцы не взяты")


# ============================================================
#  SessionOverlay — статистика сессии с графиком
# ============================================================
class SessionOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "SESSION",
            settings.get("session_x", 400), settings.get("session_y", 50),
            settings.get("session_width", 320), settings.get("session_height", 300),
            settings, "session",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)

        self.session_header = tk.Label(self.content, text="SESSION STATS", font=(ff, fs, "bold"), fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W)
        self.session_header.pack(fill=tk.X, pady=(4, 0))

        _make_separator(self.content).pack(fill=tk.X, pady=4)

        self.stats_grid = tk.Frame(self.content, bg=COLOR_PANEL)
        self.stats_grid.pack(fill=tk.X, pady=(0, 4))

        self.systems_label = self._make_stat_row(self.stats_grid, "Systems:", "0", COLOR_CYAN)
        self.deliveries_label = self._make_stat_row(self.stats_grid, "Deliveries:", "0", COLOR_GREEN_TEXT)
        self.cargo_label = self._make_stat_row(self.stats_grid, "Cargo (t):", "0", COLOR_ACCENT)
        self.route_cargo_label = self._make_stat_row(self.stats_grid, "Route (t):", "0", COLOR_YELLOW)
        self.construction_cargo_label = self._make_stat_row(self.stats_grid, "Build (t):", "0", COLOR_CYAN)
        self.time_label = self._make_stat_row(self.stats_grid, "Time:", "00:00", COLOR_TEXT_MUTED)

        self.route_system_label = tk.Label(self.content, text="", font=(ff, fs - 1), fg=COLOR_YELLOW, bg=COLOR_PANEL, anchor=tk.W)
        self.route_system_label.pack(fill=tk.X, pady=(2, 0))

        _make_separator(self.content).pack(fill=tk.X, pady=4)

        tk.Label(self.content, text="CARGO HISTORY", font=(ff, fs - 2, "bold"), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W).pack(fill=tk.X)

        self.chart_canvas = tk.Canvas(self.content, bg=COLOR_PANEL, highlightthickness=0, height=100)
        self.chart_canvas.pack(fill=tk.X, pady=(4, 0))

        self.route_info = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W, wraplength=280)
        self.route_info.pack(fill=tk.X, pady=(4, 0))

        self.cargo_history: deque = deque(maxlen=20)
        self.jump_history: deque = deque(maxlen=20)
        self.session_start = time.time()
        self.start_system = ""
        self.current_system = ""

    def _make_stat_row(self, parent, label, value, value_color):
        ff = self.settings.get("font_family", "Consolas")
        fs = self.settings.get("font_size", 10)
        row = tk.Frame(parent, bg=COLOR_PANEL)
        row.pack(fill=tk.X, pady=1)
        tk.Label(row, text=label, font=(ff, fs - 1), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, width=12, anchor=tk.W).pack(side=tk.LEFT)
        lbl = tk.Label(row, text=value, font=(ff, fs, "bold"), fg=value_color, bg=COLOR_PANEL, anchor=tk.E)
        lbl.pack(side=tk.RIGHT)
        return lbl

    def update_session(self, data: dict):
        systems_visited = data.get("systems_visited", 0)
        self.systems_label.config(text=str(systems_visited))

        deliveries = data.get("deliveries_count", 0)
        self.deliveries_label.config(text=str(deliveries))

        cargo_total = data.get("cargo_total_tons", 0)
        self.cargo_label.config(text=f"{cargo_total:.1f}")

        route_cargo = data.get("route_cargo_tons", 0)
        self.route_cargo_label.config(text=f"{route_cargo:.1f}")
        construction_cargo = data.get("construction_cargo_tons", 0)
        self.construction_cargo_label.config(text=f"{construction_cargo:.1f}")

        elapsed = int(time.time() - self.session_start)
        hours = elapsed // 3600
        mins = (elapsed % 3600) // 60
        self.time_label.config(text=f"{hours:02d}:{mins:02d}")

        last_system = data.get("last_delivery_system", "")
        if last_system:
            self.route_system_label.config(text=f"-> {last_system}")
        else:
            self.route_system_label.config(text="")

        current = data.get("current_system", "")
        if current and not self.start_system:
            self.start_system = current
        self.current_system = current

        if self.start_system and self.current_system:
            self.route_info.config(text=f">> {self.start_system}  ->  {self.current_system}")
        else:
            self.route_info.config(text="")

        cargo_count = data.get("cargo_count", 0)
        self.cargo_history.append(cargo_count)
        if current:
            self.jump_history.append(current)

        self._draw_chart()

    def _draw_chart(self):
        canvas = self.chart_canvas
        canvas.delete("all")

        history = list(self.cargo_history)
        if len(history) < 2:
            canvas.create_text(140, 50, text="Collecting data...", fill=COLOR_TEXT_MUTED, font=("Consolas", 9))
            return

        w = canvas.winfo_width() or 280
        h = canvas.winfo_height() or 100
        padding = 20

        max_val = max(history) if max(history) > 0 else 1
        min_val = 0

        for i in range(5):
            y = padding + (h - 2 * padding) * i / 4
            canvas.create_line(padding, y, w - padding, y, fill=COLOR_LINE, width=1)

        points = []
        for i, val in enumerate(history):
            x = padding + (w - 2 * padding) * i / max(len(history) - 1, 1)
            y = padding + (h - 2 * padding) * (1 - val / max_val)
            points.append((x, y))

        for i in range(len(points) - 1):
            canvas.create_line(points[i][0], points[i][1], points[i+1][0], points[i+1][1], fill=COLOR_ACCENT, width=2)

        for x, y in points:
            canvas.create_oval(x-3, y-3, x+3, y+3, fill=COLOR_ACCENT, outline=COLOR_TEXT)

        canvas.create_text(padding, h - 5, text=str(min_val), fill=COLOR_TEXT_MUTED, font=("Consolas", 7), anchor=tk.W)
        canvas.create_text(padding, padding, text=str(max_val), fill=COLOR_TEXT_MUTED, font=("Consolas", 7), anchor=tk.W)


# ============================================================
#  OverlayManager
# ============================================================
class OverlayManager:
    #: Блоки HUD: ключ -> (настройка видимости, класс окна)
    BLOCKS = ("route", "status", "ship", "cargo", "session", "events", "exobio")

    #: Позиции по умолчанию для «Сбросить позиции» (x, y, w, h)
    DEFAULT_POSITIONS = DEFAULT_BLOCK_POSITIONS

    def __init__(self, master: tk.Tk, config_path: Path, game_monitor=None):
        self.master = master
        self.config_path = config_path
        self.settings = load_overlay_settings(config_path)
        # Отслеживание игры: запущена/в фокусе + геометрия окна.
        self.game_monitor = game_monitor or GameMonitor()
        self.route_overlay: Optional[RouteOverlay] = None
        self.status_overlay: Optional[StatusOverlay] = None
        self.ship_overlay: Optional[ShipOverlay] = None
        self.cargo_overlay: Optional[CargoOverlay] = None
        self.session_overlay: Optional[SessionOverlay] = None
        self.events_overlay: Optional[SessionEventsOverlay] = None
        self.exobio_overlay: Optional[ExobiologyOverlay] = None
        self.enabled = False
        self._update_callback: Optional[Callable] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._pending_logs: list = []
        self._log_lock = threading.Lock()
        self._session_stats = {
            "systems_visited": 0,
            "deliveries_count": 0,
            "cargo_total_tons": 0.0,
            "current_system": "",
            "cargo_count": 0,
        }
        # Контекст для правил автопоказа (обновляется в _apply_update).
        self._context_state: Dict[str, Any] = {}
        # Активность для автоскрытия при простое: любое изменение данных или
        # возврат фокуса игре продлевает показ HUD.
        self._last_activity = time.monotonic()
        self._hidden_by_idle = False
        self.hotkeys = HotkeyManager(master, logger=self.log)

    def start(self, update_callback: Callable):
        if self.enabled:
            return
        self.enabled = True
        self._update_callback = update_callback
        self._last_activity = time.monotonic()
        self._hidden_by_idle = False
        self.master.after(0, self._create_windows)
        self._stop.clear()
        self._thread = threading.Thread(target=self._update_loop, daemon=True)
        self._thread.start()

    def _create_windows(self):
        self.route_overlay = RouteOverlay(self.master, self.settings)
        self.status_overlay = StatusOverlay(self.master, self.settings)
        self.ship_overlay = ShipOverlay(self.master, self.settings)
        self.cargo_overlay = CargoOverlay(self.master, self.settings)
        self.session_overlay = SessionOverlay(self.master, self.settings)
        self.events_overlay = SessionEventsOverlay(self.master, self.settings)
        self.exobio_overlay = ExobiologyOverlay(self.master, self.settings)

        for ov, key in self._blocks():
            ov.set_on_move(self._make_moved_handler(key))
            ov.set_on_resize(lambda w, h, k=key: self._on_resized(k, w, h))
            # Якоря считаем относительно экрана или окна игры — см. overlay_area().
            ov.set_area_provider(self.overlay_area)
            # Содержимое уже собрано — запоминаем шрифты и применяем
            # персональные настройки блока (свой размер шрифта/прозрачность).
            ov._register_fonts()
            ov.apply_font(self.settings.get("font_family", "Consolas"),
                          resolve_block_font_size(self.settings, key))
            ov.set_alpha(resolve_block_alpha(self.settings, key), save=False)
            if not self.settings.get(f"show_{key}", True):
                ov.hide()

        # Применяем якоря после того, как все окна созданы и знают свой размер.
        self.master.after(60, self.apply_anchors)
        self.register_hotkeys()

    # ============================================================
    #  Блоки, геометрия, раскладка
    # ============================================================
    def _blocks(self) -> list:
        """Живые пары (ключ, окно) — только для существующих окон."""
        mapping = {
            "route": self.route_overlay,
            "status": self.status_overlay,
            "ship": self.ship_overlay,
            "cargo": self.cargo_overlay,
            "session": self.session_overlay,
            "events": self.events_overlay,
            "exobio": self.exobio_overlay,
        }
        return [(key, mapping.get(key)) for key in self.BLOCKS if mapping.get(key) is not None]

    def _make_moved_handler(self, key: str):
        def handler(x: int, y: int):
            self.settings[f"{key}_x"] = x
            self.settings[f"{key}_y"] = y

        return handler

    def game_state(self):
        """Актуальное состояние игры (кэшируется монитором на ~1 с)."""
        try:
            return self.game_monitor.state
        except Exception:
            return GameState()

    @property
    def game_running(self) -> bool:
        return bool(self.game_state().running)

    def screen_area(self) -> Tuple[int, int, int, int]:
        """Весь основной экран."""
        try:
            return (0, 0, self.master.winfo_screenwidth(), self.master.winfo_screenheight())
        except Exception:
            return (0, 0, 1920, 1080)

    def overlay_area(self) -> Tuple[int, int, int, int]:
        """Область, внутри которой раскладываются блоки HUD.

        Если включена привязка к окну игры и игра запущена — это прямоугольник
        монитора с игрой (так оверлей не уедет на другой экран). Иначе — весь
        основной экран.
        """
        if self.settings.get("attach_to_game", True):
            state = self.game_state()
            monitor = state.monitor
            if monitor:
                left, top, right, bottom = monitor
                return (left, top, max(1, right - left), max(1, bottom - top))
        return self.screen_area()

    def apply_anchors(self):
        """Расставить все блоки по их якорям внутри текущей области."""
        area = self.overlay_area()
        for key, overlay in self._blocks():
            anchor = self.settings.get(f"{key}_anchor", "custom")
            if not anchor or anchor == "custom":
                continue
            try:
                overlay._apply_anchor(area)
            except Exception:
                pass

    def snap_block(self, key: str, anchor: str, save: bool = True):
        """Привязать блок к якорю (или отпустить: anchor='custom')."""
        if save:
            self.settings[f"{key}_anchor"] = anchor
        for block_key, overlay in self._blocks():
            if block_key != key or overlay is None:
                continue
            if anchor == "custom":
                return
            try:
                overlay._anchor = anchor
                overlay._apply_anchor(self.overlay_area())
            except Exception:
                pass
            return

    def reset_positions(self):
        """Вернуть блоки на стандартные места и сбросить якоря."""
        for key, (x, y, w, h) in self.DEFAULT_POSITIONS.items():
            self.settings[f"{key}_x"] = x
            self.settings[f"{key}_y"] = y
            self.settings[f"{key}_width"] = w
            self.settings[f"{key}_height"] = h
            self.settings[f"{key}_anchor"] = "custom"
        for _key, overlay in self._blocks():
            pos = self.DEFAULT_POSITIONS.get(_key)
            if overlay is None or not pos:
                continue
            try:
                overlay.set_geometry(*pos)
            except Exception:
                pass
        self.save_settings()

    # ============================================================
    #  Профили раскладки
    # ============================================================
    def list_profiles(self) -> list:
        profiles = self.settings.get("profiles") or {}
        return sorted(profiles.keys()) if isinstance(profiles, dict) else []

    @property
    def active_profile(self) -> str:
        return str(self.settings.get("active_profile", "") or "")

    def capture_layout(self, name: str) -> bool:
        """Сохранить текущую раскладку под именем `name`."""
        name = (name or "").strip()
        if not name:
            return False
        windows = {key: overlay for key, overlay in self._blocks()}
        snapshot = capture_layout_snapshot(self.settings, windows, self.BLOCKS)
        profiles = self.settings.get("profiles")
        if not isinstance(profiles, dict):
            profiles = {}
        profiles[name] = snapshot
        self.settings["profiles"] = profiles
        self.settings["active_profile"] = name
        self.save_settings()
        return True

    def apply_layout(self, name: str) -> bool:
        """Применить сохранённую раскладку.

        Шрифт, прозрачность, размер и поведение блоков могут отличаться от
        текущих, но окна НЕ пересоздаются: настройки проталкиваются в живые
        окна (`apply_block_style`), поэтому переключение профиля не заставляет
        оверлей мигать и терять позицию.
        """
        profiles = self.settings.get("profiles") or {}
        snapshot = profiles.get(name) if isinstance(profiles, dict) else None
        if not isinstance(snapshot, dict):
            return False
        apply_layout_snapshot(self.settings, snapshot, self.BLOCKS)
        self.settings["active_profile"] = name
        for key, overlay in self._blocks():
            entry = snapshot.get(key) or {}
            if overlay is None or not isinstance(entry, dict):
                continue
            x, y = entry.get("x"), entry.get("y")
            w, h = entry.get("width"), entry.get("height")
            try:
                if None not in (x, y, w, h):
                    overlay.set_geometry(x, y, w, h)
                overlay._anchor = entry.get("anchor", "custom")
                if entry.get("visible", True) and self.settings.get(f"show_{key}", True):
                    overlay.show()
                else:
                    overlay.hide()
            except Exception:
                pass
        # Персональные настройки и горячие клавиши тоже приехали из профиля —
        # проталкиваем их в живые окна, а не пересоздаём оверлей.
        self.apply_block_style()
        if self.enabled:
            self.register_hotkeys()
        self.master.after(60, self.apply_anchors)
        self.save_settings()
        return True

    def delete_profile(self, name: str) -> bool:
        profiles = self.settings.get("profiles")
        if not isinstance(profiles, dict) or name not in profiles:
            return False
        profiles.pop(name, None)
        if self.active_profile == name:
            self.settings["active_profile"] = ""
        self.save_settings()
        return True

    def set_layout_margin(self, margin: int):
        self.settings["layout_margin"] = max(0, int(margin))
        self.apply_anchors()
        self.save_settings()

    def _on_resized(self, key: str, w: int, h: int):
        self.settings[f"{key}_width"] = w
        self.settings[f"{key}_height"] = h

    def _on_route_moved(self, x: int, y: int):
        self.settings["route_x"] = x
        self.settings["route_y"] = y

    def _on_status_moved(self, x: int, y: int):
        self.settings["status_x"] = x
        self.settings["status_y"] = y

    def _on_ship_moved(self, x: int, y: int):
        self.settings["ship_x"] = x
        self.settings["ship_y"] = y

    def _on_cargo_moved(self, x: int, y: int):
        self.settings["cargo_x"] = x
        self.settings["cargo_y"] = y

    def _on_session_moved(self, x: int, y: int):
        self.settings["session_x"] = x
        self.settings["session_y"] = y

    def _on_events_moved(self, x: int, y: int):
        self.settings["events_x"] = x
        self.settings["events_y"] = y

    def _update_loop(self):
        last_data_hash = None
        ed_active_counter = 0
        last_game_running = False
        while not self._stop.is_set():
            # Игры нет — HUD не нужен вообще (если его не просили держать всегда).
            try:
                game = self.game_state()
            except Exception:
                game = GameState()
            if self.settings.get("hide_when_game_off", True) and not game.running:
                self.master.after(0, lambda: self._set_all_visibility(False))
                last_game_running = False
                # Пока игры нет — простой не копим: вернулись в игру, HUD
                # должен появиться сразу, а не через таймер автоскрытия.
                self.mark_activity()
                time.sleep(1.0)
                continue
            if not last_game_running:
                # Игра только что запустилась (или сменился монитор) —
                # пересчитываем привязку блоков к её окну.
                last_game_running = True
                self.master.after(0, self.apply_anchors)

            # Проверяем, активна ли игра — оверлей topmost только над игрой
            attach = self.settings.get("attach_to_game", True)
            if attach:
                try:
                    # Эвристика по заголовку foreground-окна остаётся страховкой:
                    # окно игры находится не всегда (например, до первого кадра).
                    ed_active = game.focused or _is_ed_foreground()
                    if ed_active:
                        ed_active_counter = 3  # держим visible ещё 3 цикла после потери фокуса
                        if game.focused:
                            self.mark_activity()
                    elif ed_active_counter > 0:
                        ed_active_counter -= 1
                    should_show = ed_active_counter > 0
                    self.master.after(0, lambda s=should_show: self._set_all_visibility(s))
                except Exception:
                    pass
            else:
                # Режим "всегда поверх" — показываем и поднимаем
                self.master.after(0, lambda: self._set_all_visibility(True))

            if self._update_callback:
                try:
                    data = self._update_callback()
                    # Хешируем ключевые данные, чтобы не обновлять оверлей без изменений
                    current_hash = self._hash_data(data)
                    if current_hash != last_data_hash:
                        last_data_hash = current_hash
                        self.master.after(0, lambda d=data: self._apply_update(d))
                except Exception:
                    pass
            with self._log_lock:
                logs = list(self._pending_logs)
                self._pending_logs.clear()
            for msg, level in logs:
                self.master.after(0, lambda m=msg, l=level: self._add_log_safe(m, l))
            time.sleep(1.0)

    def _set_all_visibility(self, show: bool):
        """Показать/скрыть оверлеи. При показе — lift() + topmost для гарантии Z-order.

        Итоговая видимость блока складывается из четырёх условий: HUD вообще
        нужен (`show` — есть игра/фокус), пользователь включил блок, сработало
        правило «по ситуации» и не истёк таймер простоя.
        """
        visibility = self.evaluate_block_visibility(game_visible=show)
        for key, ov in self._blocks():
            if not ov:
                continue
            try:
                should_show = visibility.get(key, show)
                if should_show:
                    if not ov.window.winfo_viewable():
                        ov.show()
                    ov.window.lift()
                    ov.window.attributes("-topmost", True)
                else:
                    ov.hide()
            except Exception:
                pass

    def _hash_data(self, data: dict) -> str:
        """Хеш данных для сравнения изменений между тиками.

        ВАЖНО: сюда нужно включать всё, что реально отображается в
        оверлеях. Раньше хешировалась только часть полей корабля
        (hull/shield/fuel/pips/balance/damaged_count), а сам список модулей
        и их health/power/on — нет. Из-за этого, например, повреждение
        конкретного модуля (когда суммарный damaged_count не менялся —
        модуль уже был повреждён, просто ещё сильнее) не приводило к
        обновлению ShipOverlay вообще: _apply_update() просто не вызывался.
        То же самое было с destination/legal_state/power/fire_group и т.д.
        """
        import hashlib
        parts = []
        ship = data.get("ship", {})
        for key in (
            "ship_type", "ship_name", "ship_ident",
            "hull_percent", "shield_percent",
            "fuel_level", "fuel_capacity", "fuel_reservoir",
            "cargo_count", "cargo_capacity",
            "flags", "flags2",
            "pips_sys", "pips_eng", "pips_wep",
            "balance", "legal_state", "rebuy",
            "fire_group", "gui_focus",
            "destination_system", "destination_body", "destination_name",
            "power_used", "power_capacity",
            "damaged_count", "critical_count",
        ):
            parts.append(str(ship.get(key, "")))
        # Модули по отдельности — иначе изменение health/power/on у
        # конкретного модуля не поймать, если суммарные счётчики
        # (damaged_count/critical_count) не изменились.
        modules = ship.get("modules", [])
        for m in sorted(modules, key=lambda m: m.get("slot", "")):
            parts.append(
                f"{m.get('slot', '')}:{m.get('health', 0)}:{m.get('power', 0)}:{m.get('on', True)}"
            )
        parts.append(str(data.get("visited", 0)))
        parts.append(str(data.get("total", 0)))
        parts.append(str(data.get("current", "")))
        parts.append(str(data.get("online", False)))
        parts.append(str(data.get("watcher_active", False)))
        parts.append(str(data.get("systems_visited", 0)))
        parts.append(str(data.get("deliveries_count", 0)))
        parts.append(str(data.get("cargo_total_tons", 0)))
        parts.append(str(data.get("route_cargo_tons", 0)))
        parts.append(str(data.get("construction_cargo_tons", 0)))
        parts.append(str(data.get("progress", "")))
        parts.append(str(data.get("next_system_info", {})))
        # Состояние игры: HUD должен отреагировать на запуск/выход из игры.
        parts.append(str(data.get("game_running", False)))
        parts.append(str(data.get("game_focused", False)))
        parts.append(str(data.get("game_detail", "")))
        parts.append(str(data.get("exobiology", {})))
        return hashlib.md5("|".join(parts).encode()).hexdigest()

    def _apply_update(self, data: dict):
        # Данные изменились — значит, в журнале есть жизнь: продлеваем показ
        # HUD и пересчитываем контекст для правил «показывать по ситуации».
        self.mark_activity()
        self.update_context(data)
        if self.route_overlay:
            self.route_overlay.update_route(
                data.get("current", "-"), data.get("next", "-"),
                data.get("visited", 0), data.get("total", 0), data.get("remaining"),
                data.get("next_system_info"),
            )
        if self.status_overlay:
            self.status_overlay.set_status(data.get("online", False), data.get("status_detail", ""))
            self.status_overlay.set_game(
                bool(data.get("game_running", False)),
                bool(data.get("game_focused", False)),
                str(data.get("game_detail", "") or ""),
            )
            self.status_overlay.set_watcher(data.get("watcher_active", False))
            self.status_overlay.set_progress(data.get("progress", ""))
            for msg, level in data.get("log_lines", []):
                self._add_log_safe(msg, level)
        if self.ship_overlay:
            ship_data = data.get("ship", {})
            if ship_data:
                self.ship_overlay.update_ship(ship_data)
        if self.cargo_overlay:
            cargo_data = data.get("cargo", {})
            if cargo_data:
                self.cargo_overlay.update_cargo(cargo_data)

        if self.exobio_overlay:
            self.exobio_overlay.update_exobiology(data.get("exobiology"))

        if self.session_overlay:
            current_sys = data.get("current", "-")
            # The helper tracks visited systems independently of the route;
            # use that authoritative counter instead of counting route redraws.
            self._session_stats["systems_visited"] = int(data.get("systems_visited", 0) or 0)
            if current_sys != "-":
                self._session_stats["current_system"] = current_sys

            # These values are already session totals supplied by the helper.
            # Adding them on every overlay tick made the counters grow again
            # even when no new journal event arrived.
            self._session_stats["deliveries_count"] = int(data.get("deliveries_count", 0) or 0)
            self._session_stats["cargo_total_tons"] = float(data.get("cargo_total_tons", 0) or 0)
            self._session_stats["route_deliveries_count"] = int(data.get("route_deliveries_count", 0) or 0)
            self._session_stats["route_cargo_tons"] = float(data.get("route_cargo_tons", 0) or 0)
            self._session_stats["construction_cargo_tons"] = float(data.get("construction_cargo_tons", 0) or 0)

            ship = data.get("ship", {})
            self._session_stats["cargo_count"] = ship.get("cargo_count", 0)

            self.session_overlay.update_session(self._session_stats)

    def _add_log_safe(self, message: str, level: str = "info"):
        if self.status_overlay:
            self.status_overlay.add_log(message, level)

    def log(self, message: str, level: str = "info"):
        with self._log_lock:
            self._pending_logs.append((message, level))

    def log_session_event(self, message: str, level: str = "info"):
        if self.events_overlay:
            self.master.after(0, lambda m=message, l=level: self.events_overlay.add_event(m, l))

    def stop(self):
        self.enabled = False
        self._stop.set()
        self.hotkeys.stop()
        self.save_settings()
        for _key, ov in self._blocks():
            self.master.after(0, ov.destroy)
        self.route_overlay = None
        self.status_overlay = None
        self.ship_overlay = None
        self.cargo_overlay = None
        self.session_overlay = None
        self.events_overlay = None
        self.exobio_overlay = None

    def toggle(self, update_callback: Callable):
        if self.enabled:
            self.stop()
        else:
            self.start(update_callback)

    def toggle_visibility(self):
        for _key, ov in self._blocks():
            ov.toggle()

    def set_alpha(self, alpha: float):
        self.settings["alpha"] = alpha
        for _key, ov in self._blocks():
            ov.set_alpha(alpha)

    def set_font(self, family: str, size: int):
        """Смена шрифта на лету: окна не пересоздаются.

        Раньше здесь перезапускался весь оверлей — окна мигали и теряли
        позицию. Теперь каждый блок сам перекрашивает свои виджеты
        (`OverlayWindow.apply_font`), а у блоков с собственным размером
        шрифта он сохраняется.
        """
        try:
            self.settings["font_size"] = max(6, min(28, int(size)))
        except (TypeError, ValueError):
            return
        self.settings["font_family"] = family
        self.apply_block_style()
        self.save_settings()

    def set_show_route(self, show: bool):
        self.set_block_visible("route", show)

    def set_show_status(self, show: bool):
        self.set_block_visible("status", show)

    def set_show_ship(self, show: bool):
        self.set_block_visible("ship", show)

    def set_show_cargo(self, show: bool):
        self.set_block_visible("cargo", show)

    def set_show_session(self, show: bool):
        self.set_block_visible("session", show)

    def set_ship_block(self, block: str, show: bool):
        """Внутренние блоки SHIP (pips, щиты, модули…).

        Содержимое окна собирается при создании, поэтому окно пересоздаётся,
        но позицию, прозрачность, шрифт и блокировку возвращаем сразу же —
        для пользователя это выглядит как мгновенная перерисовка одного блока.
        """
        self.settings[f"show_{block}"] = show
        if self.ship_overlay and self.enabled:
            was_visible = self.ship_overlay.window.winfo_viewable()
            self.ship_overlay.destroy()
            self.ship_overlay = ShipOverlay(self.master, self.settings)
            self.ship_overlay.set_on_move(self._on_ship_moved)
            self.ship_overlay.set_on_resize(lambda w, h: self._on_resized("ship", w, h))
            self.ship_overlay.set_area_provider(self.overlay_area)
            self.ship_overlay._register_fonts()
            self.ship_overlay._apply_anchor(self.overlay_area())
            self.apply_block_style("ship")
            if not was_visible or not self.settings.get("show_ship", True):
                self.ship_overlay.hide()

    def set_attach_to_game(self, attach: bool):
        self.settings["attach_to_game"] = attach

    # ============================================================
    #  Настройки блоков: вид, размер, поведение — всё на лету
    # ============================================================
    def _overlay_for(self, key: str):
        """Живое окно блока или None (оверлей выключен)."""
        for block_key, overlay in self._blocks():
            if block_key == key:
                return overlay
        return None

    def _notify_block(self, key: str, name: str, value: Any):
        """Сообщить UI об изменении настройки (в т.ч. по горячей клавише)."""
        callback = getattr(self, "on_settings_changed", None)
        if callback:
            try:
                callback(key, name, value)
            except Exception:
                pass

    def set_block_visible(self, key: str, show: bool, save: bool = True):
        """Показать/скрыть блок сразу (без пересоздания окна)."""
        self.settings[f"show_{key}"] = bool(show)
        overlay = self._overlay_for(key)
        if overlay is not None:
            try:
                overlay.show() if show else overlay.hide()
            except Exception:
                pass
        if save:
            self.save_settings()
        self._notify_block(key, "visible", bool(show))

    def toggle_block(self, key: str):
        """Переключить блок (горячая клавиша)."""
        show = not bool(self.settings.get(f"show_{key}", True))
        self.set_block_visible(key, show)
        label = BLOCK_LABELS.get(key, key)
        self.log(f"{label}: {'показан' if show else 'скрыт'} (горячая клавиша)", "info")

    def toggle_all_blocks(self):
        """Показать все блоки или спрятать все (F12 и т.п.)."""
        any_visible = any(self.settings.get(f"show_{key}", True) for key in self.BLOCKS)
        for key in self.BLOCKS:
            self.set_block_visible(key, not any_visible, save=False)
        self.save_settings()
        self._notify_block("", "visible", not any_visible)

    def set_block_locked(self, key: str, locked: bool):
        self.settings[f"{key}_locked"] = bool(locked)
        overlay = self._overlay_for(key)
        if overlay is not None:
            overlay.set_locked(bool(locked))
        self.save_settings()
        self._notify_block(key, "locked", bool(locked))

    def set_block_alpha(self, key: str, alpha: Optional[float]):
        """Прозрачность блока. `None` — вернуть общую настройку."""
        if alpha is None:
            self.settings.pop(f"{key}_alpha", None)
            value = float(self.settings.get("alpha", 0.90) or 0.90)
        else:
            try:
                value = max(0.1, min(1.0, float(alpha)))
            except (TypeError, ValueError):
                return
            self.settings[f"{key}_alpha"] = value
        overlay = self._overlay_for(key)
        if overlay is not None:
            overlay.set_alpha(value, save=False)
        self.save_settings()
        self._notify_block(key, "alpha", value)

    def set_block_font_size(self, key: str, size: Optional[int]):
        """Размер шрифта блока. `None` — вернуть общий размер."""
        if size in (None, ""):
            self.settings.pop(f"{key}_font_size", None)
            value = int(self.settings.get("font_size", 10) or 10)
        else:
            try:
                value = max(6, min(28, int(size)))
            except (TypeError, ValueError):
                return
            self.settings[f"{key}_font_size"] = value
        overlay = self._overlay_for(key)
        if overlay is not None:
            overlay.apply_font(self.settings.get("font_family", "Consolas"), value)
        self.save_settings()
        self._notify_block(key, "font_size", value)

    def set_block_size(self, key: str, width: int, height: int):
        """Размер блока прямо сейчас."""
        try:
            width = max(120, int(width))
            height = max(80, int(height))
        except (TypeError, ValueError):
            return
        self.settings[f"{key}_width"] = width
        self.settings[f"{key}_height"] = height
        overlay = self._overlay_for(key)
        if overlay is not None:
            overlay.set_size(width, height)
        self.save_settings()
        self._notify_block(key, "size", (width, height))

    def apply_size_preset(self, preset: str, key: Optional[str] = None):
        """Пресет размера для одного блока или для всех сразу."""
        keys = (key,) if key else self.BLOCKS
        changed = False
        for block_key in keys:
            size = preset_size(block_key, preset)
            if not size:
                continue
            width, height = size
            self.settings[f"{block_key}_width"] = width
            self.settings[f"{block_key}_height"] = height
            overlay = self._overlay_for(block_key)
            if overlay is not None:
                overlay.set_size(width, height)
            self._notify_block(block_key, "size", (width, height))
            changed = True
        if changed:
            self.save_settings()
        return changed

    def set_click_through(self, enabled: bool, key: Optional[str] = None):
        """Клик-сквозь: для одного блока или для всех (`key=None`)."""
        if key:
            self.settings[f"{key}_click_through"] = bool(enabled)
            overlay = self._overlay_for(key)
            if overlay is not None:
                overlay.set_click_through(bool(enabled), save_key=None)
            self._notify_block(key, "click_through", bool(enabled))
        else:
            self.settings["click_through"] = bool(enabled)
            for block_key, overlay in self._blocks():
                if self.settings.get(f"{block_key}_click_through") is not None:
                    continue  # у блока своё значение — общую правку не применяем
                overlay.set_click_through(bool(enabled), save_key=None)
                self._notify_block(block_key, "click_through", bool(enabled))
        self.save_settings()

    def set_auto_rule(self, key: str, rule: str):
        """Правило автопоказа: `always`, `docked`, `has_cargo`, ..."""
        if rule not in AUTO_RULES:
            rule = "always"
        self.settings[f"{key}_auto_rule"] = rule
        self.save_settings()
        self._notify_block(key, "auto_rule", rule)

    def set_auto_rules_enabled(self, enabled: bool):
        self.settings["auto_rules_enabled"] = bool(enabled)
        self.save_settings()
        self.log("Показ блоков по ситуации включён" if enabled
                 else "Показ блоков по ситуации выключен", "info")

    def set_idle_timeout(self, seconds: int):
        """Через сколько секунд без событий прятать HUD (0 — не прятать)."""
        try:
            self.settings["idle_timeout"] = max(0, int(seconds))
        except (TypeError, ValueError):
            self.settings["idle_timeout"] = 0
        self._last_activity = time.monotonic()
        self.save_settings()

    def reset_block(self, key: str):
        """Вернуть блок к стандарту: позиция, размер, вид, поведение."""
        x, y, width, height = DEFAULT_BLOCK_POSITIONS.get(key, (50, 50, 280, 200))
        for suffix in ("alpha", "font_size", "click_through"):
            self.settings.pop(f"{key}_{suffix}", None)
        self.settings[f"{key}_locked"] = False
        self.settings[f"{key}_auto_rule"] = "always"
        self.settings[f"{key}_anchor"] = "custom"
        self.settings[f"{key}_x"] = x
        self.settings[f"{key}_y"] = y
        self.settings[f"{key}_width"] = width
        self.settings[f"{key}_height"] = height
        overlay = self._overlay_for(key)
        if overlay is not None:
            try:
                overlay._anchor = "custom"
                overlay.set_geometry(x, y, width, height)
                overlay.set_locked(False)
                overlay.set_alpha(resolve_block_alpha(self.settings, key), save=False)
                overlay.apply_font(self.settings.get("font_family", "Consolas"),
                                   resolve_block_font_size(self.settings, key))
                overlay.set_click_through(block_click_through(self.settings, key),
                                          save_key=None)
                overlay.show() if self.settings.get(f"show_{key}", True) else overlay.hide()
            except Exception:
                pass
        self.save_settings()
        self._notify_block(key, "reset", True)

    def apply_block_style(self, key: Optional[str] = None):
        """Протолкнуть все персональные настройки в живые окна."""
        family = self.settings.get("font_family", "Consolas")
        for block_key, overlay in self._blocks():
            if key and block_key != key:
                continue
            try:
                overlay.set_alpha(resolve_block_alpha(self.settings, block_key), save=False)
                overlay.apply_font(family, resolve_block_font_size(self.settings, block_key))
                overlay.set_locked(bool(self.settings.get(f"{block_key}_locked", False)))
                overlay.set_click_through(block_click_through(self.settings, block_key),
                                          save_key=None)
            except Exception:
                pass

    # ============================================================
    #  Поведение: автопоказ по ситуации и автоскрытие при простое
    # ============================================================
    def mark_activity(self):
        """Отметить активность: HUD не должен прятаться, пока идут события."""
        self._last_activity = time.monotonic()
        self._hidden_by_idle = False

    def idle_timeout(self) -> int:
        try:
            return max(0, int(self.settings.get("idle_timeout", 0) or 0))
        except (TypeError, ValueError):
            return 0

    def update_context(self, data: Optional[dict] = None):
        """Собрать контекст ситуации из последних данных и состояния игры."""
        data = data or {}
        ship = data.get("ship") or {}
        flags = ship.get("flags_list")
        if not flags and (ship.get("flags") or ship.get("flags2")):
            flags = decode_status_flags(int(ship.get("flags") or 0),
                                        int(ship.get("flags2") or 0))
        flags = list(flags or [])
        exobio = data.get("exobiology") or {}
        game = self.game_state()
        context = {
            "flags": flags,
            "docked": "Docked" in flags,
            "cargo_count": float(ship.get("cargo_count")
                                 or (data.get("cargo") or {}).get("cargo_count") or 0),
            "bio_signals": int((exobio.get("bio_signals") if isinstance(exobio, dict) else 0) or 0),
            "route_total": int(data.get("total") or 0),
            "game_running": bool(data.get("game_running", game.running)),
            "game_focused": bool(data.get("game_focused", game.focused)),
        }
        self._context_state = context
        return context

    def evaluate_block_visibility(self, context: Optional[dict] = None,
                                  game_visible: bool = True) -> Dict[str, bool]:
        """Кому из блоков сейчас можно быть на экране.

        Складывается из четырёх условий: игра показывает HUD вообще,
        пользователь включил блок, сработало правило «по ситуации» и не
        истёк таймер простоя.
        """
        ctx = context if context is not None else (self._context_state or {})
        timeout = self.idle_timeout()
        idle_hidden = timeout > 0 and (time.monotonic() - self._last_activity) > timeout
        self._hidden_by_idle = idle_hidden
        rules_on = bool(self.settings.get("auto_rules_enabled", False))
        result: Dict[str, bool] = {}
        for key in self.BLOCKS:
            visible = bool(game_visible) and bool(self.settings.get(f"show_{key}", True))
            if visible and idle_hidden:
                visible = False
            if visible and rules_on:
                visible = auto_rule_matches(self.settings.get(f"{key}_auto_rule", "always"), ctx)
            result[key] = visible
        return result

    # ============================================================
    #  Горячие клавиши
    # ============================================================
    def register_hotkeys(self):
        """Зарегистрировать системные горячие клавиши блоков."""
        if not self.enabled:
            self.hotkeys.stop()
            return
        self.hotkeys.clear()
        for key in self.BLOCKS:
            combo = str(self.settings.get(f"{key}_hotkey", "") or "").strip()
            if combo:
                self.hotkeys.register(combo, lambda k=key: self.toggle_block(k))
        all_combo = str(self.settings.get("toggle_all_hotkey", "F12") or "").strip()
        if all_combo:
            self.hotkeys.register(all_combo, self.toggle_all_blocks)
        self.hotkeys.start()

    def set_block_hotkey(self, key: str, combo: str) -> bool:
        """Назначить блоку горячую клавишу ('' — снять)."""
        combo = (combo or "").strip()
        if combo:
            self.settings[f"{key}_hotkey"] = combo
        else:
            self.settings.pop(f"{key}_hotkey", None)
        self.save_settings()
        if self.enabled:
            self.register_hotkeys()
        return True

    def save_settings(self):
        save_overlay_settings(self.config_path, self.settings)


# ============================================================
#  Настройки оверлея
# ============================================================
DEFAULT_SETTINGS = {
    "alpha": 0.90,
    "font_family": "Consolas",
    "font_size": 10,
    "show_route": True,
    "show_status": True,
    "show_ship": True,
    "show_cargo": True,
    "show_session": True,
    "show_events": True,
    "show_exobio": True,
    "show_flags": True,
    "show_pips": True,
    "show_hull": True,
    "show_shield": True,
    "show_fuel": True,
    "show_power": True,
    "show_cargo_info": True,
    "show_balance": True,
    "show_legal": True,
    "show_destination": True,
    "show_modules": True,
    "route_x": 50,
    "route_y": 50,
    "route_width": 280,
    "route_height": 160,
    "route_locked": False,
    "route_anchor": "custom",
    "status_x": 50,
    "status_y": 220,
    "status_width": 280,
    "status_height": 220,
    "status_locked": False,
    "status_anchor": "custom",
    "ship_x": 50,
    "ship_y": 440,
    "ship_width": 360,
    "ship_height": 420,
    "ship_locked": False,
    "ship_anchor": "custom",
    "cargo_x": 50,
    "cargo_y": 1000,
    "cargo_width": 300,
    "cargo_height": 340,
    "cargo_locked": False,
    "cargo_anchor": "custom",
    "session_x": 400,
    "session_y": 50,
    "session_width": 320,
    "session_height": 300,
    "session_locked": False,
    "session_anchor": "custom",
    "events_x": 730,
    "events_y": 50,
    "events_width": 320,
    "events_height": 260,
    "events_locked": False,
    "events_anchor": "custom",
    "exobio_x": 1060,
    "exobio_y": 50,
    "exobio_width": 330,
    "exobio_height": 360,
    "exobio_locked": False,
    "exobio_anchor": "custom",
    "attach_to_game": True,
    # Раскладка: отступ от края области (экрана или окна игры)
    "layout_margin": 24,
    # Прятать HUD, когда игра не запущена
    "hide_when_game_off": True,
    # Клик-сквозь по умолчанию для всех блоков (мышь работает в игре)
    "click_through": False,
    # Скрывать HUD, если в журнале нет событий дольше N секунд (0 — не скрывать)
    "idle_timeout": 0,
    # Учитывать правила «показывать блок по ситуации»
    "auto_rules_enabled": False,
    # Горячая клавиша «показать/скрыть все блоки»
    "toggle_all_hotkey": "F12",
    # Профили раскладки: {имя: {блок: {x,y,width,height,anchor,visible}, ...}}
    "profiles": {},
    "active_profile": "",
}


def load_overlay_settings(config_path: Path) -> dict:
    if config_path.exists():
        try:
            import json
            with open(config_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            merged = dict(DEFAULT_SETTINGS)
            merged.update(data)
            return merged
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)


def save_overlay_settings(config_path: Path, settings: dict):
    """Сохранить только HUD-настройки, не затирая API credentials.

    До версии 2.0 overlay сохранял весь словарь settings обратно в общий
    config-файл. При этом в него иногда попадали только параметры overlay,
    и ключи Raven/EDSM/Inara исчезали при закрытии или обновлении программы.
    Общий файл оставляем для совместимости, но делаем merge только известных
    HUD-ключей.
    """
    try:
        import json
        config_path.parent.mkdir(parents=True, exist_ok=True)
        existing = {}
        if config_path.exists():
            try:
                with open(config_path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    existing = loaded
            except (OSError, ValueError):
                existing = {}
        overlay_keys = set(DEFAULT_SETTINGS)
        overlay_keys.update(key for key in settings if key.startswith((
            "route_", "status_", "ship_", "cargo_", "session_", "events_", "exobio_",
        )))
        existing.update({key: settings[key] for key in overlay_keys if key in settings})
        tmp = config_path.with_suffix(config_path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        tmp.replace(config_path)
    except Exception:
        pass
