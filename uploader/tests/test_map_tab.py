"""Тесты вкладки «Карта системы» на уровне приложения.

Логика карты (проценты, раскладка) покрыта в `test_system_map.py`; здесь
проверяем связку «журнал → карта → холст/список», которую легко сломать,
не заметив:

* вкладка создаётся и стоит в блокноте после «Колонизатора»;
* события журнала доходят до сборщика карты и вызывают перерисовку;
* на холсте рисуются тела, стройплощадка с прогресс-баром и отметка «Вы здесь»;
* данные Raven Colonial подмешиваются в карту и обновляют процент завезённого;
* сеть не дёргается чаще порога и не дёргается вообще в историческом разборе;
* список объектов справа и строка состояния заполняются.
"""

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

SYSTEM = "HIP 22460"
ADDRESS = 123456789
SITE_MARKET = 3951663874
SITE_NAME = "Planetary Construction Site: A 1"
BODY_1 = f"{SYSTEM} A 1"

BUILD_ID = "5f1c2b90-0d3a-4d5c-9f2a-1e6b7c8d9e0f"


def location_event(**overrides):
    event = {
        "event": "Location",
        "timestamp": "2026-09-14T10:00:00Z",
        "StarSystem": SYSTEM,
        "SystemAddress": ADDRESS,
        "Docked": True,
        "StationName": SITE_NAME,
        "StationType": "PlanetaryInstallation",
        "MarketID": SITE_MARKET,
        "Body": BODY_1,
        "BodyID": 3,
        "BodyType": "Planet",
        "StationServices": ["colonisationcontribution", "commodities"],
        "Ship": "Type9",
        "ShipName": "HAUL-EWOK",
    }
    event.update(overrides)
    return event


def scan_events():
    return [
        {"event": "Scan", "timestamp": "2026-09-14T10:00:03Z", "BodyName": f"{SYSTEM} A",
         "BodyID": 1, "StarSystem": SYSTEM, "SystemAddress": ADDRESS, "StarType": "K",
         "DistanceFromArrivalLS": 0.0, "Radius": 5.9e8},
        {"event": "Scan", "timestamp": "2026-09-14T10:00:04Z", "BodyName": BODY_1,
         "BodyID": 3, "StarSystem": SYSTEM, "SystemAddress": ADDRESS,
         "Parents": [{"Star": 1}], "PlanetClass": "High metal content world",
         "DistanceFromArrivalLS": 12.4, "Radius": 7.4e6, "Landable": True},
        {"event": "SAAScanComplete", "timestamp": "2026-09-14T10:00:05Z",
         "BodyName": BODY_1, "BodyID": 3, "StarSystem": SYSTEM},
        {"event": "FSSDiscoveryScan", "timestamp": "2026-09-14T10:00:06Z",
         "StarSystem": SYSTEM, "SystemAddress": ADDRESS, "BodyCount": 9},
    ]


def depot_event(required=5000, provided=1000):
    return {
        "event": "ColonisationConstructionDepot",
        "timestamp": "2026-09-14T10:00:10Z",
        "MarketID": SITE_MARKET,
        "StarSystem": SYSTEM,
        "SystemAddress": ADDRESS,
        "ConstructionName": "A 1",
        "BodyNum": 3,
        "ConstructionProgress": 0.2,
        "ResourcesRequired": [{"Name": "$steel_name;", "Name_Localised": "Steel",
                               "RequiredAmount": required, "ProvidedAmount": provided}],
    }


class MapTabTestBase(unittest.TestCase):
    """Приложение с заглушками Tk и холстом известного размера."""

    def setUp(self):
        from test_initial_upload_flow import install_gui_stubs, make_root

        install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch", "journal_parser",
                     "overlay", "ship_tracker", "route_tracker", "game_monitor",
                     "exobiology", "colonisation", "carrier", "raven_colonial_api",
                     "system_map"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.root = make_root()

        import colonial_helper

        self.module = colonial_helper
        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)

        # Холст в заглушках имеет размер 1x1 — карта решила бы, что вкладка не
        # показана. Задаём реальный размер и список строк таблицы.
        self.app.map_canvas.winfo_width.return_value = 900
        self.app.map_canvas.winfo_height.return_value = 560
        self.app.map_tree.get_children.return_value = ()

    def tearDown(self):
        self.tmp.cleanup()

    def canvas_texts(self):
        """Все подписи, нарисованные на холсте."""
        return [str(call.kwargs.get("text"))
                for call in self.app.map_canvas.create_text.call_args_list]

    def canvas_shapes(self):
        canvas = self.app.map_canvas
        return {
            "oval": canvas.create_oval.call_count,
            "rectangle": canvas.create_rectangle.call_count,
            "polygon": canvas.create_polygon.call_count,
            "text": canvas.create_text.call_count,
        }


class MapTabBuildTests(MapTabTestBase):
    """Вкладка собрана и стоит там, где её ищет пользователь."""

    def test_tab_widgets_created(self):
        for attribute in ("tab_map", "map_canvas", "map_tree", "map_status", "map_hint",
                          "map_zoom_label", "map_system_label", "map_moons_var",
                          "map_labels_var"):
            self.assertTrue(hasattr(self.app, attribute), f"нет {attribute}")
        self.assertIsNotNone(self.app.system_map)

    def test_tab_added_after_colony(self):
        texts = [str(call.kwargs.get("text")) for call in self.app.notebook.add.call_args_list]
        self.assertIn(" Карта системы ", texts)
        self.assertLess(texts.index(" Колонизатор "), texts.index(" Карта системы "),
                        f"порядок вкладок: {texts}")

    def test_notebook_tab_changed_is_bound(self):
        bindings = [str(call.args[0]) for call in self.app.notebook.bind.call_args_list]
        self.assertIn("<<NotebookTabChanged>>", bindings)

    def test_status_shows_unknown_system_at_start(self):
        texts = [str(call.kwargs.get("text")) for call in self.app.map_status.config.call_args_list]
        self.assertTrue(any("Система неизвестна" in text for text in texts), texts[-3:])


class MapJournalFeedTests(MapTabTestBase):
    """События журнала доходят до карты и перерисовывают её."""

    def test_tracked_event_fills_map(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(), live=True)

        snapshot = self.app.system_map.snapshot()
        self.assertEqual(snapshot.system, SYSTEM)
        self.assertEqual(len(snapshot.bodies), 2)
        self.assertEqual(snapshot.known_body_count, 9)
        site = snapshot.sites[0]
        self.assertEqual(site.percent_delivered, 20)
        self.assertEqual(snapshot.player.ship_name, "HAUL-EWOK")

    def test_live_event_schedules_redraw(self):
        self.app._map_redraw_job = None
        self.app._handle_tracked_event(location_event(), live=True)
        self.assertIsNotNone(self.app._map_redraw_job, "перерисовка не запланирована")

    def test_historical_event_does_not_touch_network(self):
        with mock.patch.object(self.app.raven_api, "get_system_projects") as projects, \
             mock.patch.object(self.app, "_map_visible", return_value=False):
            self.app._handle_tracked_event(location_event(), live=False)
            self.app._feed_system_map({"event": "FSDJump", "StarSystem": "Другая",
                                       "SystemAddress": 2}, live=False)
        projects.assert_not_called()
        self.assertEqual(self.app.system_map.current_system, "Другая")

    def test_restore_from_journal_tail_fills_map(self):
        # Старт с уже открытым депо: новых событий не будет, карта берётся из хвоста.
        lines = [
            '{"timestamp":"2026-09-14T09:59:00Z","event":"FSDJump","StarSystem":"%s",'
            '"SystemAddress":%d}' % (SYSTEM, ADDRESS),
            '{"timestamp":"2026-09-14T09:59:30Z","event":"Scan","BodyName":"%s",'
            '"BodyID":3,"StarSystem":"%s","PlanetClass":"Rocky body",'
            '"DistanceFromArrivalLS":12.4}' % (BODY_1, SYSTEM),
            '{"timestamp":"2026-09-14T10:00:00Z","event":"Location","StarSystem":"%s",'
            '"SystemAddress":%d,"Docked":true,"StationName":"%s","MarketID":%d,'
            '"StationServices":["colonisationcontribution"],"Body":"%s","BodyID":3}'
            % (SYSTEM, ADDRESS, SITE_NAME, SITE_MARKET, BODY_1),
            '{"timestamp":"2026-09-14T10:00:10Z","event":"ColonisationConstructionDepot",'
            '"MarketID":%d,"StarSystem":"%s","ConstructionName":"A 1","BodyNum":3,'
            '"ResourcesRequired":[{"Name":"$steel_name;","RequiredAmount":5000,'
            '"ProvidedAmount":2500}]}' % (SITE_MARKET, SYSTEM),
        ]
        raw = ("\n".join(lines) + "\n").encode("utf-8")
        journal = self.home / "Journal.260914100000.01.log"
        journal.write_bytes(raw)

        with mock.patch.object(self.app, "log"):
            restored = self.app._restore_station_state_from_journal()

        snapshot = self.app.system_map.snapshot()
        self.assertEqual(snapshot.system, SYSTEM)
        self.assertEqual([body.name for body in snapshot.bodies], [BODY_1])
        self.assertEqual(snapshot.sites[0].percent_delivered, 50)
        self.assertTrue(restored["site"], "депо не восстановлено")

    def test_initial_import_hook_feeds_map(self):
        # Первичный импорт истории идёт своими хуками — карта должна быть в списке.
        source = Path(self.module.__file__).read_text(encoding="utf-8")
        self.assertIn("def map_hook(line, ev):", source)
        self.assertIn("self._feed_system_map(ev, live=False)", source)


class MapDrawingTests(MapTabTestBase):
    """Холст: тела, стройплощадка с прогресс-баром и отметка пилота."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(), live=True)
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()

    def test_bodies_and_site_are_drawn(self):
        self.prepare()
        shapes = self.canvas_shapes()
        self.assertGreater(shapes["oval"], 3, "тела не нарисованы")
        self.assertGreaterEqual(shapes["polygon"], 1, "стройплощадка не нарисована ромбом")
        texts = self.canvas_texts()
        self.assertIn(SYSTEM + " A", texts)
        self.assertIn(BODY_1, texts)
        self.assertIn("A 1", texts)
        self.assertIn("Вы здесь", texts)

    def test_progress_bar_shows_percent(self):
        self.prepare()
        texts = self.canvas_texts()
        self.assertIn("20%", texts, f"прогресс-бар не показал процент: {texts}")
        # Полоса: подложка и заполнение.
        self.assertGreaterEqual(self.app.map_canvas.create_rectangle.call_count, 2)

    def test_progress_bar_follows_delivered_cargo(self):
        self.prepare()
        self.app.map_canvas.reset_mock()
        self.app._handle_tracked_event(depot_event(required=5000, provided=4500), live=True)
        self.app._map_redraw_now()
        self.assertIn("90%", self.canvas_texts())

    def test_completed_site_shows_hundred(self):
        self.prepare()
        self.app.map_canvas.reset_mock()
        event = depot_event(required=5000, provided=5000)
        event["ConstructionComplete"] = True
        self.app._handle_tracked_event(event, live=True)
        self.app._map_redraw_now()
        self.assertIn("100%", self.canvas_texts())

    def test_labels_toggle(self):
        self.prepare()
        self.app.map_labels_var.set(False)
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        texts = self.canvas_texts()
        # Имена объектов и «Вы здесь» исчезают, а процент завезённого груза и
        # легенда остаются: без них карта теряет смысл.
        self.assertNotIn(BODY_1, texts)
        self.assertNotIn("A 1", texts)
        self.assertNotIn("Вы здесь", texts)
        self.assertIn("20%", texts)
        self.app.map_labels_var.set(True)
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        texts = self.canvas_texts()
        self.assertIn(BODY_1, texts)
        self.assertIn("Вы здесь", texts)

    def test_moons_toggle(self):
        self.app._handle_tracked_event(location_event(), live=True)
        self.app._handle_tracked_event(
            {"event": "Scan", "BodyName": f"{SYSTEM} A 2", "BodyID": 4, "StarSystem": SYSTEM,
             "Parents": [{"Star": 1}], "PlanetClass": "Class III gas giant",
             "DistanceFromArrivalLS": 812.0}, live=True)
        self.app._handle_tracked_event(
            {"event": "Scan", "BodyName": f"{SYSTEM} A 2 a", "BodyID": 5,
             "StarSystem": SYSTEM, "Parents": [{"Planet": 4}], "PlanetClass": "Icy body",
             "DistanceFromArrivalLS": 813.0}, live=True)
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        self.assertIn(f"{SYSTEM} A 2 a", self.canvas_texts())

        self.app.map_moons_var.set(False)
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        self.assertNotIn(f"{SYSTEM} A 2 a", self.canvas_texts())

    def test_zoom_buttons(self):
        self.prepare()
        before = self.app._map_zoom()
        self.app._on_map_zoom(1)
        self.assertGreater(self.app._map_zoom(), before)
        self.app._on_map_zoom(-1)
        self.assertEqual(self.app._map_zoom(), before)
        # Крайние положения не выходят за список шагов.
        for _ in range(10):
            self.app._on_map_zoom(-1)
        self.assertEqual(self.app._map_zoom_index, 0)
        for _ in range(20):
            self.app._on_map_zoom(1)
        self.assertEqual(self.app._map_zoom_index, len(self.app.MAP_ZOOM_STEPS) - 1)

    def test_wheel_zoom(self):
        self.prepare()
        index = self.app._map_zoom_index
        event = mock.Mock(delta=120, num=0)
        self.app._on_map_wheel(event)
        self.assertEqual(self.app._map_zoom_index, index + 1)
        event = mock.Mock(delta=-120, num=0)
        self.app._on_map_wheel(event)
        self.assertEqual(self.app._map_zoom_index, index)
        # Linux: колесо приходит кнопками 4/5.
        event = mock.Mock(delta=0, num=4)
        self.app._on_map_wheel(event)
        self.assertEqual(self.app._map_zoom_index, index + 1)

    def test_hidden_canvas_does_not_crash(self):
        self.prepare()
        self.app.map_canvas.winfo_width.return_value = 1
        self.app.map_canvas.reset_mock()
        self.app._draw_system_map()
        self.assertEqual(self.app.map_canvas.create_oval.call_count, 0)

    def test_click_selects_object_and_syncs_tree(self):
        self.prepare()
        # В настоящем Tk строки таблицы уже вставлены — повторим это в заглушке.
        iids = [str(call.kwargs.get("iid"))
                for call in self.app.map_tree.insert.call_args_list]
        self.app.map_tree.get_children.return_value = tuple(iids)
        items = self.app._map_items
        site = next(item for item in items
                    if item.label == "A 1" and item.kind == "station")
        event = mock.Mock(x=int(site.x), y=int(site.y))
        self.app._on_map_click(event)
        self.assertEqual(self.app._map_selected, site.ref.build_id or site.ref.name)
        self.app.map_tree.selection_set.assert_called()

    def test_hover_shows_hint(self):
        self.prepare()
        site = next(item for item in self.app._map_items
                    if item.label == "A 1" and item.kind == "station")
        self.app._on_map_hover(mock.Mock(x=int(site.x), y=int(site.y)))
        hints = [str(call.kwargs.get("text")) for call in self.app.map_hint.config.call_args_list]
        self.assertTrue(any("завезено 20%" in hint for hint in hints), hints[-3:])

    def test_tree_rows_and_status(self):
        self.prepare()
        iids = [str(call.kwargs.get("iid")) for call in self.app.map_tree.insert.call_args_list]
        self.assertTrue(any(iid.endswith(SITE_NAME) or "A 1" in iid for iid in iids), iids)
        self.assertTrue(any(iid.startswith("b:") for iid in iids), iids)
        values = [call.kwargs.get("values") for call in self.app.map_tree.insert.call_args_list]
        self.assertTrue(any("20%" in [str(item) for item in row] for row in values if row),
                        values)
        status = [str(call.kwargs.get("text"))
                  for call in self.app.map_status.config.call_args_list]
        self.assertTrue(any(SYSTEM in text and "строек" in text for text in status),
                        status[-2:])


class MapRavenTests(MapTabTestBase):
    """Raven Colonial: чужие доставки и планы площадок попадают на карту."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(required=5000, provided=1000), live=True)

    def projects_result(self, **overrides):
        project = {
            "buildId": BUILD_ID,
            "buildName": "A 1",
            "buildType": "PlanetaryInstallation",
            "marketId": SITE_MARKET,
            "bodyNum": 3,
            "sumTotal": 5000,
            "sumNeed": 1000,
            "commodities": {"steel": 1000},
        }
        project.update(overrides)
        return {"ok": True, "status": 200, "data": [project]}

    def sites_result(self):
        return {"ok": True, "status": 200, "data": {"sites": [
            {"id": "s-2", "name": "B 2", "buildType": "Orbis Starport", "bodyNum": 4,
             "bodyName": f"{SYSTEM} A 2", "status": "planned"},
        ]}}

    def test_raven_done_updates_percent(self):
        self.prepare()
        self.assertEqual(self.app.system_map.snapshot().sites[0].percent_delivered, 20)
        self.app._map_raven_done(SYSTEM, self.projects_result(), self.sites_result())
        snapshot = self.app.system_map.snapshot()
        site = snapshot.sites[0]
        self.assertEqual(site.percent_delivered, 80, "чужие доставки не учтены")
        self.assertEqual(site.build_id, BUILD_ID)
        planned = [station for station in snapshot.stations if station.planned]
        self.assertEqual([station.title for station in planned], ["B 2"])

    def test_raven_done_ignores_other_system(self):
        self.prepare()
        self.app._map_raven_done("Другая система", self.projects_result(), self.sites_result())
        self.assertEqual(self.app.system_map.snapshot().sites[0].percent_delivered, 20)

    def test_raven_error_shown_in_status(self):
        self.prepare()
        self.app._map_raven_done(SYSTEM, {"ok": False, "error": "нет ключа RCC"},
                                 {"ok": False, "error": "404"})
        status = [str(call.kwargs.get("text"))
                  for call in self.app.map_status.config.call_args_list]
        self.assertTrue(any("нет ключа RCC" in text for text in status), status[-2:])

    def test_extract_helpers(self):
        self.assertEqual(self.app._map_extract_projects([{"buildId": "x"}]), [{"buildId": "x"}])
        self.assertEqual(self.app._map_extract_projects({"projects": [{"buildId": "x"}]}),
                         [{"buildId": "x"}])
        self.assertEqual(self.app._map_extract_projects({"sumTotal": 5}), [{"sumTotal": 5}])
        self.assertEqual(self.app._map_extract_projects(None), [])
        self.assertEqual(self.app._map_extract_projects("мусор"), [])
        self.assertEqual(self.app._map_extract_plans({"sites": [{"id": 1}]}), [{"id": 1}])
        self.assertEqual(self.app._map_extract_plans([{"id": 1}]), [{"id": 1}])
        self.assertEqual(self.app._map_extract_plans(None), [])

    def test_refresh_is_throttled(self):
        self.prepare()
        self.app.raven_api._key = "rcc-key"
        with mock.patch.object(type(self.app.raven_api), "is_connected",
                               new_callable=mock.PropertyMock, return_value=True), \
             mock.patch.object(self.app.raven_api, "get_system_projects",
                               return_value=self.projects_result()) as projects, \
             mock.patch.object(self.app.raven_api, "get_system_sites",
                               return_value=self.sites_result()):
            self.app._map_refresh_from_raven()
            self.wait_for_fetch()
            self.app._map_refresh_from_raven()
            self.wait_for_fetch()
            self.assertEqual(projects.call_count, 1, "Raven дёргают чаще порога")
            self.app._map_refresh_from_raven(force=True)
            self.wait_for_fetch()
            self.assertEqual(projects.call_count, 2, "force=True не сработал")

    def test_live_jump_triggers_refresh(self):
        self.prepare()
        with mock.patch.object(type(self.app.raven_api), "is_connected",
                               new_callable=mock.PropertyMock, return_value=True), \
             mock.patch.object(self.app.raven_api, "get_system_projects",
                               return_value=self.projects_result()) as projects, \
             mock.patch.object(self.app.raven_api, "get_system_sites",
                               return_value=self.sites_result()):
            self.app._handle_tracked_event(depot_event(), live=True)
            self.wait_for_fetch()
            self.assertEqual(projects.call_count, 1)

    def test_refresh_button_without_connection(self):
        self.prepare()
        with mock.patch.object(type(self.app.raven_api), "is_connected",
                               new_callable=mock.PropertyMock, return_value=False):
            self.app._on_map_refresh()
        status = [str(call.kwargs.get("text"))
                  for call in self.app.map_status.config.call_args_list]
        self.assertTrue(any("не подключён" in text for text in status), status[-2:])

    def wait_for_fetch(self, timeout=3.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.app._map_raven_inflight:
                return True
            time.sleep(0.01)
        return False


class MapInteractionTests(MapTabTestBase):
    """Выбор объекта, открытие проекта и переход на вкладку."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        self.app._handle_tracked_event(depot_event(), live=True)
        self.app._map_raven_done(
            SYSTEM,
            {"ok": True, "data": [{"buildId": BUILD_ID, "buildName": "A 1",
                                   "marketId": SITE_MARKET, "sumTotal": 5000,
                                   "sumNeed": 4000}]},
            {"ok": True, "data": {"sites": []}},
        )
        self.app._map_redraw_now()

    def test_tab_changed_redraws_and_updates_status(self):
        self.prepare()
        with mock.patch.object(self.app, "_map_visible", return_value=True), \
             mock.patch.object(self.app, "_map_refresh_from_raven") as refresh:
            self.app.map_status.reset_mock()
            self.app._on_notebook_tab_changed()
        refresh.assert_called_once_with()
        status = [str(call.kwargs.get("text"))
                  for call in self.app.map_status.config.call_args_list]
        self.assertTrue(any(SYSTEM in text for text in status), status[-2:])

    def test_tab_changed_ignored_for_other_tabs(self):
        with mock.patch.object(self.app, "_map_visible", return_value=False), \
             mock.patch.object(self.app, "_map_redraw_now") as redraw:
            self.app._on_notebook_tab_changed()
        redraw.assert_not_called()

    def test_open_project_by_double_click(self):
        self.prepare()
        self.app._select_map_object(BUILD_ID)
        with mock.patch.object(self.app, "_colony_open_url") as opener:
            self.app._on_map_open_project()
        opener.assert_called_once()
        url = str(opener.call_args.args[0])
        self.assertIn(BUILD_ID, url)

    def test_open_project_without_build_id(self):
        self.app._handle_tracked_event(location_event(), live=True)
        self.app._map_redraw_now()
        self.app._select_map_object(SITE_NAME)
        with mock.patch.object(self.app, "_colony_open_url") as opener:
            self.app._on_map_open_project()
        opener.assert_not_called()

    def test_tree_selection_selects_on_canvas(self):
        self.prepare()
        self.app.map_tree.selection.return_value = (f"s:{BUILD_ID}",)
        self.app.map_canvas.reset_mock()
        self.app._on_map_tree_select()
        self.assertEqual(self.app._map_selected, BUILD_ID)
        self.assertGreater(self.app.map_canvas.create_polygon.call_count, 0)

    def test_selection_survives_redraw(self):
        self.prepare()
        self.app._select_map_object(BUILD_ID)
        selected = [item for item in self.app._map_items if item.selected]
        self.assertEqual([item.label for item in selected], ["A 1"])
        self.app._map_redraw_now()
        selected = [item for item in self.app._map_items if item.selected]
        self.assertEqual([item.label for item in selected], ["A 1"])


class MapRobustnessTests(MapTabTestBase):
    """Карта не должна ронять приложение."""

    def test_draw_without_canvas_size(self):
        self.app.map_canvas.winfo_width.side_effect = RuntimeError("нет окна")
        self.app._draw_system_map()

    def test_redraw_with_empty_builder(self):
        self.app._map_redraw_now()
        self.assertEqual(self.app._map_items[-1].kind, "player")

    def test_feed_garbage_event(self):
        self.app._feed_system_map(None, live=True)
        self.app._feed_system_map({"event": "Music"}, live=True)
        self.app._feed_system_map({"event": "Scan"}, live=True)

    def test_schedule_redraw_coalesces(self):
        first = None
        for _ in range(5):
            self.app._map_schedule_redraw()
            first = first or self.app._map_redraw_job
        self.assertIsNotNone(self.app._map_redraw_job)
        self.app.root.after_cancel.assert_called()

    def test_thread_safety_of_snapshot(self):
        # Raven-поток и события журнала идут параллельно — снимок не должен падать.
        self.app._handle_tracked_event(location_event(), live=True)
        errors = []

        def reader():
            for _ in range(200):
                try:
                    self.app.system_map.snapshot()
                except Exception as exc:       # pragma: no cover - защита теста
                    errors.append(exc)

        threads = [threading.Thread(target=reader) for _ in range(3)]
        for thread in threads:
            thread.start()
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
