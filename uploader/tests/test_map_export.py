"""Экспорт карты в PNG: валидный файл, детерминированность, без падений.

Рендер карты в картинку живёт в `map_export` на чистом stdlib, поэтому здесь
проверяем байты: сигнатуру, размеры из IHDR, повторяемость и то, что кириллица
и неизвестные глифы не роняют экспорт.
"""

import struct
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from map_export import export_map_png, save_map_png  # noqa: E402
from test_system_map import depot_event, resource, scanned_system  # noqa: E402


def png_dims(data: bytes):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "это не PNG"
    width, height = struct.unpack(">II", data[16:24])
    return width, height


class MapExportTests(unittest.TestCase):
    def snapshot(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 6680, 1815)]))
        return builder.snapshot()

    def test_signature_and_dimensions(self):
        data = export_map_png(self.snapshot(), width=640, height=400)
        self.assertEqual(png_dims(data), (640, 400))
        self.assertIn(b"IHDR", data[12:16])
        self.assertTrue(data.endswith(b"IEND\xaeB`\x82"))

    def test_deterministic(self):
        snapshot = self.snapshot()
        self.assertEqual(export_map_png(snapshot), export_map_png(snapshot))

    def test_different_systems_differ(self):
        first = export_map_png(self.snapshot())
        other = export_map_png(scanned_system().snapshot())
        self.assertNotEqual(first, other)

    def test_empty_snapshot_does_not_crash(self):
        from system_map import SystemMapBuilder
        data = export_map_png(SystemMapBuilder().snapshot())
        self.assertEqual(png_dims(data)[0], 1280)

    def test_planned_site_dashed_diamond(self):
        builder = scanned_system()
        builder.merge_site_plans("HIP 22460", [
            {"id": "s-9", "name": "B 2", "buildType": "Orbis Starport",
             "bodyNum": 4, "bodyName": "HIP 22460 A 2", "status": "planned"}])
        data = export_map_png(builder.snapshot())
        self.assertEqual(png_dims(data), (1280, 820))

    def test_unknown_glyphs_are_safe(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 100, 10)]))
        snapshot = builder.snapshot()
        snapshot.sites[0].build_name = "Стройка ★ Ω"
        data = export_map_png(snapshot)
        self.assertEqual(png_dims(data)[1], 820)

    def test_save_writes_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.png"
            self.assertTrue(save_map_png(self.snapshot(), path))
            self.assertEqual(png_dims(path.read_bytes())[0], 1280)
            self.assertFalse(save_map_png(self.snapshot(), Path(tmp) / "no" / "dir" / "x.png"))


if __name__ == "__main__":
    unittest.main()
