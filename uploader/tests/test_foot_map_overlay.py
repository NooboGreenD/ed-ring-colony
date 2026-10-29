"""Блок FOOTMAP: подписи, показ и скрытие разделов, экономия перерисовок."""

import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import i18n  # noqa: E402
from overlay import FootMapOverlay  # noqa: E402


def state(**overrides):
    """Состояние `foot_map.FootMap.state()` в том виде, в каком его зовёт блок."""
    base = {
        "known": True,
        "body": "HIP 1 A 3 a",
        "system": "HIP 1",
        "lat": -12.3456,
        "lon": 45.6789,
        "heading": 40.0,
        "altitude": 12.4,
        "scale": 250,
        "on_foot": True,
        "trail": [(0.0, 0.0), (10.0, 20.0), (40.0, 60.0)],
        "pois": [{"kind": "ship", "name": "", "east": 100.0, "north": 50.0,
                  "distance": 111.8, "bearing": 63.4}],
        "ship": {"kind": "ship", "name": "", "east": 100.0, "north": 50.0,
                 "distance": 111.8, "bearing": 63.4},
        "oxygen": 82.0,
        "health": 100.0,
        "temperature": 240.5,
        "gravity": 0.9,
        "weapon": "Karma P-15",
        "age_seconds": 0.4,
    }
    base.update(overrides)
    return base


class _BlockCase(unittest.TestCase):
    def setUp(self):
        self.saved_locale = i18n.current_locale()
        i18n.set_locale("ru")
        self.overlay = FootMapOverlay(None, {"font_family": "Consolas", "font_size": 10})
        self.addCleanup(self.overlay.destroy)
        self.addCleanup(i18n.set_locale, self.saved_locale)


class FootMapBlockTests(_BlockCase):
    def test_empty_state_says_the_surface_is_unknown(self):
        self.overlay.update_footmap(None)
        self.assertEqual(self.overlay.body_label.text(), "ПОВЕРХНОСТЬ НЕ ИЗВЕСТНА")
        self.assertEqual(self.overlay.coords_label.text(), "")
        self.assertEqual(self.overlay.ship_label.text(), "")
        self.assertEqual(self.overlay.vitals_label.text(), "")

    def test_body_and_coordinates(self):
        self.overlay.update_footmap(state())
        self.assertEqual(self.overlay.body_label.text(), "HIP 1 A 3 A")
        self.assertEqual(self.overlay.coords_label.text(), "12.3456°S  ·  45.6789°E")

    def test_ship_distance_and_vitals(self):
        self.overlay.update_footmap(state())
        self.assertEqual(self.overlay.ship_label.text(), "корабль: 112 м")
        self.assertIn("O₂ 82%", self.overlay.vitals_label.text())
        self.assertIn("HP 100%", self.overlay.vitals_label.text())
        self.assertIn("240 K", self.overlay.vitals_label.text())
        self.assertIn("0.9 g", self.overlay.vitals_label.text())

    def test_distance_units_follow_the_language(self):
        self.overlay.update_footmap(state(
            ship={"kind": "ship", "name": "", "east": 0.0, "north": 628300.0,
                  "distance": 628300.0, "bearing": 0.0}), force=True)
        self.assertEqual(self.overlay.ship_label.text(), "корабль: 628,3 км")
        i18n.set_locale("en")
        self.overlay.update_footmap(state(
            ship={"kind": "ship", "name": "", "east": 0.0, "north": 628300.0,
                  "distance": 628300.0, "bearing": 0.0}), force=True)
        self.assertEqual(self.overlay.ship_label.text(), "ship: 628.3 km")

    def test_missing_ship_and_vitals_leave_the_lines_empty(self):
        self.overlay.update_footmap(state(ship=None, oxygen=None, health=None,
                                          temperature=None, gravity=None))
        self.assertEqual(self.overlay.ship_label.text(), "")
        self.assertEqual(self.overlay.vitals_label.text(), "")

    def test_vitals_are_coloured_by_the_worst_level(self):
        from hud_window import COLOR_RED_TEXT, COLOR_TEXT_MUTED, COLOR_YELLOW

        colour = FootMapOverlay._vitals_color
        self.assertEqual(colour({"oxygen": 18.0, "health": 100.0}), COLOR_RED_TEXT)
        self.assertEqual(colour({"oxygen": 40.0, "health": 100.0}), COLOR_YELLOW)
        self.assertEqual(colour({"oxygen": 82.0}), COLOR_TEXT_MUTED)
        self.assertEqual(colour({}), COLOR_TEXT_MUTED)

    def test_identical_state_is_not_redrawn(self):
        self.overlay.update_footmap(state())
        painted = self.overlay._paints
        self.overlay.update_footmap(state())
        self.assertEqual(self.overlay._paints, painted)
        self.overlay.update_footmap(state(heading=41.0))
        self.assertEqual(self.overlay._paints, painted)
        self.overlay.update_footmap(state(altitude=99.0), force=True)
        self.assertEqual(self.overlay._paints, painted + 1)

    def test_resize_redraws_the_rings(self):
        self.overlay.update_footmap(state())
        painted = self.overlay._paints
        self.overlay.resize(380, 460)
        self.assertGreaterEqual(self.overlay._paints, painted)

    def test_sections_hide_the_widgets(self):
        self.overlay.settings["overlay_footmap_map"] = False
        self.overlay.settings["overlay_footmap_vitals"] = False
        self.overlay.apply_data_options()
        self.assertTrue(self.overlay.canvas.isHidden())
        self.assertTrue(self.overlay.vitals_label.isHidden())
        self.overlay.settings["overlay_footmap_map"] = True
        self.overlay.settings["overlay_footmap_vitals"] = True
        self.overlay.apply_data_options()
        self.assertFalse(self.overlay.canvas.isHidden())
        self.assertFalse(self.overlay.vitals_label.isHidden())

    def test_canvas_draws_without_data(self):
        """Пустая карта всё равно рисуется: подсказка вместо колец."""
        self.overlay.resize(340, 400)
        self.overlay.update_footmap(None, force=True)
        self.assertFalse(self.overlay.canvas.grab().isNull())

    def test_canvas_draws_points_trail_and_north(self):
        self.overlay.resize(340, 400)
        self.overlay.update_footmap(state(pois=[
            {"kind": "ship", "name": "", "east": 20.0, "north": 30.0,
             "distance": 36.0, "bearing": 33.7},
            {"kind": "settlement", "name": "Hutton Settlement", "east": -60.0,
             "north": 40.0, "distance": 72.1, "bearing": 303.7},
            {"kind": "station", "name": "Bessel Landing", "east": 10.0,
             "north": -80.0, "distance": 80.6, "bearing": 172.9},
        ]), force=True)
        image = self.overlay.canvas.grab()
        self.assertFalse(image.isNull())
        self.assertGreater(image.width(), 100)


if __name__ == "__main__":
    unittest.main()
