"""Тесты карты системы в Colonial Helper (`system_view.py`).

Карта больше не уезжает в браузер: пакет данных собирает `system_view.py`, а
рисует его вкладка приложения холстом Tk (`tk_orrery.py`). Тот же пакет
приходит и на сайт, который рисует его three.js (`src/lib/orrery3d`).

Здесь проверяется то, ради чего модуль и появился:

* палитра и формат чисел совпадают с сайтом (иначе карта «другого цвета»);
* пакет данных: кластеры мультизвёздных систем, орбиты кладутся полилиниями,
  маркер тела стоит на своей орбите, постройки — на поверхности тела;
* интеграция с вкладкой: «3D-карта ⛶» открывает сцену в самой вкладке, а не в
  браузере, и старые имена обработчиков (`_on_map_open_plotly`) работают;
* автономного HTML в приложении нет и не появится: модуль не умеет ни
  собирать страницу, ни открывать браузер;
* контракт с движком: версия в `system_view.VIEW_VERSION` совпадает с
  `ORRERY_VIEW_VERSION` из `src/lib/orrery3d/types.ts`.
"""

import json
import math
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import system_map as sm
import system_view as sv
import webbrowser


def _kelt_snapshot():
    """Двойная звезда с постройкой на планете первой звезды."""
    builder = sm.SystemMapBuilder()
    builder.handle({"event": "FSDJump", "StarSystem": "KELT", "SystemAddress": 42})
    builder.handle({"event": "Scan", "StarSystem": "KELT", "BodyName": "KELT A",
                    "ScanType": "Detailed", "StarType": "G", "Radius": 1.7e9,
                    "DistanceFromArrivalLS": 0.0, "EffectiveTemperature": 5050})
    builder.handle({"event": "Scan", "StarSystem": "KELT", "BodyName": "KELT B",
                    "ScanType": "Detailed", "StarType": "M", "Radius": 3e8,
                    "DistanceFromArrivalLS": 41000.0, "EffectiveTemperature": 3400})
    builder.handle({"event": "Scan", "StarSystem": "KELT", "BodyName": "KELT A 1",
                    "ScanType": "Detailed", "PlanetClass": "Rocky body", "Radius": 6e6,
                    "DistanceFromArrivalLS": 120.0, "SemiMajorAxis": 1.1e10,
                    "SurfaceGravity": 9.8, "Landable": True, "Parents": [{"Star": 1}]})
    builder.handle({"event": "Scan", "StarSystem": "KELT", "BodyName": "KELT B 1",
                    "ScanType": "Detailed", "PlanetClass": "Icy body", "Radius": 2e6,
                    "DistanceFromArrivalLS": 41000.0, "SemiMajorAxis": 2.0e9,
                    "Parents": [{"Star": 2}]})
    # Сигналы на планете: биология и геология приходят одним событием сканера.
    builder.handle({"event": "SAASignalsFound", "StarSystem": "KELT", "BodyName": "KELT A 1",
                    "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 3},
                                {"Type": "$SAA_SignalType_Geological;", "Count": 5},
                                {"Type": "$SAA_SignalType_Human;", "Count": 1}],
                    "Genuses": [{"Genus_Localised": "Бактерии"}]})
    builder.handle({"event": "ColonisationConstructionDepot", "StarSystem": "KELT",
                    "MarketID": 10, "ConstructionName": "KELT A 1 Colony",
                    "BodyName": "KELT A 1", "ConstructionProgress": 0.42,
                    "ResourcesRequired": [{"Name": "Steel", "RequiredAmount": 100000,
                                           "ProvidedAmount": 42000}]})
    return builder.snapshot("KELT")


def _sol_with_moon_snapshot():
    """Солнце, землеподобная планета в зоне обитаемости и её луна."""
    builder = sm.SystemMapBuilder()
    builder.handle({"event": "FSDJump", "StarSystem": "Sol", "SystemAddress": 1})
    builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol",
                    "ScanType": "Detailed", "StarType": "G", "Radius": 6.957e8,
                    "EffectiveTemperature": 5778, "BodyID": 1})
    builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol 3",
                    "ScanType": "Detailed", "PlanetClass": "Earthlike body",
                    "Radius": 6.371e6, "DistanceFromArrivalLS": 499.0, "BodyID": 3,
                    "SemiMajorAxis": 1.496e11, "Parents": [{"Star": 1}]})
    builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol 3 a",
                    "ScanType": "Detailed", "PlanetClass": "Rocky body",
                    "Radius": 1.7e6, "DistanceFromArrivalLS": 499.0, "BodyID": 4,
                    "SemiMajorAxis": 3.84e8, "Parents": [{"Planet": 3}, {"Star": 1}]})
    return builder.snapshot("Sol")


def _body(payload, name):
    for body in payload["bodies"]:
        if body["name"] == name:
            return body
    raise AssertionError(f"в пакете нет тела {name}: {[b['name'] for b in payload['bodies']]}")


def _point_to_polyline(point, points):
    """Расстояние от точки до ломаной — «маркер лежит на орбите»."""
    best = float("inf")
    for a, b in zip(points, points[1:]):
        ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        ap = (point[0] - a[0], point[1] - a[1], point[2] - a[2])
        denom = sum(value * value for value in ab) or 1e-12
        ratio = max(0.0, min(1.0, sum(x * y for x, y in zip(ap, ab)) / denom))
        proj = (a[0] + ab[0] * ratio, a[1] + ab[1] * ratio, a[2] + ab[2] * ratio)
        best = min(best, math.dist(point, proj))
    return best


class PaletteAndFormatTests(unittest.TestCase):
    """Цвета и числа — те же, что на сайте: карты не должны «разъезжаться»."""

    def test_star_color_follows_temperature(self):
        hot = sv.get_star_color("B", 25000.0)
        cool = sv.get_star_color("M", 3000.0)
        self.assertNotEqual(hot, cool, "горячая и холодная звезда одного цвета")
        self.assertEqual(sv.get_star_color("G", 5778.0), sv.get_star_color("G", 5778.0))
        # Без температуры остаётся цвет по спектральному классу.
        self.assertEqual(sv.get_star_color("G", 0.0), sv.get_star_color("G"))
        self.assertEqual(sv.get_star_color("", 0.0), sv.STAR_FALLBACK_COLOR)

    def test_body_color_by_class_and_fallback(self):
        earthlike = sm.MapBody(name="X 1", kind=sm.KIND_PLANET, body_class="Earthlike")
        gas = sm.MapBody(name="X 2", kind=sm.KIND_PLANET, body_class="Gas giant")
        star = sm.MapBody(name="X", kind=sm.KIND_STAR, star_type="G")
        self.assertNotEqual(sv.body_color(earthlike), sv.body_color(gas))
        self.assertEqual(sv.body_color(star), sv.STAR_FALLBACK_COLOR)
        self.assertEqual(sv.body_color(sm.MapBody(name="X 3", kind=sm.KIND_PLANET)),
                         sv.BODY_FALLBACK_COLOR)

    def test_formatters_are_human_readable(self):
        self.assertIn("св. с", sv.format_distance(600.0))
        self.assertIn("км", sv.format_radius(6.371e6))
        self.assertIn("K", sv.format_temp(288.0))
        self.assertIn("т", sv.format_tons(8500.0).replace("t", "т").lower())
        self.assertIn("%", sv.build_progress_bar(42.0))

    def test_habitable_zone_of_sol_is_earth_like(self):
        sol = sm.MapBody(name="Sol", kind=sm.KIND_STAR, radius_m=6.957e8,
                         surface_temp_k=5778.0, star_type="G")
        inner, outer = sv.estimate_habitable_zone_ls(sol)
        # 0,75–1,77 а.е. — те же границы, что считает сайт (habitableZoneLs).
        self.assertAlmostEqual(inner, 374.25, delta=1.0)
        self.assertAlmostEqual(outer, 883.2, delta=2.0)
        self.assertIsNone(sv.estimate_habitable_zone_ls(
            sm.MapBody(name="KELT A 1", kind=sm.KIND_PLANET, radius_m=6e6)))

    def test_view_mode_normalisation(self):
        for alias in ("2d", "top", "сверху", " flat "):
            self.assertEqual(sv.normalize_view_mode(alias), "2d")
        for alias in ("3d", "iso", "3D", "", None, "мусор"):
            self.assertEqual(sv.normalize_view_mode(alias), "3d")

    def test_short_label_strips_system_prefix(self):
        self.assertEqual(sv.short_label("KELT A 1", "KELT"), "A 1")
        self.assertEqual(sv.short_label("БезСистемы", "KELT"), "БезСистемы")


class ViewPayloadTests(unittest.TestCase):
    """Пакет данных — то, что видит рендерер: тела, кластеры, зоны, постройки."""

    def setUp(self):
        self.snapshot = _kelt_snapshot()
        self.payload = sv.build_view_payload(self.snapshot)

    def test_summary_matches_bodies(self):
        summary = self.payload["summary"]
        self.assertEqual(summary["stars"], 2)
        self.assertEqual(summary["bodies"], len(self.payload["bodies"]))
        self.assertEqual(summary["planets"], 2)
        self.assertEqual(summary["landable"], 1)
        self.assertEqual(summary["structures"], 1)
        self.assertEqual(summary["activeSites"], 1)

    def test_planet_of_secondary_star_belongs_to_it(self):
        self.assertEqual(_body(self.payload, "KELT B 1")["star"], "KELT B")
        self.assertEqual(_body(self.payload, "KELT A 1")["star"], "KELT A")
        clusters = {cluster["star"]: cluster["bodies"] for cluster in self.payload["clusters"]}
        self.assertIn("KELT B 1", clusters["KELT B"])
        self.assertNotIn("KELT B 1", clusters["KELT A"])

    def test_secondary_star_has_an_orbit(self):
        star_orbits = {orbit["name"]: orbit for orbit in self.payload["orbits"]
                       if orbit["kind"] == "star"}
        self.assertIn("KELT B", star_orbits, "у второй звезды нет своей орбиты")
        self.assertGreaterEqual(len(star_orbits["KELT B"]["points"]), 8)

    def test_habitable_zone_per_star(self):
        owners = {zone["owner"] for zone in self.payload["zones"]}
        self.assertEqual(owners, {"KELT A", "KELT B"})
        for zone in self.payload["zones"]:
            self.assertLess(zone["innerLs"], zone["outerLs"])
            self.assertLess(zone["inner"], zone["outer"])

    def test_habitable_band_counts_from_the_parent_for_moons(self):
        payload = sv.build_view_payload(_sol_with_moon_snapshot())
        self.assertEqual(_body(payload, "Sol 3")["habitableBand"], "habitable")
        # Луна вращается вокруг планеты, но зона считается по орбите планеты:
        # иначе луна в обитаемой зоне выглядела бы «дальше зоны».
        self.assertEqual(_body(payload, "Sol 3 a")["habitableBand"], "habitable")
        bands = {body["name"]: body["habitableBand"] for body in payload["bodies"]}
        self.assertEqual(bands["Sol"], None, "у звезды не бывает полосы обитаемости")

    def test_structure_sits_on_the_body_surface(self):
        structure = self.payload["structures"][0]
        self.assertEqual(structure["body"], "KELT A 1")
        body = _body(self.payload, "KELT A 1")
        distance = math.dist(structure["position"], body["position"])
        self.assertGreater(distance, 0.0, "постройка легла в центр тела")
        self.assertLessEqual(distance, body["radius"] * 1.3 + 1.0,
                             "постройка висит далеко от поверхности тела")
        self.assertAlmostEqual(structure["progress"], 42.0, delta=1.0)
        self.assertTrue(structure["onSurface"], "планетарная стройка не помечена наземной")
        self.assertTrue(body["structures"], "тело не знает о своей стройке")

    def test_structure_carries_cargo_and_resources(self):
        structure = self.payload["structures"][0]
        self.assertGreater(structure["remainingTons"], 0)
        self.assertLess(structure["remainingTons"], structure["requiredTons"])
        names = [resource["name"] for resource in structure["resources"]]
        self.assertIn("Сталь", names, "товар показан «слепым» ключом Raven")

    def test_moons_toggle_adds_and_removes_moons(self):
        snapshot = _sol_with_moon_snapshot()
        with_moons = sv.build_view_payload(snapshot, show_moons=True)
        without = sv.build_view_payload(snapshot, show_moons=False)
        self.assertTrue(any(body["kind"] == "moon" for body in with_moons["bodies"]))
        self.assertFalse(any(body["kind"] == "moon" for body in without["bodies"]))
        self.assertEqual(with_moons["summary"]["moons"], 1)
        self.assertEqual(without["summary"]["moons"], 0)

    def test_scale_modes_keep_bodies_but_change_the_layout(self):
        linear = sv.build_view_payload(self.snapshot, scale_mode="linear")
        self.assertEqual(linear["scaleMode"], "linear")
        self.assertEqual(len(linear["bodies"]), len(self.payload["bodies"]))
        distances = [math.dist(_body(linear, name)["position"], (0.0, 0.0, 0.0))
                     for name in ("KELT A 1", "KELT B 1")]
        original = [math.dist(_body(self.payload, name)["position"], (0.0, 0.0, 0.0))
                    for name in ("KELT A 1", "KELT B 1")]
        self.assertNotEqual(distances, original, "линейный масштаб ничего не изменил")

    def test_start_focus_and_zoom_from_the_tab(self):
        payload = sv.build_view_payload(self.snapshot, selected="KELT A 1", zoom=2)
        self.assertEqual(payload["startFocus"], "KELT A 1")
        self.assertEqual(payload["startZoom"], 2)
        self.assertEqual(sv.build_view_payload(self.snapshot, zoom=9)["startZoom"], 3)

    def test_player_marker_uses_his_body(self):
        snapshot = _kelt_snapshot()
        snapshot.player.body_name = "KELT A 1"
        snapshot.player.system = "KELT"
        payload = sv.build_view_payload(snapshot)
        self.assertEqual(payload["player"]["body"], "KELT A 1")
        self.assertEqual(payload["player"]["position"], _body(payload, "KELT A 1")["position"])

    def test_payload_is_json_serialisable(self):
        text = json.dumps(self.payload, ensure_ascii=False)
        self.assertEqual(json.loads(text)["system"], "KELT")
        self.assertEqual(self.payload["version"], sv.VIEW_VERSION)

    def test_body_carries_every_signal_kind(self):
        """Сигналы тела едут в пакет целиком — как на сайте (`BodySignals`)."""
        signals = _body(self.payload, "KELT A 1")["signals"]
        self.assertEqual(signals["bio"], 3)
        self.assertEqual(signals["geo"], 5)
        self.assertEqual(signals["human"], 1)
        self.assertEqual(signals["thargoid"], 0)
        self.assertEqual(signals["genuses"], ["Бактерии"])
        self.assertEqual(_body(self.payload, "KELT A 1")["bioSignals"], 3)
        self.assertEqual(self.payload["summary"]["signals"]["geo"], 5)
        self.assertEqual(self.payload["summary"]["signalBodies"], 1)

    def test_empty_system_still_builds(self):
        payload = sv.build_view_payload(sm.MapSnapshot(system="Пусто"))
        self.assertEqual(payload["bodies"], [])
        self.assertEqual(payload["structures"], [])
        self.assertIsNone(payload["player"])


class OrbitAndMarkerTests(unittest.TestCase):
    """Маркер тела обязан лежать на нарисованной орбите.

    Повод: раньше орбита рисовалась своим эллипсом и подгонялась под точку из
    плана, и в системе с настоящими элементами маркер съезжал на ~e·a.
    """

    def _geometry(self):
        builder = sm.SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": "Sol", "SystemAddress": 1})
        builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol",
                        "ScanType": "Detailed", "StarType": "G", "BodyID": 1,
                        "Radius": 6.957e8, "DistanceFromArrivalLS": 0.0,
                        "EffectiveTemperature": 5778})
        builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol 3",
                        "ScanType": "Detailed", "PlanetClass": "Rocky body", "BodyID": 3,
                        "Radius": 6.4e6, "DistanceFromArrivalLS": 499.0,
                        "SemiMajorAxis": 1.496e11, "Eccentricity": 0.5,
                        "OrbitalInclination": 3.0, "Periapsis": 102.9,
                        "OrbitalPeriod": 31558149.0, "MeanAnomaly": 358.6,
                        "Parents": [{"Star": 1}]})
        builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol 3 a",
                        "ScanType": "Detailed", "PlanetClass": "Rocky body", "BodyID": 4,
                        "Radius": 1.7e6, "DistanceFromArrivalLS": 499.0,
                        "SemiMajorAxis": 3.84e8, "Eccentricity": 0.0549,
                        "OrbitalInclination": -23.4, "OrbitalPeriod": 2360591.0,
                        "MeanAnomaly": 90.0, "Parents": [{"Planet": 3}, {"Star": 1}]})
        builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol 4",
                        "ScanType": "Detailed", "PlanetClass": "Icy body", "BodyID": 5,
                        "Radius": 5e6, "DistanceFromArrivalLS": 900.0,
                        "SemiMajorAxis": 2.7e11, "Parents": [{"Star": 1}]})
        return sv.build_view_payload(builder.snapshot("Sol"))

    def test_planet_marker_sits_on_its_drawn_orbit(self):
        payload = self._geometry()
        orbit = next(item for item in payload["orbits"] if item["name"] == "Sol 3")
        distance = _point_to_polyline(tuple(_body(payload, "Sol 3")["position"]),
                                      [tuple(point) for point in orbit["points"]])
        # Допуск — дискретизация полилинии; съезд по элементам был бы ~e·a.
        self.assertLess(distance, 0.35, f"маркер съехал с орбиты на {distance}")
        self.assertTrue(orbit["real"], "орбита с настоящими элементами не помечена")
        self.assertAlmostEqual(orbit["periodDays"], 365.256, places=2)

    def test_moon_marker_sits_on_its_drawn_orbit(self):
        payload = self._geometry()
        orbit = next(item for item in payload["moonOrbits"] if item["name"] == "Sol 3 a")
        distance = _point_to_polyline(tuple(_body(payload, "Sol 3 a")["position"]),
                                      [tuple(point) for point in orbit["points"]])
        self.assertLess(distance, 0.35, f"маркер луны съехал на {distance}")
        self.assertTrue(orbit["real"])

    def test_body_without_elements_still_matches_its_circle(self):
        payload = self._geometry()
        orbit = next(item for item in payload["orbits"] if item["name"] == "Sol 4")
        points = [tuple(point) for point in orbit["points"]]
        radius = max(math.dist((0.0, 0.0, 0.0), point) for point in points)
        sagitta = radius * (1.0 - math.cos(math.pi / max(1, len(points) - 1)))
        distance = _point_to_polyline(tuple(_body(payload, "Sol 4")["position"]), points)
        self.assertLessEqual(distance, sagitta * 1.5 + 1e-9,
                             f"{distance} больше сагитты {sagitta}")
        self.assertFalse(orbit["real"], "без элементов орбита не может быть «настоящей»")


class StandaloneHtmlRemovedTests(unittest.TestCase):
    """Автономного HTML больше нет: карта живёт во вкладке приложения.

    Проверка «наоборот»: раньше модуль собирал страницу и открывал браузер,
    и эти имена легко вернуть по привычке. Если такой тест упал — значит в
    приложении снова появился путь «карта в браузере».
    """

    HTML_NAMES = ("generate_map_html", "export_map_html", "open_map_in_browser",
                  "viewer_script", "viewer_contract", "cards_html",
                  "map_summary_text", "MAP_TEMPLATE", "CARD_RAIL_CSS",
                  "open_plotly_in_browser", "export_plotly_html")

    def test_module_has_no_html_path(self):
        for name in self.HTML_NAMES:
            self.assertFalse(hasattr(sv, name), f"вернулся автономный HTML: {name}")

    def test_no_browser_and_no_bundle_on_disk(self):
        source = Path(sv.__file__).read_text(encoding="utf-8")
        self.assertNotIn("webbrowser", source, "system_view снова открывает браузер")
        self.assertFalse((HERE.parent / "assets" / "orrery-viewer.js").exists(),
                         "сборка движка для автономной страницы вернулась в репозиторий")

    def test_summary_is_built_from_the_payload(self):
        """Сводка «сколько чего» осталась — её показывает заголовок карты."""
        payload = sv.build_view_payload(_kelt_snapshot())
        summary = payload["summary"]
        self.assertEqual(summary["stars"], 2)
        self.assertEqual(summary["structures"], 1)
        self.assertEqual(payload["version"], sv.VIEW_VERSION)

class AppIntegrationTests(unittest.TestCase):
    """Вкладка карты: кнопки, экспорт и обратная совместимость имён."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(HERE))
        from test_initial_upload_flow import install_gui_stubs
        install_gui_stubs()
        import colonial_helper
        cls.app_cls = colonial_helper.ColonialHelperApp

    @staticmethod
    def _app(snapshot=None, config=None):
        app = mock.MagicMock(spec=AppIntegrationTests.app_cls)
        app._map_last_snapshot = snapshot if snapshot is not None else sm.MapSnapshot(system="Sol")
        app.config = config if config is not None else {}
        app._map_selected = ""
        app.system_map = mock.MagicMock()
        app.system_map.snapshot.return_value = app._map_last_snapshot
        app.map_moons_var = mock.MagicMock()
        app.map_moons_var.get.return_value = True
        # Сцена и переключатели вкладки: в spec класса их нет — это состояние,
        # которое создаётся в `__init__`, а приложение здесь игрушечное.
        app.map_view_mode = mock.MagicMock()
        app.map_view_mode.get.return_value = "3d"
        app._map3d_scene = mock.MagicMock()
        app._map3d_view = mock.MagicMock()
        app.notebook = mock.MagicMock()
        app.tab_map = "tab-map"
        app._map_hint = []
        # Параметры вида читает настоящий метод: у mock-приложения его надо
        # привязать, иначе он вернёт заглушку и тест ничего не проверит.
        app._map_viewer_options = lambda: AppIntegrationTests.app_cls._map_viewer_options(app)
        return app

    def test_app_has_map_methods(self):
        for name in ("_on_map_open_3d", "_on_map_open_plotly", "_map_viewer_options",
                     "_on_map_tree_context", "_map3d_scene", "_draw_system_map_3d",
                     "_on_map_motion_toggle", "_on_map_motion_speed", "_on_map_level_change",
                     "_on_map_view_preset", "_on_map_reset_3d", "_on_map_reset_time",
                     "_on_map_key", "_on_map_dolly"):
            self.assertTrue(hasattr(self.app_cls, name), f"нет метода {name}")
        for gone in ("_on_map_export_3d", "_on_map_export_plotly"):
            self.assertFalse(hasattr(self.app_cls, gone),
                             f"экспорт автономного HTML вернулся: {gone}")

    def test_empty_snapshot_asks_for_data(self):
        app = self._app(snapshot=sm.MapSnapshot(system=""))
        self.app_cls._on_map_open_3d(app)
        app._map_set_hint.assert_called_with("Нет данных о текущей системе для карты")

    def test_open_shows_the_scene_in_the_tab(self):
        """«3D-карта» открывает сцену на месте: вкладка, режим, перерисовка."""
        app = self._app()
        self.app_cls._on_map_open_3d(app, "KELT A 1")
        app.map_view_mode.set.assert_called_with("3d")
        self.assertEqual(app.config["map_view_mode"], "3d")
        self.assertEqual(app._map_selected, "KELT A 1")
        self.assertEqual(app._map_center, "KELT A 1")
        app.notebook.select.assert_called_once_with(app.tab_map)
        app._map_redraw_now.assert_called_once()
        app.log.assert_called_once()
        # Никакого браузера: открывать карту больше нечем.
        with mock.patch("webbrowser.open") as mock_browser:
            self.app_cls._on_map_open_plotly(app)
        mock_browser.assert_not_called()

    def test_legacy_config_key_selects_the_start_view(self):
        plain = self._app(config={"map_viewer_view": "2d", "map_viewer_zoom": 1})
        self.assertEqual(self.app_cls._map_viewer_options(plain)["view_mode"], "2d")
        self.assertEqual(self.app_cls._map_viewer_options(plain)["zoom"], 1)
        legacy = self._app(config={"map_plotly_view": "2d", "map_plotly_zoom": 1})
        self.assertEqual(self.app_cls._map_viewer_options(legacy)["view_mode"], "2d")
        self.assertEqual(self.app_cls._map_viewer_options(legacy)["zoom"], 1)

    def test_failure_is_reported_not_raised(self):
        """Ошибка сцены не роняет вкладку: приложение показывает подсказку."""
        app = self._app()
        app._map3d_scene.side_effect = OSError("нет места")
        with mock.patch.object(self.app_cls, "_map_redraw_now",
                               side_effect=OSError("нет места")):
            self.app_cls._on_map_open_3d(app)
        app._map_set_hint.assert_called()
        app.log.assert_called_once()

    def test_copy_map_text_hint(self):
        app = self._app()
        self.app_cls._copy_map_text(app, "KELT A 1", "Скопировано")
        app._map_set_hint.assert_called_with("Скопировано")


class ContractParityTests(unittest.TestCase):
    """Версия контракта — одна на движок, приложение и сайт."""

    def test_site_and_app_share_the_contract_version(self):
        types = (HERE.parent.parent / "src" / "lib" / "orrery3d" / "types.ts").read_text(encoding="utf-8")
        marker = "ORRERY_VIEW_VERSION"
        self.assertIn(marker, types, "на сайте нет константы версии контракта")
        value = int(types.split(marker, 1)[1].split("=", 1)[1].split(";", 1)[0].strip())
        self.assertEqual(value, sv.VIEW_VERSION,
                         "версии пакета сайта и приложения разошлись")

    def test_payload_field_names_match_the_engine_types(self):
        """Поля пакета перечислены в типах движка — иначе рендерер их не найдёт."""
        types = (HERE.parent.parent / "src" / "lib" / "orrery3d" / "types.ts").read_text(encoding="utf-8")
        payload = sv.build_view_payload(_kelt_snapshot())
        for field in ("version", "system", "span", "scaleMode", "summary", "clusters",
                      "bodies", "orbits", "moonOrbits", "zones", "structures", "player"):
            self.assertIn(f"{field}", payload, f"в пакете нет поля {field}")
            self.assertIn(f"{field}:", types, f"движок не знает поля {field}")


if __name__ == "__main__":
    unittest.main()
