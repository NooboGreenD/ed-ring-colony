"""Headless Qt tests for the rewritten Setup window."""
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import Qt
    from PySide6.QtTest import QTest

    import installer_window
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
class SetupWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "payload" / "ColonialHelper.exe"
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b"payload")
        self.install_root = self.root / "installed"
        self.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def _installer(self, result=None, error=None):
        def fake(source, **kwargs):
            self.calls.append({"source": Path(source), "kwargs": kwargs,
                               "thread": threading.current_thread().name})
            if error is not None:
                raise error
            return result if result is not None else {
                "executable": self.install_root / "ColonialHelper.exe",
                "shortcuts": [], "warnings": [], "process": None,
                "install_root": self.install_root,
            }

        return fake

    def _window(self, installer=None):
        window = installer_window.SetupWindow(
            self.source, install_root=self.install_root,
            installer=installer or self._installer())
        window.show()
        self.app.processEvents()
        return window

    # ------------------------------------------------------------------ frame
    def test_window_is_visible_with_custom_frameless_title_bar(self):
        window = self._window()
        self.assertTrue(window.isVisible())
        self.assertTrue(window.windowFlags() & Qt.WindowType.FramelessWindowHint)
        self.assertIn("Установка Colonial Helper", window.windowTitle())
        window.close()

    def test_first_install_offers_a_single_start_button(self):
        window = self._window()
        self.assertIsNone(window.repair_button)
        self.assertEqual(window.install_button.text(), "УСТАНОВИТЬ И ЗАПУСТИТЬ")
        self.assertFalse(window.desktop_check.isChecked())
        self.assertIn(str(self.install_root), window.path_label.text())
        window.close()

    def test_existing_install_offers_repair_and_reinstall(self):
        self.install_root.mkdir(parents=True)
        (self.install_root / "ColonialHelper.exe").write_bytes(b"old")
        window = self._window()
        self.assertTrue(window.existing_install)
        self.assertEqual(window.repair_button.text(), "ВОССТАНОВИТЬ")
        self.assertEqual(window.install_button.text(), "ПЕРЕУСТАНОВИТЬ")
        window.close()

    # ---------------------------------------------------------------- install
    def test_install_runs_off_the_gui_thread_and_reports_success(self):
        window = self._window()
        window.desktop_check.setChecked(True)
        window.install_button.click()
        self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        self.assertEqual(len(self.calls), 1)
        call = self.calls[0]
        self.assertEqual(call["source"], self.source)
        self.assertTrue(call["kwargs"]["desktop_shortcut"])
        self.assertTrue(call["kwargs"]["launch"])
        self.assertNotEqual(call["thread"], "MainThread")
        self.assertIn("Готово", window.status.text())
        self.assertTrue(wait_until(self.app, lambda: not window.isVisible(), timeout_ms=3000))

    def test_repair_and_reinstall_pass_their_mode_to_the_installer(self):
        self.install_root.mkdir(parents=True)
        (self.install_root / "ColonialHelper.exe").write_bytes(b"old")
        window = self._window()
        window.repair_button.click()
        self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        self.assertTrue(self.calls[0]["kwargs"]["repair"])
        self.assertFalse(self.calls[0]["kwargs"]["reinstall"])
        window.close()

    def test_permission_error_explains_that_helper_must_be_closed(self):
        window = self._window(installer=self._installer(error=PermissionError("denied")))
        window.install_button.click()
        self.assertTrue(wait_until(
            self.app, lambda: "Не удалось установить" in window.status.text()))
        self.assertIn("Закройте Colonial Helper", window.status.text())
        self.assertTrue(window.install_button.isEnabled())
        self.assertEqual(window.install_button.text(), "ПОВТОРИТЬ УСТАНОВКУ")
        self.assertIn("PermissionError", window.last_error)
        window.close()

    def test_shortcut_warning_keeps_the_window_open_longer_but_reports_success(self):
        result = {"executable": self.install_root / "ColonialHelper.exe",
                  "shortcuts": [], "warnings": ["политика запрещает ярлыки"],
                  "process": None, "install_root": self.install_root}
        window = self._window(installer=self._installer(result=result))
        window.install_button.click()
        self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        self.assertIn("ярлык не создан", window.status.text())
        self.assertIn("политика запрещает ярлыки", window.status.text())
        self.app.processEvents()
        self.assertTrue(window.isVisible())
        window.close()

    def test_real_install_launcher_copies_the_payload_end_to_end(self):
        from unittest import mock

        import installer

        window = installer_window.SetupWindow(self.source, install_root=self.install_root)
        window.show()
        self.app.processEvents()
        with mock.patch.object(installer, "create_shortcut") as shortcut, \
             mock.patch.object(installer, "_launch") as launch:
            window.install_button.click()
            self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        installed = self.install_root / installer.EXECUTABLE
        self.assertEqual(installed.read_bytes(), self.source.read_bytes())
        self.assertTrue(shortcut.called)
        launch.assert_called_once()
        window.close()

    def test_main_opens_the_native_setup_window(self):
        from unittest import mock

        import installer
        import ui_qt

        window = mock.Mock()
        app = mock.Mock()
        app.exec.return_value = 0
        with mock.patch.object(installer, "payload_executable", return_value=self.source), \
             mock.patch.object(installer_window, "SetupWindow", return_value=window) as factory, \
             mock.patch.object(ui_qt, "ensure_app", return_value=app):
            self.assertEqual(installer.main([]), 0)
        factory.assert_called_once_with(self.source)
        window.show.assert_called_once_with()
        app.exec.assert_called_once_with()

    def test_buttons_are_disabled_while_the_copy_is_running(self):
        release = threading.Event()

        def slow(source, **kwargs):
            release.wait(3)
            return {"executable": self.source, "shortcuts": [], "warnings": [],
                    "process": None, "install_root": self.install_root}

        window = self._window(installer=slow)
        window.install_button.click()
        self.app.processEvents()
        self.assertFalse(window.install_button.isEnabled())
        self.assertIn("УСТАНОВКА", window.install_button.text())
        release.set()
        self.assertTrue(wait_until(self.app, lambda: window.result is not None))
        window.close()


if __name__ == "__main__":
    unittest.main()
