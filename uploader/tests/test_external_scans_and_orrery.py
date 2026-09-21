"""Тесты внешних сканов (EDSM / БД проекта) и 3D Orrery карты системы."""

import math
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from system_map import (
    SystemMapBuilder,
    layout,
    MapSnapshot,
    MapBody,
    MapStation,
    PlayerPosition,
    KIND_STAR,
    KIND_PLANET,
    KIND_MOON,
)
from edsm_api import EDSMAPI
from api_client import ApiClient


class ExternalScansTests(unittest.TestCase):
    """Проверка загрузки сканов, сделанных другими игроками."""

    def test_load_external_bodies_populates_system(self):
        builder = SystemMapBuilder()
        builder.current_system = "Colonia"

        bodies = [
            {
                "name": "Colonia",
                "type": "Star",
                "subType": "F (White) Star",
                "distanceToArrival": 0.0,
                "radius": 850000.0,
            },
            {
                "name": "Colonia 1",
                "type": "Planet",
                "subType": "High metal content world",
                "distanceToArrival": 142.5,
                "radius": 4500.0,
                "isLandable": True,
                "atmosphereType": "thin carbon dioxide atmosphere",
                "first_discovered_by": "CMDR Explorer",
            },
            {
                "name": "Colonia 1 a",
                "type": "Planet",
                "subType": "Rocky body",
                "distanceToArrival": 143.0,
                "parents": [{"Planet": 1}],
                "radius": 1200.0,
                "isLandable": True,
            },
        ]

        changed = builder.load_external_bodies(bodies, source="edsm")
        self.assertTrue(changed)

        snapshot = builder.snapshot()
        self.assertEqual(snapshot.system, "Colonia")
        self.assertEqual(len(snapshot.bodies), 3)
        self.assertEqual(snapshot.known_body_count, 3)

        star = snapshot.star
        self.assertIsNotNone(star)
        self.assertEqual(star.name, "Colonia")

        planet = next(b for b in snapshot.bodies if b.name == "Colonia 1")
        self.assertEqual(planet.kind, KIND_PLANET)
        self.assertTrue(planet.landable)
        self.assertEqual(planet.first_discovered_by, "CMDR Explorer")
        self.assertEqual(planet.source, "edsm")
        self.assertTrue(planet.from_external)

        moon = next(b for b in snapshot.bodies if b.name == "Colonia 1 a")
        self.assertEqual(moon.kind, KIND_MOON)

    def test_local_journal_scan_preserves_priority(self):
        builder = SystemMapBuilder()
        builder.handle({
            "event": "FSDJump",
            "StarSystem": "Sol",
            "SystemAddress": 10477373803,
        })
        builder.handle({
            "event": "Scan",
            "StarSystem": "Sol",
            "BodyName": "Earth",
            "PlanetClass": "Earthlike body",
            "DistanceFromArrivalLS": 499.0,
            "Landable": False,
            "WasDiscovered": True,
        })

        external_bodies = [
            {
                "name": "Earth",
                "type": "Planet",
                "subType": "Water world",  # Другой сабтайп
                "distanceToArrival": 500.0,
                "first_discovered_by": "Historic",
            }
        ]

        builder.load_external_bodies(external_bodies, source="edsm")
        snapshot = builder.snapshot()
        earth = next(b for b in snapshot.bodies if b.name == "Earth")

        # Собственный скан не должен затираться типом из EDSM
        self.assertEqual(earth.body_class, "Earthlike body")
        self.assertEqual(earth.first_discovered_by, "Historic")
        self.assertFalse(earth.from_external)


class Orrery3DLayoutTests(unittest.TestCase):
    """Проверка геометрии и проекции 3D Orrery."""

    def setUp(self):
        self.builder = SystemMapBuilder()
        self.builder.handle({
            "event": "FSDJump",
            "StarSystem": "Proxima",
            "SystemAddress": 99999,
        })
        self.builder.handle({
            "event": "Scan",
            "StarSystem": "Proxima",
            "BodyName": "Proxima Major",
            "StarType": "M",
            "DistanceFromArrivalLS": 0.0,
            "Radius": 1.5e8,
        })
        self.builder.handle({
            "event": "Scan",
            "StarSystem": "Proxima",
            "BodyName": "Proxima 1",
            "PlanetClass": "High metal content world",
            "DistanceFromArrivalLS": 85.0,
            "SemiMajorAxis": 2.5e10,
            "Radius": 5.0e6,
            "Landable": True,
            "Atmosphere": "carbon dioxide atmosphere",
            "SurfaceGravity": 9.8,
        })
        self.builder.handle({
            "event": "Scan",
            "StarSystem": "Proxima",
            "BodyName": "Proxima 1 a",
            "PlanetClass": "Rocky body",
            "DistanceFromArrivalLS": 85.2,
            "Parents": [{"Planet": 1}],
            "SemiMajorAxis": 4.0e8,
            "Radius": 1.2e6,
            "Landable": True,
        })

    def test_2d_and_3d_modes_produce_placed_items(self):
        snapshot = self.builder.snapshot()
        items_2d = layout(snapshot, 800, 600, mode="2d")
        items_3d = layout(snapshot, 800, 600, mode="3d", pitch_deg=38.0, yaw_deg=-20.0)

        self.assertGreaterEqual(len(items_2d), 3)
        self.assertGreaterEqual(len(items_3d), 3)

        # В 3D Orrery эллипсы имеют полуоси a и b (b < a из-за наклона перспективы)
        planet_3d = next(it for it in items_3d if it.label == "Proxima 1")
        self.assertGreater(planet_3d.orbit_a, 0)
        self.assertGreater(planet_3d.orbit_b, 0)
        self.assertLess(planet_3d.orbit_b, planet_3d.orbit_a)

        # Есть координаты базовой плоскости (plane_x, plane_y) для вертикальных дроп-линий
        self.assertIsNotNone(planet_3d.plane_x)
        self.assertIsNotNone(planet_3d.plane_y)
        self.assertTrue(planet_3d.landable)
        self.assertAlmostEqual(planet_3d.distance_ls, 85.0, places=1)

    def test_3d_pitch_affects_orbit_minor_axis(self):
        snapshot = self.builder.snapshot()
        # При более крутом угле наклона камеры (наблюдение сверху 80°) малая полуось больше
        items_steep = layout(snapshot, 800, 600, mode="3d", pitch_deg=80.0)
        # При пологом угле (20°) малая полуось сильно сплюснута
        items_shallow = layout(snapshot, 800, 600, mode="3d", pitch_deg=20.0)

        p_steep = next(it for it in items_steep if it.label == "Proxima 1")
        p_shallow = next(it for it in items_shallow if it.label == "Proxima 1")

        self.assertGreater(p_steep.orbit_b, p_shallow.orbit_b)

    def test_center_on_translates_items_in_3d(self):
        snapshot = self.builder.snapshot()
        items_uncentered = layout(snapshot, 800, 600, mode="3d")
        items_centered = layout(snapshot, 800, 600, mode="3d", center_on="Proxima 1")

        p_uncentered = next(it for it in items_uncentered if it.label == "Proxima 1")
        p_centered = next(it for it in items_centered if it.label == "Proxima 1")

        # При центрировании целевой объект встает ровно в середину (400, 300)
        self.assertAlmostEqual(p_centered.x, 400.0, places=1)
        self.assertAlmostEqual(p_centered.y, 300.0, places=1)


class ClientApiExtScansTests(unittest.TestCase):
    """Проверка методов API для внешних сканов и статистики пилота."""

    def test_edsm_fetch_system_bodies_mocked(self):
        edsm = EDSMAPI()
        with mock.patch.object(edsm._session, "get") as mock_get:
            mock_resp = mock.MagicMock()
            mock_resp.ok = True
            mock_resp.json.return_value = {
                "name": "Eol Prou RS-T d3-94",
                "bodies": [{"name": "Eol Prou RS-T d3-94 A", "type": "Star"}],
            }
            mock_get.return_value = mock_resp

            res = edsm.fetch_system_bodies("Eol Prou RS-T d3-94")
            self.assertTrue(res["ok"])
            self.assertEqual(len(res["bodies"]), 1)
            self.assertEqual(res["bodies"][0]["name"], "Eol Prou RS-T d3-94 A")

    def test_api_client_upload_pilot_stats_mocked(self):
        client = ApiClient(token="test-token-123")
        with mock.patch.object(client._session, "post") as mock_post:
            mock_resp = mock.MagicMock()
            mock_resp.ok = True
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"ok": True, "stats": {"credits": 50000000}}
            mock_post.return_value = mock_resp

            stats = {
                "credits": 50000000,
                "arx": 1250,
                "mercenary_coins": 45,
                "first_discoveries_count": 12,
                "bio_samples_count": 34,
            }
            res = client.upload_pilot_stats(stats, cmdr="CMDR Test")
            self.assertTrue(res["ok"])
            mock_post.assert_called_once()
            call_json = mock_post.call_args.kwargs["json"]
            self.assertEqual(call_json["token"], "test-token-123")
            self.assertEqual(call_json["credits"], 50000000)
            self.assertEqual(call_json["arx"], 1250)


if __name__ == "__main__":
    unittest.main()
