"""Headless Qt tests for the migrated Exobiology page."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QCheckBox, QPushButton, QTableWidget

    import helper_pages
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


GENERA = ("Bacterium", "Cactoida", "Osseus", "Stratum")
PRESETS = (("icy_land", "Ледяные миры"), ("rocky_atmo_land", "Скалистые с атмосферой"))
BODIES = (
    {"body": "A 3", "class": "Rocky body", "atmosphere": "thin CO2",
     "landable": "Да", "signals": "3", "mapped": "Да",
     "matched": "Скалистые с атмосферой"},
    {"body": "A 4", "class": "Icy body", "atmosphere": "нет",
     "landable": "Нет", "signals": "—", "mapped": "—", "matched": "—"},
)


def _state(**overrides):
    data = dict(
        genus_choices=GENERA,
        selected_genera=("Osseus",),
        show_planets=True,
        planet_choices=PRESETS,
        selected_planets=("icy_land",),
        rows=BODIES,
    )
    data.update(overrides)
    return helper_pages.ExobioPageState(**data)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class ExobioPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.events = []
        self.actions = helper_pages.ExobioPageActions(
            rescan=lambda: self.events.append("rescan"),
            scan_all=lambda: self.events.append("scan_all"),
            filters_changed=lambda: self.events.append("filters"))
        self.page = helper_pages.ExobioPage(_state(), self.actions)

    # ------------------------------------------------------------- structure
    def test_system_panel_has_both_scan_buttons(self):
        self.assertIn("не определена", self.page.system_label.text())
        self.assertIsInstance(self.page.rescan_btn, QPushButton)
        self.assertIsInstance(self.page.scan_all_btn, QPushButton)
        self.page.rescan_btn.click()
        self.page.scan_all_btn.click()
        self.assertEqual(self.events, ["rescan", "scan_all"])

    def test_table_has_documented_columns(self):
        self.assertIsInstance(self.page.table, QTableWidget)
        titles = [self.page.table.horizontalHeaderItem(index).text()
                  for index in range(self.page.table.columnCount())]
        self.assertEqual(titles, ["Тело", "Класс", "Атмосфера", "Посадка",
                                  "Биосигналы", "Карта DSS", "Подходит под фильтр"])

    def test_rows_are_rendered_in_order(self):
        rows = self.page.row_values()
        self.assertEqual([row[0] for row in rows], ["A 3", "A 4"])
        self.assertEqual(rows[0][4], "3")
        self.assertEqual(rows[1][6], "—")

    def test_genera_and_presets_are_checkboxes(self):
        self.assertEqual(set(self.page.genus_widgets), set(GENERA))
        self.assertEqual(set(self.page.planet_widgets), {key for key, _ in PRESETS})
        self.assertIsInstance(self.page.genus_widgets["Osseus"], QCheckBox)
        self.assertIsInstance(self.page.show_planets_check, QCheckBox)

    def test_initial_filter_state(self):
        self.assertEqual(self.page.genera(), ["Osseus"])
        self.assertEqual(self.page.planet_ids(), ["icy_land"])
        self.assertTrue(self.page.show_planets())
        self.assertTrue(self.page.planet_checked("icy_land"))
        self.assertFalse(self.page.planet_checked("rocky_atmo_land"))

    # --------------------------------------------------------------- wiring
    def test_checkboxes_report_changes(self):
        self.page.genus_widgets["Osseus"].setChecked(False)
        self.page.planet_widgets["rocky_atmo_land"].setChecked(True)
        self.page.show_planets_check.setChecked(False)
        self.assertEqual(self.events, ["filters", "filters", "filters"])

    def test_genera_buttons_apply_to_every_row(self):
        self.page.all_genera_btn.click()
        self.assertEqual(len(self.page.genera()), len(GENERA))
        self.page.none_genera_btn.click()
        self.assertEqual(self.page.genera(), [])
        self.assertEqual(self.events, ["filters", "filters"])

    def test_clear_planets_button(self):
        self.page.clear_planets_btn.click()
        self.assertEqual(self.page.planet_ids(), [])
        self.assertEqual(self.events, ["filters"])

    # ----------------------------------------------------------- programmatic
    def test_setters_do_not_echo_back(self):
        self.events.clear()
        self.page.set_genera(["Stratum"])
        self.page.set_planet_ids([])
        self.page.set_show_planets(False)
        self.assertEqual(self.events, [])
        self.assertEqual(self.page.genera(), ["Stratum"])
        self.assertEqual(self.page.planet_ids(), [])
        self.assertFalse(self.page.show_planets())

    def test_status_and_summary_text(self):
        self.page.set_system_text("HIP 12345")
        self.assertIn("HIP 12345", self.page.system_label.text())
        self.page.set_system_text("")
        self.assertIn("не определена", self.page.system_label.text())

        self.page.set_summary_text("Тел отсканировано: 1")
        self.assertEqual(self.page.summary_label.text(), "Тел отсканировано: 1")

        self.page.set_status_text("Сканирование: файл 3 из 9...", "#65c78a")
        self.assertEqual(self.page.status_label.text(), "Сканирование: файл 3 из 9...")
        self.assertIn("#65c78a", self.page.status_label.styleSheet())

    def test_rows_can_be_replaced_and_emptied(self):
        self.page.set_rows([])
        self.assertEqual(self.page.row_values(), [])
        self.page.set_rows([("B 1", "Icy body", "нет", "Да", "1", "—", "—")])
        self.assertEqual(self.page.row_values()[0][0], "B 1")

    def test_empty_state_builds_without_filters(self):
        page = helper_pages.ExobioPage(_state(genus_choices=(), planet_choices=(),
                                              rows=()), None)
        self.assertEqual(page.genus_widgets, {})
        self.assertEqual(page.planet_widgets, {})
        self.assertEqual(page.row_values(), [])


class ExobioPageHostTests(unittest.TestCase):
    """The page must work inside the helper shell, like every other tab."""

    @classmethod
    def setUpClass(cls):
        if QT_ERROR is not None:  # pragma: no cover - depends on the machine
            raise unittest.SkipTest(f"Qt runtime unavailable: {QT_ERROR}")
        cls.app = ensure_app()

    def test_page_can_be_added_to_a_tab(self):
        import helper_shell
        import qt_compat as qt

        root = qt.tk.Tk()
        try:
            shell = helper_shell.build_shell(root, version="test")
            page = helper_pages.ExobioPage(_state(), None)
            tab = qt.tk.Frame(shell.content_area)
            tab._get_tk_layout().addWidget(page)
            page.show()
            shell.add(tab, "Экзобиология")
            shell.select(tab)
            self.assertEqual(shell.pages, [tab])
        finally:
            root.destroy()


if __name__ == "__main__":
    unittest.main()
