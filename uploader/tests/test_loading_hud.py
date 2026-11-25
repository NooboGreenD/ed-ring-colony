"""Pure manifest maths and optional offscreen tests for the square/table HUD."""

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from loading_patterns import loading_tables, loading_segments
from test_loading_patterns import payload


class LoadingTableTests(unittest.TestCase):
    def test_filter_keeps_unknown_rows_and_does_not_change_header_totals(self):
        data = payload()
        remaining = loading_tables(data)
        all_goods = loading_tables(data, True)
        self.assertEqual([len(c["rows"]) for c in remaining], [1, 1])
        self.assertEqual([len(c["rows"]) for c in all_goods], [2, 1])
        for filtered, full in zip(remaining, all_goods):
            self.assertEqual(
                {k: v for k, v in filtered.items() if k != "rows"},
                {k: v for k, v in full.items() if k != "rows"},
            )
        self.assertEqual(remaining[0]["loaded"], 5)
        self.assertEqual(remaining[0]["remaining"], 2)
        self.assertIsNone(remaining[1]["loaded"])
        self.assertIsNone(remaining[1]["rows"][0]["remaining"])

    def test_partial_observations_are_lower_bounds_not_zero_stock(self):
        data = payload()
        carrier = data["progress"]["carriers"][0]
        carrier["known"] = False
        carrier["items"][1]["loaded"] = None
        row = loading_tables(data)[0]
        self.assertEqual(row["loaded"], 5)
        self.assertEqual(row["unknown"], 2)
        self.assertIsNone(row["remaining"])
        self.assertIsNone(row["rows"][0]["loaded"])
        self.assertIsNone(row["rows"][0]["remaining"])

    def test_focus_and_completed_carriers_stay_present(self):
        data = payload()
        data["carrier_id"] = "456"
        self.assertEqual([c["carrierId"] for c in loading_tables(data)], ["456"])
        data["carrier_id"] = "123"
        data["progress"]["carriers"][0]["items"][1]["loaded"] = 2
        card = loading_tables(data)[0]
        self.assertEqual(card["rows"], [])
        self.assertEqual(card["loaded"], 7)
        self.assertEqual(card["remaining"], 0)

    def test_squares_floor_progress_and_never_falsely_show_complete(self):
        for loaded, target, filled in [
            (0, 100, 0),
            (1, 100, 0),
            (50, 100, 10),
            (99, 100, 19),
            (100, 100, 20),
            (999, 100, 20),
            (-1, 100, 0),
            (0, 0, 0),
        ]:
            self.assertEqual(loading_segments(loaded, target), filled)
        self.assertIsNone(loading_segments(None, 100))

    def test_zero_targets_empty_state_and_surplus(self):
        self.assertEqual(loading_tables({}), [])
        data = payload()
        data["progress"]["carriers"][0]["items"][0]["loaded"] = 999
        self.assertEqual(loading_tables(data, True)[0]["rows"][0]["loaded"], 5)
        data["progress"]["carriers"][0]["items"] = []
        row = loading_tables(data)[0]
        self.assertEqual((row["loaded"], row["target"], row["remaining"]), (0, 0, 0))


try:
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QTableWidget
    from overlay import LoadingOverlay, DEFAULT_SETTINGS
    from overlay_options import CONTENT_OPTIONS
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:
    QT_ERROR = str(exc)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class LoadingHudQtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.settings = dict(DEFAULT_SETTINGS)
        self.overlay = LoadingOverlay(None, self.settings)
        self.addCleanup(self.overlay.destroy)
        self.overlay.update_loading(payload())

    def test_table_columns_and_squares_beneath_each_carrier(self):
        cards = self.overlay.manifest.cards
        self.assertEqual(set(cards), {"123", "456"})
        a, b = cards["123"], cards["456"]
        self.assertIsInstance(a.table, QTableWidget)
        self.assertEqual(a.name_label.text(), "Alpha")
        self.assertLess(a.layout().indexOf(a.name_label), a.layout().indexOf(a.squares))
        self.assertLess(a.layout().indexOf(a.squares), a.layout().indexOf(a.table))
        self.assertEqual(a.squares.filled, 14)
        self.assertEqual(a.table.rowCount(), 1)
        self.assertEqual(a.table.item(0, 1).text(), "0")
        self.assertEqual(a.table.item(0, 2).text(), "2")
        self.assertIsNone(b.squares.filled)
        self.assertEqual(b.table.item(0, 1).text(), "?")
        self.assertEqual(b.table.item(0, 2).text(), "?")
        self.assertEqual(a.table.editTriggers(), QTableWidget.NoEditTriggers)

    def test_live_filter_and_settings_toggle_use_same_persisted_key(self):
        controller = Mock()
        self.overlay.set_controller(controller)
        self.overlay.filter_combo.setCurrentIndex(1)
        self.assertTrue(self.settings["overlay_loading_completed"])
        self.assertEqual(self.overlay.manifest.cards["123"].table.rowCount(), 2)
        controller.save_settings.assert_called_once()
        controller._notify_block.assert_called_once_with(
            "loading",
            "content",
            {"setting": "overlay_loading_completed", "value": True},
        )
        self.settings["overlay_loading_completed"] = False
        self.overlay.apply_data_options()
        self.assertEqual(self.overlay.filter_combo.currentIndex(), 0)
        self.assertEqual(self.overlay.manifest.cards["123"].table.rowCount(), 1)

    def test_sections_font_updates_and_no_rebuild_on_identical_data(self):
        a = self.overlay.manifest.cards["123"]
        table = a.table
        for option, widgets in [
            ("carriers", [a.name_label, a.totals_label]),
            ("progress", [a.squares]),
            ("items", [a.table]),
        ]:
            self.assertIn(option, CONTENT_OPTIONS["loading"])
            self.settings["overlay_loading_" + option] = False
            self.overlay.apply_data_options()
            for widget in widgets:
                self.assertTrue(widget.isHidden())
            self.settings["overlay_loading_" + option] = True
            self.overlay.apply_data_options()
            for widget in widgets:
                self.assertFalse(widget.isHidden())
        self.overlay.apply_font("Arial", 16)
        self.assertEqual(a.table.font().family(), "Arial")
        self.assertEqual(a.name_label.font().family(), "Arial")
        self.assertEqual(a.table.font().pixelSize(), 19)
        self.overlay.update_loading(payload())
        self.assertIs(self.overlay.manifest.cards["123"].table, table)
        self.overlay.update_loading({"note": "Offline"})
        self.assertEqual(self.overlay.manifest.cards, {})
        self.assertEqual(self.overlay.summary_label.text(), "Offline")

    def test_many_carriers_are_scrollable_not_truncated_and_focus_clears_old_cards(
        self,
    ):
        from copy import deepcopy

        data = payload()
        data["progress"]["carriers"] = [
            dict(
                deepcopy(data["progress"]["carriers"][0]),
                carrierId=str(n),
                name="Carrier " + str(n),
            )
            for n in range(20)
        ]
        self.overlay.update_loading(data)
        self.assertEqual(len(self.overlay.manifest.cards), 20)
        data["carrier_id"] = "17"
        self.overlay.update_loading(data)
        self.assertEqual(list(self.overlay.manifest.cards), ["17"])


if __name__ == "__main__":
    unittest.main()
