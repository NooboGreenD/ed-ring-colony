"""Вкладка «Фракции»: снимок из журнала, карточка с сайта и выбор свежего.

Проверяется то, из-за чего вкладка раньше показывала только «Ожидание данных
о системе…»: Helper должен уметь показать фракции системы, даже если свежего
``FSDJump`` в читаемых журналах нет, — из хвоста журналов и из базы проекта.
Здесь же закреплён приоритет источников: живой журнал свежее ответа сайта.
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

import factions_data
from api_client import ApiClient


SOL_EVENT = {
    "event": "FSDJump",
    "timestamp": "2026-10-31T22:14:03Z",
    "StarSystem": "Sol",
    "SystemAddress": 10477373803,
    "SystemFaction": {"Name": "Sol Workers' Party", "FactionState": "Boom"},
    "Factions": [
        {"Name": "Sol Nationalists", "Influence": 0.12, "Allegiance": "Federation",
         "Government": "Dictatorship", "FactionState": "Lockdown",
         "ActiveStates": [{"State": "Lockdown"}]},
        {"Name": "Sol Workers' Party", "Influence": 0.58, "Allegiance": "Federation",
         "Government": "Democracy", "FactionState": "Boom",
         "ActiveStates": [{"State": "Boom"}, {"State": "Expansion"}]},
        {"Name": "Mother Gaia", "Influence": 0.22, "Allegiance": "Federation",
         "Government": "Democracy"},
    ],
}

SITE_PAYLOAD = {
    "system": {
        "id64": "10477373803",
        "name": "Sol",
        "allegiance": "Federation",
        "government": "Democracy",
        "controlling_faction": "Sol Workers' Party",
        "observed_at": "2026-10-31T20:00:00+00:00",
        "source": "helper",
    },
    "factions": [
        {"id": 1, "name": "Mother Gaia", "influence": 0.31, "allegiance": "Federation",
         "government": "Democracy", "state": "None", "active_states": [],
         "is_player": False},
        {"id": 2, "name": "Sol Workers' Party", "influence": 0.62,
         "allegiance": "Federation", "government": "Democracy", "state": "Boom",
         "active_states": ["Boom"], "is_player": True},
    ],
}


def write_journal(directory, name, events, mtime=None):
    path = Path(directory) / name
    path.write_text("\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


class JournalSnapshotTests(unittest.TestCase):
    def test_event_becomes_a_sorted_snapshot(self):
        snapshot = factions_data.snapshot_from_event(SOL_EVENT)
        self.assertEqual(snapshot["system"], "Sol")
        self.assertEqual(snapshot["address"], "10477373803")
        self.assertEqual(snapshot["controlling"], "Sol Workers' Party")
        self.assertEqual(snapshot["observed_at"], "2026-10-31T22:14:03Z")
        self.assertEqual(snapshot["source"], factions_data.SOURCE_JOURNAL)
        self.assertEqual([row["name"] for row in snapshot["factions"]],
                         ["Sol Workers' Party", "Mother Gaia", "Sol Nationalists"])
        top = snapshot["factions"][0]
        self.assertEqual(top["influence"], 0.58)
        self.assertEqual(top["active_states"], ["Boom", "Expansion"])
        self.assertEqual(top["allegiance"], "Federation")

    def test_events_without_factions_are_ignored(self):
        for event in ({"event": "Docked", "StarSystem": "Sol", "SystemAddress": 1},
                      {"event": "FSDJump", "StarSystem": "Sol", "Factions": []},
                      {"event": "Location", "Factions": SOL_EVENT["Factions"]},
                      "мусор"):
            self.assertIsNone(factions_data.snapshot_from_event(event))

    def test_influence_is_clamped_and_garbage_becomes_zero(self):
        event = json.loads(json.dumps(SOL_EVENT))
        event["Factions"][0]["Influence"] = 3.5
        event["Factions"][1]["Influence"] = "много"
        event["Factions"][2].pop("Influence")
        snapshot = factions_data.snapshot_from_event(event)
        by_name = {row["name"]: row["influence"] for row in snapshot["factions"]}
        self.assertEqual(by_name["Sol Nationalists"], 1.0)
        self.assertEqual(by_name["Sol Workers' Party"], 0.0)
        self.assertEqual(by_name["Mother Gaia"], 0.0)

    def test_site_payload_becomes_the_same_shape(self):
        snapshot = factions_data.snapshot_from_site(SITE_PAYLOAD)
        self.assertEqual(snapshot["system"], "Sol")
        self.assertEqual(snapshot["address"], "10477373803")
        self.assertEqual(snapshot["controlling"], "Sol Workers' Party")
        self.assertEqual(snapshot["source"], factions_data.SOURCE_SITE)
        self.assertEqual(snapshot["observed_at"], "2026-10-31T20:00:00+00:00")
        self.assertEqual([(row["name"], row["influence"]) for row in snapshot["factions"]],
                         [("Sol Workers' Party", 0.62), ("Mother Gaia", 0.31)])
        self.assertTrue(snapshot["factions"][0]["is_player"])
        self.assertEqual(snapshot["factions"][0]["active_states"], ["Boom"])

    def test_site_payload_without_system_is_ignored(self):
        for payload in ({}, {"system": None, "factions": []}, {"factions": [{"name": "X"}]},
                        "мусор", None):
            self.assertIsNone(factions_data.snapshot_from_site(payload))


class PreferSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.journal = factions_data.snapshot_from_event(SOL_EVENT)
        self.site = factions_data.snapshot_from_site(SITE_PAYLOAD)

    def test_newer_journal_wins(self):
        chosen = factions_data.prefer_snapshot(self.journal, self.site)
        self.assertEqual(chosen["source"], factions_data.SOURCE_JOURNAL)

    def test_newer_site_wins(self):
        self.journal["observed_at"] = "2026-10-30T10:00:00Z"
        chosen = factions_data.prefer_snapshot(self.journal, self.site)
        self.assertEqual(chosen["source"], factions_data.SOURCE_SITE)

    def test_equal_time_keeps_the_journal(self):
        self.journal["observed_at"] = "2026-10-31T20:00:00+00:00"
        chosen = factions_data.prefer_snapshot(self.journal, self.site)
        self.assertEqual(chosen["source"], factions_data.SOURCE_JOURNAL)

    def test_missing_side_or_time(self):
        self.assertIsNone(factions_data.prefer_snapshot(None, None))
        self.assertEqual(factions_data.prefer_snapshot(self.journal, None)["system"], "Sol")
        self.assertEqual(factions_data.prefer_snapshot(None, self.site)["system"], "Sol")
        self.journal["observed_at"] = ""
        chosen = factions_data.prefer_snapshot(self.journal, self.site)
        self.assertEqual(chosen["source"], factions_data.SOURCE_SITE, "без времени — старее")

    def test_snapshot_is_copied_not_shared(self):
        chosen = factions_data.prefer_snapshot(self.journal, self.site)
        chosen["system"] = "Lave"
        self.assertEqual(self.journal["system"], "Sol")


class JournalScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_finds_the_latest_event_by_address(self):
        older = dict(SOL_EVENT, timestamp="2026-10-30T10:00:00Z")
        write_journal(self.dir, "Journal.2026-10-30T100000.01.log", [older],
                      mtime=time.time() - 120)
        write_journal(self.dir, "Journal.2026-10-31T221403.02.log", [SOL_EVENT],
                      mtime=time.time())
        snapshot = factions_data.scan_journal_for_factions(self.dir, "Sol", 10477373803)
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["observed_at"], "2026-10-31T22:14:03Z")
        self.assertEqual(snapshot["source"], factions_data.SOURCE_JOURNAL_ARCHIVE)

    def test_last_event_in_a_file_wins(self):
        newer = dict(SOL_EVENT, timestamp="2026-10-31T23:00:00Z")
        write_journal(self.dir, "Journal.2026-10-31T221403.02.log", [SOL_EVENT, newer],
                      mtime=time.time())
        snapshot = factions_data.scan_journal_for_factions(self.dir, "", 10477373803)
        self.assertEqual(snapshot["observed_at"], "2026-10-31T23:00:00Z")

    def test_matches_by_name_when_the_address_is_unknown(self):
        write_journal(self.dir, "Journal.2026-10-31T221403.02.log", [SOL_EVENT],
                      mtime=time.time())
        snapshot = factions_data.scan_journal_for_factions(self.dir, "sol")
        self.assertEqual(snapshot["system"], "Sol")

    def test_other_systems_and_junk_lines_are_skipped(self):
        lave = dict(SOL_EVENT, StarSystem="Lave", SystemAddress=9001)
        path = write_journal(self.dir, "Journal.2026-10-31T221403.02.log", [lave],
                             mtime=time.time())
        with path.open("a", encoding="utf-8") as handle:
            handle.write("{битый json\n")
        self.assertIsNone(factions_data.scan_journal_for_factions(self.dir, "Sol", 10477373803))

    def test_missing_directory_and_empty_request_are_safe(self):
        self.assertIsNone(factions_data.scan_journal_for_factions(None, "Sol", 1))
        self.assertIsNone(factions_data.scan_journal_for_factions("/нет/такой/папки", "Sol", 1))
        write_journal(self.dir, "Journal.2026-10-31T221403.02.log", [SOL_EVENT],
                      mtime=time.time())
        self.assertIsNone(factions_data.scan_journal_for_factions(self.dir))

    def test_address_wins_over_a_renamed_system(self):
        renamed = dict(SOL_EVENT, StarSystem="Sol Prime")
        write_journal(self.dir, "Journal.2026-10-31T221403.02.log", [renamed],
                      mtime=time.time())
        self.assertEqual(
            factions_data.scan_journal_for_factions(self.dir, "Sol", 10477373803)["system"],
            "Sol Prime")
        self.assertIsNone(factions_data.scan_journal_for_factions(self.dir, "Sol", 4242))


class TimestampTests(unittest.TestCase):
    def test_journal_and_site_times_formatted(self):
        self.assertRegex(factions_data.format_timestamp("2026-10-31T22:14:03Z"),
                         r"^\d{2}\.\d{2}\.2026 \d{2}:\d{2}$")
        self.assertRegex(factions_data.format_timestamp("2026-10-31T22:14:03+00:00"),
                         r"^\d{2}\.\d{2}\.2026 \d{2}:\d{2}$")

    def test_bad_values_give_empty_text(self):
        for value in ("", None, "вчера", 42, "2026-13-45T99:99:99Z"):
            self.assertEqual(factions_data.format_timestamp(value), "")

    def test_system_key_prefers_the_address(self):
        self.assertEqual(factions_data.system_key("Sol", 10477373803), "10477373803")
        self.assertEqual(factions_data.system_key("Sol"), "sol")


class _Response:
    def __init__(self, status, body):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._body = body
        self.text = ""

    def json(self):
        return self._body


class SiteRequestTests(unittest.TestCase):
    def setUp(self):
        self.client = ApiClient(token="t", site_url="https://colony.test")
        self.client._session = mock.Mock()

    def test_address_goes_as_id64(self):
        self.client._session.get.return_value = _Response(200, SITE_PAYLOAD)
        result = self.client.get_system_factions(10477373803, "Sol")
        self.assertTrue(result["ok"])
        self.assertEqual(result["system"]["name"], "Sol")
        args, kwargs = self.client._session.get.call_args
        self.assertEqual(args[0], "https://colony.test/api/factions/system")
        self.assertEqual(kwargs["params"], {"id64": "10477373803"})

    def test_name_is_used_when_the_address_is_unknown(self):
        self.client._session.get.return_value = _Response(200, SITE_PAYLOAD)
        self.client.get_system_factions(0, "Sol")
        _args, kwargs = self.client._session.get.call_args
        self.assertEqual(kwargs["params"], {"name": "Sol"})

    def test_missing_system_is_not_a_network_error(self):
        self.client._session.get.return_value = _Response(
            404, {"error": "Системы нет в данных о фракциях"})
        result = self.client.get_system_factions(4242, "")
        self.assertFalse(result["ok"])
        self.assertTrue(result["missing"])

    def test_server_error_and_network_failure_are_reported(self):
        self.client._session.get.return_value = _Response(503, {"error": "Недоступно"})
        self.assertEqual(self.client.get_system_factions(1, "")["error"], "Недоступно")
        self.client._session.get.side_effect = OSError("нет сети")
        result = self.client.get_system_factions(1, "")
        self.assertFalse(result["ok"])
        self.assertIn("нет сети", result["error"])

    def test_empty_request_does_not_touch_the_network(self):
        result = self.client.get_system_factions(0, "")
        self.assertFalse(result["ok"])
        self.client._session.get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
