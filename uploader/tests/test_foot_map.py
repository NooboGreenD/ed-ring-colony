"""Миникарта пешехода: геометрия поверхности, след, точки интереса, блок HUD.

Проверяем то, что легко сломать незаметно: пересчёт координат в метры,
разворот карты по курсу, порог шага следа, чтение ``Status.json`` по mtime,
имена поселений/портов из журнала и то, что блок не перерисовывается зря.
"""

import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import foot_map  # noqa: E402
from foot_map import FootMap, local_offsets, to_screen  # noqa: E402

RADIUS = 6_371_000.0


def status(**overrides):
    """Минимальный `Status.json` пешехода на поверхности."""
    base = {
        "timestamp": "2026-10-29T10:00:00Z",
        "event": "Status",
        "Flags": 0,
        "Flags2": 1,
        "BodyName": "HIP 1 A 3 a",
        "PlanetRadius": RADIUS,
        "Latitude": -12.3456,
        "Longitude": 45.6789,
        "Altitude": 12.4,
        "Heading": 40.0,
        "Oxygen": 0.82,
        "Health": 1.0,
        "Temperature": 240.5,
        "Gravity": 0.9,
        "SelectedWeapon": "$humanoid_weapon_pistol_name;",
        "SelectedWeapon_Localised": "Karma P-15",
    }
    base.update(overrides)
    return base


class GeometryTests(unittest.TestCase):
    def test_north_offset_is_metres_over_radius(self):
        east, north = local_offsets(0.001, 0.0, 0.0, 0.0, RADIUS)
        self.assertAlmostEqual(east, 0.0, places=6)
        self.assertAlmostEqual(north, math.radians(0.001) * RADIUS, places=3)

    def test_east_offset_shrinks_towards_the_pole(self):
        _east, near_equator = local_offsets(0.0, 0.001, 0.0, 0.0, RADIUS)
        _east, near_pole = local_offsets(80.0, 0.001, 80.0, 0.0, RADIUS)
        self.assertLess(math.hypot(*local_offsets(80.0, 0.001, 80.0, 0.0, RADIUS)),
                        math.hypot(*local_offsets(0.0, 0.001, 0.0, 0.0, RADIUS)))

    def test_distance_and_bearing(self):
        metres = math.radians(0.001) * RADIUS
        self.assertAlmostEqual(foot_map.distance_m(0.001, 0.0, 0.0, 0.0, RADIUS),
                               metres, places=3)
        self.assertAlmostEqual(foot_map.bearing_deg(0.0, 0.001, 0.0, 0.0, RADIUS), 90.0,
                               places=3)
        self.assertAlmostEqual(foot_map.bearing_deg(-0.001, 0.0, 0.0, 0.0, RADIUS), 180.0,
                               places=3)

    def test_heading_zero_puts_north_up(self):
        x, y = to_screen(0.0, 100.0, 0.0, 1.0, 200.0, 200.0)
        self.assertAlmostEqual(x, 200.0)
        self.assertAlmostEqual(y, 100.0)

    def test_map_turns_with_the_heading(self):
        """Курс на восток: север уходит влево, восток — вверх."""
        x, y = to_screen(0.0, 100.0, 90.0, 1.0, 200.0, 200.0)
        self.assertAlmostEqual(x, 100.0)
        self.assertAlmostEqual(y, 200.0)
        x, y = to_screen(100.0, 0.0, 90.0, 1.0, 200.0, 200.0)
        self.assertAlmostEqual(x, 200.0)
        self.assertAlmostEqual(y, 100.0)

    def test_heading_wraps_around(self):
        self.assertEqual(foot_map.normalize_heading(370), 10.0)
        self.assertEqual(foot_map.normalize_heading(-10), 350.0)
        self.assertEqual(foot_map.normalize_heading(None), 0.0)
        self.assertEqual(foot_map.normalize_heading("мусор"), 0.0)

    def test_scale_steps_round_up_to_the_next_step(self):
        self.assertEqual(foot_map.pick_scale(0), 25)
        self.assertEqual(foot_map.pick_scale(25), 25)
        self.assertEqual(foot_map.pick_scale(26), 50)
        self.assertEqual(foot_map.pick_scale(4999), 5000)
        self.assertEqual(foot_map.pick_scale(10 ** 9), foot_map.SCALE_STEPS[-1])

    def test_distance_units(self):
        self.assertEqual(foot_map.split_distance(745), (745, "m"))
        self.assertEqual(foot_map.split_distance(1500), (1.5, "km"))
        self.assertEqual(foot_map.split_distance(None), (0, "m"))

    def test_empty_state_is_not_known(self):
        state = foot_map.empty_state()
        self.assertFalse(state["known"])
        self.assertEqual(state["trail"], [])
        self.assertIsNone(state["ship"])


class FootMapJournalTests(unittest.TestCase):
    """Точки и след: журнал даёт места, `Status.json` — где командир сейчас."""

    def setUp(self):
        self.map = FootMap()

    def place(self, body="HIP 1 A 3 a", lat=0.0, lon=0.0):
        """Встать на поверхность: тело, координаты и показатели скафандра."""
        self.map.update_status(status(BodyName=body, Latitude=lat, Longitude=lon))

    def test_touchdown_gives_the_ship_point(self):
        self.assertTrue(self.map.handle({"event": "Touchdown", "BodyName": "HIP 1 A 3 a",
                                         "Latitude": 1.5, "Longitude": 2.5}))
        self.assertTrue(self.map.update_status(status(Latitude=1.51, Longitude=2.5)))
        data = self.map.state()
        self.assertEqual(data["body"], "HIP 1 A 3 a")
        self.assertIsNotNone(data["ship"])
        self.assertGreater(data["ship"]["distance"], 1000)

    def test_liftoff_forgets_the_ship(self):
        self.place()
        self.map.handle({"event": "Touchdown", "Latitude": 0.0, "Longitude": 0.0})
        self.assertTrue(self.map.handle({"event": "Liftoff"}))
        self.assertIsNone(self.map.state()["ship"])

    def test_settlement_name_comes_from_the_journal(self):
        self.place()
        self.map.handle({"event": "ApproachSettlement", "MarketID": 7,
                         "Name": "$hutton_settlement_name;",
                         "Name_Localised": "Hutton Settlement",
                         "Latitude": 0.01, "Longitude": 0.02})
        kinds = {poi["kind"]: poi["name"] for poi in self.map.state()["pois"]}
        self.assertEqual(kinds.get(foot_map.POI_SETTLEMENT), "Hutton Settlement")

    def test_port_name_comes_from_station_name(self):
        self.place()
        self.map.handle({"event": "Docked", "MarketID": 8,
                         "StationName": "Bessel Landing",
                         "Latitude": 0.02, "Longitude": 0.03})
        names = [poi["name"] for poi in self.map.state()["pois"]]
        self.assertIn("Bessel Landing", names)

    def test_untranslated_name_is_not_shown(self):
        """Строка ``$...;`` без перевода — не имя: подпись остаётся пустой."""
        self.place()
        self.map.handle({"event": "ApproachSettlement", "MarketID": 9,
                         "Name": "$unknown_name;", "Latitude": 0.0, "Longitude": 0.0})
        names = [poi["name"] for poi in self.map.state()["pois"]
                 if poi["kind"] == foot_map.POI_SETTLEMENT]
        self.assertEqual(names, [""])

    def test_body_change_clears_trail_and_points(self):
        """Перелёт на другое тело: старый след и старые базы больше не в кадре."""
        self.place()
        self.map.handle({"event": "Touchdown", "Latitude": 0.0, "Longitude": 0.0})
        self.map.handle({"event": "ApproachSettlement", "MarketID": 3,
                         "Name": "Old Base", "Latitude": 0.02, "Longitude": 0.0})
        self.place(lat=0.01)
        self.assertEqual(len(self.map.trail_points()), 2)
        self.assertIn("Old Base", [poi["name"] for poi in self.map.state()["pois"]])
        self.map.handle({"event": "Location", "BodyName": "HIP 1 A 4 a",
                         "Latitude": 5.0, "Longitude": 5.0})
        self.assertEqual(self.map.trail_points(), [])
        self.assertNotIn("Old Base", [poi["name"] for poi in self.map.state()["pois"]])

    def test_fsd_jump_resets_everything(self):
        self.map.update_status(status())
        self.assertTrue(self.map.handle({"event": "FSDJump"}))
        data = self.map.state()
        self.assertFalse(data["known"])
        self.assertIsNone(data["lat"])

    def test_disembark_and_embark_switch_the_mode(self):
        self.map.update_status(status(Flags2=0, Latitude=0.0, Longitude=0.0))
        self.assertFalse(self.map.state()["on_foot"])
        self.map.handle({"event": "Disembark"})
        self.assertTrue(self.map.state()["on_foot"])
        self.map.handle({"event": "Embark"})
        self.assertFalse(self.map.state()["on_foot"])

    def test_unknown_event_changes_nothing(self):
        self.assertFalse(self.map.handle({"event": "Music", "MusicTrack": "MainMenu"}))
        self.assertFalse(self.map.handle({}))

    def test_garbage_coordinates_are_ignored(self):
        self.assertFalse(self.map.handle({"event": "Touchdown", "Latitude": "x",
                                          "Longitude": None}))
        self.map.update_status(status(Latitude="—", Longitude="—"))
        data = self.map.state()
        self.assertFalse(data["known"])
        self.assertIsNone(data["ship"])


class FootMapStatusTests(unittest.TestCase):
    def setUp(self):
        self.map = FootMap()

    def test_position_and_vitals_are_scaled_for_the_people(self):
        self.map.update_status(status())
        data = self.map.state()
        self.assertTrue(data["known"])
        self.assertEqual(data["body"], "HIP 1 A 3 a")
        self.assertEqual(data["heading"], 40.0)
        self.assertEqual(data["altitude"], 12.4)
        self.assertAlmostEqual(data["oxygen"], 82.0)
        self.assertAlmostEqual(data["health"], 100.0)
        self.assertAlmostEqual(data["temperature"], 240.5)
        self.assertAlmostEqual(data["gravity"], 0.9)
        self.assertEqual(data["weapon"], "Karma P-15")
        self.assertTrue(data["on_foot"])

    def test_on_foot_flag_comes_from_flags2(self):
        self.map.update_status(status(Flags2=0))
        self.assertFalse(self.map.state()["on_foot"])
        self.map.update_status(status(Flags2=0b100000))
        # Бит OnFoot не выставлен — значит, командир в машине или в корабле.
        self.assertFalse(self.map.state()["on_foot"])

    def test_unchanged_status_is_not_reported_as_change(self):
        self.assertTrue(self.map.update_status(status()))
        self.assertFalse(self.map.update_status(status()))

    def test_trail_ignores_tiny_steps(self):
        self.map.update_status(status(Latitude=0.0, Longitude=0.0))
        self.map.update_status(status(Latitude=0.00005, Longitude=0.0))  # ~5.6 м
        self.assertEqual(len(self.map.trail_points()), 1)
        self.map.update_status(status(Latitude=0.0005, Longitude=0.0))   # ~56 м
        points = self.map.trail_points()
        self.assertEqual(len(points), 2)
        self.assertAlmostEqual(points[-1][0], 0.0005)

    def test_trail_stops_at_the_limit(self):
        short = FootMap(trail_step=1.0, trail_limit=5)
        for step in range(20):
            short.update_status(status(Latitude=step * 0.001, Longitude=0.0))
        self.assertEqual(len(short.trail_points()), 5)

    def test_state_trail_is_in_metres_around_the_commander(self):
        self.map.update_status(status(Latitude=0.0, Longitude=0.0))
        self.map.update_status(status(Latitude=0.01, Longitude=0.0))
        trail = self.map.state()["trail"]
        self.assertEqual(trail[-1][0], 0.0)
        self.assertAlmostEqual(trail[-1][1], 0.0, places=3)
        # Точка старта — позади командира на юг.
        self.assertLess(trail[0][1], 0.0)

    def test_poi_list_is_sorted_by_distance(self):
        self.map.update_status(status(Latitude=0.0, Longitude=0.0))
        self.map.handle({"event": "ApproachSettlement", "MarketID": 1, "Name": "Far",
                         "Latitude": 0.5, "Longitude": 0.0})
        self.map.handle({"event": "ApproachSettlement", "MarketID": 2, "Name": "Near",
                         "Latitude": 0.01, "Longitude": 0.0})
        names = [poi["name"] for poi in self.map.state()["pois"]]
        self.assertEqual(names, ["Near", "Far"])

    def test_poi_limit_drops_the_farthest(self):
        map_with_points = FootMap()
        map_with_points.update_status(status(Latitude=0.0, Longitude=0.0))
        for index in range(foot_map.POI_LIMIT + 6):
            map_with_points.handle({"event": "ApproachSettlement", "MarketID": index,
                                    "Name": f"P{index}",
                                    "Latitude": index * 0.01, "Longitude": 0.0})
        names = {poi["name"] for poi in map_with_points.state()["pois"]}
        self.assertLessEqual(len(names), foot_map.POI_LIMIT)
        # Новое поселение не выбрасывается, место освобождает дальняя старая
        # точка, а ближние к командиру остаются.
        self.assertIn(f"P{foot_map.POI_LIMIT + 5}", names)
        self.assertIn("P0", names)
        self.assertNotIn("P28", names)

    def test_scale_follows_the_farthest_visible_point(self):
        self.map.update_status(status(Latitude=0.0, Longitude=0.0))
        self.map.handle({"event": "Touchdown", "Latitude": 0.02, "Longitude": 0.0})
        # ~2.2 км до корабля: ближайшая ступень с запасом — 2500 м.
        self.assertEqual(self.map.state()["scale"], 2500)

    def test_far_point_does_not_blow_up_the_scale(self):
        self.map.update_status(status(Latitude=0.0, Longitude=0.0))
        self.map.handle({"event": "ApproachSettlement", "MarketID": 1, "Name": "Far",
                         "Latitude": 30.0, "Longitude": 0.0})
        state = self.map.state()
        self.assertLessEqual(state["scale"], foot_map.POI_MAX_DRAW_M)
        self.assertTrue(any(poi["distance"] > foot_map.POI_MAX_DRAW_M
                            for poi in state["pois"]))


class FootMapPollTests(unittest.TestCase):
    """`poll` читает Status.json только когда файл изменился."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.folder.cleanup)
        self.dir = Path(self.folder.name)

    def write_status(self, payload, mtime=None):
        path = self.dir / "Status.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def test_missing_file_is_not_an_error(self):
        self.assertFalse(FootMap().poll(self.dir))
        self.assertFalse(FootMap().poll(None))

    def test_file_is_read_once_per_change(self):
        self.write_status(status(), mtime=1_000_000)
        map_ = FootMap()
        self.assertTrue(map_.poll(self.dir))
        self.assertEqual(map_.state()["body"], "HIP 1 A 3 a")
        self.assertFalse(map_.poll(self.dir))
        self.write_status(status(Latitude=1.0), mtime=1_000_001)
        self.assertTrue(map_.poll(self.dir))
        self.assertAlmostEqual(map_.state()["lat"], 1.0)

    def test_broken_json_keeps_the_previous_state(self):
        self.write_status(status(), mtime=1_000_000)
        map_ = FootMap()
        map_.poll(self.dir)
        (self.dir / "Status.json").write_text("{не json", encoding="utf-8")
        os.utime(self.dir / "Status.json", (1_000_002, 1_000_002))
        self.assertFalse(map_.poll(self.dir))
        self.assertTrue(map_.state()["known"])


if __name__ == "__main__":
    unittest.main()
