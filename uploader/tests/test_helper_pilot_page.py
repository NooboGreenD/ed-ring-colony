"""Headless Qt tests for the migrated Pilot infographic page."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QCheckBox, QLabel, QPushButton

    import helper_pages
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class PilotLayoutHelpersTests(unittest.TestCase):
    def test_columns_follow_window_width(self):
        self.assertEqual(helper_pages.pilot_columns(1400, False), 3)
        self.assertEqual(helper_pages.pilot_columns(900, False), 2)
        self.assertEqual(helper_pages.pilot_columns(700, False), 1)

    def test_compact_mode_is_denser(self):
        self.assertEqual(helper_pages.pilot_columns(1400, True), 4)
        self.assertEqual(helper_pages.pilot_columns(900, True), 3)
        self.assertEqual(helper_pages.pilot_columns(700, True), 2)
        self.assertEqual(helper_pages.pilot_columns(500, True), 1)

    def test_sparkline_needs_two_points(self):
        self.assertEqual(helper_pages.sparkline_points([1.0], 240, 60), [])
        self.assertEqual(helper_pages.sparkline_points([0, 5], 240, 60).__len__(), 2)
        self.assertEqual(helper_pages.sparkline_points([0, 5], 5, 5), [])

    def test_sparkline_stays_inside_the_canvas(self):
        points = helper_pages.sparkline_points([0, 10, 5, 20], 240, 60)
        self.assertTrue(all(0 <= x <= 240 for x, _y in points))
        self.assertTrue(all(0 <= y <= 60 for _x, y in points))

    def test_flat_series_does_not_divide_by_zero(self):
        points = helper_pages.sparkline_points([7, 7, 7], 200, 50)
        self.assertEqual(len(points), 3)
        self.assertTrue(all(0 <= y <= 50 for _x, y in points))

    def test_bars_are_scaled_to_the_largest_value(self):
        rows = helper_pages.bars_geometry([("Sol", 120.0), ("Alpha", 60.0)], 240, 110)
        self.assertEqual(len(rows), 2)
        self.assertGreater(rows[0]["rect"][2], rows[1]["rect"][2])
        self.assertEqual(rows[0]["name"], "Sol")

    def test_bars_handle_empty_input(self):
        self.assertEqual(helper_pages.bars_geometry([], 240, 110), [])
        self.assertEqual(helper_pages.bars_geometry([("Sol", 1.0)], 5, 5), [])

    def test_long_system_names_are_truncated(self):
        rows = helper_pages.bars_geometry([("X" * 60, 10.0)], 240, 110)
        self.assertEqual(len(rows[0]["name"]), 22)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class PilotPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.refreshed = []
        self.compact_changes = []
        self.page = helper_pages.PilotPage(
            compact=False,
            columns_provider=lambda: 2,
            on_compact_changed=self.compact_changes.append,
            on_refresh=lambda: self.refreshed.append(1),
        )
        self.page.show()
        self.app.processEvents()

    def tearDown(self):
        import i18n

        i18n.set_locale("ru")
        self.page.deleteLater()

    def test_page_follows_the_language_chosen_in_the_launcher(self):
        """Инфографика пилота не должна остаться русской в другом языке."""
        import re

        import i18n

        for code in ("en", "de", "ja"):
            i18n.set_locale(code)
            page = helper_pages.PilotPage(columns_provider=lambda: 2)
            try:
                page.set_value("ship", i18n.tr("Корабль не определён"))
                texts = [item.text() for item in page.findChildren(QLabel)]
                texts += [item.text() for item in page.findChildren(QPushButton)]
                texts += [item.text() for item in page.findChildren(QCheckBox)]
                russian = [text for text in texts
                           if text and re.search("[А-Яа-яЁё]", text)]
                self.assertEqual(russian, [], f"{code}: остались русские подписи")
            finally:
                page.deleteLater()

    # ------------------------------------------------------------- structure
    def test_page_is_native_qt_with_kpi_tiles_bars_and_charts(self):
        for key in helper_pages.PILOT_KPI_KEYS:
            self.assertIn(key, self.page.values)
            self.assertIn(f"{key}_sub", self.page.subs)
        for key in ("ship", "route_status", "commander", "balance", "game", "exobio"):
            self.assertIn(key, self.page.values)
        for key in ("hull_bar", "shield_bar", "fuel_bar", "power_bar", "route_progress"):
            self.assertIn(key, self.page.bars)
        self.assertIsInstance(self.page.spark, helper_pages.SparklineWidget)
        self.assertIsInstance(self.page.systems_chart, helper_pages.BarsChart)

    def test_tiles_follow_the_column_count(self):
        self.assertEqual(self.page.column_count(), 2)
        self.assertEqual(self.page.tile_layout.rowCount(), 3)  # шесть плиток в две колонки

    def test_resize_rebuilds_tiles_and_notifies_the_application(self):
        seen = []
        self.page._on_columns_changed = lambda: seen.append(self.page.column_count())
        self.page._columns_provider = lambda: 3
        self.page.resize(1400, 700)
        self.app.processEvents()
        self.assertEqual(self.page.column_count(), 3)
        self.assertEqual(seen, [3])

    # ------------------------------------------------------------------ data
    def test_values_and_subs_are_written_into_labels(self):
        self.page.set_value("kpi_tons", "43 t")
        self.page.set_value("kpi_tons_sub", "на маршрут 20 t")
        self.page.set_value("ship", "Python")
        self.assertEqual(self.page.values["kpi_tons"].text(), "43 t")
        self.assertEqual(self.page.subs["kpi_tons_sub"].text(), "на маршрут 20 t")
        self.assertEqual(self.page.values["ship"].text(), "Python")

    def test_bars_clamp_out_of_range_values(self):
        self.page.set_bar("hull_bar", 150)
        self.page.set_bar("shield_bar", -4)
        self.assertEqual(self.page.bars["hull_bar"].value(), 100)
        self.assertEqual(self.page.bars["shield_bar"].value(), 0)

    def test_charts_accept_series_and_rows(self):
        self.page.set_spark([0, 5, 10])
        self.page.set_systems([("Sol", 120.0), ("Alpha", 60.0)])
        self.assertEqual(self.page.spark.values, [0.0, 5.0, 10.0])
        self.assertEqual(self.page.systems_chart.rows, [("Sol", 120.0), ("Alpha", 60.0)])

    def test_long_values_are_elided_but_keep_the_full_text(self):
        long_value = "Sol A 3: 4 сигналов · Bacterium, Fonticulua, Stratum"
        self.page.resize(880, 600)
        self.app.processEvents()
        self.page.set_value("exobio", long_value)
        widget = self.page.values["exobio"]
        self.assertEqual(widget.text(), long_value)
        self.assertEqual(widget.toolTip(), long_value)

    def test_elided_label_shortens_painted_text_only(self):
        widget = helper_pages.ElidedLabel("короткое")
        widget.resize(40, 20)
        widget.set_full_text("очень длинное значение, которое не влезает")
        self.assertEqual(widget.full_text(), "очень длинное значение, которое не влезает")
        self.assertEqual(widget.text(), widget.full_text())

    def test_updated_time_is_shown(self):
        self.page.set_updated("12:34:56")
        self.assertEqual(self.page.updated_label.text(), "12:34:56")

    # --------------------------------------------------------------- actions
    def test_refresh_button_asks_the_application_to_refresh(self):
        self.page.refresh_button.click()
        self.app.processEvents()
        self.assertEqual(self.refreshed, [1])

    def test_compact_checkbox_reports_the_new_state(self):
        self.page.compact_check.setChecked(True)
        self.app.processEvents()
        self.assertEqual(self.compact_changes, [True])

    # ---------------------------------------------------------------- drawing
    def _render(self, widget):
        widget.resize(240, 80)
        self.app.processEvents()
        return widget.grab().toImage()

    def test_sparkline_renders_a_visible_line(self):
        self.page.spark.set_values([0, 5, 10, 7])
        image = self._render(self.page.spark)
        colors = {image.pixelColor(x, y).name() for x in range(0, 240, 3)
                  for y in range(0, 80, 3)}
        self.assertGreater(len(colors), 1, "график должен что-то нарисовать")

    def test_sparkline_without_data_shows_a_hint(self):
        self.page.spark.set_values([1])
        image = self._render(self.page.spark)
        colors = {image.pixelColor(x, y).name() for x in range(0, 240, 3)
                  for y in range(0, 80, 3)}
        self.assertGreater(len(colors), 1, "подсказка тоже рисуется")

    def test_bars_chart_renders_rows_and_empty_state(self):
        self.page.systems_chart.set_rows([("Sol", 120.0), ("Alpha", 60.0)])
        painted = self._render(self.page.systems_chart)
        self.page.systems_chart.set_rows([])
        empty = self._render(self.page.systems_chart)
        self.assertNotEqual(painted.constBits(), empty.constBits())


if __name__ == "__main__":
    unittest.main()
