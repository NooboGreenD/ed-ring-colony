"""Headless Qt tests for the migrated Route page."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QLabel, QPushButton, QTableWidget

    import helper_pages
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


ROWS = [
    (1, "Sol", "✓ Посещена", "05.01.3301 12:00", "visited"),
    (2, "Alpha Centauri", "● Текущая", "", "current"),
    (3, "Wolf 359", "○ Ожидает", "", "pending"),
]


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class RoutePageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.events = []
        actions = helper_pages.RoutePageActions(
            import_route=lambda: self.events.append("import"),
            export_csv=lambda: self.events.append("export"),
            import_atlas=lambda: self.events.append("atlas"),
            clear=lambda: self.events.append("clear"),
        )
        self.page = helper_pages.RoutePage(actions)

    def tearDown(self):
        import i18n

        i18n.set_locale("ru")

    def test_page_follows_the_language_chosen_in_the_launcher(self):
        """Страница маршрута не должна остаться русской в другом языке."""
        import re

        import i18n

        for code in ("en", "zh"):
            i18n.set_locale(code)
            page = helper_pages.RoutePage()
            try:
                headers = [page.table.horizontalHeaderItem(i).text()
                           for i in range(page.table.columnCount())]
                texts = [item.text() for item in page.findChildren(QLabel)]
                texts += [item.text() for item in page.findChildren(QPushButton)]
                texts += headers
                russian = [text for text in texts
                           if text and re.search("[А-Яа-яЁё]", text)]
                self.assertEqual(russian, [], f"{code}: остались русские подписи")
                # Номер строки и имя поля API переводятся не должны.
                self.assertEqual(headers[0], "#")
            finally:
                page.deleteLater()

    # ------------------------------------------------------------- structure
    def test_keeps_the_attribute_names_the_app_uses(self):
        for name in ("table", "counter", "import_btn", "export_btn", "atlas_btn",
                     "clear_btn"):
            self.assertTrue(hasattr(self.page, name), name)

    def test_table_is_a_read_only_native_widget(self):
        self.assertIsInstance(self.page.table, QTableWidget)
        self.assertEqual(self.page.table.columnCount(), 4)
        headers = [self.page.table.horizontalHeaderItem(i).text()
                   for i in range(self.page.table.columnCount())]
        self.assertEqual(headers, ["#", "Система", "Статус", "Посещена"])
        self.assertFalse(self.page.table.editTriggers())

    def test_starts_empty_with_the_original_hint(self):
        self.assertEqual(self.page.row_count(), 0)
        self.assertEqual(self.page.counter_text(), "Маршрут не загружен")

    # ---------------------------------------------------------------- buttons
    def test_buttons_fire_their_callbacks(self):
        for button in (self.page.import_btn, self.page.export_btn,
                       self.page.atlas_btn, self.page.clear_btn):
            self.assertIsInstance(button, QPushButton)
            button.click()
        self.assertEqual(self.events, ["import", "export", "atlas", "clear"])

    def test_missing_callbacks_do_not_crash(self):
        page = helper_pages.RoutePage(helper_pages.RoutePageActions())
        for button in (page.import_btn, page.export_btn, page.atlas_btn,
                       page.clear_btn):
            button.click()

    # ------------------------------------------------------------------ rows
    def test_rows_replace_the_previous_contents(self):
        self.page.set_rows(ROWS)
        self.assertEqual(self.page.row_count(), 3)
        self.assertEqual(self.page.row_values(0), ("1", "Sol", "✓ Посещена",
                                                   "05.01.3301 12:00"))
        self.page.set_rows(ROWS[:1])
        self.assertEqual(self.page.row_count(), 1)
        self.page.set_rows([])
        self.assertEqual(self.page.row_count(), 0)

    def test_rows_are_coloured_by_status(self):
        self.page.set_rows(ROWS)
        expected = {"visited": helper_pages.GREEN,
                    "current": helper_pages.ORANGE,
                    "pending": helper_pages.MUTED}
        for row, values in enumerate(ROWS):
            item = self.page.table.item(row, 0)
            colour = item.foreground().color().name()
            self.assertEqual(colour, expected[values[4]].lower(), values[4])

    def test_rows_without_status_keep_the_default_colour(self):
        self.page.set_rows([(1, "Sol", "Посещена", "")])
        self.assertEqual(self.page.row_values(0), ("1", "Sol", "Посещена", ""))
        brush = self.page.table.item(0, 0).foreground()
        self.assertEqual(brush.style(), Qt.BrushStyle.NoBrush)

    def test_rows_accept_any_sequence_and_convert_to_text(self):
        self.page.set_rows([(7, "LHS 3447", "Ожидает", None, "pending")])
        self.assertEqual(self.page.row_values(0), ("7", "LHS 3447", "Ожидает", "None"))

    def test_set_rows_tolerates_none(self):
        self.page.set_rows(ROWS)
        self.page.set_rows(None)
        self.assertEqual(self.page.row_count(), 0)

    def test_counter_text(self):
        self.page.set_counter("Всего: 3 | Посещено: 1 | Осталось: 2")
        self.assertEqual(self.page.counter_text(),
                         "Всего: 3 | Посещено: 1 | Осталось: 2")

    # ---------------------------------------------------------------- drawing
    def test_page_renders_with_rows(self):
        self.page.set_rows(ROWS)
        self.page.set_counter("Всего: 3 | Посещено: 1 | Осталось: 2")
        self.page.resize(900, 520)
        self.page.show()
        self.app.processEvents()
        image = self.page.grab().toImage()
        self.assertFalse(image.isNull())
        self.assertEqual((image.width(), image.height()), (900, 520))
        self.page.hide()

    def test_table_uses_the_available_width(self):
        self.page.resize(1100, 600)
        self.page.show()
        self.app.processEvents()
        self.assertGreater(self.page.table.width(), 800)
        self.page.hide()


if __name__ == "__main__":
    unittest.main()
