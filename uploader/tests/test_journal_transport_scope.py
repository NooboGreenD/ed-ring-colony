"""Разделение «весь перевозимый груз» / «завезено на стройплощадку».

Сайт считает два разных блока досье, и оба выводятся из журнала, поэтому
признак `is_construction` обязан рождаться парсером, а не додумываться
сервером или клиентом. Тесты закрепляют:

* `ColonisationContribution` — поставка на стройку (или на колонизационный
  корабль системы, если это «System Colonisation Ship»);
* `CargoDepot` — груз МИССИИ, строительным он становится только у рынка
  стройплощадки (раньше любой CargoDepot записывался колонизационным);
* `Cargo`-дифф — поставка на стройку, пока игрок стоит у рынка стройплощадки:
  её узнаём и по `ColonisationConstructionDepot`, и по имени/сервисам станции
  в `Docked`/`Market` (приложение могло стартовать уже у площадки);
* отгрузка на авианосце и продажа на обычном рынке — перевозка, а не стройка,
  и это два разных `delivery_kind`;
* `PARSER_VERSION` поднят, потому что набор признаков изменился: старые
  записи локального кэша «уже загруженных файлов» должны быть пере-импортированы.
"""

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import journal_parser  # noqa: E402

SYSTEM = "HIP 22460"
SITE_MARKET = 3951663874
ORDINARY_MARKET = 666000111


def _journal(*events: str) -> str:
    return "\n".join(events)


def loc(ts="2026-09-14T10:00:00Z"):
    return (
        '{"timestamp":"%s","event":"Location","StarSystem":"%s","SystemAddress":123456789}' % (ts, SYSTEM)
    )


def docked(market_id, ts="2026-09-14T10:00:30Z", station_name=None,
           station_type="PlanetaryInstallation", services=None):
    payload = {
        "timestamp": ts,
        "event": "Docked",
        "StationName": station_name if station_name is not None else "Planetary Construction Site: A 1",
        "StationType": station_type,
        "MarketID": market_id,
        "StarSystem": SYSTEM,
    }
    if services is not None:
        payload["StationServices"] = services
    return json.dumps(payload)


def ordinary_docked(market_id, ts="2026-09-14T10:00:30Z"):
    """Обычный порт: ни имени стройплощадки, ни сервиса колонизации."""
    return docked(
        market_id,
        ts=ts,
        station_name="Jaeger Hub",
        station_type="Orbis Starport",
        services=["dock", "missions", "commodities"],
    )


def undocked(ts="2026-09-14T10:10:00Z"):
    return '{"timestamp":"%s","event":"Undocked","StationName":"Planetary Construction Site: A 1"}' % ts


def depot(market_id, progress=0.25, ts="2026-09-14T10:00:20Z"):
    return (
        '{"timestamp":"%s","event":"ColonisationConstructionDepot","MarketID":%d,'
        '"ConstructionName":"Planetary Construction Site: A 1","ConstructionProgress":%s,'
        '"ResourcesRequired":[{"Name":"$titanium_name;","Name_Localised":"Titanium",'
        '"ProvidedAmount":100,"TargetAmount":400}]}' % (ts, market_id, progress)
    )


def cargo(titanium, ts="2026-09-14T10:01:00Z"):
    return (
        '{"timestamp":"%s","event":"Cargo","Vessel":"Ship","Count":1,"Inventory":'
        '[{"Name":"$titanium_name;","Name_Localised":"Titanium","Count":%d}]}' % (ts, titanium)
    )


def contribution(amount, ts="2026-09-14T10:02:00Z"):
    return (
        '{"timestamp":"%s","event":"ColonisationContribution","MarketID":%d,'
        '"MarketName":"Planetary Construction Site: A 1","Contributions":'
        '[{"Name":"$titanium_name;","Name_Localised":"Titanium","Amount":%d}]}'
        % (ts, SITE_MARKET, amount)
    )


def cargo_depot(count, ts="2026-09-14T10:03:00Z"):
    return (
        '{"timestamp":"%s","event":"CargoDepot","UpdateType":"Deliver","MissionID":123,'
        '"CargoType":"BasicMedicines","CargoType_Localised":"Basic Medicines","Count":%d,'
        '"Total":%d,"Start":0,"End":1}' % (ts, count, count)
    )


def carrier_sell(count, ts="2026-09-14T10:04:00Z"):
    return (
        '{"timestamp":"%s","event":"MarketSell","MarketID":%d,"Type":"$titanium_name;",'
        '"Type_Localised":"Titanium","Count":%d,"AvgPrice":12000,"GrossRevenue":%d,'
        '"StationType":"FleetCarrier","CarrierID":"C1234"}' % (ts, ORDINARY_MARKET, count, count * 12000)
    )


def parse(*events: str):
    _, deliveries, *_ = journal_parser.parse_journal(_journal(*events))
    return deliveries


class ConstructionFlagTests(unittest.TestCase):
    def test_contribution_is_construction(self):
        deliveries = parse(loc(), docked(SITE_MARKET), contribution(50))
        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0]["source"], "colonisation_contribution")
        self.assertIs(deliveries[0]["is_construction"], True)
        self.assertEqual(deliveries[0]["amount"], 50)

    def test_cargo_depot_without_site_is_a_mission(self):
        # `CargoDepot` — склад грузовой миссии. Без стройплощадки рядом это
        # перевозка, иначе тоннаж миссий записывался колонизационным.
        deliveries = parse(loc(), cargo_depot(30))
        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0]["source"], "cargo_depot")
        self.assertEqual(deliveries[0]["delivery_kind"], "mission_delivery")
        self.assertIs(deliveries[0]["is_construction"], False)

    def test_cargo_depot_at_construction_site_is_construction(self):
        deliveries = parse(loc(), docked(SITE_MARKET), cargo_depot(30, "2026-09-14T10:03:30Z"))
        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0]["delivery_kind"], "construction_site")
        self.assertIs(deliveries[0]["is_construction"], True)

    def test_cargo_delta_at_known_site_is_construction(self):
        deliveries = parse(
            loc(),
            depot(SITE_MARKET),
            docked(SITE_MARKET),
            cargo(100, "2026-09-14T10:05:00Z"),
            cargo(40, "2026-09-14T10:06:00Z"),
        )
        deltas = [d for d in deliveries if d["source"] == "cargo_delta"]
        self.assertEqual(len(deltas), 1, deltas)
        self.assertEqual(deltas[0]["amount"], 60)
        self.assertIs(deltas[0]["is_construction"], True)

    def test_cargo_delta_at_ordinary_market_is_not_construction(self):
        # Обычный порт: ни имени стройплощадки, ни depot-события — падение
        # груза это продажа на рынке, а не строительный тоннаж.
        deliveries = parse(
            loc(),
            ordinary_docked(ORDINARY_MARKET),
            cargo(100, "2026-09-14T10:05:00Z"),
            cargo(10, "2026-09-14T10:06:00Z"),
        )
        deltas = [d for d in deliveries if d["source"] == "cargo_delta"]
        self.assertEqual(len(deltas), 1, deltas)
        self.assertEqual(deltas[0]["delivery_kind"], "market_sale")
        self.assertIs(deltas[0]["is_construction"], False)

    def test_site_is_recognised_without_depot_event(self):
        # Приложение стартовало, когда командир уже стоит у площадки: в этой
        # сессии `ColonisationConstructionDepot` ещё не приходил, но имя
        # станции и сервис колонизации говорят всё сами.
        deliveries = parse(
            loc(),
            docked(SITE_MARKET, services=["dock", "colonisationcontribution"]),
            cargo(100, "2026-09-14T10:05:00Z"),
            cargo(40, "2026-09-14T10:06:00Z"),
        )
        deltas = [d for d in deliveries if d["source"] == "cargo_delta"]
        self.assertEqual(len(deltas), 1, deltas)
        self.assertEqual(deltas[0]["delivery_kind"], "construction_site")
        self.assertEqual(deltas[0]["station_kind"], "construction_site")
        self.assertIs(deltas[0]["is_construction"], True)
        self.assertEqual(deltas[0]["station_name"], "Planetary Construction Site: A 1")

    def test_lookalike_name_without_service_is_not_a_site(self):
        deliveries = parse(
            loc(),
            docked(
                ORDINARY_MARKET,
                services=["dock", "missions", "commodities"],
            ),
            cargo(100, "2026-09-14T10:05:00Z"),
            cargo(10, "2026-09-14T10:06:00Z"),
        )
        deltas = [d for d in deliveries if d["source"] == "cargo_delta"]
        self.assertEqual(len(deltas), 1, deltas)
        self.assertIs(deltas[0]["is_construction"], False)

    def test_contribution_at_colonisation_ship_is_separate_kind(self):
        deliveries = parse(
            loc(),
            docked(
                SITE_MARKET,
                station_name="System Colonisation Ship",
                station_type="Orbis Starport",
                services=["dock", "colonisationcontribution"],
            ),
            contribution(120, "2026-09-14T10:02:10Z"),
        )
        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0]["delivery_kind"], "colonisation_ship")
        self.assertEqual(deliveries[0]["station_kind"], "colonisation_ship")
        self.assertIs(deliveries[0]["is_construction"], True)

    def test_ordinary_market_sell_is_recorded_as_market_sale(self):
        sell = (
            '{"timestamp":"2026-09-14T10:04:10Z","event":"MarketSell","MarketID":%d,'
            '"Type":"$titanium_name;","Type_Localised":"Titanium","Count":15,'
            '"AvgPrice":12000,"GrossRevenue":180000,"StationType":"Orbis Starport"}'
            % ORDINARY_MARKET
        )
        deliveries = parse(loc(), ordinary_docked(ORDINARY_MARKET), sell)
        sells = [d for d in deliveries if d["delivery_kind"] == "market_sale"]
        self.assertEqual(len(sells), 1, deliveries)
        self.assertEqual(sells[0]["source"], "cargo_delta")
        self.assertEqual(sells[0]["amount"], 15)
        self.assertIs(sells[0]["is_construction"], False)

    def test_undocking_clears_the_site_binding(self):
        # После отстыковки дифф больше не может «приписаться» к площадке,
        # даже если depot-событие системы игрок уже видел.
        deliveries = parse(
            loc(),
            depot(SITE_MARKET),
            docked(SITE_MARKET),
            undocked(),
            cargo(100, "2026-09-14T10:11:00Z"),
            cargo(70, "2026-09-14T10:12:00Z"),
        )
        deltas = [d for d in deliveries if d["source"] == "cargo_delta"]
        self.assertEqual(len(deltas), 1, deltas)
        self.assertIs(deltas[0]["is_construction"], False)

    def test_carrier_sale_is_transport_only(self):
        deliveries = parse(loc(), carrier_sell(25))
        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0]["source"], "carrier_delivery")
        self.assertIs(deliveries[0]["is_construction"], False)

    def test_total_and_site_tonnage_split(self):
        deliveries = parse(
            loc(),
            depot(SITE_MARKET),
            docked(SITE_MARKET),
            contribution(100, "2026-09-14T10:02:00Z"),
            cargo_depot(40, "2026-09-14T10:03:00Z"),
            carrier_sell(25, "2026-09-14T10:04:00Z"),
        )
        total = sum(d["amount"] for d in deliveries)
        site = sum(d["amount"] for d in deliveries if d["is_construction"])
        self.assertEqual(total, 165)
        self.assertEqual(site, 140)
        self.assertEqual(total - site, 25)


class SourceHelpersTests(unittest.TestCase):
    def test_parser_version_bumped_for_new_flags(self):
        self.assertGreaterEqual(
            journal_parser.PARSER_VERSION,
            4,
            "delivery_kind меняет смысл записей: кэш файлов обязан устареть",
        )

    def test_construction_sources(self):
        self.assertTrue(journal_parser.is_construction_source("colonisation_contribution"))
        self.assertTrue(journal_parser.is_construction_source("CARGO_DEPOT"))
        self.assertFalse(journal_parser.is_construction_source("carrier_delivery"))
        self.assertFalse(journal_parser.is_construction_source(None))
        self.assertFalse(journal_parser.is_construction_source(""))


class ApiPayloadTests(unittest.TestCase):
    """Payload для сайта обязан нести и признак источника, и признак стройки."""

    def test_delivery_for_api_forwards_scope_fields(self):
        from test_initial_upload_flow import install_gui_stubs

        install_gui_stubs()
        import colonial_helper

        payload = colonial_helper.ColonialHelperApp._delivery_for_api(
            {
                "system_name": SYSTEM,
                "commodity": "Titanium",
                "amount": 42,
                "delivered_at": "2026-09-14T10:00:00Z",
                "market_id": SITE_MARKET,
                "is_hub": None,
                "route_system_id": None,
                "source": "cargo_delta",
                "is_construction": True,
                "source_hash": "abc",
                # локальное поле для группировки Raven — наружу не уходит
                "system_address": 123456789,
            }
        )
        self.assertNotIn("system_address", payload)
        self.assertEqual(payload["source"], "cargo_delta")
        self.assertIs(payload["is_construction"], True)

    def test_transport_delivery_keeps_flag_false(self):
        from test_initial_upload_flow import install_gui_stubs

        install_gui_stubs()
        import colonial_helper

        payload = colonial_helper.ColonialHelperApp._delivery_for_api(
            {
                "system_name": SYSTEM,
                "commodity": "Titanium",
                "amount": 7,
                "delivered_at": "2026-09-14T10:00:00Z",
                "source": "carrier_delivery",
                "is_construction": False,
                "source_hash": "def",
            }
        )
        self.assertIs(payload["is_construction"], False)


if __name__ == "__main__":
    unittest.main()
