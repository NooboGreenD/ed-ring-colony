"""Exercise actual Helper diagnostics without Qt, credentials or network."""
import ast
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from carrier import CarrierTracker
from event_dispatch import canonical_commodity


def helper_class():
    source = Path(__file__).resolve().parents[1] / 'colonial_helper.py'
    tree = ast.parse(source.read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ColonialHelperApp')
    methods = [n for n in cls.body if isinstance(n, ast.FunctionDef)
               and n.name in ('_feed_carrier', '_flush_carrier_sync')]
    node = ast.ClassDef(name='App', bases=[], keywords=[], body=methods, decorator_list=[])
    env = {'time': time, 'threading': mock.Mock(), 'canonical_commodity': canonical_commodity}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<diagnostics>', 'exec'), env)
    return env['App']


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.app = helper_class()()
        self.app.root = SimpleNamespace(after=lambda delay, fn: fn())
        self.app.log = mock.Mock()
        self.app.api = SimpleNamespace(is_connected=True)
        self.collector = mock.Mock(pending_count=1)
        self.app._carrier_sync_collector = lambda: self.collector
        self.app._carrier_server_at = time.monotonic()
        self.app.CARRIER_SERVER_REFRESH_SECONDS = 90
        self.app._carrier_server_warning_at = 0
        self.app._load_server_carriers = mock.Mock()

    def test_ignored_http_success_is_visible_without_credentials_or_event_dump(self):
        self.collector.flush.return_value = {'ok': True, 'sent': 1, 'applied': 0,
                                            'duplicates': 0, 'ignored': 1, 'skipped': 0,
                                            'carriers': ['3713477376']}
        self.app._flush_carrier_sync()
        message, level = self.app.log.call_args.args
        self.assertEqual(level, 'warn')
        self.assertIn('применено операций — 0', message)
        self.assertIn('игнорировано — 1', message)
        self.assertIn('3713477376', message)
        self.assertNotIn('token', message)

    def test_idle_watcher_does_not_spam_success_logs(self):
        self.collector.pending_count = 0
        self.app._flush_carrier_sync()
        self.app.log.assert_not_called()
        self.collector.flush.assert_not_called()

    def test_local_sale_logs_actual_stock_change(self):
        self.app.carrier = CarrierTracker()
        self.app.carrier.handle({'event': 'Docked', 'MarketID': 3713477376,
                                 'timestamp': '2026-03-01T10:00:00Z',
                                 'StarSystem': 'Sol', 'StationType': 'FleetCarrier',
                                 'StationServices': ['squadronBank']})
        self.app._refresh_carrier_cargo = mock.Mock()
        self.app._feed_carrier({'event': 'MarketSell', 'MarketID': 3713477376,
                               'timestamp': '2026-03-01T10:01:00Z',
                               'Type': 'steel', 'Count': 1320}, live=True)
        message, level = self.app.log.call_args.args
        self.assertIn('0 → 1320 т', message)
        self.assertIn('MarketSell steel', message)
        self.assertEqual(level, 'info')
