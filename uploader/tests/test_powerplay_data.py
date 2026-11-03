"""PowerPlay 2.0: разбор журнала, состояние командира и системы.

Проверяем правила, которые видно только вместе с игрой:

* «держава по журналу» — это ``ControllingPower``, а ``Powers`` перечисляет
  только претендентов: без владельца вкладка пишет «держава не определена», а
  не угадывает по единственной державе в списке (это же правило слоя карты на
  сайте, см. ``POWERPLAY.md``);
* наблюдения PowerPlay 1.0 (до 29.10.2024) не принимаются: тогда те же поля
  значили другое;
* чего в событии нет, того и в окне нет — «неизвестно» никогда не становится
  нулём;
* старое событие не откатывает уже прочитанное живое.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import powerplay_data as pp  # noqa: E402


def jump(**overrides):
    """``FSDJump`` населённой системы с полями PowerPlay."""
    event = {
        "timestamp": "2026-11-01T10:05:00Z",
        "event": "FSDJump",
        "StarSystem": "Sol",
        "SystemAddress": 10477373803,
        "ControllingPower": "Jerome Archer",
        "Powers": ["Jerome Archer", "Aisling Duval"],
        "PowerplayState": "Stronghold",
        "PowerplayStateControlProgress": 0.62,
        "PowerplayStateReinforcement": 1240,
        "PowerplayStateUndermining": 380,
    }
    event.update(overrides)
    return event


def commander(**overrides):
    """Событие ``Powerplay`` — то, что игра пишет при входе и после изменений."""
    event = {
        "timestamp": "2026-11-01T10:00:00Z",
        "event": "Powerplay",
        "Power": "Jerome Archer",
        "Rank": 12,
        "Merits": 4320,
        "Votes": 5,
        "TimePledged": 864000,
    }
    event.update(overrides)
    return event


class PowerDirectoryTests(unittest.TestCase):
    def test_names_are_normalized_the_way_the_journal_spells_them(self):
        self.assertEqual(pp.normalize_power("aisling duval"), "Aisling Duval")
        self.assertEqual(pp.normalize_power("A. Lavigny-Duval"), "A. Lavigny-Duval")
        self.assertEqual(pp.normalize_power("arissa lavigny duval"), "A. Lavigny-Duval")
        self.assertEqual(pp.normalize_power("Li Yong Rui"), "Li Yong-Rui")
        # Неизвестная держава не теряется: имя остаётся как в журнале.
        self.assertEqual(pp.normalize_power("Some New Power"), "Some New Power")
        self.assertEqual(pp.normalize_power(None), "")
        self.assertEqual(pp.normalize_power("$power;"), "")

    def test_colors_come_from_the_site_directory(self):
        """Цвета держав — те же, что на карте Atlas (`POWERPLAY_POWERS`)."""
        self.assertEqual(pp.power_info("Jerome Archer")["color"], "#e94ae6")
        self.assertEqual(pp.power_info("Aisling Duval")["color"], "#19b5e6")
        self.assertEqual(pp.power_info("A. Lavigny-Duval")["label"], "Arissa Lavigny-Duval")
        # Новая держава получает цвет из имени, а не серую заглушку.
        color = pp.power_info("Some New Power")["color"]
        self.assertTrue(color.startswith("#") and len(color) == 7)
        self.assertEqual(color, pp.power_info("Some New Power")["color"])

    def test_unknown_power_is_not_grey(self):
        self.assertNotIn(pp.power_info("Some New Power")["color"], ("#8794a1", ""))

    def test_system_states_have_titles_and_ranges(self):
        self.assertEqual(pp.state_info("Stronghold")["title"], "Оплот")
        self.assertEqual(pp.state_info("Stronghold")["range_ly"], 30)
        self.assertEqual(pp.state_info("Fortified")["range_ly"], 20)
        self.assertEqual(pp.state_info("Exploited")["range_ly"], 0)
        self.assertEqual(pp.state_info("Unoccupied")["title"], "Свободная система")
        self.assertEqual(pp.state_info("Contested")["title"], "Спорная")
        # Новое состояние после обновления игры не прячем.
        self.assertEqual(pp.state_info("BrandNew")["name"], "BrandNew")
        self.assertEqual(pp.state_info("BrandNew")["title"], "")

    def test_allegiances_have_translation_keys(self):
        self.assertEqual(pp.allegiance_title("Empire"), "Империя")
        self.assertEqual(pp.allegiance_title("Federation"), "Федерация")
        self.assertEqual(pp.allegiance_title("Alliance"), "Альянс")
        self.assertEqual(pp.allegiance_title("Independent"), "Независимые")
        self.assertEqual(pp.allegiance_title(""), "")
        self.assertEqual(pp.allegiance_title(None), "")


class SystemStateTests(unittest.TestCase):
    def test_full_jump_becomes_a_snapshot(self):
        snapshot = pp.system_state(jump())
        self.assertEqual(snapshot["power"], "Jerome Archer")
        self.assertEqual(snapshot["state"], "Stronghold")
        self.assertEqual(snapshot["powers"], ["Jerome Archer", "Aisling Duval"])
        self.assertAlmostEqual(snapshot["control_progress"], 0.62)
        self.assertEqual(snapshot["reinforcement"], 1240)
        self.assertEqual(snapshot["undermining"], 380)
        self.assertEqual(snapshot["source"], "journal")

    def test_powers_without_controlling_power_leave_the_owner_unknown(self):
        """``Powers`` — претенденты, а не владелец: угадывать нельзя."""
        snapshot = pp.system_state(jump(ControllingPower=None))
        self.assertEqual(snapshot["power"], "")
        self.assertEqual(snapshot["powers"], ["Jerome Archer", "Aisling Duval"])

    def test_unoccupied_system_has_a_state_but_no_owner(self):
        snapshot = pp.system_state(jump(PowerplayState="Unoccupied",
                                        ControllingPower=None, Powers=[]))
        self.assertEqual(snapshot["state"], "Unoccupied")
        self.assertEqual(snapshot["power"], "")
        self.assertEqual(snapshot["powers"], [])

    def test_powerplay_one_observation_is_rejected(self):
        """До 29.10.2024 те же поля значили другое (PowerPlay 1.0)."""
        self.assertIsNone(pp.system_state(jump(timestamp="2019-05-01T10:00:00Z")))

    def test_event_without_powerplay_fields_is_ignored(self):
        event = {"event": "FSDJump", "timestamp": "2026-11-01T10:05:00Z",
                 "StarSystem": "Sol", "SystemAddress": 1}
        self.assertIsNone(pp.system_state(event))

    def test_location_event_is_accepted_like_a_jump(self):
        event = jump(event="Location")
        self.assertEqual(pp.system_state(event)["power"], "Jerome Archer")

    def test_missing_counters_are_unknown_not_zero(self):
        event = jump(PowerplayStateControlProgress=None,
                     PowerplayStateReinforcement=None, PowerplayStateUndermining=None)
        snapshot = pp.system_state(event)
        self.assertIsNone(snapshot["control_progress"])
        self.assertIsNone(snapshot["reinforcement"])
        self.assertIsNone(snapshot["undermining"])

    def test_site_payload_is_understood(self):
        """Карточка системы сайта: ``powerplay`` уже разложен по ключам."""
        payload = {"found": True, "name": "Sol", "id64": "10477373803",
                   "powerplay": {"power": "Jerome Archer", "state": "Fortified",
                                 "powers": ["Jerome Archer"],
                                 "controlProgress": 0.41, "reinforcement": 900,
                                 "undermining": 120,
                                 "observedAt": "2026-11-01T09:00:00Z",
                                 "source": "journal"}}
        snapshot = pp.site_state(payload)
        self.assertEqual(snapshot["source"], "site")
        self.assertEqual(snapshot["state"], "Fortified")
        self.assertAlmostEqual(snapshot["control_progress"], 0.41)
        self.assertEqual(snapshot["observed_at"], "2026-11-01T09:00:00Z")

    def test_site_payload_without_powerplay_block_gives_nothing(self):
        self.assertIsNone(pp.site_state({"found": True, "name": "Sol", "powerplay": None}))


class CommanderTests(unittest.TestCase):
    def setUp(self):
        self.tracker = pp.PowerplayTracker()

    def test_powerplay_event_fills_rank_merits_votes_and_pledge_time(self):
        self.assertTrue(self.tracker.handle(commander()))
        state = self.tracker.state()
        self.assertEqual(state["power"]["name"], "Jerome Archer")
        self.assertEqual(state["rank"], 12)
        self.assertEqual(state["merits"], 4320)
        self.assertEqual(state["votes"], 5)
        self.assertEqual(state["time_pledged"], 864000)
        self.assertEqual(state["observed_at"], "2026-11-01T10:00:00Z")
        self.assertTrue(state["known"])

    def test_powerplay_one_era_event_is_not_taken(self):
        self.assertFalse(self.tracker.handle(commander(timestamp="2020-01-01T00:00:00Z")))
        self.assertFalse(self.tracker.state()["known"])

    def test_older_event_does_not_roll_back_the_newer_one(self):
        self.tracker.handle(commander(timestamp="2026-11-02T10:00:00Z", Merits=9000))
        self.tracker.handle(commander(timestamp="2026-11-01T10:00:00Z", Merits=10))
        state = self.tracker.state()
        self.assertEqual(state["merits"], 9000, "архив откатил живые данные")
        self.assertEqual(state["observed_at"], "2026-11-02T10:00:00Z")

    def test_actions_are_remembered_newest_first(self):
        self.tracker.handle(commander())
        self.tracker.handle({"event": "PowerplayDeliver", "timestamp": "2026-11-01T11:00:00Z",
                             "Power": "Jerome Archer", "Count": 15,
                             "Type_Localised": "Power Converters"})
        self.tracker.handle({"event": "PowerplayVote", "timestamp": "2026-11-01T11:10:00Z",
                             "Votes": 5})
        self.tracker.handle({"event": "PowerplaySalary", "timestamp": "2026-11-01T11:20:00Z",
                             "Amount": 1000000})
        actions = self.tracker.state()["actions"]
        self.assertEqual([row["kind"] for row in actions],
                         ["PowerplaySalary", "PowerplayVote", "PowerplayDeliver"])
        self.assertEqual(actions[1]["votes"], 5)
        self.assertEqual(self.tracker.state()["salary"]["amount"], 1000000)

    def test_action_list_is_capped(self):
        self.tracker.handle(commander())
        for index in range(pp.ACTION_LIMIT + 5):
            self.tracker.handle({"event": "PowerplayDeliver",
                                 "timestamp": f"2026-11-01T12:{index:02d}:00Z",
                                 "Count": index})
        self.assertEqual(len(self.tracker.state()["actions"]), pp.ACTION_LIMIT)

    def test_join_sets_power_and_zeroes(self):
        self.tracker.handle(commander())
        self.tracker.handle({"event": "PowerplayLeave", "timestamp": "2026-11-01T12:00:00Z",
                             "Power": "Jerome Archer"})
        state = self.tracker.state()
        self.assertEqual(state["power"], {})
        self.assertIsNone(state["rank"])

        self.tracker.handle({"event": "PowerplayJoin", "timestamp": "2026-11-01T12:05:00Z",
                             "Power": "Aisling Duval"})
        state = self.tracker.state()
        self.assertEqual(state["power"]["name"], "Aisling Duval")
        self.assertEqual(state["merits"], 0)
        self.assertEqual(state["votes"], 0)
        self.assertEqual(state["pledged_at"], "2026-11-01T12:05:00Z")

    def test_defect_names_both_powers_and_switches(self):
        self.tracker.handle(commander())
        self.tracker.handle({"event": "PowerplayDefect",
                             "timestamp": "2026-11-02T08:00:00Z",
                             "FromPower": "Jerome Archer", "ToPower": "Aisling Duval"})
        state = self.tracker.state()
        self.assertEqual(state["power"]["name"], "Aisling Duval")
        self.assertEqual(state["actions"][0]["from_power"], "Jerome Archer")
        self.assertEqual(state["actions"][0]["to_power"], "Aisling Duval")

    def test_system_state_is_kept_and_filtered_by_the_current_system(self):
        self.tracker.handle(jump())
        self.assertIsNotNone(self.tracker.state(now_system="Sol")["system"])
        self.assertIsNone(self.tracker.state(now_system="Alioth")["system"],
                          "состояние чужой системы показано как текущее")

    def test_system_state_computes_titles_and_colors(self):
        self.tracker.handle(jump())
        system = self.tracker.state(now_system="Sol")["system"]
        self.assertEqual(system["state_info"]["title"], "Оплот")
        self.assertEqual(system["power_info"]["color"], "#e94ae6")
        self.assertEqual([info["name"] for info in system["powers_info"]],
                         ["Jerome Archer", "Aisling Duval"])

    def test_newer_system_observation_wins(self):
        self.tracker.handle(jump(timestamp="2026-11-01T10:00:00Z",
                                 PowerplayState="Exploited"))
        self.tracker.handle(jump(timestamp="2026-11-02T10:00:00Z",
                                 PowerplayState="Fortified"))
        self.assertEqual(self.tracker.state(now_system="Sol")["system"]["state"],
                         "Fortified")
        # Старое наблюдение той же системы не откатывает состояние.
        self.assertFalse(self.tracker.apply_system(
            {"system": "Sol", "state": "Exploited", "observed_at": "2026-10-01T10:00:00Z"}))
        self.assertEqual(self.tracker.state(now_system="Sol")["system"]["state"],
                         "Fortified")

    def test_forget_clears_everything(self):
        self.tracker.handle(commander())
        self.tracker.handle(jump())
        self.tracker.forget()
        state = self.tracker.state()
        self.assertFalse(state["known"])
        self.assertEqual(state["actions"], [])
        self.assertIsNone(state["system"])

    def test_unknown_event_changes_nothing(self):
        self.assertFalse(self.tracker.handle({"event": "Docked"}))
        self.assertFalse(self.tracker.state()["known"])

    def test_action_without_its_numbers_is_not_recorded(self):
        """«Собрано» без числа — не действие: обрезанный журнал не рисуем."""
        self.assertFalse(self.tracker.handle({"event": "PowerplayCollect"}))
        self.assertEqual(self.tracker.state()["actions"], [])


class JournalScanTests(unittest.TestCase):
    """Хвосты журналов: Helper запустили уже в игре, живых событий нет."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name: str, events) -> Path:
        path = self.dir / name
        path.write_text("\n".join(json.dumps(event) for event in events) + "\n",
                        encoding="utf-8")
        return path

    def test_latest_powerplay_and_system_events_are_found(self):
        self.write("Journal.2026-10-31T100000.01.log", [commander(Merits=100),
                                                        jump(timestamp="2026-10-31T10:00:00Z")])
        self.write("Journal.2026-11-01T100000.01.log", [
            commander(timestamp="2026-11-01T10:00:00Z", Merits=4320),
            jump(),
            {"event": "Docked", "timestamp": "2026-11-01T10:30:00Z", "StarSystem": "Sol"},
        ])
        found = pp.scan_journal_for_powerplay(self.dir, "Sol", 10477373803)
        self.assertEqual(found["commander"]["Merits"], 4320)
        self.assertEqual(found["system"]["PowerplayState"], "Stronghold")

    def test_system_of_another_place_is_not_taken(self):
        self.write("Journal.2026-11-01T100000.01.log", [
            jump(StarSystem="Alioth", SystemAddress=1),
            commander(),
        ])
        found = pp.scan_journal_for_powerplay(self.dir, "Sol", 10477373803)
        self.assertIsNone(found["system"])
        self.assertIsNotNone(found["commander"], "держава командира не зависит от системы")

    def test_powerplay_one_era_events_are_skipped(self):
        self.write("Journal.2026-11-01T100000.01.log", [
            commander(timestamp="2020-01-01T00:00:00Z"),
        ])
        found = pp.scan_journal_for_powerplay(self.dir, "Sol", 10477373803)
        self.assertIsNone(found["commander"])

    def test_empty_or_missing_folder_is_not_an_error(self):
        self.assertEqual(pp.scan_journal_for_powerplay(self.dir, "Sol", 1),
                         {"commander": None, "system": None})
        self.assertEqual(pp.scan_journal_for_powerplay(self.dir / "нет", "Sol", 1),
                         {"commander": None, "system": None})
        self.assertEqual(pp.scan_journal_for_powerplay(None, "Sol", 1),
                         {"commander": None, "system": None})

    def test_broken_lines_do_not_stop_the_scan(self):
        path = self.dir / "Journal.2026-11-01T100000.01.log"
        path.write_text('{"event": "Docked"\nnot json\n'
                        + json.dumps(commander()) + "\n", encoding="utf-8")
        self.assertIsNotNone(pp.scan_journal_for_powerplay(self.dir, "Sol", 0)["commander"])

    def test_scan_feeds_the_tracker(self):
        self.write("Journal.2026-11-01T100000.01.log", [commander(), jump()])
        found = pp.scan_journal_for_powerplay(self.dir, "Sol", 10477373803)
        tracker = pp.PowerplayTracker()
        tracker.handle(found["commander"])
        tracker.handle(found["system"])
        state = tracker.state(now_system="Sol")
        self.assertEqual(state["merits"], 4320)
        self.assertEqual(state["system"]["state"], "Stronghold")


class _Response:
    """Ответ ``requests`` без сети: только то, что читает ``ApiClient``."""

    def __init__(self, status, body):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._body = body
        self.text = ""

    def json(self):
        return self._body


SOL_OVERVIEW = {
    "found": True,
    "name": "Sol",
    "id64": "10477373803",
    "powerplay": {
        "power": "Jerome Archer",
        "state": "Stronghold",
        "powers": ["Jerome Archer", "Aisling Duval"],
        "controlProgress": 0.62,
        "reinforcement": 1240,
        "undermining": 380,
        "observedAt": "2026-11-01T10:05:00Z",
        "source": "journal",
    },
}


class SiteRequestTests(unittest.TestCase):
    """``GET /api/systems/overview`` — единственный дешёвый источник PowerPlay."""

    def setUp(self):
        from api_client import ApiClient
        from unittest import mock as _mock

        self.mock = _mock
        self.client = ApiClient(token="t", site_url="https://colony.test")
        self.client._session = _mock.Mock()

    def test_address_goes_as_id64_to_the_system_card(self):
        self.client._session.get.return_value = _Response(200, SOL_OVERVIEW)
        result = self.client.get_system_powerplay(10477373803, "Sol")
        self.assertTrue(result["ok"])
        self.assertEqual(result["powerplay"]["state"], "Stronghold")
        args, kwargs = self.client._session.get.call_args
        self.assertEqual(args[0], "https://colony.test/api/systems/overview")
        self.assertEqual(kwargs["params"], {"id64": "10477373803", "name": "Sol"})

    def test_system_without_powerplay_is_not_an_error(self):
        self.client._session.get.return_value = _Response(
            200, {"found": True, "name": "Lave", "id64": "1", "powerplay": None})
        result = self.client.get_system_powerplay(1, "Lave")
        self.assertTrue(result["ok"])
        self.assertIsNone(result["powerplay"])
        self.assertIsNone(pp.site_state({"found": True, "name": "Lave",
                                         "powerplay": result["powerplay"]}))

    def test_missing_system_is_not_a_network_error(self):
        self.client._session.get.return_value = _Response(
            200, {"found": False, "error": "Системы нет в базе"})
        result = self.client.get_system_powerplay(4242, "")
        self.assertFalse(result["ok"])
        self.assertTrue(result["missing"])

    def test_server_error_and_network_failure_are_reported(self):
        self.client._session.get.return_value = _Response(503, {"error": "Недоступно"})
        self.assertEqual(self.client.get_system_powerplay(1, "")["error"], "Недоступно")
        self.client._session.get.side_effect = OSError("нет сети")
        result = self.client.get_system_powerplay(1, "")
        self.assertFalse(result["ok"])
        self.assertIn("нет сети", result["error"])

    def test_empty_request_does_not_touch_the_network(self):
        result = self.client.get_system_powerplay(0, "")
        self.assertFalse(result["ok"])
        self.client._session.get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
