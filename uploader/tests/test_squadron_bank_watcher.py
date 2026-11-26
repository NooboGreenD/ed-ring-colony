"""Real Cargo.json snapshots and restored docks, not an idealised live Docked.

No Qt/network: execute actual Helper restore methods, collector and HUD tracker.
"""
import ast
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from carrier import CarrierTracker
from carrier_sync import CarrierEventCollector
from journal_parser import iter_journal_events
from i18n import tr

SQ = 3709000001
DOCK = {'event': 'Docked', 'timestamp': '2026-03-01T10:00:00Z', 'MarketID': SQ,
        'StationType': 'FleetCarrier', 'StationName': 'SQD-001', 'StarSystem': 'Sol',
        'StationServices': ['dock', 'squadronBank']}


def snapshot(stamp='2026-03-01T10:00:01Z', steel=700):
    return {'event': 'Cargo', 'timestamp': stamp, 'Vessel': 'Ship', 'Count': steel,
            'Inventory': [{'Name': 'steel', 'Count': steel}] if steel else []}


def helper_class():
    tree = ast.parse((Path(__file__).resolve().parents[1]/'colonial_helper.py').read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ColonialHelperApp')
    names = {'_carrier_sync_collector', '_read_ship_cargo', '_on_squadron_bank_transfer',
             '_restore_station_state_from_journal'}
    body = [n for n in cls.body if (isinstance(n, ast.FunctionDef) and n.name in names)
            or (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id.startswith('RESTORE_') for t in n.targets))]
    env = {'iter_journal_events': iter_journal_events, 'tr': tr, 'json': json, 'time': time}
    node = ast.ClassDef(name='App', bases=[], keywords=[], body=body, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<helper-restore>', 'exec'), env)
    return env['App']


class BankWatcherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.App = helper_class()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root/'Cargo.json'
        self.write(snapshot())
        self.tracker = CarrierTracker()
        self.tracker.handle(DOCK)
        self.collector = CarrierEventCollector(cargo_reader=self.read, on_bank_transfer=self.tracker.handle)

    def write(self, data, notify=True):
        # Simulate the real ordering: Cargo marker appended, sidecar written
        # later. The existing watcher retries after processing the whole batch.
        if notify and hasattr(self, 'collector'):
            self.collector.feed({key: value for key, value in data.items() if key != 'Inventory'}, live=True)
        self.path.write_text(json.dumps(data), encoding='utf-8')

    def read(self):
        return json.loads(self.path.read_text(encoding='utf-8'))

    def start(self):
        self.collector.restore_context([DOCK])
        self.collector.begin_live()

    def bank(self):
        return [e for e in self.collector.pending if e['event'] == 'SquadronBankTransfer']

    def test_restored_dock_and_first_deposit_without_a_new_dock(self):
        self.start()
        self.assertEqual(self.collector.pending, [])  # restoring is not uploading old events
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'], [{'Type': 'steel', 'Count': 500, 'Direction': 'tocarrier'}])
        self.assertEqual(self.tracker.state.commodities['steel'], 500)
        self.assertEqual(self.tracker.state.delivered['steel'], 500)
        self.collector.poll_cargo()
        self.collector.feed(self.read(), live=True)
        self.assertEqual(len(self.bank()), 1)

    def test_cargo_marker_before_sidecar_write_is_retried_on_next_poll(self):
        self.start()
        self.collector.feed({'event': 'Cargo', 'timestamp': '2026-03-01T10:01:00Z', 'Vessel': 'Ship', 'Count': 200}, live=True)
        self.assertFalse(self.bank())  # file still contains the pre-deposit snapshot
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(len(self.bank()), 1)
        self.assertEqual(self.bank()[0]['timestamp'], '2026-03-01T10:01:00Z')

    def test_latest_sidecar_is_not_applied_to_an_older_marker_before_known_trade(self):
        self.start()
        self.write(snapshot('2026-03-01T10:01:02Z', 250), notify=False)
        self.collector.feed({'event': 'Cargo', 'timestamp': '2026-03-01T10:01:00Z', 'Count': 200}, live=True)
        self.collector.feed({'event': 'MarketBuy', 'timestamp': '2026-03-01T10:01:01Z', 'MarketID': SQ,
                             'Type': 'steel', 'Count': 50}, live=True)
        self.collector.feed({'event': 'Cargo', 'timestamp': '2026-03-01T10:01:02Z', 'Count': 250}, live=True)
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 500)  # not 450 / 550
        self.assertEqual(self.bank()[0]['timestamp'], '2026-03-01T10:01:02Z')

    def test_unchanged_sidecar_after_trade_never_generates_a_phantom_bank_delta(self):
        self.start()
        self.collector.feed({'event': 'MarketBuy', 'timestamp': '2026-03-01T10:01:00Z', 'MarketID': SQ,
                             'Type': 'steel', 'Count': 50}, live=True)
        self.collector.poll_cargo()  # old file; expected inventory already adjusted
        self.assertFalse(self.bank())
        self.write(snapshot('2026-03-01T10:01:01Z', 750))
        self.collector.poll_cargo()
        self.assertFalse(self.bank())

    def test_intermediate_sidecar_older_than_known_trade_waits_for_catchup(self):
        self.start()
        self.collector.feed({'event': 'MarketBuy', 'timestamp': '2026-03-01T10:02:00Z', 'MarketID': SQ,
                             'Type': 'steel', 'Count': 50}, live=True)
        self.write(snapshot('2026-03-01T10:01:00Z', 700))
        self.collector.poll_cargo()
        self.assertFalse(self.bank())
        self.write(snapshot('2026-03-01T10:02:00Z', 750))
        self.collector.poll_cargo()
        self.assertFalse(self.bank())

    def test_unknown_cargo_change_is_not_a_deposit_then_tracking_resumes(self):
        self.start()
        self.collector.feed({'event': 'EjectCargo', 'timestamp': '2026-03-01T10:01:00Z'}, live=True)
        self.write(snapshot('2026-03-01T10:01:01Z', 600))
        self.collector.poll_cargo()
        self.assertFalse(self.bank())
        self.write(snapshot('2026-03-01T10:02:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 400)

    def test_live_journal_and_sidecar_do_not_double_count_and_withdrawal_updates_stock(self):
        self.start()
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.feed(self.read(), live=True)
        self.collector.poll_cargo()
        self.assertEqual(len(self.bank()), 1)
        self.write(snapshot('2026-03-01T10:02:00Z', 300))
        self.collector.poll_cargo()
        self.assertEqual(self.tracker.state.commodities['steel'], 400)
        self.assertEqual(self.tracker.state.delivered['steel'], 400)

    def test_sidecar_ahead_of_journal_waits_for_its_marker_and_known_operations(self):
        self.start()
        self.write(snapshot('2026-03-01T10:01:01Z', 750), notify=False)
        self.collector.poll_cargo()
        self.assertFalse(self.bank())
        self.collector.feed({'event': 'MarketBuy', 'timestamp': '2026-03-01T10:01:00Z', 'MarketID': SQ,
                             'Type': 'steel', 'Count': 50}, live=True)
        self.collector.feed({'event': 'Cargo', 'timestamp': '2026-03-01T10:01:01Z', 'Count': 750}, live=True)
        self.collector.poll_cargo()
        self.assertFalse(self.bank())

    def test_same_second_future_snapshot_is_not_used_for_a_different_cargo_count(self):
        self.start()
        self.write(snapshot('2026-03-01T10:01:00Z', 750), notify=False)
        self.collector.feed({'event': 'Cargo', 'timestamp': '2026-03-01T10:01:00Z', 'Count': 700}, live=True)
        self.collector.poll_cargo()
        self.assertFalse(self.bank())
        self.collector.feed({'event': 'MarketBuy', 'timestamp': '2026-03-01T10:01:00Z', 'MarketID': SQ,
                             'Type': 'steel', 'Count': 50}, live=True)
        self.collector.feed({'event': 'Cargo', 'timestamp': '2026-03-01T10:01:00Z', 'Count': 750}, live=True)
        self.collector.poll_cargo()
        self.assertFalse(self.bank())

    def test_full_unload_and_repeated_poll(self):
        self.start()
        self.write(snapshot('2026-03-01T10:01:00Z', 0))
        self.collector.poll_cargo()
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 700)
        self.assertEqual(len(self.bank()), 1)

    def test_invalid_truncated_stale_or_srv_sidecar_never_becomes_an_empty_hold(self):
        self.start()
        for value in ({'event': 'Cargo', 'timestamp': '2026-03-01T10:01:00Z'},
                      {**snapshot('2026-03-01T10:01:00Z', 0), 'Vessel': 'SRV'},
                      snapshot('2026-03-01T09:00:00Z', 0), snapshot('2099-01-01T00:00:00Z', 0),
                      {**snapshot('2026-03-01T10:01:00Z', 0), 'Count': 700}):
            self.write(value)
            self.collector.poll_cargo()
        self.assertFalse(self.bank())
        self.write(snapshot('2026-03-01T10:02:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 500)

    def test_historical_reconciliation_then_begin_live_does_not_lose_first_change(self):
        self.start()
        self.collector.feed(DOCK, live=False)  # startup replay used to reset baseline to None
        self.collector.begin_live()
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 500)

    def test_personal_dock_undock_jump_and_shutdown_disable_polling(self):
        cases = [[{**DOCK, 'StationServices': ['dock']}], [DOCK, {'event': 'Undocked'}],
                 [DOCK, {'event': 'FSDJump', 'StarSystem': 'Lave'}], [DOCK, {'event': 'Shutdown'}],
                 [DOCK, {'event': 'Location', 'Docked': False, 'StarSystem': 'Sol'}]]
        for events in cases:
            with self.subTest(events=events):
                self.collector.restore_context(events)
                self.collector.begin_live()
                self.write(snapshot('2026-03-01T10:01:00Z', 200))
                self.collector.poll_cargo()
                self.assertFalse(self.bank())

    def test_sparse_carrier_jump_keeps_bank_tracking_and_does_not_borrow_future_cargo(self):
        self.start()
        # The sidecar may already contain the post-jump deposit when the
        # watcher is still reading CarrierJump. It is NOT a new dock baseline.
        self.write(snapshot('2026-03-01T10:02:00Z', 200), notify=False)
        self.collector.feed({'event': 'CarrierJump', 'timestamp': '2026-03-01T10:01:00Z',
                             'MarketID': SQ, 'StationType': 'FleetCarrier', 'StarSystem': 'Lave'}, live=True)
        self.collector.feed({'event': 'Cargo', 'timestamp': '2026-03-01T10:02:00Z', 'Count': 200}, live=True)
        self.collector.poll_cargo()
        self.assertEqual(len(self.bank()), 1)
        self.assertEqual(self.bank()[0]['Transfers'], [{'Type': 'steel', 'Count': 500, 'Direction': 'tocarrier'}])
        self.assertEqual(self.tracker.state.commodities['steel'], 500)

    def test_restored_sparse_location_keeps_known_carrier_kind(self):
        location = {key: value for key, value in DOCK.items() if key != 'StationServices'}
        location.update(event='Location', Docked=True, timestamp='2026-03-01T10:00:00Z')
        for evidence in (DOCK, {'event': 'CarrierStats', 'CarrierID': SQ, 'CarrierType': 'SquadronCarrier'},
                         {'event': 'CarrierLocation', 'CarrierID': SQ, 'CarrierType': 'SquadronCarrier'}):
            with self.subTest(evidence=evidence['event']):
                self.write(snapshot(), notify=False)
                self.collector = CarrierEventCollector(cargo_reader=self.read)
                self.collector.restore_context([evidence, {'event': 'LoadGame'}, location])
                self.collector.begin_live()
                self.write(snapshot('2026-03-01T10:01:00Z', 200))
                self.collector.poll_cargo()
                self.assertEqual(len(self.bank()), 1)
                self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 500)

    def test_identity_after_sparse_restored_location_is_used_before_live_baseline(self):
        location = {key: value for key, value in DOCK.items() if key != 'StationServices'}
        location.update(event='Location', Docked=True)
        self.collector.restore_context([location, {'event': 'CarrierLocation', 'CarrierID': SQ,
                                                   'CarrierType': 'SquadronCarrier'}])
        self.collector.begin_live()
        self.assertEqual(self.collector.pending, [])
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 500)

    def test_known_bank_is_recognised_after_leaving_and_returning_to_sparse_dock(self):
        self.start()
        self.collector.feed({'event': 'Undocked'}, live=True)
        self.collector.feed({key: value for key, value in DOCK.items() if key != 'StationServices'}, live=True)
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 500)

    def test_untyped_snapshot_never_asserts_that_a_carrier_is_personal(self):
        self.collector.restore_context([{key: value for key, value in DOCK.items() if key != 'StationServices'}])
        event = {**DOCK, 'event': 'Market', 'timestamp': '2026-03-01T10:01:00Z',
                 'Items': [{'Name': 'steel', 'Stock': 1, 'Producer': True}]}
        self.assertTrue(self.collector.queue_market_snapshot(event))
        self.assertNotIn('CarrierType', self.collector.pending[-1])
        self.assertFalse(self.bank())

    def test_known_squadron_type_does_not_leak_to_another_carrier(self):
        self.start()
        self.collector.feed({'event': 'Undocked'}, live=True)
        self.collector.feed({**DOCK, 'MarketID': SQ + 1, 'StationName': 'OWN-001',
                             'StationServices': ['dock'], 'timestamp': '2026-03-01T10:00:01Z'}, live=True)
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.poll_cargo()
        self.assertFalse(self.bank())

    def test_restored_dock_can_queue_verified_market_in_its_actual_system(self):
        self.start()
        event = {**DOCK, 'event': 'Market', 'timestamp': '2026-03-01T10:01:00Z',
                 'Items': [{'Name': 'steel', 'Stock': 1, 'Producer': True}]}
        self.assertTrue(self.collector.queue_market_snapshot(event))
        self.assertFalse(self.collector.queue_market_snapshot({**event, 'StarSystem': 'Lave'}))

    def test_late_identity_does_not_misclassify_a_trade_missing_from_stale_sidecar(self):
        self.collector.feed({key: value for key, value in DOCK.items() if key != 'StationServices'}, live=True)
        self.collector.feed({'event': 'MarketBuy', 'timestamp': '2026-03-01T10:00:02Z',
                             'MarketID': SQ, 'Type': 'steel', 'Count': 50}, live=True)
        self.collector.feed({'event': 'CarrierStats', 'timestamp': '2026-03-01T10:00:03Z',
                             'CarrierID': SQ, 'CarrierType': 'SquadronCarrier'}, live=True)
        self.write(snapshot('2026-03-01T10:00:04Z', 750))
        self.collector.poll_cargo()
        self.assertFalse(self.bank())  # known purchase is not an extra withdrawal
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 550)

    def test_live_identity_can_enable_bank_tracking_without_claiming_old_changes(self):
        self.collector.feed({key: value for key, value in DOCK.items() if key != 'StationServices'}, live=True)
        self.collector.feed({'event': 'CarrierStats', 'timestamp': '2026-03-01T10:00:02Z',
                             'CarrierID': SQ, 'CarrierType': 'SquadronCarrier'}, live=True)
        self.assertFalse(self.bank())
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        self.collector.poll_cargo()
        self.assertEqual(len(self.bank()), 1)
        self.assertEqual(self.bank()[0]['Transfers'][0]['Count'], 500)

    def test_actual_helper_restores_bank_context_with_saved_offsets_and_reads_real_sidecar(self):
        # Exercise the Helper's tail event allowlist, not just collector calls.
        identity = {'event': 'CarrierLocation', 'timestamp': '2026-03-01T09:59:00Z',
                    'CarrierID': SQ, 'CarrierType': 'SquadronCarrier', 'StarSystem': 'Sol'}
        location = {key: value for key, value in DOCK.items() if key != 'StationServices'}
        location.update(event='Location', Docked=True)
        (self.root/'Journal.01.log').write_text('\n'.join(map(json.dumps, [identity, location]))+'\n', encoding='utf-8')
        app = self.App()
        app.journal_path = app.data_dir = self.root
        app.carrier = CarrierTracker()
        app.root = SimpleNamespace(after=lambda _delay, fn: fn())
        app.construction = SimpleNamespace(handle=mock.Mock(), site=None)
        app.system_map = SimpleNamespace(handle=mock.Mock(), current_system='')
        app._station_commerce_collector = mock.Mock()
        app._squadron_collector = mock.Mock()
        app._refresh_site_project = app._refresh_carrier_cargo = app.log = mock.Mock()
        result = app._restore_station_state_from_journal()
        self.assertTrue(result['carrier'])
        collector = app._carrier_sync_collector()
        self.assertTrue(collector.queue_market_snapshot({**DOCK, 'event': 'Market',
            'timestamp': '2026-03-01T10:00:02Z', 'Items': [{'Name': 'steel', 'Stock': 1, 'Producer': True}]}))
        self.assertEqual(collector.pending[-1]['CarrierType'], 'SquadronCarrier')
        collector.begin_live()
        self.write(snapshot('2026-03-01T10:01:00Z', 200))
        collector.poll_cargo()
        collector.feed({'event': 'Cargo', 'timestamp': '2026-03-01T10:01:00Z', 'Count': 200}, live=True)
        collector.poll_cargo()
        self.assertEqual(app.carrier.state.commodities['steel'], 500)
        self.assertEqual(app.carrier.state.delivered['steel'], 500)
        self.assertIn('на носитель 500 т', app.log.call_args.args[0])

    def test_watcher_primes_after_history_and_polls_before_upload(self):
        source = (Path(__file__).resolve().parents[1]/'colonial_helper.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ColonialHelperApp')
        loop = ast.get_source_segment(source, next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == '_watcher_loop'))
        self.assertLess(loop.index('.begin_live()'), loop.index('while not self.watcher_stop_event.is_set():'))
        self.assertLess(loop.index('.poll_cargo()'), loop.index('self._flush_carrier_sync()'))


if __name__ == '__main__':
    unittest.main()
