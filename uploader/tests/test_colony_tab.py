"""Тесты вкладки «Колонизатор» и Raven Colonial API.

Проверяем то, что легко сломать и дорого проверять вручную:

* клиент Raven Colonial ходит ровно по тем методам и путям, что описаны в
  официальной документации (`/about`): PUT /api/project, PATCH для правки,
  POST .../complete, PUT|DELETE /api/cmdr/{cmdr}/primary;
* имена командиров и товаров экранируются в пути;
* без ключа RCC запрос не уходит вообще;
* разбор строк «товары:количество» и извлечение проектов/основного проекта
  из ответов Raven Colonial.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


class _FakeResponse:
    def __init__(self, payload=None, ok=True, status=200, text=""):
        self._payload = payload
        self.ok = ok
        self.status_code = status
        self.text = text or (str(payload) if payload is not None else "")

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class CommanderByKeyTests(unittest.TestCase):
    """Имя пилота по ключу RCC: GET /api/cmdr/ с заголовком rcc-key."""

    def setUp(self):
        from raven_colonial_api import RavenColonialAPI

        self.api = RavenColonialAPI("test-key")
        self.api._session = mock.MagicMock()
        self.calls = []

        def record(method, url, headers=None, json=None, timeout=None):
            self.calls.append({"method": method.upper(), "url": url,
                               "headers": headers or {}, "json": json})
            return _FakeResponse({"displayName": "Jameson", "cmdrId": "1234"})

        self.api._session.request.side_effect = record

    def test_endpoint_and_header(self):
        result = self.api.get_cmdr_by_key("candidate-key")
        self.assertTrue(result["ok"])
        call = self.calls[0]
        self.assertEqual(call["method"], "GET")
        self.assertTrue(call["url"].endswith("/api/cmdr/"), call["url"])
        self.assertEqual(call["headers"].get("rcc-key"), "candidate-key")

    def test_uses_current_key_when_not_passed(self):
        self.api.get_cmdr_by_key()
        self.assertEqual(self.calls[0]["headers"].get("rcc-key"), "test-key")

    def test_no_key_means_no_request(self):
        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("")
        api._session = mock.MagicMock()
        result = api.get_cmdr_by_key("")
        self.assertFalse(result["ok"])
        self.assertIn("не задан", result["error"])
        api._session.request.assert_not_called()

    def test_bad_key_is_reported(self):
        self.api._session.request.side_effect = None
        self.api._session.request.return_value = _FakeResponse(
            None, ok=False, status=401, text="")
        result = self.api.get_cmdr_by_key("bad")
        self.assertFalse(result["ok"])
        self.assertIn("401", result["error"])

    def test_display_name_extraction(self):
        from raven_colonial_api import RavenColonialAPI

        self.assertEqual(
            RavenColonialAPI.cmdr_display_name({"data": {"displayName": "Jameson"}}),
            "Jameson")
        self.assertEqual(
            RavenColonialAPI.cmdr_display_name({"data": {"name": "  Jameson  "}}),
            "Jameson")
        self.assertEqual(RavenColonialAPI.cmdr_display_name({"data": "Jameson"}),
                         "Jameson")
        self.assertEqual(RavenColonialAPI.cmdr_display_name({"data": {}}), "")
        self.assertEqual(RavenColonialAPI.cmdr_display_name({}), "")
        self.assertEqual(RavenColonialAPI.cmdr_display_name(None), "")

    def test_network_error_is_not_raised(self):
        self.api._session.request.side_effect = RuntimeError("timeout")
        result = self.api.get_cmdr_by_key()
        self.assertFalse(result["ok"])
        self.assertIn("timeout", result["error"])


class ErrorDescriptionTests(unittest.TestCase):
    """Пустое тело ответа больше не превращается в «неизвестную ошибку»."""

    def setUp(self):
        from raven_colonial_api import RavenColonialAPI

        self.api = RavenColonialAPI("test-key")
        self.api._session = mock.MagicMock()
        self.calls = []

        def record(method, url, headers=None, json=None, timeout=None):
            self.calls.append({"method": method.upper(), "url": url})
            return _FakeResponse(None, ok=False, status=self.status, text=self.body)

        self.api._session.request.side_effect = record

    def _error(self, status, body=""):
        self.status, self.body = status, body
        return self.api.get_cmdr_active("CMDR")["error"]

    def test_empty_body_is_explained_by_status(self):
        for status, needle in ((400, "неверный запрос"), (401, "ключ RCC"),
                               (403, "нет прав"), (404, "не найдено"),
                               (409, "конфликт"), (429, "слишком много запросов"),
                               (500, "ошибка сервера"), (503, "недоступен")):
            error = self._error(status)
            self.assertIn(needle, error, status)
            self.assertIn(str(status), error, status)
            self.assertNotIn("неизвестная ошибка", error)

    def test_server_message_is_appended(self):
        error = self._error(400, "buildName is required")
        self.assertIn("buildName is required", error)

    def test_unknown_status_still_says_something(self):
        error = self._error(418)
        self.assertIn("418", error)
        self.assertTrue(error.strip())


class RavenColonialApiTests(unittest.TestCase):
    def setUp(self):
        from raven_colonial_api import RavenColonialAPI

        self.api = RavenColonialAPI("test-key")
        self.api._session = mock.MagicMock()
        self.calls = []

        def record(method, url, headers=None, json=None, timeout=None):
            self.calls.append({"method": method.upper(), "url": url, "json": json,
                               "headers": headers or {}})
            return _FakeResponse({"buildId": "abc-123"})

        self.api._session.request.side_effect = record

    # -- создание / правка / завершение -----------------------------------
    def test_create_project_uses_put_and_key(self):
        result = self.api.create_project({
            "systemName": "Sol", "buildName": "Alpha", "buildType": "Coriolis",
            "marketId": 123, "systemAddress": 456, "notes": None,
        })
        self.assertTrue(result["ok"])
        call = self.calls[0]
        self.assertEqual(call["method"], "PUT")
        self.assertTrue(call["url"].endswith("/api/project/"))
        self.assertEqual(call["headers"]["rcc-key"], "test-key")
        # None-поля не должны уезжать на сервер: PATCH-подобный merge ломается
        # от явных null'ов.
        self.assertEqual(call["json"], {"systemName": "Sol", "buildName": "Alpha",
                                        "buildType": "Coriolis", "marketId": 123,
                                        "systemAddress": 456})

    def test_create_project_requires_api_fields(self):
        """Обязательные поля ProjectCreate — marketId, systemAddress, buildName.

        Без них Raven отвечает 400, а в логе это выглядит как «неизвестная
        ошибка». Проверяем их до запроса и называем конкретные поля.
        """
        result = self.api.create_project({"systemName": "Sol", "buildType": "Coriolis"})
        self.assertFalse(result["ok"])
        self.assertEqual(self.calls, [])  # запрос не уходил
        for field in ("marketId", "systemAddress", "buildName"):
            self.assertIn(field, result["error"])

        # Одного marketId мало: без systemAddress проект создать нельзя.
        result = self.api.create_project({"buildName": "Alpha", "marketId": 1})
        self.assertFalse(result["ok"])
        self.assertIn("systemAddress", result["error"])
        self.assertEqual(self.calls, [])

    def test_project_page_url(self):
        """После создания проект открывается как ravencolonial.com/#build=..."""
        from raven_colonial_api import project_url, system_url

        self.assertEqual(project_url("abc-123"), "https://ravencolonial.com/#build=abc-123")
        self.assertEqual(system_url("Arietis Sector AG-W b2-1"),
                         "https://ravencolonial.com/#sys=Arietis%20Sector%20AG-W%20b2-1")

    def test_update_project_uses_patch(self):
        self.api.update_project("abc-123", {"buildName": "Beta", "maxNeed": None})
        call = self.calls[0]
        self.assertEqual(call["method"], "PATCH")
        self.assertTrue(call["url"].endswith("/api/project/abc-123"))
        self.assertEqual(call["json"], {"buildName": "Beta"})

    def test_mark_complete_is_post(self):
        self.api.mark_complete("abc-123")
        self.assertEqual(self.calls[0]["method"], "POST")
        self.assertTrue(self.calls[0]["url"].endswith("/api/project/abc-123/complete"))

    # -- основной проект ---------------------------------------------------
    def test_set_primary(self):
        """buildId идёт в пути, тело пустое.

        Раньше отправлялся PUT /cmdr/{cmdr}/primary с JSON-строкой в теле —
        сервер отвечал отказом с пустым телом, а UI показывал
        «неизвестная ошибка».
        """
        self.api.set_primary("CMDR Name", "abc-123")
        call = self.calls[0]
        self.assertEqual(call["method"], "PUT")
        self.assertTrue(
            call["url"].endswith("/api/cmdr/CMDR%20Name/primary/abc-123"), call["url"])
        self.assertIsNone(call["json"])

    def test_set_primary_rejects_empty_arguments(self):
        self.assertFalse(self.api.set_primary("", "abc-123")["ok"])
        self.assertFalse(self.api.set_primary("CMDR Name", "")["ok"])
        self.assertEqual(self.calls, [])

    def test_clear_primary(self):
        self.api.clear_primary("CMDR Name")
        self.assertEqual(self.calls[0]["method"], "DELETE")
        self.assertTrue(
            self.calls[0]["url"].endswith("/api/cmdr/CMDR%20Name/primary/"),
            self.calls[0]["url"])

    def test_get_primary(self):
        self.api.get_primary("cmdr")
        self.assertEqual(self.calls[0]["method"], "GET")
        self.assertTrue(self.calls[0]["url"].endswith("/api/cmdr/cmdr/primary"))

    # -- связи -------------------------------------------------------------
    def test_link_and_unlink_cmdr(self):
        self.api.link_cmdr("abc-123", "CMDR Name", True)
        self.assertEqual(self.calls[0]["method"], "PUT")
        self.assertTrue(self.calls[0]["url"].endswith("/api/project/abc-123/link/CMDR%20Name"))
        self.api.link_cmdr("abc-123", "CMDR Name", False)
        self.assertEqual(self.calls[1]["method"], "DELETE")

    def test_assign_commodity_escapes_names(self):
        self.api.assign_commodity("abc-123", "CMDR Name", "liquid oxygen", True)
        call = self.calls[0]
        self.assertEqual(call["method"], "PUT")
        self.assertTrue(call["url"].endswith("/api/project/abc-123/assign/CMDR%20Name/liquid%20oxygen"))

    def test_set_ready(self):
        self.api.set_ready("abc-123", ["steel", "aluminium"], True)
        call = self.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertTrue(call["url"].endswith("/api/project/abc-123/ready"))
        self.assertEqual(call["json"], ["steel", "aluminium"])

    def test_get_cmdr_active(self):
        self.api.get_cmdr_active("CMDR Name")
        self.assertTrue(self.calls[0]["url"].endswith("/api/cmdr/CMDR%20Name/active"))

    def test_empty_cmdr_is_rejected_without_request(self):
        result = self.api.get_cmdr_active("")
        self.assertFalse(result["ok"])
        self.assertEqual(self.calls, [])

    # -- ключ и ошибки -----------------------------------------------------
    def test_missing_key_blocks_write_without_request(self):
        self.api.api_key = ""
        result = self.api.create_project({"systemName": "Sol"})
        self.assertFalse(result["ok"])
        self.assertIn("RCC", result["error"])
        self.assertEqual(self.calls, [])

    def test_error_response_is_reported(self):
        self.api._session.request.side_effect = None
        self.api._session.request.return_value = _FakeResponse(
            {"message": "bad request"}, ok=False, status=400
        )
        result = self.api.update_project("abc-123", {"buildName": "X"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], 400)
        self.assertIn("bad request", result["error"])

    def test_network_failure_is_not_raised(self):
        self.api._session.request.side_effect = RuntimeError("connection reset")
        result = self.api.get_project_by_id("abc-123")
        self.assertFalse(result["ok"])
        self.assertIn("connection reset", result["error"])


class ColonyHelperTests(unittest.TestCase):
    """Статические помощники вкладки (без создания окна)."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(HERE))
        from test_initial_upload_flow import install_gui_stubs

        install_gui_stubs()
        import colonial_helper  # noqa: E402

        cls.app_cls = colonial_helper.ColonialHelperApp

    def test_commodities_parser(self):
        parse = self.app_cls._parse_commodities
        self.assertEqual(parse("aluminium:1200, steel:900"),
                         {"aluminium": 1200, "steel": 900})
        self.assertEqual(parse(""), {})
        self.assertEqual(parse("steel"), {})          # без количества — пропускаем
        self.assertEqual(parse("Steel:10"), {"steel": 10})  # товары в нижнем регистре
        self.assertEqual(parse("a:1, b:oops, c:3"), {"a": 1, "c": 3})

    def test_project_progress(self):
        progress = self.app_cls._project_progress
        self.assertEqual(progress({"sumNeed": 50, "sumTotal": 100}), "50 / 100 (50%)")
        self.assertEqual(progress({"sumNeed": 0, "sumTotal": 0}), "0")
        self.assertEqual(progress({}), "—")
        self.assertEqual(progress({"sumNeed": "x", "sumTotal": "y"}), "—")

    def test_extract_projects_from_various_shapes(self):
        extract = self.app_cls._extract_colony_projects
        projects = [{"buildId": "1"}, {"buildId": "2"}]
        self.assertEqual(extract(projects), projects)
        self.assertEqual(extract({"projects": projects}), projects)
        self.assertEqual(extract({"buildId": "1"}), [{"buildId": "1"}])
        self.assertEqual(extract(None), [])
        self.assertEqual(extract([{"no_id": True}]), [])

    def test_extract_primary_id(self):
        extract = self.app_cls._extract_primary_id
        self.assertEqual(extract({"ok": True, "data": {"primaryBuildId": "abc"}}), "abc")
        self.assertEqual(extract({"ok": True, "data": {"buildId": "abc"}}), "abc")
        self.assertEqual(extract({"ok": True, "data": '"abc"'}), "abc")
        self.assertEqual(extract({"ok": False}), "")


if __name__ == "__main__":
    unittest.main()
