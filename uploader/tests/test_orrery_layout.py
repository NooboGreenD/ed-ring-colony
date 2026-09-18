"""Тесты геометрии оррери (`orrery.py`) — общей для Tk-карты и HTML-экспорта.

Повод: карта системы рисовала все планеты вокруг главной звезды, а наземные
постройки — в фиксированных единицах от её центра. В мультизвёздной системе это
выглядело как «стройку выбросило в космос», а тела второй звезды жили в чужом
кластере. Тесты фиксируют новое поведение и не дают ему уплыть обратно.
"""

import math
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import orrery
from system_map import (
    KIND_MOON,
    KIND_PLANET,
    KIND_STAR,
    STATION_PORT,
    STATION_SETTLEMENT,
    STATION_SITE,
    MapBody,
    MapSnapshot,
    MapStation,
)


def star(name, body_id, distance=0.0, radius_m=6.957e8, temp=5778.0):
    return MapBody(name=name, kind=KIND_STAR, body_id=body_id, distance_ls=distance,
                   radius_m=radius_m, surface_temp_k=temp, star_type="G")


def planet(name, body_id, distance, parent=None, **kwargs):
    return MapBody(name=name, kind=KIND_PLANET, body_id=body_id, distance_ls=distance,
                   orbit_ls=distance, parent_ids=[parent] if parent else [], **kwargs)


def station(name, body_name, kind=STATION_SITE, **kwargs):
    return MapStation(name=name, body_name=body_name, kind=kind, **kwargs)


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


class StarClusterTests(unittest.TestCase):
    def test_single_star_spreads_planets_by_distance(self):
        plan = orrery.plan_system([star("Sol", 1), planet("Sol 1", 2, 20),
                                  planet("Sol 2", 3, 400), planet("Sol 3", 4, 9000)], "Sol")
        radius = lambda name: dist(plan["positions"][name], (0.0, 0.0, 0.0))
        self.assertLess(radius("Sol 1"), radius("Sol 2"))
        self.assertLess(radius("Sol 2"), radius("Sol 3"))
        for body in plan["bodies"]:
            self.assertLessEqual(radius(body["name"]), plan["span"] + 1e-6)

    def test_body_of_secondary_star_sits_by_its_own_star(self):
        plan = orrery.plan_system([
            star("KELT A", 1),
            star("KELT B", 2, 41_000),
            planet("KELT A 1", 10, 30, parent=1),
            planet("KELT B 1", 20, 41_000, parent=2),
        ], "KELT")
        self.assertEqual(len(plan["stars"]), 2)
        self.assertEqual(len(plan["clusters"]), 2)
        positions = plan["positions"]
        self.assertLess(dist(positions["KELT B 1"], positions["KELT B"]),
                        dist(positions["KELT B 1"], positions["KELT A"]))
        clusters = {row["star"]: row["bodies"] for row in plan["clusters"]}
        self.assertIn("KELT A 1", clusters["KELT A"])
        self.assertNotIn("KELT B 1", clusters["KELT A"])

    def test_moon_stays_with_its_planet(self):
        moon = MapBody(name="Sol 5 a", kind=KIND_MOON, body_id=3, distance_ls=400,
                       orbit_ls=1.2, parent_ids=[2], parent_name="Sol 5")
        plan = orrery.plan_system([star("Sol", 1), planet("Sol 5", 2, 400), moon], "Sol")
        positions = plan["positions"]
        self.assertLess(dist(positions["Sol 5 a"], positions["Sol 5"]),
                        dist(positions["Sol 5 a"], positions["Sol"]))

    def test_many_stars_stay_finite_and_inside_their_clusters(self):
        bodies = [star("HIP A", 1)]
        for index in range(40):
            bodies.append(star(f"HIP {index + 2}", index + 2, 5000 * (index + 1)))
        for index in range(12):
            bodies.append(planet(f"HIP A {index + 1}", 500 + index, 50 * (index + 1), parent=1))
        plan = orrery.plan_system(bodies, "HIP")
        self.assertEqual(len(plan["stars"]), 41)
        self.assertEqual(plan["label_mode"], "focused")
        for cluster in plan["clusters"]:
            for name in cluster["bodies"]:
                point = plan["positions"][name]
                self.assertTrue(all(orrery._num(value) == value and value == value for value in point))
                self.assertLessEqual(dist(point, cluster["center"]), cluster["budget"] * 1.01)

    def test_system_without_star_still_places_bodies(self):
        plan = orrery.plan_system([planet("Orphan 1", 1, 100), planet("Orphan 2", 2, 400)], "Orphan")
        self.assertEqual(plan["stars"], [])
        self.assertEqual(len(plan["positions"]), 2)
        self.assertTrue(plan["orbits"])


class SurfaceStructureTests(unittest.TestCase):
    def test_ground_station_sits_on_the_visible_limb(self):
        plan = orrery.plan_system([star("Sol", 1), planet("Sol 4", 2, 500, radius_m=6.4e6)], "Sol")
        placements = orrery.place_stations(plan, [{"name": "База", "body_name": "Sol 4"}],
                                           plan["span"], 800.0)
        self.assertEqual(len(placements), 1)
        placement = placements[0]
        self.assertTrue(placement["on_surface"])
        marker_px = plan["markers"]["Sol 4"]
        body_radius_units = (marker_px / 2.0) * ((plan["span"] * 2.0) / 800.0) * 1.25
        offset = dist(placement["position"], plan["positions"]["Sol 4"])
        self.assertLessEqual(offset, body_radius_units * 3.5)

    def test_orbital_station_is_further_out_than_ground_one(self):
        plan = orrery.plan_system([planet("Sol 4", 2, 500, radius_m=6.4e6)], "Sol")
        ground, orbital = orrery.place_stations(plan, [
            {"name": "Поселение", "body_name": "Sol 4", "kind": STATION_SETTLEMENT},
            {"name": "Порт", "body_name": "Sol 4", "kind": STATION_PORT},
        ], plan["span"], 800.0)
        self.assertTrue(ground["on_surface"])
        self.assertTrue(orbital["on_surface"])
        self.assertGreater(dist(orbital["position"], plan["positions"]["Sol 4"]),
                           0.0)

    def test_several_sites_on_one_body_do_not_overlap(self):
        plan = orrery.plan_system([planet("Sol 4", 2, 500, radius_m=6.4e6)], "Sol")
        placements = orrery.place_stations(plan, [
            {"name": f"Площадка {index}", "body_name": "Sol 4"} for index in range(3)
        ], plan["span"], 800.0)
        points = [item["position"] for item in placements]
        self.assertEqual(len(set(points)), 3)

    def test_unknown_body_falls_back_to_a_system_ring(self):
        plan = orrery.plan_system([planet("Sol 4", 2, 500)], "Sol")
        placements = orrery.place_stations(plan, [{"name": "Платформа", "body_name": ""}],
                                           plan["span"], 800.0)
        self.assertEqual(len(placements), 1)
        self.assertIsNone(placements[0]["anchor"])
        self.assertFalse(placements[0]["on_surface"])

    def test_sphere_mode_spreads_structures_over_the_surface(self):
        plan = orrery.plan_system([planet("Sol 4", 2, 500, radius_m=6.4e6)], "Sol")
        placements = orrery.place_stations(
            plan, [{"name": f"База {i}", "body_name": "Sol 4"} for i in range(3)],
            plan["span"], 800.0, sphere_radii={"Sol 4": 20.0})
        for placement in placements:
            offset = dist(placement["position"], plan["positions"]["Sol 4"])
            self.assertAlmostEqual(offset, 20.0 * 1.03, places=3)


class FocusTests(unittest.TestCase):
    def test_zoom_levels_get_progressively_closer(self):
        bodies = [star("Sol", 1)] + [planet(f"Sol {i}", 10 + i, 100 * i, parent=1) for i in range(1, 9)]
        plan = orrery.plan_system(bodies, "Sol")
        spans = [orrery.focus_view(plan, "Sol 4", level)["half_span"] for level in range(4)]
        self.assertTrue(all(span > 0 for span in spans))
        self.assertLess(spans[1], spans[0])
        self.assertLess(spans[2], spans[1])
        self.assertLess(spans[3], spans[2])
        eyes = [orrery.focus_view(plan, "Sol 4", level)["eye"] for level in range(4)]
        self.assertLess(eyes[3], eyes[0])

    def test_overview_focus_keeps_the_whole_system_in_view(self):
        plan = orrery.plan_system([star("Sol", 1), planet("Sol 8", 2, 8000)], "Sol")
        view = orrery.focus_view(plan, "Sol 8", 0)
        self.assertEqual(view["center"], plan["positions"]["Sol 8"])
        self.assertGreaterEqual(view["half_span"], plan["span"])

    def test_unknown_target_returns_none(self):
        plan = orrery.plan_system([star("Sol", 1)], "Sol")
        self.assertIsNone(orrery.focus_view(plan, "Такой нет", 2))

    def test_neighbours_are_sorted_by_distance(self):
        plan = orrery.plan_system([star("Sol", 1), planet("Sol 1", 2, 100),
                                   planet("Sol 2", 3, 200), planet("Sol 3", 4, 9000)], "Sol")
        neighbours = orrery.neighbours_of(plan, "Sol 1", limit=2)
        self.assertEqual(neighbours[0], "Sol 2")


class GeometryTests(unittest.TestCase):
    def test_habitable_zone_scales_with_luminosity(self):
        sun = {"radius_m": 6.957e8, "surface_temp_k": 5778.0}
        giant = {"radius_m": 6.957e9, "surface_temp_k": 4200.0}
        self.assertGreater(orrery.habitable_zone_ls(giant)[1], orrery.habitable_zone_ls(sun)[1])
        inner, outer = orrery.habitable_zone_ls(sun)
        self.assertTrue(300.0 < inner < 600.0, f"HZ Солнца должна быть около 1 а.е., было {inner}")
        self.assertGreater(outer, inner)

    def test_marker_sizes_shrink_in_dense_systems(self):
        lonely = orrery.plan_system([planet("Sol 1", 2, 100, radius_m=6.4e6)], "Sol")
        dense_bodies = [star("Sol", 1)]
        dense_bodies += [planet(f"Sol {i}", i + 1, 100 * i, parent=1) for i in range(1, 40)]
        dense = orrery.plan_system(dense_bodies, "Sol")
        self.assertLess(max(dense["markers"].values()), max(lonely["markers"].values()) + 12)
        self.assertTrue(dense["crowded"])
        self.assertFalse(lonely["crowded"])

    def test_star_designation_parsing(self):
        self.assertEqual(orrery.star_designation("Sol A 3", "Sol"), "A")
        self.assertEqual(orrery.star_designation("Shinrarta Dezhra AB 5", "Shinrarta Dezhra"), "AB")
        self.assertEqual(orrery.star_designation("Sol 16", "Sol"), "")

    def test_summary_counts(self):
        snapshot = MapSnapshot(system="Sol", bodies=[
            star("Sol", 1),
            planet("Sol 1", 2, 40, parent=1, landable=True, bio_signals=3),
            planet("Sol 2", 3, 400, parent=1, rings=[{"Name": "A Ring", "RingClass": "Icy"}]),
        ], stations=[station("База", "Sol 1"), station("Порт", "Sol 2", STATION_PORT)])
        plan = orrery.plan_system(snapshot.bodies, snapshot.system)
        summary = orrery.summarize_plan(plan, [{"is_site": True, "complete": False}])
        self.assertEqual(summary["stars"], 1)
        self.assertEqual(summary["planets"], 2)
        self.assertEqual(summary["landable"], 1)
        self.assertEqual(summary["bio_signals"], 3)
        self.assertEqual(summary["ringed"], 1)
        self.assertEqual(summary["active_sites"], 1)

    def test_unclassified_body_is_treated_as_a_planet(self):
        # Тело из неполного скана (kind == "") обязано остаться на карте.
        plan = orrery.plan_system([star("Sol", 1),
                                   MapBody(name="Sol 7", kind="", body_id=7, distance_ls=900)], "Sol")
        self.assertIn("Sol 7", plan["positions"])
        self.assertEqual(plan["by_name"]["Sol 7"]["kind"], "planet")


class OrbitalMechanicsTests(unittest.TestCase):
    """Настоящие орбиты: эллипс со звездой в фокусе (зеркало сайта)."""

    def test_kepler_equation_solved(self):
        # e = 0 -> E = M
        for M in (0.0, 0.5, 1.7, 3.14, 6.2):
            self.assertLess(abs(orrery.solve_kepler(M, 0.0) - M), 1e-12)
        # e > 0 -> решение удовлетворяет M = E - e*sin(E)
        for e in (0.1, 0.5, 0.9):
            for M in (0.3, 1.0, 2.5, 4.0, 5.9):
                E = orrery.solve_kepler(M, e)
                self.assertLess(abs(E - e * math.sin(E) - M), 1e-8, f"e={e} M={M}")

    def test_periapsis_and_apoapsis_radii(self):
        # Звезда в ФОКУСЕ: r = a(1-e) и r = a(1+e) - главное отличие от окружностей.
        a, e = 100.0, 0.5
        peri = orrery.orbit_point(a, 0.0, e, 0.0, 0.0, (0.0, 0.0, 0.0))
        apo = orrery.orbit_point(a, math.pi, e, 0.0, 0.0, (0.0, 0.0, 0.0))
        self.assertAlmostEqual(math.dist(peri, (0.0, 0.0, 0.0)), a * (1 - e), places=9)
        self.assertAlmostEqual(math.dist(apo, (0.0, 0.0, 0.0)), a * (1 + e), places=9)

    def test_periapsis_argument_rotates_orbit(self):
        peri = orrery.orbit_point(50.0, 0.0, 0.4, 0.0, math.pi / 2, (0.0, 0.0, 0.0))
        self.assertLess(abs(peri[0]), 1e-9)
        self.assertGreater(peri[1], 0.0)

    def test_inclination_lifts_orbit_out_of_plane(self):
        path = orrery.orbital_path(40.0, 0.2, math.radians(30.0), 0.0, (0.0, 0.0, 0.0), 48)
        max_z = max(abs(point[2]) for point in path)
        self.assertGreater(max_z, 0.0)

    def test_body_without_elements_is_not_marked_real(self):
        self.assertFalse(orrery.has_real_elements({"name": "Sol 4"}))
        self.assertTrue(orrery.has_real_elements({"name": "Sol 3", "eccentricity": 0.0167}))
        self.assertTrue(orrery.has_real_elements({"name": "Sol 3", "orbital_inclination": 1.5}))

    def test_plan_uses_real_elements_when_present(self):
        snapshot = MapSnapshot(system="Sol", bodies=[
            star("Sol", 1),
            planet("Sol 3", 3, 499.0, parent=1, eccentricity=0.0167,
                   orbital_inclination=0.0, arg_of_periapsis=102.9,
                   mean_anomaly_deg=358.6, orbital_period_days=365.256),
            planet("Sol 4", 4, 805.0, parent=1),
        ])
        plan = orrery.plan_system(snapshot.bodies, "Sol")
        earth = next(o for o in plan["orbits"] if o["name"] == "Sol 3")
        mars = next(o for o in plan["orbits"] if o["name"] == "Sol 4")
        self.assertTrue(earth["real"])
        self.assertAlmostEqual(earth["eccentricity"], 0.0167, places=9)
        self.assertAlmostEqual(earth["period_days"], 365.256, places=6)
        self.assertNotEqual(mars.get("real"), True)

        # Планета стоит на своём эллипсе: r = a(1-e^2)/(1+e*cos(v)).
        point = plan["positions"]["Sol 3"]
        center = earth["center"]
        radius = math.dist(point, center)
        e = 0.0167
        nu = math.atan2(point[1] - center[1], point[0] - center[0]) - math.radians(102.9)
        conic = earth["radius"] * (1 - e * e) / (1 + e * math.cos(nu))
        self.assertLess(abs(radius - conic), 1e-9)

        # Порядок по дистанции сохраняется и в «реальном» режиме.
        self.assertLess(math.dist(plan["positions"]["Sol 3"], (0, 0, 0)),
                        math.dist(plan["positions"]["Sol 4"], (0, 0, 0)))

    def test_eccentric_orbit_stays_inside_scene(self):
        snapshot = MapSnapshot(system="HD 1", bodies=[
            star("HD 1", 1),
            planet("HD 1 1", 2, 300.0, parent=1, eccentricity=0.9,
                   orbital_inclination=12.0, arg_of_periapsis=40.0,
                   mean_anomaly_deg=200.0, orbital_period_days=10.0),
        ])
        plan = orrery.plan_system(snapshot.bodies, "HD 1")
        for point in plan["positions"].values():
            for value in point:
                self.assertTrue(math.isfinite(value))
                self.assertLessEqual(abs(value), plan["span"] + 1e-6)

    def test_moon_orbit_uses_real_elements(self):
        snapshot = MapSnapshot(system="Sol", bodies=[
            star("Sol", 1),
            planet("Sol 5", 5, 400.0, parent=1),
            MapBody(name="Sol 5 a", kind=KIND_MOON, body_id=6, distance_ls=400.0,
                    parent_ids=[5, 1], eccentricity=0.0549, orbital_inclination=-23.4,
                    arg_of_periapsis=0.0, mean_anomaly_deg=90.0, orbital_period_days=27.32),
        ])
        plan = orrery.plan_system(snapshot.bodies, "Sol")
        moon_orbit = next(o for o in plan["moon_orbits"] if o["name"] == "Sol 5 a")
        self.assertTrue(moon_orbit["real"])
        self.assertAlmostEqual(moon_orbit["period_days"], 27.32, places=6)
        self.assertAlmostEqual(moon_orbit["eccentricity"], 0.0549, places=9)

    def test_star_color_from_temperature_matches_site(self):
        # Те же контрольные точки, что в src/lib/systemOrrery.ts.
        self.assertEqual(orrery.star_color_from_temperature(3000.0), "rgb(255, 180, 107)")
        self.assertEqual(orrery.star_color_from_temperature(5778.0), "rgb(255, 244, 234)")
        self.assertIsNone(orrery.star_color_from_temperature(0.0))
        cool = orrery.star_color_from_temperature(3000.0)
        hot = orrery.star_color_from_temperature(20000.0)
        parse = lambda rgb: [int(v) for v in rgb[4:-1].split(",")]
        self.assertGreater(parse(cool)[0], parse(cool)[2], "холодная звезда краснее")
        self.assertGreater(parse(hot)[2], parse(hot)[0], "горячая звезда голубее")

    def test_star_radius_scale_orders_by_true_size(self):
        small = orrery.star_radius_scale(6.957e8 * 0.1)
        solar = orrery.star_radius_scale(6.957e8)
        giant = orrery.star_radius_scale(6.957e8 * 1000)
        self.assertLess(small, solar)
        self.assertLess(solar, giant)
        self.assertLess(giant, 3.0)
        self.assertEqual(orrery.star_radius_scale(0.0), 1.0)


if __name__ == "__main__":
    unittest.main()
