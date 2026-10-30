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


class FootMapSampleTests(unittest.TestCase):
    """Образцы биосигналов: где снят и докуда нельзя ставить следующий."""

    def setUp(self):
        self.map = FootMap()
        self.map.update_status(status(Latitude=0.0, Longitude=0.0))

    def sample(self, species="Bacterium Cerbrus", genus="Bacterium",
               scan_type="Sample") -> bool:
        return self.map.handle({
            "event": "ScanOrganic", "ScanType": scan_type,
            "Genus": f"$Codex_Ent_{genus}_Genus_Name;", "Genus_Localised": genus,
            "Species": "$Codex_Ent_Bacterial_01_Name;", "Species_Localised": species,
            "Body": 3,
        })

    def walk_to(self, meters: float) -> None:
        """Отойти на север на `meters` метров: 1° широты ≈ 111,2 км."""
        self.map.update_status(status(Latitude=meters / (math.pi / 180.0) / RADIUS,
                                      Longitude=0.0))

    # -- радиус колонии ----------------------------------------------------
    def test_clonal_range_comes_from_the_codex_table(self):
        self.assertEqual(foot_map.clonal_range("Bacterium"), 500)
        self.assertEqual(foot_map.clonal_range("Osseus"), 800)
        self.assertEqual(foot_map.clonal_range("Tussock"), 200)
        self.assertEqual(foot_map.clonal_range("Electricae"), 1000)
        self.assertEqual(foot_map.clonal_range("Amphora Plant"), 100)
        # Вид начинается с рода, а часть родов игра пишет во множественном числе.
        self.assertEqual(foot_map.clonal_range("Bacterium Cerbrus"), 500)
        self.assertEqual(foot_map.clonal_range("Conchas"), 150)
        self.assertEqual(foot_map.clonal_range("Brain Trees"), 100)

    def test_unknown_genus_falls_back_to_the_common_value(self):
        self.assertEqual(foot_map.clonal_range("$unknown;"),
                         foot_map.DEFAULT_CLONAL_RANGE_M)
        self.assertEqual(foot_map.clonal_range(None, ""), foot_map.DEFAULT_CLONAL_RANGE_M)

    # -- точки образцов ----------------------------------------------------
    def test_only_the_sample_event_places_a_point(self):
        """`Log` — знакомство с видом, `Analyse` — итог: точка одна, на `Sample`."""
        self.assertFalse(self.sample(scan_type="Log"))
        self.assertEqual(self.map.sample_points(), [])
        self.assertTrue(self.sample(scan_type="Sample"))
        self.assertFalse(self.sample(scan_type="Analyse"))
        self.assertEqual(len(self.map.sample_points()), 1)

    def test_sample_keeps_genus_species_and_radius(self):
        self.sample()
        point = self.map.sample_points()[0]
        self.assertEqual(point["species"], "Bacterium Cerbrus")
        self.assertEqual(point["genus"], "Bacterium")
        self.assertEqual(point["radius"], 500)
        summary = self.map.state()["sample"]
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["total"], foot_map.SAMPLES_PER_SPECIES)
        self.assertFalse(summary["complete"])

    def test_next_sample_needs_to_leave_the_colony_radius(self):
        self.sample()
        summary = self.map.state()["sample"]
        self.assertFalse(summary["allowed"])
        self.assertAlmostEqual(summary["need_m"], 500.0, delta=1.0)

        self.walk_to(200.0)
        summary = self.map.state()["sample"]
        self.assertFalse(summary["allowed"])
        self.assertAlmostEqual(summary["need_m"], 300.0, delta=1.0)

        self.walk_to(600.0)
        summary = self.map.state()["sample"]
        self.assertTrue(summary["allowed"])
        self.assertEqual(summary["need_m"], 0.0)

    def test_same_bush_is_not_recorded_twice(self):
        self.sample()
        self.walk_to(2.0)                      # на два метра — тот же куст
        self.assertFalse(self.sample())
        self.assertEqual(len(self.map.sample_points()), 1)

    def test_three_samples_complete_the_set_and_the_next_starts_a_new_one(self):
        self.sample()
        for step in (1, 2):
            self.walk_to(600.0 * step)
            self.assertTrue(self.sample())
        summary = self.map.state()["sample"]
        self.assertTrue(summary["complete"])
        self.assertEqual(summary["count"], 3)

        # Комплект собран: игра снимает канистру, четвёртый образец — новый набор.
        self.walk_to(2000.0)
        self.assertTrue(self.sample())
        summary = self.map.state()["sample"]
        self.assertEqual(summary["count"], 1)
        self.assertFalse(summary["complete"])

    def test_another_species_discards_the_unfinished_set(self):
        """Генетический самплер держит один вид: смена вида стирает образцы."""
        self.sample()
        self.walk_to(600.0)
        self.assertTrue(self.sample(species="Osseus Spiralis", genus="Osseus"))
        points = self.map.sample_points()
        self.assertEqual([row["species"] for row in points], ["Osseus Spiralis"])
        self.assertEqual(points[0]["radius"], 800)

    def test_sample_waits_for_the_first_status(self):
        """Скан пришёл раньше `Status.json`: точка встанет, когда будет координата."""
        map_ = FootMap()
        self.assertFalse(map_.handle({"event": "ScanOrganic", "ScanType": "Sample",
                                      "Species_Localised": "Tussock Cultro"}))
        self.assertEqual(map_.sample_points(), [])
        map_.update_status(status(Latitude=1.0, Longitude=2.0))
        points = map_.sample_points()
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0]["species"], "Tussock Cultro")
        self.assertEqual(points[0]["radius"], 200)

    def test_samples_are_forgotten_on_another_body_and_on_a_jump(self):
        self.sample()
        self.map.handle({"event": "Location", "BodyName": "HIP 1 A 4 a",
                         "Latitude": 5.0, "Longitude": 5.0})
        self.assertEqual(self.map.sample_points(), [])
        self.assertIsNone(self.map.state()["sample"])

        self.sample()
        self.map.handle({"event": "FSDJump"})
        self.assertEqual(self.map.sample_points(), [])

    def test_sample_circle_widens_the_scale(self):
        """Круг образца должен помещаться в диск: иначе радиуса не видно."""
        self.sample()                          # Bacterium: круг 500 м
        self.assertEqual(self.map.state()["scale"], 1000)
        far = FootMap()
        far.update_status(status(Latitude=0.0, Longitude=0.0))
        far.handle({"event": "ScanOrganic", "ScanType": "Sample",
                    "Genus_Localised": "Electricae", "Species_Localised": "Electricae Pluma"})
        self.assertEqual(far.state()["scale"], 2500)   # круг 1000 м

    def test_completed_set_no_longer_widens_the_scale(self):
        """Комплект собран — карта не держится на старых кругах."""
        for step in range(3):
            self.walk_to(6.0 * step)
            self.assertTrue(self.sample())
        self.assertTrue(self.map.state()["sample"]["complete"])
        # Круги рядом, но масштаб теперь задаёт след, а не они.
        self.assertEqual(self.map.state()["scale"], 100)


class FootMapVehicleTests(unittest.TestCase):
    """Корабль и ровер: к ним возвращаются, поэтому их точки не вытесняются."""

    def setUp(self):
        self.map = FootMap()
        self.map.update_status(status(Latitude=0.0, Longitude=0.0))

    def test_srv_point_appears_when_leaving_the_rover(self):
        self.assertTrue(self.map.handle({"event": "Disembark", "SRV": True,
                                         "Latitude": 0.002, "Longitude": 0.0}))
        srv = self.map.state()["srv"]
        self.assertEqual(srv["kind"], foot_map.POI_SRV)
        self.assertGreater(srv["distance"], 100)

    def test_getting_into_the_rover_clears_its_point(self):
        self.map.handle({"event": "Disembark", "SRV": True,
                         "Latitude": 0.002, "Longitude": 0.0})
        self.assertTrue(self.map.handle({"event": "Embark", "SRV": True}))
        self.assertIsNone(self.map.state()["srv"])

    def test_docking_the_rover_in_the_ship_clears_the_point(self):
        self.map.handle({"event": "Disembark", "SRV": True,
                         "Latitude": 0.002, "Longitude": 0.0})
        self.assertTrue(self.map.handle({"event": "DockSRV"}))
        self.assertIsNone(self.map.state()["srv"])

    def test_leaving_the_ship_marks_it_even_without_touchdown(self):
        self.assertTrue(self.map.handle({"event": "Disembark", "SRV": False,
                                         "Latitude": 0.003, "Longitude": 0.0}))
        ship = self.map.state()["ship"]
        self.assertIsNotNone(ship)
        self.assertEqual(ship["kind"], foot_map.POI_SHIP)

    def test_ship_and_rover_survive_a_crowd_of_settlements(self):
        self.map.handle({"event": "Touchdown", "Latitude": 0.02, "Longitude": 0.0})
        self.map.handle({"event": "Disembark", "SRV": True,
                         "Latitude": 0.001, "Longitude": 0.0})
        for index in range(foot_map.POI_LIMIT + 8):
            self.map.handle({"event": "ApproachSettlement", "MarketID": 100 + index,
                             "Name": f"P{index}", "Latitude": 0.01 + index * 0.01,
                             "Longitude": 0.0})
        state = self.map.state()
        self.assertIsNotNone(state["ship"], "корабль вытеснили поселения")
        self.assertIsNotNone(state["srv"], "ровер вытеснили поселения")
        self.assertLessEqual(len(state["pois"]), foot_map.POI_LIMIT)

    def test_reset_forgets_the_rover(self):
        self.map.handle({"event": "Disembark", "SRV": True,
                         "Latitude": 0.002, "Longitude": 0.0})
        self.map.handle({"event": "Died"})
        self.assertIsNone(self.map.state()["srv"])


class FootMapPlaceTests(unittest.TestCase):
    """Вид точки и «где я»: поселение от порта отличает `StationType`."""

    def setUp(self):
        self.map = FootMap()
        self.map.update_status(status(Latitude=0.0, Longitude=0.0))

    def poi(self, kind):
        return next((row for row in self.map.state()["pois"] if row["kind"] == kind), None)

    def test_settlement_type_beats_the_station_name(self):
        """`OnFootSettlement` с именем в StationName — поселение, а не порт."""
        self.map.handle({"event": "Location", "StationName": "Bhabha Terminal",
                         "StationType": "OnFootSettlement",
                         "Latitude": 0.01, "Longitude": 0.02})
        self.assertEqual(self.poi(foot_map.POI_SETTLEMENT)["name"], "Bhabha Terminal")
        self.assertIsNone(self.poi(foot_map.POI_STATION))

    def test_planetary_port_keeps_the_port_kind(self):
        self.map.handle({"event": "Docked", "StationName": "Vasco Terminal",
                         "StationType": "CraterPort",
                         "Latitude": 0.01, "Longitude": 0.02})
        self.assertEqual(self.poi(foot_map.POI_STATION)["name"], "Vasco Terminal")
        self.assertIsNone(self.poi(foot_map.POI_SETTLEMENT))

    def test_approach_settlement_has_no_station_type_but_is_a_settlement(self):
        self.map.handle({"event": "ApproachSettlement", "MarketID": 5,
                         "Name": "Hutton Settlement",
                         "Latitude": 0.01, "Longitude": 0.02})
        self.assertEqual(self.poi(foot_map.POI_SETTLEMENT)["name"], "Hutton Settlement")

    def test_landing_pad_comes_from_docked(self):
        self.map.handle({"event": "Docked", "StationName": "Vasco Terminal",
                         "StationType": "CraterPort", "LandingPad": 7,
                         "Latitude": 0.01, "Longitude": 0.02})
        self.assertEqual(self.poi(foot_map.POI_STATION)["pad"], 7)

    def test_pad_zero_is_not_a_pad(self):
        """``LandingPad: 0`` в журнале значит «без площадки», а не «площадка 0»."""
        self.map.handle({"event": "Docked", "StationName": "Vasco Terminal",
                         "LandingPad": 0, "Latitude": 0.01, "Longitude": 0.02})
        self.assertIsNone(self.poi(foot_map.POI_STATION)["pad"])

    def test_place_is_reported_while_standing_inside(self):
        """Точка поселения под стрелкой: по одной карте не видно, что это оно."""
        self.map.handle({"event": "ApproachSettlement", "MarketID": 5,
                         "Name": "Hutton Settlement",
                         "Latitude": 0.0, "Longitude": 0.005})   # ~550 м на экваторе
        self.assertIsNone(self.map.state()["place"])              # ещё далеко
        self.map.update_status(status(Latitude=0.0, Longitude=0.001))
        place = self.map.state()["place"]
        self.assertEqual(place["name"], "Hutton Settlement")
        self.assertLess(place["distance"], foot_map.PLACE_NEAR_M)

    def test_place_is_a_port_when_the_marker_is_a_port(self):
        self.map.handle({"event": "Docked", "StationName": "Vasco Terminal",
                         "StationType": "CraterPort", "LandingPad": 3,
                         "Latitude": 0.0, "Longitude": 0.0})
        self.assertEqual(self.map.state()["place"]["kind"], foot_map.POI_STATION)


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


class FootMapRenderingContractTests(unittest.TestCase):
    """Связка «состояние → блок HUD», которую видно без запуска Qt.

    Сам холст рисуется настоящим `QPainter`, а в прогоне без графической
    библиотеки Qt не поднимается вовсе. Поэтому здесь проверяется то, что
    ломается тихо: новые данные дошли до блока, у каждой точки есть цвет и
    метка, а новые разделы окна действительно скрываются настройкой.
    """

    @staticmethod
    def _source(name: str) -> str:
        return (Path(__file__).resolve().parent.parent / name).read_text(encoding="utf-8")

    def test_every_footmap_section_points_to_a_real_widget(self):
        import ast

        import overlay_options

        tree = ast.parse(self._source("overlay_blocks.py"))
        assigned = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == "FootMapOverlay":
                for item in ast.walk(node):
                    if isinstance(item, ast.Assign):
                        for target in item.targets:
                            if isinstance(target, ast.Attribute) and \
                                    isinstance(target.value, ast.Name) and \
                                    target.value.id == "self":
                                assigned.add(target.attr)
        for section, (_label, attributes) in overlay_options.CONTENT_OPTIONS["footmap"].items():
            for attribute in attributes:
                self.assertIn(attribute, assigned, f"раздел {section}: нет виджета {attribute}")

    def test_points_and_samples_have_their_own_sections(self):
        import overlay_options

        sections = overlay_options.CONTENT_OPTIONS["footmap"]
        self.assertIn("points", sections)
        self.assertIn("samples", sections)

    def test_canvas_knows_the_rover_and_the_sample_circles(self):
        import ast

        tree = ast.parse(self._source("overlay_blocks.py"))
        canvas = next(node for node in ast.walk(tree)
                      if isinstance(node, ast.ClassDef) and node.name == "FootMapCanvas")
        methods = {item.name for item in canvas.body if isinstance(item, ast.FunctionDef)}
        self.assertIn("_draw_samples", methods)
        self.assertIn("_draw_srv_marker", methods)
        paint = next(item for item in canvas.body
                     if isinstance(item, ast.FunctionDef) and item.name == "paintEvent")
        called = {node.attr for node in ast.walk(paint)
                  if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load)}
        self.assertIn("_draw_samples", called, "круги образцов не рисуются")
        self.assertIn("_draw_pois", called)

    def test_each_kind_has_its_own_marker(self):
        """У поселения и порта свои значки: в игре они тоже разные."""
        import ast

        tree = ast.parse(self._source("overlay_blocks.py"))
        canvas = next(node for node in ast.walk(tree)
                      if isinstance(node, ast.ClassDef) and node.name == "FootMapCanvas")
        methods = {item.name for item in canvas.body if isinstance(item, ast.FunctionDef)}
        for marker in ("_draw_settlement_marker", "_draw_port_marker"):
            self.assertIn(marker, methods)
        draw_pois = next(item for item in canvas.body
                         if isinstance(item, ast.FunctionDef) and item.name == "_draw_pois")
        called = {node.attr for node in ast.walk(draw_pois)
                  if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load)}
        self.assertIn("_draw_settlement_marker", called, "поселение рисуется точкой")
        self.assertIn("_draw_port_marker", called, "порт рисуется точкой")

    def test_place_line_has_its_own_section(self):
        import ast

        import overlay_options

        self.assertIn("place", overlay_options.CONTENT_OPTIONS["footmap"])
        tree = ast.parse(self._source("overlay_blocks.py"))
        overlay = next(node for node in ast.walk(tree)
                       if isinstance(node, ast.ClassDef) and node.name == "FootMapOverlay")
        methods = {item.name for item in overlay.body if isinstance(item, ast.FunctionDef)}
        self.assertIn("_place_text", methods)
        update = next(item for item in overlay.body
                      if isinstance(item, ast.FunctionDef) and item.name == "update_footmap")
        texts = {node.attr for node in ast.walk(update)
                 if isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load)}
        self.assertIn("place_label", texts, "строка «вы в поселении» не обновляется")

    def test_each_point_kind_has_a_colour_and_a_name(self):
        import ast

        tree = ast.parse(self._source("overlay_blocks.py"))
        colours = None
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == "FootMapCanvas":
                for item in node.body:
                    if isinstance(item, ast.Assign) and \
                            getattr(item.targets[0], "id", "") == "POI_COLORS":
                        colours = item.value
        self.assertIsNotNone(colours)
        kinds = {key.attr for key in colours.keys if isinstance(key, ast.Attribute)}
        for kind in ("POI_SHIP", "POI_SRV", "POI_SETTLEMENT", "POI_STATION"):
            self.assertIn(kind, kinds, f"у точки {kind} нет цвета")


if __name__ == "__main__":
    unittest.main()
