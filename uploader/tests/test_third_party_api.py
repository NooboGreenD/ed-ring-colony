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
        self.api.RETRY_DELAY = 0     # тест не должен спать между попытками
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


CLOUDFLARE_HTML = (
    "<!DOCTYPE html>\n"
    '<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n'
    '<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->\n'
    "<head><title>edsm.net | 503: Service temporarily unavailable</title></head>"
)


class CloudflareHtmlResponseTests(unittest.TestCase):
    """Ответ-заглушка Cloudflare: короткое сообщение в лог, а не разметка.

    Жалоба: в логах появлялось
    «EDSM: <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6…».
    Это страница Cloudflare вместо JSON: EDSM был недоступен или отклонял
    клиента. Теперь такой ответ классифицируется и повторяется.
    """

    def _api(self, response):
        from edsm_api import EDSMAPI

        api = EDSMAPI("key", "CMDR")
        api._session = mock.MagicMock()
        api._session.post.return_value = response
        api.RETRY_DELAY = 0          # тест не должен спать между попытками
        return api

    def test_html_answer_is_classified_not_dumped(self):
        api = self._api(_FakeResponse(None, ok=False, status=503, text=CLOUDFLARE_HTML))
        result = api.submit_event({"event": "FSDJump"})
        self.assertFalse(result["ok"])
        self.assertTrue(result["retryable"])
        self.assertEqual(result["status"], 503)
        self.assertNotIn("<!DOCTYPE", result["error"])
        self.assertNotIn("<!--[if", result["error"])
        self.assertIn("HTML", result["error"])
        self.assertLess(len(result["error"]), 200)

    def test_html_answer_is_retried(self):
        """Число повторов фиксируем числом, а не константой самого клиента."""
        api = self._api(_FakeResponse(None, ok=False, status=503, text=CLOUDFLARE_HTML))
        result = api.submit_event({"event": "FSDJump"})
        self.assertEqual(api._session.post.call_count, 3)
        self.assertEqual(result["attempts"], 3)
        self.assertGreater(api.MAX_ATTEMPTS, 1)

    def test_permanent_failure_is_not_retried(self):
        """Отклонённое событие (msgnum >= 200) повторять бессмысленно."""
        api = self._api(_FakeResponse({"msgnum": 204, "msg": "Software not found"}))
        result = api.submit_event({"event": "FSDJump"})
        self.assertFalse(result["ok"])
        self.assertEqual(api._session.post.call_count, 1)
        self.assertIn("204", result["error"])

    def test_recovery_after_transient_failure(self):
        api = self._api(_FakeResponse(None, ok=False, status=503, text=CLOUDFLARE_HTML))
        api._session.post.side_effect = [
            _FakeResponse(None, ok=False, status=503, text=CLOUDFLARE_HTML),
            _FakeResponse({"msgnum": 100, "msg": "OK"}),
        ]
        result = api.submit_event({"event": "FSDJump"})
        self.assertTrue(result["ok"], result)
        self.assertEqual(api._session.post.call_count, 2)

    def test_user_agent_is_set(self):
        """Cloudflare отклоняет дефолтный python-requests — UA обязателен."""
        import requests

        from edsm_api import EDSMAPI
        from inara_api import InaraAPI

        for api in (EDSMAPI("key", "CMDR", app_version="2.5.1"),
                    InaraAPI("key", "CMDR", app_version="2.5.1")):
            self.assertIsInstance(api._session, requests.Session)
            agent = api._session.headers.get("User-Agent", "")
            self.assertIn("2.5.1", agent)
            self.assertNotIn("python-requests", agent)
            self.assertEqual(api._session.headers.get("Accept"), "application/json")

    def test_inara_html_answer_is_classified(self):
        from inara_api import InaraAPI

        api = InaraAPI("key", "CMDR")
        api._session = mock.MagicMock()
        api.RETRY_DELAY = 0
        api._session.post.return_value = _FakeResponse(
            None, ok=False, status=503, text=CLOUDFLARE_HTML)
        result = api.submit("addCommanderTravelFSDJump", {"starsystemName": "Kuma"})
        self.assertFalse(result["ok"])
        self.assertTrue(result["retryable"])
        self.assertNotIn("<!DOCTYPE", result["error"])
        self.assertIn("Inara", result["error"])
        # Inara за тем же Cloudflare, что и EDSM: событие повторяется.
        self.assertEqual(api._session.post.call_count, 3)
        self.assertEqual(result["attempts"], 3)

    def test_connection_error_is_retryable(self):
        import requests

        api = self._api(None)
        api._session.post.side_effect = requests.Timeout("read timed out")
        result = api.submit_event({"event": "FSDJump"})
        self.assertFalse(result["ok"])
        self.assertTrue(result["retryable"])
        self.assertIn("нет соединения", result["error"])
        self.assertNotIn("<", result["error"])


class HttpResponseClassifierTests(unittest.TestCase):
    """Чистые функции разбора плохих ответов."""

    def test_looks_like_html(self):
        from http_errors import looks_like_html

        self.assertTrue(looks_like_html(CLOUDFLARE_HTML))
        self.assertTrue(looks_like_html("<html><body>oops</body></html>"))
        self.assertFalse(looks_like_html('{"msgnum": 100}'))
        self.assertFalse(looks_like_html(""))
        self.assertFalse(looks_like_html(None))

    def test_describe_statuses(self):
        from http_errors import describe_bad_response

        cases = {
            401: "доступ запрещён",
            403: "доступ запрещён",
            404: "не найден",
            429: "слишком много запросов",
            500: "ошибка сервера",
            503: "ошибка сервера",
        }
        for status, needle in cases.items():
            described = describe_bad_response(
                "EDSM", _FakeResponse(None, ok=False, status=status, text=""))
            self.assertIn(needle, described["error"], status)
            self.assertTrue(described["retryable"] or status in (401, 403, 404))

    def test_short_body_hides_html(self):
        from http_errors import short_body

        self.assertEqual(short_body(_FakeResponse(text=CLOUDFLARE_HTML)), "HTML-страница")
        self.assertEqual(short_body(_FakeResponse(text="обычная ошибка")), "обычная ошибка")


class DispatcherFailureThrottleTests(unittest.TestCase):
    """Одна недоступность сервиса — не тысячи строк в логе."""

    def _dispatcher(self):
        from event_dispatch import ThirdPartyDispatcher

        dispatcher = ThirdPartyDispatcher()
        messages = []
        dispatcher.on_result = lambda service, ok, message: messages.append((ok, message))
        return dispatcher, messages

    def test_first_failure_is_logged_then_throttled(self):
        dispatcher, messages = self._dispatcher()
        for _ in range(10):
            dispatcher._notify_failure("edsm", "EDSM: ошибка сервера (HTTP 503)")
        self.assertEqual(len(messages), 1, messages)
        self.assertFalse(messages[0][0])

    def test_reminder_every_n_failures(self):
        dispatcher, messages = self._dispatcher()
        total = dispatcher.FAIL_NOTICE_EVERY * 2 + 1
        for _ in range(total):
            dispatcher._notify_failure("edsm", "EDSM: ошибка сервера (HTTP 503)")
        # 1-я, N-я и 2N-я неудачи.
        self.assertEqual(len(messages), 3, messages)
        self.assertIn("неудач подряд", messages[1][1])
        self.assertIn(str(dispatcher.FAIL_NOTICE_EVERY), messages[1][1])

    def test_recovery_is_reported_once(self):
        dispatcher, messages = self._dispatcher()
        for _ in range(3):
            dispatcher._notify_failure("edsm", "EDSM: ошибка сервера (HTTP 503)")
        dispatcher._notify_success("edsm")
        dispatcher._notify_success("edsm")
        recovery = [m for ok, m in messages if ok]
        self.assertEqual(len(recovery), 1, messages)
        self.assertIn("восстановлена", recovery[0])
        self.assertEqual(dispatcher._fail_streak["edsm"], 0)

    def test_services_are_counted_separately(self):
        dispatcher, messages = self._dispatcher()
        dispatcher._notify_failure("edsm", "EDSM: сбой")
        dispatcher._notify_failure("inara", "Inara: сбой")
        self.assertEqual(dispatcher._fail_streak["edsm"], 1)
        self.assertEqual(dispatcher._fail_streak["inara"], 1)
        self.assertEqual(len(messages), 2)


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


class InaraEventMappingTests(unittest.TestCase):
    """Поля Inara API: имена из журнала не совпадают с именами Inara.

    Документация: https://inara.cz/elite/inara-api-docs/. Раньше уходили
    `StarSystem`/`StationName` и не уходили координаты, тело и `shipGameID`,
    а посадки (Touchdown) не отправлялись вовсе.
    """

    def _submit(self, event: dict) -> tuple:
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeInara:
            enabled = True

            def submit(self, event_name, event_data, timestamp=""):
                sent.append((event_name, event_data, timestamp))
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(inara_api=FakeInara())
        dispatcher.submit(event, live=True)
        dispatcher.flush(timeout=2)
        return sent

    def test_dock_sends_coords_body_and_ship(self):
        sent = self._submit({
            "event": "Docked", "timestamp": "2025-01-01T00:00:00Z",
            "StarSystem": "Kuma", "StarPos": [1.0, 2.0, 3.0], "Body": "Kuma 3 a",
            "StationName": "Hestia Depot", "MarketID": 3951663874,
            "ShipType": "Type9", "ShipID": 12,
        })
        name, data, _ = sent[0]
        self.assertEqual(name, "addCommanderTravelDock")
        self.assertEqual(data["starsystemName"], "Kuma")
        self.assertEqual(data["starsystemCoords"], [1.0, 2.0, 3.0])
        self.assertEqual(data["starsystemBodyName"], "Kuma 3 a")
        self.assertEqual(data["stationName"], "Hestia Depot")
        self.assertEqual(data["marketID"], 3951663874)
        self.assertEqual(data["shipType"], "Type9")
        self.assertEqual(data["shipGameID"], 12)

    def test_carrier_jump_sends_station_and_market(self):
        sent = self._submit({
            "event": "CarrierJump", "timestamp": "2025-01-01T00:00:01Z",
            "StarSystem": "Kuma", "StarPos": [1.0, 2.0, 3.0],
            "StationName": "The Last Word", "MarketID": 3700005632,
        })
        name, data, _ = sent[0]
        self.assertEqual(name, "addCommanderTravelCarrierJump")
        self.assertEqual(data["stationName"], "The Last Word")
        self.assertEqual(data["marketID"], 3700005632)

    def test_touchdown_is_sent_as_travel_land(self):
        """Посадка на стройплощадку — главное событие колонизатора."""
        sent = self._submit({
            "event": "Touchdown", "timestamp": "2025-01-01T00:00:02Z",
            "StarSystem": "Kuma", "StarPos": [1.0, 2.0, 3.0],
            "Body": "Kuma 3 a", "Latitude": 24.66, "Longitude": -107.5,
        })
        name, data, _ = sent[0]
        self.assertEqual(name, "addCommanderTravelLand")
        self.assertEqual(data["starsystemName"], "Kuma")
        self.assertEqual(data["starsystemBodyName"], "Kuma 3 a")
        self.assertEqual(data["starsystemBodyCoords"], [24.66, -107.5])

    def test_touchdown_without_system_uses_known_position(self):
        """Touchdown приходит без системы — подставляем известное положение."""
        from event_dispatch import ThirdPartyDispatcher

        sent = []

        class FakeInara:
            enabled = True

            def submit(self, event_name, event_data, timestamp=""):
                sent.append((event_name, event_data))
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(inara_api=FakeInara())
        dispatcher.submit({"event": "Location", "timestamp": "2025-01-01T00:00:00Z",
                           "StarSystem": "Kuma", "StarPos": [1.0, 2.0, 3.0]}, live=True)
        dispatcher.submit({"event": "Touchdown", "timestamp": "2025-01-01T00:00:03Z"}, live=True)
        dispatcher.flush(timeout=2)
        land = [item for item in sent if item[0] == "addCommanderTravelLand"]
        self.assertEqual(len(land), 1)
        self.assertEqual(land[0][1]["starsystemName"], "Kuma")
        self.assertEqual(land[0][1]["starsystemCoords"], [1.0, 2.0, 3.0])

    def test_scans_are_not_sent_to_inara(self):
        """Событий сканирования в Inara API нет."""
        from event_dispatch import INARA_EVENTS

        for event in ("Scan", "FSSDiscoveryScan", "SAAScanComplete"):
            self.assertNotIn(event, INARA_EVENTS)


if __name__ == "__main__":
    unittest.main()


class InaraWhitelistTests(unittest.TestCase):
    """2.10.9: «This application has no access allowed.» — не временный сбой.

    Inara пускает только приложения из белого списка: личный ключ без
    одобренного имени приложения отклоняется на каждом запросе. Повторять
    такой запрос бесполезно, а в лог достаточно одной понятной строки.
    """

    def setUp(self):
        from inara_api import InaraAPI

        self.api = InaraAPI("key", "CMDR", app_version="2.10.9")
        self.api._session = mock.MagicMock()
        self.api.RETRY_DELAY = 0

    def _answer(self, status_text):
        self.api._session.post.return_value = _FakeResponse(
            {"header": {"eventStatus": 400, "eventStatusText": status_text},
             "events": []})

    def test_not_whitelisted_is_explained_and_not_retried(self):
        self._answer("This application has no access allowed.")
        result = self.api.submit("addCommanderTravelDock",
                                 {"starsystemName": "Sol"}, "2025-01-01T00:00:00Z")
        self.assertFalse(result["ok"])
        self.assertEqual(result.get("error_kind"), "inara_not_whitelisted")
        self.assertFalse(result.get("retryable"))
        self.assertEqual(self.api._session.post.call_count, 1,
                         "повторы при отказе в доступе бессмысленны")
        self.assertIn("белом списке", result["error"])

    def test_other_auth_error_is_not_retried_either(self):
        self._answer("Invalid API key")
        result = self.api.submit("addCommanderTravelDock",
                                 {"starsystemName": "Sol"}, "2025-01-01T00:00:00Z")
        self.assertFalse(result["ok"])
        self.assertFalse(result.get("retryable"))
        self.assertNotIn("error_kind", result)
        self.assertEqual(self.api._session.post.call_count, 1)

    def test_dispatcher_notifies_once_per_session(self):
        from event_dispatch import ThirdPartyDispatcher

        class Denied:
            enabled = True

            def submit(self, event_name, data, timestamp=""):
                return {"ok": False, "error_kind": "inara_not_whitelisted",
                        "error": "Inara: приложение не в белом списке Inara"}

        notes = []
        dispatcher = ThirdPartyDispatcher(inara_api=Denied())
        dispatcher.on_result = lambda service, ok, message: notes.append(message)
        payload = {"event_name": "addCommanderTravelDock", "data": {},
                   "timestamp": "2025-01-01T00:00:00Z"}
        dispatcher._do_inara(payload)
        dispatcher._do_inara(payload)
        dispatcher._do_inara(payload)
        self.assertEqual(len(notes), 1, "простыня из одинаковых отказов не нужна")
        self.assertIn("белом списке", notes[0])


class RavenSupplyUpdateTests(unittest.TestCase):
    """2.10.10: колонка Need на сайте обновляется ProjectUpdate, а не contribute.

    Raven Colonial прибавляет тонны доставок к заслугам командира, но остаток
    потребности по материалам пересчитывает только из `POST /api/project/{id}`
    с телом `{buildId, commodities, maxNeed}` — так делает эталонный плагин
    EDMC-Ravencolonial при каждом `ColonisationConstructionDepot`.
    """

    def test_update_supply_posts_project_update(self):
        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("key")
        api._session = mock.MagicMock()
        api._session.post.return_value = _FakeResponse({"buildId": "b-1"})
        result = api.update_supply("b-1", {"steel": 600}, 1000)
        self.assertTrue(result["ok"])
        url = api._session.post.call_args[0][0]
        self.assertTrue(url.endswith("/project/b-1"), url)
        self.assertEqual(api._session.post.call_args[1]["json"],
                         {"buildId": "b-1", "commodities": {"steel": 600},
                          "maxNeed": 1000})

    def test_depot_event_updates_project_need(self):
        from event_dispatch import ThirdPartyDispatcher

        calls = []

        class FakeRaven:
            enabled = True
            is_connected = True

            def get_project(self, address, market_id, use_cache=True):
                return {"buildId": "b-42"}

            def update_supply(self, build_id, commodities, max_need):
                calls.append((build_id, dict(commodities), max_need))
                return {"ok": True}

            def supply_fc(self, *args, **kwargs):
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(raven_api=FakeRaven())
        sent_ids = []
        dispatcher.on_supply_sent = sent_ids.append
        event = {"event": "ColonisationConstructionDepot",
                 "MarketID": 3951663874, "SystemAddress": 123456789,
                 "ResourcesRequired": [
                     {"Name": "$steel_name;", "RequiredAmount": 1000,
                      "ProvidedAmount": 400},
                     {"Name": "$water_name;", "RequiredAmount": 500,
                      "ProvidedAmount": 500},
                 ]}
        self.assertEqual(dispatcher._submit_raven_supply(event), "queued")
        service, payload = dispatcher._queue.get_nowait()
        self.assertEqual(service, "raven")
        dispatcher._do_raven(payload)
        self.assertEqual(calls, [("b-42", {"steel": 600, "water": 0}, 1500)])
        self.assertEqual(sent_ids, ["b-42"],
                         "хук on_supply_sent зовётся после принятого ProjectUpdate")
        # То же состояние depot повторно — ProjectUpdate не дублируем.
        self.assertEqual(dispatcher._submit_raven_supply(event), "skipped")
