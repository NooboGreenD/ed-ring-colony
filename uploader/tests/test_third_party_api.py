"""Проверка отправки в EDSM, Inara и Raven Colonial (FC cargo).

Тесты pinned'ят конкретные причины, по которым данные не доходили:

* EDSM требует `fromSoftware`/`fromSoftwareVersion`/`fromGameVersion`/
  `fromGameBuild` и отвечает ошибкой в теле при HTTP 200 — `response.ok`
  недостаточно;
* Inara API живёт по адресу `/inapi/v1/`, иначе запросы уходят в никуда;
* ответ Inara тоже приходит с HTTP 200 даже при `eventStatus` 400;
* Raven Colonial требует имя товара в нижнем регистре (`steel`, не `Steel`);
* авианосец определяется по MarketID, а не только по «последней станции».
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


class _FakeResponse:
    def __init__(self, payload=None, ok=True, status=200, text=""):
        self._payload = payload
        self.ok = ok
        self.status_code = status
        self.text = text or ""

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class EDSMTests(unittest.TestCase):
    def setUp(self):
        from edsm_api import EDSMAPI

        self.api = EDSMAPI("key", "CMDR")
        self.api._session = mock.MagicMock()
        self.captured = {}

        def record(url, data=None, timeout=None):
            self.captured = {"url": url, "data": data}
            return _FakeResponse({"msgnum": 100, "msg": "OK"})

        self.api._session.post.side_effect = record

    def test_required_fields_are_sent(self):
        """fromSoftware/Version и fromGameVersion/Build — обязательные поля."""
        result = self.api.submit_event({"event": "FSDJump", "timestamp": "2025-01-01T00:00:00Z"})
        self.assertTrue(result["ok"])
        data = self.captured["data"]
        for field in ("commanderName", "apiKey", "fromSoftware", "fromSoftwareVersion",
                      "fromGameVersion", "fromGameBuild", "message"):
            self.assertIn(field, data, field)
        self.assertTrue(data["fromSoftware"])
        self.assertTrue(data["fromGameVersion"])
        self.assertTrue(data["fromGameBuild"])

    def test_url_is_journal_endpoint(self):
        self.api.submit_event({"event": "Scan"})
        self.assertEqual(self.captured["url"], "https://www.edsm.net/api-journal-v1")

    def test_http_200_with_error_msgnum_is_a_failure(self):
        """EDSM отвечает 200 и при ошибке: статус живёт в msgnum."""
        self.api._session.post.side_effect = None
        self.api._session.post.return_value = _FakeResponse(
            {"msgnum": 207, "msg": "Game version not found"})
        result = self.api.submit_event({"event": "Scan"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["msgnum"], 207)
        self.assertIn("207", result["error"])

        # 204 — не указаны имя/версия софта (ровно то, что было раньше)
        self.api._session.post.return_value = _FakeResponse(
            {"msgnum": 204, "msg": "Software version not found"})
        self.assertFalse(self.api.submit_event({"event": "Scan"})["ok"])

    def test_accepted_msgnums(self):
        self.api._session.post.side_effect = None
        for msgnum in (100, 101, 102, 103, 104):
            self.api._session.post.return_value = _FakeResponse({"msgnum": msgnum, "msg": ""})
            self.assertTrue(
                self.api.submit_event({"event": "Scan"})["ok"],
                f"msgnum {msgnum} должен считаться принятым",
            )

    def test_game_version_from_journal_is_used(self):
        self.api.set_game_version("4.1.2.100", "r312345/r0")
        self.api.submit_event({"event": "Scan"})
        data = self.captured["data"]
        self.assertEqual(data["fromGameVersion"], "4.1.2.100")
        self.assertEqual(data["fromGameBuild"], "r312345/r0")

    def test_network_failure_is_not_raised(self):
        self.api._session.post.side_effect = RuntimeError("no route")
        result = self.api.submit_event({"event": "Scan"})
        self.assertFalse(result["ok"])
        self.assertIn("no route", result["error"])


class InaraTests(unittest.TestCase):
    def setUp(self):
        from inara_api import InaraAPI

        self.api = InaraAPI("key", "CMDR", app_version="2.2.0")
        self.api._session = mock.MagicMock()
        self.captured = {}

        def record(url, json=None, timeout=None):
            self.captured = {"url": url, "json": json}
            return _FakeResponse({"header": {"eventStatus": 200},
                                  "events": [{"eventStatus": 200}]})

        self.api._session.post.side_effect = record

    def test_endpoint_is_inapi_v1(self):
        """Раньше запросы уходили на несуществующий inara-api.php."""
        self.api.submit("addCommanderTravelDock", {"starsystemName": "Sol"}, "2025-01-01T00:00:00Z")
        self.assertEqual(self.captured["url"], "https://inara.cz/inapi/v1/")

    def test_header_shape(self):
        self.api.submit("addCommanderTravelDock", {"starsystemName": "Sol"}, "2025-01-01T00:00:00Z")
        header = self.captured["json"]["header"]
        self.assertEqual(header["appVersion"], "2.2.0")
        self.assertTrue(header["isBeingDeveloped"])
        self.assertEqual(header["APIkey"], "key")
        self.assertEqual(header["commanderName"], "CMDR")
        event = self.captured["json"]["events"][0]
        self.assertEqual(event["eventName"], "addCommanderTravelDock")
        self.assertEqual(event["eventTimestamp"], "2025-01-01T00:00:00Z")
        self.assertEqual(event["eventData"], {"starsystemName": "Sol"})

    def test_http_200_with_event_status_400_is_a_failure(self):
        self.api._session.post.side_effect = None
        self.api._session.post.return_value = _FakeResponse({
            "header": {"eventStatus": 200},
            "events": [{"eventStatus": 400,
                        "eventStatusText": "Missing required property: starsystemName"}],
        })
        result = self.api.submit("addCommanderTravelDock", {}, "2025-01-01T00:00:00Z")
        self.assertFalse(result["ok"])
        self.assertEqual(result["event_status"], 400)
        self.assertIn("starsystemName", result["error"])

    def test_header_auth_failure_is_a_failure(self):
        self.api._session.post.side_effect = None
        self.api._session.post.return_value = _FakeResponse({
            "header": {"eventStatus": 400, "eventStatusText": "Invalid API key"},
            "events": [],
        })
        result = self.api.submit("addCommanderTravelDock", {"starsystemName": "Sol"})
        self.assertFalse(result["ok"])
        self.assertIn("Invalid API key", result["error"])

    def test_soft_statuses_are_ok(self):
        self.api._session.post.side_effect = None
        for status in (200, 202, 204):
            self.api._session.post.return_value = _FakeResponse({
                "header": {"eventStatus": 200},
                "events": [{"eventStatus": status}],
            })
            self.assertTrue(self.api.submit("x", {})["ok"], status)

    def test_network_failure_is_not_raised(self):
        self.api._session.post.side_effect = RuntimeError("timeout")
        result = self.api.submit("x", {})
        self.assertFalse(result["ok"])
        self.assertIn("timeout", result["error"])


class FleetCarrierDetectionTests(unittest.TestCase):
    """Почему не уходил прогресс погрузки авианосца."""

    def test_carrier_market_id_is_detected_without_docked_event(self):
        """Программа запущена, когда командир уже стоит на FC: Docked не видно."""
        from event_dispatch import is_fleet_carrier

        # MarketID авианосца попадает в диапазон 3.7e9 … 3.8e9
        self.assertTrue(is_fleet_carrier({"MarketID": 3700005632}, station_type=""))
        # Обычная станция — нет
        self.assertFalse(is_fleet_carrier({"MarketID": 128666762}, station_type="Coriolis"))

    def test_carrier_id_and_station_type_still_work(self):
        from event_dispatch import is_fleet_carrier

        self.assertTrue(is_fleet_carrier({"CarrierID": 3700005632, "MarketID": 0}, station_type=""))
        self.assertTrue(is_fleet_carrier({"MarketID": 123}, station_type="FleetCarrier"))
        self.assertFalse(is_fleet_carrier({"MarketID": 123}, station_type="Coriolis Starport"))

    def test_commodity_is_normalized_for_raven(self):
        """Raven принимает `steel`, но не `Steel` и не `$steel_name;`."""
        from event_dispatch import normalize_commodity

        self.assertEqual(normalize_commodity("$steel_name;"), "steel")
        self.assertEqual(normalize_commodity("Steel"), "steel")
        self.assertEqual(normalize_commodity("steel"), "steel")
        self.assertEqual(normalize_commodity("LIQUIDOXYGEN"), "liquidoxygen")
        self.assertEqual(normalize_commodity(None), "")

    def test_cargo_delta_uses_fdname_and_market_id(self):
        """Полный путь: MarketSell на FC без события Docked уходит в Raven."""
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeRaven:
            is_connected = True

            def supply_fc(self, market_id, commodity, delta):
                sent.append((market_id, commodity, delta))
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(raven_api=FakeRaven())
        dispatcher.submit({
            "event": "MarketSell",
            "timestamp": "2025-01-01T00:00:00Z",
            "MarketID": 3700005632,          # авианосец
            "Type": "$steel_name;",
            "Type_Localised": "Steel",
            "Count": 700,
        }, live=True, station_type="")       # тип станции неизвестен
        dispatcher.flush(timeout=2)
        self.assertEqual(sent, [(3700005632, "steel", 700)])

    def test_buy_from_carrier_removes_cargo(self):
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeRaven:
            is_connected = True

            def supply_fc(self, market_id, commodity, delta):
                sent.append((market_id, commodity, delta))
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(raven_api=FakeRaven())
        dispatcher.submit({
            "event": "MarketBuy", "timestamp": "2025-01-01T00:00:01Z",
            "MarketID": 3700005632, "Type": "steel", "Count": 120,
        }, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(sent, [(3700005632, "steel", -120)])

    def test_regular_station_is_not_sent_to_raven(self):
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeRaven:
            is_connected = True

            def supply_fc(self, market_id, commodity, delta):
                sent.append((market_id, commodity, delta))
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(raven_api=FakeRaven())
        dispatcher.submit({
            "event": "MarketSell", "timestamp": "2025-01-01T00:00:02Z",
            "MarketID": 128666762, "Type": "steel", "Count": 10,
        }, live=True, station_type="Coriolis")
        dispatcher.flush(timeout=2)
        self.assertEqual(sent, [])


class CargoTransferTests(unittest.TestCase):
    """Погрузка авианосца через экран Transfer (CargoTransfer)."""

    def _dispatcher_with_raven(self):
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeRaven:
            is_connected = True

            def supply_fc(self, market_id, commodity, delta):
                sent.append((market_id, commodity, delta))
                return {"ok": True}

        return ThirdPartyDispatcher(raven_api=FakeRaven()), sent

    def test_transfer_to_carrier_adds_cargo(self):
        dispatcher, sent = self._dispatcher_with_raven()
        dispatcher.submit({"event": "Docked", "timestamp": "2025-01-01T00:00:00Z",
                           "StarSystem": "Sol", "StationName": "FC Test",
                           "MarketID": 3700005632, "StationType": "FleetCarrier"}, live=True)
        dispatcher.submit({
            "event": "CargoTransfer", "timestamp": "2025-01-01T00:00:01Z",
            "Transfers": [{"Type": "steel", "Count": 700, "Direction": "tocarrier"}],
        }, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(sent, [(3700005632, "steel", 700)])

    def test_transfer_to_ship_removes_cargo(self):
        dispatcher, sent = self._dispatcher_with_raven()
        dispatcher.submit({"event": "Docked", "timestamp": "2025-01-01T00:00:00Z",
                           "StarSystem": "Sol", "MarketID": 3700005632,
                           "StationType": "FleetCarrier"}, live=True)
        dispatcher.submit({
            "event": "CargoTransfer", "timestamp": "2025-01-01T00:00:02Z",
            "Transfers": [{"Type": "steel", "Count": 100, "Direction": "toship"}],
        }, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(sent, [(3700005632, "steel", -100)])

    def test_multiple_transfers_are_sent_separately(self):
        dispatcher, sent = self._dispatcher_with_raven()
        dispatcher.submit({"event": "Docked", "timestamp": "2025-01-01T00:00:00Z",
                           "StarSystem": "Sol", "MarketID": 3700005632,
                           "StationType": "FleetCarrier"}, live=True)
        dispatcher.submit({
            "event": "CargoTransfer", "timestamp": "2025-01-01T00:00:03Z",
            "Transfers": [
                {"Type": "steel", "Count": 10, "Direction": "tocarrier"},
                {"Type": "$titanium_name;", "Count": 5, "Direction": "tocarrier"},
                {"Type": "gold", "Count": 3, "Direction": "tosrv"},   # не авианосец
            ],
        }, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(sent, [(3700005632, "steel", 10), (3700005632, "titanium", 5)])

    def test_transfer_at_regular_station_is_ignored(self):
        dispatcher, sent = self._dispatcher_with_raven()
        dispatcher.submit({"event": "Docked", "timestamp": "2025-01-01T00:00:00Z",
                           "StarSystem": "Sol", "MarketID": 128666762,
                           "StationType": "Coriolis"}, live=True)
        dispatcher.submit({
            "event": "CargoTransfer", "timestamp": "2025-01-01T00:00:04Z",
            "Transfers": [{"Type": "steel", "Count": 10, "Direction": "tocarrier"}],
        }, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(sent, [])


class EdsmTransientStateTests(unittest.TestCase):
    def test_location_is_attached_to_later_events(self):
        """EDSM просит докладывать систему/станцию для одиночных событий."""
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeEDSM:
            enabled = True

            def submit_event(self, event):
                sent.append(event)
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(edsm_api=FakeEDSM())
        dispatcher.submit({"event": "Location", "timestamp": "2025-01-01T00:00:00Z",
                           "StarSystem": "Sol", "SystemAddress": 10477373803,
                           "StarPos": [0, 0, 0], "StationName": "Jameson", "MarketID": 42},
                          live=True)
        dispatcher.submit({"event": "Scan", "timestamp": "2025-01-01T00:00:01Z",
                           "BodyName": "Sol 1"}, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(len(sent), 2)
        scan = sent[1]
        self.assertEqual(scan["_systemName"], "Sol")
        self.assertEqual(scan["_systemAddress"], 10477373803)
        self.assertEqual(scan["_stationName"], "Jameson")
        self.assertEqual(scan["_marketId"], 42)

    def test_undocked_clears_station(self):
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeEDSM:
            enabled = True

            def submit_event(self, event):
                sent.append(event)
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(edsm_api=FakeEDSM())
        dispatcher.submit({"event": "Docked", "timestamp": "2025-01-01T00:00:00Z",
                           "StarSystem": "Sol", "StationName": "Jameson", "MarketID": 42},
                          live=True)
        dispatcher.submit({"event": "Undocked", "timestamp": "2025-01-01T00:00:01Z",
                           "StarSystem": "Sol", "MarketID": 42}, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(len(sent), 2)   # Undocked теперь тоже уходит в EDSM
        self.assertIsNone(sent[1]["_stationName"])

    def test_game_version_is_captured_from_loadgame(self):
        from event_dispatch import ThirdPartyDispatcher

        class FakeEDSM:
            enabled = True

            def __init__(self):
                self.game_version = None
                self.game_build = None

            def set_game_version(self, version, build):
                self.game_version, self.game_build = version, build

            def submit_event(self, event):
                return {"ok": True}

        edsm = FakeEDSM()
        dispatcher = ThirdPartyDispatcher(edsm_api=edsm)
        dispatcher.submit({"event": "LoadGame", "timestamp": "2025-01-01T00:00:00Z",
                           "GameVersion": "4.1.2.100", "Build": "r312345/r0"}, live=True)
        self.assertEqual(edsm.game_version, "4.1.2.100")
        self.assertEqual(edsm.game_build, "r312345/r0")

    def test_dedup_sets_are_bounded(self):
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeEDSM:
            enabled = True

            def submit_event(self, event):
                sent.append(event)
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(edsm_api=FakeEDSM())
        dispatcher.max_seen = 100
        for index in range(500):
            dispatcher.submit({"event": "Scan", "timestamp": f"2025-01-01T00:00:{index:02d}Z",
                               "BodyName": f"Sol {index}"}, live=True)
        self.assertLessEqual(len(dispatcher._seen["edsm"]), dispatcher.max_seen)


if __name__ == "__main__":
    unittest.main()
