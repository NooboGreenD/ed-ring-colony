"""Тесты кэширования экзобиологии и сканирования журналов.

Проверяем:
1. `ExobiologyCache`: сохранение, чтение, обработка повреждённого JSON.
2. `scan_journals_for_system`: извлечение Scan, FSSBodySignals, SAASignalsFound,
   FSSDiscoveryScan из файлов журналов.
3. `scan_all_journals_for_exobio`: агрегация информации обо всех системах в журналах.
4. `ExobiologyTracker`: обработка SAASignalsFound, FSSDiscoveryScan, экспорт/импорт,
   счётчики тел и поиск планет при отсутствии текущего тела (в глубоком космосе).
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from exobiology import (
    ExobiologyCache,
    ExobiologyTracker,
    atmosphere_category,
    body_matches,
    scan_all_journals_for_exobio,
    scan_journals_for_system,
)


class ExobiologyCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.cache_dir = Path(self.tmp)
        self.cache_path = self.cache_dir / "exobio_cache.json"
        self.cache = ExobiologyCache(self.cache_path)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_cache_returns_none(self):
        self.assertIsNone(self.cache.get_system("HIP 99999"))
        self.assertEqual(self.cache.all_systems(), {})

    def test_store_and_get_system(self):
        bodies = {
            "HIP 12345 1": {
                "body_name": "HIP 12345 1",
                "planet_class": "High metal content body",
                "atmosphere": "thin carbon dioxide",
                "landable": True,
                "bio_signals": 2,
            }
        }
        organics = {"Tussock Poxtop": {"samples": 1, "value": 1500000}}
        self.cache.store_system("HIP 12345", bodies, organics, known_body_count=12)

        data = self.cache.get_system("HIP 12345")
        self.assertIsNotNone(data)
        self.assertEqual(data["known_body_count"], 12)
        self.assertEqual(len(data["bodies"]), 1)
        self.assertEqual(data["bodies"]["HIP 12345 1"]["bio_signals"], 2)
        self.assertIn("Tussock Poxtop", data["organics"])

        # Проверяем сохранение на диск
        cache2 = ExobiologyCache(self.cache_path)
        data2 = cache2.get_system("HIP 12345")
        self.assertIsNotNone(data2)
        self.assertEqual(data2["known_body_count"], 12)

    def test_corrupt_cache_file_handled_gracefully(self):
        with open(self.cache_path, "w", encoding="utf-8") as f:
            f.write("{corrupt json content...")

        cache = ExobiologyCache(self.cache_path)
        self.assertIsNone(cache.get_system("HIP 12345"))
        # Запись поверх повреждённого файла работает корректно
        cache.store_system("HIP 12345", {"A": {}}, {}, 5)
        self.assertIsNotNone(cache.get_system("HIP 12345"))

    def test_clear_system(self):
        self.cache.store_system("Sys1", {"B": {}}, {}, 1)
        self.cache.store_system("Sys2", {"C": {}}, {}, 2)
        self.cache.clear_system("Sys1")
        self.assertIsNone(self.cache.get_system("Sys1"))
        self.assertIsNotNone(self.cache.get_system("Sys2"))


class JournalScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.journal_dir = Path(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_journal(self, filename: str, events: list):
        path = self.journal_dir / filename
        with open(path, "w", encoding="utf-8") as f:
            for ev in events:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        return path

    def test_scan_journals_for_system_finds_scans_and_signals(self):
        j1 = [
            {"timestamp": "2026-09-10T10:00:00Z", "event": "FSDJump", "StarSystem": "TestSys"},
            {"timestamp": "2026-09-10T10:01:00Z", "event": "FSSDiscoveryScan", "BodyCount": 8},
            {
                "timestamp": "2026-09-10T10:02:00Z",
                "event": "Scan",
                "StarSystem": "TestSys",
                "BodyName": "TestSys 1",
                "PlanetClass": "High metal content body",
                "Atmosphere": "thin carbon dioxide atmosphere",
                "AtmosphereType": "CarbonDioxide",
                "Landable": True,
                "SurfaceGravity": 4.5,
                "SurfaceTemperature": 220,
            },
            {
                "timestamp": "2026-09-10T10:03:00Z",
                "event": "FSSBodySignals",
                "BodyName": "TestSys 1",
                "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 3}],
            },
            {
                "timestamp": "2026-09-10T10:04:00Z",
                "event": "SAASignalsFound",
                "BodyName": "TestSys 1",
                "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 3}],
                "Genuses": [
                    {"Genus": "$Codex_Ent_Bacterial_Genus_Name;", "Genus_Localised": "Bacterium"},
                    {"Genus": "$Codex_Ent_Stratum_Genus_Name;", "Genus_Localised": "Stratum"},
                ],
            },
            {
                "timestamp": "2026-09-10T10:05:00Z",
                "event": "SAAScanComplete",
                "BodyName": "TestSys 1",
            },
        ]
        self._write_journal("Journal.2026-09-10T100000.01.log", j1)

        tracker = ExobiologyTracker()
        events = scan_journals_for_system(self.journal_dir, "TestSys", handle_func=tracker.handle)
        self.assertEqual(len(events), 6)
        self.assertEqual(tracker.system_known_body_count(), 8)
        self.assertEqual(tracker.system_scanned_count(), 1)
        bodies = tracker.system_bodies()
        self.assertEqual(len(bodies), 1)
        body = bodies[0]
        self.assertEqual(body["body"], "TestSys 1")
        self.assertEqual(body["bio_signals"], 3)
        self.assertTrue(body["mapped"])

    def test_scan_all_journals_for_exobio(self):
        j1 = [
            {"timestamp": "2026-09-10T10:00:00Z", "event": "FSDJump", "StarSystem": "SysA"},
            {"timestamp": "2026-09-10T10:01:00Z", "event": "FSSDiscoveryScan", "BodyCount": 4},
            {
                "timestamp": "2026-09-10T10:02:00Z",
                "event": "Scan",
                "StarSystem": "SysA",
                "BodyName": "SysA 1",
                "PlanetClass": "Icy body",
                "Atmosphere": "methane atmosphere",
                "Landable": True,
            },
            {
                "timestamp": "2026-09-10T10:03:00Z",
                "event": "FSSBodySignals",
                "BodyName": "SysA 1",
                "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 2}],
            },
            {"timestamp": "2026-09-10T11:00:00Z", "event": "FSDJump", "StarSystem": "SysB"},
            {
                "timestamp": "2026-09-10T11:02:00Z",
                "event": "Scan",
                "StarSystem": "SysB",
                "BodyName": "SysB 1",
                "PlanetClass": "Rocky body",
                "Atmosphere": "",
                "Landable": True,
            },
        ]
        self._write_journal("Journal.2026-09-10T100000.01.log", j1)

        tracker = ExobiologyTracker()
        count = scan_all_journals_for_exobio(self.journal_dir, handle_func=tracker.handle)
        self.assertGreaterEqual(count, 5)

        # SysB активна
        self.assertEqual(tracker.current_system, "SysB")
        self.assertEqual(tracker.system_scanned_count(), 1)

        # Данные SysA сохранены
        sys_a = tracker.export_system_data("SysA")
        self.assertEqual(sys_a["known_body_count"], 4)
        self.assertIn("SysA 1", sys_a["bodies"])
        self.assertEqual(sys_a["bodies"]["SysA 1"]["bio_signals"], 2)

        sys_b = tracker.export_system_data("SysB")
        self.assertEqual(len(sys_b["bodies"]), 1)
        self.assertIn("SysB 1", sys_b["bodies"])
        self.assertEqual(sys_b["bodies"]["SysB 1"]["bio_signals"], 0)


class ExobiologyTrackerEnhancementsTests(unittest.TestCase):
    def test_saa_signals_found_event_handling(self):
        tracker = ExobiologyTracker()
        tracker.handle({"event": "FSDJump", "StarSystem": "Beta Hydri"})
        tracker.handle({
            "event": "Scan",
            "StarSystem": "Beta Hydri",
            "BodyName": "Beta Hydri 2",
            "PlanetClass": "Rocky body",
            "Atmosphere": "thin ammonia atmosphere",
            "AtmosphereType": "Ammonia",
            "Landable": True,
        })
        tracker.handle({
            "event": "SAASignalsFound",
            "StarSystem": "Beta Hydri",
            "BodyName": "Beta Hydri 2",
            "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 2}],
            "Genuses": [
                {"Genus": "$Codex_Ent_Bacterial_Genus_Name;", "Genus_Localised": "Bacterium"},
                {"Genus": "$Codex_Ent_Fonticulua_Genus_Name;", "Genus_Localised": "Fonticulua"},
            ],
        })

        body = tracker.bodies.get(tracker._key("Beta Hydri", "Beta Hydri 2"))
        self.assertIsNotNone(body)
        self.assertEqual(body.get("bio_signals"), 2)
        self.assertEqual(len(body.get("genuses", [])), 2)

    def test_fss_discovery_scan_updates_known_count(self):
        tracker = ExobiologyTracker()
        tracker.handle({"event": "FSDJump", "StarSystem": "Lave"})
        self.assertEqual(tracker.system_known_body_count(), 0)

        tracker.handle({"event": "FSSDiscoveryScan", "BodyCount": 16})
        self.assertEqual(tracker.system_known_body_count(), 16)

    def test_import_and_export_system_data(self):
        tracker = ExobiologyTracker()
        tracker.handle({"event": "FSDJump", "StarSystem": "Eravate"})
        tracker.handle({"event": "FSSDiscoveryScan", "BodyCount": 10})
        tracker.handle({
            "event": "Scan",
            "StarSystem": "Eravate",
            "BodyName": "Eravate 1",
            "PlanetClass": "Icy body",
            "Atmosphere": "argon atmosphere",
            "Landable": True,
        })
        tracker.handle({
            "event": "FSSBodySignals",
            "StarSystem": "Eravate",
            "BodyName": "Eravate 1",
            "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 1}],
        })

        exported = tracker.export_system_data("Eravate")
        self.assertEqual(exported["known_body_count"], 10)
        self.assertIn("Eravate 1", exported["bodies"])

        # Новый трекер импортирует данные
        tracker2 = ExobiologyTracker()
        tracker2.current_system = "Eravate"
        tracker2.import_system_data("Eravate", exported)

        self.assertEqual(tracker2.system_known_body_count(), 10)
        self.assertEqual(tracker2.system_scanned_count(), 1)
        bodies = tracker2.system_bodies()
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]["body"], "Eravate 1")
        self.assertEqual(bodies[0]["bio_signals"], 1)

    def test_cache_save_and_load(self):
        tmp = tempfile.mkdtemp()
        try:
            cache = ExobiologyCache(Path(tmp) / "cache.json")
            tracker = ExobiologyTracker()
            tracker.handle({"event": "FSDJump", "StarSystem": "Achenar"})
            tracker.handle({"event": "FSSDiscoveryScan", "BodyCount": 24})
            tracker.handle({
                "event": "Scan",
                "StarSystem": "Achenar",
                "BodyName": "Achenar 3",
                "PlanetClass": "High metal content body",
                "Atmosphere": "carbon dioxide atmosphere",
                "Landable": True,
            })
            tracker.handle({
                "event": "FSSBodySignals",
                "StarSystem": "Achenar",
                "BodyName": "Achenar 3",
                "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 4}],
            })

            tracker.save_to_cache(cache)

            # Восстанавливаем в чистый трекер
            tracker2 = ExobiologyTracker()
            tracker2.load_from_cache(cache)
            tracker2.current_system = "Achenar"

            self.assertEqual(tracker2.system_known_body_count(), 24)
            self.assertEqual(tracker2.system_scanned_count(), 1)
            b = tracker2.system_bodies()
            self.assertEqual(len(b), 1)
            self.assertEqual(b[0]["bio_signals"], 4)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_search_planets_with_previously_scanned_bodies(self):
        from exobiology import PLANET_SEARCH_PRESETS

        tracker = ExobiologyTracker()
        tracker.handle({"event": "FSDJump", "StarSystem": "Maia"})
        tracker.handle({
            "event": "Scan",
            "StarSystem": "Maia",
            "BodyName": "Maia A 2 a",
            "PlanetClass": "Rocky body",
            "Atmosphere": "thin carbon dioxide atmosphere",
            "Landable": True,
        })
        tracker.handle({
            "event": "FSSBodySignals",
            "StarSystem": "Maia",
            "BodyName": "Maia A 2 a",
            "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 2}],
        })

        preset = [p for p in PLANET_SEARCH_PRESETS if p["id"] == "rocky_atmo_land"]
        self.assertTrue(preset)
        results = tracker.search_system_planets(preset)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["body"], "Maia A 2 a")
        self.assertEqual(results[0]["bio_signals"], 2)


class AtmosphereDetectionTests(unittest.TestCase):
    def test_expanded_atmosphere_types(self):
        # Проверяем как прямые строки, так и словари
        self.assertEqual(atmosphere_category({"atmosphere": "nitrogen atmosphere"}), "thin")
        self.assertEqual(atmosphere_category({"atmosphere": "thin nitrogen atmosphere"}), "thin")
        self.assertEqual(atmosphere_category({"atmosphere": "carbon dioxide atmosphere"}), "thin")
        self.assertEqual(atmosphere_category({"atmosphere": "thin carbon dioxide"}), "thin")
        self.assertEqual(atmosphere_category({"atmosphere": "thick methane atmosphere"}), "thick")
        self.assertEqual(atmosphere_category({"atmosphere": "methane-rich atmosphere"}), "thick")
        self.assertEqual(atmosphere_category({"atmosphere": "No atmosphere"}), "none")
        self.assertEqual(atmosphere_category({"atmosphere": ""}), "unknown")


if __name__ == "__main__":
    unittest.main(verbosity=2)
