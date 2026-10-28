"""Native Qt main window for Colonial Helper.

The window is a :class:`ui_qt.FramelessWindow` with the product's custom frame.
Application code talks to it through a small, explicit API — timers, clipboard,
window-level hotkeys and the close hook — instead of the previous Tk facade.
"""
from __future__ import annotations

from typing import Callable, Dict, Optional

from PySide6.QtCore import QTimer
from PySide6.QtGui import QGuiApplication, QIcon, QKeySequence, QShortcut
from PySide6.QtWidgets import QApplication

from ui_qt import FramelessWindow, ensure_app

#: Window-level hotkeys. Global (system-wide) hotkeys are handled by the
#: overlay manager itself; these fire while the Helper window has focus.
SHORTCUT_KEYS = {
    "<F12>": "F12",
    "<Control-F12>": "Ctrl+F12",
    "<Control-o>": "Ctrl+O",
    "<Control-O>": "Ctrl+O",
}


class HelperWindow(FramelessWindow):
    """Main window: custom frame, timers, clipboard and a close hook."""

    def __init__(self, title: str = "Colonial Helper") -> None:
        ensure_app()
        super().__init__(title)
        self._timers: Dict[int, QTimer] = {}
        self._timer_seq = 0
        self._shortcuts = []
        self._close_handler: Optional[Callable] = None
        self._closing = False
        self.setMinimumSize(980, 630)

    # ------------------------------------------------------------------ window
    def run(self) -> int:
        """Show the window and enter the Qt event loop."""
        self.show()
        return int(ensure_app().exec())

    def geometry(self, spec: Optional[str] = None):  # noqa: N802 - Tk-style call
        if spec is None:
            return f"{self.width()}x{self.height()}"
        width, _, height = str(spec).lower().partition("x")
        try:
            self.resize(int(width), int(height))
        except (TypeError, ValueError):
            pass
        return f"{self.width()}x{self.height()}"

    def title(self, text: Optional[str] = None) -> str:  # noqa: N802 - Tk-style call
        if text is not None:
            self.setWindowTitle(str(text))
        return self.windowTitle()

    def minsize(self, width: int, height: int) -> None:
        self.setMinimumSize(int(width), int(height))

    def iconbitmap(self, path: str) -> None:  # noqa: N802 - Tk-style call
        try:
            icon = QIcon(str(path))
            if not icon.isNull():
                self.setWindowIcon(icon)
        except Exception:
            pass

    def winfo_width(self) -> int:  # noqa: N802 - Tk-style call
        return int(self.width())

    def winfo_exists(self) -> bool:  # noqa: N802 - Tk-style call
        return not self._closing

    # ------------------------------------------------------------------ timers
    def after(self, delay_ms: int, callback: Callable) -> int:
        """Run ``callback`` once after ``delay_ms``; returns a cancellation id."""
        timer = QTimer(self)
        timer.setSingleShot(True)

        def fire() -> None:
            self._timers.pop(token, None)
            if not self._closing:
                callback()

        timer.timeout.connect(fire)
        self._timer_seq += 1
        token = self._timer_seq
        self._timers[token] = timer
        timer.start(max(0, int(delay_ms)))
        return token

    def after_cancel(self, token: Optional[int]) -> None:
        timer = self._timers.pop(token, None)
        if timer is not None:
            timer.stop()
            timer.deleteLater()

    def update_idletasks(self) -> None:  # noqa: N802 - Tk-style call
        app = QApplication.instance()
        if app is not None:
            app.processEvents()

    # --------------------------------------------------------------- clipboard
    def clipboard_clear(self) -> None:
        clipboard = QGuiApplication.clipboard()
        if clipboard is not None:
            clipboard.clear()

    def clipboard_append(self, text: str) -> None:
        clipboard = QGuiApplication.clipboard()
        if clipboard is not None:
            clipboard.setText(str(text))

    # ------------------------------------------------------------- hotkeys/hook
    def bind(self, sequence: str, handler: Callable, add: Optional[str] = None) -> None:
        key = SHORTCUT_KEYS.get(str(sequence))
        if key is None:
            return
        shortcut = QShortcut(QKeySequence(key), self)
        shortcut.activated.connect(lambda: handler(None))
        self._shortcuts.append(shortcut)

    def protocol(self, name: str, handler: Callable) -> None:
        if str(name).upper() == "WM_DELETE_WINDOW":
            self._close_handler = handler

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self._close_handler is not None and not self._closing:
            self._closing = True
            try:
                self._close_handler()
            finally:
                event.accept()
                super().closeEvent(event)
                return
        self._closing = True
        for timer in self._timers.values():
            timer.stop()
        self._timers.clear()
        super().closeEvent(event)

    def destroy(self) -> None:
        self._closing = True
        self.close()
        app = QApplication.instance()
        if app is not None:
            app.quit()
