"""Вкладка «Фракции»: путь «журнал + база проекта» без свежего события.

Жалоба: «Не отображается информация о минорках системы, в которой находится
пилот… сейчас просто ожидание данных и ничего больше». Причина — состояние
вкладки наполнялось только живыми ``FSDJump``/``Location``. Здесь проверяется,
что Helper показывает фракции и без них: из хвоста журналов и из базы проекта
(``GET /api/factions/system``), а живое событие остаётся приоритетным.

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


SOL_EVENT = {
    "event": "FSDJump",
    "timestamp": "2026-10-31T22:14:03Z",
    "StarSystem": "Sol",
    "SystemAddress": 10477373803,
    "SystemFaction": {"Name": "Sol Workers' Party", "FactionState": "Boom"},
    "Factions": [
        {"Name": "Sol Workers' Party", "Influence": 0.58, "Allegiance": "Federation",
         "Government": "Democracy", "FactionState": "Boom",
         "ActiveStates": [{"State": "Boom"}]},
        {"Name": "Mother Gaia", "Influence": 0.22, "Allegiance": "Federation",
         "Government": "Democracy"},
        {"Name": "Sol Nationalists", "Influence": 0.12, "Allegiance": "Federation",
         "Government": "Dictatorship", "FactionState": "Lockdown"},
    ],
}

SITE_PAYLOAD = {
    "ok": True,
    "system": {
        "id64": "10477373803",
        "name": "Sol",
        "controlling_faction": "Sol Workers' Party",
        "observed_at": "2026-10-31T20:00:00+00:00",
        "source": "helper",
    },
    "factions": [
        {"id": 1, "name": "Sol Workers' Party", "influence": 0.62,
         "allegiance": "Federation", "government": "Democracy", "state": "Boom",
         "active_states": ["Boom"], "is_player": True},
        {"id": 2, "name": "Mother Gaia", "influence": 0.31, "allegiance": "Federation",
         "government": "Democracy", "state": "None", "active_states": []},
    ],
}


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class FactionSourceTests(unittest.TestCase):
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
        # Сборка вкладки запускает фоновое обновление: в тестах сайт подменён,
        # чтобы ни один прогон не уходил в сеть.
        api = mock.patch.object(self.app_module.ApiClient, "get_system_factions",
                                return_value={"ok": False, "missing": True})
        api.start()
        self.addCleanup(api.stop)
        with mock.patch.object(self.app_module, "DEFAULT_JOURNAL_PATH", self.journals), \
                mock.patch.object(self.app_module.ColonialHelperApp, "save_config"), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            self.helper = self.app_module.ColonialHelperApp(make_root())
        self.helper.journal_path = self.journals
        deadline = time.monotonic() + 5.0
        while self.helper._faction_site_inflight and time.monotonic() < deadline:
            time.sleep(0.01)
        self.helper._faction_site_inflight = False
        self.widget = self.helper.faction_infographic

    # -------------------------------------------------------------- helpers
    def write_journal(self, events, name="Journal.2026-10-31T221403.01.log"):
        path = self.journals / name
        path.write_text("\n".join(json.dumps(event) for event in events) + "\n",
                        encoding="utf-8")
        os.utime(path, (time.time(), time.time()))
        return path

    def apply(self, journal=None, site=None, site_error="", system="Sol",
              address=10477373803):
        self.helper._apply_faction_refresh({
            "system": system, "address": address, "journal": journal,
            "site": site, "site_error": site_error,
        })

    # --------------------------------------------------------------- tests
    def test_site_snapshot_fills_the_tab_without_any_jump(self):
        self.helper.ship.state.current_system = "Sol"
        self.helper.ship.state.system_address = 10477373803
        self.apply(site=SITE_PAYLOAD)
        self.assertEqual(self.widget.cards_count(), 2)
        self.assertIn("сайт проекта", self.widget.source_label.text())
        self.assertEqual(self.widget.status_label.text(), "")

    def test_site_factions_carry_the_player_flag(self):
        self.apply(site=SITE_PAYLOAD)
        card = self.widget._card_widgets()[0]
        from PySide6.QtWidgets import QLabel

        texts = [item.text() for item in card.findChildren(QLabel)]
        self.assertTrue(any("фракция игроков" in text for text in texts))

    def test_journal_is_used_when_the_site_knows_nothing(self):
        self.apply(journal=None, site=None)
        self.assertEqual(self.widget.cards_count(), 0)
        self.assertIn("не найдены", self.widget.status_label.text())

    def test_site_failure_keeps_the_journal_data(self):
        import factions_data

        journal = factions_data.snapshot_from_event(SOL_EVENT)
        self.apply(journal=journal, site=None, site_error="HTTP 503")
        self.assertEqual(self.widget.cards_count(), 3)
        self.assertIn("журнал", self.widget.source_label.text())
        self.assertIn("HTTP 503", self.widget.status_label.text())

    def test_newer_journal_snapshot_beats_an_older_site_answer(self):
        import factions_data

        journal = factions_data.snapshot_from_event(SOL_EVENT)
        self.apply(journal=journal, site=SITE_PAYLOAD)
        self.assertEqual(self.widget.cards_count(), 3, "три фракции из журнала")
        self.assertIn("журнал игры", self.widget.source_label.text())

    def test_live_event_is_not_rolled_back_by_an_old_site_answer(self):
        self.helper._update_faction_infographic(SOL_EVENT)   # живое событие 22:14
        self.assertEqual(self.widget.cards_count(), 3)
        self.apply(site=SITE_PAYLOAD)                        # сайт видел 20:00
        self.assertEqual(self.widget.cards_count(), 3, "живой журнал остаётся")
        self.assertIn("журнал игры", self.widget.source_label.text())

    def test_answer_from_a_system_the_pilot_already_left_is_dropped(self):
        self.helper.ship.state.current_system = "Lave"
        self.apply(site=SITE_PAYLOAD, system="Sol")
        self.assertEqual(self.widget.cards_count(), 0)

    def test_worker_reads_the_journal_when_trackers_are_empty(self):
        self.write_journal([SOL_EVENT])
        self.helper._faction_system = ""
        self.helper._faction_system_address = 0
        self.helper.ship.state.current_system = ""
        self.helper.system_map.current_system = ""
        with mock.patch.object(self.helper.api, "get_system_factions",
                               return_value={"ok": False, "missing": True}) as asked:
            self.helper._faction_refresh_worker(force=True)
        self.assertTrue(asked.called, "сайт спросили по найденной системе")
        self.assertEqual(asked.call_args[0][0], 10477373803)
        self.assertEqual(self.widget.cards_count(), 3, "фракции из хвоста журнала")
        self.assertIn("архив", self.widget.source_label.text())

    def test_worker_uses_the_site_card_for_a_known_system(self):
        self.helper.ship.state.current_system = "Sol"
        self.helper.ship.state.system_address = 10477373803
        with mock.patch.object(self.helper.api, "get_system_factions",
                               return_value=SITE_PAYLOAD):
            self.helper._faction_refresh_worker(force=True)
        self.assertEqual(self.widget.cards_count(), 2)
        self.assertIn("сайт проекта", self.widget.source_label.text())

    def test_refresh_keeps_one_request_in_flight(self):
        self.helper._faction_site_inflight = True
        with mock.patch("threading.Thread") as thread:
            self.helper._refresh_factions_data()
        thread.assert_not_called()

    def test_refresh_is_rate_limited_by_system(self):
        self.helper._faction_request_key = "10477373803"
        self.helper._faction_request_at = time.monotonic()
        with mock.patch("threading.Thread") as thread:
            self.helper._refresh_factions_data()
        thread.assert_not_called()
        with mock.patch("threading.Thread") as thread:
            self.helper._refresh_factions_data(force=True)
        self.assertTrue(thread.called, "кнопка «Обновить» обходит TTL")

    def test_no_system_known_shows_the_hint(self):
        self.helper._faction_system = ""
        self.helper._faction_system_address = 0
        self.helper.ship.state.current_system = ""
        self.helper.system_map.current_system = ""
        with mock.patch.object(self.helper, "_determine_cmdr_system",
                               return_value=(None, 0)):
            self.helper._faction_refresh_worker(force=True)
        self.assertEqual(self.widget.cards_count(), 0)
        self.assertIn("Система не определена", self.widget.status_label.text())


if __name__ == "__main__":
    unittest.main()
