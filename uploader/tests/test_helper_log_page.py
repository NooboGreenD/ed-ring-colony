"""Headless Qt tests for the migrated Log page used by Colonial Helper."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtGui import QTextCursor
    from PySide6.QtWidgets import QPlainTextEdit, QPushButton

    import helper_pages
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class LogPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.page = helper_pages.LogPage()
        self.page.show()
        self.app.processEvents()

    def tearDown(self):
        self.page.deleteLater()

    def test_page_is_built_from_native_widgets(self):
        self.assertIsInstance(self.page.view, QPlainTextEdit)
        self.assertIsInstance(self.page.clear_button, QPushButton)
        self.assertTrue(self.page.is_read_only())

    def test_entries_keep_their_level_colour(self):
        self.page.append("[12:00:00] Сбой загрузки", "error")
        self.page.append("[12:00:01] Готово", "success")
        document = self.page.view.document()
        self.assertIn("Сбой загрузки", document.toPlainText())
        self.assertIn("Готово", document.toPlainText())
        cursor = QTextCursor(document)
        cursor.movePosition(QTextCursor.MoveOperation.Start)
        cursor.movePosition(QTextCursor.MoveOperation.End,
                            QTextCursor.MoveMode.KeepAnchor)
        colors = {cursor.charFormat().foreground().color().name()}
        html = document.toHtml()
        self.assertIn("#e27676", html.lower())
        self.assertIn("#65c78a", html.lower())
        self.assertTrue(colors)

    def test_entries_are_appended_as_separate_lines_and_counted(self):
        for index in range(3):
            self.page.append(f"строка {index}", "info")
        lines = self.page.text().splitlines()
        self.assertEqual(lines, ["строка 0", "строка 1", "строка 2"])
        self.assertEqual(self.page.entry_count(), 3)
        self.assertIn("3", self.page.counter.text())

    def test_clear_button_empties_the_view(self):
        self.page.append("что-то", "warn")
        self.page.clear_button.click()
        self.app.processEvents()
        self.assertEqual(self.page.text(), "")
        self.assertEqual(self.page.counter.text(), "")

    def test_multiline_block_is_appended_as_one_entry(self):
        self.page.append_block("[12:00:00]\nимпорт: 12 файлов", "info")
        self.assertIn("импорт: 12 файлов", self.page.text())
        self.assertEqual(self.page.entry_count(), 2)


if __name__ == "__main__":
    unittest.main()
