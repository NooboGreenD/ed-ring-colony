"""Тесты «Путешествий»: разбор маршрута, позиция пилота и статистика пути.

Модуль `route_travel` — чистая логика без Qt и сети, поэтому здесь проверяется
ровно то, что увидит пилот: какие системы прочитались из вставленного текста,
где он сейчас, что уйдёт в буфер обмена и какие цифры попадут в статистику.

Отдельно держим главное правило проекта: **не выдумывать данные**. Нет
координат — нет расстояния; не было замеренных прыжков — нет оценки прибытия.
"""
import json
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import route_travel  # noqa: E402


NAVROUTE = {
    "Route": [
        {"StarSystem": "Sol", "StarPos": [0.0, 0.0, 0.0], "StarClass": "G"},
        {"StarSystem": "Alpha Centauri", "StarPos": [3.0, 0.0, 0.0]},
        {"StarSystem": "Wolf 359", "StarPos": [6.0, 0.0, 0.0], "StarClass": "M",
         "SystemAddress": 31075022},
    ]
}


def systems_with_status():
    return [
        {"index": 1, "name": "Sol", "status": "visited", "star_pos": [0.0, 0.0, 0.0]},
        {"index": 2, "name": "Alpha Centauri", "status": "pending",
         "star_pos": [3.0, 0.0, 0.0]},
        {"index": 3, "name": "Wolf 359", "status": "pending",
         "star_pos": [6.0, 0.0, 0.0], "star_class": "M"},
    ]


class ParseTests(unittest.TestCase):
    def test_navroute_from_the_game(self):
        parsed = route_travel.parse_route_text(json.dumps(NAVROUTE))
        self.assertEqual(parsed.format, "navroute")
        self.assertEqual([s["name"] for s in parsed.systems],
                         ["Sol", "Alpha Centauri", "Wolf 359"])
        self.assertEqual(parsed.systems[2]["star_class"], "M")
        self.assertEqual(parsed.systems[2]["system_address"], 31075022)
        self.assertEqual(parsed.systems[0]["star_pos"], [0.0, 0.0, 0.0])

    def test_json_list_and_duplicates(self):
        parsed = route_travel.parse_route_text('["Sol", "Sol", {"name": "Wolf 359"}]')
        self.assertEqual(parsed.format, "json")
        self.assertEqual([s["name"] for s in parsed.systems], ["Sol", "Wolf 359"])

    def test_plain_list_accepts_numbers_arrows_and_commas(self):
        text = ("1. Sol\n2) Alpha Centauri\nSol → Wolf 359\n# LHS 3447\n"
                "Shinrarta Dezhra, Deciat\n")
        parsed = route_travel.parse_route_text(text)
        self.assertEqual(parsed.format, "list")
        self.assertEqual([s["name"] for s in parsed.systems],
                         ["Sol", "Alpha Centauri", "Wolf 359", "LHS 3447",
                          "Shinrarta Dezhra", "Deciat"])

    def test_header_line_is_not_a_system(self):
        parsed = route_travel.parse_route_text("Система\nSol\nWolf 359")
        self.assertEqual([s["name"] for s in parsed.systems], ["Sol", "Wolf 359"])

    def test_csv_keeps_the_raw_text_for_the_tracker(self):
        csv = "Система;Статус;X, св. л.\nSol;Посещена;0\nWolf 359;Ожидает;-1.8\n"
        parsed = route_travel.parse_route_text(csv)
        # CSV разбирает RouteTracker.load_from_csv: у него свои правила чтения
        # собственной выгрузки (заголовки на языке интерфейса, адрес, координаты).
        self.assertEqual(parsed.format, "csv")
        self.assertIn("Wolf 359", parsed.raw)

    def test_empty_text_is_not_an_error(self):
        for value in ("", "   ", None):
            parsed = route_travel.parse_route_text(value)
            self.assertEqual(parsed.format, "empty")
            self.assertFalse(parsed.ok)
            self.assertEqual(parsed.error, "")

    def test_foreign_json_is_reported_not_misparsed(self):
        parsed = route_travel.parse_route_text('{"a": 1}')
        self.assertEqual(parsed.format, "json")
        self.assertIn("нет списка систем", parsed.error)
        self.assertEqual(parsed.systems, [])

    def test_broken_json_is_reported(self):
        parsed = route_travel.parse_route_text('{"Route": [')
        self.assertIn("не JSON", parsed.error)

    def test_text_without_systems_is_reported(self):
        parsed = route_travel.parse_route_text("1.\n2.\n#\n")
        self.assertIn("не нашлось ни одной системы", parsed.error)

    def test_clean_name_strips_markers_and_quotes(self):
        self.assertEqual(route_travel.clean_name("  «Sol»  "), "Sol")
        self.assertEqual(route_travel.clean_name("3) Wolf 359."), "Wolf 359")
        self.assertEqual(route_travel.clean_name("# LHS 3447"), "LHS 3447")
        self.assertEqual(route_travel.clean_name(""), "")


class DistanceTests(unittest.TestCase):
    def test_distances_use_coordinates(self):
        result = route_travel.route_distances(systems_with_status(), 1)
        self.assertAlmostEqual(result["distance_done"], 3.0)
        self.assertAlmostEqual(result["distance_left"], 3.0)
        self.assertAlmostEqual(result["distance_total"], 6.0)

    def test_unknown_coordinates_are_dash_not_zero(self):
        systems = [{"name": "Sol"}, {"name": "Wolf 359"}]
        result = route_travel.route_distances(systems, 0)
        self.assertIsNone(result["distance_done"])
        self.assertIsNone(result["distance_left"])
        self.assertIsNone(result["distance_total"])

    def test_one_missing_leg_does_not_invent_the_rest(self):
        systems = [
            {"name": "A", "star_pos": [0.0, 0.0, 0.0]},
            {"name": "B"},
            {"name": "C", "star_pos": [4.0, 0.0, 0.0]},
        ]
        result = route_travel.route_distances(systems, 1)
        self.assertIsNone(result["distance_left"], "дырка в координатах — прочерк")


class SessionTests(unittest.TestCase):
    def test_repeated_system_is_not_a_jump(self):
        session = route_travel.TravelSession()
        self.assertTrue(session.record("Sol", at=100.0))
        self.assertFalse(session.record("sol", at=130.0))
        self.assertEqual(len(session.jumps), 1)

    def test_tempo_needs_two_jumps(self):
        session = route_travel.TravelSession()
        session.record("Sol", at=100.0)
        self.assertIsNone(session.tempo(now=200.0))
        session.record("Wolf 359", at=160.0, distance=4.2)
        self.assertAlmostEqual(session.tempo(now=200.0), 60.0)
        self.assertAlmostEqual(session.measured_distance(), 4.2)

    def test_restart_and_reset(self):
        session = route_travel.TravelSession()
        session.record("Sol", at=100.0)
        session.restart(at=500.0)
        self.assertEqual(session.jumps, [])
        self.assertAlmostEqual(session.elapsed(now=560.0), 60.0)
        session.reset()
        self.assertIsNone(session.elapsed(now=560.0))


class TravelStateTests(unittest.TestCase):
    def _state(self, **kwargs):
        defaults = dict(systems=systems_with_status(), current="Alpha Centauri",
                        follow=True, now=1600.0)
        defaults.update(kwargs)
        return route_travel.travel_state(translate=lambda text: text, **defaults)

    def test_position_progress_and_next(self):
        state = self._state()
        self.assertTrue(state["loaded"])
        self.assertEqual(state["next"], "Wolf 359")
        self.assertEqual(state["position"], 1)
        self.assertAlmostEqual(state["progress"], 200.0 / 3.0)
        self.assertIn("Wolf 359", state["status"])
        self.assertEqual(state["stats"]["current"], "Alpha Centauri")

    def test_off_route_keeps_the_route_and_says_so(self):
        state = self._state(current="Shinrarta Dezhra")
        self.assertEqual(state["position"], -1)
        self.assertIn("вне маршрута", state["status"])
        # Первая НЕПРОЙДЕННАЯ система — не «Sol»: он отмечен посещённым.
        self.assertEqual(state["next"], "Alpha Centauri")
        self.assertIn("Alpha Centauri", state["note"])

    def test_without_jumps_there_is_no_eta(self):
        state = self._state()
        self.assertEqual(state["stats"]["eta"], route_travel.DASH)
        self.assertEqual(state["stats"]["tempo"], route_travel.DASH)

    def test_eta_uses_measured_tempo(self):
        session = route_travel.TravelSession()
        session.record("Sol", at=1000.0)
        session.record("Alpha Centauri", at=1300.0)
        # Один прыжок впереди (Wolf 359), темп — 300 с на прыжок.
        state = self._state(session=session, now=1600.0)
        # 300 с на прыжок и один прыжок впереди → прибытие около 1600 + 300.
        self.assertIn("около", state["stats"]["eta"])
        self.assertNotEqual(state["stats"]["eta"], route_travel.DASH)

    def test_hint_fills_the_info_block(self):
        state = self._state(hint={"system": "Wolf 359", "known": True, "bodies": 12,
                                  "discoverer": "Someone", "status": "building",
                                  "progress": 42, "remaining": 1200,
                                  "star_class": "M", "scoopable": True})
        self.assertIn("12", state["info"]["bodies"])
        self.assertEqual(state["info"]["discoverer"], "Someone")
        self.assertIn("42", state["info"]["construction"])
        self.assertIn("заправка есть", state["info"]["star"])

    def test_unknown_construction_is_a_dash(self):
        state = self._state(hint={"system": "Wolf 359", "known": False})
        self.assertEqual(state["info"]["construction"], "системы нет в базе проекта")
        self.assertEqual(state["info"]["discoverer"], route_travel.DASH)
        self.assertEqual(state["info"]["bodies"], route_travel.DASH)

    def test_finished_route(self):
        systems = systems_with_status()
        state = self._state(systems=systems, current="Wolf 359")
        self.assertEqual(state["next"], "")
        self.assertEqual(state["stats"]["jumps_left"], "0")
        self.assertIn("пройден", state["status"])
        self.assertAlmostEqual(state["progress"], 100.0, places=1)

    def test_empty_route(self):
        state = self._state(systems=[])
        self.assertFalse(state["loaded"])
        self.assertEqual(state["upcoming"], [])
        self.assertEqual(state["stats"]["next"], route_travel.DASH)

    def test_upcoming_list_is_limited_and_numbered(self):
        systems = [{"name": f"System {index:02d}"} for index in range(1, 11)]
        state = self._state(systems=systems, current="System 01", upcoming_limit=4)
        self.assertEqual(len(state["upcoming"]), 4)
        self.assertEqual(state["upcoming"][0][0], 1)
        self.assertEqual(state["upcoming"][0][1], "System 02")
        self.assertIn("Показаны первые 4", state["note"])

    def test_upcoming_legs(self):
        state = self._state(current="Sol")
        rows = state["upcoming"]
        # От Sol до Wolf 359 — два плеча по 3 св. л. (через Alpha Centauri).
        self.assertEqual([row[1] for row in rows], ["Alpha Centauri", "Wolf 359"])
        self.assertIn("3.0", rows[0][2])
        self.assertIn("3.0", rows[1][2])


class FormatTests(unittest.TestCase):
    def test_durations(self):
        self.assertEqual(route_travel.format_duration(35), "35 с")
        self.assertEqual(route_travel.format_duration(124), "2 мин")
        self.assertEqual(route_travel.format_duration(8040), "2 ч 14 мин")
        self.assertEqual(route_travel.format_duration(None), route_travel.DASH)

    def test_light_years_need_a_value(self):
        self.assertEqual(route_travel.format_light_years(4.25), "4.2 св. л.")
        self.assertEqual(route_travel.format_light_years(None), route_travel.DASH)

    def test_clock_is_local_and_labelled(self):
        moment = time.mktime((2026, 11, 17, 21, 34, 0, 0, 0, -1))
        self.assertRegex(route_travel.format_clock(moment), r"^около \d{2}:\d{2}$")
        self.assertEqual(route_travel.format_clock(None), route_travel.DASH)

    def test_format_titles(self):
        self.assertIn("NavRoute", route_travel.route_format_title("navroute"))
        self.assertEqual(route_travel.route_format_title("нет-такого"),
                         "неизвестный формат")

    def test_follow_status_text(self):
        self.assertIn("включено", route_travel.follow_status_text(True, [{"name": "Sol"}]))
        self.assertIn("маршрута нет", route_travel.follow_status_text(True, []))


class HelpersTests(unittest.TestCase):
    def test_find_system_ignores_case_and_spaces(self):
        systems = systems_with_status()
        self.assertEqual(route_travel.find_system(systems, "  alpha centauri "), 1)
        self.assertEqual(route_travel.find_system(systems, ""), -1)
        self.assertEqual(route_travel.find_system(systems, "Нет такой"), -1)

    def test_next_system_skips_visited(self):
        systems = systems_with_status()
        systems[1]["status"] = "visited"
        self.assertEqual(route_travel.next_system_name(systems, "Sol"), "Wolf 359")

    def test_pending_from_keeps_order(self):
        systems = systems_with_status()
        self.assertEqual([s["name"] for s in route_travel.pending_from(systems, 0)],
                         ["Alpha Centauri", "Wolf 359"])


if __name__ == "__main__":
    unittest.main()
