"""Тесты «карточек системы» и приближения в HTML-экспорте Plotly.

Проверяют три вещи, ради которых карта переделывалась:

* многозвёздная система раскладывается кластерами, а не «всё вокруг главной»;
* наземные постройки сидят на видимой поверхности тела, а не висят в космосе;
* фокус на цели действительно режет размах осей (приближение), а иконки
  строек/станций мелкие и подписываются только у цели;
* HTML-экспорт несёт правую колонку карточек и JS, пересчитывающий зум.
"""

import math
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import orrery
import plotly_map as pm
import system_map as sm


def _snapshot():
    builder = sm.SystemMapBuilder()
    builder.handle({"event": "FSDJump", "StarSystem": "KELT", "SystemAddress": 42})
    builder.handle({"event": "Scan", "StarSystem": "KELT", "BodyName": "KELT A", "ScanType": "Detailed",
                    "StarType": "G", "Radius": 1.7e9, "DistanceFromArrivalLS": 0.0,
                    "EffectiveTemperature": 5050})
    builder.handle({"event": "Scan", "StarSystem": "KELT", "BodyName": "KELT B", "ScanType": "Detailed",
                    "StarType": "M", "Radius": 3e8, "DistanceFromArrivalLS": 41000.0,
                    "EffectiveTemperature": 3400})
    builder.handle({"event": "Scan", "StarSystem": "KELT", "BodyName": "KELT A 1", "ScanType": "Detailed",
                    "PlanetClass": "Rocky body", "Radius": 6e6, "DistanceFromArrivalLS": 120.0,
                    "SemiMajorAxis": 1.1e10, "SurfaceGravity": 9.8, "Landable": True,
                    "Parents": [{"Star": 1}]})
    builder.handle({"event": "Scan", "StarSystem": "KELT", "BodyName": "KELT B 1", "ScanType": "Detailed",
                    "PlanetClass": "Icy body", "Radius": 2e6, "DistanceFromArrivalLS": 41000.0,
                    "SemiMajorAxis": 2.0e9, "Parents": [{"Star": 2}]})
    builder.handle({"event": "ColonisationConstructionDepot", "StarSystem": "KELT", "MarketID": 10,
                    "ConstructionName": "KELT A 1 Colony", "BodyName": "KELT A 1",
                    "ConstructionProgress": 0.42,
                    "ResourcesRequired": [{"Name": "Steel", "RequiredAmount": 100000, "ProvidedAmount": 42000}]})
    return builder.snapshot("KELT")


def _trace(schema, *parts):
    for trace in schema["data"]:
        name = str(trace.get("name") or "")
        if all(part in name for part in parts):
            return trace
    return None


class ClusterGeometryTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = _snapshot()

    def test_planet_of_secondary_star_belongs_to_it(self):
        schema = pm.build_plotly_dict(self.snapshot)
        positions = pm.build_system_geometry(self.snapshot)["positions"]
        distance = lambda a, b: ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5
        self.assertLess(distance(positions["KELT B 1"], positions["KELT B"]),
                        distance(positions["KELT B 1"], positions["KELT A"]))
        self.assertIsNotNone(_trace(schema, "Вторичные звёзды"))

    def test_secondary_star_has_an_orbit(self):
        geom = pm.build_system_geometry(self.snapshot)
        curves = [key for key in geom["orbit_curves"] if key.startswith("__star__:")]
        self.assertTrue(curves, "орбита второй звезды должна рисоваться")

    def test_habitable_zone_per_star(self):
        plan = orrery.plan_system(self.snapshot.bodies, "KELT")
        self.assertGreaterEqual(len(plan["hz_paths"]), 2)
        self.assertIsNotNone(_trace(pm.build_plotly_dict(self.snapshot), "Обитаемая зона"))


class SurfaceStationTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = _snapshot()
        self.geom = pm.build_system_geometry(self.snapshot)

    def test_station_sits_on_the_body_limb(self):
        position = self.geom["station_positions"]["KELT A 1 Colony"]
        body = self.geom["positions"]["KELT A 1"]
        offset = ((position[0] - body[0]) ** 2 + (position[1] - body[1]) ** 2
                  + (position[2] - body[2]) ** 2) ** 0.5
        marker_px = self.geom["markers"]["KELT A 1"]
        limb = (marker_px / 2.0) * ((self.geom["span"] * 2.0) / orrery.CANVAS_PX) * 1.25
        self.assertLess(offset, limb * 3.5, "постройка улетела с поверхности тела")

    def test_hover_says_the_station_is_on_the_surface(self):
        trace = _trace(pm.build_plotly_dict(self.snapshot), "Стройплощадки")
        self.assertIn("на поверхности", trace["hovertext"][0])


class IconsAndFocusTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = _snapshot()

    def test_site_icons_are_small(self):
        trace = _trace(pm.build_plotly_dict(self.snapshot), "Стройплощадки")
        self.assertTrue(all(size <= 9.5 for size in trace["marker"]["size"]),
                        "иконки строек обязаны быть мелкими")

    def test_dense_system_hides_labels(self):
        builder = sm.SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": "Dense", "SystemAddress": 7})
        builder.handle({"event": "Scan", "StarSystem": "Dense", "BodyName": "Dense A", "ScanType": "Detailed",
                        "StarType": "G", "Radius": 7e8, "DistanceFromArrivalLS": 0.0})
        for index in range(1, 40):
            builder.handle({"event": "Scan", "StarSystem": "Dense", "BodyName": f"Dense {index}",
                            "ScanType": "Detailed", "PlanetClass": "Rocky body", "Radius": 5e6,
                            "DistanceFromArrivalLS": 100.0 * index, "Parents": [{"Star": 1}]})
        builder.handle({"event": "ColonisationConstructionDepot", "StarSystem": "Dense", "MarketID": 3,
                        "ConstructionName": "Dense 5 Colony", "BodyName": "Dense 5",
                        "ConstructionProgress": 0.1, "ResourcesRequired": []})
        schema = pm.build_plotly_dict(builder.snapshot("Dense"))
        bodies = _trace(schema, "Планеты")
        sites = _trace(schema, "Стройплощадки")
        self.assertEqual([text for text in bodies["text"] if text], [], "в плотной системе подписи тел молчат")
        self.assertEqual([text for text in sites["text"] if text], [], "и подписи строек тем более")

    def test_labels_only_for_the_target(self):
        schema = pm.build_plotly_dict(self.snapshot, selected="KELT A 1", zoom=3)
        trace = _trace(schema, "Стройплощадки")
        self.assertTrue(any(text for text in trace["text"]))

    def test_focus_cuts_axis_span(self):
        overview = pm.build_plotly_dict(self.snapshot)["layout"]["scene"]
        self.assertIn("range", overview["xaxis"], "общий обзор обязан иметь явный размах осей")
        focused = pm.build_plotly_dict(self.snapshot, selected="KELT A 1", zoom=3)["layout"]["scene"]
        overview_span = overview["xaxis"]["range"][1] - overview["xaxis"]["range"][0]
        focused_span = focused["xaxis"]["range"][1] - focused["xaxis"]["range"][0]
        self.assertLess(focused_span, overview_span)
        # «Центрирование на цели» — в размахе осей: camera.center Plotly меряет в
        # нормализованных единицах, данные координаты там уносят вид в пустоту.
        self.assertEqual(focused["camera"]["center"], {"x": 0, "y": 0, "z": 0})
        position = pm.build_system_geometry(self.snapshot)["positions"]["KELT A 1"]
        for axis, key in (("xaxis", 0), ("yaxis", 1), ("zaxis", 2)):
            low, high = focused[axis]["range"]
            self.assertAlmostEqual((low + high) / 2.0, position[key], places=2,
                                   msg=f"{axis}: окно фокуса не по центру цели")
        # Окно фокуса = разрез движка с запасом FOCUS_PAD.
        view = orrery.focus_view(orrery.plan_system(self.snapshot.bodies, self.snapshot.system or ""),
                                 "KELT A 1", 3)
        self.assertAlmostEqual((focused["xaxis"]["range"][1] - focused["xaxis"]["range"][0]) / 2.0,
                               orrery.focus_window(view["half_span"]), places=3)

    def test_marker_sits_on_its_own_orbit_curve(self):
        """Маркер тела лежит на нарисованной эллиптической орбите (а не рядом)."""
        geom = pm.build_system_geometry(self.snapshot)
        import math
        for name, curve in geom["orbit_curves"].items():
            if name not in geom["positions"] or not curve["x"]:
                continue
            point = geom["positions"][name]
            distance = min(math.dist((curve["x"][i], curve["y"][i], curve["z"][i]), point)
                           for i in range(len(curve["x"])))
            self.assertLess(distance, max(0.05, abs(point[0]) * 0.02),
                            f"{name}: маркер в {distance:.3f} от своей орбиты")

    def test_zoom_buttons_are_offered_when_a_target_is_selected(self):
        schema = pm.build_plotly_dict(self.snapshot, selected="KELT A 1", zoom=2)
        buttons = schema["layout"]["updatemenus"][0]["buttons"]
        labels = [str(button.get("label")) for button in buttons]
        self.assertTrue(any("кластер" in label for label in labels))
        self.assertTrue(any("поверхность" in label for label in labels))


class HtmlCardsTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = _snapshot()
        self.html = pm.generate_plotly_html(self.snapshot)

    def test_card_rail_is_present(self):
        self.assertIn("Карточки системы", self.html)
        self.assertIn('data-name="KELT A 1"', self.html)
        self.assertIn("KELT A 1 Colony", self.html)

    def test_grouped_by_star(self):
        self.assertIn("★ B", self.html)

    def test_js_payload_and_focus_functions(self):
        self.assertIn("const PLAN =", self.html)
        self.assertIn("function focusView", self.html)
        self.assertIn("function structurePositions", self.html)
        self.assertIn("plotly_click", self.html)

    def test_html_view_toggle_switches_camera_only(self):
        """Переключатель вида в HTML — камера+проекция, а не другая фигура."""
        self.assertIn('id="view"', self.html)
        # Направление камеры приходит из Python-движка, а JS пишет camera целиком
        # (eye/up/center/projection) — только так переключение вида не уводит камеру.
        self.assertIn("const CAMERA = ", self.html)
        self.assertIn("relayout['scene.camera'] = ", self.html)
        self.assertIn("center: { x: 0, y: 0, z: 0 }", self.html)
        self.assertIn("const OVERVIEW_SPAN = ", self.html)
        self.assertNotIn("scene.projection", self.html)
        # Стартовая камера по умолчанию — 3D, как на сайте.
        self.assertIn("flat: false", self.html)
        # Сфера тела переиспользуется при зуме, а не перестраивается заново.
        self.assertIn("function refreshSphere", self.html)
        self.assertIn("function sphereGeometry", self.html)

    def test_flat_start_view_documented_in_payload(self):
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d")
        self.assertEqual(schema["layout"]["scene"]["camera"]["projection"]["type"], "orthographic")
        flat_html = pm.generate_plotly_html(self.snapshot, view_mode="2d")
        self.assertIn("flat: true", flat_html)
        self.assertIn('id="view" data-on="1"', flat_html)

    def test_empty_system_still_renders(self):
        empty = sm.MapSnapshot(system="EmptySys")
        html = pm.generate_plotly_html(empty)
        self.assertIn("EmptySys", html)
        self.assertIn("Нет данных о телах системы", html)

    def test_payload_is_json_serialisable(self):
        import json
        payload = pm.build_map_payload(self.snapshot)
        restored = json.loads(json.dumps(payload, ensure_ascii=False))
        self.assertIn("KELT A 1", restored["positions"])
        self.assertTrue(restored["structures"])
        self.assertTrue(restored["clusters"])


class PlotlySiteParityTests(unittest.TestCase):
    """Карта приложения и карта сайта — одна модель.

    Сайт (`src/components/SystemPlotlyMap.tsx`) не строит «плоскую» фигуру: там
    всегда одна 3D-сцена, а «вид сверху» — это камера. Если в приложении снова
    появится отдельный 2D-рендер (scatter + xaxis/yaxis), кнопки вида в
    статичном HTML молчат, и карта «работает только в 2D режиме».
    """

    SITE = HERE.parent.parent / "src" / "components" / "SystemPlotlyMap.tsx"

    @classmethod
    def setUpClass(cls):
        cls.snapshot = _snapshot()

    def test_site_and_app_share_the_same_view_model(self):
        source = self.SITE.read_text(encoding="utf-8")
        self.assertIn("type: 'scatter3d'", source)
        self.assertNotIn("type: 'scatter',", source,
                        "сайт ушёл в отдельную 2D-фигуру — паритет надо переносить сюда")
        # Камера и окна — из общего движка, а не на коленке в компоненте.
        self.assertIn("camera: sceneCamera(viewMode)", source)
        self.assertIn("focusWindow(halfSpan)", source)
        self.assertIn("overviewWindow(traceExtent(traces), layout.span)", source)
        self.assertIn("sphereGeometry", source)

    def test_camera_and_pads_are_one_source_of_truth(self):
        engine = (HERE.parent.parent / "src" / "lib" / "systemOrrery.ts").read_text(encoding="utf-8")
        for constant, value in (("FOCUS_PAD", orrery.FOCUS_PAD), ("OVERVIEW_PAD", orrery.OVERVIEW_PAD),
                                ("CAMERA_DISTANCE", orrery.CAMERA_DISTANCE)):
            self.assertIn(f"export const {constant} = {value};", engine,
                          f"{constant} разошёлся с uploader/orrery.py")
        iso = orrery.scene_camera("iso")["eye"]
        norm = (iso["x"] ** 2 + iso["y"] ** 2 + iso["z"] ** 2) ** 0.5
        self.assertAlmostEqual(norm, orrery.CAMERA_DISTANCE, places=6)
        self.assertGreater(norm, 1.0, "камера обязана быть снаружи единичного бокса сцены")

    def test_app_figure_matches_site_camera(self):
        """Стартовая камера = `sceneCamera('iso')` из движка сайта."""
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d")
        camera = schema["layout"]["scene"]["camera"]
        self.assertEqual(camera, orrery.scene_camera("iso"))
        self.assertEqual(camera["up"], {"x": 0, "y": 0, "z": 1})
        # Направление сайта: x>0, y<0 (азимут 0.62/−0.62/0.4).
        eye = camera["eye"]
        self.assertGreater(eye["x"], 0)
        self.assertLess(eye["y"], 0)
        self.assertGreater(eye["z"], 0)

    def test_app_figure_always_uses_scatter3d(self):
        for mode in ("3d", "2d", ""):
            schema = pm.build_plotly_dict(self.snapshot, view_mode=mode)
            self.assertIn("scene", schema["layout"])
            self.assertNotIn("xaxis", schema["layout"])
            for trace in schema["data"]:
                self.assertIn(trace["type"], ("scatter3d", "mesh3d"),
                              f"view_mode={mode!r}: в карте появилась 2D-трасса")

    def test_html_export_shares_the_sphere_grid_with_python(self):
        html = pm.generate_plotly_html(self.snapshot, view_mode="3d",
                                       selected="KELT A 1", zoom=3)
        # JS перекладывает вершины при зуме — сетка обязана прийти из движка,
        # иначе индексы граней статичной фигуры не совпадут с новыми вершинами.
        self.assertIn(f"const SPHERE_MESH = {list(orrery.sphere_mesh())}", html)
        self.assertIn("SPHERE_HAZE : SPHERE_MESH", html)
        self.assertIn(f"const HAZE_SCALE = {orrery.SPHERE_HAZE_SCALE}", html)
        self.assertIn(f"const SPHERE_LIFT = {orrery.SPHERE_SURFACE_LIFT}", html)
        self.assertNotIn("sphereGeometry(center, radius * 1.1, 20, 10)", html)

    def test_site_material_and_aspect_match_the_engine(self):
        engine = (HERE.parent.parent / "src" / "lib" / "systemOrrery.ts").read_text(encoding="utf-8")
        segments, rings = orrery.sphere_mesh()
        self.assertIn(f"export const SPHERE_MESH: [number, number] = [{segments}, {rings}];", engine)
        self.assertIn(f"export const SPHERE_HAZE_SCALE = {orrery.SPHERE_HAZE_SCALE};", engine)
        self.assertIn(f"export const SPHERE_SURFACE_LIFT = {orrery.SPHERE_SURFACE_LIFT};", engine)
        self.assertIn("opacity: 1,", engine, "сайт сделал сферу полупрозрачной — будет блин")
        self.assertIn("aspectmode: 'manual'", engine)
        component = self.SITE.read_text(encoding="utf-8")
        self.assertIn("...sceneAspect()", component)

    def test_sphere_grid_matches_site_constants(self):
        segments, rings = orrery.sphere_mesh()
        mesh = orrery.sphere_geometry([0.0, 0.0, 0.0], 1.0)
        self.assertEqual(len(mesh["x"]), (segments + 1) * (rings + 1))
        self.assertEqual(len(mesh["i"]), 2 * segments * rings)
        # Единичный радиус во всех направлениях — сфера, а не эллипсоид.
        self.assertAlmostEqual(max(mesh["x"]), 1.0, places=6)
        self.assertAlmostEqual(min(mesh["z"]), -1.0, places=6)
        self.assertAlmostEqual(orrery.detail_sphere_radius_units(100, 3), 42.0, places=6)
        self.assertAlmostEqual(orrery.detail_sphere_radius_units(100, 2), 14.0, places=6)


class OrbitCurveMatchesMarkerTests(unittest.TestCase):
    """Маркер тела обязан лежать на нарисованной орбите.

    Повод: `plotly_map` рисовал орбиту своим эллипсом и подгонял его под
    точку из плана через `_orbit_scale` — компенсацию для прежней КРУГОВОЙ
    раскладки. Когда `orrery.plan_system` начал ставить тела на настоящие
    эллипсы (звезда в фокусе), подгонка стала двойной и маркер съезжал с
    орбиты на ~e·a. Тест сравнивает маркер с той кривой, что реально уходит
    в Plotly, с поправкой на дискретизацию полилинии (сагитта хорды).
    """

    @staticmethod
    def _point_to_polyline(point, points):
        best = float("inf")
        for a, b in zip(points, points[1:]):
            ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
            ap = (point[0] - a[0], point[1] - a[1], point[2] - a[2])
            denom = sum(v * v for v in ab) or 1e-12
            t = max(0.0, min(1.0, sum(x * y for x, y in zip(ap, ab)) / denom))
            proj = (a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t)
            best = min(best, math.dist(point, proj))
        return best

    def _geometry(self):
        builder = sm.SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": "Sol", "SystemAddress": 1})
        builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol",
                        "ScanType": "Detailed", "StarType": "G", "BodyID": 1,
                        "Radius": 6.957e8, "DistanceFromArrivalLS": 0.0,
                        "EffectiveTemperature": 5778})
        # Планета с настоящими элементами: вытянутая орбита, наклон, перицентр.
        builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol 3",
                        "ScanType": "Detailed", "PlanetClass": "Rocky body", "BodyID": 3,
                        "Radius": 6.4e6, "DistanceFromArrivalLS": 499.0,
                        "SemiMajorAxis": 1.496e11, "Eccentricity": 0.5,
                        "OrbitalInclination": 3.0, "Periapsis": 102.9,
                        "OrbitalPeriod": 31558149.0, "MeanAnomaly": 358.6,
                        "Parents": [{"Star": 1}]})
        # Луна тоже с элементами.
        builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol 3 a",
                        "ScanType": "Detailed", "PlanetClass": "Rocky body", "BodyID": 4,
                        "Radius": 1.7e6, "DistanceFromArrivalLS": 499.0,
                        "SemiMajorAxis": 3.84e8, "Eccentricity": 0.0549,
                        "OrbitalInclination": -23.4, "OrbitalPeriod": 2360591.0,
                        "MeanAnomaly": 90.0, "Parents": [{"Planet": 3}, {"Star": 1}]})
        # И тело без элементов — прежняя схема.
        builder.handle({"event": "Scan", "StarSystem": "Sol", "BodyName": "Sol 4",
                        "ScanType": "Detailed", "PlanetClass": "Icy body", "BodyID": 5,
                        "Radius": 5e6, "DistanceFromArrivalLS": 900.0,
                        "SemiMajorAxis": 2.7e11, "Parents": [{"Star": 1}]})
        return pm.build_system_geometry(builder.snapshot(), show_moons=True)

    def test_planet_marker_sits_on_its_drawn_orbit(self):
        geom = self._geometry()
        curve = geom["orbit_curves"]["Sol 3"]
        points = list(zip(curve["x"], curve["y"], curve["z"]))
        distance = self._point_to_polyline(tuple(geom["positions"]["Sol 3"]), points)
        # Главное — геометрия: сагитта хорды при 96 сегментах это десятые
        # unit'а, а съезд при двойной подгонке был ~e·a (несколько unit'ов).
        self.assertLess(distance, 0.05, f"маркер съехал с орбиты на {distance}")
        self.assertTrue(curve.get("real"), "орбита с элементами помечена настоящей")
        self.assertAlmostEqual(curve.get("period_days", 0.0), 365.256, places=2)

    def test_moon_marker_sits_on_its_drawn_orbit(self):
        geom = self._geometry()
        curve = geom["moon_orbit_curves"]["Sol 3 a"]
        points = list(zip(curve["x"], curve["y"], curve["z"]))
        distance = self._point_to_polyline(tuple(geom["positions"]["Sol 3 a"]), points)
        self.assertLess(distance, 0.05, f"маркер луны съехал на {distance}")
        self.assertTrue(curve.get("real"))

    def test_body_without_elements_still_matches_its_circle(self):
        geom = self._geometry()
        curve = geom["orbit_curves"]["Sol 4"]
        points = list(zip(curve["x"], curve["y"], curve["z"]))
        radius = max(math.dist((0.0, 0.0, 0.0), p) for p in points)
        # Допуск — сагитта хорды полилинии, а не произвольное число.
        sagitta = radius * (1.0 - math.cos(math.pi / max(1, len(points) - 1)))
        distance = self._point_to_polyline(tuple(geom["positions"]["Sol 4"]), points)
        self.assertLessEqual(distance, sagitta * 1.5 + 1e-9,
                             f"{distance} больше сагитты {sagitta}")
        self.assertNotEqual(curve.get("real"), True, "без элементов орбита не «настоящая»")

    def test_star_color_follows_temperature(self):
        # Тот же цвет, что на сайте: сначала температура, класс — запасной.
        self.assertEqual(pm.get_star_color("G", 5778.0), "rgb(255, 244, 234)")
        self.assertEqual(pm.get_star_color("G", 0.0), pm.get_star_color("G"))
        self.assertEqual(pm.get_star_color("", 0.0), pm.ED_COLOR_STAR_DEFAULT)

if __name__ == "__main__":
    unittest.main()
