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

from PySide6.QtCore import QObject, Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QGuiApplication
from PySide6.QtWidgets import (
    QApplication,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

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
QLabel {{ color: {TEXT}; }}
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
QFrame#card {{ background: {PANEL_ALT}; border: 1px solid {LINE}; border-radius: 8px; }}
QFrame#cardAccent {{ border: none; border-radius: 2px; }}
"""


def ensure_app() -> QApplication:
    """Return the single QApplication instance, creating it on first use."""
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv[:1])
    app.setApplicationName("Colonial Helper")
    app.setApplicationDisplayName("ED Ring Colony — Colonial Helper")
    app.setQuitOnLastWindowClosed(True)
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
        widget.setStyleSheet(f"color:{color};")
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
        self.setFixedHeight(34)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 0, 6, 0)
        layout.setSpacing(2)
        self.title = QLabel(title)
        self.title.setObjectName("titlebarTitle")
        layout.addWidget(self.title)
        layout.addStretch(1)
        self.minimize = _title_button("—", name="titleButton", tooltip="Свернуть")
        self.maximize = _title_button("□", name="titleButton", tooltip="Развернуть")
        self.close_button = _title_button("×", name="titleButtonClose", tooltip="Закрыть")
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


def schedule(delay_ms: int, callback: Callable) -> None:
    QTimer.singleShot(int(delay_ms), callback)
