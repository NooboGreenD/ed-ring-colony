"""Выгрузка маршрута в CSV: выбор столбцов и то, что в них попадает.

Правила, за которые держат эти тесты:

* столбец «Система» есть в файле всегда: без него файл нечего выгружать;
* неотмеченный в окне набор означает прежний формат (четыре столбца), а не
  пустой файл — «Экспорт CSV» не должен внезапно отдавать пустоту;
* неизвестное значение — пустая строка, а не ноль: «тел 0» и «тел неизвестно»
  в таблице должны различаться;
* файл открывается Excel'ом как таблица (BOM, `;`, CRLF) и читается обратно:
  координаты и адрес системы возвращаются в маршрут.
"""
import csv
import io
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import route_export  # noqa: E402
import route_tracker  # noqa: E402


def system(name, **overrides):
    data = {"index": 0, "name": name, "status": "pending", "visited_at": None}
    data.update(overrides)
    return data


def hint(**overrides):
    data = {"known": True, "bodies": 12, "mapped": 4, "footfall": 1,
            "discoverer": "CMDR Orin Vex", "status": "building",
            "progress": 42.6, "remaining": 18240.4}
    data.update(overrides)
    return data


def parsed(text):
    """CSV как строки таблицы — без BOM, с нашим разделителем."""
    body = text.lstrip("\ufeff")
    return list(csv.reader(io.StringIO(body), delimiter=route_export.DELIMITER))


class ColumnChoiceTests(unittest.TestCase):
    def test_default_is_the_old_file_format(self):
        self.assertEqual(route_export.normalize_keys(None),
                         ["index", "system", "status", "visited_at"])
        self.assertEqual(route_export.normalize_keys([]),
                         ["index", "system", "status", "visited_at"])

    def test_system_column_is_always_there(self):
        for keys in (["bodies"], ["x"], ["system"], ["nosuchcolumn"]):
            self.assertIn("system", route_export.normalize_keys(keys), keys)

    def test_only_known_columns_and_fixed_order(self):
        chosen = route_export.normalize_keys(["remaining", "system", "x", "bogus"])
        self.assertEqual(chosen, ["system", "x", "remaining"],
                         "порядок столбцов в файле не зависит от окна")

    def test_duplicates_do_not_double_the_column(self):
        self.assertEqual(route_export.normalize_keys(["x", "x", "system"]),
                         ["system", "x"])

    def test_all_keys_are_the_fields_in_order(self):
        self.assertEqual(route_export.all_keys(),
                         [field.key for field in route_export.FIELDS])

    def test_hints_are_needed_only_for_site_columns(self):
        self.assertFalse(route_export.needs_hints(["index", "system", "x"]))
        self.assertTrue(route_export.needs_hints(["system", "bodies"]))
        self.assertTrue(route_export.needs_hints(["system", "discoverer"]))
        # Прежний формат сети не требует вовсе.
        self.assertFalse(route_export.needs_hints(None))

    def test_coordinates_are_needed_for_distances_too(self):
        self.assertTrue(route_export.needs_coordinates(["system", "x"]))
        self.assertTrue(route_export.needs_coordinates(["system", "jump_ly"]))
        self.assertFalse(route_export.needs_coordinates(["system", "status"]))

    def test_titles_are_translated(self):
        translator = lambda text: f"<{text}>"  # noqa: E731
        self.assertEqual(route_export.titles(["system", "bodies"], translator),
                         ["<Система>", "<Тел в системе>"])
        # Без переводчика — русские оригиналы.
        self.assertEqual(route_export.titles(["system"]), ["Система"])


class ValueTests(unittest.TestCase):
    def test_position_prefers_the_route_and_falls_back_to_the_hint(self):
        from_route = {"star_pos": [1.0, 2.0, 3.0]}
        self.assertEqual(route_export.position(from_route, {"coordinates": {"x": 9, "y": 9, "z": 9}}),
                         (1.0, 2.0, 3.0))
        self.assertEqual(route_export.position({}, {"coordinates": {"x": 1, "y": 2, "z": 3}}),
                         (1.0, 2.0, 3.0))
        self.assertEqual(route_export.position({"StarPos": [4, 5, 6]}), (4.0, 5.0, 6.0))

    def test_partial_or_broken_position_is_not_coordinates(self):
        for star_pos in ([1, 2], [1, float("nan"), 0], [None, 0, 0], "bad", None):
            self.assertIsNone(route_export.position({"star_pos": star_pos}), star_pos)

    def test_jump_distance_between_neighbours(self):
        self.assertEqual(route_export.jump_distance((0, 0, 0), (3, 4, 0)), 5.0)
        self.assertIsNone(route_export.jump_distance(None, (3, 4, 0)))

    def test_visited_time_is_formatted_like_the_table(self):
        self.assertEqual(route_export.format_visited("2026-10-31T22:14:05.123Z"),
                         "31.10.2026 22:14")
        self.assertEqual(route_export.format_visited(""), "")
        self.assertEqual(route_export.format_visited("вчера"), "вчера")

    def test_rows_keep_unknown_values_empty_not_zero(self):
        rows = route_export.build_rows(
            [system("Empty One")],
            ["index", "system", "bodies", "mapped", "discoverer", "progress", "x"],
        )
        self.assertEqual(rows, [["1", "Empty One", "", "", "", "", ""]])

    def test_rows_take_hint_values_and_localize_construction(self):
        rows = route_export.build_rows(
            [system("Built One")],
            ["system", "bodies", "mapped", "footfall", "discoverer", "construction", "progress", "remaining"],
            hints={"built one": hint()},
            translate=lambda text: f"<{text}>",
        )
        self.assertEqual(rows[0], ["Built One", "12", "4", "1", "CMDR Orin Vex",
                                   "<стройка идёт>", "43", "18240"])

    def test_rows_print_jump_distance_between_neighbours(self):
        rows = route_export.build_rows(
            [system("Sol", star_pos=[0, 0, 0]), system("Lave", star_pos=[3, 4, 0])],
            ["system", "x", "y", "z", "jump_ly"],
        )
        self.assertEqual(rows[1], ["Lave", "5.00", "3.000", "4.000", "0.000"])
        # У первой системы предыдущей нет — расстояние неизвестно, а не ноль.
        self.assertEqual(rows[0][1], "")

    def test_rows_count_distance_from_hint_coordinates(self):
        rows = route_export.build_rows(
            [system("A"), system("B")],
            ["system", "jump_ly"],
            hints={"a": {"coordinates": {"x": 0, "y": 0, "z": 0}},
                   "b": {"coordinates": {"x": 0, "y": 0, "z": 10}}},
        )
        self.assertEqual([row[-1] for row in rows], ["", "10.00"])

    def test_jump_is_blank_after_a_system_without_coordinates(self):
        """Пропуск в координатах не должен превращаться в «прыжок через одну»."""
        rows = route_export.build_rows(
            [system("A", star_pos=[0, 0, 0]), system("B"), system("C", star_pos=[0, 0, 30])],
            ["system", "jump_ly"],
        )
        self.assertEqual([row[-1] for row in rows], ["", "", ""])

    def test_status_text_is_translated_by_the_caller(self):
        statuses = {"visited": "посещена", "pending": "ожидает"}
        rows = route_export.build_rows(
            [system("A", status="visited"), system("B")],
            ["system", "status"],
            status_text=lambda value: statuses.get(value, value),
        )
        self.assertEqual([row[1] for row in rows], ["посещена", "ожидает"])

    def test_unknown_construction_status_is_empty(self):
        rows = route_export.build_rows([system("A")], ["system", "construction"],
                                       hints={"a": {"status": "unknown"}})
        self.assertEqual(rows[0][1], "")


class FileTests(unittest.TestCase):
    def test_file_opens_in_excel(self):
        text = route_export.build_csv([system("Sol")], ["index", "system"])
        self.assertTrue(text.startswith("\ufeff"), "без BOM Excel ломает кириллицу")
        self.assertIn("\r\n", text)
        self.assertEqual(parsed(text), [["#", "Система"], ["1", "Sol"]])

    def test_every_cell_is_quoted_so_separators_survive(self):
        text = route_export.build_csv([system("Sol; Lave, 2")], ["system"])
        self.assertIn('"Sol; Lave, 2"', text)
        self.assertEqual(parsed(text)[1], ["Sol; Lave, 2"])

    def test_row_count_skips_the_header(self):
        self.assertEqual(route_export.row_count(""), 0)
        text = route_export.build_csv([system("A"), system("B")], ["system"])
        self.assertEqual(route_export.row_count(text), 2)

    def test_empty_route_still_has_a_header(self):
        text = route_export.build_csv([], ["system", "bodies"])
        self.assertEqual(parsed(text), [["Система", "Тел в системе"]])


class RoundTripTests(unittest.TestCase):
    def setUp(self):
        self.tracker = route_tracker.RouteTracker()
        self.tracker.load_from_csv("system\nSol\nLave\n")

    def tearDown(self):
        import i18n
        i18n.set_locale("ru")

    def test_export_default_is_the_old_four_columns(self):
        rows = parsed(self.tracker.export_csv())
        self.assertEqual(rows[0], ["#", "Система", "Статус", "Посещена"])

    def test_export_then_import_keeps_names_coordinates_and_address(self):
        self.tracker.systems[0].update({"star_pos": [0, 0, 0], "system_address": 10477373803})
        self.tracker.systems[1].update({"star_pos": [3, 4, 0]})
        text = self.tracker.export_csv(["system", "x", "y", "z", "jump_ly", "system_address"])

        fresh = route_tracker.RouteTracker()
        fresh.load_from_csv(text)

        self.assertEqual([s["name"] for s in fresh.systems], ["Sol", "Lave"])
        self.assertEqual(fresh.systems[0]["star_pos"], [0.0, 0.0, 0.0])
        self.assertEqual(fresh.systems[1]["star_pos"], [3.0, 4.0, 0.0])
        self.assertEqual(fresh.systems[0]["system_address"], 10477373803)

    def test_export_then_import_works_in_another_language(self):
        """Заголовки в выгрузке переводятся — файл должен читаться обратно."""
        import i18n
        i18n.set_locale("de")
        self.tracker.systems[0]["star_pos"] = [1.5, -2.25, 300.125]
        text = self.tracker.export_csv(["system", "x", "y", "z"])

        fresh = route_tracker.RouteTracker()
        fresh.load_from_csv(text)

        self.assertEqual([s["name"] for s in fresh.systems], ["Sol", "Lave"])
        self.assertEqual(fresh.systems[0]["star_pos"], [1.5, -2.25, 300.125])

    def test_empty_coordinates_in_the_file_are_not_zero(self):
        text = self.tracker.export_csv(["system", "x", "y", "z"])
        fresh = route_tracker.RouteTracker()
        fresh.load_from_csv(text)
        self.assertNotIn("star_pos", fresh.systems[0])

    def test_own_export_is_not_mistaken_for_a_list_of_names(self):
        text = self.tracker.export_csv(["index", "system"])
        fresh = route_tracker.RouteTracker()
        fresh.load_from_csv(text)
        self.assertEqual([s["name"] for s in fresh.systems], ["Sol", "Lave"])


if __name__ == "__main__":
    unittest.main()
