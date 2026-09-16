"""Тесты интерактивной карты Plotly (plotly_map.py и интеграции в Colonial Helper)."""

import json
import os
import sys
import tempfile
import math
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import orrery
import plotly_map as pm
import system_map as sm


class PlotlyMapGeometryTests(unittest.TestCase):
    """Тесты построения геометрии и структуры данных Plotly."""

    def setUp(self):
        self.builder = sm.SystemMapBuilder()
        self.builder.handle({"event": "FSDJump", "StarSystem": "TestSys", "SystemAddress": 999111})
        self.builder.handle({
            "event": "Scan",
            "StarSystem": "TestSys",
            "BodyName": "TestSys A",
            "ScanType": "Detailed",
            "StarType": "G",
            "Radius": 6.96e8,
            "DistanceFromArrivalLS": 0.0,
        })
        self.builder.handle({
            "event": "Scan",
            "StarSystem": "TestSys",
            "BodyName": "TestSys 1",
            "ScanType": "Detailed",
            "PlanetClass": "Earthlike body",
            "Radius": 6.37e6,
            "DistanceFromArrivalLS": 300.0,
            "SemiMajorAxis": 9e10,
            "Eccentricity": 0.02,
            "OrbitalInclination": 3.5,
            "SurfaceGravity": 9.81,
            "SurfaceTemperature": 290.0,
            "Landable": False,
        })
        self.builder.handle({
            "event": "SAASignalsFound",
            "StarSystem": "TestSys",
            "BodyName": "TestSys 1",
            "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 3}],
            "Genuses": [{"Genus_Localised": "Stratum"}, {"Genus_Localised": "Tubus"}],
        })
        self.builder.handle({
            "event": "Scan",
            "StarSystem": "TestSys",
            "BodyName": "TestSys 1 a",
            "ScanType": "Detailed",
            "PlanetClass": "Rocky body",
            "Radius": 1.7e6,
            "DistanceFromArrivalLS": 301.0,
            "Parents": [{"Planet": 1}],
            "Landable": True,
            "SurfaceGravity": 1.6,
        })
        self.builder.handle({
            "event": "ColonisationConstructionDepot",
            "StarSystem": "TestSys",
            "MarketID": 100200,
            "ConstructionName": "Site Alpha",
            "BodyName": "TestSys 1",
            "ConstructionProgress": 0.55,
            "ResourcesRequired": [{"Name": "Titanium", "RequiredAmount": 4000, "ProvidedAmount": 2200}],
        })
        self.builder.handle({
            "event": "Location",
            "StarSystem": "TestSys",
            "Body": "TestSys 1",
            "Docked": False,
        })
        self.snapshot = self.builder.snapshot("TestSys")

    def test_build_plotly_dict_basic_structure(self):
        schema = pm.build_plotly_dict(self.snapshot)
        self.assertIn("data", schema)
        self.assertIn("layout", schema)
        self.assertIn("config", schema)
        self.assertIsInstance(schema["data"], list)
        self.assertGreater(len(schema["data"]), 3)

    def test_traces_contain_expected_objects(self):
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d")
        trace_names = [t.get("name") for t in schema["data"]]
        self.assertIn("Главная звезда", trace_names)
        self.assertIn("Планеты", trace_names)
        self.assertIn("Луны", trace_names)
        self.assertIn("Стройплощадки", trace_names)
        self.assertIn("Вы здесь (CMDR)", trace_names)
        self.assertIn("Орбиты планет", trace_names)

    def test_view_mode_3d_uses_scatter3d_and_z(self):
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d")
        for trace in schema["data"]:
            self.assertEqual(trace["type"], "scatter3d")
            self.assertIn("z", trace)
        self.assertIn("scene", schema["layout"])
        self.assertNotIn("xaxis", schema["layout"])

    def test_view_mode_2d_is_a_camera_not_a_flat_figure(self):
        """«2D» — вид сверху в той же 3D-сцене, а не отдельная плоская фигура.

        Раньше 2D строил scatter-трассы без `scene`, из-за чего все кнопки вида
        в HTML (они пишут в `scene.*`) молчали, и карта из приложения
        «работала только в 2D режиме».
        """
        schema = pm.build_plotly_dict(self.snapshot, view_mode="2d")
        for trace in schema["data"]:
            self.assertEqual(trace["type"], "scatter3d")
            self.assertIn("z", trace)
        self.assertIn("scene", schema["layout"])
        self.assertNotIn("xaxis", schema["layout"])
        camera = schema["layout"]["scene"]["camera"]
        self.assertEqual(camera["projection"]["type"], "orthographic")
        eye = camera["eye"]
        self.assertGreater(eye["z"], 1.0)
        self.assertLess(abs(eye["x"]), 0.01)
        self.assertLess(abs(eye["y"]), 0.01)
        self.assertEqual(camera["up"], {"x": 0, "y": 1, "z": 0})

    def test_view_mode_3d_uses_site_isometric_camera(self):
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d")
        camera = schema["layout"]["scene"]["camera"]
        # Ортография: в перспективе часть системы обрезается краем рамки.
        self.assertEqual(camera["projection"]["type"], "orthographic")
        eye = camera["eye"]
        # Азимут сайта: (0.62, −0.62, 0.4), т.е. x>0, y<0.
        self.assertGreater(eye["x"], 0.5)
        self.assertLess(eye["y"], -0.5)
        self.assertGreater(eye["z"], 0.3)
        self.assertAlmostEqual(eye["x"], -eye["y"], places=6)
        # |eye| > 1 — камера снаружи единичного бокса сцены, иначе она внутри
        # сферы тела и на «поверхности» был бы чёрный экран.
        self.assertGreater(sum(value * value for value in eye.values()) ** 0.5, 1.2)

    def test_camera_center_is_always_normalised_zero(self):
        """`camera.center` — нормализованные единицы: координаты цели там убивают вид."""
        for mode in ("3d", "2d"):
            for zoom in (0, 1, 2, 3):
                schema = pm.build_plotly_dict(self.snapshot, view_mode=mode,
                                              selected="TestSys 1", zoom=zoom)
                self.assertEqual(schema["layout"]["scene"]["camera"]["center"],
                                 {"x": 0, "y": 0, "z": 0},
                                 f"view={mode} zoom={zoom}: центр камеры уехал в data-единицы")

    def test_scene_layout_uses_only_valid_plotly_keys(self):
        """Plotly (go.Figure) валидирует layout: неизвестный ключ роняет сборку.

        Так и сломался CI: `scene.projection` не существует, проекция живёт в
        `scene.camera.projection`.
        """
        schema = pm.build_plotly_dict(self.snapshot, view_mode="2d", selected="TestSys 1", zoom=3)
        scene = schema["layout"]["scene"]
        self.assertLessEqual(set(scene), {"bgcolor", "camera", "xaxis", "yaxis", "zaxis",
                                         "aspectmode", "aspectratio", "dragmode", "annotations",
                                         "domain", "hovermode"})
        self.assertLessEqual(set(scene["camera"]), {"eye", "up", "center", "projection"})
        for key in scene["camera"]["eye"]:
            self.assertIn(key, ("x", "y", "z"))

    def test_overview_box_contains_every_plotted_point(self):
        """В обзоре ничего не должно обрезаться краем поля."""
        for mode in ("3d", "2d"):
            schema = pm.build_plotly_dict(self.snapshot, view_mode=mode)
            extent = orrery.trace_extent(schema["data"])
            self.assertGreater(extent, 0)
            for axis in ("xaxis", "yaxis", "zaxis"):
                low, high = schema["layout"]["scene"][axis]["range"]
                self.assertLessEqual(low, -extent + 1e-6, f"{mode}/{axis}: левый край режет данные")
                self.assertGreaterEqual(high, extent - 1e-6, f"{mode}/{axis}: правый край режет данные")
                self.assertAlmostEqual(high, -low, places=6, msg="разрез обязан быть кубическим")

    def test_focus_body_is_a_ball_not_a_pancake(self):
        """Тело в фокусе — шар: равные габариты по осям, свет и непрозрачность."""
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d", selected="TestSys 1", zoom=3)
        scene = schema["layout"]["scene"]
        # Бокс обязан быть кубическим: 'data' сплющивает сцену по габариту данных,
        # а у системы с почти плоским z это превращает планеты в блины.
        self.assertEqual(scene["aspectmode"], "manual")
        self.assertEqual(scene["aspectratio"], {"x": 1, "y": 1, "z": 1})
        mesh = next(t for t in schema["data"] if t.get("meta") == "sphere")
        radius = {}
        for axis in ("x", "y", "z"):
            extent = (max(mesh[axis]) - min(mesh[axis])) / 2.0
            radius[axis] = extent
        self.assertAlmostEqual(radius["x"], radius["y"], places=6)
        self.assertAlmostEqual(radius["y"], radius["z"], places=6)
        # Непрозрачный материал: иначе просвечивают обратные грани — «блин».
        self.assertEqual(mesh["opacity"], orrery.SPHERE_MATERIAL["opacity"])
        self.assertEqual(mesh["opacity"], 1.0)
        self.assertFalse(mesh["flatshading"])
        lighting = mesh["lighting"]
        self.assertGreater(lighting["diffuse"], lighting["ambient"],
                           "без косого света шар выглядит плоским пятном")
        self.assertIn("lightposition", mesh)
        # Сетка — из общего движка (и она же уходит в JS экспорта).
        segments, rings = orrery.sphere_mesh()
        self.assertEqual(len(mesh["x"]), (segments + 1) * (rings + 1))
        self.assertEqual(len(mesh["i"]), 2 * segments * rings)

    def test_sphere_traces_use_only_valid_mesh3d_keys(self):
        """`go.Figure` валидирует и трассы: выдуманный ключ mesh3d роняет экспорт.

        Локально plotly может отсутствовать, поэтому проверяем список ключей сами —
        так же, как `test_scene_layout_uses_only_valid_plotly_keys` для layout.
        """
        allowed = {"type", "meta", "name", "x", "y", "z", "i", "j", "k",
                   "color", "colorscale", "cmin", "cmax", "opacity", "flatshading",
                   "lighting", "lightposition", "contour", "hoverinfo", "showscale",
                   "visible", "showlegend", "legendgroup", "hovertext", "customdata", "scene"}
        lighting_keys = {"ambient", "diffuse", "specular", "roughness", "fresnel"}
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d", selected="TestSys 1", zoom=3)
        meshes = [t for t in schema["data"] if t.get("type") == "mesh3d"]
        self.assertTrue(meshes)
        for trace in meshes:
            self.assertLessEqual(set(trace), allowed, f"{trace.get('meta')}: лишние ключи mesh3d")
            self.assertLessEqual(set(trace.get("lighting", {})), lighting_keys)
            for key in trace.get("lightposition", {}):
                self.assertIn(key, ("x", "y", "z"))

    def test_haze_is_a_bigger_shell_with_its_own_grid(self):
        body = next(b for b in self.snapshot.bodies if b.name == "TestSys 1")
        body.atmosphere = "Nitrogen / Oxygen"
        try:
            schema = pm.build_plotly_dict(self.snapshot, view_mode="3d",
                                          selected="TestSys 1", zoom=3)
        finally:
            body.atmosphere = ""
        sphere = next(t for t in schema["data"] if t.get("meta") == "sphere")
        haze = next(t for t in schema["data"] if t.get("meta") == "sphere_haze")

        def shell_radius(trace):
            center = ((min(trace["x"]) + max(trace["x"])) / 2.0,
                      (min(trace["y"]) + max(trace["y"])) / 2.0,
                      (min(trace["z"]) + max(trace["z"])) / 2.0)
            # Все вершины широтной сетки лежат на сфере → берём максимум расстояний.
            return max(math.dist((x, y, z), center)
                       for x, y, z in zip(trace["x"], trace["y"], trace["z"]))

        self.assertGreater(shell_radius(haze), shell_radius(sphere))
        self.assertAlmostEqual(shell_radius(haze) / shell_radius(sphere), orrery.SPHERE_HAZE_SCALE, places=3)
        self.assertLess(haze["opacity"], 1.0, "дымка обязана оставаться полупрозрачной")
        # Сетка дымки мельче — и её вершины/индексы должны быть между собой согласованы.
        haze_segments, haze_rings = max(12, int(orrery.sphere_mesh()[0] * 0.8)), max(8, int(orrery.sphere_mesh()[1] * 0.8))
        self.assertEqual(len(haze["x"]), (haze_segments + 1) * (haze_rings + 1))
        self.assertEqual(len(haze["i"]), 2 * haze_segments * haze_rings)

    def test_sphere_fits_inside_the_focus_window(self):
        """Сфера тела вместе с дымкой помещается в окно уровня 3 — иначе чёрный экран."""
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d", selected="TestSys 1", zoom=3)
        scene = schema["layout"]["scene"]
        low, high = scene["xaxis"]["range"]
        mesh = next(t for t in schema["data"] if t.get("meta") == "sphere")
        self.assertLessEqual(max(mesh["x"]), high)
        self.assertGreaterEqual(min(mesh["x"]), low)

    def test_view_buttons_relayout_the_same_scene(self):
        """Кнопки вида пишут только в валидные ключи scene.camera.*."""
        schema = pm.build_plotly_dict(self.snapshot, view_mode="2d")
        buttons = schema["layout"]["updatemenus"][0]["buttons"]
        labels = {b["label"]: b["args"][0] for b in buttons}
        for label in ("🔭 3D Orrery", "🧭 Сверху (2D)", "📐 Сбоку (Профиль)", "🔄 Сброс",
                      "🎥 Перспектива", "🧊 Ортография"):
            self.assertIn(label, labels)
        self.assertEqual(labels["🧭 Сверху (2D)"]["scene.camera"]["up"], {"x": 0, "y": 1, "z": 0})
        self.assertEqual(labels["🎥 Перспектива"]["scene.camera.projection.type"], "perspective")
        self.assertEqual(labels["🧊 Ортография"]["scene.camera.projection.type"], "orthographic")
        for label, args in labels.items():
            for key in args:
                self.assertTrue(key.startswith("scene."), f"{label}: мимо сцены — {key}")
                self.assertNotIn("scene.projection", key)
            camera = args.get("scene.camera")
            if camera:
                self.assertEqual(camera["center"], {"x": 0, "y": 0, "z": 0})

    def test_focus_body_gets_sphere_without_haze(self):
        """В режимах «окрестности»/«поверхность» тело получает mesh3d-сферу."""
        focused = pm.build_plotly_dict(
            self.snapshot, view_mode="3d", selected="TestSys 1", zoom=3)
        meshes = [t for t in focused["data"] if t.get("type") == "mesh3d"]
        self.assertEqual([t.get("meta") for t in meshes], ["sphere"],
                         "у тела без атмосферы дымка не рисуется")
        sphere = meshes[0]
        self.assertEqual(sphere["name"], "TestSys 1")
        # Сетка совпадает с движком сайта: SPHERE_MESH (40×24).
        segments, rings = orrery.sphere_mesh()
        self.assertEqual(len(sphere["x"]), (segments + 1) * (rings + 1))
        # по 2 индекса в каждое из i/j/k на квад → 2·rings·segments
        self.assertEqual(len(sphere["i"]), 2 * rings * segments)
        self.assertEqual(len(sphere["j"]), len(sphere["k"]))
        # Сфера сидит ровно на теле (центр = координата планеты в этой же
        # фигуре), а не в начале координат и не «рядом».
        planets = next(t for t in focused["data"] if t.get("name") == "Планеты")
        body_point = (planets["x"][0], planets["y"][0], planets["z"][0])
        bbox_center = tuple(
            (min(sphere[axis]) + max(sphere[axis])) / 2.0 for axis in ("x", "y", "z")
        )
        for got, want in zip(bbox_center, body_point):
            self.assertAlmostEqual(got, want, places=6)
        radius = max(abs(pz - bbox_center[2]) for pz in sphere["z"])
        self.assertGreater(radius, 0.0)
        window = (focused["layout"]["scene"]["xaxis"]["range"][1]
                  - focused["layout"]["scene"]["xaxis"]["range"][0]) / 2.0
        # Окно шире сферы на FOCUS_PAD (запас, чтобы сфера не липла к краю),
        # радиус при этом = 0.42 от разреза фокуса — как на сайте.
        self.assertAlmostEqual(radius, orrery.focus_window(radius / 0.42) / orrery.FOCUS_PAD * 0.42, places=6)
        self.assertGreater(window, radius, 'сфера не должна упираться в край окна')

    def test_atmosphere_body_gets_haze_layer(self):
        """Тело с атмосферой дополнительно получает полупрозрачную дымку."""
        body = next(b for b in self.snapshot.bodies if b.name == "TestSys 1")
        body.atmosphere = "Nitrogen / Oxygen"
        try:
            focused = pm.build_plotly_dict(
                self.snapshot, view_mode="3d", selected="TestSys 1", zoom=2)
        finally:
            body.atmosphere = ""
        metas = [t.get("meta") for t in focused["data"] if t.get("type") == "mesh3d"]
        self.assertEqual(metas, ["sphere", "sphere_haze"])

    def test_star_focus_has_no_sphere(self):
        focused = pm.build_plotly_dict(
            self.snapshot, view_mode="3d", selected="TestSys A", zoom=3)
        self.assertEqual([t for t in focused["data"] if t.get("type") == "mesh3d"], [])

    def test_overview_has_no_stray_sphere(self):
        schema = pm.build_plotly_dict(self.snapshot, view_mode="3d")
        self.assertEqual([t for t in schema["data"] if t.get("type") == "mesh3d"], [])

    def test_hover_contains_exobio_and_gravity(self):
        schema = pm.build_plotly_dict(self.snapshot)
        planet_trace = next(t for t in schema["data"] if t.get("name") == "Планеты")
        hover = planet_trace["hovertext"][0]
        self.assertIn("TestSys 1", hover)
        self.assertIn("Биосигналы", hover)
        self.assertIn("Stratum", hover)
        self.assertIn("1.00 G", hover)

    def test_hover_contains_site_progress(self):
        schema = pm.build_plotly_dict(self.snapshot)
        site_trace = next(t for t in schema["data"] if t.get("name") == "Стройплощадки")
        hover = site_trace["hovertext"][0]
        self.assertIn("55.0%", hover)
        self.assertIn("2 200", hover)

    def test_player_position_marker(self):
        schema = pm.build_plotly_dict(self.snapshot)
        player_trace = next(t for t in schema["data"] if t.get("name") == "Вы здесь (CMDR)")
        self.assertEqual(player_trace["marker"]["color"], pm.ED_COLOR_PLAYER)
        self.assertIn("CMDR", player_trace["text"][0])

    def test_scale_modes(self):
        orrery_schema = pm.build_plotly_dict(self.snapshot, scale_mode="orrery")
        linear_schema = pm.build_plotly_dict(self.snapshot, scale_mode="linear")
        self.assertIsInstance(orrery_schema["data"], list)
        self.assertIsInstance(linear_schema["data"], list)

    def test_moons_toggle(self):
        with_moons = pm.build_plotly_dict(self.snapshot, show_moons=True)
        without_moons = pm.build_plotly_dict(self.snapshot, show_moons=False)
        has_moons_1 = any(t.get("name") == "Луны" for t in with_moons["data"])
        has_moons_2 = any(t.get("name") == "Луны" for t in without_moons["data"])
        self.assertTrue(has_moons_1)
        self.assertFalse(has_moons_2)

    def test_habitable_zone_estimation_and_trace(self):
        star = self.snapshot.star
        hz = pm.estimate_habitable_zone_ls(star)
        self.assertIsNotNone(hz)
        self.assertGreater(hz[1], hz[0])
        schema = pm.build_plotly_dict(self.snapshot)
        hz_trace = next((t for t in schema["data"] if "Обитаемая зона" in str(t.get("name"))), None)
        self.assertIsNotNone(hz_trace)

    def test_planetary_rings_rendering_and_hover(self):
        self.builder.handle({
            "event": "Scan",
            "StarSystem": "TestSys",
            "BodyName": "RingedWorld",
            "ScanType": "Detailed",
            "PlanetClass": "Class I gas giant",
            "Radius": 5e7,
            "DistanceFromArrivalLS": 800.0,
            "Rings": [{
                "Name": "RingedWorld A Ring",
                "RingClass": "eRingClass_Icy",
                "InnerRad": 6e7,
                "OuterRad": 1.2e8,
            }],
        })
        snap = self.builder.snapshot("TestSys")
        schema = pm.build_plotly_dict(snap)
        ring_trace = next((t for t in schema["data"] if "Кольца планет" in str(t.get("name"))), None)
        self.assertIsNotNone(ring_trace)
        planet_trace = next(t for t in schema["data"] if t.get("name") == "Планеты")
        ringed_hover = next(h for h in planet_trace["hovertext"] if "RingedWorld" in h)
        self.assertIn("Кольца", ringed_hover)
        self.assertIn("Icy", ringed_hover)

    def test_target_lock_and_camera_centering(self):
        """Захват цели = разрез осей вокруг тела; камера при этом смотрит в 0.

        Раньше «центрирование» делали через `camera.center` в unit'ах системы,
        и Plotly увозил вид в пустоту (чёрный экран вместо цели).
        """
        schema = pm.build_plotly_dict(self.snapshot, selected="TestSys 1")
        target_trace = next((t for t in schema["data"] if "Цель: TestSys 1" in str(t.get("name"))), None)
        self.assertIsNotNone(target_trace)
        camera = schema["layout"]["scene"]["camera"]
        self.assertEqual(camera["center"], {"x": 0, "y": 0, "z": 0})
        planets = next(t for t in schema["data"] if t.get("name") == "Планеты")
        for axis, key in (("xaxis", "x"), ("yaxis", "y"), ("zaxis", "z")):
            low, high = schema["layout"]["scene"][axis]["range"]
            self.assertAlmostEqual((low + high) / 2.0, planets[key][0], places=4,
                                   msg=f"{axis} не отцентрован на цели")


class ViewModeNormalisationTests(unittest.TestCase):
    """Нормализатор вида: один источник правды для Tk, фигуры и HTML."""

    def test_aliases(self):
        for raw in ("3d", "3D", "3D Orrery", None, "", "orrery", "перспектива"):
            self.assertEqual(pm.normalize_view_mode(raw), "3d")
        for raw in ("2d", "2D", "2д", "top", "flat", "сверху", "плоский"):
            self.assertEqual(pm.normalize_view_mode(raw), "2d")


class PlotlyMapOutputTests(unittest.TestCase):
    """Тесты вывода HTML, работы с файлами и браузером."""

    def setUp(self):
        self.builder = sm.SystemMapBuilder()
        self.builder.handle({"event": "FSDJump", "StarSystem": "Achenar", "SystemAddress": 12345})
        self.builder.handle({
            "event": "Scan",
            "StarSystem": "Achenar",
            "BodyName": "Achenar",
            "ScanType": "Detailed",
            "StarType": "B",
            "Radius": 2e9,
            "DistanceFromArrivalLS": 0.0,
        })
        self.snapshot = self.builder.snapshot("Achenar")

    def test_build_plotly_figure_when_plotly_available(self):
        if pm.HAS_PLOTLY:
            fig = pm.build_plotly_figure(self.snapshot)
            self.assertIsNotNone(fig)
            self.assertGreater(len(fig.data), 0)

    def test_generate_plotly_html_contains_plotlyjs_and_system(self):
        html = pm.generate_plotly_html(self.snapshot)
        self.assertIn("<!DOCTYPE html>", html)
        self.assertIn("https://cdn.plot.ly/plotly-2.35.2.min.js", html)
        self.assertIn("Plotly.newPlot", html)
        self.assertIn("Achenar", html)

    def test_export_plotly_html_writes_to_disk(self):
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "map.html"
            res = pm.export_plotly_html(self.snapshot, filepath=target)
            self.assertEqual(res, target)
            self.assertTrue(target.exists())
            self.assertGreater(target.stat().st_size, 1000)

    def test_open_plotly_in_browser_calls_webbrowser(self):
        with mock.patch("webbrowser.open") as mock_open:
            path = pm.open_plotly_in_browser(self.snapshot)
            self.assertTrue(path.exists())
            mock_open.assert_called_once_with(path.as_uri())

    def test_generate_plotly_html_offline_mode(self):
        if pm.HAS_PLOTLY:
            html = pm.generate_plotly_html(self.snapshot, include_plotlyjs="inline")
            self.assertIn("<script>", html)
            self.assertGreater(len(html), 100000)

    def test_system_without_star_fallback(self):
        empty_snap = sm.MapSnapshot(system="EmptySys")
        schema = pm.build_plotly_dict(empty_snap)
        self.assertIsInstance(schema["data"], list)
        html = pm.generate_plotly_html(empty_snap)
        self.assertIn("EmptySys", html)


class ColonialHelperPlotlyIntegrationTests(unittest.TestCase):
    """Тесты интеграции методов Plotly в ColonialHelperApp."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(HERE))
        from test_initial_upload_flow import install_gui_stubs
        install_gui_stubs()
        import colonial_helper
        cls.app_cls = colonial_helper.ColonialHelperApp

    def test_app_has_plotly_methods(self):
        self.assertTrue(hasattr(self.app_cls, "_on_map_open_plotly"))
        self.assertTrue(hasattr(self.app_cls, "_on_map_export_plotly"))

    def test_on_map_open_plotly_handles_empty_snapshot(self):
        app = mock.MagicMock(spec=self.app_cls)
        app._map_last_snapshot = None
        app.system_map = mock.MagicMock()
        app.system_map.snapshot.return_value = sm.MapSnapshot(system="")
        self.app_cls._on_map_open_plotly(app)
        app._map_set_hint.assert_called_with("Нет данных о текущей системе для Plotly")

    def test_on_map_open_plotly_invokes_open(self):
        app = mock.MagicMock(spec=self.app_cls)
        snap = sm.MapSnapshot(system="Sol")
        app._map_last_snapshot = snap
        app.map_moons_var = mock.MagicMock()
        app.map_moons_var.get.return_value = True
        app.map_view_mode = mock.MagicMock()
        app.map_view_mode.get.return_value = "3d"

        with mock.patch("plotly_map.open_plotly_in_browser") as mock_open:
            mock_open.return_value = Path("/tmp/test_map.html")
            self.app_cls._on_map_open_plotly(app)
            # zoom/labels передаются: карта открывается с тем же приближением,
            # что выбрано в Tk-вкладке (по умолчанию — общий обзор).
            mock_open.assert_called_once_with(
                snap, view_mode="3d", show_moons=True, selected="", zoom=0, show_all_labels=False)
            app._map_update_status.assert_called_once()
            app.log.assert_called_once()

    def test_tk_2d_toggle_no_longer_flattens_plotly_map(self):
        """Переключатель 2D/3D канваса больше не делает Plotly-карту плоской.

        Раньше он же определял и тип трасс в HTML, из-за чего карта, открытая из
        приложения, «работала только в 2D режиме».
        """
        app = mock.MagicMock(spec=self.app_cls)
        app._map_last_snapshot = sm.MapSnapshot(system="Sol")
        app.map_moons_var = mock.MagicMock()
        app.map_moons_var.get.return_value = True
        app.map_view_mode = mock.MagicMock()
        app.map_view_mode.get.return_value = "2d"
        app.config = {"map_plotly_zoom": 0, "map_plotly_labels": False}
        with mock.patch("plotly_map.open_plotly_in_browser") as mock_open:
            mock_open.return_value = Path("/tmp/test_map.html")
            self.app_cls._on_map_open_plotly(app)
            self.assertEqual(mock_open.call_args.kwargs["view_mode"], "3d")

    def test_map_plotly_view_config_selects_start_camera(self):
        """Ключ `map_plotly_view` — про стартовую камеру, а не про другой рендер."""
        app = mock.MagicMock(spec=self.app_cls)
        app._map_last_snapshot = sm.MapSnapshot(system="Sol")
        app.map_moons_var = mock.MagicMock()
        app.map_moons_var.get.return_value = True
        app.config = {"map_plotly_view": "2d", "map_plotly_zoom": 1}
        with mock.patch("plotly_map.open_plotly_in_browser") as mock_open:
            mock_open.return_value = Path("/tmp/test_map.html")
            self.app_cls._on_map_open_plotly(app)
            self.assertEqual(mock_open.call_args.kwargs["view_mode"], "2d")
            self.assertEqual(mock_open.call_args.kwargs["zoom"], 1)

    def test_export_plotly_html_uses_same_view_source(self):
        app = mock.MagicMock(spec=self.app_cls)
        app._map_last_snapshot = sm.MapSnapshot(system="Sol")
        app.map_moons_var = mock.MagicMock()
        app.map_moons_var.get.return_value = True
        app.map_view_mode = mock.MagicMock()
        app.map_view_mode.get.return_value = "2d"
        app.config = {"map_plotly_zoom": 0, "map_plotly_labels": False}
        with mock.patch("plotly_map.export_plotly_html") as mock_export, \
                mock.patch("colonial_helper.filedialog.asksaveasfilename",
                           return_value="/tmp/sol_map.html"):
            self.app_cls._on_map_export_plotly(app)
            self.assertEqual(mock_export.call_args.kwargs["view_mode"], "3d")

    def test_copy_map_text_and_context_menu_attributes(self):
        self.assertTrue(hasattr(self.app_cls, "_on_map_tree_context"))
        self.assertTrue(hasattr(self.app_cls, "_copy_map_text"))
        app = mock.MagicMock(spec=self.app_cls)
        self.app_cls._copy_map_text(app, "HIP 22460 1", "Скопировано")
        app._map_set_hint.assert_called_with("Скопировано")


if __name__ == "__main__":
    unittest.main()
