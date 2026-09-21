"""Domain migration, credentials isolation and real API request regression tests."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import requests
from api_client import ApiClient, _safe_json
from site_config import DEFAULT_SITE_URL, normalize_site_url, saved_connection


def response(payload=None, status=200):
    result = requests.Response()
    result.status_code = status
    result._content = json.dumps(payload if payload is not None else {"ok": True}).encode()
    result.encoding = "utf-8"
    return result


class SiteConfigurationTests(unittest.TestCase):
    def test_default_and_legacy_addresses_migrate_without_http_redirects(self):
        for url in ("", "http://edringcolony.ru/", "https://www.edringcolony.ru/api/",
                    "https://ed-ring-colony.vercel.app", "http://ed-ring-colony.vercel.app/api"):
            with self.subTest(url=url):
                self.assertEqual(normalize_site_url(url), DEFAULT_SITE_URL)

    def test_custom_https_and_local_development_origins(self):
        for raw, expected in (("https://other.test:8443/api/", "https://other.test:8443"),
                              ("http://localhost:3000", "http://localhost:3000"),
                              ("http://[::1]:3000/api", "http://[::1]:3000")):
            self.assertEqual(normalize_site_url(raw), expected)

    def test_rejects_insecure_ambiguous_and_supabase_urls(self):
        for url in ("http://other.test", "ftp://edringcolony.ru", "https://u:p@other.test",
                    "https://other.test/account", "https://other.test?token=secret",
                    "https://other.test#x", "https://other.test:bad", "other.test",
                    "https://other.test\\@evil.test", "https://other.\ntest",
                    "https://supabase.edringcolony.ru"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                normalize_site_url(url)

    def test_legacy_credentials_restore_after_overlay_config_loss(self):
        self.assertEqual(saved_connection({}, {"token": "saved"}), (DEFAULT_SITE_URL, "saved"))
        self.assertEqual(saved_connection({"token": "older"}, {"token": "saved"}),
                         (DEFAULT_SITE_URL, "saved"))

    def test_tokens_are_not_reused_when_only_the_host_changes(self):
        self.assertEqual(saved_connection({"site_url": "https://other.test", "token": "old"},
                                          {"token": "old"}), ("https://other.test", ""))
        self.assertEqual(saved_connection({"site_url": "https://other.test"},
                                          {"site_url": DEFAULT_SITE_URL, "token": "old"}),
                         ("https://other.test", ""))
        self.assertEqual(saved_connection({}, {"site_url": "https://other.test", "token": "new"}),
                         ("https://other.test", "new"))

    def test_invalid_saved_url_fails_closed(self):
        with self.assertRaises(ValueError):
            saved_connection({"site_url": "http://insecure.test", "token": "old"}, {})


class SelfhostApiTests(unittest.TestCase):
    def test_all_site_requests_use_instance_origin_and_never_follow_redirects(self):
        client = ApiClient(site_url="https://other.test/api/")
        transport = mock.Mock()
        transport.post.return_value = response({"ok": True, "user_id": "u", "inserted": 1})
        transport.get.return_value = response()
        client._session = transport
        with mock.patch.dict(ApiClient._post_upload.__globals__, {"_session_for_thread": lambda: transport}):
            self.assertTrue(client.validate_token("rc_test")["ok"])
            client._post_upload({"token": client.token, "deliveries": []})
            client.get_system_scans("Sol")
            client.upload_system_scans("Sol", [{"body_id": 1}])
            client.upload_pilot_stats({"credits": 1})
        calls = transport.post.call_args_list + transport.get.call_args_list
        self.assertEqual({call.args[0] for call in calls}, {
            "https://other.test/api/auth/token", "https://other.test/api/logs/upload",
            "https://other.test/api/atlas/system-bodies", "https://other.test/api/cmdr/stats",
        })
        for call in calls:
            self.assertIs(call.kwargs["allow_redirects"], False)
            self.assertIsNot(call.kwargs.get("verify"), False)

    def test_401_resets_previous_identity_and_explains_database_migration(self):
        client = ApiClient("old")
        client.user_id = "old-user"
        client.cmdr_name = "Old Pilot"
        with mock.patch.object(client._session, "post", return_value=response({}, 401)):
            result = client.validate_token("not-imported")
        self.assertFalse(result["ok"])
        self.assertFalse(client.is_connected)
        self.assertIsNone(client.cmdr_name)
        self.assertEqual(client.token, "")
        self.assertIn("api_tokens", result["error"])
        self.assertIn("https://edringcolony.ru/account?tab=tokens", result["error"])
        self.assertNotIn("not-imported", result["error"])

    def test_tls_failure_is_not_worked_around_by_disabling_verification(self):
        client = ApiClient()
        with mock.patch.object(client._session, "post", side_effect=requests.exceptions.SSLError()) as post:
            result = client.validate_token("secret")
        self.assertFalse(result["ok"])
        self.assertIn("HTTPS", result["error"])
        self.assertEqual(post.call_count, 1)
        self.assertIsNot(post.call_args.kwargs.get("verify"), False)

    def test_redirect_is_failure_even_though_requests_response_ok_is_true(self):
        client = ApiClient("secret")
        redirect = response({"ok": True}, 307)
        self.assertTrue(redirect.ok)
        transport = mock.Mock()
        transport.post.return_value = redirect
        with mock.patch.dict(ApiClient._post_upload.__globals__, {"_session_for_thread": lambda: transport}):
            result = client.upload_deliveries([{"quantity": 1}], max_workers=1)
        self.assertFalse(result["ok"])
        self.assertIn("перенаправляет", result["error"])
        self.assertEqual(transport.post.call_count, 1)

    def test_non_object_json_is_a_controlled_error(self):
        for payload in ([1], "ok", 1):
            self.assertFalse(_safe_json(response(payload))["ok"])


class UploadCacheScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from test_initial_upload_flow import install_gui_stubs
        install_gui_stubs()
        import colonial_helper
        cls.App = colonial_helper.ColonialHelperApp

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.app = self.App.__new__(self.App)
        self.app.api = ApiClient("token")
        self.app.api.user_id = "user-a"
        self.app.config_path = root / "config.json"
        self.app.credentials_path = root / "credentials.json"
        self.app.imported_files_path = root / "imported.json"
        self.app.imported_files = {}
        self.app.last_file_mtimes = {"journal.log": 200}
        self.app.root = mock.Mock()
        self.journal = root / "journal.log"
        self.journal.write_text("test")

    def test_import_cache_is_bound_to_verified_user_and_origin(self):
        self.app._mark_files_imported([self.journal])
        self.assertTrue(self.app._is_file_imported(self.journal))
        self.app.api.user_id = "user-b"
        self.assertFalse(self.app._is_file_imported(self.journal))
        self.app.api = ApiClient("token", "https://other.test")
        self.app.api.user_id = "user-a"
        self.assertFalse(self.app._is_file_imported(self.journal))

    def test_watcher_offsets_are_not_reused_for_a_new_account(self):
        self.app._save_journal_offsets()
        self.assertEqual(self.app._load_journal_offsets(), {"journal.log": 200})
        self.app.api.user_id = "user-b"
        self.assertEqual(self.app._load_journal_offsets(), {})

    def test_legacy_watcher_offsets_force_one_reconciliation(self):
        file = self.app.config_path.with_name(".colonial_helper_journal_offsets.json")
        file.write_text(json.dumps({"journal.log": 200}))
        self.assertEqual(self.app._load_journal_offsets(), {})

    def test_token_switch_is_blocked_while_watcher_uses_the_previous_account(self):
        self.app.watcher_active = True
        self.app.token_entry = mock.Mock()
        self.app.token_entry.get.return_value = "other-token"
        self.app.log = mock.Mock()
        with mock.patch.object(self.app.api, "validate_token") as validate:
            self.app._on_validate_token()
        validate.assert_not_called()
        self.assertEqual(self.app.api.token, "token")
        self.assertEqual(self.app.api.user_id, "user-a")

    def test_actual_config_loader_uses_separate_credentials_token(self):
        self.app.config_path.write_text("{}")
        self.app.credentials_path.write_text(json.dumps({"token": "restored"}))
        self.app.load_config()
        self.assertEqual(self.app.api.token, "restored")
        self.assertEqual(self.app.api.site_url, DEFAULT_SITE_URL)


if __name__ == "__main__":
    unittest.main()
