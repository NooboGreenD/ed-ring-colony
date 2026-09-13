"""Тесты экзобиологии: разбор журнала и предсказание родов.

Проверяем, что:

* события журнала (`Scan`, `SAAScanComplete`, `FSSBodySignals`, `ScanOrganic`,
  `CodexEntry`) складываются в состояние тела;
* предсказание опирается на атмосферу и геологию: на телах без атмосферы не
  предлагаются роды, требующие thin, и наоборот;
* прогресс образцов считается по трём сэмплам.
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from exobiology import ExobiologyTracker, atmosphere_category, predict_genera  # noqa: E402


def scan_event(**overrides):
    event = {
        "event": "Scan",
        "StarSystem": "HIP 12345",
        "BodyName": "HIP 12345 A 3",
        "BodyID": 12,
        "PlanetClass": "Rocky body",
        "Landable": True,
        "Atmosphere": "thin sulfur dioxide atmosphere",
        "AtmosphereType": "SulfurDioxide",
        "AtmosphereComposition": [{"Name": "SulfurDioxide", "Percent": 96.0}],
        "SurfaceGravity": 4.2,
        "SurfaceTemperature": 188.0,
        "Volcanism": "",
        "Materials": [{"Name": "iron", "Percent": 19.0}],
        "DistanceFromArrivalLS": 812.4,
    }
    event.update(overrides)
    return event


class AtmosphereCategoryTests(unittest.TestCase):
    def test_categories(self):
        self.assertEqual(atmosphere_category({"atmosphere": "", "atmosphere_type": ""}), "unknown")
        self.assertEqual(atmosphere_category({"atmosphere": "", "atmosphere_type": "None"}), "none")
        self.assertEqual(
            atmosphere_category({"atmosphere": "thin sulfur dioxide atmosphere"}), "thin")
        self.assertEqual(
            atmosphere_category({"atmosphere": "thick carbon dioxide atmosphere"}), "thick")
        self.assertEqual(atmosphere_category({}), "unknown")


class PredictionTests(unittest.TestCase):
    def test_vacuum_body_excludes_thin_atmosphere_genera(self):
        body = {"atmosphere": "", "atmosphere_type": "None", "volcanism": "",
                "surface_temperature": 120.0, "surface_gravity": 2.0}
        genera = {genus for genus, _score, _notes in predict_genera(body)}
        self.assertIn("Amphora Plant", genera)
        self.assertIn("Bark Mounds", genera)
        self.assertNotIn("Tussock", genera)   # требует тонкую атмосферу
        self.assertNotIn("Aleoida", genera)
        self.assertNotIn("Conchas", genera)   # требует геологию

    def test_vacuum_with_volcanism_adds_geology_genera(self):
        body = {"atmosphere": "", "atmosphere_type": "None",
                "volcanism": "major silicate vapour geysers volcanism",
                "surface_temperature": 320.0, "surface_gravity": 6.0}
        genera = {genus for genus, _score, _notes in predict_genera(body)}
        self.assertIn("Conchas", genera)
        self.assertIn("Shards", genera)
        self.assertIn("Fumerola", genera)

    def test_thin_atmosphere_gives_classic_list(self):
        body = {"atmosphere": "thin carbon dioxide atmosphere", "volcanism": "",
                "surface_temperature": 210.0, "surface_gravity": 8.0}
        genera = {genus for genus, _score, _notes in predict_genera(body)}
        self.assertIn("Tussock", genera)
        self.assertIn("Aleoida", genera)
        self.assertIn("Bacterium", genera)
        self.assertNotIn("Amphora Plant", genera)
        self.assertNotIn("Electricae", genera)  # нужна геология

    def test_geology_rules_are_scored_higher(self):
        plain = {genus: score for genus, score, _n in
                 predict_genera({"atmosphere": "thin nitrogen atmosphere", "volcanism": ""})}
        volcanic = {genus: score for genus, score, _n in
                    predict_genera({"atmosphere": "thin nitrogen atmosphere",
                                    "volcanism": "carbon dioxide geysers"})}
        self.assertGreater(volcanic.get("Electricae", 0), plain.get("Electricae", 0))
        self.assertGreater(volcanic.get("Bacterium", 0), plain.get("Bacterium", 0))

    def test_unknown_atmosphere_yields_no_guessing(self):
        """Без данных об атмосфере модель не выдаёт случайных родов."""
        self.assertEqual(predict_genera({}), [])
        self.assertEqual(predict_genera({"atmosphere": "", "atmosphere_type": ""}), [])

    def test_limit_is_respected(self):
        body = {"atmosphere": "thin argon atmosphere", "volcanism": ""}
        self.assertLessEqual(len(predict_genera(body, limit=3)), 3)


class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.tracker = ExobiologyTracker()

    def test_scan_and_signals_and_mapping(self):
        self.tracker.handle({"event": "FSDJump", "StarSystem": "HIP 12345"})
        self.tracker.handle(scan_event())
        self.tracker.handle({"event": "SAAScanComplete", "BodyName": "HIP 12345 A 3"})
        self.tracker.handle({
            "event": "FSSBodySignals",
            "BodyName": "HIP 12345 A 3",
            "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 3},
                        {"Type": "$SAA_SignalType_Geological;", "Count": 1}],
        })
        state = self.tracker.current_body_state()
        self.assertIsNotNone(state)
        self.assertEqual(state["body"], "HIP 12345 A 3")
        self.assertEqual(state["bio_signals"], 3)
        self.assertTrue(state["mapped"])
        self.assertEqual(state["atmosphere_category"], "thin")
        self.assertIn("Tussock", [p["genus"] for p in state["predictions"]])

    def test_organic_sampling_progress(self):
        self.tracker.handle({"event": "FSDJump", "StarSystem": "Sol"})
        self.tracker.handle(scan_event(StarSystem="Sol", BodyName="Sol 3"))
        self.tracker.handle({"event": "ApproachBody", "StarSystem": "Sol", "BodyName": "Sol 3"})
        for _ in range(2):
            self.tracker.handle({"event": "ScanOrganic", "Body": "Sol 3",
                                 "Species": "$Codex_Ent_Tussocks_Genus_Name;",
                                 "Species_Localised": "Tussock", "ScanType": "Sample"})
        state = self.tracker.current_body_state()
        organics = {row["species"]: row for row in state["organics"]}
        self.assertEqual(organics["Tussock"]["samples"], 2)
        self.assertFalse(organics["Tussock"]["complete"])
        self.tracker.handle({"event": "ScanOrganic", "Body": "Sol 3",
                             "Species_Localised": "Tussock", "ScanType": "Sample"})
        state = self.tracker.current_body_state()
        organics = {row["species"]: row for row in state["organics"]}
        self.assertTrue(organics["Tussock"]["complete"])

    def test_signal_keeps_max_count(self):
        self.tracker.handle({"event": "FSDJump", "StarSystem": "A"})
        self.tracker.handle(scan_event(StarSystem="A", BodyName="A 1"))
        for count in (2, 5, 3):
            self.tracker.handle({"event": "FSSBodySignals", "BodyName": "A 1",
                                 "Signals": [{"Type": "$SAA_SignalType_Biological;",
                                              "Count": count}]})
        self.assertEqual(self.tracker.current_body_state()["bio_signals"], 5)

    def test_rescan_does_not_lose_mapped_state(self):
        self.tracker.handle({"event": "FSDJump", "StarSystem": "A"})
        self.tracker.handle(scan_event(StarSystem="A", BodyName="A 1"))
        self.tracker.handle({"event": "SAAScanComplete", "BodyName": "A 1"})
        self.tracker.handle(scan_event(StarSystem="A", BodyName="A 1"))
        self.assertTrue(self.tracker.current_body_state()["mapped"])

    def test_bad_events_do_not_break_tracker(self):
        for event in ({}, {"event": "Scan"}, {"event": "ScanOrganic"},
                      {"event": "FSSBodySignals", "Signals": "boom"}):
            self.tracker.handle(event)
        self.assertIsNone(self.tracker.current_body_state())

    def test_bodies_are_separated_by_system(self):
        self.tracker.handle({"event": "FSDJump", "StarSystem": "A"})
        self.tracker.handle(scan_event(StarSystem="A", BodyName="A 1"))
        self.tracker.handle({"event": "FSDJump", "StarSystem": "B"})
        self.tracker.handle(scan_event(StarSystem="B", BodyName="B 2"))
        self.assertEqual(len(self.tracker.recent_bodies()), 1)
        self.assertEqual(self.tracker.recent_bodies()[0]["body"], "B 2")

    def test_codex_entry_counts_species(self):
        self.tracker.handle({
            "event": "CodexEntry",
            "Category": "$Codex_CategoryType_Biology;",
            "Name_Localised": "Bacterium",
        })
        self.assertEqual(self.tracker.seen_species.get("Bacterium"), 1)


if __name__ == "__main__":
    unittest.main()
