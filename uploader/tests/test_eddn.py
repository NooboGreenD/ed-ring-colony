"""EDDN: сообщения схемы journal/1 и отправка (uploader/eddn_api.py, event_dispatch.py).

Запуск (нужны requests и стандартная библиотека):
    python -m unittest discover -s uploader/tests -v

Проверка по настоящей схеме EDDN (необязательная): указать папку с
`schemas/journal-v1.0.json` из клона github.com/EDCD/EDDN и установить jsonschema:
    EDDN_SCHEMA_DIR=/path/to/EDDN/schemas python -m unittest tests.test_eddn -v
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import requests  # noqa: E402

from eddn_api import (  # noqa: E402
    EDDN_EVENTS,
    EDDN_LIVE_URL,
    JOURNAL_SCHEMA_REF,
    SOFTWARE_NAME,
    EddnClient,
    EddnContext,
    augment_location,
    clean_message,
)
from event_dispatch import ThirdPartyDispatcher  # noqa: E402

LOAD_GAME = {
    "timestamp": "2026-10-01T10:00:00Z", "event": "LoadGame", "FID": "F1",
    "Commander": "Test CMDR", "Horizons": True, "Odyssey": True,
    "gameversion": "4.0.0.1450", "build": "r290000/r0",
}
LOCATION = {
    "timestamp": "2026-10-01T10:01:00Z", "event": "Location",
    "StarSystem": "Delta Velorum", "SystemAddress": 2000000001, "StarPos": [12.5, -3.25, 40.0],
    "Body": "Delta Velorum A", "BodyID": 1, "Docked": False,
    "Wanted": True, "Latitude": 1.0, "Longitude": 2.0,
    "Factions": [{
        "Name": "Pilots", "Name_Localised": "Пилоты", "MyReputation": 12.0, "HomeSystem": True,
        "Government": "$government_Democracy;", "Government_Localised": "Демократия",
    }],
}
DOCKED = {
    "timestamp": "2026-10-01T10:02:00Z", "event": "Docked", "StationName": "Alpha Port",
    "StationType": "Outpost", "StarSystem": "Delta Velorum", "SystemAddress": 2000000001,
    "MarketID": 3951663874, "ActiveFine": 100, "CockpitBreach": False, "Wanted": False,
    "StationEconomies": [{"Name": "$economy_Industrial;", "Name_Localised": "Industrial", "Proportion": 1.0}],
}
SCAN = {
    "timestamp": "2026-10-01T10:03:00Z", "event": "Scan", "BodyName": "Delta Velorum A 1",
    "BodyID": 3, "SystemAddress": 2000000001, "ScanType": "Detailed",
    "DistanceFromArrivalLS": 100.0,
    "Materials": [{"Name": "iron", "Name_Localised": "Iron", "Percent": 10.0}],
}
FSD_JUMP = {
    "timestamp": "2026-10-01T10:04:00Z", "event": "FSDJump", "StarSystem": "Sol",
    "SystemAddress": 10477373803, "StarPos": [0.0, 0.0, 0.0], "JumpDist": 5.0,
    "FuelUsed": 1.0, "FuelLevel": 20.0, "BoostUsed": 0,
}
CARGO_DEPOT = {"timestamp": "2026-10-01T10:05:00Z", "event": "CargoDepot", "MarketID": 1}


def _context(*events) -> EddnContext:
    context = EddnContext()
    for event in events:
        context.observe(event)
    return context


def _build(context: EddnContext, event: dict):
    return context.build(event, software_version="2.13.2")


def _walk_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _walk_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_keys(item)


class SupportedEventsTests(unittest.TestCase):
    def test_supported_events_are_the_journal_schema_list_without_codexentry(self):
        # enum схемы journal/1 минус CodexEntry (у него своя схема codexentry/1).
        self.assertEqual(EDDN_EVENTS, frozenset({
            "Docked", "FSDJump", "Scan", "Location", "SAASignalsFound", "CarrierJump",
        }))

    def test_colonisation_and_cargo_events_never_leave_the_uploader(self):
        context = _context(LOAD_GAME, LOCATION)
        for name in ("ColonisationConstructionDepot", "ColonisationContribution", "CargoDepot",
                     "MarketSell", "MarketBuy", "CodexEntry", "Loadout"):
            with self.subTest(event=name):
                self.assertIsNone(_build(context, {"timestamp": "2026-10-01T10:06:00Z", "event": name,
                                                   "StarSystem": "Delta Velorum",
                                                   "SystemAddress": 2000000001}))


class MessageShapeTests(unittest.TestCase):
    def test_message_is_wrapped_for_the_live_journal_schema(self):
        message = _build(_context(LOAD_GAME, LOCATION), DOCKED)
        self.assertEqual(message["$schemaRef"], JOURNAL_SCHEMA_REF)
        self.assertFalse(message["$schemaRef"].endswith("/test"), "тестовая схема в боевой отправке")
        self.assertEqual(message["header"], {
            "uploaderID": "Test CMDR",
            "softwareName": SOFTWARE_NAME,
            "softwareVersion": "2.13.2",
            "gameversion": "4.0.0.1450",
            "gamebuild": "r290000/r0",
        })
        self.assertEqual(message["message"]["event"], "Docked")

    def test_personal_and_localised_fields_are_removed_at_every_depth(self):
        message = _build(_context(LOAD_GAME, LOCATION), LOCATION)["message"]
        for key in ("Wanted", "Latitude", "Longitude"):
            self.assertNotIn(key, message)
        keys = list(_walk_keys(message))
        self.assertFalse([key for key in keys if key.endswith("_Localised")], "остались *_Localised")

    def test_faction_personal_fields_are_removed(self):
        message = _build(_context(LOAD_GAME, LOCATION), LOCATION)["message"]
        faction = message["Factions"][0]
        self.assertEqual(faction["Name"], "Pilots")
        self.assertEqual(faction["Government"], "$government_Democracy;")
        for key in ("MyReputation", "HomeSystem", "HappiestSystem", "SquadronFaction"):
            self.assertNotIn(key, faction)

    def test_docked_disallowed_fields_are_removed(self):
        message = _build(_context(LOAD_GAME, LOCATION), DOCKED)["message"]
        for key in ("ActiveFine", "CockpitBreach", "Wanted"):
            self.assertNotIn(key, message)
        self.assertEqual(message["StationEconomies"], [{"Name": "$economy_Industrial;", "Proportion": 1.0}])

    def test_clean_message_keeps_the_fields_the_schema_needs(self):
        cleaned = clean_message(FSD_JUMP)
        self.assertEqual(cleaned["StarSystem"], "Sol")
        self.assertEqual(cleaned["StarPos"], [0.0, 0.0, 0.0])
        for key in ("JumpDist", "FuelUsed", "FuelLevel", "BoostUsed"):
            self.assertNotIn(key, cleaned)

    def test_horizons_and_odyssey_are_sent_only_when_known(self):
        known = _build(_context(LOAD_GAME, LOCATION), DOCKED)["message"]
        self.assertTrue(known["horizons"])
        self.assertTrue(known["odyssey"])

        legacy_load = {k: v for k, v in LOAD_GAME.items() if k not in ("Horizons", "Odyssey")}
        unknown = _build(_context(legacy_load, LOCATION), DOCKED)["message"]
        self.assertNotIn("horizons", unknown, "флаг выдуман, а не взят из LoadGame")
        self.assertNotIn("odyssey", unknown)

    def test_fileheader_version_wins_over_loadgame(self):
        context = _context({"event": "Fileheader", "gameversion": "4.0.0.1500", "build": "r300000/r0"},
                           LOAD_GAME, LOCATION)
        self.assertEqual(context.game_version, "4.0.0.1500")
        self.assertEqual(context.game_build, "r300000/r0")


class AugmentationTests(unittest.TestCase):
    def test_docked_gets_star_pos_from_the_last_location_when_system_matches(self):
        message = _build(_context(LOAD_GAME, LOCATION), DOCKED)["message"]
        self.assertEqual(message["StarPos"], [12.5, -3.25, 40.0])
        self.assertEqual(message["SystemAddress"], 2000000001)

    def test_scan_without_system_takes_the_name_from_a_matching_address(self):
        message = _build(_context(LOAD_GAME, LOCATION), SCAN)["message"]
        self.assertEqual(message["StarSystem"], "Delta Velorum")
        self.assertEqual(message["StarPos"], [12.5, -3.25, 40.0])

    def test_mismatched_system_address_is_not_sent(self):
        docked = dict(DOCKED, SystemAddress=999)
        self.assertIsNone(_build(_context(LOAD_GAME, LOCATION), docked))

    def test_mismatched_system_name_is_not_sent(self):
        docked = dict(DOCKED, StarSystem="Sol")
        self.assertIsNone(_build(_context(LOAD_GAME, LOCATION), docked))

    def test_event_without_any_identifier_is_not_sent(self):
        scan = {k: v for k, v in SCAN.items() if k != "SystemAddress"}
        self.assertIsNone(_build(_context(LOAD_GAME, LOCATION), scan))

    def test_without_a_known_location_nothing_is_filled_in(self):
        self.assertIsNone(_build(_context(LOAD_GAME), DOCKED))

    def test_an_incomplete_location_event_resets_the_known_location(self):
        partial = {"timestamp": "2026-10-01T10:01:30Z", "event": "FSDJump", "StarSystem": "Delta Velorum"}
        self.assertIsNone(_build(_context(LOAD_GAME, LOCATION, partial), DOCKED))

    def test_augment_location_reports_what_it_could_not_verify(self):
        location = {"StarSystem": "A", "SystemAddress": 1, "StarPos": [1.0, 2.0, 3.0]}
        message = {"timestamp": "t", "event": "Scan"}
        self.assertFalse(augment_location(message, location), "без имени и адреса сверять нечем")
        self.assertFalse(augment_location({"SystemAddress": 2}, location))


class LiveGateTests(unittest.TestCase):
    def test_beta_or_alpha_clients_are_not_sent(self):
        for version in ("4.0.0.1450-beta", "4.0.0.1450 Alpha"):
            with self.subTest(version=version):
                load = dict(LOAD_GAME, gameversion=version)
                self.assertIsNone(_build(_context(load, LOCATION), DOCKED))

    def test_unknown_game_version_is_not_sent(self):
        load = {k: v for k, v in LOAD_GAME.items() if k not in ("gameversion", "build")}
        self.assertIsNone(_build(_context(load, LOCATION), DOCKED))

    def test_unknown_commander_is_not_sent(self):
        load = {k: v for k, v in LOAD_GAME.items() if k != "Commander"}
        self.assertIsNone(_build(_context(load, LOCATION), DOCKED))


class ClientTests(unittest.TestCase):
    class _Response:
        def __init__(self, status=200, text=""):
            self.status_code = status
            self.text = text

    def test_posts_json_to_the_live_endpoint(self):
        client = EddnClient(enabled=True, app_version="2.13.2")
        message = _build(_context(LOAD_GAME, LOCATION), DOCKED)
        with mock.patch.object(client._session, "post", return_value=self._Response(200)) as post:
            result = client.submit(message)
        self.assertEqual(result, {"ok": True, "status": 200})
        url = post.call_args.args[0] if post.call_args.args else post.call_args.kwargs["url"]
        self.assertEqual(url, EDDN_LIVE_URL)
        self.assertEqual(post.call_args.kwargs["headers"], {"Content-Type": "application/json"})
        self.assertEqual(json.loads(post.call_args.kwargs["data"].decode("utf-8")), message)

    def test_disabled_client_sends_nothing(self):
        client = EddnClient(enabled=False)
        with mock.patch.object(client._session, "post") as post:
            self.assertFalse(client.submit({"x": 1})["ok"])
        post.assert_not_called()

    def test_bad_request_is_reported_and_not_retried(self):
        client = EddnClient(enabled=True)
        with mock.patch.object(client._session, "post", return_value=self._Response(400, "bad schema")) as post:
            result = client.submit({"x": 1})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], 400)
        self.assertIn("bad schema", result["error"])
        self.assertEqual(post.call_count, 1, "400 повторено — правила EDDN это запрещают")

    def test_connection_error_is_reported(self):
        client = EddnClient(enabled=True)
        with mock.patch.object(client._session, "post", side_effect=requests.ConnectionError("no route")):
            result = client.submit({"x": 1})
        self.assertFalse(result["ok"])
        self.assertIn("недоступен", result["error"])


class _FakeEddn:
    def __init__(self, enabled=True):
        self.enabled = enabled
        self.software_version = "2.13.2"
        self.sent = []

    def submit(self, message):
        self.sent.append(message)
        return {"ok": True}


class DispatcherTests(unittest.TestCase):
    def test_only_supported_live_events_are_published(self):
        fake = _FakeEddn()
        dispatcher = ThirdPartyDispatcher(eddn_api=fake, workers=1)
        for event in (LOAD_GAME, LOCATION, DOCKED, SCAN, CARGO_DEPOT):
            dispatcher.submit(event, live=True)
        self.assertTrue(dispatcher.flush(timeout=5))
        self.assertEqual([m["message"]["event"] for m in fake.sent], ["Location", "Docked", "Scan"])

    def test_nothing_is_published_while_disabled(self):
        fake = _FakeEddn(enabled=False)
        dispatcher = ThirdPartyDispatcher(eddn_api=fake, workers=1)
        dispatcher.submit(LOAD_GAME, live=True)
        dispatcher.submit(LOCATION, live=True)
        self.assertTrue(dispatcher.flush(timeout=5))
        self.assertEqual(fake.sent, [])

    def test_history_is_not_published_by_default(self):
        fake = _FakeEddn()
        dispatcher = ThirdPartyDispatcher(eddn_api=fake, workers=1)
        dispatcher.submit(LOAD_GAME, live=False)
        dispatcher.submit(LOCATION, live=False)
        dispatcher.submit(DOCKED, live=False)
        self.assertTrue(dispatcher.flush(timeout=5))
        self.assertEqual(fake.sent, [])

    def test_history_still_feeds_the_location_context(self):
        # Журнал, прочитанный из истории, всё равно даёт локацию для живых событий.
        fake = _FakeEddn()
        dispatcher = ThirdPartyDispatcher(eddn_api=fake, workers=1)
        dispatcher.submit(LOAD_GAME, live=False)
        dispatcher.submit(LOCATION, live=False)
        dispatcher.submit(DOCKED, live=True)
        self.assertTrue(dispatcher.flush(timeout=5))
        self.assertEqual([m["message"]["event"] for m in fake.sent], ["Docked"])

    def test_unbuildable_event_is_counted_not_sent(self):
        fake = _FakeEddn()
        dispatcher = ThirdPartyDispatcher(eddn_api=fake, workers=1)
        dispatcher.submit(LOAD_GAME, live=True)
        dispatcher.submit(DOCKED, live=True)  # локации ещё нет — сверять не с чем
        self.assertTrue(dispatcher.flush(timeout=5))
        self.assertEqual(fake.sent, [])
        self.assertEqual(dispatcher.stats["eddn_skipped"], 1)


@unittest.skipUnless(os.environ.get("EDDN_SCHEMA_DIR"), "нужна папка schemas из клона EDDN")
class RealSchemaTests(unittest.TestCase):
    def test_built_messages_pass_the_published_journal_schema(self):
        import jsonschema

        schema_dir = Path(os.environ["EDDN_SCHEMA_DIR"])
        schema = json.loads((schema_dir / "journal-v1.0.json").read_text(encoding="utf-8"))
        enum = set(schema["properties"]["message"]["properties"]["event"]["enum"])
        self.assertTrue(EDDN_EVENTS <= enum, "в схеме нет события, которое мы шлём")

        validator = jsonschema.Draft4Validator(schema)
        context = _context(LOAD_GAME)
        built = []
        # Location строит сообщение из своих данных; Docked и Scan берут локацию из
        # предыдущего Location (та же логика, что в живом диспетчере); FSDJump — свой.
        built.append(("Location", _build(context, LOCATION)))
        context.observe(LOCATION)
        built.append(("Docked", _build(context, DOCKED)))
        built.append(("Scan", _build(context, SCAN)))
        built.append(("FSDJump", _build(context, FSD_JUMP)))
        for name, message in built:
            with self.subTest(event=name):
                self.assertIsNotNone(message, name)
                validator.validate(message)


if __name__ == "__main__":
    unittest.main()
