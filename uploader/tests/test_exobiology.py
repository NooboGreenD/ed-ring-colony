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

from exobiology import (  # noqa: E402
    FIRST_DISCOVERY_BONUS,
    MAPPED_BONUS,
    SAMPLE_COOLDOWN_SECONDS,
    ExobiologyTracker,
    atmosphere_category,
    estimate_value,
    format_credits,
    GENUS_RULES,
    MIN_PREDICTION_PERCENT,
    estimate_value,
    normalize_genus,
    predict_genera,
    prediction_rows,
)


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
        """Без атмосферы, но с геологией: Anemone/Brain Trees/Tubers/Fumerola.

        Консервативная правка модели: роды без атмосферы — это Anemone, Brain
        Trees, Sinuous Tubers, Crystalline Shards, Bark Mounds, Amphora Plant и
        Fumerola. «Conchas» же, наоборот, живут на тонкой атмосфере
        (аммиак/азот/вода/CO2), и на вакуумном теле их быть не может — раньше
        модель ставила их в пару «вакуум + геология», что было ошибкой.
        """
        body = {"atmosphere": "", "atmosphere_type": "None",
                "volcanism": "major silicate vapour geysers volcanism",
                "surface_temperature": 320.0, "surface_gravity": 6.0}
        genera = {genus for genus, _score, _notes in predict_genera(body)}
        self.assertIn("Sinuous Tubers", genera)
        self.assertIn("Crystalline Shards", genera)
        self.assertIn("Fumerola", genera)
        self.assertIn("Anemone", genera)
        self.assertNotIn("Conchas", genera)
        self.assertNotIn("Tussock", genera)

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
        """Геология добавляет вес там, где она «бонус», и обязательна для Fumerola."""
        plain = {genus: score for genus, score, _n in
                 predict_genera({"atmosphere": "thin argon atmosphere", "volcanism": "",
                                 "planet_class": "Icy body"})}
        volcanic = {genus: score for genus, score, _n in
                    predict_genera({"atmosphere": "thin argon atmosphere",
                                    "volcanism": "carbon dioxide geysers",
                                    "planet_class": "Icy body"})}
        self.assertGreater(volcanic.get("Electricae", 0), plain.get("Electricae", 0))
        self.assertGreater(volcanic.get("Bacterium", 0), plain.get("Bacterium", 0))
        self.assertNotIn("Fumerola", plain)
        self.assertIn("Fumerola", volcanic)

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


class RulesAccuracyTests(unittest.TestCase):
    """То, ради чего модель переписывали: газ, класс, гравитация и виды."""

    def test_gas_of_atmosphere_matters(self):
        """Тонкая атмосфера есть, а газа рода нет — рода показывать нельзя."""
        argon = {"atmosphere": "thin argon atmosphere", "planet_class": "Icy body"}
        rows = {row["genus"] for row in prediction_rows(argon)}
        self.assertIn("Electricae", rows)
        self.assertIn("Fonticulua", rows)
        co2 = {"atmosphere": "thin carbon dioxide atmosphere", "planet_class": "Rocky body"}
        rows = {row["genus"] for row in prediction_rows(co2)}
        self.assertNotIn("Electricae", rows)
        self.assertIn("Tussock", rows)

    def test_journal_spelling_variants_are_equivalent(self):
        """«sulphur»/«sulfur»/«SulfurDioxide» — один и тот же газ для модели."""
        british = {"atmosphere": "thin sulphur dioxide atmosphere", "planet_class": "Rocky body"}
        american = {"atmosphere": "Thin Sulfur Dioxide atmosphere",
                    "atmosphere_type": "SulfurDioxide", "planet_class": "Rocky body"}
        expect = {row["genus"] for row in prediction_rows(british)}
        self.assertEqual(expect, {row["genus"] for row in prediction_rows(american)})
        self.assertIn("Recepta", expect)

    def test_wrong_planet_class_excludes_the_genus(self):
        body = {"atmosphere": "thin ammonia atmosphere", "planet_class": "Icy body"}
        rows = {row["genus"] for row in prediction_rows(body)}
        self.assertNotIn("Aleoida", rows)      # только Rocky/HMC
        self.assertNotIn("Frutexa", rows)     # только Rocky/HMC

    def test_gravity_cap_lowers_the_percent_instead_of_excluding(self):
        rule = GENUS_RULES["Aleoida"]
        self.assertEqual(rule["max_g"], 0.27)
        light = {"atmosphere": "thin ammonia atmosphere", "planet_class": "Rocky body",
                 "surface_gravity": 1.0}
        heavy = dict(light, surface_gravity=8.0)
        rows = {row["genus"]: row for row in prediction_rows(heavy)}
        self.assertIn("Aleoida", rows)                       # не выбрасываем
        self.assertLess(rows["Aleoida"]["percent"], 100)      # но снижаем
        self.assertEqual(100, {row["genus"]: row for row in prediction_rows(light)}["Aleoida"]["percent"])
        self.assertTrue(any("гравитация" in note for note in rows["Aleoida"]["notes"]))

    def test_species_are_predicted_with_the_genus(self):
        body = {"atmosphere": "thin carbon dioxide atmosphere", "planet_class": "Rocky body",
                "surface_temperature": 185.0}
        rows = {row["genus"]: row for row in prediction_rows(body)}
        self.assertIn("Aleoida coronamus", rows["Aleoida"]["species"])
        self.assertNotIn("Aleoida laminiae", rows["Aleoida"]["species"])   # аммиачный вид
        # Temperature band picks the right Tussock too.
        self.assertTrue(any("Tussock" in name for name in rows["Tussock"]["species"]))

    def test_confirmed_genera_win_and_aliases_resolve(self):
        self.assertEqual(normalize_genus("Shards"), "Crystalline Shards")
        self.assertEqual(normalize_genus("Sinuous Tuber"), "Sinuous Tubers")
        self.assertGreater(estimate_value("Shards"), 0)
        self.assertGreater(estimate_value("Tubers"), 0)

    def test_weak_matches_are_not_shown(self):
        """Тело без данных атмосферы не должно превращаться в «возможно всё»."""
        self.assertEqual(prediction_rows({"planet_class": "Rocky body"}), [])
        self.assertEqual(predict_genera({"planet_class": "Rocky body"}), [])
        rows = prediction_rows({"atmosphere": "thick water atmosphere", "planet_class": "Water world"})
        self.assertTrue(all(row["percent"] >= MIN_PREDICTION_PERCENT for row in rows))


class ValueEstimateTests(unittest.TestCase):
    """Оценка выплаты: порядок величины, а не прайс."""

    def test_base_value(self):
        self.assertGreater(estimate_value("Tussock"), 0)
        self.assertEqual(estimate_value("Tussock", mapped=False),
                         estimate_value("Tussock"))

    def test_multipliers(self):
        base = estimate_value("Osseus")
        self.assertEqual(estimate_value("Osseus", mapped=True),
                         int(round(base * MAPPED_BONUS)))
        self.assertEqual(estimate_value("Osseus", first_discovery=True),
                         int(round(base * FIRST_DISCOVERY_BONUS)))

    def test_unknown_genus_gives_zero_not_a_guess(self):
        self.assertEqual(estimate_value("Неизвестный род"), 0)
        self.assertEqual(estimate_value(""), 0)
        self.assertEqual(estimate_value(None), 0)

    def test_format_credits(self):
        self.assertEqual(format_credits(0), "0")
        self.assertEqual(format_credits(850), "850")
        self.assertEqual(format_credits(550_000), "550 тыс")
        self.assertEqual(format_credits(1_200_000), "1.2 млн")
        self.assertEqual(format_credits(2_000_000), "2 млн")
        self.assertEqual(format_credits("мусор"), "0")


class PredictionRowsTests(unittest.TestCase):
    """Процент считается от максимума, достижимого для конкретного рода."""

    def test_percent_is_relative_to_the_genus_maximum(self):
        body = {"atmosphere": "thin sulfur dioxide atmosphere",
                "volcanism": "", "surface_temperature": 188.0,
                "surface_gravity": 4.2}
        rows = {row["genus"]: row for row in prediction_rows(body)}
        # Род только с атмосферным правилом: совпало — значит 100 %.
        self.assertEqual(rows["Tussock"]["percent"], 100)
        # Electricae требует геологию и на таком теле не предсказывается вовсе.
        self.assertNotIn("Electricae", rows)

    def test_geology_genus_reaches_full_percent(self):
        body = {"atmosphere": "thin argon atmosphere", "planet_class": "Icy body",
                "volcanism": "minor silicate vapour geysers", "surface_gravity": 1.0}
        rows = {row["genus"]: row for row in prediction_rows(body)}
        self.assertEqual(rows["Electricae"]["percent"], 100)
        self.assertIn("геология есть", rows["Electricae"]["notes"])
        # Род с обязательной геологией на таком теле тоже на 100 %.
        self.assertEqual(rows["Fumerola"]["percent"], 100)

    def test_rows_carry_value_and_limit(self):
        body = {"atmosphere": "thin sulfur dioxide atmosphere", "volcanism": ""}
        rows = prediction_rows(body)
        self.assertTrue(all("value_cr" in row and "percent" in row for row in rows))
        self.assertLessEqual(len(prediction_rows(body, limit=2)), 2)

    def test_empty_body(self):
        self.assertEqual(prediction_rows({}), [])


class SampleTimingTests(unittest.TestCase):
    """Обратный отсчёт до следующего образца."""

    def setUp(self):
        self.tracker = ExobiologyTracker()
        self.tracker.handle({"event": "FSDJump", "StarSystem": "Sol"})
        self.tracker.handle(scan_event(StarSystem="Sol", BodyName="Sol 3"))
        self.tracker.handle({"event": "ApproachBody", "StarSystem": "Sol",
                             "BodyName": "Sol 3"})

    def _sample(self, timestamp):
        self.tracker.handle({
            "event": "ScanOrganic", "timestamp": timestamp, "Body": "Sol 3",
            "Species_Localised": "Tussock", "ScanType": "Sample"})

    def test_countdown_uses_event_timestamp(self):
        self._sample("2025-01-01T00:00:00Z")
        from datetime import datetime, timezone

        now = datetime(2025, 1, 1, 0, 0, 10, tzinfo=timezone.utc).timestamp()
        row = self.tracker.current_body_state(now=now)["organics"][0]
        self.assertEqual(row["samples"], 1)
        self.assertEqual(row["wait_seconds"], int(round(SAMPLE_COOLDOWN_SECONDS - 10)))
        self.assertEqual(row["samples_left"], 2)

    def test_countdown_reaches_zero(self):
        self._sample("2025-01-01T00:00:00Z")
        from datetime import datetime, timezone

        now = datetime(2025, 1, 1, 0, 5, 0, tzinfo=timezone.utc).timestamp()
        row = self.tracker.current_body_state(now=now)["organics"][0]
        self.assertEqual(row["wait_seconds"], 0)

    def test_complete_set_has_no_countdown_and_carries_value(self):
        for second in (0, 40, 80):
            self._sample(f"2025-01-01T00:00:{second:02d}Z")
        from datetime import datetime, timezone

        now = datetime(2025, 1, 1, 0, 2, 0, tzinfo=timezone.utc).timestamp()
        state = self.tracker.current_body_state(now=now)
        row = state["organics"][0]
        self.assertTrue(row["complete"])
        self.assertEqual(row["wait_seconds"], 0)
        self.assertGreater(row["value_cr"], 0)
        self.assertEqual(state["value_cr"], row["value_cr"])
        self.assertEqual(state["samples_done"], 3)
        self.assertEqual(state["samples_total"], 3)

    def test_genus_is_derived_from_species_name(self):
        self.assertEqual(ExobiologyTracker._genus_of("Tussock Poxtop"), "Tussock")
        self.assertEqual(ExobiologyTracker._genus_of("Osseus"), "Osseus")
        self.assertEqual(ExobiologyTracker._genus_of("Что-то незнакомое"),
                         "Что-то")
        self.assertEqual(ExobiologyTracker._genus_of(""), "")


class SystemBodiesTests(unittest.TestCase):
    """Список тел системы: куда лететь за биосигналами."""

    def setUp(self):
        self.tracker = ExobiologyTracker()
        self.tracker.handle({"event": "FSDJump", "StarSystem": "A"})
        self.tracker.handle(scan_event(StarSystem="A", BodyName="A 1"))
        self.tracker.handle(scan_event(StarSystem="A", BodyName="A 2"))
        self.tracker.handle({"event": "FSDJump", "StarSystem": "B"})
        self.tracker.handle(scan_event(StarSystem="B", BodyName="B 1"))
        # Вернулись в A — список тел системы смотрим по ней.
        self.tracker.handle({"event": "FSDJump", "StarSystem": "A"})

    def _signals(self, body, count, system="A"):
        self.tracker.handle({"event": "FSSBodySignals", "StarSystem": system,
                             "BodyName": body,
                             "Signals": [{"Type": "$SAA_SignalType_Biological;",
                                          "Count": count}]})

    def test_only_current_system_and_sorted_by_signals(self):
        self._signals("A 1", 2)
        self._signals("A 2", 5)
        self._signals("B 1", 9, system="B")
        rows = self.tracker.system_bodies()
        self.assertEqual([row["body"] for row in rows], ["A 2", "A 1"])
        self.assertEqual(rows[0]["bio_signals"], 5)

    def test_bodies_without_signals_are_hidden(self):
        self._signals("A 1", 3)
        rows = self.tracker.system_bodies()
        self.assertEqual([row["body"] for row in rows], ["A 1"])

    def test_limit(self):
        self._signals("A 1", 3)
        self._signals("A 2", 4)
        self.assertEqual(len(self.tracker.system_bodies(limit=1)), 1)

    def test_signals_follow_the_event_system_not_the_current_one(self):
        self.tracker.handle({"event": "FSDJump", "StarSystem": "B"})
        self._signals("A 2", 4)          # событие помечено системой A
        self.assertEqual([row["body"] for row in self.tracker.system_bodies()], [])
        self.tracker.handle({"event": "FSDJump", "StarSystem": "A"})
        self.assertEqual([row["body"] for row in self.tracker.system_bodies()], ["A 2"])

    def test_flags(self):
        self._signals("A 1", 1)
        self.tracker.handle({"event": "SAAScanComplete", "BodyName": "A 1"})
        self.tracker.handle({"event": "ScanOrganic", "Body": "A 1",
                             "Species_Localised": "Tussock", "ScanType": "Sample"})
        row = self.tracker.system_bodies()[0]
        self.assertTrue(row["mapped"])
        self.assertTrue(row["has_organics"])
        self.assertTrue(row["landable"])


class EventDedupTests(unittest.TestCase):
    """2.10.14: повтор события из хвоста журнала не считается дважды.

    `_restore_station_state_from_journal` при каждом старте Watcher заново
    прогоняет хвост последних журналов через трекер — без дедупликации по
    timestamp каждый перезапуск добавлял бы лишний образец.
    """

    def _tracker(self):
        tracker = ExobiologyTracker()
        tracker.handle({"event": "FSDJump", "StarSystem": "Sol"})
        tracker.handle({"event": "ApproachBody", "StarSystem": "Sol",
                        "BodyName": "Sol 3"})
        return tracker

    def _sample(self, tracker, ts):
        tracker.handle({"event": "ScanOrganic", "timestamp": ts, "StarSystem": "Sol",
                        "Body": "Sol 3", "Species_Localised": "Tussock Poxtop",
                        "ScanType": "Sample"})

    def test_same_sample_event_counted_once(self):
        tracker = self._tracker()
        self._sample(tracker, "2026-09-14T10:00:00Z")
        self._sample(tracker, "2026-09-14T10:00:00Z")
        entry = tracker.organics[tracker._key("Sol", "Sol 3")]["Tussock Poxtop"]
        self.assertEqual(entry["samples"], 1)

    def test_distinct_timestamps_count_separately(self):
        tracker = self._tracker()
        self._sample(tracker, "2026-09-14T10:00:00Z")
        self._sample(tracker, "2026-09-14T10:01:00Z")
        entry = tracker.organics[tracker._key("Sol", "Sol 3")]["Tussock Poxtop"]
        self.assertEqual(entry["samples"], 2)

    def test_events_without_timestamp_are_not_deduped(self):
        tracker = self._tracker()
        self._sample(tracker, "")
        self._sample(tracker, "")
        entry = tracker.organics[tracker._key("Sol", "Sol 3")]["Tussock Poxtop"]
        self.assertEqual(entry["samples"], 2,
                         "без timestamp отличить повтор от нового образца нельзя")

    def test_codex_entry_dedup(self):
        tracker = self._tracker()
        event = {"event": "CodexEntry", "timestamp": "2026-09-14T10:00:00Z",
                 "Category": "$codex_categorytype_biology;",
                 "Name": "Tussock Poxtop", "Region": "Sol 3"}
        tracker.handle(event)
        tracker.handle(dict(event))
        self.assertEqual(tracker.seen_species["Tussock Poxtop"], 1)

    def test_system_body_count(self):
        tracker = self._tracker()
        tracker.handle({"event": "Scan", "timestamp": "2026-09-14T10:00:00Z",
                        "StarSystem": "Sol", "BodyName": "Sol 3",
                        "PlanetClass": "Rocky body"})
        self.assertEqual(tracker.system_body_count(), 1)
        tracker.handle({"event": "FSDJump", "StarSystem": "Alpha Centauri"})
        self.assertEqual(tracker.system_body_count(), 0,
                         "считаем только тела текущей системы")
