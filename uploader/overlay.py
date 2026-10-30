"""Менеджер HUD оверлея: блоки, их показ, раскладка и настройки.

Сами окна блоков живут в `overlay_blocks.py` (нативные Qt-виджеты), корпус
окна — в `hud_window.py`, чистые расчёты раскладки — в `overlay_layout.py`.
Здесь остаётся то, что связывает их с игрой: цикл обновления, горячие
клавиши, экраны, автоскрытие и сохранение настроек.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from PySide6.QtWidgets import QWidget

import ship_hud
from game_monitor import (
    GameMonitor,
    GameState,
    _is_own_window,
    _own_pid,
    _win32_find_game_window,
    _win32_window_pid,
)
from hotkeys import HotkeyManager
from hud_window import (
    COLOR_ACCENT,
    COLOR_ACCENT_HOVER,
    COLOR_BG,
    COLOR_BORDER,
    COLOR_BORDER_ACTIVE,
    COLOR_CYAN,
    COLOR_GREEN,
    COLOR_GREEN_TEXT,
    COLOR_LINE,
    COLOR_PANEL,
    COLOR_PANEL_ALT,
    COLOR_PANEL_HOVER,
    COLOR_RED,
    COLOR_RED_TEXT,
    COLOR_SURFACE,
    COLOR_TEXT,
    COLOR_TEXT_DIM,
    COLOR_TEXT_MUTED,
    COLOR_YELLOW,
    OVERLAY_META,
    HudWindow as OverlayWindow,
)
from hud_win32 import (
    _foreground_window,
    _get_ed_hwnd,
    _hwnd_of,
    _is_ed_foreground,
    _set_click_through,
    _set_window_topmost,
    _toplevel_hwnd,
    _user32,
    _window_pid,
)
from overlay_blocks import (  # noqa: F401 — имена живут здесь для совместимости
    CargoOverlay,
    CarrierOverlay,
    ExobiologyOverlay,
    FootMapOverlay,
    RouteOverlay,
    SessionEventsOverlay,
    SessionOverlay,
    ShipOverlay,
    StatusOverlay,
    _section_text,
    _species_tail,
    format_table,
    is_monospace_font,
)
from overlay_layout import (
    ANCHOR_KEYS,
    ANCHOR_LABELS,
    AUTO_RULE_LABELS,
    AUTO_RULES,
    BLOCK_LABELS,
    DEFAULT_BLOCK_POSITIONS,
    IDLE_TIMEOUTS,
    LAYOUT_GLOBAL_KEYS,
    SIZE_PRESET_LABELS,
    SIZE_PRESETS,
    ZORDER_REFRESH_SECONDS,
    apply_layout_snapshot,
    auto_rule_matches,
    block_click_through,
    block_detached,
    capture_layout_snapshot,
    compute_anchored_position,
    legacy_click_through,
    preset_size,
    resolve_block_alpha,
    resolve_block_font_size,
)
from overlay_options import (
    CARRIER_FILTERS,
    CONTENT_DEFAULTS,
    CONTENT_OPTIONS,
    filter_carrier_rows,
    option_key,
)
from screens import (
    MonitorInfo,
    fit_into_area,
    header_visible,
    list_monitors,
    monitor_for_area,
    translate_between_areas,
)
from exobiology import estimate_value, format_credits
from ship_tracker import decode_status_flags

#: Публичные имена модуля: окна блоков, расчёты раскладки, цвета и утилиты
#: Win32 переехали в соседние модули, но импортируются по-прежнему отсюда —
#: через `overlay` их берут и `colonial_helper`, и тесты.
__all__ = [
    # окна
    "OverlayWindow", "RouteOverlay", "StatusOverlay", "ShipOverlay",
    "CargoOverlay", "CarrierOverlay", "ExobiologyOverlay", "FootMapOverlay",
    "SessionOverlay",
    "SessionEventsOverlay", "OverlayManager",
    # раскладка и настройки блоков
    "ANCHOR_KEYS", "ANCHOR_LABELS", "AUTO_RULES", "AUTO_RULE_LABELS",
    "BLOCK_LABELS", "DEFAULT_BLOCK_POSITIONS", "IDLE_TIMEOUTS",
    "LAYOUT_GLOBAL_KEYS", "SIZE_PRESETS", "SIZE_PRESET_LABELS",
    "ZORDER_REFRESH_SECONDS", "apply_layout_snapshot", "auto_rule_matches", "block_click_through",
    "block_detached", "capture_layout_snapshot", "compute_anchored_position",
    "legacy_click_through", "preset_size", "resolve_block_alpha",
    "resolve_block_font_size",
    # содержимое блоков и утилиты текста
    "CARRIER_FILTERS", "CONTENT_DEFAULTS", "CONTENT_OPTIONS",
    "filter_carrier_rows", "option_key", "format_table", "is_monospace_font",
    "_section_text", "_species_tail",
    # экраны
    "MonitorInfo", "fit_into_area", "header_visible", "list_monitors",
    "monitor_for_area", "translate_between_areas",
    # игра и Win32
    "GameMonitor", "GameState", "_is_own_window", "_own_pid",
    "_win32_find_game_window", "_win32_window_pid", "decode_status_flags",
    "_foreground_window", "_get_ed_hwnd", "_hwnd_of", "_is_ed_foreground",
    "_set_click_through", "_set_window_topmost", "_toplevel_hwnd", "_user32",
    "_window_pid", "ship_hud", "estimate_value", "format_credits",
    # палитра HUD
    "COLOR_ACCENT", "COLOR_ACCENT_HOVER", "COLOR_BG", "COLOR_BORDER",
    "COLOR_BORDER_ACTIVE", "COLOR_CYAN", "COLOR_GREEN", "COLOR_GREEN_TEXT",
    "COLOR_LINE", "COLOR_PANEL", "COLOR_PANEL_ALT", "COLOR_PANEL_HOVER",
    "COLOR_RED", "COLOR_RED_TEXT", "COLOR_SURFACE", "COLOR_TEXT",
    "COLOR_TEXT_DIM", "COLOR_TEXT_MUTED", "COLOR_YELLOW", "OVERLAY_META",
]


class OverlayManager:
    #: Блоки HUD: ключ -> (настройка видимости, класс окна)
    BLOCKS = ("route", "status", "ship", "cargo", "session", "events", "exobio",
              "carrier", "footmap")

    #: Позиции по умолчанию для «Сбросить позиции» (x, y, w, h)
    DEFAULT_POSITIONS = DEFAULT_BLOCK_POSITIONS

    def __init__(self, master, config_path: Path, game_monitor=None):
        self.master = master
        self.config_path = config_path
        self.settings = load_overlay_settings(config_path)
        # Отдаёт состояние EXOBIO для принудительной перерисовки блока после
        # смены фильтров (подключает приложение, см. set_exobio_state_provider).
        self._exobio_state_provider = None
        # Отслеживание игры: запущена/в фокусе + геометрия окна.
        self.game_monitor = game_monitor or GameMonitor()
        self.route_overlay: Optional[RouteOverlay] = None
        self.status_overlay: Optional[StatusOverlay] = None
        self.ship_overlay: Optional[ShipOverlay] = None
        self.cargo_overlay: Optional[CargoOverlay] = None
        self.session_overlay: Optional[SessionOverlay] = None
        self.events_overlay: Optional[SessionEventsOverlay] = None
        self.exobio_overlay: Optional[ExobiologyOverlay] = None
        self.carrier_overlay: Optional[CarrierOverlay] = None
        self.footmap_overlay: Optional[FootMapOverlay] = None
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
        # Когда в последний раз переставляли блоки в Z-order (см.
        # _set_all_visibility и ZORDER_REFRESH_SECONDS).
        self._zorder_at = 0.0
        # Экраны (кэш на пару секунд): нужны отвязанным блокам и меню «Экран».
        self._monitors_cache: List[MonitorInfo] = []
        self._monitors_at = 0.0
        # HWND окон оверлея и главного окна Helper. Заполняет поток Tk, читает
        # фоновый цикл: пока пользователь тянет блок или открыл его меню,
        # фокус у нашего окна, и HUD не должен прятаться как «игра не в фокусе».
        self._overlay_hwnds: frozenset = frozenset()
        self._helper_hwnd: Optional[int] = None
        # Открыта вкладка «Оверлей»: HUD остаётся на экране, пока его настраивают.
        self._ui_editing = False
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
        self.carrier_overlay = CarrierOverlay(self.master, self.settings)
        self.footmap_overlay = FootMapOverlay(self.master, self.settings)

        for key, ov in self._blocks():
            self._wire_block(key, ov)
            ov.apply_data_options()
            # Содержимое уже собрано — запоминаем шрифты и применяем
            # персональные настройки блока (свой размер шрифта/прозрачность).
            ov._register_fonts()
            ov.apply_font(self.settings.get("font_family", "Consolas"),
                          resolve_block_font_size(self.settings, key))
            ov.set_alpha(resolve_block_alpha(self.settings, key), save=False)
            # Экран, на котором стоял блок, могли отключить — возвращаем блок
            # на ближайший, иначе его не достать мышью.
            self.ensure_block_on_screen(key)
            if not self.settings.get(f"show_{key}", True):
                ov.hide()

        try:
            self._helper_hwnd = _toplevel_hwnd(self.master)
        except Exception:
            self._helper_hwnd = None
        # Применяем якоря после того, как все окна созданы и знают свой размер.
        self.master.after(60, self.apply_anchors)
        self.register_hotkeys()

    def _wire_block(self, key: str, ov):
        """Подключить окно блока к менеджеру (при создании и пересоздании)."""
        ov.set_on_move(self._make_moved_handler(key))
        ov.set_on_resize(lambda w, h, k=key: self._on_resized(k, w, h))
        if hasattr(ov, "set_on_release"):
            ov.set_on_release(lambda k=key: self._on_block_released(k))
        # Якоря считаем относительно экрана с игрой — или своего экрана у
        # отвязанного блока (см. block_area).
        ov.set_area_provider(lambda k=key: self.block_area(k))
        if hasattr(ov, "set_controller"):
            ov.set_controller(self)

    def _on_block_released(self, key: str):
        """Блок отпустили после перетаскивания/ресайза: сохранить и сообщить UI."""
        self.save_settings()
        self._notify_block(key, "position", None)

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
            "carrier": self.carrier_overlay,
            "footmap": self.footmap_overlay,
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
        screen = self.master.screen() if isinstance(self.master, QWidget) else None
        if screen is None:
            return (0, 0, 1920, 1080)
        geometry = screen.geometry()
        return (geometry.x(), geometry.y(), geometry.width(), geometry.height())

    def overlay_area(self) -> Tuple[int, int, int, int]:
        """Область, внутри которой раскладываются блоки HUD.

        Если включена привязка к окну игры и игра запущена — это прямоугольник
        монитора с игрой (так оверлей не уедет на другой экран). Иначе — весь
        основной экран. У отвязанного блока область своя — см. block_area().
        """
        if self.settings.get("attach_to_game", True):
            state = self.game_state()
            monitor = state.monitor
            if monitor:
                left, top, right, bottom = monitor
                return (left, top, max(1, right - left), max(1, bottom - top))
        return self.screen_area()

    # -- экраны и отвязанные блоки -------------------------------------------
    def monitors(self) -> List[MonitorInfo]:
        """Подключённые экраны (основной — первый). Кэш на пару секунд.

        Вне Windows (и если Win32 не ответил) — один экран размером с
        основной: так меню и раскладка работают одинаково везде.
        """
        now = time.monotonic()
        if self._monitors_cache and now - self._monitors_at < 2.0:
            return list(self._monitors_cache)
        found = []
        try:
            found = list_monitors()
        except Exception:
            found = []
        if not found:
            x, y, w, h = self.screen_area()
            rect = (x, y, x + w, y + h)
            found = [MonitorInfo(index=1, work=rect, bounds=rect, primary=True)]
        self._monitors_cache = list(found)
        self._monitors_at = now
        return list(found)

    def block_detached(self, key: str) -> bool:
        return block_detached(self.settings, key)

    def _block_rect(self, key: str) -> Tuple[int, int, int, int]:
        """Геометрия блока (x, y, w, h).

        Позицию берём из настроек: её обновляют и перетаскивание, и якоря, и
        перенос на другой экран — причём сразу, а Tk отдаёт новые координаты
        окна только после обработки отложенных задач. Размер — у живого окна,
        если Tk его уже знает.
        """
        default = DEFAULT_BLOCK_POSITIONS.get(key, (50, 50, 280, 200))
        values = []
        for suffix, fallback in zip(("x", "y", "width", "height"), default):
            try:
                values.append(int(self.settings.get(f"{key}_{suffix}", fallback)))
            except (TypeError, ValueError):
                values.append(int(fallback))
        overlay = self._overlay_for(key)
        if overlay is not None:
            try:
                width, height = overlay.size()
                if int(width) > 1 and int(height) > 1:
                    values[2], values[3] = int(width), int(height)
            except Exception:
                pass
        return tuple(values)

    def block_monitor(self, key: str) -> Optional[MonitorInfo]:
        """Экран, на котором сейчас стоит блок."""
        return monitor_for_area(self._block_rect(key), self.monitors())

    def block_area(self, key: str) -> Tuple[int, int, int, int]:
        """Область якорей блока: экран с игрой — или свой экран отвязанного."""
        if not self.block_detached(key):
            return self.overlay_area()
        monitor = self.block_monitor(key)
        if monitor is not None:
            return monitor.work_area
        return self.screen_area()

    def ensure_block_on_screen(self, key: str, save: bool = False) -> bool:
        """Вернуть блок на экран, если его шапка не видна ни на одном мониторе.

        Так бывает, когда отвязанный блок стоял на втором мониторе, а тот
        отключили: окно жило бы за краем, и достать его мышью было бы нельзя.
        """
        overlay = self._overlay_for(key)
        if overlay is None:
            return False
        monitors = self.monitors()
        x, y, w, h = self._block_rect(key)
        if header_visible((x, y, w, h), monitors):
            return False
        target = monitor_for_area((x, y, w, h), monitors)
        if target is None:
            return False
        nx, ny = fit_into_area(x, y, w, h, target.work_area)
        try:
            overlay.set_position(nx, ny, save=True)
        except Exception:
            return False
        if save:
            self.save_settings()
        return True

    def set_block_detached(self, key: str, detached: bool, move_to_game: bool = False):
        """Отвязать блок от игры (или привязать обратно).

        Отвязанный блок виден и без фокуса игры и раскладывается по якорю
        внутри своего экрана. `move_to_game` — при возврате к игре перенести
        блок на экран с игрой (выбор «с игрой» во вкладке «Оверлей»).
        """
        detached = bool(detached)
        self.settings[f"{key}_detached"] = detached
        overlay = self._overlay_for(key)
        if overlay is not None:
            try:
                overlay.set_detached(detached, save=False)
            except Exception:
                pass
        area = None
        if not detached and move_to_game:
            area = self.overlay_area()
            self._move_block_into(key, area)
        self._reanchor(key, area)
        self.save_settings()
        self._notify_block(key, "detached", detached)

    def move_block_to_monitor(self, key: str, index: int) -> bool:
        """Отвязать блок от игры и перенести на экран `index` (1 — основной)."""
        monitors = self.monitors()
        target = next((m for m in monitors if m.index == int(index)), None)
        if target is None:
            return False
        self.settings[f"{key}_detached"] = True
        overlay = self._overlay_for(key)
        if overlay is not None:
            try:
                overlay.set_detached(True, save=False)
            except Exception:
                pass
        # Оверлей может быть выключен — тогда переносим сохранённую позицию,
        # и блок появится уже на новом экране.
        self._move_block_into(key, target.work_area)
        self._reanchor(key, target.work_area)
        self.save_settings()
        self._notify_block(key, "detached", True)
        self.log(f"{BLOCK_LABELS.get(key, key)}: отвязан от игры → {target.label()}", "info")
        return True

    def _move_block_into(self, key: str, area: Tuple[int, int, int, int]):
        """Перенести блок в область (экран), сохранив его место «по смыслу»."""
        if not area:
            return
        x, y, w, h = self._block_rect(key)
        ax, ay, aw, ah = area
        cx, cy = x + w // 2, y + h // 2
        if ax <= cx < ax + aw and ay <= cy < ay + ah:
            return  # блок уже на этом экране
        source = monitor_for_area((x, y, w, h), self.monitors())
        nx, ny = translate_between_areas(x, y, w, h,
                                         source.work_area if source else None, area)
        overlay = self._overlay_for(key)
        if overlay is None:
            self.settings[f"{key}_x"] = int(nx)
            self.settings[f"{key}_y"] = int(ny)
            return
        try:
            overlay.set_position(nx, ny, save=True)
        except Exception:
            pass

    def _reanchor(self, key: str, area: Optional[Tuple[int, int, int, int]] = None):
        """Переставить блок по якорю. `area` — если окно только что двигали:
        Tk отдаёт новые координаты окна не сразу, и экран по ним не узнать."""
        overlay = self._overlay_for(key)
        if overlay is None:
            return
        anchor = self.settings.get(f"{key}_anchor", "custom")
        if not anchor or anchor == "custom":
            return
        try:
            overlay._apply_anchor(area or self.block_area(key))
        except Exception:
            pass

    def apply_anchors(self):
        """Расставить все блоки по их якорям внутри их областей."""
        for key, overlay in self._blocks():
            anchor = self.settings.get(f"{key}_anchor", "custom")
            if not anchor or anchor == "custom":
                continue
            try:
                overlay._apply_anchor(self.block_area(key))
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
                overlay._apply_anchor(self.block_area(key))
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
            if not game.running:
                # `hide_when_game_off` is an explicit user choice. Previously
                # the unchecked option only skipped this early hide, but the
                # `attach_to_game` branch below hid the windows again because
                # there was no focused game window. That made the setting look
                # intermittent and its UI message (“show even without game”)
                # was false in practice.
                hide_without_game = bool(self.settings.get("hide_when_game_off", True))
                self.master.after(0, lambda show=not hide_without_game: self._set_all_visibility(show))
                last_game_running = False
                ed_active_counter = 0
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

            # Фокус у окна самого оверлея (блок тянут, открыто его меню, идёт
            # настройка во вкладке «Оверлей») — это тоже «игра»: раньше HUD
            # прятался через три секунды прямо под курсором у того, кто его
            # настраивал, а таймер простоя прятал его посреди настройки.
            try:
                own_focus = self._own_overlay_in_focus()
            except Exception:
                own_focus = False
            if own_focus:
                self.mark_activity()
            # Проверяем, активна ли игра — оверлей topmost только над игрой
            attach = self.settings.get("attach_to_game", True)
            if attach:
                try:
                    # Эвристика по заголовку foreground-окна остаётся страховкой:
                    # окно игры находится не всегда (например, до первого кадра).
                    ed_active = game.focused or own_focus or _is_ed_foreground()
                    if ed_active:
                        ed_active_counter = 3  # держим visible ещё 3 цикла после потери фокуса
                        if game.focused:
                            self.mark_activity()
                    elif ed_active_counter > 0:
                        ed_active_counter -= 1
                    should_show = ed_active_counter > 0
                    # Отвязанные от игры блоки видны и без её фокуса.
                    self.master.after(0, lambda s=should_show: self._set_all_visibility(s, detached=True))
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

    def _own_overlay_in_focus(self) -> bool:
        """В фокусе наше окно, рядом с которым HUD должен оставаться на экране.

        Это окна самого оверлея (блок тянут мышью, открыто меню «···») и
        главное окно Helper, пока в нём открыта вкладка «Оверлей». Вызывается
        из фонового потока: только HWND и PID, без заголовков окон (см.
        _is_ed_foreground — чтение заголовка своего окна вешало программу).
        """
        fg = _foreground_window()
        if not fg:
            return False
        if fg in self._overlay_hwnds:
            return True
        if not _is_own_window(_window_pid(fg), _own_pid()):
            return False
        if self._helper_hwnd and fg == self._helper_hwnd:
            return bool(self._ui_editing)
        # Прочие окна процесса — меню и диалоги, открытые из блоков.
        return True

    def set_ui_editing(self, editing: bool):
        """Открыта ли вкладка «Оверлей» в Helper (HUD тогда не прячется)."""
        self._ui_editing = bool(editing)

    def _set_all_visibility(self, show: bool, detached: Optional[bool] = None):
        """Показать/скрыть оверлеи. При показе — lift() + topmost для гарантии Z-order.

        `detached` — видимость блоков, отвязанных от игры (None — как у всех):
        они не зависят от фокуса игры, но подчиняются остальным правилам.

        Z-order поднимаем не на каждом тике (цикл работает раз в секунду),
        а только когда это действительно нужно: блок только что появился,
        у него слетел topmost или прошло больше ZORDER_REFRESH_SECONDS с
        прошлой перестановки. Ежесекундный lift() по всем окнам — главный
        источник мерцания при редактировании: Windows каждый раз
        пересобирает layered-окна, а во время перетаскивания ещё и борется
        с курсором за позицию окна.

        Итоговая видимость блока складывается из четырёх условий: HUD вообще
        нужен (`show` — есть игра/фокус), пользователь включил блок, сработало
        правило «по ситуации» и не истёк таймер простоя.
        """
        visibility = self.evaluate_block_visibility(game_visible=show, detached_visible=detached)
        now = time.monotonic()
        refresh_due = (now - self._zorder_at) >= ZORDER_REFRESH_SECONDS
        hwnds = set()
        for key, ov in self._blocks():
            if not ov:
                continue
            try:
                should_show = visibility.get(key, show)
                if should_show:
                    just_shown = not ov.is_visible()
                    if just_shown:
                        ov.show()
                    else:
                        # Страховка: закреплённый блок обязан пропускать мышь.
                        # Стиль пишется, только если его кто-то сбросил.
                        ensure = getattr(ov, "ensure_mouse_mode", None)
                        if ensure is not None:
                            ensure()
                    hwnd = getattr(ov, "_hwnd", None)
                    if isinstance(hwnd, int) and hwnd:
                        hwnds.add(hwnd)
                    # Пока блок тянут мышью, порядок окон не трогаем.
                    if getattr(ov, "_dragging", False):
                        continue
                    if just_shown or refresh_due or not ov._is_topmost:
                        ov.set_topmost(True)
                        ov.lift()
                else:
                    ov.hide()
            except Exception:
                pass
        self._overlay_hwnds = frozenset(hwnds)
        self._zorder_at = now

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
        parts.append(str(data.get("route_summary", {})))
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
        # Подсказка о следующей системе: стройка и первооткрыватель. Без неё
        # строка не перерисовывалась, пока журнал молчит.
        hint = data.get("next_system_hint") or {}
        parts.append(str(hint))
        # Состояние игры: HUD должен отреагировать на запуск/выход из игры.
        parts.append(str(data.get("game_running", False)))
        parts.append(str(data.get("game_focused", False)))
        parts.append(str(data.get("game_detail", "")))
        # Отпечаток экзобиологии — без «живых» полей: обратный отсчёт до
        # следующего образца меняется каждую секунду, и с ним хеш менялся бы
        # тоже, заставляя перерисовывать все блоки. Оверлей Exobio тикает сам.
        parts.append(self._exobiology_fingerprint(data.get("exobiology")))
        # Груз авианосца: тоннаж, товары и остаток до потребности площадки.
        parts.append(str(data.get("carrier", {})))
        # Миникарта: каждое движение и поворот меняют кадр, а журнал при этом
        # молчит — без этих полей блок замирал на месте стоянки.
        parts.append(self._footmap_fingerprint(data.get("footmap")))
        return hashlib.md5("|".join(parts).encode()).hexdigest()

    @staticmethod
    def _footmap_fingerprint(state) -> str:
        """Часть хеша по миникарте: позиция, курс, след и точки интереса."""
        if not isinstance(state, dict):
            return ""
        return "|".join((
            str(state.get("body") or ""),
            str(state.get("lat") or ""),
            str(state.get("lon") or ""),
            str(state.get("heading") or ""),
            str(state.get("altitude") or ""),
            str(state.get("scale") or ""),
            str(len(state.get("trail") or [])),
            str(state.get("oxygen") or ""),
            str(state.get("health") or ""),
            str(state.get("temperature") or ""),
            str(state.get("gravity") or ""),
            str(state.get("ship") or ""),
            str(state.get("pois") or ""),
            str(state.get("srv") or ""),
            str(state.get("samples") or ""),
            str(state.get("sample") or ""),
        ))

    @staticmethod
    def _exobiology_fingerprint(state) -> str:
        """Часть хеша по экзобиологии: только то, что приходит из журнала."""
        if not isinstance(state, dict):
            return ""
        parts = [
            str(state.get("system") or ""),
            str(state.get("body") or ""),
            str(state.get("bio_signals") or 0),
            str(bool(state.get("mapped"))),
            str(len(state.get("predictions") or [])),
        ]
        for row in state.get("organics") or []:
            parts.append(f"{row.get('species')}:{row.get('samples')}:{row.get('stage')}")
        for row in state.get("system_bodies") or []:
            parts.append(f"{row.get('body')}:{row.get('bio_signals')}:{bool(row.get('mapped'))}")
        # Фильтры и найденные планеты: без них смена настроек на вкладке
        # «Экзобиология» не перерисовывала блок.
        parts.append("g:" + ",".join(str(g) for g in state.get("genera_filter") or []))
        for row in state.get("planets") or []:
            parts.append(f"p:{row.get('body')}:{row.get('planet_class')}")
        return "|".join(parts)

    def _apply_update(self, data: dict):
        # Данные изменились — значит, в журнале есть жизнь: продлеваем показ
        # HUD и пересчитываем контекст для правил «показывать по ситуации».
        self.mark_activity()
        self.update_context(data)
        if self.route_overlay:
            self.route_overlay.update_route(
                data.get("current", "-"), data.get("next", "-"),
                data.get("visited", 0), data.get("total", 0), data.get("remaining"),
                data.get("next_system_info"), data.get("route_summary"),
                data.get("next_system_hint"),
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
                self._last_ship_data = ship_data
                self.ship_overlay.update_ship(ship_data)
        if self.cargo_overlay:
            cargo_data = data.get("cargo", {})
            if cargo_data:
                self.cargo_overlay.update_cargo(cargo_data)

        if self.exobio_overlay:
            self.exobio_overlay.update_exobiology(data.get("exobiology"))

        if self.carrier_overlay:
            # Обновляем всегда, даже когда данных нет: при `if carrier_data`
            # блок замирал на последнем непустом состоянии, и после сброса
            # (смена командира, разгруженный носитель) в нём продолжали
            # висеть старые строки груза.
            self.carrier_overlay.update_carrier(data.get("carrier") or {})

        if self.footmap_overlay:
            # Позиция на поверхности приходит из Status.json, поэтому блок
            # обновляем всегда: пустое состояние тоже информация.
            self.footmap_overlay.update_footmap(data.get("footmap") or {})

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

        for _key, overlay in self._blocks():
            overlay.apply_data_options()

    def set_content_option(self, block, section, value):
        if section not in CONTENT_OPTIONS.get(block, {}):
            return
        self.settings[option_key(block, section)] = bool(value)
        self.save_settings()
        overlay = getattr(self, f'{block}_overlay', None)
        if overlay:
            if block == 'exobio':
                overlay._render()
            elif block == 'events':
                overlay.render_events()
            overlay.apply_data_options()

    def set_carrier_filter(self, mode=None, query=None):
        if mode is not None:
            self.settings['carrier_filter'] = mode if mode in CARRIER_FILTERS else 'all'
        if query is not None:
            self.settings['carrier_search'] = str(query).strip()[:120]
        self.save_settings()
        if self.carrier_overlay:
            self.carrier_overlay.update_carrier(getattr(self.carrier_overlay, '_last_carrier_data', {}))
            self.carrier_overlay.apply_data_options()

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
        self._overlay_hwnds = frozenset()
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
        self.carrier_overlay = None

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

    def refresh_ship(self):
        """Перерисовать SHIP сразу, не дожидаясь нового события журнала.

        Смена режима списка модулей или шрифта данные не меняет: подпись HUD
        та же, и без принудительной перерисовки блок выглядел бы «не отреагировавшим».
        """
        overlay = self.ship_overlay
        if overlay is None or not self.enabled:
            return
        data = getattr(self, "_last_ship_data", None)
        if not data:
            return
        try:
            overlay.update_ship(data, force=True)
        except Exception:
            pass

    def set_ship_modules_view(self, mode: str):
        """Режим списка модулей в SHIP: «important» / «all» / «off».

        Окно не пересоздаём — список строится при каждой перерисовке, поэтому
        достаточно принудительно отдать ему текущие данные.
        """
        mode = str(mode or "important").lower()
        if mode not in ("important", "all", "off"):
            mode = "important"
        if self.settings.get("ship_modules_view") == mode:
            return
        self.settings["ship_modules_view"] = mode
        self.save_settings()
        self._notify_block("ship", "ship_modules_view", mode)
        self.refresh_ship()

    def set_ship_block(self, block: str, show: bool):
        """Внутренние блоки SHIP (pips, щиты, модули…).

        Содержимое окна собирается при создании, поэтому окно пересоздаётся,
        но позицию, прозрачность, шрифт и блокировку возвращаем сразу же —
        для пользователя это выглядит как мгновенная перерисовка одного блока.
        """
        show = bool(show)
        previous = bool(self.settings.get(f"show_{block}", True))
        self.settings[f"show_{block}"] = show
        if previous == show:
            # Значение не изменилось — пересоздавать окно незачем: это и есть
            # та самая вспышка, которую пользователь видит при редактировании.
            return
        if self.ship_overlay and self.enabled:
            was_visible = self.ship_overlay.is_visible()
            self.ship_overlay.destroy()
            self.ship_overlay = ShipOverlay(self.master, self.settings)
            self._wire_block("ship", self.ship_overlay)
            self.ship_overlay._register_fonts()
            self.ship_overlay._apply_anchor(self.block_area("ship"))
            self.apply_block_style("ship")
            if not was_visible or not self.settings.get("show_ship", True):
                self.ship_overlay.hide()

    def set_exobio_filters(self, genera=None, planet_search=None, show_planets=None):
        """Фильтры блока EXOBIO (вкладка «Экзобиология»).

        Окно не пересоздаём: разделы перерисуются на следующем тике данных, а
        принудительную перерисовку делаем сами. Пересоздание окна — это ровно
        та вспышка, на которую жаловались в настройках блоков.
        """
        if genera is not None:
            self.settings["exobio_genera"] = [str(g) for g in genera if str(g).strip()]
        if planet_search is not None:
            self.settings["exobio_planet_search"] = [str(i) for i in planet_search if str(i).strip()]
        if show_planets is not None:
            self.settings["exobio_show_planet_search"] = bool(show_planets)
        self.refresh_exobio()

    def refresh_exobio(self):
        """Перерисовать EXOBIO сразу, не дожидаясь новых событий журнала.

        Без этого смена фильтра на вкладке применялась только после следующего
        события в журнале — в пустой системе выглядело как «не работает».
        """
        overlay = self.exobio_overlay
        if overlay is None or not self.enabled:
            return
        provider = getattr(self, "_exobio_state_provider", None)
        if provider is None:
            return
        try:
            state = provider()
        except Exception:
            return
        overlay.update_exobiology(state)

    def set_exobio_state_provider(self, provider):
        """Колбэк, отдающий состояние экзобиологии для принудительной перерисовки."""
        self._exobio_state_provider = provider

    def set_attach_to_game(self, attach: bool):
        """Переключить привязку и сразу сохранить её.

        The old setter changed only the in-memory value. A restart therefore
        silently restored the previous mode, which looked like the overlay
        ignored the checkbox. Re-apply anchors as well so the monitor choice
        changes without restarting the HUD.
        """
        self.settings["attach_to_game"] = bool(attach)
        self.apply_anchors()
        self.save_settings()

    def set_hide_when_game_off(self, hide: bool):
        """Choose whether the HUD is hidden while Elite Dangerous is closed."""
        self.settings["hide_when_game_off"] = bool(hide)
        self.save_settings()
        # The update thread normally applies this on its next tick. Apply the
        # no-game case now too, so toggling the checkbox has no one-second stale
        # window and cannot be overwritten by attach_to_game handling.
        try:
            game = self.game_state()
            if not game.running:
                self.master.after(0, lambda show=not bool(hide): self._set_all_visibility(show))
        except Exception:
            pass

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
        """Закрепить блок (не двигается, мышь уходит в игру) или открепить."""
        self.settings[f"{key}_locked"] = bool(locked)
        overlay = self._overlay_for(key)
        if overlay is not None:
            overlay.set_locked(bool(locked))
        self.save_settings()
        self._notify_block(key, "locked", bool(locked))

    def all_locked(self) -> bool:
        return all(bool(self.settings.get(f"{key}_locked", False)) for key in self.BLOCKS)

    def set_all_locked(self, locked: bool):
        """Закрепить или открепить все блоки сразу."""
        locked = bool(locked)
        for key in self.BLOCKS:
            self.settings[f"{key}_locked"] = locked
            overlay = self._overlay_for(key)
            if overlay is not None:
                try:
                    overlay.set_locked(locked)
                except Exception:
                    pass
        self.save_settings()
        self._notify_block("", "locked", locked)

    def toggle_all_locked(self) -> bool:
        """Горячая клавиша (Ctrl+F12): все закреплены — открепить, иначе закрепить.

        Закреплённый оверлей мышь не ловит вовсе, поэтому открепить его можно
        только отсюда или из вкладки «Оверлей».
        """
        locked = not self.all_locked()
        self.set_all_locked(locked)
        self.log("Оверлей закреплён: клики уходят в игру" if locked
                 else "Оверлей откреплён: блоки можно двигать и настраивать", "info")
        return locked

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
        self.settings[f"{key}_detached"] = False
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
                overlay.set_detached(False, save=False)
                overlay.set_alpha(resolve_block_alpha(self.settings, key), save=False)
                overlay.apply_font(self.settings.get("font_family", "Consolas"),
                                   resolve_block_font_size(self.settings, key))
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
                # Закрепление = клик насквозь (см. block_click_through).
                overlay.set_locked(bool(self.settings.get(f"{block_key}_locked", False)))
                overlay.set_detached(block_detached(self.settings, block_key), save=False)
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
            # Стоит ли командир сейчас на авианосце (правило at_carrier).
            "at_carrier": bool((data.get("carrier") or {}).get("at_carrier")),
            "game_running": bool(data.get("game_running", game.running)),
            "game_focused": bool(data.get("game_focused", game.focused)),
        }
        self._context_state = context
        return context

    def evaluate_block_visibility(self, context: Optional[dict] = None,
                                  game_visible: bool = True,
                                  detached_visible: Optional[bool] = None) -> Dict[str, bool]:
        """Кому из блоков сейчас можно быть на экране.

        Складывается из четырёх условий: игра показывает HUD вообще,
        пользователь включил блок, сработало правило «по ситуации» и не
        истёк таймер простоя. Для блоков, отвязанных от игры, первое условие
        задаёт `detached_visible` (None — как у всех): фокус игры им не нужен.
        """
        ctx = context if context is not None else (self._context_state or {})
        # Keep the preference meaningful even for callers that provide a
        # context directly instead of going through _update_loop. This avoids
        # one path showing blocks while the loop correctly hides them.
        if self.settings.get("hide_when_game_off", True) and ctx.get("game_running") is False:
            game_visible = False
            detached_visible = False
        timeout = self.idle_timeout()
        idle_hidden = timeout > 0 and (time.monotonic() - self._last_activity) > timeout
        self._hidden_by_idle = idle_hidden
        rules_on = bool(self.settings.get("auto_rules_enabled", False))
        result: Dict[str, bool] = {}
        for key in self.BLOCKS:
            base = game_visible
            if detached_visible is not None and self.block_detached(key):
                base = detached_visible
            visible = bool(base) and bool(self.settings.get(f"show_{key}", True))
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
        # Закрепить/открепить все: закреплённый блок мышью не открепить —
        # клики уходят в игру, поэтому нужна клавиша.
        lock_combo = str(self.settings.get("lock_toggle_hotkey", "Ctrl+F12") or "").strip()
        if lock_combo:
            self.hotkeys.register(lock_combo, self.toggle_all_locked)
        self.hotkeys.start()

    def set_lock_hotkey(self, combo: str) -> bool:
        """Клавиша «закрепить/открепить все блоки» ('' — без клавиши)."""
        self.settings["lock_toggle_hotkey"] = (combo or "").strip()
        self.save_settings()
        if self.enabled:
            self.register_hotkeys()
        return True

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
#: Версия схемы HUD-настроек. Поднимаем, когда меняем значение по умолчанию
#: у уже существующего ключа: сохранённый конфиг перекрывает DEFAULT_SETTINGS,
#: поэтому без миграции прежний пользователь навсегда остался бы на старом
#: значении и не увидел бы исправления.
SETTINGS_SCHEMA_VERSION = 6

#: Миграции: версия схемы -> {ключ: прежнее значение по умолчанию}.
#: Ключ получает новый дефолт только если пользователь его не менял, то есть
#: сохранённое значение всё ещё равно прежнему дефолту. Свой размер окна,
#: заданный вручную, трогать нельзя.
SETTINGS_DEFAULT_CHANGES = {
    # 2.8.3: раздел «Поиск планет» обрезался при высоте 470 px
    2: {"exobio_height": 470},
    # 2.10.23: SHIP пересобран в компактный текстовый HUD — прежние 420 px
    # оставляли под списком модулей пустоту, а 330 px хватает с лентой.
    4: {"ship_height": 420},
    # 2.18.33: в ROUTE появилась подсказка о следующей системе (стройка и
    # первооткрыватель) — две строки значка и шкала. На 160 px они выдавливали
    # «Цель», поэтому блок становится выше.
    6: {"route_height": 160, "route_width": 280},
}

#: Миграции позиций: версия схемы -> {блок: (прежний x, прежний y)}.
#: Позиция переносится на новую, только если блок не двигали вовсе, то есть
#: обе координаты всё ещё равны прежним значениям по умолчанию. Блок, который
#: пользователь поставил сам, трогать нельзя — даже если он стоит «неудачно».
SETTINGS_POSITION_CHANGES = {
    # 2.8.5: раскладка приведена к сетке без перекрытий. Прежняя уезжала
    # CARGO за нижний край экрана (y=1000 при высоте 340), а EXOBIO после
    # подъёма до 620 px наезжал на CARRIER.
    3: {
        "ship": (50, 440),
        "cargo": (50, 1000),
        "session": (400, 50),
        "events": (730, 50),
        "exobio": (1060, 50),
        "carrier": (1060, 430),
    },
    # 2.18.33: ROUTE вырос под подсказку о следующей системе, и STATUS с SHIP
    # сдвигаются вниз — иначе новый ROUTE ложится на STATUS.
    6: {
        "status": (50, 220),
        "ship": (50, 440),
    },
}


#: Ключи, которых больше нет: «клик насквозь» с 2.15.0 даёт закрепление блока.
#: Из конфига их убирает save_overlay_settings, значения переносит миграция.
LEGACY_OVERLAY_KEYS = ("click_through",) + tuple(
    f"{_block}_click_through" for _block in DEFAULT_BLOCK_POSITIONS
)

#: Персональные настройки блока, у которых «нет ключа» значит «как у всех».
#: Их удаление тоже надо сохранять — иначе после перезапуска возвращалось
#: старое значение (см. save_overlay_settings).
BLOCK_OVERRIDE_SUFFIXES = ("alpha", "font_size", "hotkey")


def _migrate_click_through_to_lock(merged: dict, stored: dict) -> None:
    """Схема 5 (2.15.0): «клик насквозь» перестал быть отдельной галочкой.

    Теперь его даёт закрепление: закреплённый блок всегда пропускает мышь в
    игру, откреплённый — всегда принимает клики. Блок, который раньше
    пропускал мышь (своей галочкой или общей), становится закреплённым —
    иначе после обновления он начал бы перехватывать клики у игры.
    """
    for block in DEFAULT_BLOCK_POSITIONS:
        if legacy_click_through(stored, block):
            merged[f"{block}_locked"] = True
    for key in LEGACY_OVERLAY_KEYS:
        merged.pop(key, None)


def migrate_overlay_settings(merged: dict, stored: dict) -> dict:
    """Поднять дефолты, которые пользователь не менял, до текущей версии схемы.

    :param merged: DEFAULT_SETTINGS, перекрытые сохранённым конфигом.
    :param stored: содержимое конфига как есть — по нему видно, что именно
        записала предыдущая версия и какую версию схемы она помнила.
    """
    try:
        stored_version = int(stored.get("settings_schema", 1))
    except (TypeError, ValueError):
        stored_version = 1
    if stored_version >= SETTINGS_SCHEMA_VERSION:
        return merged
    for version in range(stored_version + 1, SETTINGS_SCHEMA_VERSION + 1):
        for key, old_default in SETTINGS_DEFAULT_CHANGES.get(version, {}).items():
            if stored.get(key) == old_default:
                merged[key] = DEFAULT_SETTINGS[key]
        for block, (old_x, old_y) in SETTINGS_POSITION_CHANGES.get(version, {}).items():
            # Только если блок не двигали: обе координаты равны прежним
            # дефолтным. Сдвинутый вручную блок оставляем как есть.
            if (stored.get(f"{block}_x"), stored.get(f"{block}_y")) == (old_x, old_y):
                merged[f"{block}_x"] = DEFAULT_SETTINGS[f"{block}_x"]
                merged[f"{block}_y"] = DEFAULT_SETTINGS[f"{block}_y"]
        if version == 5:
            _migrate_click_through_to_lock(merged, stored)
    merged["settings_schema"] = SETTINGS_SCHEMA_VERSION
    return merged


DEFAULT_SETTINGS = {
    "settings_schema": SETTINGS_SCHEMA_VERSION,
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
    "show_carrier": True,
    "show_footmap": True,
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
    #: Список модулей в SHIP: «important» — повреждённые, выключенные и
    #: ключевые системы; «all» — все; «off» — только итог по повреждениям.
    #: `show_modules: False` (старая настройка) всегда значит «off».
    "ship_modules_view": "important",
    # Позиции и размеры блоков здесь не заданы: их подставляет цикл сразу
    # после словаря из DEFAULT_BLOCK_POSITIONS. Раньше значения дублировались
    # и разошлись — EXOBIO наезжал на CARRIER, а CARGO уходил за нижний край.
    "route_locked": False,
    "route_anchor": "custom",
    "status_locked": False,
    "status_anchor": "custom",
    "ship_locked": False,
    "ship_anchor": "custom",
    "cargo_locked": False,
    "cargo_anchor": "custom",
    "session_locked": False,
    "session_anchor": "custom",
    "events_locked": False,
    "events_anchor": "custom",
    "exobio_locked": False,
    "exobio_anchor": "custom",
    # Фильтры блока EXOBIO (вкладка «Экзобиология»).
    # Пустой список родов — фильтр выключен, показываем все предсказания.
    "exobio_genera": [],
    # id наборов критериев поиска планет (exobiology.PLANET_SEARCH_PRESETS).
    "exobio_planet_search": [],
    # Показывать ли в блоке раздел «Поиск планет».
    "exobio_show_planet_search": True,
    # Компактный режим блока EXOBIO (плашки-бейджи, шкалы вероятности, HUD-акцент).
    "exobio_compact": True,
    # Как печатать разделы EXOBIO: «table» — колонками (компактно и читаемо),
    # «list» — прежними многострочными абзацами.
    "exobio_layout": "table",
    # Сколько найденных планет показывать.
    "exobio_planet_limit": 6,
    "carrier_locked": False,
    "carrier_anchor": "custom",
    "footmap_locked": False,
    "footmap_anchor": "custom",
    # Миникарта нужна только на поверхности: правило «пешком (OnFoot)»
    # срабатывает, как только включены автоправила на вкладке «Оверлей».
    "footmap_auto_rule": "on_foot",
    # Привязка к игре: блоки видны только пока игра в фокусе. Блок, у
    # которого <ключ>_detached = True, отвязан — виден всегда и может жить
    # на другом экране (ключи по умолчанию добавляет цикл ниже).
    "attach_to_game": True,
    # Раскладка: отступ от края области (экрана или окна игры)
    "layout_margin": 24,
    # Прятать HUD, когда игра не запущена
    "hide_when_game_off": True,
    # Скрывать HUD, если в журнале нет событий дольше N секунд (0 — не скрывать)
    "idle_timeout": 0,
    # Учитывать правила «показывать блок по ситуации»
    "auto_rules_enabled": False,
    # Горячая клавиша «показать/скрыть все блоки»
    "toggle_all_hotkey": "F12",
    # Горячая клавиша «закрепить/открепить все блоки». Закреплённый блок
    # пропускает мышь в игру, и мышью его уже не открепить.
    "lock_toggle_hotkey": "Ctrl+F12",
    # Профили раскладки: {имя: {блок: {x,y,width,height,anchor,visible}, ...}}
    "profiles": {},
    "active_profile": "",
}

DEFAULT_SETTINGS.update(CONTENT_DEFAULTS)
DEFAULT_SETTINGS.update(carrier_filter='all', carrier_search='')

# Позиции и размеры блоков берутся из DEFAULT_BLOCK_POSITIONS — единственного
# источника раскладки. Раньше они дублировались literals-ами выше и разошлись:
# окна читают именно <ключ>_x/_y/_width/_height, поэтому при первом запуске
# EXOBIO наезжал на CARRIER, а CARGO уходил за нижний край экрана.
for _key, (_x, _y, _w, _h) in DEFAULT_BLOCK_POSITIONS.items():
    DEFAULT_SETTINGS[f"{_key}_x"] = _x
    DEFAULT_SETTINGS[f"{_key}_y"] = _y
    DEFAULT_SETTINGS[f"{_key}_width"] = _w
    DEFAULT_SETTINGS[f"{_key}_height"] = _h
    DEFAULT_SETTINGS[f"{_key}_detached"] = False
del _key, _x, _y, _w, _h


def load_overlay_settings(config_path: Path) -> dict:
    if config_path.exists():
        try:
            import json
            with open(config_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            merged = dict(DEFAULT_SETTINGS)
            merged.update(data)
            return migrate_overlay_settings(
                merged, data if isinstance(data, dict) else {}
            )
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
            "carrier_", "footmap_",
        )))
        existing.update({key: settings[key] for key in overlay_keys if key in settings})
        # Удаление ключа — тоже изменение. Общий конфиг пишут два владельца:
        # приложение (save_config кладёт всё, что прочитало при запуске) и
        # оверлей. Без явного удаления «вернуть общую прозрачность» или «снять
        # клавишу» откатывались после перезапуска, а устаревшие ключи жили вечно.
        for key in LEGACY_OVERLAY_KEYS:
            existing.pop(key, None)
        for block in DEFAULT_BLOCK_POSITIONS:
            for suffix in BLOCK_OVERRIDE_SUFFIXES:
                name = f"{block}_{suffix}"
                if name not in settings:
                    existing.pop(name, None)
        tmp = config_path.with_suffix(config_path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        tmp.replace(config_path)
    except Exception:
        pass
