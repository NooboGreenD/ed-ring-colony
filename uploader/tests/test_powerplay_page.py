"""Headless Qt tests for the PowerPlay tab: commander and current system.

Окно ничего не считает само: ``powerplay_data`` уже разложил журнал, а здесь
проверяется только то, что видит командир — подписи, цвета, шкала контроля и
честное «данных нет» вместо нулей. Тесты Qt на машине без плагинов
пропускаются (см. ``QT_ERROR``).
"""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QLabel

    import powerplay_data
    import qt_powerplay
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


def commander_state(**overrides):
    """То, что отдаёт ``PowerplayTracker.state()`` после события ``Powerplay``."""
    state = {
        "known": True,
        "power": {"name": "Jerome Archer", "label": "Jerome Archer",
                  "allegiance": "Federation", "color": "#e94ae6"},
        "rank": 12,
        "merits": 4320,
        "votes": 5,
        "time_pledged": 864000,
        "pledged_at": "2026-11-01T10:00:00Z",
        "observed_at": "2026-11-01T10:00:00Z",
        "salary": {"amount": 1000000, "at": "2026-11-01T11:20:00Z"},
        "actions": [
            {"kind": "PowerplaySalary", "at": "2026-11-01T11:20:00Z", "amount": 1000000},
            {"kind": "PowerplayVote", "at": "2026-11-01T11:10:00Z", "votes": 5},
            {"kind": "PowerplayDeliver", "at": "2026-11-01T11:00:00Z", "count": 15,
             "item": "Power Converters"},
        ],
        "system": None,
        "note": "",
    }
    state.update(overrides)
    return state


def system_state(**overrides):
    system = {
        "system": "Sol",
        "id64": 10477373803,
        "power": "Jerome Archer",
        "power_info": {"name": "Jerome Archer", "label": "Jerome Archer",
                       "allegiance": "Federation", "color": "#e94ae6"},
        "state": "Stronghold",
        "state_info": {"name": "Stronghold", "title": "Оплот", "range_ly": 30},
        "powers": ["Jerome Archer", "Aisling Duval"],
        "powers_info": [
            {"name": "Jerome Archer", "label": "Jerome Archer", "color": "#e94ae6"},
            {"name": "Aisling Duval", "label": "Aisling Duval", "color": "#19b5e6"},
        ],
        "control_progress": 0.62,
        "reinforcement": 1240,
        "undermining": 380,
        "observed_at": "2026-11-01T10:05:00Z",
        "source": "journal",
    }
    system.update(overrides)
    return system


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class PowerplayPanelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.refreshed = []
        self.widget = qt_powerplay.PowerplayPanel(
            locale="ru", site_url="https://edringcolony.ru",
            on_refresh=lambda: self.refreshed.append(True))

    def visible(self, widget) -> bool:
        """Будет ли виджет виден, когда окно покажут.

        У ребёнка ещё не показанного окна ``isHidden()`` отвечает не так, как
        ждёшь, поэтому спрашиваем ``isVisibleTo``: он говорит именно «показался
        бы» — скрытую карточку это и ловит.
        """
        return widget.isVisibleTo(self.widget)

    # ------------------------------------------------------------- structure
    def test_widget_keeps_the_name_the_app_expects(self):
        self.assertEqual(self.widget.objectName(), "PowerplayPanel")

    def test_atlas_link_follows_the_interface_language(self):
        self.assertTrue(self.widget.atlas_url.startswith("https://edringcolony.ru"))
        self.assertIn("/atlas", self.widget.atlas_url)
        self.assertIn("powerplay", self.widget.atlas_url)

    def test_refresh_button_asks_the_helper(self):
        self.widget.refresh()
        self.assertEqual(self.refreshed, [True])

    def test_atlas_button_opens_the_browser(self):
        with mock.patch("webbrowser.open") as opened:
            self.widget._open_atlas()
        self.assertEqual(opened.call_args[0][0], self.widget.atlas_url)

    # ---------------------------------------------------------- empty state
    def test_empty_state_explains_what_to_do(self):
        self.assertIsNotNone(self.widget.empty)
        self.assertIn("журнал игры", self.widget.empty.text())
        # Пустые карточки не висят серыми прямоугольниками.
        self.assertFalse(self.visible(self.widget.commander_card))
        self.assertFalse(self.visible(self.widget.system_card))
        self.assertEqual(self.widget.action_lines(), [])

    def test_commander_without_power_says_so_instead_of_guessing(self):
        self.widget.set_state(commander_state(power={}))
        self.assertIn("Держава не выбрана", self.widget.power_label_widget.text())
        # Карточка остаётся: ранг и заслуги известны и без державы.
        self.assertTrue(self.visible(self.widget.commander_card))

    # ---------------------------------------------------------- commander
    def test_commander_card_shows_power_rank_merits_votes_and_pledge(self):
        self.widget.set_state(commander_state())
        self.assertEqual(self.widget.power_label_widget.text(),
                         "Jerome Archer · Федерация")
        rank = self.widget.rank_label.text()
        self.assertIn("Ранг 12", rank)
        self.assertIn("заслуги 4 320", rank)
        self.assertIn("голоса 5", rank)
        self.assertIn("10 дн 0 ч", self.widget.pledge_label.text())
        self.assertIn("1 000 000 кр", self.widget.salary_label.text())

    def test_power_color_comes_from_the_directory(self):
        self.widget.set_state(commander_state())
        self.assertIn("#e94ae6", self.widget.power_label_widget.styleSheet())

    def test_missing_numbers_leave_their_lines_blank(self):
        self.widget.set_state(commander_state(rank=None, merits=None, votes=None))
        self.assertEqual(self.widget.rank_label.text(), "")
        self.widget.set_state(commander_state(time_pledged=None, salary={}))
        self.assertEqual(self.widget.pledge_label.text(), "")
        self.assertEqual(self.widget.salary_label.text(), "")

    def test_zero_votes_and_zero_merits_are_real_values(self):
        """Ноль — это ноль: новичок видит «0», а не пустоту."""
        self.widget.set_state(commander_state(rank=1, merits=0, votes=0))
        rank = self.widget.rank_label.text()
        self.assertIn("Ранг 1", rank)
        self.assertIn("заслуги 0", rank)
        self.assertIn("голоса 0", rank)

    # -------------------------------------------------------------- actions
    def test_actions_are_newest_first_with_time(self):
        self.widget.set_state(commander_state())
        lines = self.widget.action_lines()
        self.assertEqual(len(lines), 3)
        self.assertIn("выплата: 1 000 000 кр", lines[0])
        self.assertIn("01.11.2026 11:20", lines[0])
        self.assertIn("отдано голосов: 5", lines[1])
        self.assertIn("доставлено 15", lines[2])
        self.assertIn("Power Converters", lines[2])

    def test_actions_header_disappears_without_actions(self):
        self.widget.set_state(commander_state(actions=[]))
        self.assertEqual(self.widget.action_lines(), [])
        self.assertFalse(self.visible(self.widget.actions_header))

    def test_unknown_action_kind_is_skipped_not_shown_blank(self):
        self.widget.set_state(commander_state(actions=[
            {"kind": "PowerplaySomethingNew", "at": "2026-11-01T12:00:00Z"}]))
        self.assertEqual(self.widget.action_lines(), [])

    def test_new_state_replaces_old_action_lines(self):
        self.widget.set_state(commander_state())
        self.widget.set_state(commander_state(actions=[
            {"kind": "PowerplayJoin", "at": "2026-11-02T09:00:00Z",
             "power": "Aisling Duval"}]))
        lines = self.widget.action_lines()
        self.assertEqual(len(lines), 1)
        self.assertIn("Aisling Duval", lines[0])

    # --------------------------------------------------------------- system
    def test_system_card_shows_owner_state_and_scale(self):
        self.widget.set_state(commander_state(system=system_state()))
        system = self.widget
        self.assertIn("Sol", system.system_label.text())
        self.assertIn("Оплот", system.state_label.text())
        self.assertIn("30", system.state_label.text())
        control = system.control_label.text()
        self.assertIn("Jerome Archer · Федерация", control)
        self.assertIn("62 %", control)
        self.assertIn("1 240", control)
        self.assertIn("380", control)
        self.assertEqual(system.control_bar.value(), 620)
        self.assertTrue(self.visible(system.control_bar))
        self.assertIn("Aisling Duval", system.powers_label.text())
        self.assertIn("журнал игры", system.source_label.text())

    def test_system_without_owner_is_not_attributed_to_a_pretender(self):
        self.widget.set_state(commander_state(system=system_state(
            power="", power_info={}, state="Unoccupied",
            state_info={"name": "Unoccupied", "title": "Свободная система",
                        "range_ly": 0})))
        self.assertIn("Держава не определена", self.widget.control_label.text())
        self.assertIn("своей зоны влияния не даёт", self.widget.state_label.text())

    def test_system_without_progress_hides_the_bar(self):
        self.widget.set_state(commander_state(system=system_state(
            control_progress=None, reinforcement=None, undermining=None)))
        self.assertFalse(self.visible(self.widget.control_bar))
        self.assertEqual(self.widget.control_label.text(),
                         "Держава: Jerome Archer · Федерация")

    def test_stronghold_progress_above_one_hundred_is_clamped(self):
        self.widget.set_state(commander_state(system=system_state(
            control_progress=1.35)))
        self.assertEqual(self.widget.control_bar.value(), 1000)
        self.assertIn("135 %", self.widget.control_label.text())

    def test_system_card_hides_when_no_system_is_known(self):
        self.widget.set_state(commander_state(system=None))
        self.assertFalse(self.visible(self.widget.system_card))
        self.assertFalse(self.visible(self.widget.control_bar))

    def test_site_source_is_named_as_the_site(self):
        self.widget.set_state(commander_state(system=system_state(
            source="site", observed_at="2026-11-01T09:00:00Z")))
        self.assertIn("сайт проекта", self.widget.source_label.text())

    def test_archive_source_is_named_as_the_archive(self):
        self.widget.set_state(commander_state(system=system_state(
            source="journal-archive")))
        self.assertIn("архив", self.widget.source_label.text())

    # ---------------------------------------------------------------- notes
    def test_note_reaches_the_window(self):
        self.widget.set_state(commander_state(
            note="Сайт не ответил — показано из журнала игры."))
        self.assertIn("Сайт не ответил", self.widget.note_label.text())
        self.widget.set_state(commander_state(note=""))
        self.assertEqual(self.widget.note_label.text(), "")

    def test_state_is_kept_for_the_next_redraw(self):
        state = commander_state()
        self.widget.set_state(state)
        self.assertEqual(self.widget.state()["merits"], 4320)

    def test_none_state_is_treated_as_empty(self):
        self.widget.set_state(None)
        self.assertEqual(self.widget.state(), {})
        self.assertIsNotNone(self.widget.empty)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class PowerplayTextTests(unittest.TestCase):
    """Подписи без окна: их же использует карточка, и они попадают в переводы."""

    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def test_thousands_are_split_like_in_the_game(self):
        self.assertEqual(qt_powerplay._thousands(4320), "4 320")
        self.assertEqual(qt_powerplay._thousands(1000000), "1 000 000")
        self.assertEqual(qt_powerplay._thousands(0), "0")
        self.assertEqual(qt_powerplay._thousands(None), "")
        self.assertEqual(qt_powerplay._thousands("12"), "12")

    def test_duration_talks_in_days_and_hours(self):
        self.assertEqual(qt_powerplay.duration_text(864000), "10 дн 0 ч")
        self.assertEqual(qt_powerplay.duration_text(3700), "1 ч 1 мин")
        self.assertEqual(qt_powerplay.duration_text(45), "0 ч 0 мин")
        self.assertEqual(qt_powerplay.duration_text(None), "")
        self.assertEqual(qt_powerplay.duration_text(-5), "")

    def test_power_label_includes_the_allegiance(self):
        self.assertEqual(qt_powerplay.power_label(
            {"name": "Aisling Duval", "label": "Aisling Duval",
             "allegiance": "Empire"}), "Aisling Duval · Империя")
        self.assertEqual(qt_powerplay.power_label(
            {"name": "Some New Power", "label": "Some New Power"}), "Some New Power")
        self.assertEqual(qt_powerplay.power_label({}), "")

    def test_every_action_kind_has_a_line(self):
        for kind, key in qt_powerplay.ACTION_KEYS.items():
            text = qt_powerplay.action_text({"kind": kind, "count": 3, "votes": 2,
                                             "amount": 500, "power": "Aisling Duval",
                                             "from_power": "Jerome Archer",
                                             "to_power": "Aisling Duval"})
            self.assertTrue(text, kind)
            self.assertNotIn("{", text, f"{kind}: в подписи остался шаблон {key}")

    def test_action_line_names_what_was_moved(self):
        text = qt_powerplay.action_text({"kind": "PowerplayCollect", "count": 12,
                                         "item": "Power Converters"})
        self.assertIn("собрано 12", text)
        self.assertIn("Power Converters", text)

    def test_unknown_action_gives_no_line(self):
        self.assertEqual(qt_powerplay.action_text({"kind": "Docked"}), "")
        self.assertEqual(qt_powerplay.action_text({}), "")


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class PowerplayTrackerToPanelTests(unittest.TestCase):
    """Сквозная проверка: живые события журнала → подписи на вкладке."""

    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def test_journal_events_end_up_on_the_tab(self):
        tracker = powerplay_data.PowerplayTracker()
        tracker.handle({"event": "Powerplay", "timestamp": "2026-11-01T10:00:00Z",
                        "Power": "Aisling Duval", "Rank": 7, "Merits": 2100,
                        "Votes": 3, "TimePledged": 172800})
        tracker.handle({"event": "FSDJump", "timestamp": "2026-11-01T10:05:00Z",
                        "StarSystem": "Cubeo", "SystemAddress": 1,
                        "ControllingPower": "Aisling Duval",
                        "Powers": ["Aisling Duval"],
                        "PowerplayState": "Fortified",
                        "PowerplayStateControlProgress": 0.44})
        tracker.handle({"event": "PowerplayDeliver",
                        "timestamp": "2026-11-01T10:30:00Z",
                        "Count": 20, "Type_Localised": "Political Prisoners"})

        widget = qt_powerplay.PowerplayPanel(locale="ru",
                                             site_url="https://edringcolony.ru")
        widget.set_state(tracker.state(now_system="Cubeo"))

        self.assertIn("Aisling Duval · Империя", widget.power_label_widget.text())
        self.assertIn("заслуги 2 100", widget.rank_label.text())
        self.assertIn("2 дн 0 ч", widget.pledge_label.text())
        self.assertIn("Cubeo", widget.system_label.text())
        self.assertIn("Укреплённая", widget.state_label.text())
        self.assertIn("44 %", widget.control_label.text())
        self.assertEqual(widget.control_bar.value(), 440)
        self.assertEqual(len(widget.action_lines()), 1)
        self.assertIn("Political Prisoners", widget.action_lines()[0])
        self.assertIsNone(widget.empty)


if __name__ == "__main__":
    unittest.main()
