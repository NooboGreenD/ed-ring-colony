"""Учёт авианосцев на сайте проекта и корректная отправка в Raven Colonial.

Проверяется:

* сборщик событий (carrier_sync.CarrierEventCollector) отбирает те же события
  с тем же контекстом стоянки, что и загрузчик журналов на сайте
  (src/lib/fleetCarrierCollector.ts) — иначе хеши дельт разошлись бы и груз
  задвоился бы при загрузке через сайт и через Helper;
* outbox на диске переживает перезапуск, неудачная пачка не теряется;
* банк эскадры: дифф трюма у эскадренного носителя с вычетом известных
  операций, дроны не учитываются;
* трекер авианосца: эскадренный CarrierStats не делает носитель «своим»,
  данные сайта подставляются в оверлей;
* Raven: аддитивные дельты не уходят из истории и по незарегистрированным
  носителям, исправления по рынку отправляются установкой значений (POST).
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from carrier_sync import (  # noqa: E402
    CarrierEventCollector, carrier_market_cargo, inventory_from_cargo,
)
from carrier import CarrierTracker  # noqa: E402

FC = 3700005632
SQ = 3709000001

JOURNAL = [
    {"timestamp": "2026-03-01T08:00:00Z", "event": "FSDJump", "StarSystem": "Sol", "StarPos": [0, 0, 0], "SystemAddress": 1},
    {"timestamp": "2026-03-01T08:10:00Z", "event": "Docked", "StationName": "L14-X1J", "StationType": "FleetCarrier",
     "MarketID": FC, "StarSystem": "Sol", "SystemAddress": 1, "LandingPads": {"Large": 8}},
    {"timestamp": "2026-03-01T08:11:00Z", "event": "MarketSell", "MarketID": FC, "Type": "steel", "Count": 700,
     "SellPrice": 4000, "TotalSale": 2800000, "AvgPricePaid": 3000},
    {"timestamp": "2026-03-01T08:12:00Z", "event": "CargoTransfer", "Transfers": [{"Type": "titanium", "Count": 20, "Direction": "tocarrier"}]},
    {"timestamp": "2026-03-01T08:13:00Z", "event": "Undocked", "StationName": "L14-X1J", "MarketID": FC},
    {"timestamp": "2026-03-01T08:14:00Z", "event": "CargoTransfer", "Transfers": [{"Type": "water", "Count": 5, "Direction": "tocarrier"}]},
    {"timestamp": "2026-03-01T08:20:00Z", "event": "Docked", "StationName": "Galileo", "StationType": "Ocellus", "MarketID": 128666762, "StarSystem": "Sol"},
    {"timestamp": "2026-03-01T08:21:00Z", "event": "MarketSell", "MarketID": 128666762, "Type": "gold", "Count": 1},
]


class FakeApi:
    is_connected = True

    def __init__(self, fail=False):
        self.fail = fail
        self.batches = []

    def sync_carrier_events(self, events):
        self.batches.append(list(events))
        if self.fail:
            return {"ok": False, "error": "HTTP 503"}
        return {"ok": True, "applied": len(events), "duplicates": 0, "carriers": [str(FC)]}


class CollectorTests(unittest.TestCase):
    def test_same_selection_and_context_as_the_website_collector(self):
        collector = CarrierEventCollector()
        for event in JOURNAL:
            collector.feed(event, live=False)
        events = collector.pending
        # Ровно то же, что ожидает тест сайта (fleet-carriers-normalize.test.mjs).
        self.assertEqual([event["event"] for event in events], ["Docked", "MarketSell", "CargoTransfer"])
        self.assertEqual(events[0]["_StarPos"], [0, 0, 0])
        self.assertNotIn("LandingPads", events[0])
        self.assertEqual(events[1]["_StationType"], "FleetCarrier")
        self.assertEqual(events[2]["_MarketID"], FC)
        self.assertEqual(events[2]["_StationType"], "FleetCarrier")

    def test_carrier_events_pass_through_and_irrelevant_ones_do_not(self):
        collector = CarrierEventCollector()
        collector.feed({"timestamp": "t", "event": "CarrierStats", "CarrierID": FC, "Crew": [], "ShipPacks": [{"PackTheme": "x"}]})
        collector.feed({"timestamp": "t", "event": "CarrierJumpRequest", "CarrierID": FC, "SystemName": "Alpha"})
        collector.feed({"timestamp": "t", "event": "Scan", "BodyName": "Sol"})
        collector.feed({"timestamp": "t", "event": "CarrierFinance", "CarrierID": FC})
        names = [event["event"] for event in collector.pending]
        self.assertEqual(names, ["CarrierStats", "CarrierJumpRequest"])
        self.assertNotIn("ShipPacks", collector.pending[0])

    def test_outbox_survives_restart_and_failed_batches_are_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "outbox.json"
            collector = CarrierEventCollector(path)
            for event in JOURNAL:
                collector.feed(event)
            collector.save()
            restored = CarrierEventCollector(path)
            self.assertEqual(restored.pending_count, 3)
            self.assertEqual(restored.pending_carrier_ids(), {FC})

            failing = FakeApi(fail=True)
            result = restored.flush(failing)
            self.assertFalse(result["ok"])
            self.assertEqual(restored.pending_count, 3)

            api = FakeApi()
            result = restored.flush(api)
            self.assertTrue(result["ok"])
            self.assertEqual(result["sent"], 3)
            self.assertEqual(restored.pending_count, 0)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), [])

    def test_flush_is_skipped_without_connection(self):
        collector = CarrierEventCollector()
        collector.feed(JOURNAL[1])
        api = FakeApi()
        api.is_connected = False
        self.assertFalse(collector.flush(api)["ok"])
        self.assertEqual(api.batches, [])


class SquadronBankTests(unittest.TestCase):
    def setUp(self):
        self.inventory = {"steel": 700, "aluminium": 100}
        self.collector = CarrierEventCollector(inventory_reader=lambda: dict(self.inventory))
        self.collector.feed({"timestamp": "2026-03-01T09:00:00Z", "event": "Docked", "StationName": "SQD-001",
                             "StationType": "FleetCarrier", "MarketID": SQ, "StarSystem": "HIP 1",
                             "StationServices": ["dock", "squadronBank"]}, live=True)

    def cargo(self, ts):
        self.collector.feed({"timestamp": ts, "event": "Cargo", "Vessel": "Ship", "Count": sum(self.inventory.values())}, live=True)

    def bank(self):
        return [event for event in self.collector.pending if event["event"] == "SquadronBankTransfer"]

    def test_deposit_and_withdrawal_are_counted_from_the_hold_diff(self):
        self.inventory = {"steel": 200, "aluminium": 100, "drones": 4}
        self.cargo("2026-03-01T09:01:00Z")
        self.inventory = {"steel": 200, "aluminium": 150, "drones": 4}
        self.cargo("2026-03-01T09:02:00Z")
        bank = self.bank()
        self.assertEqual(bank[0]["MarketID"], SQ)
        self.assertEqual(bank[0]["Transfers"], [{"Type": "steel", "Count": 500, "Direction": "tocarrier"}])
        self.assertEqual(bank[1]["Transfers"], [{"Type": "aluminium", "Count": 50, "Direction": "toship"}])

    def test_known_operations_are_not_mistaken_for_bank_transfers(self):
        # Покупка на рынке в той же пачке журнала: ожидаемый трюм учитывает её заранее.
        self.collector.feed({"timestamp": "2026-03-01T09:01:00Z", "event": "MarketBuy", "MarketID": SQ, "Type": "water", "Count": 10}, live=True)
        self.inventory = {"steel": 300, "aluminium": 100, "water": 10}
        self.cargo("2026-03-01T09:01:01Z")
        self.assertEqual(self.bank()[0]["Transfers"], [{"Type": "steel", "Count": 400, "Direction": "tocarrier"}])
        # Неизвестное изменение трюма (миссия) — следующий дифф не считается банком.
        self.collector.feed({"timestamp": "2026-03-01T09:02:00Z", "event": "MissionCompleted"}, live=True)
        self.inventory = {"steel": 0, "aluminium": 100, "water": 10}
        self.cargo("2026-03-01T09:02:01Z")
        self.assertEqual(len(self.bank()), 1)

    def test_history_and_ordinary_carriers_never_produce_bank_transfers(self):
        collector = CarrierEventCollector(inventory_reader=lambda: {"steel": 1})
        collector.feed({"timestamp": "t", "event": "Docked", "StationType": "FleetCarrier", "MarketID": FC, "StarSystem": "Sol"}, live=True)
        collector.feed({"timestamp": "t2", "event": "Cargo", "Vessel": "Ship", "Inventory": []}, live=True)
        self.assertFalse([event for event in collector.pending if event["event"] == "SquadronBankTransfer"])
        self.inventory = {"steel": 0}
        self.collector.feed({"timestamp": "t3", "event": "Cargo", "Vessel": "Ship"}, live=False)
        self.assertEqual(self.bank(), [])

    def test_inventory_parser_ignores_drones(self):
        self.assertEqual(inventory_from_cargo({"Inventory": [
            {"Name": "drones", "Count": 10}, {"Name": "$steel_name;", "Count": 5}, {"Name": "steel", "Count": 2}]}), {"steel": 7})


class MarketCargoTests(unittest.TestCase):
    def test_market_snapshot_rule_matches_srvsurvey(self):
        self.assertEqual(carrier_market_cargo([
            {"Name": "$steel_name;", "Stock": 1200, "Producer": True, "Consumer": False},
            {"Name": "$titanium_name;", "Stock": 0, "Demand": 0, "Producer": False, "Consumer": False},
            {"Name": "$water_name;", "Stock": 0, "Demand": 500, "Producer": False, "Consumer": True},
            {"name": "Gold", "stock": 10},
            {"name": "Silver", "demand": 40},
        ]), {"steel": 1200, "titanium": 0, "gold": 10})


class TrackerTests(unittest.TestCase):
    def test_squadron_carrier_stats_do_not_make_it_own(self):
        tracker = CarrierTracker()
        tracker.handle({"timestamp": "2026-03-01T10:00:00Z", "event": "CarrierStats", "CarrierID": SQ,
                        "CarrierType": "SquadronCarrier", "SpaceUsage": {"Cargo": 10, "FreeSpace": 100}})
        self.assertEqual(tracker.own_carrier_id, 0)
        self.assertEqual(tracker.states()[SQ].kind, "squadron")

    def test_docking_at_javelin_is_recognised_by_squadron_bank_service(self):
        tracker = CarrierTracker()
        tracker.handle({"timestamp": "t", "event": "Docked", "StationType": "FleetCarrier", "MarketID": SQ,
                        "StationName": "SQD-001", "StarSystem": "HIP 1", "StationServices": ["dock", "squadronBank"]})
        self.assertEqual(tracker.state.kind, "squadron")

    def test_carrier_location_and_jump_requests(self):
        tracker = CarrierTracker()
        tracker.handle({"timestamp": "t", "event": "CarrierLocation", "CarrierID": FC, "StarSystem": "Sol", "SystemAddress": 1, "BodyID": 0})
        state = tracker.states()[FC]
        self.assertEqual(state.system_name, "Sol")
        self.assertFalse(state.at_carrier)
        tracker.handle({"timestamp": "t", "event": "CarrierJumpRequest", "CarrierID": FC, "SystemName": "Alpha", "DepartureTime": "2026-03-01T10:15:00Z"})
        self.assertEqual(state.jump_system, "Alpha")
        tracker.handle({"timestamp": "t", "event": "CarrierJumpCancelled", "CarrierID": FC})
        self.assertEqual(state.jump_system, "")

    def test_server_view_becomes_the_cargo_source(self):
        tracker = CarrierTracker()
        tracker.handle({"timestamp": "2026-03-01T08:10:00Z", "event": "Docked", "StationType": "FleetCarrier",
                        "MarketID": FC, "StationName": "L14-X1J", "StarSystem": "Sol"})
        tracker.handle({"timestamp": "2026-03-01T08:11:00Z", "event": "MarketSell", "MarketID": FC, "Type": "gold", "Count": 5})
        view = {
            "carrierId": str(FC), "type": "FleetCarrier", "name": "Spirula", "callsign": "L14-X1J", "relation": "own",
            "location": {"system": "Sol", "estimated": False}, "jump": {"system": "Alpha", "departureAt": "2026-03-01T12:00:00.000Z"},
            "status": {"dockingLabel": "все пилоты", "pendingDecommission": False},
            "services": [{"role": "Refuel", "label": "Заправка", "activated": True, "enabled": True},
                         {"role": "Shipyard", "label": "Верфь", "activated": False, "enabled": False}],
            "space": {"cargo": 800, "freeSpace": 17000, "totalCapacity": 25000, "statsAt": "2026-03-01T09:00:00.000Z"},
            "cargo": {"items": [{"commodity": "steel", "name": "Steel", "quantity": 700},
                                {"commodity": "titanium", "name": "Titanium", "quantity": 100}]},
        }
        # Пока по носителю есть неотправленные события, груз с сайта не подставляем.
        self.assertTrue(tracker.merge_server(view, merge_cargo=False))
        self.assertEqual(tracker.state.commodities, {"gold": 5})
        self.assertTrue(tracker.merge_server(view))
        data = tracker.get_state_dict()
        self.assertEqual(data["cargo_source"], "server")
        self.assertEqual({row["key"]: row["amount"] for row in data["commodities"]}, {"steel": 700, "titanium": 100})
        self.assertEqual(data["services"], ["Заправка"])
        self.assertEqual(data["jump_system"], "Alpha")
        self.assertEqual(data["stored"], 800)
        self.assertTrue(data["server_seen"])
        # Более старый CarrierStats с сайта не перетирает свежий локальный тоннаж.
        tracker.handle({"timestamp": "2026-03-01T11:00:00Z", "event": "CarrierStats", "CarrierID": FC,
                        "SpaceUsage": {"Cargo": 900, "FreeSpace": 16900}})
        tracker.merge_server(view)
        self.assertEqual(tracker.state.stored, 900)


class RavenDispatchTests(unittest.TestCase):
    def make(self, known=True, current=None):
        from event_dispatch import ThirdPartyDispatcher

        calls = {"patch": [], "post": [], "notes": []}

        class FakeRaven:
            is_connected = True

            def fc_known(self, market_id):
                return known

            def supply_fc(self, market_id, commodity, delta):
                calls["patch"].append((market_id, commodity, delta))
                return {"ok": True}

            def get_fc_cargo(self, market_id):
                return {"ok": True, "data": dict(current or {})}

            def set_fc_cargo(self, market_id, cargo):
                calls["post"].append((market_id, dict(cargo)))
                return {"ok": True}

        dispatcher = ThirdPartyDispatcher(raven_api=FakeRaven(), backfill_enabled=True)
        dispatcher.on_result = lambda service, ok, message: calls["notes"].append(message)
        return dispatcher, calls

    SALE = {"event": "MarketSell", "timestamp": "2026-03-01T08:11:00Z", "MarketID": FC, "Type": "steel", "Count": 700}

    def test_history_never_sends_additive_deltas_even_with_backfill(self):
        dispatcher, calls = self.make()
        dispatcher.submit(dict(self.SALE), live=False)
        dispatcher.flush(timeout=2)
        self.assertEqual(calls["patch"], [])
        dispatcher.submit(dict(self.SALE), live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(calls["patch"], [(FC, "steel", 700)])

    def test_unregistered_carriers_get_no_deltas_and_one_notice(self):
        dispatcher, calls = self.make(known=False)
        dispatcher.submit(dict(self.SALE), live=True)
        dispatcher.submit({**self.SALE, "timestamp": "2026-03-01T08:12:00Z"}, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(calls["patch"], [])
        self.assertEqual(sum("не зарегистрирован" in note for note in calls["notes"]), 1)

    def test_market_correction_posts_only_changed_items_once(self):
        dispatcher, calls = self.make(current={"steel": 900, "titanium": 50})
        dispatcher.submit_fc_cargo_correction(FC, cargo={"steel": 700, "titanium": 50, "water": 0})
        dispatcher.flush(timeout=2)
        self.assertEqual(calls["post"], [(FC, {"steel": 700})])
        # Тот же снимок повторно не отправляется.
        dispatcher.submit_fc_cargo_correction(FC, cargo={"steel": 700, "titanium": 50, "water": 0})
        dispatcher.flush(timeout=2)
        self.assertEqual(len(calls["post"]), 1)

    def test_empty_hold_zeroes_raven_cargo(self):
        dispatcher, calls = self.make(current={"steel": 900, "titanium": 0})
        dispatcher.submit_fc_cargo_correction(FC, empty=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(calls["post"], [(FC, {"steel": 0})])


if __name__ == "__main__":
    unittest.main()
