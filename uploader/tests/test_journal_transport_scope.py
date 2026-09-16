"""Разделение «весь перевозимый груз» / «завезено на стройплощадку».

Сайт считает два разных блока досье, и оба выводятся из журнала, поэтому
признак `is_construction` обязан рождаться парсером, а не додумываться
сервером или клиентом. Тесты закрепляют:

* `ColonisationContribution` и `CargoDepot` — поставка на стройку;
* `Cargo`-дифф — поставка на стройку ТОЛЬКО пока игрок стоит у рынка, про
  который журнал уже показывал `ColonisationConstructionDepot` (иначе
  обычная продажа в павильоне превратилась бы в строительный тоннаж);
* продажа на авианосце — перевозка, а не стройка;
* `PARSER_VERSION` поднят, потому что набор признаков изменился: старые
  записи локального кэша «уже загруженных файлов» должны быть пере-импортированы.
"""

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


def docked(market_id, ts="2026-09-14T10:00:30Z"):
    return (
        '{"timestamp":"%s","event":"Docked","StationName":"Planetary Construction Site: A 1",'
        '"StationType":"PlanetaryInstallation","MarketID":%d,"StarSystem":"%s"}' % (ts, market_id, SYSTEM)
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

    def test_cargo_depot_is_construction(self):
        deliveries = parse(loc(), cargo_depot(30))
        self.assertEqual(len(deliveries), 1)
        self.assertEqual(deliveries[0]["source"], "cargo_depot")
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
        # Рынок известен, но про него журнал никогда не показывал depot-событие:
        # падение груза — это продажа, а не строительный тоннаж.
        deliveries = parse(
            loc(),
            docked(ORDINARY_MARKET, "2026-09-14T10:00:30Z"),
            cargo(100, "2026-09-14T10:05:00Z"),
            cargo(10, "2026-09-14T10:06:00Z"),
        )
        deltas = [d for d in deliveries if d["source"] == "cargo_delta"]
        self.assertEqual(len(deltas), 1, deltas)
        self.assertIs(deltas[0]["is_construction"], False)

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
            3,
            "признак is_construction меняет смысл записей: кэш файлов обязан устареть",
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
