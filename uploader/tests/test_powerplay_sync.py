"""Раздел «BGS», вкладка PowerPlay: путь «журнал + сайт» в самом Helper.

Окно ничего не считает: ``powerplay_data`` держит состояние командира и
системы, а Helper только принимает живые события, дособирает хвосты журналов и
(если журнал молчит) спрашивает карточку системы у сайта. Здесь проверяется
именно эта связка: живые события, ответ фона, TTL, «чужой» ответ и пояснение.

Тесты Qt: на машине без Qt-плагинов они пропускаются (см. `QT_ERROR`).
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    import colonial_helper

    from test_initial_upload_flow import install_gui_stubs, make_root, restore_gui_stubs

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


COMMANDER = {
    "event": "Powerplay",
    "timestamp": "2026-11-01T10:00:00Z",
    "Power": "Jerome Archer",
    "Rank": 12,
    "Merits": 4320,
    "Votes": 5,
    "TimePledged": 864000,
}

SOL_JUMP = {
    "event": "FSDJump",
    "timestamp": "2026-11-01T10:05:00Z",
    "StarSystem": "Sol",
    "SystemAddress": 10477373803,
    "ControllingPower": "Jerome Archer",
    "Powers": ["Jerome Archer", "Aisling Duval"],
    "PowerplayState": "Stronghold",
    "PowerplayStateControlProgress": 0.62,
    "PowerplayStateReinforcement": 1240,
    "PowerplayStateUndermining": 380,
}

#: Ответ ``GET /api/systems/overview`` — тот же блок, что читает карта Atlas.
SITE_PAYLOAD = {
    "ok": True,
    "found": True,
    "id64": "10477373803",
    "name": "Sol",
    "powerplay": {
        "power": "Aisling Duval",
        "state": "Fortified",
        "powers": ["Aisling Duval"],
        "controlProgress": 0.44,
        "reinforcement": 900,
        "undermining": 120,
        "observedAt": "2026-10-31T20:00:00Z",
        "source": "journal",
    },
}


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class PowerplaySyncTests(unittest.TestCase):
    def setUp(self):
        install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch",
                     "journal_parser", "overlay", "ship_tracker", "route_tracker",
                     "game_monitor", "exobiology"):
            sys.modules.pop(name, None)
        self.app_module = __import__("colonial_helper")
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.journals = self.home / "journals"
        self.journals.mkdir()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(restore_gui_stubs)
        # Сборка раздела запускает фоновое обновление: сеть подменена, чтобы
        # прогон никогда не уходил наружу.
        api = mock.patch.object(self.app_module.ApiClient, "get_system_powerplay",
                                return_value={"ok": False, "missing": True})
        api.start()
        self.addCleanup(api.stop)
        with mock.patch.object(self.app_module, "DEFAULT_JOURNAL_PATH", self.journals), \
                mock.patch.object(self.app_module.ColonialHelperApp, "save_config"), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            self.helper = self.app_module.ColonialHelperApp(make_root())
        self.helper.journal_path = self.journals
        deadline = time.monotonic() + 5.0
        while self.helper._powerplay_inflight and time.monotonic() < deadline:
            time.sleep(0.01)
        self.helper._powerplay_inflight = False
        self.widget = self.helper.powerplay_panel

    # -------------------------------------------------------------- helpers
    def write_journal(self, events, name="Journal.2026-11-01T100000.01.log"):
        path = self.journals / name
        path.write_text("\n".join(json.dumps(event) for event in events) + "\n",
                        encoding="utf-8")
        os.utime(path, (time.time(), time.time()))
        return path

    def apply(self, events=None, site=None, site_error="", system="Sol",
              address=10477373803):
        self.helper._apply_powerplay_refresh({
            "system": system, "address": address, "events": events or {},
            "site": site, "site_error": site_error,
        })

    # ----------------------------------------------------------- structure
    def test_section_has_both_tabs(self):
        self.assertEqual(self.helper.bgs_section.tabs.count(), 2)
        self.assertIn("Фракции", self.helper.bgs_section.tabs.tabText(0))
        self.assertIn("PowerPlay", self.helper.bgs_section.tabs.tabText(1))
        self.assertIs(self.helper.powerplay_panel,
                      self.helper.bgs_section.powerplay)

    def test_powerplay_tab_starts_with_the_hint(self):
        self.assertIsNotNone(self.widget.empty)
        self.assertIn("журнал игры", self.widget.empty.text())

    # ------------------------------------------------------- live journal
    def test_live_events_fill_the_tab(self):
        self.helper._update_powerplay(COMMANDER)
        self.helper._update_powerplay(SOL_JUMP)
        self.assertIn("Jerome Archer", self.widget.power_label_widget.text())
        self.assertIn("заслуги 4 320", self.widget.rank_label.text())
        self.assertIn("Sol", self.widget.system_label.text())
        self.assertIn("Оплот", self.widget.state_label.text())
        self.assertEqual(self.widget.control_bar.value(), 620)

    def test_live_system_state_is_shown_for_the_current_system(self):
        self.helper._update_powerplay(SOL_JUMP)
        self.helper.ship.state.current_system = "Alioth"
        self.helper._render_powerplay()
        self.assertIn("Данных PowerPlay", self.widget.empty.text(),
                      "состояние Sol выдано за текущую систему")

    def test_new_commander_clears_the_previous_record(self):
        self.helper._update_powerplay(COMMANDER)
        self.helper._update_powerplay({"event": "LoadGame",
                                       "timestamp": "2026-11-02T09:00:00Z"})
        self.assertFalse(self.widget.state().get("known"))
        self.assertEqual(self.widget.state().get("merits"), None)

    def test_powerplay_one_events_are_ignored(self):
        self.helper._update_powerplay(dict(COMMANDER, timestamp="2020-01-01T00:00:00Z"))
        self.assertFalse(self.widget.state().get("known"))

    # ---------------------------------------------------------- background
    def test_journal_archive_is_used_when_the_site_knows_nothing(self):
        self.write_journal([COMMANDER, SOL_JUMP])
        with mock.patch.object(self.helper.api, "get_system_powerplay",
                               return_value={"ok": False, "missing": True}):
            self.helper._powerplay_refresh_worker(force=True)
        self.assertIn("заслуги 4 320", self.widget.rank_label.text())
        self.assertIn("Оплот", self.widget.state_label.text())
        self.assertIn("архив", self.widget.source_label.text())

    def test_site_card_fills_the_system_when_the_journal_is_silent(self):
        self.helper.ship.state.current_system = "Sol"
        self.helper.ship.state.system_address = 10477373803
        with mock.patch.object(self.helper.api, "get_system_powerplay",
                               return_value=SITE_PAYLOAD):
            self.helper._powerplay_refresh_worker(force=True)
        self.assertIn("Sol", self.widget.system_label.text())
        self.assertIn("Укреплённая", self.widget.state_label.text())
        self.assertIn("сайт проекта", self.widget.source_label.text())
        self.assertEqual(self.widget.note_label.text(), "")

    def test_live_journal_beats_an_older_site_answer(self):
        self.helper._update_powerplay(SOL_JUMP)          # живое событие 10:05
        self.apply(events={}, site=SITE_PAYLOAD)   # сайт видел 20:00
        self.assertIn("Оплот", self.widget.state_label.text(), "живой журнал остался")
        self.assertIn("62 %", self.widget.control_label.text())

    def test_site_error_is_explained_under_the_cards(self):
        self.helper.ship.state.current_system = "Sol"
        self.helper.ship.state.system_address = 10477373803
        with mock.patch.object(self.helper.api, "get_system_powerplay",
                               return_value={"ok": False, "error": "HTTP 503"}):
            self.helper._powerplay_refresh_worker(force=True)
        self.assertIn("HTTP 503", self.widget.note_label.text())

    def test_free_system_says_so_without_an_error(self):
        self.helper.ship.state.current_system = "Sol"
        self.helper.ship.state.system_address = 10477373803
        with mock.patch.object(self.helper.api, "get_system_powerplay",
                               return_value={"ok": False, "missing": True}):
            self.helper._powerplay_refresh_worker(force=True)
        self.assertIn("ни в журнале игры, ни в базе проекта",
                      self.widget.note_label.text())

    def test_answer_for_a_system_the_pilot_left_is_dropped(self):
        self.helper.ship.state.current_system = "Lave"
        self.apply(events={}, site=SITE_PAYLOAD, system="Sol")
        self.assertNotIn("Sol", self.widget.system_label.text())

    def test_refresh_keeps_one_request_in_flight(self):
        self.helper._powerplay_inflight = True
        with mock.patch("threading.Thread") as thread:
            self.helper._refresh_powerplay()
        thread.assert_not_called()

    def test_refresh_is_rate_limited_by_system(self):
        self.helper._powerplay_request_key = "10477373803"
        self.helper._powerplay_request_at = time.monotonic()
        with mock.patch("threading.Thread") as thread:
            self.helper._refresh_powerplay()
        thread.assert_not_called()
        with mock.patch("threading.Thread") as thread:
            self.helper._refresh_powerplay(force=True)
        self.assertTrue(thread.called, "кнопка «Обновить» обходит TTL")

    def test_failed_journal_scan_still_asks_the_site(self):
        with mock.patch.object(self.app_module, "scan_journal_for_powerplay",
                               side_effect=OSError("no such folder")), \
                mock.patch.object(self.helper.api, "get_system_powerplay",
                                  return_value=SITE_PAYLOAD) as asked:
            self.helper.journal_path = self.journals / "нет"
            self.helper.ship.state.current_system = "Sol"
            self.helper.ship.state.system_address = 10477373803
            self.helper._powerplay_refresh_worker(force=True)
        self.assertTrue(asked.called)


if __name__ == "__main__":
    unittest.main()
