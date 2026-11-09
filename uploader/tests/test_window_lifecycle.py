"""Окно Helper не должно закрываться «само» и не должно исчезать молча.

Две жалобы, которые держат эти тесты:

* «иногда при первом запуске программа сама закрывается, без ошибки» —
  приложение завершалось, как только закрывалось любое «последнее» окно
  (блок HUD, диалог, служебное окно), а исключение из слота Qt уходило в
  stderr, которого у оконной сборки нет;
* «закрылось, а в диспетчере задач висит» — выход не выполнялся, если
  сохранение настроек при закрытии бросало исключение.

Проверяется поведение, а не реализация: флаг `quitOnLastWindowClosed`,
запись причины закрытия в журнал, гарантированный выход и перехват ошибок
обработчиков.
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication

    import crash_log
    import helper_window
    import ui_qt

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


def read_log(root: Path) -> str:
    try:
        return (crash_log.log_path(root)).read_text(encoding="utf-8")
    except OSError:
        return ""


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class WindowLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ui_qt.ensure_app()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {"COLONIAL_HELPER_HOME": str(self.root)})
        self.env.start()
        self.app.setQuitOnLastWindowClosed(True)
        self.window = helper_window.HelperWindow("тест жизненного цикла")
        self.app.processEvents()

    def tearDown(self):
        try:
            self.window.deleteLater()
            self.app.processEvents()
        except RuntimeError:
            pass
        self.env.stop()
        crash_log.uninstall()
        self.app.setQuitOnLastWindowClosed(True)
        self.temp.cleanup()

    # ---------------------------------------------------------------- выход
    def test_window_close_is_bound_to_the_main_window_not_to_the_last_one(self):
        """Пока Helper работает, выход не зависит от «последнего» окна."""
        seen = {}

        def check_and_quit():
            seen["policy"] = self.app.quitOnLastWindowClosed()
            self.app.exit(0)

        QTimer.singleShot(30, check_and_quit)

        self.window.run()

        self.assertFalse(seen["policy"],
                         "выход должен зависеть от главного окна, а не от любого")
        self.assertTrue(self.app.quitOnLastWindowClosed(),
                        "настройку лаунчера нужно вернуть после Helper")

    def test_closed_by_user_is_not_reported_as_spontaneous(self):
        QTimer.singleShot(20, self.window.close)

        self.window.run()

        text = read_log(self.root)
        self.assertIn("закрытие окна Helper", text)
        self.assertIn("выход Helper", text)
        self.assertIn("окно закрыто пользователем", text)
        self.assertNotIn("без действия пользователя", text)

    def test_exit_without_user_action_is_written_to_the_journal(self):
        # `exit()` завершает цикл событий, не закрывая окон: ровно то, что
        # пилот называет «программа сама закрылась».
        QTimer.singleShot(20, lambda: self.app.exit(0))

        self.window.run()

        text = read_log(self.root)
        self.assertIn("без закрытия окна", text,
                      "«закрылось само» обязано оставлять след с причиной")

    def test_close_handler_failure_still_quits_and_is_logged(self):
        def broken():
            raise RuntimeError("сохранение настроек не удалось")

        self.window._close_handler = broken
        self.window.show()

        self.window.close()
        self.app.processEvents()

        text = read_log(self.root)
        self.assertIn("сохранение настроек не удалось", text)
        self.assertIn("ошибка в обработчике", text)
        self.assertTrue(self.window._closing)

    def test_destroy_is_idempotent(self):
        self.window.destroy()
        self.window.destroy()

        self.assertTrue(self.window._destroyed)
        self.app.processEvents()

    # ------------------------------------------------------------ обработчики
    def test_timer_error_is_written_to_the_journal(self):
        def boom():
            raise ValueError("таймер упал")

        self.window.after(1, boom)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and "таймер упал" not in read_log(self.root):
            self.app.processEvents()
            time.sleep(0.01)

        text = read_log(self.root)
        self.assertIn("таймер упал", text)
        self.assertIn("ValueError", text)

    def test_call_safely_returns_value_and_hides_nothing(self):
        self.assertEqual(helper_window.call_safely(lambda value: value * 2, 21), 42)

        result = helper_window.call_safely(self._fail)

        self.assertIsNone(result)
        self.assertIn("обработчик", read_log(self.root))

    @staticmethod
    def _fail():
        raise KeyError("нет ключа")

    def test_shortcut_handler_error_is_logged(self):
        calls = []

        def handler(event):
            calls.append(event)
            raise OSError("горячая клавиша упала")

        self.window.bind("<F12>", handler)
        shortcut = self.window._shortcuts[-1]

        helper_window.call_safely(handler, None)

        self.assertIsNotNone(shortcut)
        self.assertEqual(calls, [None])
        self.assertIn("горячая клавиша упала", read_log(self.root))


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class QtMessageJournalTests(unittest.TestCase):
    """Предупреждения Qt тоже должны попадать в журнал падений."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {"COLONIAL_HELPER_HOME": str(self.root)})
        self.env.start()

    def tearDown(self):
        crash_log.uninstall()
        self.env.stop()
        self.temp.cleanup()

    def test_qt_warning_reaches_the_journal(self):
        from PySide6.QtCore import qWarning

        self.assertTrue(crash_log.install_qt_messages())
        qWarning("тестовое предупреждение Qt")

        self.assertIn("тестовое предупреждение Qt", read_log(self.root))
        self.assertIn("Qt warning", read_log(self.root))

    def test_journal_records_start_and_clean_exit(self):
        crash_log.install(version="2.27.0")
        crash_log.closing_note(0, reason="окно закрыто пользователем")

        text = read_log(self.root)
        self.assertIn("запуск Helper 2.27.0", text)
        self.assertIn("выход Helper, код 0", text)


if __name__ == "__main__":
    unittest.main()
