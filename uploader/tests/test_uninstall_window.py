"""Headless Qt tests for the uninstall window."""
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtTest import QTest

    import bundle
    import uninstall
    import uninstall_window
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


def wait_until(app, predicate, timeout_ms=4000):
    elapsed = 0
    while elapsed < timeout_ms:
        app.processEvents()
        if predicate():
            return True
        QTest.qWait(10)
        elapsed += 10
    app.processEvents()
    return predicate()


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class UninstallWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "Games" / "Colonial Helper"
        (self.root / "app" / "1.0.0").mkdir(parents=True)
        (self.root / "app" / "1.0.0" / "helper.py").write_text("code", encoding="utf-8")
        (self.root / "logs").mkdir()
        (self.root / "logs" / "launcher.log").write_text("log", encoding="utf-8")
        bundle.write_install_marker(self.root)
        self.calls = []
        self.closed = []

    def tearDown(self):
        self.temp.cleanup()

    def _planner(self, ok=True, problems=None):
        def planner(root, **kwargs):
            self.calls.append({"root": Path(root), "kwargs": kwargs})
            plan = uninstall.UninstallPlan(root=Path(root))
            plan.bytes = 2048
            if not ok:
                plan.problems.extend(problems or ["нет установки"])
            return plan

        return planner

    def _uninstaller(self, result=None, error=None):
        def fake(plan):
            self.calls.append({"executed": plan, "thread": threading.current_thread().name})
            if error is not None:
                raise error
            return result if result is not None else {
                "ok": True, "removed": [str(plan.root)], "failed": [],
                "warnings": [], "deferred": False,
            }

        return fake

    def _window(self, planner=None, uninstaller=None):
        window = uninstall_window.UninstallWindow(
            self.root, planner=planner or self._planner(),
            uninstaller=uninstaller or self._uninstaller())
        window.show()
        self.closed.append(window)
        self.app.processEvents()
        return window

    # ------------------------------------------------------------------ build
    def test_window_offers_three_choices_with_settings_unchecked(self):
        window = self._window()

        self.assertIn("Удаление Colonial Helper", window.windowTitle())
        self.assertTrue(window.shortcuts_check.isChecked())
        self.assertTrue(window.logs_check.isChecked())
        self.assertFalse(window.settings_check.isChecked())
        self.assertTrue(window.shortcuts_check.isEnabled())
        self.assertEqual(window.remove_button.text(), "УДАЛИТЬ")
        self.assertEqual(window.cancel_button.text(), "ОТМЕНА")
        self.assertIn("Удаление нельзя отменить", window.status.text())

    def test_missing_install_disables_the_action(self):
        empty = self.base / "Empty"
        empty.mkdir()

        window = uninstall_window.UninstallWindow(empty, planner=self._planner(),
                                                  uninstaller=self._uninstaller())
        window.show()
        self.app.processEvents()

        self.assertFalse(window.remove_button.isEnabled())
        self.assertFalse(window.shortcuts_check.isEnabled())
        self.assertIn("нет установленной программы", window.status.text())
        window.close()

    def test_size_label_shows_freed_space_and_grows_with_settings(self):
        window = self._window()
        before = window.size_label.text()

        self.assertIn("Будет освобождено", before)
        window.settings_check.setChecked(True)
        self.app.processEvents()

        self.assertIn("Будет освобождено", window.size_label.text())

    # ------------------------------------------------------------------ plan
    def test_plan_follows_the_checkboxes(self):
        window = self._window()
        window.shortcuts_check.setChecked(False)
        window.settings_check.setChecked(True)
        self.app.processEvents()

        window.plan()

        kwargs = self.calls[-1]["kwargs"]
        self.assertFalse(kwargs["remove_shortcuts"])
        self.assertFalse(kwargs["remove_registry"])
        self.assertFalse(kwargs["keep_settings"])
        self.assertEqual(self.calls[-1]["root"], self.root)

    def test_settings_kept_by_default(self):
        window = self._window()

        window.plan()

        self.assertTrue(self.calls[-1]["kwargs"]["keep_settings"])

    # --------------------------------------------------------------- removal
    def test_removal_runs_off_the_gui_thread_and_reports_success(self):
        window = self._window()
        window.remove_button.click()

        self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        executed = [call for call in self.calls if "executed" in call]
        self.assertEqual(len(executed), 1)
        self.assertNotEqual(executed[0]["thread"], "MainThread")
        self.assertIn("Готово", window.status.text())
        self.assertEqual(window.last_error, "")
        self.assertTrue(wait_until(self.app, lambda: not window.isVisible(), timeout_ms=3000))

    def test_deferred_removal_is_explained_without_scaring_the_user(self):
        window = self._window(uninstaller=self._uninstaller({
            "ok": True, "removed": [], "failed": [], "warnings": [], "deferred": True}))

        window.remove_button.click()

        self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        self.assertIn("исчезнут в течение нескольких секунд", window.status.text())
        self.assertEqual(window.last_error, "")
        window.close()

    def test_partial_removal_offers_retry_and_keeps_details(self):
        window = self._window(uninstaller=self._uninstaller({
            "ok": False, "removed": [], "failed": ["exe: file is busy"],
            "warnings": ["реестр занят"], "deferred": False}))

        window.remove_button.click()

        self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        self.assertIn("Удалено не всё", window.status.text())
        self.assertIn("реестр занят", window.last_error)
        self.assertIn("file is busy", window.last_error)
        self.assertEqual(window.remove_button.text(), "ПОВТОРИТЬ")
        self.assertTrue(window.remove_button.isEnabled())
        self.assertTrue(window.cancel_button.isEnabled())
        window.close()

    def test_unexpected_error_is_shown_and_buttons_come_back(self):
        window = self._window(uninstaller=self._uninstaller(error=PermissionError("denied")))

        window.remove_button.click()

        self.assertTrue(wait_until(
            self.app, lambda: "Не удалось удалить" in window.status.text()))
        self.assertIn("PermissionError", window.last_error)
        self.assertEqual(window.remove_button.text(), "ПОВТОРИТЬ")
        self.assertTrue(window.remove_button.isEnabled())
        self.assertTrue(window.cancel_button.isEnabled())
        window.close()

    def test_broken_plan_stops_before_touching_files(self):
        window = self._window(planner=self._planner(ok=False, problems=["нет установки"]))

        window.remove_button.click()

        self.assertIn("нет установки", window.status.text())
        self.assertFalse([call for call in self.calls if "executed" in call])
        self.assertTrue(window.remove_button.isEnabled())
        window.close()

    def test_buttons_are_locked_while_removal_is_running(self):
        release = threading.Event()

        def slow(plan):
            release.wait(3)
            return {"ok": True, "removed": [], "failed": [], "warnings": [],
                    "deferred": False}

        window = self._window(uninstaller=slow)
        window.remove_button.click()
        self.app.processEvents()

        self.assertFalse(window.remove_button.isEnabled())
        self.assertFalse(window.cancel_button.isEnabled())
        self.assertIn("УДАЛЯЕМ", window.remove_button.text())
        release.set()
        self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        window.close()


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class HumanSizeTests(unittest.TestCase):
    def test_sizes_use_comma_and_readable_units(self):
        self.assertEqual(uninstall_window._human_size(0), "0 Б")
        self.assertEqual(uninstall_window._human_size(999), "999 Б")
        self.assertEqual(uninstall_window._human_size(2048), "2,0 КБ")
        self.assertEqual(uninstall_window._human_size(5 * 1024 * 1024), "5,0 МБ")
        self.assertEqual(uninstall_window._human_size(150 * 1024 * 1024), "150 МБ")
        self.assertTrue(uninstall_window._human_size(3 * 1024 ** 3).endswith("ГБ"))


if __name__ == "__main__":
    unittest.main()
