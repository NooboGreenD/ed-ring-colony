"""Тесты Frontier CAPI-клиента (PKCE) из Colonial Helper."""

import base64
import hashlib
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import companion_api
from companion_api import (
    CompanionAuth,
    CompanionAuthError,
    CompanionClient,
    build_auth_url,
    create_code_challenge,
    create_code_verifier,
    profile_to_stats,
)


class PkceEncodingTests(unittest.TestCase):
    """Кодирование PKCE должно ровно совпадать с требованиями Frontier."""

    def test_verifier_is_base64url_with_padding(self):
        verifier = create_code_verifier()
        # 32 байта -> 44 символа base64 с "=" на конце. Frontier требует
        # сохранить "=" у верификатора (в отличие от challenge).
        self.assertEqual(len(verifier), 44)
        self.assertTrue(verifier.endswith("="))
        self.assertNotIn("+", verifier)
        self.assertNotIn("/", verifier)

    def test_challenge_strips_padding(self):
        verifier = "abc123"
        challenge = create_code_challenge(verifier)
        self.assertFalse(challenge.endswith("="))
        expected = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode("utf-8")).digest()
        ).decode("ascii").rstrip("=")
        self.assertEqual(challenge, expected)

    def test_challenge_matches_rfc7636_appendix_b(self):
        # Вектор из RFC 7636: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        self.assertEqual(
            create_code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        )

    def test_auth_url_contains_required_params(self):
        url = build_auth_url(
            client_id="cid",
            redirect_uri="http://127.0.0.1:1234/",
            code_challenge="ch",
            state="st",
        )
        self.assertTrue(url.startswith(companion_api.AUTH_URL + "?"))
        for fragment in ("audience=frontier", "scope=auth+capi", "response_type=code",
                         "client_id=cid", "code_challenge=ch",
                         "code_challenge_method=S256", "state=st"):
            self.assertIn(fragment, url)
        # redirect_uri обязан быть закодирован
        self.assertIn("redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2F", url)


class TokenStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "capi.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_file_returns_empty(self):
        self.assertEqual(CompanionAuth(self.path).load(), {})

    def test_save_and_load_roundtrip(self):
        auth = CompanionAuth(self.path)
        auth.save({"access_token": "a", "refresh_token": "r", "expires_in": 100})
        loaded = auth.load()
        self.assertEqual(loaded["access_token"], "a")
        self.assertIn("saved_at", loaded)

    def test_clear_removes_tokens(self):
        auth = CompanionAuth(self.path)
        auth.save({"access_token": "a"})
        auth.clear()
        self.assertFalse(auth.is_linked())

    def test_app_client_id_by_default(self):
        auth = CompanionAuth(self.path)
        self.assertEqual(auth.client_id, companion_api.APP_CLIENT_ID)
        self.assertEqual(auth.client_id, "0d6027a7-2561-4e1b-af2e-2fe71b296bdd")

    def test_explicit_client_id_wins(self):
        auth = CompanionAuth(self.path, client_id="mine")
        self.assertEqual(auth.client_id, "mine")


class TokenRequestTests(unittest.TestCase):
    """Обмен кода/refresh должен идти БЕЗ client_secret (PKCE)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.auth = CompanionAuth(os.path.join(self.tmp.name, "capi.json"))

    def tearDown(self):
        self.tmp.cleanup()

    def _capture(self, response):
        captured = {}

        class Resp:
            status_code = response["status"]
            text = json.dumps(response["body"])

            def json(self):
                return response["body"]

        def fake_post(url, data=None, headers=None, timeout=None):
            captured["url"] = url
            captured["data"] = data
            captured["headers"] = headers
            return Resp()

        return fake_post, captured

    def test_exchange_code_sends_verifier_without_secret(self):
        fake_post, captured = self._capture({
            "status": 200,
            "body": {"access_token": "at", "refresh_token": "rt", "expires_in": 14400},
        })
        with patch.object(companion_api.requests, "post", side_effect=fake_post):
            tokens = self.auth.exchange_code("code", "verifier", "http://127.0.0.1:9/")

        self.assertEqual(tokens["access_token"], "at")
        self.assertEqual(captured["data"]["grant_type"], "authorization_code")
        self.assertEqual(captured["data"]["code_verifier"], "verifier")
        self.assertNotIn("client_secret", captured["data"])
        self.assertEqual(captured["headers"]["Content-Type"], "application/x-www-form-urlencoded")

    def test_refresh_sends_no_secret(self):
        fake_post, captured = self._capture({
            "status": 200,
            "body": {"access_token": "at2", "expires_in": 100},
        })
        with patch.object(companion_api.requests, "post", side_effect=fake_post):
            tokens = self.auth.refresh("rt")

        self.assertEqual(tokens["access_token"], "at2")
        self.assertEqual(captured["data"]["grant_type"], "refresh_token")
        self.assertNotIn("client_secret", captured["data"])

    def test_error_response_raises(self):
        fake_post, _ = self._capture({
            "status": 400,
            "body": {"message": "An error occured", "logref": "123"},
        })
        with patch.object(companion_api.requests, "post", side_effect=fake_post):
            with self.assertRaises(CompanionAuthError) as ctx:
                self.auth.exchange_code("code", "v", "http://127.0.0.1:9/")
        self.assertIn("400", str(ctx.exception))

    def test_access_token_refreshes_when_expired(self):
        self.auth.save({"access_token": "old", "refresh_token": "rt",
                        "expires_in": 100, "obtained_at": 0})
        fake_post, captured = self._capture({
            "status": 200,
            "body": {"access_token": "new", "expires_in": 14400},
        })
        with patch.object(companion_api.requests, "post", side_effect=fake_post):
            token = self.auth.access_token()

        self.assertEqual(token, "new")
        self.assertEqual(captured["data"]["grant_type"], "refresh_token")

    def test_access_token_kept_when_fresh(self):
        import time as _time
        self.auth.save({"access_token": "fresh", "refresh_token": "rt",
                        "expires_in": 14400, "obtained_at": _time.time()})
        with patch.object(companion_api.requests, "post") as mock_post:
            self.assertEqual(self.auth.access_token(), "fresh")
            mock_post.assert_not_called()

    def test_access_token_empty_when_refresh_fails(self):
        self.auth.save({"access_token": "old", "refresh_token": "rt",
                        "expires_in": 100, "obtained_at": 0})
        fake_post, _ = self._capture({"status": 401, "body": {"error": "invalid_grant"}})
        with patch.object(companion_api.requests, "post", side_effect=fake_post):
            self.assertEqual(self.auth.access_token(), "")


class CapiClientTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.auth = CompanionAuth(os.path.join(self.tmp.name, "capi.json"))

    def tearDown(self):
        self.tmp.cleanup()

    class _Resp:
        def __init__(self, status, body):
            self.status_code = status
            self._body = body

        def json(self):
            return self._body

    def test_profile_request_uses_bearer(self):
        import time as _time
        self.auth.save({"access_token": "tok", "expires_in": 14400, "obtained_at": _time.time()})
        seen = {}

        def fake_get(url, headers=None, timeout=None):
            seen["url"] = url
            seen["headers"] = headers
            return CapiClientTests._Resp(200, {"commander": {"name": "Jameson"}})

        with patch.object(companion_api.requests, "get", side_effect=fake_get):
            profile = CompanionClient(self.auth).get_profile()

        self.assertEqual(profile["commander"]["name"], "Jameson")
        self.assertEqual(seen["url"], f"{companion_api.CAPI_BASE}/profile")
        self.assertEqual(seen["headers"]["Authorization"], "Bearer tok")

    def test_422_triggers_refresh_once(self):
        import time as _time
        self.auth.save({"access_token": "tok", "refresh_token": "rt",
                        "expires_in": 14400, "obtained_at": _time.time()})
        calls = []

        def fake_get(url, headers=None, timeout=None):
            calls.append(headers["Authorization"])
            status = 422 if len(calls) == 1 else 200
            return CapiClientTests._Resp(status, {"ok": True})

        def fake_post(url, data=None, headers=None, timeout=None):
            return CapiClientTests._Resp(200, {"access_token": "tok2", "expires_in": 14400})

        with patch.object(companion_api.requests, "get", side_effect=fake_get), \
             patch.object(companion_api.requests, "post", side_effect=fake_post):
            CompanionClient(self.auth).get_profile()

        self.assertEqual(calls, ["Bearer tok", "Bearer tok2"])

    def test_no_token_raises_friendly_error(self):
        with self.assertRaises(CompanionAuthError):
            CompanionClient(self.auth).get_profile()


class ProfileToStatsTests(unittest.TestCase):
    PROFILE = {
        "commander": {"name": "Cmdr Test"},
        "credits": 1234567,
        "arx": 4200,
        "rank": {"combat": 5, "trade": 3, "explore": 4, "soldier": 7,
                 "exobiologist": 2, "empire": 1, "federation": 8},
        "statistics": {
            "bank_account": {"current_wealth": 999},
            "exploration": {"systems_scanned": 1200, "planets_scanned_to_level_3": 300,
                            "first_footfalls": 77, "efficiency_score": 99,
                            "highest_payout": 500000},
            "exobiology": {"organic_data_count": 55, "organic_species_encountered": 18,
                           "organic_data_profits": 12000000},
            "combat": {"combat_bond_profits": 314159},
        },
        "ship": "Type-9 Heavy",
        "ship_name": "Mule",
        "last_system": {"name": "Sol"},
        "last_station": {"name": "Daedalus"},
    }

    def test_maps_credits_and_ranks(self):
        stats = profile_to_stats(self.PROFILE)
        self.assertEqual(stats["cmdr"], "Cmdr Test")
        self.assertEqual(stats["credits"], 1234567)
        self.assertEqual(stats["arx"], 4200)
        self.assertEqual(stats["mercenary_rank"], 7)
        self.assertEqual(stats["exobiologist_rank"], 2)
        self.assertEqual(stats["combat_rank"], 5)
        self.assertEqual(stats["mercenary_coins"], 314159)

    def test_maps_bio_and_exploration(self):
        stats = profile_to_stats(self.PROFILE)
        self.assertEqual(stats["bio_samples_count"], 55)
        self.assertEqual(stats["bio_species_count"], 18)
        self.assertEqual(stats["bio_value_cr"], 12000000)
        self.assertEqual(stats["first_mapped_count"], 300)
        self.assertEqual(stats["first_footfalls_count"], 77)

    def test_maps_location_and_ship(self):
        stats = profile_to_stats(self.PROFILE)
        self.assertEqual(stats["current_ship"], "Type-9 Heavy (Mule)")
        self.assertEqual(stats["current_system"], "Sol")
        self.assertEqual(stats["current_station"], "Daedalus")

    def test_drops_empty_values(self):
        stats = profile_to_stats({"commander": {"name": "Solo"}})
        self.assertEqual(stats, {"cmdr": "Solo"})

    def test_garbage_input_is_safe(self):
        self.assertEqual(profile_to_stats(None), {})
        self.assertEqual(profile_to_stats("nope"), {})

    def test_payload_matches_site_stats_api_fields(self):
        # Сайт пишет эти поля в pilot_stats — расхождение приведёт к тихой
        # потере данных, поэтому сверяем имена со схемой миграции.
        stats = profile_to_stats(self.PROFILE)
        allowed = {
            "cmdr", "credits", "arx", "mercenary_coins", "mercenary_rank",
            "exobiologist_rank", "combat_rank", "trade_rank", "explore_rank",
            "empire_rank", "federation_rank", "first_discoveries_count",
            "first_mapped_count", "first_footfalls_count", "bio_samples_count",
            "bio_species_count", "bio_value_cr", "exploration_stats",
            "current_ship", "current_system", "current_station",
        }
        self.assertEqual(set(stats.keys()) - allowed, set())


if __name__ == "__main__":
    unittest.main()
