"""Компактный SHIP-HUD: только проверенные числа и одна строка на показатель.

Правила, за которые держат эти тесты:

* то, чего журнал не отдаёт (процент щитов, прочность целых модулей после
  снимка), не выдумывается — строка без шкалы и с честной подписью;
* источник и свежесть значения видны в HUD: «снимок 7м», «RepairDrone»;
* список модулей в компактном режиме умещается в лимит строк, а всё остальное
  сворачивается в «ещё N»;
* оверлей и тесты печатают один и тот же текст: Tk-код берёт строки из
  `hud_rows`, поэтому расхождение «в тестах зелено, на экране врёт» невозможно.
"""

import calendar
import sys
import unittest
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import ship_hud as hud  # noqa: E402
import ship_tracker as st  # noqa: E402
from test_ship_tracker_status import LOADOUT  # noqa: E402


def utc_hour(hour, minute=0):
    """Epoch для штампа журнала: игра пишет времена в UTC."""
    return calendar.timegm(datetime(2026, 9, 17, hour, minute, 0).timetuple())


NOW = utc_hour(12, 23)   # «снимок» в Loadout — 12:00, значит 23 минуты назад


def state_of(*events, settings=None):
    tracker = st.ShipTracker()
    tracker.parse_event(dict(LOADOUT))
    for event in events:
        # Событие без «event» считаем строкой Status.json: файл состояния —
        # тот же набор полей, и HUD обязан реагировать одинаково.
        if "event" in event:
            tracker.parse_event(event)
        else:
            tracker.parse_status_json(event)
    return tracker.get_state_dict()


def build(*events, settings=None, now=NOW):
    return hud.build_ship_hud(state_of(*events), settings=settings or {}, now=now)


class NothingIsInventedTests(unittest.TestCase):

    def test_shields_have_no_percentage_bar(self):
        """Процента щитов в журнале нет — шкалу не рисуем, только состояние."""
        h = build(settings={}, now=0)
        line = next(row for row in h["lines"] if row["label"] == "ЩИТЫ")
        self.assertIsNone(line["percent"])
        self.assertIn(line["value"], ("нет данных", "вверху", "упали", "нет генератора"))
        text = hud.render_hud_text(h)
        shields_line = [row for row in text.splitlines() if row.startswith("ЩИТЫ")][0]
        self.assertNotIn("▓", shields_line)
        self.assertNotIn("░", shields_line)

    def test_missing_hull_is_shown_as_no_data(self):
        h = hud.build_ship_hud({"ship_type": "typex_1", "shield_state": "up"},
                               settings={}, now=0)
        line = next(row for row in h["lines"] if row["label"] == "КОРПУС")
        self.assertEqual(line["value"], "нет данных")
        self.assertIsNone(line["percent"])

    def test_power_without_reactor_data_has_no_bar(self):
        h = hud.build_ship_hud({"ship_type": "typex_1", "power_used": 2.0,
                                "power_capacity": 0.0}, settings={}, now=0)
        line = next(row for row in h["lines"] if row["label"] == "ЭНЕРГИЯ")
        self.assertIsNone(line["percent"], "мощность реактора неизвестна — шкалы нет")
        self.assertIn("2.00 MW", line["value"])

    def test_snapshot_freshness_and_source_are_visible(self):
        h = build({"timestamp": "2026-09-17T12:20:00Z", "event": "HullDamage",
                   "Health": 0.62, "PlayerPilot": True},
                  now=NOW)  # 12:23:00Z
        hull = next(row for row in h["lines"] if row["label"] == "КОРПУС")
        self.assertEqual(hull["value"], "62%")
        self.assertIn("попадание", hull["hint"], "источник значения должен быть назван")
        self.assertNotIn("HullDamage", hud.render_hud_text(h), "имена событий в HUD не нужны")
        self.assertIn("3м", hull["hint"])
        head = h["modules"]["header"]
        self.assertIn("снимок 23м", head, "возраст снимка прочности модулей обязан быть виден")
        printed = [row for row in hud.hud_rows(h) if row["text"].startswith("КОРПУС")][0]["text"]
        self.assertIn("попадание", printed,
                      "сжатие строки не имеет права съедать источник и возраст значения")
        self.assertIn("3м", printed)

    def test_ammo_is_marked_uncertain_after_purchase(self):
        h = build({"timestamp": "2026-09-17T12:05:00Z", "event": "BuyAmmo", "Total": 41162},
                  now=NOW)
        text = hud.render_hud_text(h)
        self.assertIn("БОЕЗАПАС 1200?", text,
                      "точное число после покупки неизвестно —HUD честно ставит «?»")


class CompactnessTests(unittest.TestCase):

    def test_important_mode_keeps_the_block_short(self):
        h = build(settings={}, now=NOW)
        rows = hud.hud_rows(h)
        self.assertLessEqual(len(rows), 12, "компактный HUD — не простыня")
        budget = hud.line_budget({})
        for row in rows:
            self.assertLessEqual(len(row["text"]), budget,
                                 f"строка не влезает в блок и перенесётся: {row['text']}")

    def test_only_damaged_off_and_key_systems_are_listed(self):
        modules = [
            {"slot": "FrameShiftDrive", "name": "int_hyperdrive_size3_class5",
             "health": 0.44, "on": True, "power": 0.4, "priority": 1},
            {"slot": "Slot05_Size2", "name": "int_cargorack_size2_class1",
             "health": 1.0, "on": False, "power": 0.0, "priority": 1},
            {"slot": "Slot06_Size2", "name": "int_cargorack_size2_class1",
             "health": 1.0, "on": True, "power": 0.0, "priority": 1},
            {"slot": "PowerPlant", "name": "int_powerplant_size4_class2",
             "health": 1.0, "on": True, "power": 0.0, "priority": 1},
        ]
        rows, hidden = hud.module_rows(modules, mode="important")
        listed = [(row["slot"], row["name"], row["percent"]) for row in rows]
        self.assertEqual(listed, [
            ("", "ФСД", 44),                    # повреждённый — всегда первым
            ("05/S2", "ГРУЗ. СЕКЦИЯ", 100),     # выключенный — тоже важен
            ("", "РЕАКТОР", 100),               # ключевая система — даже целая
        ], "целая грузовая стойка в список важных не попадает")
        self.assertEqual(hidden, 0)

    def test_damaged_sort_first_and_lowest(self):
        modules = [
            {"slot": "Slot01_Size2", "name": "int_a", "health": 100, "on": True},
            {"slot": "Slot02_Size2", "name": "int_b", "health": 70, "on": True},
            {"slot": "Slot03_Size2", "name": "int_c", "health": 20, "on": True},
        ]
        rows, hidden = hud.module_rows(modules, mode="important", limit=2)
        self.assertEqual([row["percent"] for row in rows], [20, 70])
        self.assertEqual(hidden, 0, "целые модули в компактном режиме не считаются скрытыми")

    def test_row_limit_is_respected(self):
        modules = [{"slot": f"Slot{i:02d}_Size2", "name": f"int_cargorack_size2_class1",
                    "health": max(10, 90 - i), "on": True} for i in range(1, 20)]
        rows, hidden = hud.module_rows(modules, mode="important", limit=hud.MAX_MODULE_ROWS)
        self.assertEqual(len(rows), hud.MAX_MODULE_ROWS)
        self.assertEqual(hidden, len(modules) - hud.MAX_MODULE_ROWS)
        text = hud.render_hud_text(hud.build_ship_hud(
            {"modules": modules, "hull_percent": 100, "shield_state": "up"}, settings={}, now=0))
        self.assertIn(f"ещё {hidden}", text)

    def test_modules_off_mode_hides_the_list_but_keeps_the_warning(self):
        h = build(settings={"ship_modules_view": "off"}, now=NOW)
        self.assertEqual(h["modules"]["rows"], [])
        self.assertIn("повр 1", h["modules"]["header"],
                      "список скрыт, но повреждённый ФСД обязан остаться заметным")

    def test_all_mode_lists_everything(self):
        h = build(settings={"ship_modules_view": "all"}, now=NOW)
        self.assertEqual(len(h["modules"]["rows"]), len(LOADOUT["Modules"]))

    def test_legacy_show_modules_false_wins_over_mode(self):
        h = build(settings={"ship_modules_view": "all", "show_modules": False},
                  now=NOW)
        self.assertEqual(h["modules"]["rows"], [])
        self.assertEqual(h["modules"]["mode"], "off")


class StatusChipsTests(unittest.TestCase):

    def test_chips_are_ordered_by_severity(self):
        state = {"hull_percent": 100, "shield_state": "up",
                 "flags_list": ["Docked", "Danger", "Overheat", "Interdicted", "MainShip"]}
        h = hud.build_ship_hud(state, settings={}, now=0)
        texts = [chip["text"] for chip in h["chips"]]
        self.assertEqual(texts[:3], ["ОПАСНОСТЬ", "ПЕРЕХВАТ", "ПЕРЕГРЕВ"])
        self.assertNotIn("MainShip", " ".join(texts), "постоянно включённый флаг места стоит")

    def test_overheat_is_not_duplicated(self):
        state = {"hull_percent": 100, "shield_state": "up", "overheat": True,
                 "flags_list": ["Overheat"]}
        h = hud.build_ship_hud(state, settings={}, now=0)
        self.assertEqual([chip["text"] for chip in h["chips"]].count("ПЕРЕГРЕВ"), 1)

    def test_extra_state_flags(self):
        state = {"hull_percent": 100, "shield_state": "down", "canopy_breached": True,
                 "systems_offline": True, "flags_list": []}
        h = hud.build_ship_hud(state, settings={}, now=0)
        texts = " ".join(chip["text"] for chip in h["chips"])
        self.assertIn("КАБИНА ПРОБИТА", texts)
        self.assertIn("СИСТЕМЫ ВЫКЛ", texts)
        text = hud.render_hud_text(h)
        self.assertIn("упали", text)

    def test_wanted_status_and_destination(self):
        h = build({"timestamp": "2026-09-17T12:10:00Z", "LegalState": "Wanted",
                   "Balance": 123456, "Pips": [4, 4, 0],
                   "Destination": {"Name": "HIP 1234 A 3"}},
                  now=NOW)
        text = hud.render_hud_text(h)
        self.assertIn("WANTED", text)
        self.assertIn("HIP 1234 A 3", text)
        self.assertIn("123 456 CR", text)


class SectionsFollowSettingsTests(unittest.TestCase):

    def test_disabled_sections_disappear(self):
        state = {"timestamp": "2026-09-17T12:10:00Z", "Destination": {"Name": "HIP 1 A"}}
        full = hud.render_hud_text(build(state, settings={}, now=NOW))
        lean = hud.render_hud_text(build(state, settings={
            "show_flags": False, "show_hull": False, "show_shield": False,
            "show_power": False, "show_fuel": False, "show_cargo_info": False,
            "show_balance": False, "show_legal": False, "show_destination": False,
            "show_modules": False, "show_pips": False,
        }, now=NOW))
        for marker in ("КОРПУС", "ЩИТЫ", "ЭНЕРГИЯ", "ТОПЛИВО", "ГРУЗ", "КУДА", "МОДУЛИ"):
            self.assertIn(marker, full)
            self.assertNotIn(marker, lean)
        self.assertLess(len(lean.splitlines()), len(full.splitlines()))
        self.assertNotIn("МОДУЛИ", lean, "снятая галочка «Модули» убирает и итог")

    def test_modules_mode_off_keeps_the_damage_summary(self):
        text = hud.render_hud_text(build(settings={"ship_modules_view": "off"},
                                          now=NOW))
        self.assertIn("МОДУЛИ · 6 мод. · повр 1", text)
        clean = {"modules": [{"slot": "PowerPlant", "name": "int_powerplant_size4_class2",
                              "health": 100, "on": True}], "hull_percent": 100}
        h = hud.build_ship_hud(clean, settings={"ship_modules_view": "off"}, now=0)
        self.assertEqual(h["modules"]["header"], "", "без повреждений молчим")

    def test_pips_move_into_the_power_line(self):
        pips = {"timestamp": "2026-09-17T12:10:00Z", "Pips": [4, 4, 0]}
        with_pips = hud.render_hud_text(build(pips, settings={"show_pips": True},
                                              now=NOW))
        without = hud.render_hud_text(build(pips, settings={"show_pips": False},
                                            now=NOW))
        self.assertIn("SYS4·ENG4·WEP0", with_pips)
        self.assertNotIn("SYS4", without)


class RenderingParityTests(unittest.TestCase):

    def test_text_dump_equals_rows_plus_header(self):
        h = build({"timestamp": "2026-09-17T12:20:00Z", "event": "HullDamage",
                   "Health": 0.5}, now=NOW)
        rendered = hud.render_hud_text(h).splitlines()
        head = [h["title"]]
        if h["chips"]:
            head.append(" ".join(f"[{chip['text']}]" for chip in h["chips"]))
        body = [row["text"] for row in hud.hud_rows(h)]
        self.assertEqual(rendered, head + body,
                         "дамп = заголовок + чипы + строки оверлея, ничего лишнего")
        self.assertTrue(all(line for line in rendered), "пустых строк в HUD быть не должно")

    def test_module_line_content(self):
        line = hud.modules_table_line({"slot": "3/S3", "name": "ЩИТ", "percent": 70,
                                       "on": True, "priority": 1, "ammo": None,
                                       "suspect": False})
        self.assertIn("ЩИТ", line)
        self.assertIn("70%", line)
        self.assertTrue(line.startswith("*"), "повреждённый модуль помечен звёздочкой")
        critical = hud.modules_table_line({"slot": "", "name": "ЩИТ", "percent": 30,
                                           "on": False, "priority": 0, "ammo": "12",
                                           "suspect": True})
        self.assertTrue(critical.startswith("?"))
        self.assertIn("ВЫКЛ", critical)
        self.assertIn("ЗАП 12", critical)

    def test_slot_label_collapses_named_slots(self):
        self.assertEqual(hud.slot_label("Slot04_Size2"), "04/S2")
        self.assertEqual(hud.slot_label("FrameShiftDrive"), "",
                         "именованный слот дублирует имя модуля — метку убираем")
        self.assertEqual(hud.slot_label("Tiny01"), "T01")
        self.assertEqual(hud.short_name("int_shieldgenerator_size3_class2"), "ЩИТ")
        self.assertEqual(hud.short_name("$int_hyperdrive_size3_class5_name;"), "ФСД")

    def test_bar_fits_the_budget(self):
        """На 240 px и 12 pt шкала обязана ужаться, иначе строка переносится."""
        state = {"ship_type": "typex_1", "hull_percent": 67, "shield_state": "up",
                 "fuel_level": 20.0, "fuel_capacity": 32.0, "fuel_percent": 62,
                 "cargo_count": 0, "cargo_capacity": 0}
        wide = hud.build_ship_hud(state, settings={}, now=utc_hour(12, 0))
        narrow = hud.build_ship_hud(state, settings={"ship_width": 240, "font_size": 12},
                                    now=utc_hour(12, 0))
        budget = narrow["max_chars"]
        self.assertLess(budget, wide["max_chars"])
        hull = next(r for r in hud.hud_rows(narrow) if r["text"].startswith("КОРПУС"))
        self.assertLessEqual(len(hull["text"]), budget)
        self.assertLess(hull["text"].count("▓") + hull["text"].count("░"),
                        wide["lines"][0]["bar_width"])
        for row in hud.hud_rows(narrow):
            self.assertLessEqual(len(row["text"]), budget, row["text"])

    def test_bar_and_age_helpers(self):
        self.assertEqual(hud.bar(100, 10), "▓" * 10)
        self.assertEqual(hud.bar(0, 10), "░" * 10)
        self.assertEqual(hud.bar(None, 10), "")
        import calendar
        import datetime
        base = calendar.timegm(datetime.datetime(2026, 9, 17, 12, 0, 0).timetuple())
        self.assertEqual(hud.age_text("2026-09-17T12:00:00Z", base + 5), "сейчас")
        self.assertEqual(hud.age_text("2026-09-17T12:00:00Z", base + 42), "42с")
        self.assertEqual(hud.age_text("2026-09-17T12:00:00Z", base + 420), "7м")
        self.assertEqual(hud.age_text("2026-09-17T12:00:00Z", base + 3600 * 2), "2ч")
        self.assertEqual(hud.age_text("", base), "")
        self.assertEqual(hud.age_text("не дата", base), "")
        self.assertEqual(hud.age_text("2026-09-17T12:00:00Z", base - 1000), "сейчас",
                         "отрицательный возраст показывать нельзя — clamp в «сейчас»")


class SignatureTests(unittest.TestCase):
    """Подпись HUD — единственное, на что смотрит оверлей при перерисовке."""

    def test_signature_is_stable_and_changes_with_the_state(self):
        first = build(now=NOW)["signature"]
        same = build(now=NOW)["signature"]
        damaged = build({"timestamp": "2026-09-17T12:20:00Z", "event": "HullDamage",
                         "Health": 0.3}, now=NOW)["signature"]
        self.assertEqual(first, same)
        self.assertNotEqual(first, damaged)

    def test_signature_follows_ammo_and_afmu(self):
        base = build(now=NOW)["signature"]
        shot = build({"timestamp": "2026-09-17T12:20:00Z", "event": "AmmoUsed",
                      "Clip": 5, "Restock": 5}, now=NOW)["signature"]
        self.assertNotEqual(base, shot)


if __name__ == "__main__":
    unittest.main()
