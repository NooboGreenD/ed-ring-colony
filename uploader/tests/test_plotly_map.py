"""Тесты интерактивной карты Plotly (plotly_map.py и интеграции в Colonial Helper)."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

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

    def test_view_mode_2d_uses_scatter_without_z(self):
        schema = pm.build_plotly_dict(self.snapshot, view_mode="2d")
        for trace in schema["data"]:
            self.assertEqual(trace["type"], "scatter")
            self.assertNotIn("z", trace)
        self.assertNotIn("scene", schema["layout"])
        self.assertIn("xaxis", schema["layout"])
        self.assertIn("yaxis", schema["layout"])
        self.assertEqual(schema["layout"]["yaxis"]["scaleanchor"], "x")

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
            mock_open.assert_called_once_with(snap, view_mode="3d", show_moons=True)
            app._map_update_status.assert_called_once()
            app.log.assert_called_once()


if __name__ == "__main__":
    unittest.main()
