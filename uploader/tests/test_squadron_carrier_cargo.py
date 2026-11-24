"""Squadron bank -> outbox AND local Carrier HUD, without Qt or a live API.

Wiring tests compile the actual app methods with real collectors and tracker;
only the UI/network/dispatcher are stubbed. Market inventory is partial.
"""
import ast
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from carrier import CarrierTracker
from carrier_sync import CarrierEventCollector
from station_commerce import StationCommerceCollector

SQ = 3709000001
OWN = 3700005632
DOCK = {"event": "Docked", "timestamp": "2026-03-01T10:00:00Z", "MarketID": SQ,
        "StationType": "FleetCarrier", "StationName": "SQD-001", "StarSystem": "Sol",
        "StationServices": ["dock", "squadronBank"]}


def market(stamp="2026-03-01T10:02:00Z", **stock):
    return {**DOCK, "event": "Market", "timestamp": stamp,
            "Items": [{"Name": key, "Stock": value, "Producer": True, "Consumer": False}
                      for key, value in stock.items()]}


def server(stamp="2026-03-01T09:59:00Z", **stock):
    return {"carrierId": str(SQ), "type": "SquadronCarrier",
            "cargo": {"updatedAt": stamp, "observations": {key: stamp for key in stock}, "items": [
                {"commodity": key, "quantity": value} for key, value in stock.items()]}}


def app_class():
    tree = ast.parse((HERE.parent/'colonial_helper.py').read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ColonialHelperApp')
    names = {'_carrier_sync_collector', '_on_squadron_bank_transfer', '_on_station_inventory',
             '_load_server_carriers', '_refresh_carrier_cargo'}
    methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
    env = {'time': time, 'threading': mock.Mock()}
    node = ast.ClassDef(name='App', bases=[], keywords=[], body=methods, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<carrier-wiring>', 'exec'), env)
    return env['App'], env


class SquadronCargoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        cls, self.env = app_class()
        self.app = cls()
        self.app.data_dir = Path(self.temp.name)
        self.app.carrier = CarrierTracker()
        self.app.dispatcher = mock.Mock()
        self.app.log = mock.Mock()
        self.app.root = SimpleNamespace(after=lambda _delay, fn: fn())
        self.app.raven_api = mock.Mock(is_connected=True)
        self.app.api = mock.Mock(is_connected=True)
        self.app.api.fetch_my_carriers.return_value = {'ok': True, 'own': None, 'squadron': []}
        self.app.CARRIER_SERVER_FRESH_SECONDS = 600
        self.app.CARRIER_CARGO_REFRESH_SECONDS = 300
        self.inventory = {'steel': 700, 'water': 50}
        self.ship_stamp = '2026-03-01T10:00:00Z'
        self.app._read_ship_cargo = lambda: {
            'event': 'Cargo', 'timestamp': self.ship_stamp, 'Vessel': 'Ship',
            'Count': sum(self.inventory.values()),
            'Inventory': [{'Name': key, 'Count': amount} for key, amount in self.inventory.items()],
        }
        self.collector = self.app._carrier_sync_collector()
        self.feed(DOCK)
        self.app.carrier.merge_server(server(steel=100, water=50))

    def feed(self, event, live=True):
        self.collector.feed(event, live=live)
        self.app.carrier.handle(event)

    def cargo(self, stamp="2026-03-01T10:01:00Z", live=True):
        self.ship_stamp = stamp
        self.feed({'event': 'Cargo', 'timestamp': stamp, 'Vessel': 'Ship'}, live=live)

    def rows(self):
        return {r['key']: r for r in self.app.carrier.get_state_dict({'steel': 1000})['commodities']}

    def snapshot(self, event):
        self.app._on_station_inventory('market', event, {'market_id': str(SQ), 'station_type': 'FleetCarrier'})

    def test_bank_deposit_updates_same_hud_rows_as_personal_transfers_and_queues_once(self):
        self.inventory['steel'] = 200
        self.cargo()
        row = self.rows()['steel']
        self.assertEqual((row['amount'], row['delivered'], row['remaining']), (600, 500, 400))
        queued = [e for e in self.collector.pending if e['event'] == 'SquadronBankTransfer']
        self.assertEqual(len(queued), 1)
        self.cargo()  # unchanged Cargo sidecar / duplicate marker
        self.assertEqual(self.rows()['steel']['amount'], 600)
        self.assertEqual(self.rows()['steel']['delivered'], 500)
        self.assertIn(SQ, self.collector.pending_carrier_ids())

    def test_two_distinct_bank_changes_with_same_second_are_both_counted(self):
        self.inventory['steel'] = 600
        self.cargo()
        self.inventory['steel'] = 475
        self.cargo()
        self.assertEqual(self.rows()['steel']['amount'], 325)
        self.assertEqual(self.rows()['steel']['delivered'], 225)

    def test_bank_event_after_newer_market_does_not_apply_stock_twice(self):
        self.snapshot(market(steel=600))
        self.inventory['steel'] = 200
        self.cargo()  # earlier bank event, delivered by a delayed journal read
        self.assertEqual(self.rows()['steel']['amount'], 600)
        self.assertEqual(self.rows()['steel']['delivered'], 500)

    def test_ingestion_time_is_not_an_acknowledgment_of_a_bank_transfer(self):
        self.inventory['steel'] = 200
        self.cargo()
        view = server(steel=100)
        view['cargo']['updatedAt'] = '2026-03-02T00:00:00Z'  # old logs uploaded today
        self.app.carrier.merge_server(view)
        self.assertEqual(self.rows()['steel']['amount'], 600)
        self.assertTrue(self.app.carrier.state.commodity_versions)
        # Old sites without observation metadata cannot acknowledge it either.
        view['cargo'].pop('observations')
        self.app.carrier.merge_server(view)
        self.assertEqual(self.rows()['steel']['amount'], 600)

    def test_stale_market_cannot_replace_acknowledged_server_observation(self):
        self.app.carrier.merge_server(server('2026-03-01T10:03:00Z', steel=900, water=50))
        self.snapshot(market(steel=100))
        self.assertEqual(self.rows()['steel']['amount'], 900)

    def test_full_server_empty_snapshot_acknowledges_missing_commodity(self):
        self.snapshot(market(steel=0))
        view = server('2026-03-01T10:03:00Z')
        view['cargo']['baselineAt'] = '2026-03-01T10:03:00Z'
        self.app.carrier.merge_server(view)
        self.assertFalse(self.app.carrier.state.commodity_versions)
        self.assertEqual(self.rows()['steel']['amount'], 0)
        self.assertNotIn('water', self.app.carrier.state.commodities)

    def test_server_acknowledges_depletion_at_actual_observation_time(self):
        self.snapshot(market(steel=0))
        view = server('2026-03-01T10:02:00Z', water=50)
        view['cargo']['observations']['steel'] = '2026-03-01T10:02:00Z'
        self.app.carrier.merge_server(view)
        self.assertFalse(self.app.carrier.state.commodity_versions)
        self.assertEqual(self.rows()['steel']['amount'], 0)
        self.app.carrier.merge_server(server(steel=100))  # out-of-order HTTP response
        self.assertEqual(self.rows()['steel']['amount'], 0)

    def test_withdrawal_depletes_stock_without_negative_personal_delivery(self):
        self.inventory['steel'] = 200
        self.cargo()
        self.inventory['steel'] = 850
        self.cargo('2026-03-01T10:02:00Z')
        self.assertEqual(self.rows()['steel']['amount'], 0)
        self.assertEqual(self.rows()['steel']['delivered'], 0)

    def test_known_market_trade_is_not_counted_twice_as_bank(self):
        self.feed({'event': 'MarketSell', 'MarketID': SQ, 'Type': 'steel', 'Count': 100,
                   'timestamp': '2026-03-01T10:01:00Z'})
        self.inventory['steel'] = 600
        self.cargo('2026-03-01T10:01:01Z')
        self.assertEqual(self.rows()['steel']['amount'], 200)
        self.assertEqual(self.rows()['steel']['delivered'], 100)
        self.assertFalse([e for e in self.collector.pending if e['event'] == 'SquadronBankTransfer'])

    def test_known_cargo_transfer_is_not_counted_twice_as_bank(self):
        self.feed({'event': 'CargoTransfer', 'MarketID': SQ,
                   'timestamp': '2026-03-01T10:01:00Z',
                   'Transfers': [{'Type': 'steel', 'Count': 100, 'Direction': 'tocarrier'}]})
        self.inventory['steel'] = 600
        self.cargo('2026-03-01T10:01:01Z')
        self.assertEqual(self.rows()['steel']['amount'], 200)
        self.assertEqual(self.rows()['steel']['delivered'], 100)
        self.assertFalse([e for e in self.collector.pending if e['event'] == 'SquadronBankTransfer'])

    def test_bank_is_not_replayed_from_history_or_persisted_outbox(self):
        self.inventory['steel'] = 200
        self.cargo(live=False)
        self.assertEqual(self.rows()['steel']['delivered'], 0)
        self.cargo()  # one live delta, not the historical report
        self.collector.save()
        callback = mock.Mock()
        restored = CarrierEventCollector(self.collector.path, on_bank_transfer=callback)
        self.assertTrue(restored.pending_count)
        callback.assert_not_called()

    def test_current_market_updates_stock_offline_but_never_personal_delivery(self):
        self.app.api.is_connected = False
        self.snapshot(market(steel=900))
        self.assertEqual(self.rows()['steel']['amount'], 900)
        self.assertEqual(self.rows()['steel']['delivered'], 0)
        self.assertEqual(self.rows()['water']['amount'], 50)  # absent is not zero
        self.assertEqual(self.app.carrier.get_state_dict()['cargo_source'], 'market')

    def test_market_after_bank_is_a_baseline_not_an_extra_delivery(self):
        self.inventory['steel'] = 200
        self.cargo()
        self.snapshot(market(steel=900))  # also includes other pilots' stock
        self.assertEqual(self.rows()['steel']['amount'], 900)
        self.assertEqual(self.rows()['steel']['delivered'], 500)
        self.inventory['steel'] = 100
        self.cargo('2026-03-01T10:03:00Z')
        self.assertEqual(self.rows()['steel']['amount'], 1000)
        self.assertEqual(self.rows()['steel']['delivered'], 600)

    def test_stale_market_cannot_undo_a_newer_bank_transfer_but_can_fill_other_rows(self):
        self.inventory['steel'] = 200
        self.cargo()
        self.snapshot(market('2026-03-01T10:00:30Z', steel=200, water=80))
        self.assertEqual(self.rows()['steel']['amount'], 600)
        self.assertEqual(self.rows()['water']['amount'], 80)

    def test_inactive_market_cannot_erase_sales_and_next_sale_accumulates(self):
        sale = {**DOCK, 'event': 'MarketSell', 'timestamp': '2026-03-01T10:01:00Z',
                'Type': 'steel', 'Count': 1320}
        self.feed(sale)
        self.assertEqual(self.rows()['steel']['amount'], 1420)
        inactive = market()
        inactive['Items'] = [{'Name': 'steel', 'Stock': 0, 'Demand': 0,
                              'Producer': False, 'Consumer': False}]
        self.snapshot(inactive)
        self.assertEqual(self.rows()['steel']['amount'], 1420)
        self.feed({**sale, 'timestamp': '2026-03-01T10:03:00Z'})
        self.assertEqual(self.rows()['steel']['amount'], 2740)

    def test_market_buy_orders_and_empty_inventory_do_not_erase_unknown_hold(self):
        event = market()
        event['Items'] = [{'Name': 'steel', 'Stock': 0, 'Demand': 500, 'Consumer': True, 'Producer': False}]
        self.snapshot(event)
        self.snapshot(market())
        self.assertEqual(self.rows()['steel']['amount'], 100)
        self.snapshot(market(steel=0))  # explicit sale/depleted row really is zero
        self.assertEqual(self.rows()['steel']['amount'], 0)
        self.assertEqual(self.rows()['water']['amount'], 50)

    def test_old_dock_wrong_market_station_or_system_cannot_overwrite_current_stock(self):
        for changes in ({'MarketID': OWN}, {'StarSystem': 'Lave'}, {'StationName': 'Other'},
                        {'timestamp': '2026-03-01T09:59:59Z'}):
            self.snapshot({**market(steel=900), **changes})
        self.assertEqual(self.rows()['steel']['amount'], 100)
        self.feed({'event': 'Undocked'})
        self.snapshot(market(steel=900))
        self.assertEqual(self.rows()['steel']['amount'], 100)

    def test_unacknowledged_bank_delta_survives_server_refresh_and_older_stats(self):
        self.app.carrier.handle({'event': 'CarrierStats', 'CarrierID': SQ, 'CarrierType': 'SquadronCarrier',
                                 'timestamp': '2026-03-01T09:59:30Z',
                                 'SpaceUsage': {'Cargo': 150, 'FreeSpace': 59000}})
        self.inventory['steel'] = 200
        self.cargo()
        view = server(steel=100, water=50)
        view['space'] = {'statsAt': '2026-03-01T10:00:30Z', 'cargo': 150, 'freeSpace': 59000}
        self.app.api.fetch_my_carriers.return_value = {'ok': True, 'squadron': [view]}
        self.app._load_server_carriers()
        self.assertEqual(self.rows()['steel']['amount'], 600)
        self.assertEqual(self.app.carrier.state.stored, 650)

    def test_after_outbox_flush_old_server_cargo_still_cannot_rollback_local_stock(self):
        self.inventory['steel'] = 200
        self.cargo()
        self.collector.pending.clear()  # acknowledged upload, read replica/old request still stale
        self.app.api.fetch_my_carriers.return_value = {'ok': True, 'squadron': [server(steel=100)]}
        self.app._load_server_carriers()
        self.assertEqual(self.rows()['steel']['amount'], 600)
        self.assertEqual(self.rows()['steel']['delivered'], 500)
        # A genuinely newer cargo response acknowledges the delta and includes others' stock.
        self.app.carrier.merge_server(server('2026-03-01T10:02:00.500Z', steel=800, water=70))
        self.assertEqual(self.rows()['steel']['amount'], 800)
        self.assertEqual(self.rows()['steel']['delivered'], 500)
        self.assertEqual(self.app.carrier.state.commodity_versions, {})

    def test_zero_market_stock_survives_a_stale_server_response(self):
        self.snapshot(market(steel=0))
        self.app.carrier.merge_server(server(steel=100, water=50))
        self.assertEqual(self.rows()['steel']['amount'], 0)
        self.assertEqual(self.rows()['water']['amount'], 50)

    def test_fresh_market_is_not_trimmed_by_recent_but_older_carrier_stats(self):
        self.app.carrier.handle({'event': 'CarrierStats', 'CarrierID': SQ, 'CarrierType': 'SquadronCarrier',
                                 'timestamp': '2026-03-01T10:00:30Z',
                                 'SpaceUsage': {'Cargo': 0, 'FreeSpace': 60000}})
        self.snapshot(market(steel=900))
        self.assertEqual(self.rows()['steel']['amount'], 900)
        data = self.app.carrier.get_state_dict()
        self.assertEqual(data['stored'], 950)
        self.assertTrue(data['stored_estimated'])
        self.assertEqual(data['cargo_capacity'], 60000)

    def test_unversioned_raven_cannot_rollback_bank_or_market_observations(self):
        self.snapshot(market(steel=900))
        self.assertFalse(self.app.carrier.merge_remote({'steel': 1}, market_id=SQ))
        self.app._refresh_carrier_cargo(SQ, force=True)
        self.env['threading'].Thread.assert_not_called()
        self.assertEqual(self.rows()['steel']['amount'], 900)

    def test_personal_carrier_and_new_station_never_receive_squadron_snapshot(self):
        self.feed({**DOCK, 'MarketID': OWN, 'StationName': 'OWN-001', 'StationServices': ['dock']})
        self.app.carrier.handle({'event': 'CargoTransfer', 'MarketID': OWN,
                                 'timestamp': '2026-03-01T10:01:00Z',
                                 'Transfers': [{'Type': 'steel', 'Count': 40, 'Direction': 'tocarrier'}]})
        event = {**market(steel=900), 'MarketID': OWN, 'StationName': 'OWN-001'}
        self.app._on_station_inventory('market', event, {'market_id': OWN})
        self.assertEqual(self.rows()['steel']['amount'], 40)
        self.assertEqual(self.rows()['steel']['delivered'], 40)
        self.assertEqual(self.app.carrier.states()[SQ].commodities['steel'], 100)

    def test_historical_station_report_queues_but_never_notifies_live_inventory(self):
        commerce = StationCommerceCollector(self.app.data_dir/'stations.json')
        commerce.on_inventory = self.app._on_station_inventory
        commerce.feed(DOCK, live=False)
        commerce.feed(market(steel=900), live=False)
        self.assertIn(f'{SQ}:market', commerce.pending)
        self.assertEqual(self.rows()['steel']['amount'], 100)
        self.app.dispatcher.submit_fc_cargo_correction.assert_not_called()
        commerce.feed(market(steel=900), live=True)
        self.assertEqual(self.rows()['steel']['amount'], 900)


if __name__ == '__main__':
    unittest.main()
