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
from unittest import mock

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


class MultiSessionScanTests(unittest.TestCase):
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

    def test_system_scanned_multiple_sessions_ago_is_fully_restored(self):
        """Система просканирована 4 игровые сессии назад: сканы и образцы не должны теряться."""
        # Сессия 1: 5 дней назад — сканирование системы и тела с биосигналами
        s1 = [
            {"timestamp": "2026-09-01T10:00:00Z", "event": "FSDJump", "StarSystem": "HIP 54321"},
            {"timestamp": "2026-09-01T10:01:00Z", "event": "FSSDiscoveryScan", "BodyCount": 6},
            {
                "timestamp": "2026-09-01T10:02:00Z",
                "event": "Scan",
                "StarSystem": "HIP 54321",
                "BodyName": "HIP 54321 A",
                "StarType": "G",
            },
            {
                "timestamp": "2026-09-01T10:05:00Z",
                "event": "Scan",
                "StarSystem": "HIP 54321",
                "BodyName": "HIP 54321 1",
                "PlanetClass": "Rocky body",
                "Atmosphere": "thin ammonia atmosphere",
                "AtmosphereType": "Ammonia",
                "Landable": True,
            },
            {
                "timestamp": "2026-09-01T10:06:00Z",
                "event": "FSSBodySignals",
                "BodyName": "HIP 54321 1",
                "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 3}],
            },
            {
                "timestamp": "2026-09-01T10:07:00Z",
                "event": "SAASignalsFound",
                "BodyName": "HIP 54321 1",
                "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 3}],
                "Genuses": [
                    {"Genus": "$Codex_Ent_Bacterial_Genus_Name;", "Genus_Localised": "Bacterium"},
                    {"Genus": "$Codex_Ent_Stratum_Genus_Name;", "Genus_Localised": "Stratum"},
                ],
            },
            {
                "timestamp": "2026-09-01T10:08:00Z",
                "event": "SAAScanComplete",
                "BodyName": "HIP 54321 1",
            },
        ]
        self._write_journal("Journal.2026-09-01T100000.01.log", s1)

        # Сессия 2: 4 дня назад — взятие первого образца
        s2 = [
            {"timestamp": "2026-09-02T12:00:00Z", "event": "Location", "StarSystem": "HIP 54321", "Body": "HIP 54321 1"},
            {
                "timestamp": "2026-09-02T12:10:00Z",
                "event": "ScanOrganic",
                "ScanType": "Sample",
                "StarSystem": "HIP 54321",
                "Body": "HIP 54321 1",
                "Species_Localised": "Bacterium Cerbrus",
            },
        ]
        self._write_journal("Journal.2026-09-02T120000.01.log", s2)

        # Сессия 3: 3 дня назад — игра в другой системе Sol
        s3 = [
            {"timestamp": "2026-09-03T15:00:00Z", "event": "FSDJump", "StarSystem": "Sol"},
            {"timestamp": "2026-09-03T15:05:00Z", "event": "Scan", "StarSystem": "Sol", "BodyName": "Earth"},
        ]
        self._write_journal("Journal.2026-09-03T150000.01.log", s3)

        # Сессия 4: Текущая сессия — вход в игру в HIP 54321, скан второго тела (HIP 54321 2)
        s4 = [
            {"timestamp": "2026-09-05T09:00:00Z", "event": "Location", "StarSystem": "HIP 54321"},
            {
                "timestamp": "2026-09-05T09:01:00Z",
                "event": "Scan",
                "StarSystem": "HIP 54321",
                "BodyName": "HIP 54321 2",
                "PlanetClass": "Icy body",
                "Landable": True,
            },
        ]
        self._write_journal("Journal.2026-09-05T090000.01.log", s4)

        tracker = ExobiologyTracker()
        events = scan_journals_for_system(self.journal_dir, "HIP 54321", handle_func=tracker.handle)

        # Проверяем, что события из сессий 1, 2 и 4 были найдены и применены
        self.assertEqual(tracker.system_known_body_count(), 6)
        self.assertEqual(tracker.system_scanned_count(), 2)  # HIP 54321 1 (из сессии 1) + HIP 54321 2 (из сессии 4)

        bodies = tracker.system_bodies()
        self.assertEqual(len(bodies), 1)
        b = bodies[0]
        self.assertEqual(b["body"], "HIP 54321 1")
        self.assertEqual(b["bio_signals"], 3)
        self.assertTrue(b["mapped"])
        self.assertTrue(b["has_organics"])

        # Проверяем образец
        key = tracker._key("HIP 54321", "HIP 54321 1")
        state = tracker.body_state(key)
        self.assertIsNotNone(state)
        self.assertEqual(len(state.get("organics", [])), 1)
        self.assertEqual(state["organics"][0]["species"], "Bacterium Cerbrus")
        self.assertEqual(state["organics"][0]["samples"], 1)

    def test_cache_indexing_skips_indexed_files(self):
        """Дисковый кэш помнит проиндексированные файлы и пропускает их при повторной проверке."""
        f1 = self._write_journal("Journal.2026-09-01T100000.01.log", [
            {"timestamp": "2026-09-01T10:00:00Z", "event": "FSDJump", "StarSystem": "Sys1"},
            {"timestamp": "2026-09-01T10:02:00Z", "event": "Scan", "StarSystem": "Sys1", "BodyName": "Sys1 1",
             "PlanetClass": "Icy body", "Landable": True},
        ])
        f2 = self._write_journal("Journal.2026-09-02T100000.01.log", [
            {"timestamp": "2026-09-02T10:00:00Z", "event": "FSDJump", "StarSystem": "Sys2"},
            {"timestamp": "2026-09-02T10:02:00Z", "event": "Scan", "StarSystem": "Sys2", "BodyName": "Sys2 1",
             "PlanetClass": "Rocky body", "Landable": True},
        ])

        cache_path = self.journal_dir / "cache.json"
        cache = ExobiologyCache(cache_path)
        tracker = ExobiologyTracker()

        # Первый прогон: оба файла сканируются
        count1 = scan_all_journals_for_exobio(self.journal_dir, handle_func=tracker.handle, cache=cache)
        self.assertGreater(count1, 0)
        self.assertTrue(cache.is_file_indexed(f1.name, f1.stat().st_mtime))
        self.assertTrue(cache.is_file_indexed(f2.name, f2.stat().st_mtime))

        # Второй прогон: файлы не изменились, обработано 0 файлов
        tracker2 = ExobiologyTracker()
        count2 = scan_all_journals_for_exobio(self.journal_dir, handle_func=tracker2.handle, cache=cache)
        self.assertEqual(count2, 0)

        # Добавили третий файл: обрабатывается только он
        f3 = self._write_journal("Journal.2026-09-03T100000.01.log", [
            {"timestamp": "2026-09-03T10:00:00Z", "event": "FSDJump", "StarSystem": "Sys3"},
            {"timestamp": "2026-09-03T10:02:00Z", "event": "Scan", "StarSystem": "Sys3", "BodyName": "Sys3 1"},
        ])
        count3 = scan_all_journals_for_exobio(self.journal_dir, handle_func=tracker2.handle, cache=cache)
        self.assertGreater(count3, 0)
        self.assertTrue(cache.is_file_indexed(f3.name, f3.stat().st_mtime))


class ColonialHelperMultiSessionIntegrationTests(unittest.TestCase):
    def setUp(self):
        from test_initial_upload_flow import install_gui_stubs, make_root

        install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch", "journal_parser",
                     "overlay", "ship_tracker", "route_tracker", "game_monitor",
                     "exobiology", "colonisation", "carrier", "raven_colonial_api"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.root = make_root()

        import colonial_helper

        self.module = colonial_helper
        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_journal(self, filename: str, events: list):
        path = self.home / filename
        with open(path, "w", encoding="utf-8") as f:
            for ev in events:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
        return path

    def test_ensure_system_exobio_loads_bodies_from_old_sessions(self):
        # Старая сессия 5 дней назад
        self._write_journal("Journal.2026-09-05T100000.01.log", [
            {"timestamp": "2026-09-05T10:00:00Z", "event": "FSDJump", "StarSystem": "OldSessionSys"},
            {"timestamp": "2026-09-05T10:01:00Z", "event": "FSSDiscoveryScan", "BodyCount": 5},
            {
                "timestamp": "2026-09-05T10:02:00Z",
                "event": "Scan",
                "StarSystem": "OldSessionSys",
                "BodyName": "OldSessionSys 2",
                "PlanetClass": "Rocky body",
                "Atmosphere": "thin carbon dioxide atmosphere",
                "Landable": True,
            },
            {
                "timestamp": "2026-09-05T10:03:00Z",
                "event": "FSSBodySignals",
                "BodyName": "OldSessionSys 2",
                "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 4}],
            },
        ])

        self.app.exobiology.current_system = "OldSessionSys"
        # В текущей сессии пилот только что отсканировал тело 1
        self.app.exobiology.handle({
            "event": "Scan",
            "StarSystem": "OldSessionSys",
            "BodyName": "OldSessionSys 1",
            "PlanetClass": "Icy body",
            "Landable": True,
        })
        self.assertEqual(self.app.exobiology.system_scanned_count(), 1)

        # Вызываем _ensure_system_exobio
        self.app._ensure_system_exobio("OldSessionSys", force_scan=True)

        # Синхронно проверяем через scan_journals_for_system
        events = scan_journals_for_system(self.home, "OldSessionSys", handle_func=self.app.exobiology.handle)
        self.assertGreaterEqual(len(events), 4)

        # Теперь трекер знает и планету 1, и планету 2 из старой сессии с 4 биосигналами!
        self.assertEqual(self.app.exobiology.system_scanned_count(), 2)
        bodies = self.app.exobiology.system_bodies()
        self.assertEqual(len(bodies), 1)
        self.assertEqual(bodies[0]["body"], "OldSessionSys 2")
        self.assertEqual(bodies[0]["bio_signals"], 4)

    def test_overlay_state_with_past_session_scans(self):
        # Сохраняем в кэш систему из прошлой сессии
        self.app.exobio_cache.store_system("DeepPastSys", {
            "DeepPastSys 3": {
                "body_name": "DeepPastSys 3",
                "planet_class": "Rocky body",
                "atmosphere": "thin carbon dioxide atmosphere",
                "landable": True,
                "bio_signals": 3,
                "mapped": True,
            }
        }, known_body_count=10)

        # В текущей сессии пилот находится в этой системе
        self.app.exobiology.current_system = "DeepPastSys"
        # Текущая сессия знает только 1 тело (первичную звезду)
        self.app.exobiology.handle({
            "event": "Scan",
            "StarSystem": "DeepPastSys",
            "BodyName": "DeepPastSys A",
            "StarType": "K",
        })

        # Фильтр на скалистые планеты
        self.app._exobio_planet_vars["rocky_atmo_land"].set(True)
        self.app.exobio_show_planets_var.set(True)
        self.app._on_exobio_filters_changed()

        # Запрашиваем состояние оверлея
        state = self.app._exobiology_overlay_state()
        self.assertIsNotNone(state)
        self.assertEqual(state["system"], "DeepPastSys")

        # Оверлей видит DeepPastSys 3 из прошлой сессии!
        sys_body_names = [b["body"] for b in state["system_bodies"]]
        self.assertIn("DeepPastSys 3", sys_body_names)

        # Поиск планет находит DeepPastSys 3!
        planet_names = [p["body"] for p in state["planets"]]
        self.assertIn("DeepPastSys 3", planet_names)

    def test_approach_body_from_past_session_loads_biology(self):
        # 10 сессий назад отсканировано тело с 2 биосигналами
        self.app.exobio_cache.store_system("TargetSys", {
            "TargetSys 4": {
                "body_name": "TargetSys 4",
                "planet_class": "High metal content body",
                "atmosphere": "thin carbon dioxide atmosphere",
                "landable": True,
                "bio_signals": 2,
                "mapped": True,
            }
        }, known_body_count=8)

        # Текущая сессия: пилот подлетает к TargetSys 4
        self.app._handle_tracked_event({
            "event": "ApproachBody",
            "StarSystem": "TargetSys",
            "Body": "TargetSys 4",
        })

        state = self.app.exobiology.current_body_state()
        self.assertIsNotNone(state)
        self.assertEqual(state["body"], "TargetSys 4")
        self.assertEqual(state["bio_signals"], 2)
        self.assertTrue(state["mapped"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
