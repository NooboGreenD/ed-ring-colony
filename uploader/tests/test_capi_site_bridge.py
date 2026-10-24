"""The Helper talks to the website, never to Frontier CAPI directly."""
import unittest
from unittest import mock

from api_client import ApiClient


class _Response:
    def __init__(self, status, body):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._body = body
        self.text = ""

    def json(self):
        return self._body


class WebsiteCapiBridgeTests(unittest.TestCase):
    def setUp(self):
        self.client = ApiClient(token="project-api-token", site_url="https://colony.test")
        self.client._session = mock.Mock()

    def test_status_uses_project_token_and_returns_site_binding(self):
        self.client._session.get.return_value = _Response(200, {
            "linked": True, "active": True, "cmdrName": "Hunter",
            "profile": {"credits": 42},
        })

        result = self.client.get_capi_status()

        self.assertTrue(result["ok"])
        self.assertTrue(result["linked"])
        self.assertEqual(result["profile"]["credits"], 42)
        args, kwargs = self.client._session.get.call_args
        self.assertEqual(args[0], "https://colony.test/api/capi/helper")
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer project-api-token"})
        self.assertNotIn("json", kwargs)

    def test_sync_asks_site_to_fetch_parse_and_persist_capi(self):
        self.client._session.post.return_value = _Response(200, {
            "ok": True, "cmdrName": "Hunter", "profile": {"credits": 42},
        })

        result = self.client.sync_capi()

        self.assertTrue(result["ok"])
        self.assertEqual(result["cmdrName"], "Hunter")
        args, kwargs = self.client._session.post.call_args
        self.assertEqual(args[0], "https://colony.test/api/capi/helper")
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer project-api-token"})
        self.assertNotIn("json", kwargs)
        self.assertNotIn("data", kwargs)
        self.assertEqual(kwargs["allow_redirects"], False)

    def test_unbound_site_response_is_preserved_for_ui(self):
        self.client._session.post.return_value = _Response(403, {
            "error": "Connect Frontier on the website", "needsSiteLink": True,
        })

        result = self.client.sync_capi()

        self.assertFalse(result["ok"])
        self.assertTrue(result["needsSiteLink"])
        self.assertEqual(result["status"], 403)

    def test_missing_project_token_never_makes_a_request(self):
        self.client.token = ""
        self.assertFalse(self.client.get_capi_status()["ok"])
        self.assertFalse(self.client.sync_capi()["ok"])
        self.client._session.get.assert_not_called()
        self.client._session.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
