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
from datetime import datetime, timedelta, timezone
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import system_map as sm

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
                          "map_labels_var", "map_only_sites_var", "map_view_mode"):
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

    def test_habitable_zone_band_is_drawn(self):
        """Полоса обитаемой зоны: видно, какие тела в неё попали, а какие нет."""
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        zone = next((item for item in self.app._map_items if item.kind == "zone"), None)
        self.assertIsNotNone(zone, "зона обитаемости не построена")
        self.assertLess(zone.zone_inner, zone.zone_outer)
        texts = self.canvas_texts()
        self.assertTrue(any(text.startswith("обитаемая зона") for text in texts),
                        f"подпись зоны не нарисована: {texts}")
        # Полоса — это заливка (stipple) плюс две границы-окружности.
        outlines = [call for call in self.app.map_canvas.create_oval.call_args_list
                    if call.kwargs.get("fill") == "#2ecc71"]
        self.assertTrue(outlines, "заливка зоны не нарисована")

    def test_site_progress_arc_shows_delivered_percent(self):
        """Дуга вокруг ромба стройки — тот же процент, что в полосе прогресса."""
        self.prepare()
        arcs = [call for call in self.app.map_canvas.create_arc.call_args_list
                if call.kwargs.get("style") == "arc"]
        self.assertGreaterEqual(len(arcs), 2, "нет дуги прогресса у стройки")
        extents = [call.kwargs.get("extent") for call in arcs]
        self.assertTrue(any(abs(extent + 72.0) < 0.01 for extent in extents if extent),
                        f"дуга не соответствует 20%: {extents}")

    def test_only_sites_filter_hides_bodies_without_builds(self):
        """Фильтр «только стройки» прячет тела без площадок: их ищут глазами."""
        self.prepare()
        self.app._handle_tracked_event(
            {"event": "Scan", "BodyName": f"{SYSTEM} A 4", "BodyID": 7, "StarSystem": SYSTEM,
             "Parents": [{"Star": 1}], "PlanetClass": "Icy body",
             "DistanceFromArrivalLS": 2400.0}, live=True)
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        self.assertIn(f"{SYSTEM} A 4", self.canvas_texts())

        self.app.map_only_sites_var.set(True)
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        texts = self.canvas_texts()
        self.assertNotIn(f"{SYSTEM} A 4", texts, "тело без строек осталось на карте")
        self.assertIn(BODY_1, texts, "тело со стройкой пропало вместе с фильтром")
        self.assertIn("Вы здесь", texts, "отметка пилота пропала под фильтром")

        # Фильтр запоминается между запусками приложения.
        self.app._map_remember_view()
        self.assertTrue(self.app.config.get("map_only_sites"))

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


class MapRavenBodiesTests(MapTabTestBase):
    """Тела из Raven v2: система видна до сканирования, журнал главнее."""

    def whole_result(self):
        return {"ok": True, "status": 200, "data": {"bodies": [
            {"bodyName": f"{SYSTEM} A", "bodyId": 1, "starType": "K"},
            {"bodyName": BODY_1, "bodyId": 3,
             "planetClass": "High metal content world",
             "distanceFromArrivalLS": 12.4, "isLandable": True, "parents": [1]},
            {"bodyName": f"{SYSTEM} A 2", "bodyId": 4,
             "planetClass": "Class III gas giant",
             "distanceFromArrivalLS": 812.0, "parents": [1]},
        ]}}

    def test_bodies_appear_without_scans(self):
        self.app._handle_tracked_event(location_event(Body="", BodyID=None), live=True)
        self.app._map_raven_done(SYSTEM, {"ok": True, "data": []},
                                 {"ok": True, "data": {"sites": []}},
                                 self.whole_result())
        snapshot = self.app.system_map.snapshot()
        names = [body.name for body in snapshot.bodies]
        self.assertIn(BODY_1, names)
        self.assertIn(f"{SYSTEM} A 2", names)
        body = next(item for item in snapshot.bodies if item.name == BODY_1)
        self.assertTrue(body.from_raven)
        self.assertFalse(body.scanned)

    def test_bodies_flag_in_tree(self):
        self.app._handle_tracked_event(location_event(Body="", BodyID=None), live=True)
        self.app._map_raven_done(SYSTEM, {"ok": True, "data": []},
                                 {"ok": True, "data": {"sites": []}},
                                 self.whole_result())
        self.app._map_redraw_now()
        values = [call.kwargs.get("values") for call in self.app.map_tree.insert.call_args_list]
        self.assertTrue(any("raven" in [str(part) for part in row]
                            for row in values if row), values)

    def test_journal_scan_not_overwritten(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._map_raven_done(SYSTEM, {"ok": True, "data": []},
                                 {"ok": True, "data": {"sites": []}},
                                 self.whole_result())
        body = next(item for item in self.app.system_map.snapshot().bodies
                    if item.name == BODY_1)
        self.assertTrue(body.scanned)
        self.assertFalse(body.from_raven)
        self.assertEqual(body.distance_ls, 12.4)

    def test_extract_bodies_shapes(self):
        extract = self.app._map_extract_bodies
        self.assertEqual(extract({"bodies": [{"bodyName": "X"}]}), [{"bodyName": "X"}])
        self.assertEqual(extract([{"bodyName": "X"}]), [{"bodyName": "X"}])
        self.assertEqual(extract({"bodyName": "X"}), [{"bodyName": "X"}])
        self.assertEqual(extract({"stars": [{"bodyName": "S"}]}), [{"bodyName": "S"}])
        self.assertEqual(extract(None), [])
        self.assertEqual(extract("мусор"), [])


class MapFilterAndSummaryTests(MapTabTestBase):
    """Фильтр списка объектов и сводка системы в буфер обмена."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(), live=True)
        self.app._map_raven_done(
            SYSTEM,
            {"ok": True, "data": [{"buildId": BUILD_ID, "buildName": "A 1",
                                   "marketId": SITE_MARKET, "sumTotal": 5000,
                                   "sumNeed": 4000}]},
            {"ok": True, "data": {"sites": [
                {"id": "s-2", "name": "B 2", "bodyNum": 4, "bodyName": f"{SYSTEM} A 2",
                 "status": "planned"}]}},
        )
        self.app._map_redraw_now()

    def tree_iids(self):
        return [str(call.kwargs.get("iid"))
                for call in self.app.map_tree.insert.call_args_list]

    def refill(self):
        """Перезаполнить список с нуля: заглушка копит вызовы insert."""
        self.app.map_tree.insert.reset_mock()
        self.app._fill_map_tree(self.app._map_last_snapshot)
        return self.tree_iids()

    def test_filter_limits_rows(self):
        self.prepare()
        total = len(self.refill())
        self.assertGreater(total, 4)

        self.app.map_filter_var.set("площадка")
        filtered = self.refill()
        self.assertTrue(filtered)
        self.assertLess(len(filtered), total)

        # Фильтр ищет подстроку по всем колонкам: «план» нашёл бы и «планета»,
        # поэтому берём имя плана.
        self.app.map_filter_var.set("B 2")
        planned = self.refill()
        self.assertEqual(planned, ["s:B 2"])

        self.app.map_filter_var.set("")
        self.assertEqual(len(self.refill()), total)

    def test_filter_is_case_insensitive(self):
        self.prepare()
        self.app.map_filter_var.set("ПЛОЩАДКА")
        self.assertTrue(self.refill())

    def test_unscanned_toggle_hides_scanned_bodies(self):
        """Тумблер «неотск.»: в списке остаются станции и тела без скана."""
        self.prepare()
        total = len(self.refill())
        self.assertIn(f"b:{BODY_1}", self.refill(), "отсканированное тело в списке")

        self.app.map_unscanned_var.set(True)
        rows = self.refill()
        self.assertLess(len(rows), total)
        self.assertNotIn(f"b:{SYSTEM} A", rows, "отсканированная звезда спрятана")
        self.assertNotIn(f"b:{BODY_1}", rows, "отсканированное тело спрятано")
        self.assertIn(f"b:{SYSTEM} A 2", rows,
                      "тело плана без скана остаётся: его и надо сканировать")
        self.assertTrue(any(row.startswith("s:") for row in rows),
                        "станции должны остаться")

        self.app.map_unscanned_var.set(False)
        self.assertEqual(len(self.refill()), total)

    def test_copy_summary_to_clipboard(self):
        self.prepare()
        import sys as _sys

        clipboard = _sys.modules.get("pyperclip")
        self.assertIsNotNone(clipboard, "заглушка pyperclip не установлена")
        clipboard.copy.reset_mock()
        self.app._on_map_copy_summary()
        clipboard.copy.assert_called_once()
        report = str(clipboard.copy.call_args.args[0])
        self.assertIn(SYSTEM, report)
        self.assertIn("Стройки:", report)
        self.assertIn("A 1 — 20% (осталось 4 000 t): Сталь 4 000", report)
        hints = [str(call.kwargs.get("text"))
                 for call in self.app.map_hint.config.call_args_list]
        self.assertIn("Сводка скопирована в буфер обмена", hints)

    def test_copy_summary_fallback_without_pyperclip(self):
        self.prepare()
        with mock.patch.dict("sys.modules", {"pyperclip": None}):
            self.app._on_map_copy_summary()
        self.app.root.clipboard_append.assert_called()
        report = "".join(str(call.args[0]) for call
                         in self.app.root.clipboard_append.call_args_list)
        self.assertIn(SYSTEM, report)


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


class MapViewSettingsTests(MapTabTestBase):
    """Вид вкладки переживает перезапуск, открытая вкладка освежается сама."""

    def test_view_restored_from_config(self):
        self.app.config["map_zoom_index"] = 4
        self.app.config["map_show_moons"] = False
        self.app.config["map_show_labels"] = False
        self.app._build_tab_map()
        self.assertEqual(self.app._map_zoom_index, 4)
        self.assertFalse(self.app.map_moons_var.get())
        self.assertFalse(self.app.map_labels_var.get())

    def test_bad_config_zoom_falls_back(self):
        self.app.config["map_zoom_index"] = "мусор"
        self.app._build_tab_map()
        self.assertEqual(self.app._map_zoom_index, 2)

    def test_zoom_is_remembered_in_config(self):
        self.app._on_map_zoom(1)
        self.assertEqual(self.app.config["map_zoom_index"], 3)
        self.app.map_moons_var.set(False)
        self.app._on_map_toggle()
        self.assertFalse(self.app.config["map_show_moons"])
        self.assertFalse(self.app.config["map_show_labels"] is False
                         and not self.app.map_labels_var.get())

    def test_toggle_redraws_and_remembers(self):
        self.app._handle_tracked_event(location_event(), live=True)
        self.app.map_canvas.reset_mock()
        self.app.map_labels_var.set(False)
        self.app._on_map_toggle()
        self.assertEqual(self.app.config["map_show_labels"], False)
        self.assertGreater(self.app.map_canvas.create_oval.call_count, 0)

    def test_save_is_debounced(self):
        with mock.patch.object(self.app, "save_config") as save:
            for _ in range(5):
                self.app._map_remember_view()
            save.assert_not_called()          # колесо мыши не пишет файл пять раз
            self.app._map_flush_view()
            save.assert_called_once()

    def test_autorefresh_arms_and_stops_when_hidden(self):
        with mock.patch.object(self.app, "_map_visible", return_value=True), \
             mock.patch.object(self.app, "_map_refresh_from_raven") as refresh:
            self.app._on_notebook_tab_changed()
            self.assertIsNotNone(self.app._map_autorefresh_job, "автообновление не взведено")
            self.assertEqual(refresh.call_count, 1, "открытие вкладки не опросило Raven")
            self.app._map_autorefresh_tick()
            self.assertEqual(refresh.call_count, 2, "тик не опросил Raven")
            self.assertIsNotNone(self.app._map_autorefresh_job, "цепочка продолжилась")
        with mock.patch.object(self.app, "_map_visible", return_value=False), \
             mock.patch.object(self.app, "_map_refresh_from_raven") as refresh:
            self.app._map_autorefresh_tick()
            refresh.assert_not_called()
            self.assertIsNone(self.app._map_autorefresh_job, "цепочка оборвалась")

    def test_autorefresh_does_not_double_arm(self):
        with mock.patch.object(self.app, "_map_visible", return_value=True):
            self.app._map_arm_autorefresh()
            first = self.app._map_autorefresh_job
            self.app._map_arm_autorefresh()
            self.assertEqual(self.app._map_autorefresh_job, first)


class MapSelectionDetailsTests(MapTabTestBase):
    """Подсказка по выбранному объекту: остатки по товарам, а не только тонны."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        self.app._handle_tracked_event(depot_event(required=5000, provided=1000), live=True)
        self.app._map_redraw_now()

    def test_details_show_commodities(self):
        self.prepare()
        self.app._select_map_object(SITE_NAME)
        hints = [str(call.kwargs.get("text"))
                 for call in self.app.map_hint.config.call_args_list]
        self.assertTrue(any("осталось: steel 4 000" in hint for hint in hints), hints[-3:])
        self.assertTrue(any("нужно 5 000 t" in hint for hint in hints), hints[-3:])

    def test_details_for_body(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._map_redraw_now()
        self.app._select_map_object(BODY_1)
        hints = [str(call.kwargs.get("text"))
                 for call in self.app.map_hint.config.call_args_list]
        self.assertTrue(any("ls" in hint and BODY_1 in hint for hint in hints), hints[-3:])


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


class MapRavenCacheTests(MapTabTestBase):
    """Кэш Raven: карта собирается мгновенно, пока сеть молчит или отключена."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)

    def bodies_payload(self):
        return [{"name": f"{SYSTEM} C 9", "num": 91, "distLS": 700.0, "parents": [0],
                 "type": "rb", "subType": "Rocky body", "features": ["landable"],
                 "radius": 900.0}]

    def names(self):
        return [body.name for body in self.app.system_map.snapshot().bodies]

    def status_texts(self):
        return [str(call.kwargs.get("text"))
                for call in self.app.map_status.config.call_args_list]

    def test_raven_done_stores_cache(self):
        self.prepare()
        self.assertFalse(self.app.map_cache.path.exists())
        self.app._map_raven_done(SYSTEM, {"ok": True, "data": []},
                                 {"ok": True, "data": []},
                                 {"ok": True, "data": {"bodies": self.bodies_payload()}})
        entry = self.app.map_cache.load(SYSTEM)
        self.assertEqual(entry.get("bodies"), self.bodies_payload())

    def test_cache_applied_and_shows_age(self):
        self.prepare()
        self.app.map_cache.store(SYSTEM, bodies=self.bodies_payload())
        self.assertNotIn(f"{SYSTEM} C 9", self.names())
        self.assertTrue(self.app._map_apply_raven_cache(SYSTEM))
        body = next(item for item in self.app.system_map.snapshot().bodies
                    if item.name == f"{SYSTEM} C 9")
        self.assertTrue(body.from_raven)
        texts = self.status_texts()
        self.assertTrue(any("кэш" in text and "данные от" in text for text in texts),
                        texts[-2:])

    def test_cache_not_applied_when_empty(self):
        self.prepare()
        self.assertFalse(self.app._map_apply_raven_cache(SYSTEM))
        self.assertFalse(self.app._map_apply_raven_cache(""))

    def test_refresh_bridges_with_cache_until_first_answer(self):
        self.prepare()
        self.app.map_cache.store(SYSTEM, bodies=self.bodies_payload())
        self.assertFalse(self.app.raven_api.is_connected, "без ключа RCC сети нет")
        self.app._map_refresh_from_raven()
        self.assertIn(f"{SYSTEM} C 9", self.names(),
                      "оффлайн: кэш должен подставить тела прошлого визита")

    def test_cache_ignored_once_network_answered(self):
        self.prepare()
        self.app.map_cache.store(SYSTEM, bodies=self.bodies_payload())
        key = f"{SYSTEM}:{self.app.system_map.current_system_address}"
        self.app._map_raven_fetched[key] = time.time()
        self.app._map_refresh_from_raven()
        self.assertNotIn(f"{SYSTEM} C 9", self.names(),
                         "сеть уже ответила за этот запуск: кэш не подмешиваем")

    def test_refresh_button_offline_uses_cache(self):
        self.prepare()
        self.app.map_cache.store(SYSTEM, bodies=self.bodies_payload())
        self.app._on_map_refresh()
        self.assertIn(f"{SYSTEM} C 9", self.names())


class MapCardsPanelTests(MapTabTestBase):
    """Боковая панель «карточки системы» — как на сайте проекта."""

    def _prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(), live=True)
        self.app._map_redraw_now()

    def test_side_mode_switch_renders_cards(self):
        self._prepare()
        self.app.map_side_mode.set("cards")
        self.app._on_map_side_mode()
        self.assertEqual(self.app.config["map_side_mode"], "cards")
        self.app.map_cards_canvas.create_window.assert_called()

    def test_cards_show_body_and_its_site(self):
        self._prepare()
        created = []

        def record(*args, **kwargs):
            created.append(str(kwargs.get("text") or ""))
            return mock.MagicMock(name="Label")

        with mock.patch.object(self.module.tb, "Label", side_effect=record):
            self.app._fill_map_cards(self.app._map_last_snapshot)
        text = " ".join(item for item in created if item)
        self.assertIn(BODY_1.replace(SYSTEM + " ", ""), text)
        self.assertIn("A 1", text)          # название стройки из depot_event
        self.assertIn("20%", text)          # прогресс завезённого

    def test_empty_snapshot_shows_hint(self):
        rows = []

        def record(*args, **kwargs):
            rows.append(str(kwargs.get("text") or ""))
            return mock.MagicMock(name="Label")

        with mock.patch.object(self.module.tb, "Label", side_effect=record):
            self.app._fill_map_cards(sm.MapSnapshot(system="Empty"))
        self.assertTrue(any("Нет данных" in row for row in rows))


class MapCenteringTests(MapTabTestBase):
    """Двойной клик по объекту — центр карты на нём; по пустому месту — сброс."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(), live=True)
        self.app._map_redraw_now()

    def item(self, label):
        found = [item for item in self.app._map_items if item.label == label]
        self.assertTrue(found, f"объект {label} не на холсте")
        return found[0]

    def test_double_click_centers_on_body(self):
        self.prepare()
        target = self.item(BODY_1)
        self.app._on_map_double_click(mock.Mock(x=target.x, y=target.y))
        self.assertEqual(self.app._map_center, BODY_1)
        centered = self.item(BODY_1)
        self.assertAlmostEqual(centered.x, 450.0, delta=1.0,
                               msg="холст 900x560: центр (450, 280)")
        self.assertAlmostEqual(centered.y, 280.0, delta=1.0)

    def test_double_click_empty_resets_center(self):
        self.prepare()
        target = self.item(BODY_1)
        self.app._on_map_double_click(mock.Mock(x=target.x, y=target.y))
        self.app._on_map_double_click(mock.Mock(x=4.0, y=4.0))
        self.assertEqual(self.app._map_center, "")
        star = next(item for item in self.app._map_items if item.kind == "star")
        self.assertAlmostEqual(star.x, 450.0, delta=1.0)
        self.assertAlmostEqual(star.y, 280.0, delta=1.0)

    def test_tree_double_click_centers_selected(self):
        self.prepare()
        self.app._select_map_object(BODY_1)
        self.app._on_map_tree_double()
        self.assertEqual(self.app._map_center, BODY_1)
        centered = self.item(BODY_1)
        self.assertAlmostEqual(centered.x, 450.0, delta=1.0)

    def test_escape_resets_center(self):
        self.prepare()
        target = self.item(BODY_1)
        self.app._on_map_double_click(mock.Mock(x=target.x, y=target.y))
        self.assertEqual(self.app._map_center, BODY_1)
        self.app._on_map_escape()
        self.assertEqual(self.app._map_center, "")
        star = next(item for item in self.app._map_items if item.kind == "star")
        self.assertAlmostEqual(star.x, 450.0, delta=1.0,
                               msg="Esc вернул звезду в центр холста")

    def test_escape_without_center_is_noop(self):
        self.prepare()
        self.app._on_map_escape()   # не падает и ничего не ломает
        self.assertEqual(self.app._map_center, "")

    def test_escape_is_bound_on_canvas_and_tree(self):
        for widget in (self.app.map_canvas, self.app.map_tree):
            bound = [call.args[1].__name__ for call in widget.bind.call_args_list
                     if call.args and call.args[0] == "<Escape>"]
            self.assertIn("_on_map_escape", bound)

    def test_tree_double_click_binding_is_not_overwritten(self):
        # Регресс-ловушка: второй bind("<Double-1>") молча затирал первый и
        # центрирование в приложении не работало. В заглушках все Treeview —
        # один MagicMock, поэтому проверяем ПОСЛЕДНЮЮ привязку на дереве:
        # если её снова перетрут «открытием проекта», тест покраснеет.
        bound = [call.args[1] for call in self.app.map_tree.bind.call_args_list
                 if call.args and call.args[0] == "<Double-1>"]
        self.assertTrue(bound, "двойной клик по дереву вообще не привязан")
        self.assertEqual(bound[-1].__name__, "_on_map_tree_double")

    def test_tree_ctrl_double_click_opens_project(self):
        self.prepare()
        self.app._select_map_object(BODY_1)
        with mock.patch.object(self.app, "_on_map_open_project") as opener:
            self.app._on_map_tree_double(mock.Mock(state=4))
        opener.assert_called_once_with()
        self.assertEqual(self.app._map_center, "",
                         "Ctrl+двойной открывает проект, а не центрирует")

    def test_unscanned_toggle_is_remembered(self):
        self.prepare()
        self.app.map_unscanned_var.set(True)
        self.app.map_tree.insert.reset_mock()
        self.app._on_map_unscanned_toggle()
        self.assertTrue(self.app.config.get("map_unscanned"))
        rows = [str(call.kwargs.get("iid"))
                for call in self.app.map_tree.insert.call_args_list]
        self.assertNotIn(f"b:{BODY_1}", rows)


class MapExportButtonTests(MapTabTestBase):
    """Кнопка PNG: схема системы сохраняется файлом без Pillow и скриншотов."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(), live=True)
        self.app._map_redraw_now()

    def test_save_png_writes_file(self):
        self.prepare()
        target = self.home / "system_map.png"
        with mock.patch.object(self.module.filedialog, "asksaveasfilename",
                               return_value=str(target)):
            self.app._on_map_save_png()
        self.assertTrue(target.exists(), "файл не создан")
        head = target.read_bytes()[:8]
        self.assertEqual(head, b"\x89PNG\r\n\x1a\n")
        status = [str(call.kwargs.get("text"))
                  for call in self.app.map_status.config.call_args_list]
        self.assertTrue(any("Карта сохранена" in text for text in status), status[-2:])

    def test_save_png_cancelled(self):
        self.prepare()
        with mock.patch.object(self.module.filedialog, "asksaveasfilename",
                               return_value=""):
            self.app._on_map_save_png()
        self.assertEqual(list(self.home.glob("*.png")), [])


class MapCarryAndDueTests(MapTabTestBase):
    """Колонка «Везти», сортировка строек по дедлайну и цветовая тревога."""

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(required=5000, provided=1000),
                                       live=True)
        # Проект Raven даёт стройке buildId: без него iid строки — имя станции.
        self.app._map_raven_done(SYSTEM, {"ok": True, "data": [
            {"buildId": BUILD_ID, "buildName": "A 1", "marketId": SITE_MARKET,
             "bodyNum": 3, "sumTotal": 5000, "sumNeed": 4000,
             "commodities": {"steel": 4000}}]}, {"ok": True, "data": []})

    def rows(self):
        self.app.map_tree.insert.reset_mock()
        self.app._fill_map_tree(self.app._map_last_snapshot)
        out = []
        for call in self.app.map_tree.insert.call_args_list:
            out.append((str(call.kwargs.get("iid")), call.kwargs.get("values"),
                        call.kwargs.get("tags")))
        return out

    def due_iso(self, days: float) -> str:
        moment = datetime.now(timezone.utc) + timedelta(days=days)
        return moment.strftime("%Y-%m-%dT%H:%M:%SZ")

    _market = 910000

    def add_project(self, build_id, due=None):
        MapCarryAndDueTests._market += 1
        project = {"buildId": build_id, "buildName": build_id,
                   "marketId": MapCarryAndDueTests._market,
                   "buildType": "PlanetaryInstallation", "bodyNum": 3,
                   "sumTotal": 2000, "sumNeed": 1000, "commodities": {"steel": 1000}}
        if due:
            project["timeDue"] = due
        self.app._map_raven_done(SYSTEM, {"ok": True, "data": [project]},
                                 {"ok": True, "data": []})

    def test_carry_column_shows_top_commodity(self):
        self.prepare()
        site = [row for row in self.rows() if row[0] == f"s:{BUILD_ID}"]
        self.assertEqual(len(site), 1)
        values = site[0][1]
        self.assertEqual(len(values), 5, "пять колонок: объект/тип/завезено/осталось/везти")
        self.assertEqual(values[4], "Сталь 4 000")

    def test_filter_finds_carry_column(self):
        self.prepare()
        self.app.map_filter_var.set("Сталь")
        rows = self.rows()
        self.assertTrue(any(row[0] == f"s:{BUILD_ID}" for row in rows))
        self.app.map_filter_var.set("")

    def test_stations_sorted_by_deadline(self):
        self.prepare()
        self.add_project("due-far", due=self.due_iso(60))
        self.add_project("due-near", due=self.due_iso(2))
        self.add_project("due-none")
        iids = [row[0] for row in self.rows() if row[0].startswith("s:")]
        self.assertEqual(iids[:2], ["s:due-near", "s:due-far"],
                         "ближайший дедлайн сверху")
        self.assertLess(iids.index("s:due-far"), iids.index("s:due-none"),
                        "бессрочные — после срочных")
        self.assertLess(iids.index("s:due-far"), iids.index(f"s:{BUILD_ID}"),
                        "стройка журнала без срока — тоже после срочных")

    def test_deadline_tags(self):
        self.prepare()
        self.add_project("tag-over", due=self.due_iso(-1))
        self.add_project("tag-soon", due=self.due_iso(2))
        self.add_project("tag-calm", due=self.due_iso(30))
        tags = {row[0]: row[2] for row in self.rows()}
        self.assertEqual(tags["s:tag-over"], ("overdue",))
        self.assertEqual(tags["s:tag-soon"], ("due_soon",))
        self.assertEqual(tags["s:tag-calm"], ("site",))


class PrimaryProjectRefreshTests(MapTabTestBase):
    """2.10.11: потребность основного проекта в CARRIER перечитывается с Raven.

    Раньше `colony_primary_project` копировался один раз при назначении
    основным: наши же доставки, ProjectUpdate и сдачи других командиров
    меняли остаток на сервере, а оверлей показывал потребность на момент
    назначения.
    """

    class Runner:
        """Замена threading.Thread: целевая функция выполняется сразу."""

        instances = []

        def __init__(self, target=None, args=(), **kwargs):
            self.target, self.args = target, args
            PrimaryProjectRefreshTests.instances.append(self)

        def start(self):
            self.target(*self.args)

    def prepare(self, primary="b-1"):
        PrimaryProjectRefreshTests.instances = []
        self.app.raven_api = mock.MagicMock()
        self.app.raven_api.is_connected = True
        self.app.colony_primary_project = {"buildId": primary,
                                           "commodities": {"steel": 100}}

    def test_primary_project_reread_updates_need(self):
        self.prepare()
        self.app.raven_api.resolve_project_by_id.return_value = {
            "buildId": "b-1", "buildName": "P", "commodities": {"steel": 40}}
        self.app._load_primary_project("b-1")
        self.assertEqual(self.app.colony_primary_project["commodities"]["steel"], 40)
        need, _label, source = self.app._carrier_need_info()
        self.assertEqual(need, {"steel": 40})
        self.assertEqual(source, "project")

    def test_primary_refresh_is_throttled(self):
        self.prepare()
        with mock.patch.object(self.module.threading, "Thread", self.Runner):
            self.app._refresh_primary_project()
            self.app._refresh_primary_project()
            self.assertEqual(len(self.instances), 1,
                             "в пределах TTL тот же проект повторно не запрашиваем")
            self.app._refresh_primary_project(force=True)
            self.assertEqual(len(self.instances), 2)

    def test_load_does_not_replace_other_primary(self):
        self.prepare()
        self.app.raven_api.resolve_project_by_id.return_value = {
            "buildId": "b-1", "commodities": {"steel": 40}}
        # Пока запрос летел, основным назначили другой проект.
        self.app.colony_primary_project = {"buildId": "b-3", "commodities": {}}
        self.app._load_primary_project("b-1")
        self.assertEqual(self.app.colony_primary_project["buildId"], "b-3")

    def test_supply_sent_hook_rereads_both_projects(self):
        self.prepare()
        self.app.raven_api.resolve_project_by_id.return_value = {
            "buildId": "b-1", "commodities": {"steel": 7}}
        with mock.patch.object(self.app, "_refresh_site_project") as site, \
                mock.patch.object(self.module.threading, "Thread", self.Runner):
            self.app._on_raven_supply_sent("b-1")
            site.assert_called_once_with(force=True)
        self.assertEqual(self.app.colony_primary_project["commodities"]["steel"], 7,
                         "после ProjectUpdate потребность перечитана сразу")


def exobio_journal_lines():
    """Хвост журнала: прыжок, скан каменистой тела с атмосферой, сигналы, образец."""
    return [
        '{"timestamp":"2026-09-14T09:59:00Z","event":"FSDJump","StarSystem":"%s",'
        '"SystemAddress":%d}' % (SYSTEM, ADDRESS),
        '{"timestamp":"2026-09-14T09:59:30Z","event":"Scan","BodyName":"%s",'
        '"BodyID":3,"StarSystem":"%s","PlanetClass":"Rocky body","Landable":true,'
        '"Atmosphere":"thin sulfur dioxide atmosphere",'
        '"DistanceFromArrivalLS":12.4}' % (BODY_1, SYSTEM),
        '{"timestamp":"2026-09-14T09:59:40Z","event":"FSSBodySignals","BodyName":"%s",'
        '"StarSystem":"%s","Signals":[{"Type":"$SAA_SignalType_Biological;","Count":3}]}'
        % (BODY_1, SYSTEM),
        '{"timestamp":"2026-09-14T09:59:50Z","event":"ScanOrganic","StarSystem":"%s",'
        '"Body":"%s","Species_Localised":"Tussock Poxtop","ScanType":"Sample"}'
        % (SYSTEM, BODY_1),
    ]


class ExobioRestoreTests(MapTabTestBase):
    """2.10.14: хвост журнала кормит трекер экзобиологии.

    Жалоба: «система отсканирована пилотом», но блок EXOBIO пуст — сканы
    произошли до запуска Watcher и в трекер не попадали.
    """

    def _write_journal(self):
        raw = ("\n".join(exobio_journal_lines()) + "\n").encode("utf-8")
        (self.home / "Journal.260914100000.01.log").write_bytes(raw)

    def test_restore_fills_exobiology_tracker(self):
        from exobiology import PLANET_PRESETS_BY_ID

        self._write_journal()
        with mock.patch.object(self.app, "log"):
            self.app._restore_station_state_from_journal()
        tracker = self.app.exobiology
        self.assertEqual(tracker.current_system, SYSTEM)
        rows = tracker.search_system_planets([PLANET_PRESETS_BY_ID["rocky_atmo_land"]])
        self.assertEqual([row["body"] for row in rows], [BODY_1])
        self.assertEqual(rows[0]["bio_signals"], 3)
        self.assertEqual(tracker.system_body_count(), 1)

    def test_restore_twice_does_not_double_samples(self):
        self._write_journal()
        with mock.patch.object(self.app, "log"):
            self.app._restore_station_state_from_journal()
            self.app._restore_station_state_from_journal()
        tracker = self.app.exobiology
        entry = tracker.organics[tracker._key(SYSTEM, BODY_1)]["Tussock Poxtop"]
        self.assertEqual(entry["samples"], 1,
                         "повторный restore не должен удваивать образцы")


class ExobioOverlayStateTests(MapTabTestBase):
    """2.10.14: выбранные фильтры доходят до оверлея даже при пустом трекере."""

    def test_selected_filters_reach_state_on_empty_tracker(self):
        self.app.overlay_manager.settings["exobio_planet_search"] = ["rocky_atmo_land"]
        state = self.app._exobiology_overlay_state()
        self.assertIsNotNone(state, "с выбранными фильтрами состояние обязано быть")
        self.assertEqual([row["id"] for row in state["planet_criteria"]],
                         ["rocky_atmo_land"])
        self.assertEqual(state["planets"], [])
        self.assertEqual(state["system_known_bodies"], 0)

    def test_empty_tracker_without_filters_returns_none(self):
        self.app.overlay_manager.settings["exobio_planet_search"] = []
        self.app.overlay_manager.settings["exobio_genera"] = []
        self.assertIsNone(self.app._exobiology_overlay_state())

    def test_restored_system_planets_reach_state(self):
        self._write_journal = None  # не используется; журнал пишем прямо
        raw = ("\n".join(exobio_journal_lines()) + "\n").encode("utf-8")
        (self.home / "Journal.260914100000.01.log").write_bytes(raw)
        self.app.overlay_manager.settings["exobio_planet_search"] = ["rocky_atmo_land"]
        with mock.patch.object(self.app, "log"):
            self.app._restore_station_state_from_journal()
        state = self.app._exobiology_overlay_state()
        self.assertIsNotNone(state)
        self.assertEqual([row["body"] for row in state["planets"]], [BODY_1])
        self.assertEqual(state["system_known_bodies"], 1)
        self.assertEqual(state["system"], SYSTEM)


class ProjectCompleteConfirmTests(MapTabTestBase):
    """2.10.14: Raven получает подтверждение, когда потребность завезена вся."""

    class Runner:
        """Замена threading.Thread: целевая функция выполняется сразу."""

        instances = []

        def __init__(self, target=None, args=(), **kwargs):
            self.target, self.args = target, args
            ProjectCompleteConfirmTests.instances.append(self)

        def start(self):
            self.target(*self.args)

    DONE = {"buildId": "b-done", "buildName": "Форпост",
            "commodities": {"steel": 0, "cmmcomposite": 0}}

    def prepare(self):
        ProjectCompleteConfirmTests.instances = []
        self.app.raven_api = mock.MagicMock()
        self.app.raven_api.is_connected = True
        self.app.raven_api.mark_complete.return_value = {"ok": True, "status": 200}
        self.app.config = dict(self.app.config or {})
        self.app.config.pop("raven_complete_notified", None)

    def _call(self, project):
        with mock.patch.object(self.module.threading, "Thread", self.Runner), \
                mock.patch.object(self.app, "log"):
            self.app._maybe_confirm_project_complete(project)

    def test_zero_remaining_confirms_completion_once(self):
        self.prepare()
        self._call(dict(self.DONE))
        self._call(dict(self.DONE))
        self.app.raven_api.mark_complete.assert_called_once_with("b-done")
        self.assertIn("b-done", self.app.config["raven_complete_notified"])

    def test_positive_remaining_is_not_completed(self):
        self.prepare()
        self._call(dict(self.DONE, commodities={"steel": 5}))
        self.app.raven_api.mark_complete.assert_not_called()
        self.assertNotIn("b-done", self.app.config.get("raven_complete_notified", []))

    def test_empty_commodities_is_not_a_reason(self):
        self.prepare()
        self._call({"buildId": "b-x", "commodities": {}})
        self.app.raven_api.mark_complete.assert_not_called()

    def test_network_failure_allows_retry(self):
        self.prepare()
        self.app.raven_api.mark_complete.return_value = {
            "ok": False, "status": 0, "error": "connection"}
        self._call(dict(self.DONE))
        self.assertNotIn("b-done", self.app.config.get("raven_complete_notified", []),
                         "сетевой сбой снял метку")
        self.app.raven_api.mark_complete.return_value = {"ok": True, "status": 200}
        self._call(dict(self.DONE))
        self.assertEqual(self.app.raven_api.mark_complete.call_count, 2)
        self.assertIn("b-done", self.app.config["raven_complete_notified"])

    def test_server_reject_is_not_retried(self):
        self.prepare()
        self.app.raven_api.mark_complete.return_value = {
            "ok": False, "status": 403, "error": "forbidden"}
        self._call(dict(self.DONE))
        self._call(dict(self.DONE))
        self.app.raven_api.mark_complete.assert_called_once()

    def test_server_status_complete_skips_call(self):
        self.prepare()
        self._call(dict(self.DONE, status="Complete"))
        self.app.raven_api.mark_complete.assert_not_called()
        self.assertIn("b-done", self.app.config["raven_complete_notified"],
                      "сервер уже завершил — запоминаем, чтобы не проверять снова")

    def test_primary_refresh_hook_confirms(self):
        self.prepare()
        self.app.colony_primary_project = {"buildId": "b-done",
                                           "commodities": {"steel": 10}}
        self.app.raven_api.resolve_project_by_id.return_value = dict(self.DONE)
        with mock.patch.object(self.module.threading, "Thread", self.Runner), \
                mock.patch.object(self.app, "log"):
            self.app._load_primary_project("b-done")
        self.app.raven_api.mark_complete.assert_called_once_with("b-done")


class MapScene3DTests(MapTabTestBase):
    """Радио «3D»: сцена сайта рисуется холстом вкладки — без браузера и HTML.

    Автономной страницы у приложения больше нет, поэтому проверяем именно то,
    что видит пилот: карта появляется во вкладке (кнопка «3D-карта ⛶», Ctrl+P,
    F4), камера и уровни слушаются, движение тел идёт по орбитам, а возврат
    «К сканам» ставит тела на места.
    """

    def prepare(self):
        self.app._handle_tracked_event(location_event(), live=True)
        for event in scan_events():
            self.app._handle_tracked_event(event, live=True)
        self.app._handle_tracked_event(depot_event(), live=True)
        self.app._map_redraw_now()

    def to_3d(self):
        self.prepare()
        self.app.map_view_mode.set("3d")
        self.app._on_map_mode_change()
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        return self.app._map3d_view

    def test_scene_draws_on_the_tab_canvas(self):
        view = self.to_3d()
        self.assertIsNotNone(view, "сцена 3D не создана")
        self.assertTrue(self.app._map_items, "на сцене нет объектов")
        self.assertGreaterEqual(self.app.map_canvas.create_oval.call_count, 1,
                                "сцена нарисовала только подписи")
        self.assertIn("A 1", self.canvas_texts(), "на сцене нет подписи тела")
        self.assertIn("HIP 22460", self.canvas_texts(), "на сцене нет подписи звезды")

    def test_controls_are_in_the_tab(self):
        for name in ("map_view3d", "map_level_combo", "map_level_var", "map_zones_var",
                     "map_motion_button", "map_motion_speed_var"):
            self.assertTrue(hasattr(self.app, name), f"нет органа управления {name}")
        self.assertFalse(hasattr(self.app, "_on_map_export_3d"),
                         "экспорт автономного HTML вернулся во вкладку")

    def test_open_button_shows_the_scene_in_the_app(self):
        self.prepare()
        with mock.patch("webbrowser.open") as mock_browser:
            self.app._on_map_open_3d()
        mock_browser.assert_not_called()
        self.assertEqual(self.app.map_view_mode.get(), "3d")
        self.assertEqual(self.app.config["map_view_mode"], "3d")
        self.app.notebook.select.assert_called_with(self.app.tab_map)

    def test_open_with_focus_keeps_the_object_selected(self):
        self.prepare()
        self.app._on_map_open_3d(BODY_1)
        self.assertEqual(self.app._map_selected, BODY_1)
        self.assertEqual(self.app._map3d_view.focus, BODY_1,
                         "сцена не переехала к выбранному телу")

    def test_hotkeys_open_the_same_scene(self):
        self.prepare()
        for keysym in ("<Control-p>", "<Control-P>", "<F4>"):
            bound = [call.args[1] for call in self.app.map_canvas.bind.call_args_list
                     if call.args and call.args[0] == keysym]
            self.assertTrue(bound, f"{keysym} не привязан к карте")
        keys = [call.args[1].__name__ for call in self.app.map_canvas.bind.call_args_list
                if call.args and call.args[0] == "<KeyPress>"]
        self.assertIn("_on_map_key", keys, "клавиши сцены не привязаны")

    def test_payload_is_rebuilt_only_when_the_data_changes(self):
        self.to_3d()
        import system_view
        with mock.patch.object(system_view, "build_view_payload",
                               wraps=system_view.build_view_payload) as spy:
            self.app._map_redraw_now()
            self.app._on_map_view_preset()        # смена камеры
            self.app._on_map_level_change()       # смена уровня
        self.assertEqual(spy.call_count, 0, "пакет пересобирается на каждый кадр")
        self.app._handle_tracked_event(depot_event(required=9000, provided=100), live=True)
        with mock.patch.object(system_view, "build_view_payload",
                               wraps=system_view.build_view_payload) as spy:
            self.app._map_redraw_now()
        self.assertEqual(spy.call_count, 1, "данные изменились — пакет надо пересобрать")

    def test_view_presets_change_the_camera(self):
        view = self.to_3d()
        for name, (yaw, pitch) in (("top", (-90.0, 88.0)), ("side", (0.0, 6.0)),
                                   ("iso", (-33.0, 40.0))):
            self.app.map_view3d.set(name)
            self.app._on_map_view_preset()
            self.assertEqual(view.view, name)
            self.assertAlmostEqual(view.yaw_deg, yaw, delta=0.01)
            self.assertAlmostEqual(view.pitch_deg, pitch, delta=0.01)

    def test_level_combo_changes_the_zoom(self):
        view = self.to_3d()
        for label, level in (("Кластер", 1), ("Окрестность", 2), ("Поверхность", 3)):
            self.app.map_level_var.set(label)
            self.app._on_map_level_change()
            self.assertEqual(view.zoom, level)
        self.assertEqual(self.app.config["map_level"], 3, "уровень не запоминается")

    def test_motion_toggle_starts_and_stops_the_bodies(self):
        view = self.to_3d()
        self.app._on_map_motion_toggle()
        self.assertTrue(view.motion)
        self.assertIsNotNone(self.app._map3d_job, "таймер движения не заведён")
        self.assertEqual(self.app.map_motion_button.config.call_args.kwargs["text"],
                         "⏸ Пауза")
        self.app._on_map_motion_toggle()
        self.assertFalse(view.motion)
        self.assertIsNone(self.app._map3d_job)
        self.assertEqual(view.motion_offset_days, 0.0, "пауза не вернула тела на места")

    def test_motion_speed_comes_from_the_picker(self):
        view = self.to_3d()
        self.app.map_motion_speed_var.set("×64")
        self.app._on_map_motion_speed()
        self.assertEqual(view.motion_speed, 64.0)
        self.assertEqual(self.app.config["map_motion_speed"], 4)

    def test_motion_tick_advances_time_and_pauses_off_tab(self):
        view = self.to_3d()
        view.motion = True
        self.app.notebook.select.return_value = "tab-other"
        self.app._map_motion_tick()
        self.assertIsNone(self.app._map3d_job, "тикает в скрытой вкладке")
        self.assertEqual(view.motion_offset_days, 0.0)
        self.app.notebook.select.return_value = str(self.app.tab_map)
        self.app._map_motion_tick()
        self.assertGreater(view.motion_offset_days, 0.0, "время движения не идёт")
        self.assertIsNotNone(self.app._map3d_job)

    def test_reset_time_returns_bodies_to_the_scans(self):
        view = self.to_3d()
        view.motion = True
        view.tick(3.0)
        self.assertGreater(view.motion_offset_days, 0.0)
        self.app._on_map_reset_time()
        self.assertEqual(view.motion_offset_days, 0.0)

    def test_scheme_mode_still_draws_the_flat_map(self):
        self.prepare()
        self.app.map_view_mode.set("2d")
        self.app._on_map_mode_change()
        self.app.map_canvas.reset_mock()
        self.app._map_redraw_now()
        self.assertGreaterEqual(self.app.map_canvas.create_oval.call_count, 1)
        self.assertIn(BODY_1, self.canvas_texts())

    def test_switch_to_the_scheme_stops_the_animation(self):
        view = self.to_3d()
        self.app._on_map_motion_toggle()
        self.app.map_view_mode.set("2d")
        self.app._on_map_mode_change()
        self.assertFalse(view.motion, "схема продолжает анимировать тела")
        self.assertIsNone(self.app._map3d_job)

    def test_mouse_rotates_pans_and_zooms(self):
        view = self.to_3d()
        start_yaw = view.yaw_deg
        self.app._on_map_press(mock.Mock(x=100, y=100))
        self.app._on_map_drag(mock.Mock(x=160, y=140))
        self.assertNotEqual(view.yaw_deg, start_yaw, "мышь не поворачивает камеру")
        self.assertEqual(view.view, "free")
        self.app._on_map_press_3(mock.Mock(x=100, y=100))
        self.app._on_map_drag(mock.Mock(x=140, y=100))
        self.assertNotEqual(view.pan_offset, (0.0, 0.0, 0.0),
                            "правая кнопка не двигает карту")
        before = view.zoom_scale
        self.app._on_map_wheel(mock.Mock(delta=120))
        self.assertGreater(view.zoom_scale, before, "колесо не приближает сцену")

    def test_click_selects_and_escape_returns_the_overview(self):
        view = self.to_3d()
        # Стройка лежит поверх тела и перекрывает его маркер: кликаем по ней,
        # у неё приоритет выбора (так же ведёт себя и человек на карте).
        site = next(item for item in self.app._map_items if item.kind == "station")
        self.app._on_map_click(mock.Mock(x=site.x, y=site.y))
        self.assertEqual(self.app._map_selected, site.key)
        self.app._on_map_double_click(mock.Mock(x=site.x, y=site.y))
        self.assertEqual(view.focus, BODY_1, "камера не поехала к телу стройки")
        self.app._on_map_escape()
        self.assertEqual(self.app._map_center, "")
        self.assertEqual(view.focus, "", "Esc не вернул обзор всей системы")
        self.assertEqual(view.view, "iso")

    def test_hover_card_follows_the_cursor(self):
        view = self.to_3d()
        marker = next(item for item in self.app._map_items if item.kind == "station")
        picked = view.marker_at(marker.x, marker.y)
        self.app._on_map_hover(mock.Mock(x=marker.x, y=marker.y))
        self.assertEqual(self.app._map_hover_key, picked.key)
        self.assertEqual(view.hover_key, picked.key, "сцена не запомнила наведение")
        self.assertIn("Завезено: 20%", view.hint_text(picked),
                      "в подсказке нет прогресса стройки")
        self.app._on_map_hover(mock.Mock(x=2.0, y=2.0))
        self.assertEqual(self.app._map_hover_key, "")
        self.assertEqual(view.hover_key, "")

    def test_scene_settings_survive_a_restart(self):
        view = self.to_3d()
        self.app.map_view3d.set("top")
        self.app._on_map_view_preset()
        self.app.map_level_var.set("Окрестность")
        self.app._on_map_level_change()
        self.app._on_map_motion_speed()
        self.app._map_remember_view()
        self.assertEqual(self.app.config["map_view3d"], "top")
        self.assertEqual(self.app.config["map_level"], 2)
        self.assertEqual(self.app.config["map_zones"], True)

    def test_broken_payload_does_not_break_the_tab(self):
        """Сбой данных рисует подсказку, а не роняет окно: Tk не любит исключений."""
        self.to_3d()
        self.app._map3d_key = None
        import system_view
        with mock.patch.object(self.app, "_map_set_hint") as hint, \
                mock.patch.object(system_view, "build_view_payload",
                                  side_effect=RuntimeError("нет данных")):
            self.app._map_redraw_now()          # без исключения наружу
        self.assertTrue(hint.called, "о сбое данных никто не сказал")
        self.assertIn("3D-карта недоступна", str(hint.call_args.args[0]))
