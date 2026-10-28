"""Headless Qt tests for the native Helper shell (header, navigation, status).

The shell is built on real widgets; the compatibility pages it hosts are the
same objects the application registers today.
"""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QLabel, QWidget

    import helper_shell
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class HelperShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.changes = []
        self.root = QWidget()
        self.shell = helper_shell.build_shell(
            self.root, on_change=lambda: self.changes.append(1), version="2.18.12")

    def tearDown(self):
        self.root.deleteLater()

    def _page(self, text="page"):
        page = helper_shell.PageHost(self.shell.content_area)
        label = QLabel(str(text), page)
        page._get_tk_layout("pack").addWidget(label)
        return page

    def test_shell_is_native_qt_chrome_not_a_tk_facade(self):
        self.assertIsInstance(self.shell, helper_shell.HelperShell)
        self.assertIsInstance(self.shell, QWidget)
        self.assertIsInstance(self.shell.title_label, QLabel)
        self.assertIsInstance(self.shell.bottom_status, QLabel)
        self.assertIn("v2.18.12", self.shell.version_label.text())

    def test_pages_are_registered_in_a_native_stack_with_navigation_buttons(self):
        first, second = self._page("auth"), self._page("pilot")
        self.shell.add(first, "Подключение")
        self.shell.add(second, "Пилот")

        self.assertEqual(self.shell.pages, [first, second])
        self.assertEqual(self.shell.stack.count(), 2)
        self.assertEqual(len(self.changes), 0)
        self.shell.select(first)
        self.assertIs(self.shell.stack.currentWidget(), first)
        self.assertEqual(self.shell.title(), "Подключение")
        self.assertEqual(len(self.changes), 1)

    def test_select_keeps_the_string_contract_used_across_the_application(self):
        page = self._page()
        self.shell.add(page, "Лог")
        self.assertEqual(self.shell.select(page), str(page))
        self.assertEqual(self.shell.select(), str(page))
        self.assertEqual(self.shell.select(str(page)), str(page))
        self.assertEqual(self.shell.select("unknown"), "")

    def test_switching_pages_updates_checked_button_and_accent_marker(self):
        first, second = self._page(), self._page()
        self.shell.add(first, "Подключение")
        self.shell.add(second, "Пилот")
        self.shell.select(first)
        self.assertTrue(self.shell._buttons[first].isChecked())
        self.assertFalse(self.shell._buttons[second].isChecked())
        self.shell.select(second)
        self.assertFalse(self.shell._buttons[first].isChecked())
        self.assertTrue(self.shell._buttons[second].isChecked())

    def test_navigation_button_click_selects_its_page(self):
        first, second = self._page(), self._page()
        self.shell.add(first, "Подключение")
        self.shell.add(second, "Пилот")
        self.shell.select(first)
        self.shell._buttons[second].click()
        self.assertIs(self.shell.stack.currentWidget(), second)
        self.assertEqual(self.shell.title(), "Пилот")

    def test_status_line_is_written_through_one_entry_point(self):
        self.assertEqual(self.shell.status(), "Готов")
        self.shell.set_status("Watcher: активен")
        self.assertEqual(self.shell.bottom_status.text(), "Watcher: активен")

    def test_build_shell_returns_the_native_shell(self):
        self.assertIsInstance(self.shell, helper_shell.HelperShell)
        self.assertFalse(hasattr(helper_shell, "LegacyShell"))


if __name__ == "__main__":
    unittest.main()
