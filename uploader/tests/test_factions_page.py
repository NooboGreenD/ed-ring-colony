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
        # Состояния — теми же словами, что в игре: «Boom» не читается по-русски.
        self.assertIn("Бум", details)
        self.assertIn("Активно: Бум, Экспансия", details)

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

    # ------------------------------------------------- репутация и состояния
    def test_reputation_is_named_like_in_the_game(self):
        row = dict(FACTIONS[0], reputation=0.55)
        self.widget.set_snapshot("Sol", "", [row])
        texts = [label.text() for label
                 in self.widget._card_widgets()[0].findChildren(QLabel)]
        self.assertIn("Репутация у фракций", texts)
        self.assertIn("Приветливая", texts)
        self.assertIsNotNone(getattr(self.widget._card_widgets()[0], "_reputation_bar", None))

    def test_missing_reputation_leaves_no_empty_bar(self):
        self.widget.set_snapshot("Sol", "", [FACTIONS[0]])
        self.assertIsNone(getattr(self.widget._card_widgets()[0], "_reputation_bar", None))

    def test_reputation_steps_and_garbage(self):
        self.assertEqual(qt_factions.reputation_label(0.95), "Союзная")
        self.assertEqual(qt_factions.reputation_label(0.0), "Нейтральная")
        self.assertEqual(qt_factions.reputation_label(-0.9), "Враждебная")
        self.assertEqual(qt_factions.reputation_label(None), "")
        self.assertEqual(qt_factions.reputation_label("много"), "")

    def test_state_names_are_translated(self):
        self.assertEqual(qt_factions.state_title("Boom"), "Бум")
        self.assertEqual(qt_factions.state_title("CivilUnrest"), "Гражданские беспорядки")
        self.assertEqual(qt_factions.state_title("SomeNewState"), "SomeNewState")

    def test_state_chips_list_pending_and_recovering_states(self):
        row = dict(FACTIONS[0], pending_states=["Election"], recovering_states=["Lockdown"])
        self.widget.set_snapshot("Sol", "", [row])
        texts = [label.text() for label
                 in self.widget._card_widgets()[0].findChildren(QLabel)]
        self.assertIn("Бум", texts)
        self.assertIn("→ Выборы", texts)
        self.assertIn("↻ Изоляция", texts)

    def test_state_description_explains_what_is_happening(self):
        row = dict(FACTIONS[0], state="Famine")
        self.widget.set_snapshot("Sol", "", [row])
        texts = [label.text() for label
                 in self.widget._card_widgets()[0].findChildren(QLabel)]
        self.assertTrue(any("Голод" in text and "продовольствие" in text for text in texts))

    # ------------------------------------------------------- тенденции влияния
    def test_second_observation_draws_the_trend_chart(self):
        self.widget.set_snapshot("Sol", "", [FACTIONS[0]], observed_at="2026-11-01T10:00:00Z")
        self.assertIsNone(getattr(self.widget._card_widgets()[0], "_trend_chart", None))
        moved = [dict(FACTIONS[0], influence=0.62)]
        self.widget.set_snapshot("Sol", "", moved, observed_at="2026-11-02T10:00:00Z")
        chart = getattr(self.widget._card_widgets()[0], "_trend_chart", None)
        self.assertIsNotNone(chart)
        self.assertEqual(len(chart.values), 2)
        self.assertAlmostEqual(chart.values[-1], 0.62, places=3)

    def test_same_observation_is_not_recorded_twice(self):
        for _ in range(3):
            self.widget.set_snapshot("Sol", "", [FACTIONS[0]],
                                     observed_at="2026-11-01T10:00:00Z")
        self.assertEqual(len(self.widget.history_for(FACTIONS[0]["name"])), 1)

    def test_history_is_reset_when_the_system_changes(self):
        self.widget.set_snapshot("Sol", "", [FACTIONS[0]], observed_at="2026-11-01T10:00:00Z")
        self.widget.set_snapshot("Kuma", "", [FACTIONS[0]], observed_at="2026-11-02T10:00:00Z")
        self.assertEqual(len(self.widget.history_for(FACTIONS[0]["name"])), 1)

    def test_trend_text_talks_in_arrows_and_percent(self):
        self.assertEqual(qt_factions._trend_text([0.4]), "одно наблюдение")
        self.assertEqual(qt_factions._trend_text([0.4, 0.4]), "без изменений")
        self.assertIn("▲", qt_factions._trend_text([0.40, 0.45]))
        self.assertIn("▼", qt_factions._trend_text([0.45, 0.40]))

    # ----------------------------------------------- экономика и безопасность
    def test_system_info_strip_shows_economy_security_and_population(self):
        self.widget.set_snapshot("Sol", "", FACTIONS,
                                 system_info={"economy": "HighTech", "security": "High",
                                              "population": 22700000000})
        self.assertTrue(self.widget.system_card.isVisibleTo(self.widget))
        text = self.widget.system_info_label.text()
        self.assertIn("HighTech", text)
        self.assertIn("High", text)
        self.assertIn("22,7 млрд", text)
        self.assertIn("Высокие технологии", self.widget.system_hint_label.text())

    def test_system_info_without_data_hides_the_strip(self):
        self.widget.set_snapshot("Sol", "", FACTIONS)
        self.assertFalse(self.widget.system_card.isVisibleTo(self.widget))
        self.assertEqual(self.widget.system_info_label.text(), "")

    def test_population_is_shortened_for_reading(self):
        self.assertEqual(qt_factions._population_text(22700000000), "22,7 млрд")
        self.assertEqual(qt_factions._population_text(1500000), "1,5 млн")
        self.assertEqual(qt_factions._population_text(0), "0")
        self.assertEqual(qt_factions._population_text("много"), "много")

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

    # ------------------------------------------------------------- data source
    def test_empty_state_no_longer_promises_only_the_journal(self):
        text = self.widget.empty.text()
        self.assertIn("базе проекта", text, "подсказка знает про базу проекта")
        self.assertIn("Watcher", text)

    def test_site_source_line_shows_the_observation_time(self):
        self.widget.set_snapshot("Sol", "", FACTIONS, source="site",
                                 observed_at="2026-10-31T20:00:00+00:00")
        text = self.widget.source_label.text()
        self.assertIn("сайт проекта", text)
        self.assertIn("2026", text)

    def test_journal_source_lines_differ(self):
        self.widget.set_snapshot("Sol", "", FACTIONS, source="journal",
                                 observed_at="2026-10-31T22:14:03Z")
        self.assertIn("журнал игры", self.widget.source_label.text())
        self.widget.set_snapshot("Sol", "", FACTIONS, source="journal-archive",
                                 observed_at="2026-10-31T22:14:03Z")
        self.assertIn("архив", self.widget.source_label.text())

    def test_unknown_source_and_missing_time(self):
        self.widget.set_snapshot("Sol", "", FACTIONS, source="", observed_at="")
        self.assertEqual(self.widget.source_label.text(), "")
        self.widget.set_snapshot("Sol", "", FACTIONS, source="site", observed_at="вчера")
        self.assertIn("время неизвестно", self.widget.source_label.text())

    def test_note_explains_an_empty_list(self):
        self.widget.set_snapshot("Sol", "", [], source="", observed_at="",
                                 note="Фракции системы Sol не найдены")
        self.assertEqual(self.widget.status_label.text(), "Фракции системы Sol не найдены")

    def test_live_journal_snapshot_clears_the_previous_note(self):
        self.widget.set_snapshot("Sol", "", [], note="нет данных")
        self.widget.set_snapshot("Sol", "", FACTIONS, source="journal")
        self.assertEqual(self.widget.status_label.text(), "")

    def test_player_faction_is_marked_in_its_card(self):
        row = dict(FACTIONS[1], is_player=True)
        self.widget.set_snapshot("Sol", "", [row])
        texts = [label.text() for label in self.widget._card_widgets()[0].findChildren(QLabel)]
        self.assertTrue(any("фракция игроков" in text for text in texts))

    # ----------------------------------------------------------------- refresh
    def test_refresh_button_asks_the_helper_for_new_data(self):
        calls = []
        widget = qt_factions.FactionInfographic(locale="ru", on_refresh=lambda: calls.append(1))
        self.assertIsNotNone(widget.refresh_btn)
        widget.refresh_btn.click()
        self.assertEqual(calls, [1])

    def test_no_refresh_button_without_a_callback(self):
        self.assertIsNone(self.widget.refresh_btn)
        self.widget.refresh()          # без обработчика ничего не падает

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
