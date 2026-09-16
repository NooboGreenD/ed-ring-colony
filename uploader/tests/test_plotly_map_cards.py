"""Тесты «карточек системы» и приближения в HTML-экспорте Plotly.

Проверяют три вещи, ради которых карта переделывалась:

* многозвёздная система раскладывается кластерами, а не «всё вокруг главной»;
* наземные постройки сидят на видимой поверхности тела, а не висят в космосе;
* фокус на цели действительно режет размах осей (приближение), а иконки
  строек/станций мелкие и подписываются только у цели;
* HTML-экспорт несёт правую колонку карточек и JS, пересчитывающий зум.
"""

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
        center = focused["camera"]["center"]
        position = pm.build_system_geometry(self.snapshot)["positions"]["KELT A 1"]
        self.assertAlmostEqual(center["x"], position[0], places=2)
        self.assertAlmostEqual(center["z"], position[2], places=2)

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


if __name__ == "__main__":
    unittest.main()
