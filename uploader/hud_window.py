"""HUD оверлея на чистом Qt: корпус блока, шапка, меню и мелкие детали.

Здесь живёт всё, что раньше делал слой, эмулирующий Tk: окно без рамки,
перетаскивание за шапку, угол изменения размера, контекстное меню шапки,
прозрачность, «клик насквозь» и якоря. Никакой эмуляции `Label`/`Frame`/
`pack()` больше нет — только виджеты и раскладки Qt.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional, Sequence, Tuple

from PySide6.QtCore import QPoint, Qt, QTimer
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QMenu,
    QProgressBar,
    QSizeGrip,
    QVBoxLayout,
    QWidget,
)

import ui_qt
from hud_win32 import _set_click_through, _toplevel_hwnd

# ============================================================
#  Цветовая схема в стиле ED Ring Colony сайта
# ============================================================
# Палитра остаётся узнаваемой (графит + ED-orange), но стала строже:
# меньше случайных оттенков, выше контраст между корпусом, секциями и данными.
COLOR_BG = "#090d12"
COLOR_PANEL = "#111820"
COLOR_PANEL_ALT = "#141d26"
COLOR_SURFACE = "#18222c"
COLOR_PANEL_HOVER = "#1d2935"
COLOR_TEXT = "#e8edf2"
COLOR_TEXT_MUTED = "#8794a1"
COLOR_TEXT_DIM = "#5f6b76"
COLOR_ACCENT = "#df7b24"
COLOR_ACCENT_HOVER = "#f0953f"
COLOR_CYAN = "#61a9d8"
COLOR_GREEN = "#246b45"
COLOR_GREEN_TEXT = "#55bd82"
COLOR_RED = "#9e3940"
COLOR_RED_TEXT = "#ef6a70"
COLOR_YELLOW = "#d2a84a"
COLOR_BORDER = "#34414d"
COLOR_BORDER_ACTIVE = "#61a9d8"
COLOR_LINE = "#26313b"

#: Номер и назначение блока образуют единый визуальный язык всех восьми
#: оверлеев. Номер помогает быстро узнавать блок боковым зрением в игре.
OVERLAY_META = {
    "route": ("01", "NAVIGATION"),
    "status": ("02", "CONNECTION"),
    "ship": ("03", "VESSEL"),
    "cargo": ("04", "HOLD"),
    "session": ("05", "ACTIVITY"),
    "events": ("06", "EVENT LOG"),
    "exobio": ("07", "ANALYSIS"),
    "carrier": ("08", "FLEET CARRIER"),
}

#: Шрифт по умолчанию: моноширинный, чтобы колонки цифр не «плыли».
DEFAULT_FAMILY = "Consolas"


# ============================================================
#  Мелкие детали оформления
# ============================================================
def hud_font(family: Optional[str], size: int, bold: bool = False) -> QFont:
    """Шрифт HUD: семейство, кегль и начертание в одном месте."""
    font = QFont(str(family or DEFAULT_FAMILY))
    try:
        font.setPixelSize(max(6, int(size) + 4))
    except (TypeError, ValueError):
        font.setPixelSize(14)
    font.setBold(bool(bold))
    return font


def paint(widget: QWidget, color: Optional[str] = None,
          background: Optional[str] = None) -> None:
    """Перекрасить подпись/панель, не пересоздавая виджет.

    В Qt цвет — это свойство стиля, а не отдельный атрибут Tk: собираем
    короткий QSS из того, что реально меняется.
    """
    if not isinstance(widget, QWidget):
        return
    parts = []
    if color:
        parts.append(f"color:{color};")
    if background:
        parts.append(f"background:{background};")
    if parts:
        widget.setStyleSheet("".join(parts))


def hud_label(parent: QWidget, text: str = "", *, color: str = COLOR_TEXT,
              background: Optional[str] = None, family: Optional[str] = None,
              size: int = 10, bold: bool = False, wrap=0,
              align_right: bool = False, margin: Tuple[int, int] = (0, 0)) -> QLabel:
    """Подпись HUD: один вызов — один QLabel с нужным шрифтом и цветом."""
    label = QLabel(text, parent)
    label.setFont(hud_font(family, size, bold))
    label.setWordWrap(bool(wrap))
    if wrap is not True and wrap:
        # Явная ширина: так печатаются таблицы и длинные описания, которым
        # нужен свой предел (окно блока может быть шире текста).
        label.setMaximumWidth(int(wrap))
        label.setMinimumWidth(min(int(wrap), 80))
    if align_right:
        label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
    else:
        label.setAlignment(Qt.AlignLeft | Qt.AlignVCenter)
    left, top = margin
    if left or top:
        label.setContentsMargins(left, top, left, top)
    css = []
    if color:
        css.append(f"color:{color};")
    if background:
        label.setAttribute(Qt.WA_StyledBackground, True)
        css.append(f"background:{background};")
    if css:
        label.setStyleSheet("".join(css))
    return label


def hud_section(parent: QWidget, text: str, *, family: Optional[str] = None,
                size: int = 8) -> QLabel:
    """Заголовок раздела: мелкие прописные буквы, приглушённый цвет."""
    label = hud_label(parent, text, color=COLOR_TEXT_MUTED, family=family,
                      size=size, bold=True)
    font = label.font()
    font.setCapitalization(QFont.AllUppercase)
    font.setLetterSpacing(QFont.AbsoluteSpacing, 0.6)
    label.setFont(font)
    return label


def hud_separator(parent: QWidget, color: str = COLOR_LINE) -> QFrame:
    """Тонкая линия-разделитель между разделами блока."""
    line = QFrame(parent)
    line.setFixedHeight(1)
    line.setStyleSheet(f"background:{color};border:0;")
    return line


def hud_panel(parent: QWidget, *, background: str = COLOR_PANEL_ALT,
              margins: Tuple[int, int] = (6, 3)) -> QFrame:
    """Плашка с фоном: строка метрики или полоса состояния."""
    frame = QFrame(parent)
    frame.setAttribute(Qt.WA_StyledBackground, True)
    frame.setStyleSheet(f"background:{background};border:0;")
    layout = QHBoxLayout(frame)
    left, top = margins
    layout.setContentsMargins(left, top, left, top)
    layout.setSpacing(6)
    frame.layout_ = layout
    return frame


class HudBar(QProgressBar):
    """Полоса заполнения HUD: тонкая, без текста, с настраиваемым цветом."""

    def __init__(self, parent: Optional[QWidget] = None, *,
                 color: str = COLOR_ACCENT, height: int = 4) -> None:
        super().__init__(parent)
        self.setRange(0, 1000)
        self.setValue(0)
        self.setTextVisible(False)
        self.setFixedHeight(int(height))
        self.set_color(color)

    def set_color(self, color: str) -> None:
        self.setStyleSheet(
            f"QProgressBar{{background:{COLOR_LINE};border:0;}}"
            f"QProgressBar::chunk{{background:{color};}}"
        )

    def set_fraction(self, value: float) -> None:
        """Заполнение долей от 0 до 1 (значения вне диапазона подрезаются)."""
        try:
            fraction = max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            fraction = 0.0
        self.setValue(int(round(fraction * self.maximum())))

    def fraction(self) -> float:
        return float(self.value()) / float(self.maximum() or 1)


class HudChart(QWidget):
    """График истории трюма: сетка, ломаная и точки — на `QPainter`."""

    def __init__(self, parent: Optional[QWidget] = None, *, height: int = 100) -> None:
        super().__init__(parent)
        self.setMinimumHeight(int(height))
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet(
            f"background:{COLOR_SURFACE};border:1px solid {COLOR_LINE};"
        )
        self._values: list = []
        self._family = DEFAULT_FAMILY
        self._size = 8

    def set_history(self, values: Sequence[float]) -> None:
        self._values = [float(value or 0) for value in values]
        self.update()

    def set_font_spec(self, family: Optional[str], size: int) -> None:
        self._family = str(family or DEFAULT_FAMILY)
        self._size = max(6, int(size))
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 - имя из Qt
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        rect = self.rect().adjusted(0, 0, -1, -1)
        painter.fillRect(rect, QColor(COLOR_SURFACE))
        painter.setPen(QPen(QColor(COLOR_LINE), 1))
        painter.drawRect(rect)

        width = max(1, rect.width())
        height = max(1, rect.height())
        padding = 14
        grid_pen = QPen(QColor(COLOR_LINE), 1)
        for index in range(5):
            y = padding + (height - 2 * padding) * index / 4
            painter.setPen(grid_pen)
            painter.drawLine(padding, int(y), width - padding, int(y))

        values = list(self._values)
        if len(values) < 2:
            painter.setPen(QPen(QColor(COLOR_TEXT_MUTED), 1))
            painter.setFont(hud_font(self._family, self._size))
            painter.drawText(rect, Qt.AlignCenter, "Collecting data...")
            return

        top = max(max(values), 1.0)
        points = []
        for index, value in enumerate(values):
            x = padding + (width - 2 * padding) * index / max(len(values) - 1, 1)
            y = padding + (height - 2 * padding) * (1 - value / top)
            points.append(QPoint(int(x), int(y)))

        painter.setPen(QPen(QColor(COLOR_ACCENT), 2))
        for first, second in zip(points, points[1:]):
            painter.drawLine(first, second)
        painter.setPen(QPen(QColor(COLOR_TEXT), 1))
        painter.setBrush(QColor(COLOR_ACCENT))
        for point in points:
            painter.drawEllipse(point, 2, 2)
        painter.setBrush(Qt.NoBrush)

        painter.setPen(QPen(QColor(COLOR_TEXT_MUTED), 1))
        painter.setFont(hud_font(self._family, max(6, self._size - 1)))
        painter.drawText(QPoint(padding + 2, padding + 10), str(int(top)))
        painter.drawText(QPoint(padding + 2, height - 4), "0")


class _Header(QWidget):
    """Шапка блока: по ней блок и перетаскивают."""

    def __init__(self, window: "HudWindow") -> None:
        super().__init__(window)
        self._window = window
        self.setFixedHeight(30)
        self.setCursor(Qt.SizeAllCursor)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        self._window._begin_drag(event)
        event.accept()

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        self._window._drag_move(event)
        event.accept()

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        self._window._end_drag()
        event.accept()


class HudButton(QLabel):
    """Значок-кнопка шапки (LK/UL, «···», «::»)."""

    def __init__(self, parent: QWidget, text: str, callback: Callable,
                 *, color: str = COLOR_TEXT_MUTED, size: int = 8,
                 bold: bool = True, width: int = 18) -> None:
        super().__init__(text, parent)
        self._callback = callback
        self.setFont(hud_font(DEFAULT_FAMILY, size, bold))
        self.setAlignment(Qt.AlignCenter)
        self.setFixedWidth(int(width))
        self.setCursor(Qt.PointingHandCursor)
        paint(self, color=color)

    def set_color(self, color: str) -> None:
        paint(self, color=color)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton and self._callback is not None:
            self._callback()
            event.accept()
            return
        super().mousePressEvent(event)


class HudWindow(QWidget):
    """Оконный корпус блока HUD: без рамки, поверх игры, перетаскиваемый.

    Публичный интерфейс повторяет прежний (`set_locked`, `set_alpha`,
    `set_position`, `_apply_anchor` …), поэтому менеджер оверлея и вкладка
    «Оверлей» не меняются: изменилась только начинка окна.
    """

    MIN_WIDTH = 200
    MIN_HEIGHT = 100

    def __init__(self, master, title: str, x: int, y: int, width: int, height: int,
                 settings: Dict[str, Any], overlay_key: str) -> None:
        # QApplication обязан существовать до первого виджета — иначе Qt
        # аварийно завершает процесс, а не бросает исключение.
        ui_qt.ensure_app()
        super().__init__(master if isinstance(master, QWidget) else None)
        self.master = master
        self.settings = settings
        self.overlay_key = overlay_key
        self.title_text = str(title)
        self._alpha = settings.get("alpha", 0.90)
        self._drag_offset = QPoint(0, 0)
        self._locked = bool(settings.get(f"{overlay_key}_locked", False))
        self._anchor = settings.get(f"{overlay_key}_anchor", "custom")
        self._min_width = self.MIN_WIDTH
        self._min_height = self.MIN_HEIGHT
        # Закреплённый блок пропускает мышь в игру: это и есть «клик насквозь».
        self._click_through = self._locked
        # Блок отвязан от игры — живёт на своём экране.
        self._detached = bool(settings.get(f"{overlay_key}_detached", False))
        self._controller = None
        # Шрифты: база для масштабирования и то, что реально применено.
        family = str(settings.get("font_family", DEFAULT_FAMILY) or DEFAULT_FAMILY)
        size = settings.get(f"{overlay_key}_font_size")
        if size in (None, ""):
            size = settings.get("font_size", 10)
        try:
            size = max(6, min(28, int(size)))
        except (TypeError, ValueError):
            size = 10
        self._font_family = family
        self._font_size = size
        self._font_base = size
        self._font_specs: Dict[Any, Any] = {}
        self._applied_font = (family, size)
        self._content_pack: Dict[str, Any] = {}
        self._dragging = False
        self._hwnd: Optional[int] = None
        self._applied_through: Optional[bool] = None
        self._is_topmost = True
        self._edit_menu: Optional[QMenu] = None
        self._edit_submenus: list = []
        self._on_move_callback: Optional[Callable] = None
        self._on_resize_callback: Optional[Callable] = None
        self._on_release_callback: Optional[Callable] = None
        self._area_provider: Optional[Callable] = None

        self.setWindowTitle(self.title_text)
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.Window | Qt.Tool
                            | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setObjectName("hud")
        self.setStyleSheet(
            f"#hud{{background:{COLOR_BG};border:1px solid {COLOR_BORDER};}}"
            f"QMenu{{background:{COLOR_PANEL};color:{COLOR_TEXT};"
            f"border:1px solid {COLOR_BORDER};}}"
            f"QMenu::item:selected{{background:{COLOR_PANEL_HOVER};"
            f"color:{COLOR_ACCENT};}}"
        )
        self.setMinimumSize(self._min_width, self._min_height)
        self.setGeometry(int(x), int(y), max(self._min_width, int(width)),
                         max(self._min_height, int(height)))
        self.setWindowOpacity(float(self._alpha))
        self._build_frame()

    # -- сборка корпуса ----------------------------------------------------
    def _build_frame(self) -> None:
        code, purpose = OVERLAY_META.get(self.overlay_key, ("00", self.overlay_key.upper()))
        outer = QVBoxLayout(self)
        outer.setContentsMargins(1, 1, 1, 1)
        outer.setSpacing(0)

        # Сигнальная линия сверху: оранжевая — с игрой, голубая — отвязан.
        self.signal_rail = QFrame(self)
        self.signal_rail.setFixedHeight(2)
        self.signal_rail.setStyleSheet(f"background:{self._state_color()};border:0;")
        outer.addWidget(self.signal_rail)

        self.header = _Header(self)
        header_layout = QHBoxLayout(self.header)
        header_layout.setContentsMargins(0, 0, 4, 0)
        header_layout.setSpacing(5)

        self.header_indicator = QFrame(self.header)
        self.header_indicator.setFixedWidth(2)
        self.header_indicator.setStyleSheet(
            f"background:{self._state_color()};border:0;")
        header_layout.addWidget(self.header_indicator)

        self.code_label = hud_label(
            self.header, code, color=COLOR_BG, background=self._state_color(),
            family=DEFAULT_FAMILY, size=8, bold=True)
        self.code_label.setAlignment(Qt.AlignCenter)
        self.code_label.setFixedWidth(26)
        header_layout.addWidget(self.code_label)

        self.title_label = hud_label(
            self.header, self.title_text, color=COLOR_TEXT, family=self._font_family,
            size=max(7, self._font_size - 1), bold=True)
        header_layout.addWidget(self.title_label)

        self.purpose_label = hud_label(
            self.header, f"/ {purpose}", color=COLOR_TEXT_DIM,
            family=self._font_family, size=max(6, self._font_size - 3))
        header_layout.addWidget(self.purpose_label)
        header_layout.addStretch(1)

        self.lock_btn = HudButton(self.header, "LK" if self._locked else "UL",
                                  self._toggle_lock,
                                  color=COLOR_ACCENT if self._locked else COLOR_TEXT_DIM)
        header_layout.addWidget(self.lock_btn)
        self.edit_btn = HudButton(self.header, "···", self._show_edit_menu,
                                  color=COLOR_TEXT_MUTED, width=24)
        header_layout.addWidget(self.edit_btn)
        self.drag_label = HudButton(self.header, "::", None,
                                    color=COLOR_TEXT_DIM, width=16)
        self.drag_label.setCursor(Qt.SizeAllCursor)
        header_layout.addWidget(self.drag_label)
        outer.addWidget(self.header)

        self.content = QWidget(self)
        self.body = QVBoxLayout(self.content)
        self.body.setContentsMargins(9, 7, 9, 7)
        self.body.setSpacing(4)
        outer.addWidget(self.content, 1)

        self.grip = QSizeGrip(self)
        self.grip.setFixedSize(12, 12)
        self.grip.setStyleSheet(f"background:{COLOR_ACCENT};border:0;")
        self.grip.setVisible(not self._locked)
        self._refresh_lock_controls()
        self._apply_anchor()

    # -- геометрия и перетаскивание ---------------------------------------
    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        if hasattr(self, "grip"):
            self.grip.move(self.width() - self.grip.width() - 1,
                           self.height() - self.grip.height() - 1)
        if self._on_resize_callback and not self._dragging:
            self._on_resize_callback(self.width(), self.height())

    def _begin_drag(self, event) -> None:
        """Начать перетаскивание за шапку (закреплённый блок не двигается)."""
        if self._locked or event.button() != Qt.LeftButton:
            return
        self._dragging = True
        self._drag_offset = (event.globalPosition().toPoint() - self.frameGeometry().topLeft())
        if self._anchor != "custom":
            self._anchor = "custom"
            self.settings[f"{self.overlay_key}_anchor"] = "custom"

    def _drag_move(self, event) -> None:
        if not self._dragging or self._locked:
            return
        position = event.globalPosition().toPoint() - self._drag_offset
        self.move(position)
        if self._on_move_callback:
            self._on_move_callback(int(position.x()), int(position.y()))

    def _end_drag(self) -> None:
        was_dragging = self._dragging
        self._dragging = False
        if not was_dragging:
            return
        self.settings[f"{self.overlay_key}_x"] = int(self.x())
        self.settings[f"{self.overlay_key}_y"] = int(self.y())
        if self._on_release_callback:
            try:
                self._on_release_callback()
            except Exception:
                pass

    def set_position(self, x: int, y: int, save: bool = True) -> None:
        """Переместить окно в точку (x, y) — якоря и профили раскладки."""
        self.move(int(x), int(y))
        if save:
            self.settings[f"{self.overlay_key}_x"] = int(x)
            self.settings[f"{self.overlay_key}_y"] = int(y)
        if self._on_move_callback:
            self._on_move_callback(int(x), int(y))

    def set_geometry(self, x: int, y: int, width: int, height: int) -> None:
        """Поставить окно в точку и задать размер (профили раскладки)."""
        self.setGeometry(int(x), int(y), max(self._min_width, int(width)),
                         max(self._min_height, int(height)))
        self.settings[f"{self.overlay_key}_x"] = int(x)
        self.settings[f"{self.overlay_key}_y"] = int(y)
        self.settings[f"{self.overlay_key}_width"] = int(width)
        self.settings[f"{self.overlay_key}_height"] = int(height)
        if self._on_move_callback:
            self._on_move_callback(int(x), int(y))

    def set_size(self, width: int, height: int, save: bool = True) -> None:
        """Задать размер окна прямо сейчас (без пересоздания)."""
        try:
            width = max(self._min_width, int(width))
            height = max(self._min_height, int(height))
        except (TypeError, ValueError):
            return
        self.resize(width, height)
        if save:
            self.settings[f"{self.overlay_key}_width"] = width
            self.settings[f"{self.overlay_key}_height"] = height

    def size(self) -> Tuple[int, int]:
        """Фактический размер окна.

        Пока раскладка не посчитана, Qt отдаёт размер по умолчанию (640×480):
        в этом случае берём сохранённый, иначе якорь встанет по чужой ширине.
        """
        width, height = self.width(), self.height()
        if width > 1 and height > 1:
            return int(width), int(height)
        return (
            int(self.settings.get(f"{self.overlay_key}_width", 280) or 280),
            int(self.settings.get(f"{self.overlay_key}_height", 200) or 200),
        )

    # -- якоря -------------------------------------------------------------
    def _apply_anchor(self, area=None) -> None:
        """Поставить окно по своему якорю.

        `area` — прямоугольник (x, y, w, h), внутри которого раскладываем:
        экран или окно игры. Если не передан, берётся область из
        `self._area_provider` (её задаёт OverlayManager) либо весь экран.
        """
        from overlay_layout import compute_anchored_position

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
        screen = self.screen()
        if screen is None:
            return None
        geometry = screen.geometry()
        return (geometry.x(), geometry.y(), geometry.width(), geometry.height())

    def set_area_provider(self, provider: Optional[Callable]) -> None:
        """Функция, возвращающая область для якорей (экран или окно игры)."""
        self._area_provider = provider

    # -- обратные вызовы для менеджера ------------------------------------
    def set_on_move(self, callback: Callable) -> None:
        self._on_move_callback = callback

    def set_on_resize(self, callback: Callable) -> None:
        self._on_resize_callback = callback

    def set_on_release(self, callback: Optional[Callable]) -> None:
        """Колбэк «перетаскивание/ресайз закончились» (сохранить, пересчитать)."""
        self._on_release_callback = callback

    def set_controller(self, controller) -> None:
        """Менеджер оверлея: шапка закрепляет/отвязывает блок через него."""
        self._controller = controller

    # -- режим мыши: закреплён = клик насквозь -----------------------------
    @staticmethod
    def _alpha_below_one(alpha) -> bool:
        try:
            return float(alpha) < 1.0
        except (TypeError, ValueError):
            return False

    def _on_window_map(self, event=None) -> None:
        """Окно показано: применить режим мыши к настоящему HWND."""
        self._applied_through = None
        QTimer.singleShot(0, self._sync_click_through)

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        self._on_window_map()

    def _sync_click_through(self, force: bool = False) -> bool:
        """Привести Win32-стиль окна к режиму мыши блока.

        Закреплённый блок пропускает клики в игру, откреплённый — принимает.
        Повторно стиль не пишем, если ни режим, ни окно не менялись: каждая
        запись пересобирает окно, и при редактировании блок мерцал.
        """
        desired = bool(self._click_through)
        hwnd = _toplevel_hwnd(self)
        if not hwnd:
            self._applied_through = None
            return False
        if not force and self._applied_through == desired and self._hwnd == hwnd:
            return True
        ok = _set_click_through(hwnd, desired, self._alpha,
                                keep_layered=self._alpha_below_one(self._alpha))
        self._hwnd = hwnd
        self._applied_through = desired if ok else None
        return ok

    def ensure_mouse_mode(self) -> bool:
        """Страховка раз в тик менеджера: стиль окна совпадает с режимом блока."""
        if not self.isVisible():
            return False
        return self._sync_click_through(force=True)

    # -- состояние блока ---------------------------------------------------
    def _state_color(self) -> str:
        """Цвет сигнальной линии: оранжевый — с игрой, голубой — отвязан."""
        return COLOR_CYAN if getattr(self, "_detached", False) else COLOR_ACCENT

    def _refresh_state_colors(self) -> None:
        color = self._state_color()
        for widget in (getattr(self, "code_label", None),
                       getattr(self, "header_indicator", None),
                       getattr(self, "signal_rail", None)):
            if widget is not None:
                paint(widget, background=color)

    def set_locked(self, locked: bool, save: bool = True) -> None:
        """Закрепить/открепить блок (без пересоздания окна).

        Закреплённый блок не двигается и всегда пропускает мышь в игру;
        откреплённый можно тянуть, менять размер и открывать меню.
        """
        locked = bool(locked)
        changed = locked != self._locked or locked != self._click_through
        self._locked = locked
        self._click_through = locked
        if save:
            self.settings[f"{self.overlay_key}_locked"] = locked
        self._refresh_lock_controls()
        if locked:
            self._dragging = False
        if changed:
            self._applied_through = None
            QTimer.singleShot(0, self._sync_click_through)
            self._flash_indicator(COLOR_GREEN_TEXT if locked else COLOR_ACCENT)

    def _refresh_lock_controls(self) -> None:
        """Шапка и угол ресайза по состоянию «закреплён/откреплён»."""
        locked = self._locked
        self.lock_btn.setText("LK" if locked else "UL")
        self.lock_btn.set_color(COLOR_ACCENT if locked else COLOR_TEXT_DIM)
        self.drag_label.set_color(COLOR_TEXT_DIM if locked else COLOR_TEXT_MUTED)
        self.drag_label.setCursor(Qt.ArrowCursor if locked else Qt.SizeAllCursor)
        self.grip.setVisible(not locked)

    def _toggle_lock(self) -> None:
        """LK/UL в шапке: через менеджер, чтобы настройка сохранилась."""
        if self._controller is not None:
            try:
                self._controller.set_block_locked(self.overlay_key, not self._locked)
                return
            except Exception:
                pass
        self.set_locked(not self._locked)

    def set_detached(self, detached: bool, save: bool = True) -> None:
        """Отвязать блок от игры (или вернуть): меняется цвет шапки."""
        self._detached = bool(detached)
        if save:
            self.settings[f"{self.overlay_key}_detached"] = self._detached
        self._refresh_state_colors()

    def _toggle_detached(self) -> None:
        if self._controller is not None:
            try:
                self._controller.set_block_detached(self.overlay_key, not self._detached)
                return
            except Exception:
                pass
        self.set_detached(not self._detached)

    def _move_to_monitor(self, index: int) -> None:
        if self._controller is not None:
            try:
                self._controller.move_block_to_monitor(self.overlay_key, index)
            except Exception:
                pass

    def _flash_indicator(self, color: str, duration_ms: int = 300) -> None:
        if not hasattr(self, "header_indicator"):
            return
        paint(self.header_indicator, background=color)
        paint(self.signal_rail, background=color)

        def restore():
            self._refresh_state_colors()

        QTimer.singleShot(int(duration_ms), restore)

    # -- меню шапки --------------------------------------------------------
    def _menu_monitors(self) -> list:
        """Экраны для подменю «Экран» (пусто — без менеджера или один экран)."""
        if self._controller is None:
            return []
        try:
            return list(self._controller.monitors() or [])
        except Exception:
            return []

    def _current_monitor_index(self) -> Optional[int]:
        if self._controller is None:
            return None
        try:
            monitor = self._controller.block_monitor(self.overlay_key)
        except Exception:
            return None
        return getattr(monitor, "index", None)

    def _destroy_edit_menu(self) -> None:
        """Снять и уничтожить меню шапки, если оно ещё живо."""
        for submenu in getattr(self, "_edit_submenus", None) or []:
            try:
                submenu.deleteLater()
            except Exception:
                pass
        self._edit_submenus = []
        menu = getattr(self, "_edit_menu", None)
        self._edit_menu = None
        if menu is not None:
            try:
                menu.deleteLater()
            except Exception:
                pass

    def _add_custom_menu_entries(self, menu: QMenu) -> None:
        """Переопределяется подклассами для добавления пунктов в меню."""

    def _show_edit_menu(self) -> None:
        # Повторный клик по «···» не должен оставлять предыдущее меню висеть.
        self._destroy_edit_menu()
        from overlay_layout import ANCHOR_KEYS, ANCHOR_LABELS

        menu = QMenu(self)
        submenus: list = []
        detached = bool(getattr(self, "_detached", False))

        menu.addAction("Закрепить (клики уходят в игру)", self._toggle_lock)
        menu.addAction(
            ("[x] " if detached else "[ ] ") + "Отвязать от игры (виден всегда)",
            self._toggle_detached,
        )
        monitors = self._menu_monitors()
        if len(monitors) > 1:
            screen_menu = menu.addMenu("Экран")
            current = self._current_monitor_index()
            for monitor in monitors:
                mark = "[x] " if detached and monitor.index == current else "[ ] "
                screen_menu.addAction(
                    f"{mark}{monitor.label()}",
                    lambda index=monitor.index: self._move_to_monitor(index),
                )
            submenus.append(screen_menu)
        menu.addSeparator()

        anchor_menu = menu.addMenu("Anchor")
        for position in ANCHOR_KEYS:
            label = ANCHOR_LABELS.get(position, position)
            anchor_menu.addAction(
                ("[x] " if self._anchor == position else "[ ] ") + label,
                lambda p=position: self._set_anchor(p),
            )
        submenus.append(anchor_menu)
        menu.addSeparator()
        width, height = self.size()
        menu.addAction(f"Width: {width}px").setEnabled(False)
        menu.addAction(f"Height: {height}px").setEnabled(False)
        menu.addAction("Reset size", self._reset_size)
        menu.addSeparator()

        alpha_menu = menu.addMenu("Alpha")
        for alpha in (0.3, 0.5, 0.7, 0.85, 0.95, 1.0):
            alpha_menu.addAction(
                ("[x] " if abs(float(self._alpha) - alpha) < 0.05 else "[ ] ")
                + f"{int(alpha * 100)}%",
                lambda value=alpha: self._menu_alpha(value),
            )
        submenus.append(alpha_menu)

        font_menu = menu.addMenu("Font size")
        own_font = self.settings.get(f"{self.overlay_key}_font_size")
        shared = int(self.settings.get("font_size", 10) or 10)
        font_menu.addAction(
            ("[x] " if own_font in (None, "") else "[ ] ") + f"Как у всех ({shared})",
            lambda: self._set_own_font(None),
        )
        for value in (8, 9, 10, 11, 12, 14, 16, 18):
            font_menu.addAction(
                ("[x] " if own_font == value else "[ ] ") + str(value),
                lambda v=value: self._set_own_font(v),
            )
        submenus.append(font_menu)

        self._add_custom_menu_entries(menu)

        # Ссылки держим до закрытия меню: Qt-меню, уничтоженное под открытым
        # граббером, оставляет приложение без кликов.
        self._edit_menu = menu
        self._edit_submenus = submenus
        anchor = self.edit_btn.mapToGlobal(QPoint(0, self.edit_btn.height()))
        menu.popup(anchor)

    def _persist(self, name: str, value=None) -> None:
        """Сохранить правку из меню шапки и сообщить вкладке «Оверлей»."""
        if self._controller is None:
            return
        try:
            self._controller.save_settings()
            self._controller._notify_block(self.overlay_key, name, value)
        except Exception:
            pass

    def _menu_alpha(self, alpha: float) -> None:
        """Прозрачность из меню шапки — своя у этого блока."""
        if self._controller is not None:
            try:
                self._controller.set_block_alpha(self.overlay_key, alpha)
                return
            except Exception:
                pass
        self.set_alpha(alpha)

    def _set_own_font(self, size: Optional[int]) -> None:
        """Свой размер шрифта блока (None — общий)."""
        if self._controller is not None:
            try:
                self._controller.set_block_font_size(self.overlay_key, size)
                return
            except Exception:
                pass
        if size is None:
            self.settings.pop(f"{self.overlay_key}_font_size", None)
        else:
            self.settings[f"{self.overlay_key}_font_size"] = int(size)
        self.apply_font(self.settings.get("font_family", DEFAULT_FAMILY),
                        int(self.settings.get(f"{self.overlay_key}_font_size",
                                              self.settings.get("font_size", 10)) or 10))

    def _set_anchor(self, position: str) -> None:
        self._anchor = position
        self.settings[f"{self.overlay_key}_anchor"] = position
        self._apply_anchor()
        self._flash_indicator(COLOR_CYAN)
        self._persist("anchor", position)

    def _reset_size(self) -> None:
        from overlay_layout import DEFAULT_BLOCK_POSITIONS

        default = DEFAULT_BLOCK_POSITIONS.get(self.overlay_key, (50, 50, 280, 200))
        self.set_size(default[2], default[3])
        self._persist("size", (default[2], default[3]))

    # -- прозрачность и Z-order -------------------------------------------
    def set_alpha(self, alpha: float, save: bool = True) -> None:
        """Задать прозрачность окна.

        `save=False` — когда значение уже записано в настройки менеджером
        (общую или блока): окно не должно перетирать чужой ключ.
        """
        try:
            alpha = max(0.05, min(1.0, float(alpha)))
        except (TypeError, ValueError):
            return
        self._alpha = alpha
        if save:
            self.settings["alpha"] = alpha
        self.setWindowOpacity(alpha)
        # Смена прозрачности переписывает расширенный стиль окна — режим мыши
        # проверяем заново, иначе закреплённый блок начнёт ловить клики.
        self._applied_through = None
        QTimer.singleShot(0, self._sync_click_through)

    def set_topmost(self, topmost: bool) -> None:
        """Установить/снять «поверх всех окон»."""
        if self._is_topmost == bool(topmost):
            return
        self._is_topmost = bool(topmost)
        flags = self.windowFlags()
        if topmost:
            flags |= Qt.WindowStaysOnTopHint
        else:
            flags &= ~Qt.WindowStaysOnTopHint
        self.setWindowFlags(flags)
        if self.isVisible():
            self.show()

    # -- шрифт -------------------------------------------------------------
    def make_label(self, parent: QWidget, text: str = "", *, color: str = COLOR_TEXT,
                   background: Optional[str] = None, dp: int = 0, bold: bool = False,
                   wrap=0, align_right: bool = False) -> QLabel:
        """Подпись блока: кегль считается от базового размера этого блока.

        `dp` — смещение относительно базового кегля (как раньше `fs-1`).
        Кегль запоминается вместе с виджетом, поэтому `apply_font()` потом
        масштабирует всё содержимое разом и без пересборки окна.
        """
        size = max(6, int(self._font_size) + int(dp))
        label = hud_label(parent, text, color=color, background=background,
                          family=self._font_family, size=size, bold=bold,
                          wrap=wrap, align_right=align_right)
        self._font_specs[label] = size
        return label

    def _rescale_labels(self, factor: float) -> None:
        """Промасштабировать подписи, созданные через `make_label`."""
        for label, original in list(self._font_specs.items()):
            try:
                scaled = max(6, int(round(original * factor)))
                font = label.font()
                font.setPixelSize(scaled + 4)
                label.setFont(font)
                self._font_specs[label] = scaled
            except RuntimeError:
                # Виджет уже удалён (закрыли окно) — просто забываем его.
                self._font_specs.pop(label, None)

    def _register_fonts(self) -> None:
        """Запомнить базовый кегль содержимого.

        Раньше здесь обходились все виджеты и запоминались их шрифты: так
        масштабировали содержимое без пересоздания окна. Теперь блоки строят
        текст сами, и достаточно базового размера — по нему считаются кегли.
        """
        self._font_base = max(1, int(self._font_size))
        self._font_specs = {}

    def apply_font(self, family: str, size: int) -> None:
        """Живая смена шрифта без пересоздания окна."""
        try:
            size = max(6, min(28, int(size)))
        except (TypeError, ValueError):
            return
        family = str(family or self._font_family or DEFAULT_FAMILY)
        if size == int(self._font_size) and family == self._font_family:
            return
        factor = float(size) / float(max(1, self._font_base))
        self._font_family = family
        self._font_size = size
        self._font_base = max(1, size)
        self._rescale_labels(factor)
        self.title_label.setFont(hud_font(family, max(7, size - 1), bold=True))
        self.purpose_label.setFont(hud_font(family, max(6, size - 3)))
        self._applied_font = (family, size)
        self.on_font_changed()
        self._persist("font", size)

    def on_font_changed(self) -> None:
        """Блок перерисовывает содержимое под новый кегль (переопределяется)."""

    def font_spec(self) -> Tuple[str, int]:
        """Текущая пара (семейство, кегль) — ею пользуются блоки."""
        return self._font_family, self._font_size

    # -- видимость ---------------------------------------------------------
    def is_visible(self) -> bool:
        return bool(self.isVisible())

    def lift(self) -> None:
        self.raise_()

    def toggle(self) -> None:
        if self.isVisible():
            self.hide()
        else:
            self.show()

    def apply_data_options(self) -> None:
        """Скрыть разделы, которые выключены на вкладке «Оверлей»."""
        from overlay_options import CONTENT_DEFAULTS, CONTENT_OPTIONS, option_key

        key = self.overlay_key
        for section, (_label, attributes) in CONTENT_OPTIONS.get(key, {}).items():
            setting = option_key(key, section)
            visible = bool(self.settings.get(setting, CONTENT_DEFAULTS.get(setting, True)))
            for attribute in attributes:
                widget = getattr(self, attribute, None)
                if not isinstance(widget, QWidget):
                    continue
                if key == "exobio":
                    flag = {"telemetry_frame": "_telemetry_shown",
                            "signals_label": "_signals_shown",
                            "next_action_label": "_action_shown",
                            "planet_separator": "_planets_shown",
                            "planets_header": "_planets_shown",
                            "planets_label": "_planets_shown"}.get(attribute)
                    if flag and not getattr(self, flag, True):
                        continue
                # Уже в нужном состоянии — не дёргаем: лишняя смена видимости
                # пересобирает раскладку, а блок обновляется раз в секунду.
                if widget.isHidden() == (not visible):
                    continue
                widget.setVisible(visible)

    def destroy(self) -> None:
        """Закрыть окно и снять меню (меню держит граббер мыши).

        Повторный вызов безопасен: менеджер может закрыть блок, а следом это
        сделает сборка мусора или тест.
        """
        try:
            self._destroy_edit_menu()
            self.close()
            self.deleteLater()
        except RuntimeError:
            # C++-объект уже удалён — делать нечего.
            pass
