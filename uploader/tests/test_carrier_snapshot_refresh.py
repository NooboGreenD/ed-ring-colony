"""No-jump stock delivery: durable snapshots, bounded batches and UI invalidation.

Pure Python/AST harnesses; no Qt, personal journals, tokens or network.
"""
import ast
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from carrier_sync import CarrierEventCollector
from test_carrier_sync import FakeApi, FC, JOURNAL

DOCK = JOURNAL[1]
MARKET = {"event": "Market", "timestamp": "2026-03-01T08:11:00Z", "MarketID": FC,
          "StationName": DOCK["StationName"], "StarSystem": "Sol", "Items": [
              {"Name": "$steel_name;", "Stock": 1, "Demand": 0, "Producer": True,
               "Consumer": False, "BuyPrice": 12345},
              {"Name": "water", "Stock": 0, "Demand": 25000, "Producer": False, "Consumer": True}]}


class SnapshotQueueTests(unittest.TestCase):
    def make(self, path=None, **dock):
        collector = CarrierEventCollector(path)
        collector.feed({**DOCK, **dock})
        return collector

    def test_current_snapshot_survives_restart_and_failed_upload_without_jump(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'outbox.json'
            collector = self.make(path)
            self.assertTrue(collector.queue_market_snapshot(MARKET))
            restored = CarrierEventCollector(path)
            api = FakeApi(fail=True)
            result = restored.flush(api)
            self.assertFalse(result['ok'])
            self.assertEqual(restored.pending_count, 2)
            result = restored.flush(FakeApi())
            self.assertTrue(result['inventory_changed'])
            self.assertEqual(restored.pending_count, 0)
            self.assertEqual(json.loads(path.read_text()), [])

    def test_recent_absolute_stock_is_not_stuck_behind_historical_events(self):
        collector = self.make()
        for _ in range(600):
            collector.feed({'event': 'CarrierLocation', 'timestamp': DOCK['timestamp'], 'CarrierID': FC})
        collector.queue_market_snapshot(MARKET)
        api = FakeApi()
        result = collector.flush(api, max_batches=1)
        self.assertEqual(api.batches[0][0]['event'], 'Market')
        self.assertEqual(api.batches[0][0]['Items'][0]['Stock'], 1)
        self.assertNotIn('BuyPrice', api.batches[0][0]['Items'][0])
        self.assertTrue(result['inventory_changed'])
        self.assertGreater(collector.pending_count, 0)
        self.assertFalse(any(event['event'] == 'Market' for event in collector.pending))

    def test_identity_and_actual_observation_time_are_required(self):
        collector = self.make()
        for changes in ({'MarketID': FC+1}, {'StationName': 'Wrong'}, {'StarSystem': 'Other'},
                        {'timestamp': '2026-03-01T08:09:00Z'}, {'timestamp': '2099-01-01T00:00:00Z'},
                        {'Items': None}, {'Items': [{}]*5001}):
            self.assertFalse(collector.queue_market_snapshot({**MARKET, **changes}))
        collector.feed({'event': 'Undocked'})
        self.assertFalse(collector.queue_market_snapshot(MARKET))
        self.assertEqual(collector.pending_count, 1)

    def test_squadron_identity_is_retained_even_when_snapshot_is_uploaded_first(self):
        collector = self.make(CarrierType='SquadronCarrier', StationServices=['dock','squadronBank'])
        collector.queue_market_snapshot(MARKET)
        api = FakeApi()
        collector.flush(api)
        snapshot = api.batches[0][0]
        self.assertEqual(snapshot['CarrierType'], 'SquadronCarrier')
        self.assertIn('squadronbank', snapshot['StationServices'])

    def test_snapshot_batches_are_bounded_by_bytes_not_only_event_count(self):
        collector = self.make()
        large = {**MARKET, 'Items': [{'Name': 'steel', 'Stock': 1, 'Name_Localised': 'Сталь'*100}]}
        collector.queue_market_snapshot(large)
        collector.queue_market_snapshot({**large, 'timestamp': '2026-03-01T08:12:00Z'})
        limit = len(json.dumps(collector.pending[-1], ensure_ascii=True).encode('utf-8')) + 10
        api = FakeApi()
        with patch('carrier_sync.MAX_BATCH_BYTES', limit):
            collector.flush(api, max_batches=1)
        self.assertEqual(len(api.batches[0]), 1)
        self.assertEqual(collector.pending_count, 2)
        too_large = {**MARKET, 'Items': [{'Name': 'steel', 'Stock': 1, 'Name_Localised': 'x'*(3*1024*1024)}]}
        self.assertFalse(collector.queue_market_snapshot(too_large))

    def test_success_removes_only_sent_objects_not_new_equal_entries(self):
        collector = self.make()
        collector.pending.clear()
        collector.queue_market_snapshot(MARKET)
        api = FakeApi()
        original = api.sync_carrier_events
        def send(events):
            collector._push(dict(events[0]))  # arrival while request is in flight
            return original(events)
        api.sync_carrier_events = send
        collector.flush(api, max_batches=1)
        self.assertEqual(collector.pending_count, 1)

    def test_no_inventory_notification_for_metadata_or_unapplied_snapshot(self):
        collector = self.make()
        self.assertFalse(collector.flush(FakeApi())['inventory_changed'])
        collector.queue_market_snapshot(MARKET)
        api = FakeApi()
        api.sync_carrier_events = lambda events: {'ok': True, 'applied': 0, 'skipped': len(events)}
        self.assertFalse(collector.flush(api)['inventory_changed'])
        collector.queue_market_snapshot(MARKET)
        api.sync_carrier_events = lambda events: {'ok': True, 'duplicates': 1}
        self.assertTrue(collector.flush(api)['inventory_changed'])


def loading_methods():
    source = ast.parse((HERE.parent/'qt_loading_patterns.py').read_text())
    cls = next(node for node in source.body if isinstance(node, ast.ClassDef) and node.name == 'LoadingPatternsPage')
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef)
               and node.name in ('_on_inventory_changed', 'apply_result')]
    env = {}
    node = ast.ClassDef(name='Page', bases=[], keywords=[], body=methods, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<loading-refresh>', 'exec'), env)
    return env['Page']


class LoadingInvalidationTests(unittest.TestCase):
    def setUp(self):
        self.page = loading_methods()()
        self.page.active_id = 'selected'
        self.page.identity = lambda: 'identity'
        self.page._identity = 'identity'
        self.page.state = SimpleNamespace(identity='identity')
        self.page.isVisible = lambda: False
        self.page.overlay_active = lambda: True
        self.page._busy = False
        self.page._refresh_pending = False
        self.page.refresh = Mock()
        self.page.render = Mock()
        self.page._seq = 10

    def test_committed_inventory_refreshes_active_loading_even_with_tab_hidden(self):
        self.page._on_inventory_changed()
        self.page.refresh.assert_called_once_with(False)

    def test_refresh_does_not_start_while_tab_and_hud_are_inactive(self):
        self.page.overlay_active = lambda: False
        self.page._on_inventory_changed()
        self.page.refresh.assert_not_called()

    def test_repeated_notifications_coalesce_and_run_after_an_inflight_read(self):
        self.page._busy = True
        for _ in range(5):
            self.page._on_inventory_changed()
        self.page.refresh.assert_not_called()
        self.assertTrue(self.page._refresh_pending)
        self.page.apply_result(10, None, None, 'selected')
        self.page.refresh.assert_called_once_with(False)
        self.assertFalse(self.page._refresh_pending)

    def test_old_response_and_changed_identity_cannot_trigger_private_refresh(self):
        self.page._busy = True
        self.page._refresh_pending = True
        self.page.apply_result(9, None, None, 'selected')
        self.assertTrue(self.page._busy)
        self.page.identity = lambda: 'other identity'
        self.page._on_inventory_changed()
        self.page.refresh.assert_not_called()


if __name__ == '__main__':
    unittest.main()
