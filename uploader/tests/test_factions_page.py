"""Headless Qt tests for the native faction infographic."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QFrame, QLabel, QProgressBar

    import qt_factions
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


FACTIONS = [
    {"name": "Sol Workers' Party", "influence": 0.58, "allegiance": "Federation",
     "government": "Democracy", "state": "Boom", "active_states": ["Boom", "Expansion"]},
    {"name": "Mother Gaia", "influence": 0.22, "allegiance": "Federation",
     "government": "Democracy", "state": "None"},
    {"name": "Sol Nationalists", "influence": 0.12, "allegiance": "Federation",
     "government": "Dictatorship", "state": "Lockdown", "active_states": ["Lockdown"]},
]


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class FactionInfographicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.widget = qt_factions.FactionInfographic(
            locale="ru", site_url="https://edringcolony.ru")

    # ------------------------------------------------------------- structure
    def test_widget_keeps_the_name_the_app_expects(self):
        self.assertEqual(self.widget.objectName(), "FactionInfographic")
        self.assertTrue(self.widget.layout().count() > 0)

    def test_empty_state_asks_for_journal_data(self):
        self.assertEqual(self.widget.cards_count(), 0)
        self.assertIsNotNone(self.widget.empty)
        self.assertIn("Watcher", self.widget.empty.text())
        self.assertIn("Ожидание данных", self.widget.system_label.text())

    # -------------------------------------------------------------- snapshots
    def test_snapshot_builds_one_card_per_faction(self):
        self.widget.set_snapshot("Sol", "Sol Workers' Party", FACTIONS)
        self.assertEqual(self.widget.cards_count(), 3)
        self.assertEqual(self.widget.names(), [f["name"] for f in FACTIONS])
        self.assertIsNone(self.widget.empty)

    def test_system_and_controlling_faction_are_shown(self):
        self.widget.set_snapshot("Sol", "Sol Workers' Party", FACTIONS)
        self.assertIn("Sol", self.widget.system_label.text())
        self.assertIn("Sol Workers' Party", self.widget.control_label.text())

    def test_controlling_faction_is_marked_in_its_card(self):
        self.widget.set_snapshot("Sol", "Sol Workers' Party", FACTIONS)
        first, second = self.widget._card_widgets()[:2]
        first_texts = [label.text() for label in first.findChildren(QLabel)]
        second_texts = [label.text() for label in second.findChildren(QLabel)]
        self.assertTrue(any("КОНТРОЛИРУЕТ СИСТЕМУ" in text for text in first_texts))
        self.assertFalse(any("КОНТРОЛИРУЕТ" in text for text in second_texts))

    def test_details_line_has_influence_and_active_states(self):
        self.widget.set_snapshot("Sol", "", FACTIONS)
        texts = [label.text() for label
                 in self.widget._card_widgets()[0].findChildren(QLabel)]
        details = next(text for text in texts if "Влияние" in text)
        self.assertIn("58.0%", details)
        self.assertIn("Federation", details)
        self.assertIn("Активно: Boom, Expansion", details)

    def test_new_snapshot_replaces_the_previous_cards(self):
        self.widget.set_snapshot("Sol", "", FACTIONS)
        self.widget.set_snapshot("Kuma", "", FACTIONS[:1])
        self.assertEqual(self.widget.cards_count(), 1)
        self.assertEqual(self.widget.names(), ["Sol Workers' Party"])

    def test_empty_snapshot_after_data_brings_the_hint_back(self):
        self.widget.set_snapshot("Sol", "", FACTIONS)
        self.widget.set_snapshot("", "", [])
        self.assertEqual(self.widget.cards_count(), 0)
        self.assertIsNotNone(self.widget.empty)

    # ---------------------------------------------------------------- details
    def test_influence_bar_matches_the_number(self):
        self.widget.set_snapshot("Sol", "", FACTIONS)
        bars = self.widget._card_widgets()[0].findChildren(QProgressBar)
        self.assertEqual(len(bars), 1)
        self.assertAlmostEqual(bars[0].value() / 1000.0, 0.58, places=3)

    def test_influence_is_clamped_and_survives_garbage(self):
        self.widget.set_snapshot("Sol", "", [
            {"name": "Too high", "influence": 4.2},
            {"name": "Too low", "influence": -1},
            {"name": "Bad", "influence": "много"},
        ])
        bars = [card.findChildren(QProgressBar)[0]
                for card in self.widget._card_widgets()]
        self.assertEqual([bar.value() for bar in bars], [1000, 0, 0])

    def test_junk_rows_are_ignored(self):
        self.widget.set_snapshot("Sol", "", ["строка", None, 42, FACTIONS[0]])
        self.assertEqual(self.widget.cards_count(), 1)
        self.assertEqual(self.widget.names(), ["Sol Workers' Party"])

    def test_missing_name_gets_a_placeholder(self):
        self.widget.set_snapshot("Sol", "", [{"influence": 0.5}])
        self.assertEqual(self.widget.names(), ["—"])

    def test_cards_are_frames_not_tk_widgets(self):
        self.widget.set_snapshot("Sol", "", FACTIONS)
        self.assertTrue(all(isinstance(card, QFrame)
                            for card in self.widget._card_widgets()))

    # -------------------------------------------------------------- atlas link
    def test_atlas_link_carries_the_locale(self):
        widget = qt_factions.FactionInfographic(
            locale="ja", site_url="https://edringcolony.ru/")
        self.assertEqual(widget.atlas_url,
                         "https://edringcolony.ru/atlas?tab=factions&locale=ja")

    def test_open_atlas_uses_the_browser(self):
        with mock.patch("webbrowser.open") as browser:
            self.widget._open_atlas()
        browser.assert_called_once_with("https://edringcolony.ru/atlas?tab=factions&locale=ru",
                                        new=2)

    # ---------------------------------------------------------------- drawing
    def test_page_renders_with_cards(self):
        self.widget.set_snapshot("Sol", "Sol Workers' Party", FACTIONS)
        self.widget.resize(1000, 700)
        self.widget.show()
        self.app.processEvents()
        image = self.widget.grab().toImage()
        self.assertFalse(image.isNull())
        self.assertEqual((image.width(), image.height()), (1000, 700))
        self.widget.hide()


if __name__ == "__main__":
    unittest.main()
