"""Optional full shared-bank retrieval, no GUI, credentials or live requests."""
import ast
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from api_client import ApiClient


def app_class():
    tree = ast.parse((ROOT/'colonial_helper.py').read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ColonialHelperApp')
    methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == '_refresh_squadron_bank_from_frontier']
    node = ast.ClassDef(name='App', bases=[], keywords=[], body=methods, decorator_list=[])
    env = {'time': time, 'tr': lambda text: text}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<bank-refresh>', 'exec'), env)
    return env['App']


class BankRefreshTests(unittest.TestCase):
    def setUp(self):
        self.app = app_class()()
        self.app.api = SimpleNamespace(is_connected=True, api_base='https://example.test/api', token='project-token',
                                       refresh_squadron_bank=mock.Mock(return_value={'ok': True}))
        self.app.carrier = SimpleNamespace(state=SimpleNamespace(at_carrier=True, kind='squadron', market_id=3713000111))
        self.pending = SimpleNamespace(pending_count=0)
        self.app._carrier_sync_collector = lambda: self.pending
        self.app.root = SimpleNamespace(after=lambda delay, fn: fn())
        self.app.log = mock.Mock()
        self.app.loading_patterns_page = SimpleNamespace(inventory_changed=mock.Mock())

    def test_idle_docked_member_refreshes_periodically_not_per_tick_and_notifies_loading(self):
        self.app._refresh_squadron_bank_from_frontier()
        self.app._refresh_squadron_bank_from_frontier()
        self.app.api.refresh_squadron_bank.assert_called_once_with(3713000111)
        self.app.loading_patterns_page.inventory_changed.emit.assert_called_once()
        self.app._bank_snapshot_retry = {}
        self.app._refresh_squadron_bank_from_frontier()
        self.assertEqual(self.app.api.refresh_squadron_bank.call_count, 2)

    def test_pending_sales_personal_undocked_or_disconnected_never_trigger_full_snapshot(self):
        for attr, value, target in [('pending_count', 1, self.pending), ('kind', 'own', self.app.carrier.state),
                                    ('at_carrier', False, self.app.carrier.state), ('is_connected', False, self.app.api)]:
            before = getattr(target, attr)
            setattr(target, attr, value)
            self.app._refresh_squadron_bank_from_frontier()
            setattr(target, attr, before)
        self.app.api.refresh_squadron_bank.assert_not_called()

    def test_unlinked_binding_backs_off_and_does_not_claim_a_successful_refresh(self):
        self.app.api.refresh_squadron_bank.return_value = {'ok': False, 'needsSiteLink': True, 'status': 409}
        before = time.monotonic()
        self.app._refresh_squadron_bank_from_frontier()
        self.assertGreater(next(iter(self.app._bank_snapshot_retry.values())), before+590)
        self.app.loading_patterns_page.inventory_changed.emit.assert_not_called()
        self.app._refresh_squadron_bank_from_frontier()
        self.app.api.refresh_squadron_bank.assert_called_once()

    def test_account_or_carrier_change_has_an_independent_refresh_identity(self):
        self.app._refresh_squadron_bank_from_frontier()
        self.app.api.token = 'other-project-token'
        self.app._refresh_squadron_bank_from_frontier()
        self.assertEqual(self.app.api.refresh_squadron_bank.call_count, 2)

    def test_inflight_account_change_does_not_notify_the_new_account(self):
        def changed(_carrier_id):
            self.app.api.token = 'new-token'
            return {'ok': True}
        self.app.api.refresh_squadron_bank.side_effect = changed
        self.app._refresh_squadron_bank_from_frontier()
        self.app.loading_patterns_page.inventory_changed.emit.assert_not_called()
        self.app.log.assert_not_called()

    @mock.patch('api_client._session_for_thread')
    def test_api_posts_only_project_bearer_to_relative_site_endpoint_without_inventory(self, session):
        response = session.return_value.post.return_value
        response.ok = True
        response.status_code = 200
        response.json.return_value = {'ok': True, 'total': 675}
        api = ApiClient(token='project-token', site_url='https://example.test')
        self.assertTrue(api.refresh_squadron_bank(3713000111)['ok'])
        args, kwargs = session.return_value.post.call_args
        self.assertEqual(args[0], 'https://example.test/api/carriers/3713000111/bank/refresh')
        self.assertEqual(kwargs['headers'], {'Authorization': 'Bearer project-token'})
        self.assertFalse(kwargs['allow_redirects'])
        self.assertNotIn('json', kwargs)


if __name__ == '__main__':
    unittest.main()
