"""Personal stock regression: snapshots/withdrawals must not resurrect cargo.

Synthetic data only. No Qt, journals, credentials or network needed.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from carrier import CarrierTracker
from carrier_sync import carrier_market_cargo

FC = 3700005632
DOCK = {"event": "Docked", "timestamp": "2026-03-01T10:00:00Z", "MarketID": FC,
        "StationType": "FleetCarrier", "StationName": "OWN-001", "StarSystem": "Sol"}


def market(at="2026-03-01T10:02:00Z", **goods):
    return {**DOCK, "event": "Market", "timestamp": at, "Items": [
        {"Name": key, "Stock": qty, "Producer": True, "Consumer": False}
        for key, qty in goods.items()]}


def server(observed="2026-03-01T10:01:00Z", written="2026-03-01T12:00:00Z", **goods):
    return {"carrierId": str(FC), "type": "FleetCarrier", "relation": "own",
            "cargo": {"updatedAt": written, "observations": {key: observed for key in goods},
                      "items": [{"commodity": key, "quantity": qty} for key, qty in goods.items()]}}


class PersonalStockTests(unittest.TestCase):
    def setUp(self):
        self.tracker = CarrierTracker()
        self.tracker.handle(DOCK)
        self.tracker.merge_server(server(steel=1301, aluminium=501, water=11))

    def snapshot(self, event):
        return self.tracker.merge_market(event, carrier_market_cargo(event["Items"]), market_id=FC)

    def trade(self, event="MarketBuy", count=1300, at="2026-03-01T10:03:00Z"):
        return self.tracker.handle({"event": event, "timestamp": at, "MarketID": FC,
                                    "Type": "steel", "Count": count})

    def test_fresh_personal_market_corrects_full_hold_to_one_tonne_each(self):
        self.assertTrue(self.snapshot(market(steel=1, aluminium=1, water=1)))
        self.assertEqual(self.tracker.state.commodities, {"steel": 1, "aluminium": 1, "water": 1})
        self.assertEqual(self.tracker.state.delivered, {})  # stock != deliveries
        self.tracker.merge_server(server(written="2026-03-01T13:00:00Z", steel=1301, aluminium=501, water=11))
        self.assertEqual(self.tracker.state.commodities, {"steel": 1, "aluminium": 1, "water": 1})
        self.assertFalse(self.tracker.merge_remote({"steel": 25000}, market_id=FC))

    def test_buy_from_carrier_subtracts_and_old_server_cannot_undo_purchase(self):
        self.trade()
        self.assertEqual(self.tracker.state.commodities['steel'], 1)
        self.tracker.merge_server(server(steel=1301, aluminium=501, water=11))
        self.assertEqual(self.tracker.state.commodities['steel'], 1)
        self.trade("MarketSell", 10, "2026-03-01T10:04:00Z")
        self.assertEqual(self.tracker.state.commodities['steel'], 11)

    def test_purchase_after_opening_market_in_same_second_is_not_discarded(self):
        stamp = "2026-03-01T10:03:00Z"
        self.snapshot(market(at=stamp, steel=1301))
        self.trade(at=stamp)
        self.assertEqual(self.tracker.state.commodities['steel'], 1)
        self.tracker.merge_server(server(observed=stamp, steel=1301))
        self.assertEqual(self.tracker.state.commodities['steel'], 1)
        self.snapshot(market(at="2026-03-01T10:04:00Z", steel=1))
        self.assertEqual(self.tracker.state.commodities['steel'], 1)

    def test_explicit_depletion_cannot_be_resurrected_and_fresh_observation_acknowledges(self):
        self.trade(count=1301)
        self.assertNotIn('steel', self.tracker.state.commodities)
        self.tracker.merge_server(server(steel=1301))
        self.assertNotIn('steel', self.tracker.state.commodities)
        self.tracker.merge_server(server(observed="2026-03-01T10:04:00Z", steel=2))
        self.assertEqual(self.tracker.state.commodities['steel'], 2)
        self.assertNotIn('steel', self.tracker.state.commodity_versions)

    def test_late_trade_already_in_snapshot_is_not_applied_twice(self):
        self.snapshot(market(at="2026-03-01T10:04:00Z", steel=1))
        self.trade()
        self.assertEqual(self.tracker.state.commodities['steel'], 1)

    def test_stale_market_cannot_undo_trade_but_can_update_unrelated_good(self):
        self.trade()
        self.snapshot(market(steel=1301, aluminium=1))
        self.assertEqual(self.tracker.state.commodities['steel'], 1)
        self.assertEqual(self.tracker.state.commodities['aluminium'], 1)
        self.assertEqual(self.tracker.state.commodities['water'], 11)

    def test_purchase_orders_and_missing_goods_are_not_a_stock_snapshot(self):
        event = market()
        event['Items'] = [{"Name": "steel", "Stock": 0, "Demand": 20000, "Producer": False, "Consumer": True}]
        self.assertFalse(self.snapshot(event))
        self.assertEqual(self.tracker.state.commodities['steel'], 1301)
        self.snapshot(market(steel=0))
        self.assertNotIn('steel', self.tracker.state.commodities)
        self.assertEqual(self.tracker.state.commodities['water'], 11)

    def test_wrong_station_or_old_snapshot_is_rejected(self):
        for changes in ({'MarketID': FC+1}, {'StationName': 'Elsewhere'}, {'StarSystem': 'Lave'},
                        {'timestamp': '2026-03-01T09:00:00Z'}):
            self.assertFalse(self.snapshot({**market(steel=1), **changes}))
        self.assertEqual(self.tracker.state.commodities['steel'], 1301)
        self.tracker.handle({'event': 'Undocked'})
        self.assertFalse(self.snapshot(market(steel=1)))

    def test_server_invalidated_cargo_is_unknown_not_proportionally_distributed(self):
        invalidated = {"carrierId": str(FC), "type": "FleetCarrier", "relation": "own",
                       "cargo": None, "cargoInvalidatedAt": "2026-03-01T10:02:00Z"}
        self.tracker.merge_server(invalidated)
        self.assertEqual(self.tracker.state.commodities, {})
        self.assertFalse(self.tracker.state.remote_seen)
        self.assertEqual(self.tracker.state.reconciled, 'dropped')
        self.tracker.merge_server(server(written="2026-03-01T14:00:00Z", steel=1301))
        self.assertEqual(self.tracker.state.commodities, {})
        self.assertFalse(self.tracker.merge_remote({'steel': 1301}, market_id=FC))
        self.assertFalse(self.snapshot(market(at="2026-03-01T10:01:00Z", steel=1301)))
        self.snapshot(market(at="2026-03-01T10:04:00Z", steel=1))
        self.assertEqual(self.tracker.state.commodities['steel'], 1)
        self.tracker.merge_server(invalidated)  # delayed response cannot drop fresh stock
        self.assertEqual(self.tracker.state.commodities['steel'], 1)

    def test_inventory_transfer_to_ship_subtracts_and_survives_stale_server(self):
        self.tracker.handle({"event": "CargoTransfer", "timestamp": "2026-03-01T10:03:00Z",
                             "MarketID": FC, "Transfers": [{"Type": "steel", "Count": 1300, "Direction": "toship"}]})
        self.assertEqual(self.tracker.state.commodities['steel'], 1)
        self.tracker.merge_server(server(steel=1301))
        self.assertEqual(self.tracker.state.commodities['steel'], 1)

    def test_old_aggregate_does_not_trim_new_market_within_grace_period(self):
        self.tracker.handle({"event": "CarrierStats", "CarrierID": FC, "timestamp": "2026-03-01T10:01:59Z",
                             "SpaceUsage": {"Cargo": 1, "FreeSpace": 20000}})
        self.snapshot(market(steel=10))
        self.assertEqual(self.tracker.state.commodities['steel'], 10)


if __name__ == '__main__':
    unittest.main()
