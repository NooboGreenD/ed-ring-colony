"""Native Qt building blocks shared by the Launcher and Setup windows.

Both windows are written directly against PySide6: nothing emulates Tk here, so
a missing attribute cannot turn into a window that exists but never appears.
Work that can block (network requests, file copies) is executed on a daemon
thread and reported back through Qt signals, which Qt delivers on the GUI
thread.
"""
from __future__ import annotations

import sys
import threading
from typing import Any, Callable, Optional

from PySide6.QtCore import QEvent, QObject, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QGuiApplication, QWheelEvent
from PySide6.QtWidgets import (
    QAbstractScrollArea,
    QAbstractSlider,
    QAbstractSpinBox,
    QApplication,
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTabBar,
    QVBoxLayout,
    QWidget,
)

from i18n import tr

BG = "#1e2022"
PANEL = "#2a2d30"
PANEL_ALT = "#25282b"
LINE = "#3b4044"
TEXT = "#f2f3f4"
MUTED = "#a1a8ad"
ORANGE = "#e57b28"
ORANGE_HOVER = "#f18b35"
CYAN = "#42b9d4"
GREEN = "#65c78a"
RED = "#e27676"
YELLOW = "#e2bc65"
DISABLED_TEXT = "#70777c"
TITLE_BG = "#17191b"

WINDOW_STYLE = f"""
QWidget#shell {{ background: {BG}; }}
QWidget#body {{ background: {BG}; }}
QWidget#panel {{ background: {PANEL}; }}
QWidget#panelAlt {{ background: {PANEL_ALT}; }}
QWidget#panelClear {{ background: transparent; }}
QFrame#accentOrange {{ background: {ORANGE}; border: none; }}
QFrame#accentCyan {{ background: {CYAN}; border: none; }}
QWidget#titlebar {{ background: {TITLE_BG}; }}
QLabel#titlebarTitle {{ color: {TEXT}; font-size: 9pt; font-weight: 600; }}
QPushButton#titleButton {{
    background: transparent; border: none; color: {MUTED};
    font-size: 12pt; padding: 0;
}}
QPushButton#titleButton:hover {{ background: {LINE}; color: {TEXT}; }}
QPushButton#titleButtonClose:hover {{ background: #c0392b; color: #ffffff; }}
QLabel {{ color: {TEXT}; background: transparent; }}
QLabel[role="muted"] {{ color: {MUTED}; }}
QLabel[role="accent"] {{ color: {CYAN}; font-weight: 600; }}
QLabel[role="mono"] {{ font-family: Consolas, "DejaVu Sans Mono", monospace; }}
QPushButton {{
    background: {PANEL_ALT}; color: {TEXT}; border: 1px solid {LINE};
    border-radius: 6px; padding: 9px 14px; font-weight: 600;
}}
QPushButton:hover {{ background: {LINE}; }}
QPushButton[variant="primary"] {{
    background: {ORANGE}; color: #ffffff; border: none;
}}
QPushButton[variant="primary"]:hover {{ background: {ORANGE_HOVER}; }}
QPushButton[variant="flat"] {{
    background: transparent; border: none; color: {CYAN}; padding: 4px 2px;
}}
QPushButton[variant="flat"]:hover {{ color: {TEXT}; }}
QPushButton:disabled {{ color: {DISABLED_TEXT}; background: {PANEL_ALT}; border-color: {LINE}; }}
QPushButton[variant="primary"]:disabled {{ background: #4a3a2a; color: #a89a8c; }}
QPushButton[variant="danger"] {{
    color: {RED}; border-color: {RED};
}}
QPushButton[variant="danger"]:hover {{ background: #4a2b2b; }}
QPushButton[variant="tab"] {{
    background: transparent; border: none; border-bottom: 2px solid transparent;
    border-radius: 0; color: {MUTED}; padding: 9px 14px;
}}
QPushButton[variant="tab"]:checked {{ color: {TEXT}; border-bottom-color: {ORANGE}; }}
QCheckBox {{ color: {TEXT}; spacing: 8px; }}
QCheckBox::indicator {{
    width: 14px; height: 14px; border: 1px solid {LINE};
    border-radius: 3px; background: {PANEL_ALT};
}}
QCheckBox::indicator:hover {{ border-color: {CYAN}; }}
QCheckBox::indicator:checked {{ background: {ORANGE}; border-color: {ORANGE}; }}
QCheckBox::indicator:disabled {{ background: {PANEL}; border-color: {LINE}; }}
QRadioButton {{ color: {TEXT}; spacing: 8px; }}
QRadioButton::indicator {{
    width: 14px; height: 14px; border: 1px solid {LINE};
    border-radius: 7px; background: {PANEL_ALT};
}}
QRadioButton::indicator:hover {{ border-color: {CYAN}; }}
QRadioButton::indicator:checked {{ background: {ORANGE}; border-color: {ORANGE}; }}
QTabWidget::pane {{ border: 1px solid {LINE}; border-radius: 6px; background: {PANEL}; }}
QTabBar::tab {{
    background: {PANEL_ALT}; color: {MUTED}; border: 1px solid {LINE};
    border-bottom: none; padding: 6px 14px; margin-right: 2px;
    border-top-left-radius: 6px; border-top-right-radius: 6px;
}}
QTabBar::tab:selected {{ background: {PANEL}; color: {TEXT}; border-bottom-color: {PANEL}; }}
QTabBar::tab:hover {{ color: {TEXT}; }}
QComboBox {{
    background: {PANEL_ALT}; color: {TEXT}; border: 1px solid {LINE};
    border-radius: 6px; padding: 6px 10px;
}}
QComboBox QAbstractItemView {{
    background: {PANEL_ALT}; color: {TEXT}; selection-background-color: {ORANGE};
    selection-color: #ffffff;
}}
QScrollArea {{ border: none; background: {PANEL}; }}
QScrollArea > QWidget > QWidget {{ background: {PANEL}; }}
QScrollBar:vertical {{ background: {PANEL}; width: 10px; margin: 0; }}
QScrollBar::handle:vertical {{ background: {LINE}; min-height: 30px; border-radius: 5px; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QFrame#separator {{ background: {LINE}; max-height: 1px; border: none; }}
QTableWidget {{
    background: {PANEL}; alternate-background-color: {PANEL_ALT};
    color: {TEXT}; gridline-color: {LINE}; border: 1px solid {LINE};
    border-radius: 6px; selection-background-color: {PANEL_ALT};
    selection-color: {TEXT};
}}
QTableWidget::item {{ padding: 4px 6px; }}
QHeaderView::section {{
    background: {PANEL_ALT}; color: {MUTED}; border: none;
    border-bottom: 1px solid {LINE}; padding: 6px; font-weight: 600;
}}
QTableCornerButton::section {{ background: {PANEL_ALT}; border: none; }}
QLineEdit, QPlainTextEdit, QTextEdit {{
    background: {PANEL_ALT}; color: {TEXT}; border: 1px solid {LINE};
    border-radius: 6px; padding: 6px 8px;
    selection-background-color: {ORANGE}; selection-color: #ffffff;
}}
QMenu {{ background: {PANEL_ALT}; color: {TEXT}; border: 1px solid {LINE}; }}
QMenu::item:selected {{ background: {LINE}; }}
QSlider::groove:horizontal {{ background: {LINE}; height: 4px; border-radius: 2px; }}
QSlider::handle:horizontal {{
    background: {ORANGE}; width: 14px; margin: -6px 0; border-radius: 7px;
}}
QProgressBar {{
    background: {PANEL_ALT}; border: 1px solid {LINE}; border-radius: 6px;
    text-align: center; color: {TEXT}; min-height: 14px;
}}
QProgressBar::chunk {{ background: {ORANGE}; border-radius: 5px; }}
QToolTip {{ background: {PANEL_ALT}; color: {TEXT}; border: 1px solid {LINE}; }}
QFrame#card {{ background: {PANEL_ALT}; border: 1px solid {LINE}; border-radius: 8px; }}
QFrame#cardAccent {{ border: none; border-radius: 2px; }}
"""


#: Виджеты, которые меняют значение от колеса мыши, даже когда на них не
#: нажимали: колесо доставляется виджету под курсором, а фокус ему для этого
#: не нужен. Именно из-за этого «прокрутка страницы» молча меняла план
#: площадки, экран оверлея или размер шрифта.
#:
#: Списки (`QComboBox`) сюда не входят: у них правило строже — колесо не меняет
#: выбор никогда, даже когда список в фокусе (см. :class:`WheelGuard`).
WHEEL_SENSITIVE = (QAbstractSpinBox, QAbstractSlider, QTabBar)


def enclosing_combo(widget: Optional[QObject]) -> Optional[QComboBox]:
    """Ближайший выпадающий список вокруг виджета: он сам, его попап или поле.

    Колесо над открытым списком приходит не в `QComboBox`, а в его попап —
    отдельное окно с `QListView`. Родитель попапа в Qt — сам список, поэтому
    подъём по `parentWidget()` находит владельца в обоих случаях.
    """
    current = widget if isinstance(widget, QWidget) else None
    for _step in range(8):                    # глубина дерева попапа невелика
        if current is None:
            return None
        if isinstance(current, QComboBox):
            return current
        current = current.parentWidget()
    return None


def combo_popup_open(combo: QComboBox) -> bool:
    """Открыт ли список выбора у этого `QComboBox`."""
    view = combo.view()
    return view is not None and view.isVisible()


def inside_combo_popup(widget: Optional[QObject], combo: QComboBox) -> bool:
    """Лежит ли виджет внутри открытого попапа этого списка (view или скроллбар)."""
    current = widget if isinstance(widget, QWidget) else None
    view = combo.view()
    for _step in range(8):
        if current is None or view is None:
            return False
        if current is view:
            return True
        current = current.parentWidget()
    return False


class WheelGuard(QObject):
    """Колесо мыши не меняет значения настроек само по себе.

    Два правила, оба про «случайное движение руки»:

    * **Выпадающие списки колесо не листают никогда** — ни до клика, ни после,
      когда список уже в фокусе, ни в открытом попапе. Значение меняется
      только осознанным выбором: открыть список и нажать строку. Раньше клик по
      списку давал ему фокус, и следующее движение колеса молча переключало
      язык, план площадки или экран оверлея — со стороны это выглядело так,
      будто программа «сама прокрутила» настройку. Открытый попап при этом
      листается колесом сам (длинный список из девяти пунктов иначе не
      достать), но двигаются только пункты меню: ни выбор, ни страница под
      меню не меняются.
    * **Ползунки, счётчики и вкладки** меняются от колеса только в фокусе:
      колесо листает страницу, а не значение.

    Событие при этом не пропадает — оно уходит ближайшей прокручиваемой
    области, поэтому страница под курсором продолжает прокручиваться как
    обычно. Исключение — открытый попап списка: страницу под ним не двигаем,
    иначе меню уезжает из-под курсора.

    Фильтр ставится на приложение целиком (`ensure_app`): тогда правило
    действует и для страниц Helper, и для лаунчера, и для Setup, не требуя
    трогать каждую страницу отдельно.
    """

    def __init__(self, parent: Optional[QObject] = None) -> None:
        super().__init__(parent)
        self.suppressed = 0          # сколько событий колеса перехвачено (тесты)

    @staticmethod
    def scroll_ancestor(widget: QWidget) -> Optional[QWidget]:
        """Ближайшая прокручиваемая область вокруг виджета (или `None`)."""
        parent = widget.parentWidget() if isinstance(widget, QWidget) else None
        while parent is not None:
            if isinstance(parent, QAbstractScrollArea):
                return parent
            parent = parent.parentWidget()
        return None

    @staticmethod
    def scroll_by(area: QWidget, event: QWheelEvent) -> bool:
        """Прокрутить область на величину колеса. `False` — прокручивать нечего.

        Считаем сами, а не пересылаем событие: Qt применяет «плавную»
        прокрутку только к событиям от настоящей мыши, поэтому пересланное
        событие страницу не двигало бы (и колесо над списком просто пропадало).
        Три строки за щелчок — то же, что делает Qt по умолчанию.
        """
        bar = area.verticalScrollBar() if isinstance(area, QAbstractScrollArea) else None
        if bar is None:
            return False
        pixels = int(event.pixelDelta().y())
        if pixels:
            bar.setValue(bar.value() - pixels)
            return True
        angle = int(event.angleDelta().y())
        if not angle:
            return False
        bar.setValue(int(bar.value() - angle / 120.0 * bar.singleStep() * 3))
        return True

    def eventFilter(self, obj: QObject, event: QEvent) -> bool:  # noqa: N802 - Qt API
        if event.type() != QEvent.Type.Wheel:
            return super().eventFilter(obj, event)
        combo = enclosing_combo(obj)
        if combo is not None:
            if combo_popup_open(combo) and inside_combo_popup(obj, combo):
                # Открытое меню листает само себя: пункты едут, выбор — нет.
                return False
            # Закрытый список значение от колеса не меняет ни в каком состоянии.
            self.suppressed += 1
            area = self.scroll_ancestor(combo)
            if area is not None:
                # Страница листается, выбранное значение остаётся прежним.
                self.scroll_by(area, event)
            return True
        if isinstance(obj, WHEEL_SENSITIVE) and not obj.hasFocus():
            self.suppressed += 1
            area = self.scroll_ancestor(obj)
            if area is not None:
                # Страница листается, значение виджета остаётся прежним.
                self.scroll_by(area, event)
            return True
        return super().eventFilter(obj, event)


def install_wheel_guard(app: Optional[QApplication] = None) -> WheelGuard:
    """Включить правило «колесо не меняет значения без клика» (один раз)."""
    target = app or ensure_app()
    guard = getattr(target, "_edrc_wheel_guard", None)
    if guard is None:
        guard = WheelGuard(target)
        target._edrc_wheel_guard = guard          # держим ссылку: фильтр без неё умрёт
        target.installEventFilter(guard)
    return guard


def ensure_app() -> QApplication:
    """Return the single QApplication instance, creating it on first use."""
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv[:1])
    app.setApplicationName("Colonial Helper")
    app.setApplicationDisplayName("ED Ring Colony — Colonial Helper")
    app.setQuitOnLastWindowClosed(True)
    install_wheel_guard(app)
    return app


class Task(QObject):
    """Run a callable off the GUI thread and report back through signals."""

    done = Signal(object)
    failed = Signal(object)
    progress = Signal(int, int)

    def start(self, work: Callable[[], Any], on_done: Optional[Callable] = None,
              on_error: Optional[Callable] = None) -> "Task":
        if on_done is not None:
            self.done.connect(on_done)
        if on_error is not None:
            self.failed.connect(on_error)
        threading.Thread(target=self._run, args=(work,), daemon=True,
                         name="helper-ui-work").start()
        return self

    def _run(self, work: Callable[[], Any]) -> None:
        try:
            result = work()
        except BaseException as exc:  # reported to the user, never swallowed
            self.failed.emit(exc)
            return
        self.done.emit(result)


def describe_error(error: Any) -> str:
    """Human-readable text for an exception or an already formatted message."""
    if isinstance(error, BaseException):
        return f"{type(error).__name__}: {error}" if str(error) else type(error).__name__
    return str(error)


def run_async(owner: QObject, work: Callable[[], Any], on_done: Callable,
              on_error: Optional[Callable] = None) -> Task:
    """Start ``work`` for ``owner``; the returned task stays parented to it."""
    task = Task(owner)
    return task.start(work, on_done=on_done, on_error=on_error)


def panel(widget: QWidget, name: str) -> QWidget:
    """Give a plain container a themed background that QSS will actually paint.

    Qt does not paint style-sheet backgrounds for custom ``QWidget`` instances
    unless ``WA_StyledBackground`` is enabled, which made panels look
    transparent and let the window colour show through.
    """
    widget.setObjectName(name)
    widget.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
    return widget


def label(text: str = "", *, role: Optional[str] = None, size: Optional[int] = None,
          bold: bool = False, wrap: bool = False, color: Optional[str] = None,
          word_wrap_width: Optional[int] = None) -> QLabel:
    widget = QLabel(text)
    if role:
        widget.setProperty("role", role)
    if wrap:
        widget.setWordWrap(True)
    if word_wrap_width:
        widget.setMaximumWidth(word_wrap_width)
    font = widget.font()
    if size:
        font.setPointSize(size)
    if bold:
        font.setBold(True)
    if size or bold:
        widget.setFont(font)
    if color:
        # Без явного `background: transparent` Qt рисует под такой подписью
        # фон из палитры окна, и на панели страницы появляется светлая плашка.
        widget.setStyleSheet(f"color:{color}; background: transparent;")
    return widget


def heading(text: str, *, size: int = 20, color: str = TEXT) -> QLabel:
    widget = label(text, size=size, bold=True, color=color)
    widget.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
    return widget


def action_button(text: str, on_click: Optional[Callable] = None, *, primary: bool = False,
                  flat: bool = False, height: Optional[int] = None,
                  variant: Optional[str] = None) -> QPushButton:
    button = QPushButton(text)
    button.setProperty("variant", variant or ("primary" if primary else "flat" if flat else "default"))
    button.setCursor(Qt.CursorShape.PointingHandCursor)
    if height:
        button.setMinimumHeight(height)
    if on_click is not None:
        button.clicked.connect(lambda _checked=False: on_click())
    return button


def separator() -> QFrame:
    line = QFrame()
    line.setObjectName("separator")
    line.setFrameShape(QFrame.Shape.HLine)
    line.setFixedHeight(1)
    return line


def row(*widgets, spacing: int = 8, margins: tuple = (0, 0, 0, 0)) -> QWidget:
    container = QWidget()
    layout = QHBoxLayout(container)
    layout.setContentsMargins(*margins)
    layout.setSpacing(spacing)
    for widget in widgets:
        if widget is None:
            layout.addStretch(1)
        else:
            layout.addWidget(widget)
    return container


def column(*widgets, spacing: int = 8, margins: tuple = (0, 0, 0, 0)) -> QWidget:
    container = QWidget()
    layout = QVBoxLayout(container)
    layout.setContentsMargins(*margins)
    layout.setSpacing(spacing)
    for widget in widgets:
        if widget is None:
            layout.addStretch(1)
        else:
            layout.addWidget(widget)
    return container


def open_url(url: str) -> None:
    QDesktopServices.openUrl(QUrl(str(url)))


def center_on_screen(window: QWidget) -> None:
    screen = window.screen() or QGuiApplication.primaryScreen()
    if screen is None:
        return
    available = screen.availableGeometry()
    frame = window.frameGeometry()
    window.move(
        available.x() + max(0, (available.width() - frame.width()) // 2),
        available.y() + max(0, (available.height() - frame.height()) // 2),
    )


def _title_button(text: str, *, name: str, tooltip: str) -> QPushButton:
    button = QPushButton(text)
    button.setObjectName(name)
    button.setToolTip(tooltip)
    button.setFixedSize(34, 28)
    button.setFlat(True)
    button.setCursor(Qt.CursorShape.ArrowCursor)
    button.setFocusPolicy(Qt.FocusPolicy.NoFocus)
    return button


_CURSORS = {
    "left": Qt.CursorShape.SizeHorCursor,
    "right": Qt.CursorShape.SizeHorCursor,
    "top": Qt.CursorShape.SizeVerCursor,
    "bottom": Qt.CursorShape.SizeVerCursor,
    "topleft": Qt.CursorShape.SizeFDiagCursor,
    "bottomright": Qt.CursorShape.SizeFDiagCursor,
    "topright": Qt.CursorShape.SizeBDiagCursor,
    "bottomleft": Qt.CursorShape.SizeBDiagCursor,
}


class _TitleBar(QWidget):
    """Custom dark title bar: the window keeps a frameless look."""

    def __init__(self, window: "FramelessWindow", title: str) -> None:
        super().__init__(window)
        self._window = window
        self.setObjectName("titlebar")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setFixedHeight(34)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 0, 6, 0)
        layout.setSpacing(2)
        self.title = QLabel(title)
        self.title.setObjectName("titlebarTitle")
        layout.addWidget(self.title)
        layout.addStretch(1)
        self.minimize = _title_button("—", name="titleButton", tooltip=tr("Свернуть"))
        self.maximize = _title_button("□", name="titleButton", tooltip=tr("Развернуть"))
        self.close_button = _title_button("×", name="titleButtonClose", tooltip=tr("Закрыть"))
        self.close_button.setObjectName("titleButton")
        self.close_button.setProperty("close", True)
        for button in (self.minimize, self.maximize, self.close_button):
            layout.addWidget(button)
        self.minimize.clicked.connect(window.showMinimized)
        self.maximize.clicked.connect(window._toggle_maximized)
        self.close_button.clicked.connect(window.close)
        self._drag_origin = None

    def set_title(self, title: str) -> None:
        self.title.setText(str(title))

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt API
        if event.button() == Qt.MouseButton.LeftButton:
            handle = self._window.windowHandle()
            if handle is not None and handle.startSystemMove():
                self._drag_origin = None
                event.accept()
                return
            self._drag_origin = event.globalPosition().toPoint()
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 - Qt API
        if (self._drag_origin is not None
                and event.buttons() & Qt.MouseButton.LeftButton):
            position = event.globalPosition().toPoint()
            self._window.move(self._window.pos() + position - self._drag_origin)
            self._drag_origin = position
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802 - Qt API
        self._drag_origin = None
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: N802 - Qt API
        if event.button() == Qt.MouseButton.LeftButton:
            self._window._toggle_maximized()
        super().mouseDoubleClickEvent(event)


#: Коды WM_NCHITTEST для растягивания окна за края (Windows). Нужны, потому
#: что у рамки нет системного заголовка: без них окно нельзя растянуть мышью.
HT_LEFT, HT_RIGHT, HT_TOP, HT_TOPLEFT = 10, 11, 12, 13
HT_TOPRIGHT, HT_BOTTOM, HT_BOTTOMLEFT, HT_BOTTOMRIGHT = 14, 15, 16, 17
WM_NCHITTEST = 0x0084


def native_hit_test_enabled(platform: str, *, resizable: bool, maximized: bool) -> bool:
    """Нужно ли отвечать на ``WM_NCHITTEST`` самим.

    Только Windows: на Linux и macOS рамку окна растягивает сама система, а
    Qt присылает окну обычные события края.
    """
    return str(platform) == "win32" and bool(resizable) and not bool(maximized)


def hit_test_code(edges) -> int:
    """Края окна → код ``WM_NCHITTEST`` (0 — обычная точка)."""
    left = bool(edges & Qt.Edge.LeftEdge)
    right = bool(edges & Qt.Edge.RightEdge)
    top = bool(edges & Qt.Edge.TopEdge)
    bottom = bool(edges & Qt.Edge.BottomEdge)
    if left and top:
        return HT_TOPLEFT
    if right and top:
        return HT_TOPRIGHT
    if left and bottom:
        return HT_BOTTOMLEFT
    if right and bottom:
        return HT_BOTTOMRIGHT
    if left:
        return HT_LEFT
    if right:
        return HT_RIGHT
    if top:
        return HT_TOP
    if bottom:
        return HT_BOTTOM
    return 0


class FramelessWindow(QWidget):
    """Dark frameless window with a custom title bar and draggable edges.

    The custom frame is intentional: it is part of the product's look, so it is
    implemented natively with ``startSystemMove``/``startSystemResize`` instead
    of replacing it with the default Windows caption.
    """

    RESIZE_MARGIN = 5

    def __init__(self, title: str, *, resizable: bool = True, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setWindowFlags(Qt.WindowType.Window | Qt.WindowType.FramelessWindowHint)
        self.setWindowTitle(str(title))
        self.setObjectName("shell")
        # Фон окна и шапки рисуется таблицей стилей — только при этом флаге:
        # иначе по краям окна просвечивал системный светлый цвет.
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setStyleSheet(WINDOW_STYLE)
        self.setMouseTracking(True)
        self._resizable = bool(resizable)
        self._drag_origin = None

        shell = QVBoxLayout(self)
        shell.setContentsMargins(0, 0, 0, 0)
        shell.setSpacing(0)
        self.titlebar = _TitleBar(self, str(title))
        self.titlebar.maximize.setVisible(self._resizable)
        shell.addWidget(self.titlebar)
        self.body = QWidget()
        self.body.setObjectName("body")
        # Без этого флага Qt не рисует фон из таблицы стилей для обычного
        # QWidget: между панелями просвечивал системный светлый цвет окна.
        self.body.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.body_layout = QVBoxLayout(self.body)
        self.body_layout.setContentsMargins(20, 18, 20, 18)
        self.body_layout.setSpacing(12)
        shell.addWidget(self.body, 1)

    def setWindowTitle(self, title: str) -> None:  # noqa: N802 - Qt API
        super().setWindowTitle(str(title))
        if hasattr(self, "titlebar"):
            self.titlebar.set_title(str(title))

    def _toggle_maximized(self) -> None:
        if not self._resizable:
            return
        if self.isMaximized():
            self.showNormal()
        else:
            self.showMaximized()

    def _edges_at(self, position) -> Qt.Edge:
        if not self._resizable or self.isMaximized():
            return Qt.Edge(0)
        margin = self.RESIZE_MARGIN
        edges = Qt.Edge(0)
        if position.x() <= margin:
            edges |= Qt.Edge.LeftEdge
        elif position.x() >= self.width() - margin:
            edges |= Qt.Edge.RightEdge
        if position.y() <= margin:
            edges |= Qt.Edge.TopEdge
        elif position.y() >= self.height() - margin:
            edges |= Qt.Edge.BottomEdge
        return edges

    @staticmethod
    def _cursor_for(edges: Qt.Edge) -> Qt.CursorShape:
        left = bool(edges & Qt.Edge.LeftEdge)
        right = bool(edges & Qt.Edge.RightEdge)
        top = bool(edges & Qt.Edge.TopEdge)
        bottom = bool(edges & Qt.Edge.BottomEdge)
        if (left and top) or (right and bottom):
            return _CURSORS["topleft"]
        if (right and top) or (left and bottom):
            return _CURSORS["topright"]
        if left or right:
            return _CURSORS["left"]
        if top or bottom:
            return _CURSORS["top"]
        return Qt.CursorShape.ArrowCursor

    def mouseMoveEvent(self, event) -> None:  # noqa: N802 - Qt API
        self.setCursor(self._cursor_for(self._edges_at(event.position().toPoint())))
        super().mouseMoveEvent(event)

    def mousePressEvent(self, event) -> None:  # noqa: N802 - Qt API
        if event.button() == Qt.MouseButton.LeftButton:
            edges = self._edges_at(event.position().toPoint())
            if edges:
                handle = self.windowHandle()
                if handle is not None and handle.startSystemResize(edges):
                    event.accept()
                    return
        super().mousePressEvent(event)

    def nativeEvent(self, event_type, message):  # noqa: N802 - Qt API
        """Растягивание за края там, где клики до окна не доходят.

        У окна нет системной рамки, а содержимое (панели, таблицы, боковая
        колонка) занимает всю площадь — курсор у края попадает в дочерний
        виджет, и Qt не присылает окну ни ``mouseMove``, ни ``mousePress``.
        На Windows поэтому отвечаем на ``WM_NCHITTEST`` сами: система получает
        «здесь левый край» и тянет окно нативно, как за обычную рамку.
        """
        if (native_hit_test_enabled(sys.platform, resizable=self._resizable,
                                    maximized=self.isMaximized())
                and event_type in (b"windows_generic_MSG", b"windows_dispatcher_MSG")):
            try:
                from ctypes import wintypes

                msg = wintypes.MSG.from_address(int(message))
                if msg.message == WM_NCHITTEST:
                    local = self.mapFromGlobal(_point(msg.pt.x, msg.pt.y))
                    code = hit_test_code(self._edges_at(local))
                    if code:
                        return True, code
            except Exception:
                # Не наша платформа или Qt без доступа к MSG: обычная обработка.
                pass
        return super().nativeEvent(event_type, message)


#: Коды результата у :class:`FramedDialog` — те же числа, что у ``QDialog``,
#: поэтому вызывающий код читает их так же, как раньше.
DIALOG_REJECTED = 0
DIALOG_ACCEPTED = 1


class FramedDialog(FramelessWindow):
    """Модальное окно в оформлении приложения: своя шапка, рамка и ресайз.

    ``QDialog`` на Windows рисует системный заголовок и системную рамку, и
    такое окно выпадает из тёмного интерфейса Helper. Здесь тот же
    ``FramelessWindow``, что у лаунчера, плюс поведение диалога: модальность,
    ``accept()``/``reject()`` и ``exec()`` с вложенным циклом событий, который
    возвращает код результата.
    """

    def __init__(self, title: str, *, resizable: bool = True,
                 parent: Optional[QWidget] = None) -> None:
        super().__init__(tr(title), resizable=resizable, parent=parent)
        self.setWindowModality(Qt.WindowModality.ApplicationModal)
        self._result = DIALOG_REJECTED
        self._loop = None

    # ---------------------------------------------------------------- результат
    def result(self) -> int:
        return int(self._result)

    def accept(self) -> None:
        self._result = DIALOG_ACCEPTED
        self._finish()

    def reject(self) -> None:
        self._result = DIALOG_REJECTED
        self._finish()

    def _finish(self) -> None:
        """Спрятать окно и вернуть управление вызывающему ``exec()``."""
        loop = self._loop
        self.hide()
        if loop is not None and loop.isRunning():
            loop.exit(self._result)

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt API
        # Крестик и Esc — это отказ, а не «закрылось, ничего не выбрав».
        if self._result != DIALOG_ACCEPTED:
            self._result = DIALOG_REJECTED
        super().closeEvent(event)
        if self._loop is not None and self._loop.isRunning():
            self._loop.exit(int(self._result))

    def keyPressEvent(self, event) -> None:  # noqa: N802 - Qt API
        if event.key() == Qt.Key.Key_Escape:
            self.reject()
            return
        super().keyPressEvent(event)

    def showEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().showEvent(event)
        if not getattr(self, "_centered", False):
            self._centered = True
            self.center_on_parent()

    def center_on_parent(self) -> None:
        """Поставить окно по центру родителя, а без него — по центру экрана."""
        parent = self.parentWidget()
        if parent is not None and parent.isVisible():
            anchor = parent.frameGeometry()
            frame = self.frameGeometry()
            self.move(anchor.center().x() - frame.width() // 2,
                      anchor.center().y() - frame.height() // 2)
            return
        center_on_screen(self)

    # --------------------------------------------------------------- цикл окна
    def exec(self) -> int:  # noqa: A003 - имя намеренно как у QDialog
        """Показать окно модально и дождаться ответа; вернуть код результата."""
        from PySide6.QtCore import QEventLoop

        # `ensure_app()` заодно включает «выход по последнему окну» — а Helper
        # живёт с выключенной политикой. Если приложение уже есть, не трогаем её.
        if QApplication.instance() is None:
            ensure_app()
        self._result = DIALOG_REJECTED
        self.show()
        self.raise_()
        self.activateWindow()
        self._loop = QEventLoop(self)
        try:
            self._loop.exec()
        finally:
            self._loop = None
        return self.result()


def _point(x: int, y: int):
    """Точка Qt из экранных координат Windows (без зависимости от QPoint)."""
    from PySide6.QtCore import QPoint

    return QPoint(int(x), int(y))


def show_error_dialog(title: str, message: str, *, guard: Optional[QWidget] = None) -> None:
    """Last-resort error surface used when a window cannot be built at all."""
    from PySide6.QtWidgets import QMessageBox

    try:
        ensure_app()
        QMessageBox.critical(guard, str(title), str(message))
    except BaseException:
        print(f"{title}: {message}", file=sys.stderr)


def report_startup_error(exc: BaseException, *, title: str) -> None:
    """Print for consoles and show a dialog for windowed builds, then keep going."""
    detail = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
    print(f"{title}: {detail}", file=sys.stderr)
    show_error_dialog(title, detail)


# ---------------------------------------------------------------------------
#  Диалоги
# ---------------------------------------------------------------------------
#: Qt-обёртки для вопросов, сообщений и выбора файлов. Они повторяют прежние
#: сигнатуры (`parent=`, `initialdir=`, `filetypes=`), поэтому вызывающий код
#: Helper не зависит от того, каким было окно раньше.
#:
#: `DIALOGS_ENABLED = False` переводит их в headless-режим: модальное окно
#: вернуло бы управление только после клика, которого в прогоне тестов нет.

DIALOGS_ENABLED = True


def _dialog_parent(parent) -> "Optional[QWidget]":
    return parent if isinstance(parent, QWidget) else None


def _qt_filter(filetypes) -> str:
    parts = []
    for entry in filetypes or ():
        try:
            title, pattern = entry
        except (TypeError, ValueError):
            continue
        parts.append(f"{title} ({pattern})")
    return ";;".join(parts)


def ask_yes_no(title: str, message: str, *, parent=None) -> bool:
    """Модальный вопрос «да/нет»; по умолчанию выбран отказ."""
    if not DIALOGS_ENABLED:
        return False
    from PySide6.QtWidgets import QMessageBox

    ensure_app()
    box = QMessageBox(_dialog_parent(parent))
    box.setWindowTitle(str(title))
    box.setText(str(message))
    box.setIcon(QMessageBox.Icon.Question)
    box.setStandardButtons(QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
    box.setDefaultButton(QMessageBox.StandardButton.No)
    return box.exec() == int(QMessageBox.StandardButton.Yes)


def _show_box(icon, title: str, message: str, parent=None) -> None:
    from PySide6.QtWidgets import QMessageBox

    ensure_app()
    box = QMessageBox(_dialog_parent(parent))
    box.setWindowTitle(str(title))
    box.setText(str(message))
    box.setIcon(icon)
    box.setStandardButtons(QMessageBox.StandardButton.Ok)
    box.exec()


def show_info(title: str, message: str, *, parent=None) -> None:
    if not DIALOGS_ENABLED:
        return None
    from PySide6.QtWidgets import QMessageBox

    _show_box(QMessageBox.Icon.Information, title, message, parent)


def show_warning(title: str, message: str, *, parent=None) -> None:
    if not DIALOGS_ENABLED:
        return None
    from PySide6.QtWidgets import QMessageBox

    _show_box(QMessageBox.Icon.Warning, title, message, parent)


def show_error(title: str, message: str, *, parent=None) -> None:
    if not DIALOGS_ENABLED:
        return None
    from PySide6.QtWidgets import QMessageBox

    _show_box(QMessageBox.Icon.Critical, title, message, parent)


def ask_string(title: str, prompt: str, *, initialvalue: str = "", parent=None) -> "Optional[str]":
    """Строка ввода; ``None`` — пользователь отказался."""
    if not DIALOGS_ENABLED:
        return None
    from PySide6.QtWidgets import QInputDialog

    ensure_app()
    value, accepted = QInputDialog.getText(_dialog_parent(parent), str(title),
                                           str(prompt), text=str(initialvalue or ""))
    return str(value) if accepted else None


def ask_directory(*, initialdir: str = "", title: str = "Выбор папки", parent=None) -> str:
    if not DIALOGS_ENABLED:
        return ""
    from PySide6.QtWidgets import QFileDialog

    ensure_app()
    return QFileDialog.getExistingDirectory(_dialog_parent(parent), tr(title),
                                            str(initialdir or ""))


def ask_open_files(*, initialdir: str = "", filetypes=(), title: str = "Выбор файлов",
                   parent=None) -> list:
    if not DIALOGS_ENABLED:
        return []
    from PySide6.QtWidgets import QFileDialog

    ensure_app()
    files, _selected = QFileDialog.getOpenFileNames(_dialog_parent(parent), tr(title),
                                                    str(initialdir or ""), _qt_filter(filetypes))
    return list(files)


def ask_open_file(*, initialdir: str = "", filetypes=(), title: str = "Выбор файла",
                  parent=None) -> str:
    if not DIALOGS_ENABLED:
        return ""
    from PySide6.QtWidgets import QFileDialog

    ensure_app()
    path, _selected = QFileDialog.getOpenFileName(_dialog_parent(parent), tr(title),
                                                  str(initialdir or ""), _qt_filter(filetypes))
    return str(path)


def ask_save_file(*, initialfile: str = "", defaultextension: str = "", filetypes=(),
                  title: str = "Сохранение файла", parent=None) -> str:
    if not DIALOGS_ENABLED:
        return ""
    from PySide6.QtWidgets import QFileDialog

    ensure_app()
    dialog = QFileDialog(_dialog_parent(parent), tr(title))
    dialog.setAcceptMode(QFileDialog.AcceptMode.AcceptSave)
    dialog.setNameFilter(_qt_filter(filetypes) or "All files (*.*)")
    if initialfile:
        dialog.selectFile(str(initialfile))
    if defaultextension:
        dialog.setDefaultSuffix(str(defaultextension).lstrip("."))
    if dialog.exec() != int(QFileDialog.DialogCode.Accepted):
        return ""
    chosen = dialog.selectedFiles()
    return str(chosen[0]) if chosen else ""


def schedule(delay_ms: int, callback: Callable) -> None:
    QTimer.singleShot(int(delay_ms), callback)
