"""Регрессии привязки Frontier CAPI: «подключилось, а досье не обновляется».

Что именно проверяется и почему это здесь:

* **`audience`.** С `audience=frontier` пилот со Steam/Epic получает токен
  учётки магазина, за которой игра не числится: OAuth проходит, `/me`
  отвечает, а `companion.orerve.net/profile` возвращает
  `400 Please Visit the store to purchase Elite: Dangerous`. EDMC запрашивает
  `frontier,steam,epic` — здесь то же самое по умолчанию.
* **User-Agent.** Frontier просит формат `EDCD-[A-Za-z]+-[.0-9]+`.
* **Разбор ошибок.** «HTTP 400» в статусе ничего не объясняет; пользователь
  должен видеть причину и что делать.
* **Проверка связи.** Зелёный статус обязан появляться только после реального
  ответа CAPI, иначе привязка выглядит рабочей, не будучи ею.
* **`self.api_client`.** Такого атрибута у приложения нет (клиент живёт в
  `self.api`), из-за чего поток досье падал с AttributeError уже ПОСЛЕ
  успешного запроса к Frontier.
"""

import json
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
# Соседние тесты (`install_gui_stubs`) импортируются по имени модуля — при
# запуске пакетом `python -m unittest tests.test_capi_link` каталог тестов
# сам по себе в sys.path не попадает.
sys.path.insert(0, str(HERE))

import companion_api
from companion_api import (
    CAPI_BASE,
    CAPI_LEGACY_BASE,
    DEFAULT_AUDIENCE,
    CompanionAuth,
    CompanionAuthError,
    CompanionClient,
    build_auth_url,
    capi_user_agent,
    describe_capi_error,
    normalize_audience,
    profile_to_stats,
)


class _Resp:
    """Минимальный ответ requests: статус, тело, json()."""

    def __init__(self, status, body=None, text=""):
        self.status_code = status
        self._body = body
        self.text = text if text else (json.dumps(body) if body is not None else "")

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class AudienceTests(unittest.TestCase):
    """Платформа аккаунта — главная причина HTTP 400 у CAPI."""

    def test_default_is_the_edmc_list(self):
        self.assertEqual(DEFAULT_AUDIENCE, "frontier,steam,epic")
        for value in ("", None, "auto", "all", "   "):
            self.assertEqual(normalize_audience(value), DEFAULT_AUDIENCE)

    def test_explicit_platform_is_kept(self):
        self.assertEqual(normalize_audience("steam"), "steam")
        self.assertEqual(normalize_audience("EPIC"), "epic")
        self.assertEqual(normalize_audience("psn"), "psn")

    def test_lists_are_cleaned_and_deduplicated(self):
        self.assertEqual(normalize_audience("steam, frontier ,steam"), "steam,frontier")
        self.assertEqual(normalize_audience("steam,garbage"), "steam")

    def test_unknown_value_falls_back_to_default(self):
        self.assertEqual(normalize_audience("nintendo"), DEFAULT_AUDIENCE)

    def test_auth_url_asks_for_all_platforms_by_default(self):
        url = build_auth_url("cid", "http://127.0.0.1:1/", "ch", "st")
        self.assertIn("audience=frontier%2Csteam%2Cepic", url)

    def test_auth_url_honours_explicit_platform(self):
        url = build_auth_url("cid", "http://127.0.0.1:1/", "ch", "st", audience="steam")
        self.assertIn("audience=steam", url)
        self.assertNotIn("%2C", url.split("audience=")[1].split("&")[0])


class UserAgentTests(unittest.TestCase):
    """Frontier требует `EDCD-[A-Za-z]+-[.0-9]+`."""

    def test_matches_frontier_pattern(self):
        self.assertRegex(capi_user_agent("2.12.0"), r"^EDCD-[A-Za-z]+-[.0-9]+$")

    def test_letters_are_stripped_from_version(self):
        self.assertEqual(capi_user_agent("v2.13.0-beta"), "EDCD-ColonialHelper-2.13.0")

    def test_empty_version_is_safe(self):
        self.assertRegex(capi_user_agent("dev"), r"^EDCD-ColonialHelper-[.0-9]+$")


class CapiErrorDescriptionTests(unittest.TestCase):
    def test_400_about_purchase_explains_the_wrong_account(self):
        message, hint = describe_capi_error(
            400, "Please Visit the store to purchase Elite: Dangerous.", "/profile")
        self.assertIn("не видит купленную Elite Dangerous", message)
        self.assertIn("Steam", hint)
        self.assertIn("Epic", hint)

    def test_plain_400_mentions_platform_and_the_epic_bug(self):
        message, hint = describe_capi_error(400, "", "/profile")
        self.assertIn("400", message)
        self.assertIn("Epic", hint)

    def test_known_statuses_are_translated(self):
        self.assertIn("техобслуживании", describe_capi_error(418)[0])
        self.assertIn("частоту запросов", describe_capi_error(429)[0])
        self.assertIn("не вернул данных", describe_capi_error(204, "", "/journal")[0])
        self.assertIn("временно недоступен", describe_capi_error(503)[0])
        self.assertIn("токен", describe_capi_error(401)[0].lower())


class CapiRequestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.auth = CompanionAuth(os.path.join(self.tmp.name, "capi.json"))
        self.auth.save({"access_token": "tok", "expires_in": 14400,
                        "obtained_at": time.time()})

    def test_request_sends_edcd_user_agent(self):
        seen = {}

        def fake_get(url, headers=None, timeout=None):
            seen.update(headers or {})
            return _Resp(200, {"commander": {"name": "Jameson"}})

        with mock.patch.object(companion_api.requests, "get", side_effect=fake_get):
            CompanionClient(self.auth).get_profile()

        self.assertRegex(seen["User-Agent"], r"^EDCD-[A-Za-z]+-[.0-9]+$")
        self.assertEqual(seen["Authorization"], "Bearer tok")

    def test_400_reports_the_real_reason_not_just_the_code(self):
        def fake_get(url, headers=None, timeout=None):
            return _Resp(400, None, "Please Visit the store to purchase Elite: Dangerous.")

        with mock.patch.object(companion_api.requests, "get", side_effect=fake_get):
            with self.assertRaises(CompanionAuthError) as ctx:
                CompanionClient(self.auth).get_profile()

        exc = ctx.exception
        self.assertEqual(exc.status, 400)
        self.assertEqual(exc.endpoint, "/profile")
        self.assertIn("Elite Dangerous", str(exc))
        self.assertIn("Steam", exc.hint)
        self.assertTrue(exc.needs_relink)

    def test_400_on_live_falls_back_to_the_legacy_galaxy(self):
        hosts = []

        def fake_get(url, headers=None, timeout=None):
            hosts.append(url)
            if url.startswith(CAPI_BASE):
                return _Resp(400, None, "Bad Request")
            return _Resp(200, {"commander": {"name": "Legacy CMDR"}})

        with mock.patch.object(companion_api.requests, "get", side_effect=fake_get):
            client = CompanionClient(self.auth)
            profile = client.get_profile()

        self.assertEqual(profile["commander"]["name"], "Legacy CMDR")
        self.assertEqual(client.last_host, CAPI_LEGACY_BASE)
        self.assertEqual(hosts, [f"{CAPI_BASE}/profile", f"{CAPI_LEGACY_BASE}/profile"])

    def test_legacy_failure_keeps_the_live_explanation(self):
        def fake_get(url, headers=None, timeout=None):
            return _Resp(400, None, "Please Visit the store to purchase Elite: Dangerous.")

        with mock.patch.object(companion_api.requests, "get", side_effect=fake_get):
            with self.assertRaises(CompanionAuthError) as ctx:
                CompanionClient(self.auth).get_profile()

        self.assertEqual(ctx.exception.host, CAPI_BASE)
        self.assertIn("не видит купленную", str(ctx.exception))

    def test_maintenance_is_not_a_broken_link(self):
        with mock.patch.object(companion_api.requests, "get",
                               side_effect=lambda *a, **k: _Resp(418, None, "teapot")):
            with self.assertRaises(CompanionAuthError) as ctx:
                CompanionClient(self.auth).get_profile()
        self.assertFalse(ctx.exception.needs_relink)


class VerifyLinkTests(unittest.TestCase):
    """«Токен сохранён» ≠ «связь работает»."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.auth = CompanionAuth(os.path.join(self.tmp.name, "capi.json"))
        self.auth.save({"access_token": "tok", "expires_in": 14400,
                        "obtained_at": time.time()})

    def test_success_marks_the_link_verified(self):
        profile = {"commander": {"name": "Jameson", "credits": 100,
                                 "rank": {"combat": 3}}}
        with mock.patch.object(companion_api.requests, "get",
                               side_effect=lambda *a, **k: _Resp(200, profile)):
            result = CompanionClient(self.auth).verify()

        self.assertTrue(result["ok"])
        self.assertEqual(result["cmdr"], "Jameson")
        state = self.auth.status()
        self.assertTrue(state["verified"])
        self.assertEqual(state["cmdr"], "Jameson")
        self.assertEqual(state["error"], "")

    def test_failure_is_remembered_with_a_hint(self):
        with mock.patch.object(
                companion_api.requests, "get",
                side_effect=lambda *a, **k: _Resp(
                    400, None, "Please Visit the store to purchase Elite: Dangerous.")):
            result = CompanionClient(self.auth).verify()

        self.assertFalse(result["ok"])
        state = self.auth.status()
        self.assertTrue(state["linked"])          # токен на месте…
        self.assertFalse(state["verified"])       # …но связь не подтверждена
        self.assertIn("Elite Dangerous", state["error"])
        self.assertIn("Steam", state["hint"])

    def test_empty_profile_is_not_a_success(self):
        with mock.patch.object(companion_api.requests, "get",
                               side_effect=lambda *a, **k: _Resp(200, {})):
            result = CompanionClient(self.auth).verify()

        self.assertFalse(result["ok"])
        self.assertIn("пустой профиль", result["error"])
        self.assertFalse(self.auth.status()["verified"])

    def test_status_of_a_fresh_install(self):
        auth = CompanionAuth(os.path.join(self.tmp.name, "none.json"))
        state = auth.status()
        self.assertFalse(state["linked"])
        self.assertFalse(state["verified"])

    def test_update_keeps_the_tokens(self):
        self.auth.update(last_error="boom")
        tokens = self.auth.load()
        self.assertEqual(tokens["access_token"], "tok")
        self.assertEqual(tokens["last_error"], "boom")


class RealProfileShapeTests(unittest.TestCase):
    """Настоящий ответ CAPI: всё полезное лежит внутри `commander`/`lastSystem`."""

    PROFILE = {
        "commander": {
            "id": 12345,
            "name": "Hunter",
            "credits": 987654321,
            "debt": 0,
            "currentShipId": 4,
            "docked": True,
            "rank": {"combat": 6, "trade": 5, "explore": 8, "empire": 3,
                     "federation": 2, "cqc": 0, "soldier": 4, "exobiologist": 5},
        },
        "lastSystem": {"id": 17072, "name": "Shinrarta Dezhra"},
        "lastStarport": {"id": 128666762, "name": "Jameson Memorial"},
        "ship": {"name": "CobraMkIII", "shipName": "Ring Runner", "shipID": "RC-01",
                 "starsystem": {"name": "Shinrarta Dezhra"},
                 "station": {"name": "Jameson Memorial"}},
    }

    def test_credits_and_ranks_come_from_commander(self):
        stats = profile_to_stats(self.PROFILE)
        self.assertEqual(stats["cmdr"], "Hunter")
        self.assertEqual(stats["credits"], 987654321)
        self.assertEqual(stats["combat_rank"], 6)
        self.assertEqual(stats["explore_rank"], 8)
        self.assertEqual(stats["mercenary_rank"], 4)
        self.assertEqual(stats["exobiologist_rank"], 5)

    def test_ship_and_location_are_readable(self):
        stats = profile_to_stats(self.PROFILE)
        self.assertEqual(stats["current_ship"], "CobraMkIII (Ring Runner)")
        self.assertEqual(stats["current_system"], "Shinrarta Dezhra")
        self.assertEqual(stats["current_station"], "Jameson Memorial")

    def test_location_falls_back_to_the_ship_node(self):
        profile = {"commander": {"name": "Solo"},
                   "ship": {"name": "Anaconda",
                            "starsystem": {"name": "Sol"},
                            "station": {"name": "Abraham Lincoln"}}}
        stats = profile_to_stats(profile)
        self.assertEqual(stats["current_system"], "Sol")
        self.assertEqual(stats["current_station"], "Abraham Lincoln")
        self.assertEqual(stats["current_ship"], "Anaconda")

    def test_flat_legacy_shape_still_works(self):
        stats = profile_to_stats({"commander": {"name": "Old"}, "credits": 5,
                                  "rank": {"combat": 1}, "ship": "Sidewinder",
                                  "ship_name": "Kit", "last_system": {"name": "Eravate"}})
        self.assertEqual(stats["credits"], 5)
        self.assertEqual(stats["combat_rank"], 1)
        self.assertEqual(stats["current_ship"], "Sidewinder (Kit)")
        self.assertEqual(stats["current_system"], "Eravate")

    def test_zero_credits_survive(self):
        stats = profile_to_stats({"commander": {"name": "Broke", "credits": 0}})
        self.assertEqual(stats["credits"], 0)


class AppDossierFlowTests(unittest.TestCase):
    """Поведение приложения вокруг кнопки «Обновить досье» (без настоящего Tk)."""

    @classmethod
    def setUpClass(cls):
        from test_initial_upload_flow import install_gui_stubs
        install_gui_stubs()
        import colonial_helper
        cls.module = colonial_helper
        cls.App = colonial_helper.ColonialHelperApp

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = self.App.__new__(self.App)
        self.app.config = {}
        self.app.log = mock.Mock()
        self.app.capi_status = None
        self.app._capi_set_status = mock.Mock()
        self.app.root = mock.Mock()
        # root.after(delay, fn, *args) в тесте выполняется сразу.
        self.app.root.after = lambda _delay, fn=None, *args: fn(*args) if fn else None
        self.app.capi_auth = CompanionAuth(os.path.join(self.tmp.name, "capi.json"))
        self.app.capi_auth.save({"access_token": "tok", "expires_in": 14400,
                                 "obtained_at": time.time()})
        self.app.api = mock.Mock()
        self.app.api.is_connected = True
        self.app.api.upload_pilot_stats.return_value = {"ok": True}

    def _run_fetch(self, response):
        """Прогнать `_capi_fetch_and_upload` синхронно."""
        threads = []

        class _Thread:
            def __init__(self, target=None, daemon=None, name=None):
                self._target = target

            def start(self):
                threads.append(self._target)
                self._target()

        with mock.patch.object(companion_api.requests, "get",
                               side_effect=lambda *a, **k: response), \
             mock.patch.object(self.module.threading, "Thread", _Thread):
            self.app._capi_fetch_and_upload()
        self.assertTrue(threads, "рабочий поток досье не запускался")

    def test_api_client_alias_points_at_the_real_client(self):
        # Регрессия: раньше self.api_client не существовал и поток досье падал
        # с AttributeError уже после успешного ответа Frontier.
        self.assertIs(self.app.api_client, self.app.api)

    def test_successful_profile_is_uploaded_to_the_site(self):
        profile = {"commander": {"name": "Hunter", "credits": 10,
                                 "rank": {"combat": 2}},
                   "lastSystem": {"name": "Sol"}}
        self._run_fetch(_Resp(200, profile))

        self.app.api.upload_pilot_stats.assert_called_once()
        stats, cmdr = self.app.api.upload_pilot_stats.call_args.args
        self.assertEqual(cmdr, "Hunter")
        self.assertEqual(stats["credits"], 10)
        self.assertEqual(stats["current_system"], "Sol")
        status_text, kwargs = (self.app._capi_set_status.call_args.args,
                               self.app._capi_set_status.call_args.kwargs)
        self.assertTrue(kwargs.get("ok"))
        self.assertIn("Досье обновлено", status_text[0])
        self.assertTrue(self.app.capi_auth.status()["verified"])

    def test_http_400_shows_the_cause_and_skips_the_upload(self):
        self._run_fetch(_Resp(400, None, "Please Visit the store to purchase Elite: Dangerous."))

        self.app.api.upload_pilot_stats.assert_not_called()
        text = self.app._capi_set_status.call_args.args[0]
        self.assertIn("Досье не обновлено", text)
        self.assertIn("Elite Dangerous", text)
        self.assertIn("Steam", text)          # подсказка «выберите платформу»
        self.assertFalse(self.app._capi_set_status.call_args.kwargs.get("ok"))
        self.assertFalse(self.app.capi_auth.status()["verified"])

    def test_status_line_separates_saved_token_from_working_link(self):
        self.app._capi_refresh_status()
        text = self.app._capi_set_status.call_args.args[0]
        self.assertIn("связь ещё не проверялась", text)

        self.app.capi_auth.mark_failed("Companion API отклонил запрос: HTTP 400",
                                       "Выберите платформу Steam")
        self.app._capi_refresh_status()
        text = self.app._capi_set_status.call_args.args[0]
        self.assertIn("не подтверждена", text)
        self.assertIn("Steam", text)

        self.app.capi_auth.mark_verified("Hunter")
        self.app._capi_refresh_status()
        text = self.app._capi_set_status.call_args.args[0]
        self.assertIn("проверен", text)
        self.assertIn("Hunter", text)

    def test_platform_choice_from_config_reaches_the_auth_url(self):
        self.app.config = {"frontier_audience": "steam", "frontier_client_id": "my-id"}
        self.app._apply_capi_config()
        self.assertEqual(self.app.capi_auth.audience, "steam")
        self.assertEqual(self.app.capi_auth.client_id, "my-id")

        self.app.config = {}
        self.app._apply_capi_config()
        self.assertEqual(self.app.capi_auth.audience, DEFAULT_AUDIENCE)

    def test_platform_selector_saves_the_choice(self):
        self.app.capi_audience_var = mock.Mock()
        self.app.capi_audience_var.get.return_value = "Только Epic Games"
        self.app.save_config = mock.Mock()

        self.app._on_capi_audience_changed()

        self.assertEqual(self.app.config["frontier_audience"], "epic")
        self.assertEqual(self.app.capi_auth.audience, "epic")
        self.app.save_config.assert_called_once()

    def test_audience_labels_cover_every_platform(self):
        keys = {key for key, _label in self.module.AUDIENCE_LABELS}
        self.assertEqual(keys, {"auto", "frontier", "steam", "epic", "xbox", "psn"})
        for key, _label in self.module.AUDIENCE_LABELS:
            self.assertTrue(normalize_audience(key))


if __name__ == "__main__":
    unittest.main()
