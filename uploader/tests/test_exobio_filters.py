"""Тесты фильтров оверлея EXOBIO: роды и поиск планет по параметрам.

Задача пользователя: «вкладка для настройки фильтров оверлея Exobio, фильтр по
определённым образцам и поиск планет с параметрами — при нахождении такой
планеты в системе выводить информацию в оверлей (например планета каменистая с
атмосферой и посадкой, ледяная с посадкой и т.д.)».
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from exobiology import (  # noqa: E402
    PLANET_PRESETS_BY_ID,
    PLANET_SEARCH_PRESETS,
    ExobiologyTracker,
    body_matches,
    filter_predictions,
    search_planets,
)
from test_exobiology import scan_event  # noqa: E402


class BodyMatchesTests(unittest.TestCase):
    """Один набор критериев против одного тела."""

    def test_rocky_with_atmosphere_and_landing(self):
        criteria = PLANET_PRESETS_BY_ID["rocky_atmo_land"]
        self.assertTrue(body_matches({
            "planet_class": "Rocky body", "landable": True,
            "atmosphere": "thin sulfur dioxide atmosphere",
        }, criteria))

    def test_same_preset_rejects_gas_giant(self):
        criteria = PLANET_PRESETS_BY_ID["rocky_atmo_land"]
        self.assertFalse(body_matches({
            "planet_class": "Gas giant", "landable": False,
            "atmosphere": "thick", "atmosphere_type": "None",
        }, criteria))

    def test_icy_with_landing(self):
        criteria = PLANET_PRESETS_BY_ID["icy_land"]
        self.assertTrue(body_matches(
            {"planet_class": "Icy body", "landable": True, "atmosphere_type": "None"},
            criteria))
        # Без посадки — уже не подходит.
        self.assertFalse(body_matches(
            {"planet_class": "Icy body", "landable": False, "atmosphere_type": "None"},
            criteria))

    def test_atmosphere_none_is_strict(self):
        criteria = PLANET_PRESETS_BY_ID["rocky_land_noatmo"]
        self.assertTrue(body_matches(
            {"planet_class": "Rocky body", "landable": True, "atmosphere_type": "None"},
            criteria))
        self.assertFalse(body_matches(
            {"planet_class": "Rocky body", "landable": True,
             "atmosphere": "thin sulfur dioxide atmosphere"}, criteria))

    def test_unknown_atmosphere_is_not_counted_as_present(self):
        """Нет данных об атмосфере — утверждать «с атмосферой» нельзя."""
        criteria = PLANET_PRESETS_BY_ID["rocky_atmo_land"]
        self.assertFalse(body_matches(
            {"planet_class": "Rocky body", "landable": True}, criteria))

    def test_volcanism_preset(self):
        criteria = PLANET_PRESETS_BY_ID["volcanic_land"]
        self.assertTrue(body_matches(
            {"planet_class": "Rocky body", "landable": True,
             "volcanism": "minor silicate vapour geysers"}, criteria))
        self.assertFalse(body_matches(
            {"planet_class": "Rocky body", "landable": True, "volcanism": ""}, criteria))
        self.assertFalse(body_matches(
            {"planet_class": "Rocky body", "landable": True,
             "volcanism": "no volcanism"}, criteria))

    def test_min_signals_preset(self):
        criteria = PLANET_PRESETS_BY_ID["bio_signals"]
        self.assertTrue(body_matches({"planet_class": "Icy body", "bio_signals": 4}, criteria))
        self.assertFalse(body_matches({"planet_class": "Icy body", "bio_signals": 0}, criteria))

    def test_any_landable_ignores_class(self):
        criteria = PLANET_PRESETS_BY_ID["any_landable"]
        for planet_class in ("Rocky body", "Icy body", "Ammonia world", "Earthlike body"):
            self.assertTrue(body_matches(
                {"planet_class": planet_class, "landable": True}, criteria), planet_class)

    def test_garbage_input_does_not_raise(self):
        criteria = PLANET_PRESETS_BY_ID["icy_land"]
        self.assertFalse(body_matches(None, criteria))
        self.assertFalse(body_matches({"planet_class": "Icy body"}, None))
        self.assertFalse(body_matches("не словарь", criteria))

    def test_unknown_preset_id_is_absent(self):
        self.assertNotIn("несуществующий", PLANET_PRESETS_BY_ID)
        self.assertTrue(all(str(row.get("id")) in PLANET_PRESETS_BY_ID
                            for row in PLANET_SEARCH_PRESETS))


class SearchPlanetsTests(unittest.TestCase):
    """Поиск по списку тел: сортировка и причины совпадения."""

    BODIES = [
        {"name": "HIP 12345 A 1", "planet_class": "Icy body", "landable": True,
         "atmosphere_type": "None", "bio_signals": 0, "distance_ls": 900.0},
        {"name": "HIP 12345 A 3", "planet_class": "Rocky body", "landable": True,
         "atmosphere": "thin sulfur dioxide atmosphere", "bio_signals": 5,
         "distance_ls": 812.0},
        {"name": "HIP 12345 A 5", "planet_class": "Gas giant", "landable": False,
         "atmosphere": "thick", "bio_signals": 0, "distance_ls": 10.0},
    ]

    def test_finds_matching_and_excludes_others(self):
        rows = search_planets(self.BODIES, [PLANET_PRESETS_BY_ID["rocky_atmo_land"]])
        self.assertEqual([row["body"] for row in rows], ["HIP 12345 A 3"])

    def test_bodies_with_signals_come_first(self):
        rows = search_planets(self.BODIES, [PLANET_PRESETS_BY_ID["any_landable"]])
        self.assertEqual([row["body"] for row in rows],
                         ["HIP 12345 A 3", "HIP 12345 A 1"])

    def test_matched_labels_explain_the_hit(self):
        rows = search_planets(self.BODIES, [PLANET_PRESETS_BY_ID["icy_land"]])
        self.assertEqual(rows[0]["matched"], ["Ледяная с посадкой"])

    def test_several_presets_union(self):
        rows = search_planets(self.BODIES, [
            PLANET_PRESETS_BY_ID["rocky_atmo_land"],
            PLANET_PRESETS_BY_ID["icy_land"],
        ])
        self.assertEqual(len(rows), 2)

    def test_empty_criteria_returns_nothing(self):
        self.assertEqual(search_planets(self.BODIES, []), [])
        self.assertEqual(search_planets(self.BODIES, None), [])

    def test_limit_is_respected(self):
        rows = search_planets(self.BODIES, [PLANET_PRESETS_BY_ID["any_landable"]], limit=1)
        self.assertEqual(len(rows), 1)


class FilterPredictionsTests(unittest.TestCase):
    ROWS = [{"genus": "Osseus"}, {"genus": "Bacterium"}, {"genus": "Tussock"}]

    def test_empty_filter_keeps_everything(self):
        self.assertEqual(filter_predictions(self.ROWS, []), self.ROWS)
        self.assertEqual(filter_predictions(self.ROWS, None), self.ROWS)

    def test_filter_keeps_only_selected(self):
        self.assertEqual(filter_predictions(self.ROWS, ["Osseus"]), [{"genus": "Osseus"}])

    def test_blank_entries_are_ignored(self):
        self.assertEqual(filter_predictions(self.ROWS, ["  ", ""]), self.ROWS)


class TrackerPlanetSearchTests(unittest.TestCase):
    """Поиск идёт по текущей системе и не трогает чужие."""

    def setUp(self):
        self.tracker = ExobiologyTracker()
        self.tracker.handle(scan_event())
        self.tracker.handle(scan_event(
            BodyName="HIP 12345 A 1", BodyID=10, PlanetClass="Icy body",
            Atmosphere="", AtmosphereType="None", AtmosphereComposition=[],
            DistanceFromArrivalLS=900.0))
        self.tracker.handle(scan_event(
            StarSystem="Другая система", BodyName="Другая система A 2", BodyID=20,
            PlanetClass="Icy body", Atmosphere="", AtmosphereType="None"))
        # Текущая система — та, где были последние события.
        self.tracker.handle({"event": "FSDJump", "StarSystem": "HIP 12345"})

    def test_searches_only_current_system(self):
        rows = self.tracker.search_system_planets([PLANET_PRESETS_BY_ID["icy_land"]])
        self.assertEqual([row["body"] for row in rows], ["HIP 12345 A 1"])

    def test_no_criteria_no_search(self):
        self.assertEqual(self.tracker.search_system_planets([]), [])

    def test_rocky_with_atmosphere_found(self):
        rows = self.tracker.search_system_planets([PLANET_PRESETS_BY_ID["rocky_atmo_land"]])
        self.assertEqual([row["body"] for row in rows], ["HIP 12345 A 3"])
        self.assertTrue(rows[0]["landable"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
