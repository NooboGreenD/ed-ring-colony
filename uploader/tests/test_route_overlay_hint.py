"""ROUTE показывает стройку и первооткрывателя следующей системы.

Проверяется то, что видит командир: значок состояния стройки, процент, кто
открыл систему — и что «системы нет в базе» не превращается в пустую строку.
"""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QApplication

    import hud_icons
    import i18n
    import route_hint
    from overlay_blocks import RouteOverlay
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)

SUMMARY = {"jumps_left": 154, "star_class": "Y", "scoopable": False,
           "jump_distance": 32.8, "remaining_distance": 4995.8,
           "destination": "Eta Carina Sector GG-Y d1"}


def payload(**overrides):
    data = {
        "ok": True,
        "system": "Next One",
        "construction": {"known": True, "status": "building", "progress": 42,
                         "sitesActive": 1, "sitesComplete": 0, "remaining": 18240},
        "discovery": {"known": True, "discoverer": "CMDR Orin Vex",
                      "bodies": 12, "mapped": 4, "footfall": 1},
    }
    data.update(overrides)
    return data


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class RouteHintTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.overlay = RouteOverlay(None, {"font_family": "Consolas", "font_size": 10,
                                           "route_width": 300, "route_height": 250})
        self.addCleanup(self.overlay.destroy)

    def show(self, hint):
        self.overlay.update_route("Here", "Next One", 1, 155, None, None,
                                  SUMMARY, hint)
        QApplication.processEvents()

    def test_building_shows_percent_and_discoverer(self):
        self.show(route_hint.normalize_hint(payload()))
        self.assertIn("42%", self.overlay.hint_build_label.text())
        self.assertIn("CMDR Orin Vex", self.overlay.hint_author_label.text())
        self.assertEqual(self.overlay.hint_build_icon.icon_name(), "building")
        self.assertEqual(self.overlay.hint_author_icon.icon_name(), "compass")
        self.assertFalse(self.overlay.hint_build_bar.isHidden(), "шкала стройки видна")

    def test_completed_build_uses_the_check_icon(self):
        self.show(route_hint.normalize_hint({
            "ok": True, "system": "Next One",
            "construction": {"known": True, "status": "done", "progress": 100},
            "discovery": {"known": True, "discoverer": "", "bodies": 3}}))
        self.assertIn("завершена", self.overlay.hint_build_label.text())
        self.assertEqual(self.overlay.hint_build_icon.icon_name(), "done")
        self.assertIn("Первооткрыватель неизвестен", self.overlay.hint_author_label.text())
        self.assertEqual(self.overlay.hint_author_icon.icon_name(), "star",
                         "система в базе есть, но автор неизвестен — это другая иконка")

    def test_unexplored_system_says_so(self):
        self.show(route_hint.normalize_hint({
            "ok": True, "system": "Next One",
            "construction": {"known": False, "status": "unknown"},
            "discovery": {"known": False, "bodies": 0}}))
        self.assertIn("не исследована", self.overlay.hint_author_label.text())
        self.assertEqual(self.overlay.hint_author_icon.icon_name(), "search")
        self.assertIn("нет данных", self.overlay.hint_build_label.text())
        self.assertTrue(self.overlay.hint_build_bar.isHidden())

    def test_site_error_is_shown_not_swallowed(self):
        self.show(route_hint.normalize_hint({"ok": False, "error": "HTTP 503"}, "Next One"))
        self.assertIn("недоступен", self.overlay.hint_build_label.text())

    def test_hint_of_another_system_is_not_shown(self):
        """Маршрут сменился — чужой ответ на экране не остаётся."""
        stale = route_hint.normalize_hint(payload())
        self.overlay.update_route("Here", "Another System", 1, 155, None, None,
                                  SUMMARY, stale)
        QApplication.processEvents()
        self.assertNotIn("CMDR Orin Vex", self.overlay.hint_author_label.text())
        self.assertIn("спрашиваем", self.overlay.hint_author_label.text())
        self.assertEqual(self.overlay.get_hint()["system"], "Another System")

    def test_no_route_is_not_a_hint(self):
        self.overlay.update_route("Here", "—", 0, 0, None, None, {}, None)
        QApplication.processEvents()
        self.assertFalse(self.overlay.get_hint()["known"])

    def test_hint_section_can_be_hidden(self):
        self.overlay.settings["overlay_route_hint"] = False
        self.overlay.apply_data_options()
        self.assertTrue(self.overlay.hint_frame.isHidden())
        self.overlay.settings["overlay_route_hint"] = True
        self.overlay.apply_data_options()
        self.assertFalse(self.overlay.hint_frame.isHidden())

    def test_icons_are_drawn_from_the_site_geometry(self):
        """Иконки берутся из той же сетки 24×24, что у сайта."""
        for name in ("building", "done", "idle", "compass", "search", "star"):
            path = hud_icons.icon_path(name)
            self.assertFalse(path.isEmpty(), name)
        self.assertEqual(set(hud_icons.ICONS) - {"building", "done", "idle", "compass",
                                                 "search", "star"}, set())
        icon = hud_icons.HudIcon(None, name="compass", size=16)
        self.addCleanup(icon.close)
        icon.set_icon("star")
        self.assertEqual(icon.icon_name(), "star")

    def test_labels_are_translated(self):
        import re

        cyrillic = re.compile("[А-Яа-яЁё]")
        for code, marker in (("en", "Discovered by"), ("de", "Entdeckt von"),
                             ("ko", "발견"), ("zh", "发现者")):
            i18n.set_locale(code)
            overlay = RouteOverlay(None, {"font_family": "Consolas", "font_size": 10})
            try:
                overlay.update_route("Here", "Next One", 1, 155, None, None,
                                     SUMMARY, route_hint.normalize_hint(payload()))
                joined = " ".join(widget.text() for widget in
                                  (overlay.hint_build_label, overlay.hint_author_label))
                self.assertIn(marker, joined, f"{code}: нет перевода")
                self.assertIsNone(cyrillic.search(joined), f"{code}: остался русский текст")
            finally:
                overlay.destroy()
        i18n.set_locale("ru")


if __name__ == "__main__":
    unittest.main()
