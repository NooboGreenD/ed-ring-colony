"""Native Qt main window for Colonial Helper.

The window is a :class:`ui_qt.FramelessWindow` with the product's custom frame.
Application code talks to it through a small, explicit API — timers, clipboard,
window-level hotkeys and the close hook — instead of the previous Tk facade.
"""
from __future__ import annotations

import time
import traceback
from typing import Callable, Dict, Optional

import threading

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QGuiApplication, QIcon, QKeySequence, QShortcut
from PySide6.QtWidgets import QApplication

from ui_qt import FramelessWindow, ensure_app


def journal(message: str) -> None:
    """Строка в журнал падений; журнал — единственный след оконной сборки."""
    try:
        import crash_log

        crash_log.note(None, message)
    except Exception:
        pass


def call_safely(callback: Callable, *args, **kwargs):
    """Вызвать обработчик и записать исключение, а не потерять его.

    PySide6 не передаёт исключение из слота в `sys.excepthook`: он печатает
    трассировку в stderr, а у оконной сборки stderr нет. Так «нажал кнопку —
    ничего не произошло» и «окно закрылось само» оставались без объяснения.
    Теперь такая ошибка попадает в `logs/helper.log` с полной трассировкой.
    """
    try:
        return callback(*args, **kwargs)
    except Exception as exc:
        name = getattr(callback, "__name__", "") or type(callback).__name__
        journal(f"ошибка в обработчике {name}: {type(exc).__name__}: {exc}\n"
                f"{traceback.format_exc()}")
        return None

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

    #: Отложенный вызов, пришедший из фонового потока. Сигнал доставляется в
    #: поток окна (queued connection), поэтому таймер создаётся там, где живёт
    #: цикл событий. Раньше `after()` из потока делал `QTimer(self)` прямо в
    #: рабочем потоке: Qt отказывался («Cannot create children for a parent
    #: that is in a different thread»), колбэк не выполнялся никогда — так
    #: «зависали» проверка токена и проверка ключа Raven Colonial.
    _scheduled = Signal(object)

    def __init__(self, title: str = "Colonial Helper") -> None:
        ensure_app()
        super().__init__(title)
        self._timers: Dict[int, Optional[QTimer]] = {}
        self._timer_seq = 0
        self._scheduled.connect(self._start_scheduled,
                                Qt.ConnectionType.QueuedConnection)
        self._shortcuts = []
        self._close_handler: Optional[Callable] = None
        self._closing = False
        self._destroyed = False
        self._close_seen = False          # приходило ли событие закрытия окна
        self._quit_by_us = False          # выход попросили мы сами
        self._quit_noted = False
        self._started_at = time.monotonic()
        self.setMinimumSize(980, 630)

    # ------------------------------------------------------------------ window
    def run(self) -> int:
        """Show the window and enter the Qt event loop.

        Выход из программы привязан к **главному** окну, а не к «последнему
        открытому»: у Helper есть окна блоков HUD, диалоги и всплывающие окна,
        и `quitOnLastWindowClosed` завершал процесс, как только закрывалось
        любое из них, если главное окно в этот момент было свёрнуто или ещё не
        показано. Пилот видел «программа сама закрылась», без ошибки.
        """
        app = ensure_app()
        # Прежнее значение возвращаем в `finally`: Helper и стартовый экран
        # живут в одном процессе лаунчера, и лаунчеру «выход по последнему
        # окну» по-прежнему нужен.
        previous_policy = app.quitOnLastWindowClosed()
        app.setQuitOnLastWindowClosed(False)
        app.aboutToQuit.connect(self._note_quit)
        self._started_at = time.monotonic()
        self.show()
        journal("окно Helper показано")
        try:
            code = int(app.exec())
        except BaseException as exc:               # падение уже в цикле событий
            journal(f"цикл событий прерван: {type(exc).__name__}: {exc}\n"
                    f"{traceback.format_exc()}")
            raise
        finally:
            app.setQuitOnLastWindowClosed(previous_policy)
        elapsed = time.monotonic() - getattr(self, "_started_at", time.monotonic())
        if not self._close_seen:
            # Это и есть «закрылось само»: цикла событий больше нет, а окно
            # никто не закрывал. Причину ищем в журнале рядом — записи Qt,
            # faulthandler и ошибки обработчиков попадают туда же.
            journal(f"окно Helper закрылось без события закрытия "
                    f"через {elapsed:.1f} с, код {code}")
        self._note_quit()
        return code

    def _note_quit(self) -> None:
        """Одна строка на выход: видно, что штатный выход состоялся и почему."""
        if getattr(self, "_quit_noted", False):
            return
        self._quit_noted = True
        if not getattr(self, "_close_seen", False):
            reason = "цикл событий завершился без закрытия окна"
        elif getattr(self, "_quit_by_us", False):
            reason = "программный выход"
        else:
            reason = "окно закрыто пользователем"
        try:
            import crash_log

            crash_log.closing_note(0, reason=reason)
        except Exception:
            pass

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
        """Run ``callback`` once after ``delay_ms``; returns a cancellation id.

        Вызывать можно из любого потока: сеть в Helper живёт в фоновых
        потоках, а из них результат возвращается именно так (`root.after(0,
        …)`). Из рабочего потока запрос уезжает сигналом в поток окна, где и
        создаётся `QTimer`; иначе таймер не запускался вовсе.
        """
        self._timer_seq += 1
        token = self._timer_seq
        delay = max(0, int(delay_ms))
        if threading.current_thread() is threading.main_thread():
            self._start_timer(token, delay, callback)
        else:
            # Пока таймера нет, `after_cancel` должен находить токен — иначе
            # отменённый вызов всё равно выполнится.
            self._timers[token] = None
            self._scheduled.emit((token, delay, callback))
        return token

    def _start_scheduled(self, payload) -> None:
        """Сигнал из фонового потока уже в потоке окна — заводим таймер."""
        token, delay, callback = payload
        if token not in self._timers:
            return                      # вызов отменили до доставки
        self._start_timer(token, delay, callback)

    def _start_timer(self, token: int, delay: int, callback: Callable) -> None:
        timer = QTimer(self)
        timer.setSingleShot(True)

        def fire() -> None:
            self._timers.pop(token, None)
            if not self._closing:
                call_safely(callback)

        timer.timeout.connect(fire)
        self._timers[token] = timer
        timer.start(delay)

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
        shortcut.activated.connect(lambda: call_safely(handler, None))
        self._shortcuts.append(shortcut)

    def protocol(self, name: str, handler: Callable) -> None:
        if str(name).upper() == "WM_DELETE_WINDOW":
            self._close_handler = handler

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt API
        self._close_seen = True
        # Кто попросил закрыть окно: без стека «закрылось само» неотличимо от
        # нашего же `_on_close` через таймер или из другого потока.
        journal("закрытие окна Helper\n" + "".join(traceback.format_stack()[-6:]))
        if self._close_handler is not None and not self._closing:
            self._closing = True
            try:
                call_safely(self._close_handler)
            finally:
                event.accept()
                super().closeEvent(event)
                self._quit_soon()
                return
        self._closing = True
        for timer in self._timers.values():
            if timer is not None:
                timer.stop()
        self._timers.clear()
        super().closeEvent(event)
        self._quit_soon()

    def _quit_soon(self) -> None:
        """Гарантировать выход, даже если обработчик закрытия упал."""
        app = QApplication.instance()
        if app is not None:
            QTimer.singleShot(0, app.quit)

    def destroy(self) -> None:
        if getattr(self, "_destroyed", False):
            return
        self._quit_by_us = True
        self._destroyed = True
        self._closing = True
        self.close()
        app = QApplication.instance()
        if app is not None:
            app.quit()
