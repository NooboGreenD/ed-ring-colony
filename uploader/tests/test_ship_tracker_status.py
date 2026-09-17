"""Корректность статусов корабля: поля журнала_readonly_как их пишет игра.

Жалоба: «доработать оверлей SHIP — найти способ реализовать корректное
отображение статусов корабля, чтоб в live режиме отображалась прочность модулей,
корпуса и т. д.». Причина, по которой live-режима не было, — разбор событий по
несуществующим полям:

* `ModuleInfo` читался под ключом `Modules` (в новых сборках список лежит в `Slots`),
  поэтому панель модулей вообще ничего не приносила;
* `Repair` пишет `Item`, а читался `Module`; `AfmuRepairs` пишет локализационный
  id (`$int_shieldbooster_size1_class1_name;`), а сопоставление шло по слоту;
* `RebootRepair` отдаёт слоты, `CockpitBreached` и `JetConeDamage` не
  обрабатывались, `RepairDrone`/`Synthesis` (реальные починки корпуса) — тоже;
* `HullDamage` applies to fighters and NPC-piloted hulls too, and that number
  попадало в корпус игрока;
* `RefuelAll.Amount` — кредиты, их прибавляли к тоннам.

Тесты на реальных payload'ах журнала фиксируют каждый из этих пунктов.
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import ship_tracker as st  # noqa: E402


LOADOUT = {
    "timestamp": "2026-09-17T12:00:00Z",
    "event": "Loadout",
    "Ship": "typex_1",
    "ShipName": "Lifer",
    "ShipIdent": "A1",
    "HullHealth": 1.0,
    "FuelLevel": 31.2,
    "FuelCapacity": {"Main": 32.0, "Reserve": 0.52},
    "CargoCapacity": 24,
    "Modules": [
        {"Slot": "MainEngines", "Item": "int_engine_size3_class5", "On": True,
         "Priority": 1, "Health": 1.0, "Power": 3.72},
        {"Slot": "FrameShiftDrive", "Item": "int_hyperdrive_size3_class5", "On": True,
         "Priority": 1, "Health": 0.91, "Power": 0.45},
        {"Slot": "Slot03_Size3", "Item": "int_shieldgenerator_size3_class2", "On": True,
         "Priority": 1, "Health": 1.0, "Power": 0.9},
        {"Slot": "PowerPlant", "Item": "int_powerplant_size4_class2", "On": True,
         "Priority": 1, "Health": 1.0, "Power": 0.0},
        {"Slot": "MediumHardpoint1", "Item": "hpt_multicannon_gimbal_medium", "On": True,
         "Priority": 0, "Health": 1.0, "AmmoInClip": 90, "AmmoInHopper": 1110},
        {"Slot": "Tiny01", "Item": "int_repairer_size1_class1", "On": True,
         "Priority": 1, "Health": 1.0, "AmmoInClip": 20, "AmmoInHopper": 0},
    ],
}


def tracker_with(*events):
    tracker = st.ShipTracker()
    tracker.parse_event(dict(LOADOUT))
    for event in events:
        tracker.parse_event(event)
    return tracker


class LoadoutSnapshotTests(unittest.TestCase):
    """`Loadout` — единственный источник прочности модулей целиком."""

    def setUp(self):
        self.state = tracker_with().state

    def test_module_health_from_loadout(self):
        self.assertEqual(len(self.state.modules), 6)
        self.assertAlmostEqual(self.state.modules["FrameShiftDrive"].health, 0.91, places=3)
        self.assertEqual(len(self.state.damaged_modules), 1)

    def test_snapshot_is_marked_fresh(self):
        self.assertEqual(self.state.modules_at, "2026-09-17T12:00:00Z")
        self.assertFalse(self.state.modules_incomplete,
                         "после Loadout прочность известна точно — HUD не должен врать")
        self.assertEqual(self.state.hull_source, "Loadout")

    def test_ammo_totals_exclude_afmu(self):
        """Ремонты AFMU — не боезапас хардпоинтов: иначе счётчик завышается."""
        self.assertEqual(self.state.ammo_total, 1200)
        self.assertEqual(self.state.afmu, {"charges": 20, "capacity": 20})


class ModuleInfoTests(unittest.TestCase):
    """Правая панель: `Slots` и `Modules`, `Health` — только если игра его отдаёт."""

    def test_slots_key_with_health_is_accepted(self):
        tracker = tracker_with()
        tracker.parse_event({
            "timestamp": "2026-09-17T12:05:00Z",
            "event": "ModuleInfo",
            "Slots": [
                {"Slot": "FrameShiftDrive", "Item": "int_hyperdrive_size3_class5",
                 "Priority": 2, "Health": 0.44, "Ammo": 0, "MaxAmmo": 0},
                {"Slot": "Tiny01", "Item": "int_repairer_size1_class1",
                 "Priority": 1, "Health": 1.0, "Ammo": 13, "MaxAmmo": 20},
            ],
        })
        state = tracker.state
        self.assertAlmostEqual(state.modules["FrameShiftDrive"].health, 0.44, places=3)
        self.assertEqual(state.modules["FrameShiftDrive"].priority, 2)
        self.assertEqual(state.modules["Tiny01"].ammo_clip, 13)
        self.assertEqual(state.afmu, {"charges": 13, "capacity": 20})
        self.assertFalse(state.modules_incomplete)
        self.assertEqual(state.modules_at, "2026-09-17T12:05:00Z")

    def test_old_modules_key_without_health_marks_incomplete(self):
        tracker = tracker_with()
        tracker.parse_event({
            "timestamp": "2026-09-17T12:05:00Z",
            "event": "ModuleInfo",
            "Modules": [
                {"Slot": "MainEngines", "Item": "int_engine_size3_class5",
                 "Power": 4.1, "Priority": 3},
            ],
        })
        state = tracker.state
        self.assertAlmostEqual(state.modules["MainEngines"].power, 4.1, places=3)
        self.assertEqual(state.modules["MainEngines"].priority, 3)
        self.assertTrue(state.modules_incomplete,
                        "панель без Health не обновляет прочность — HUD обязан это сказать")

    def test_stale_file_never_repairs(self):
        """`ModulesInfo.json` пишется редко:health из него только ухудшает."""
        tracker = tracker_with()
        tracker.parse_event({
            "timestamp": "2026-09-17T12:06:00Z",
            "event": "HullDamage",
            "Health": 0.5,
        })
        tracker._handle_module_info({
            "timestamp": "2026-09-17T11:00:00Z",
            "Modules": [{"Slot": "FrameShiftDrive", "Item": "int_hyperdrive_size3_class5",
                         "Health": 1.0, "Power": 0.45}],
        }, stale=True)
        self.assertAlmostEqual(tracker.state.modules["FrameShiftDrive"].health, 0.91, places=3,
                               msg="устаревший файл вернул 100 % — этого быть не должно")

    def test_health_in_percent_is_normalised(self):
        tracker = tracker_with()
        tracker._handle_module_info({
            "timestamp": "2026-09-17T12:07:00Z",
            "Slots": [{"Slot": "MainEngines", "Item": "int_engine_size3_class5",
                       "Health": 62.0}],
        })
        self.assertAlmostEqual(tracker.state.modules["MainEngines"].health, 0.62, places=3)


class HullTests(unittest.TestCase):
    """Корпус: чужие попадания и чужие корабли к нам отношения не имеют."""

    def test_hull_damage_sets_value_source_and_time(self):
        tracker = tracker_with()
        tracker.parse_event({"timestamp": "2026-09-17T12:20:00Z", "event": "HullDamage",
                              "Health": 0.62, "PlayerPilot": True, "Fighter": False})
        state = tracker.state
        self.assertEqual(state.hull_percent, 62)
        self.assertEqual(state.hull_source, "HullDamage")
        self.assertEqual(state.hull_at, "2026-09-17T12:20:00Z")

    def test_fighter_and_npc_damage_is_ignored(self):
        tracker = tracker_with()
        for event in ({"event": "HullDamage", "Health": 0.11, "Fighter": True},
                      {"event": "HullDamage", "Health": 0.12, "SRV": True},
                      {"event": "HullDamage", "Health": 0.13, "PlayerPilot": False}):
            tracker.parse_event(dict(event, timestamp="2026-09-17T12:20:00Z"))
        self.assertEqual(tracker.state.hull_percent, 100)

    def test_heat_damage_drops_hull_and_marks_modules_stale(self):
        # `heat_active` — это «перегрев был не дольше HEAT_WINDOW_SECONDS назад»,
        # то есть свойство зависит от текущего времени. Без зафиксированных
        # часов тест проходит только в первые две минуты после своего же
        # timestamp'а, а потом краснеет сам по себе. Часы подменяем.
        import calendar
        import datetime as dt
        from unittest import mock

        event_time = calendar.timegm(dt.datetime(2026, 9, 17, 12, 21, 0).timetuple())

        tracker = tracker_with()
        tracker.parse_event({"timestamp": "2026-09-17T12:21:00Z", "event": "HeatDamage"})
        state = tracker.state
        self.assertEqual(state.hull_percent, 98)
        self.assertTrue(state.modules_incomplete)

        with mock.patch.object(st.time, "time", return_value=float(event_time)):
            self.assertTrue(state.heat_active, "сразу после события перегрев активен")
        with mock.patch.object(st.time, "time",
                               return_value=float(event_time + st.HEAT_WINDOW_SECONDS)):
            self.assertTrue(state.heat_active, "на границе окна ещё активен")
        with mock.patch.object(st.time, "time",
                               return_value=float(event_time + st.HEAT_WINDOW_SECONDS + 1)):
            self.assertFalse(state.heat_active, "после окна перегрев снят")

    def test_repair_drone_adds_only_what_was_repaired(self):
        tracker = tracker_with(
            {"timestamp": "2026-09-17T12:22:00Z", "event": "HullDamage", "Health": 0.5})
        tracker.parse_event({"timestamp": "2026-09-17T12:23:00Z", "event": "RepairDrone",
                             "HullRepaired": 0.2, "CockpitRepaired": 0.0,
                             "CorrosionRepaired": 0.0})
        self.assertEqual(tracker.state.hull_percent, 70)
        tracker.parse_event({"timestamp": "2026-09-17T12:24:00Z", "event": "RepairDrone",
                             "HullRepaired": 5.0, "CockpitRepaired": 0.0,
                             "CorrosionRepaired": 0.0})
        self.assertEqual(tracker.state.hull_percent, 100, "не больше 100 %")

    def test_synthesis_repair_restores_hull(self):
        tracker = tracker_with({"timestamp": "2026-09-17T12:22:00Z", "event": "HullDamage",
                                 "Health": 0.3})
        tracker.parse_event({"timestamp": "2026-09-17T12:30:00Z", "event": "Synthesis",
                             "Name": "Repair Braced", "Materials": []})
        self.assertEqual(tracker.state.hull_percent, 100)

    def test_cockpit_breached_marks_canopy(self):
        tracker = tracker_with()
        tracker.parse_event({"timestamp": "2026-09-17T12:31:00Z", "event": "CockpitBreached"})
        state = tracker.state
        self.assertTrue(state.canopy_breached)
        self.assertEqual(state.hull_percent, 95)


class ModuleRepairTests(unittest.TestCase):
    """Починка: AFMU по loc-id, Repair по Item, Reboot — по слотам."""

    def test_afmu_repairs_module_by_localised_id(self):
        tracker = tracker_with(
            {"timestamp": "2026-09-17T12:40:00Z", "event": "ModuleInfo",
             "Slots": [{"Slot": "Slot03_Size3", "Item": "int_shieldgenerator_size3_class2",
                        "Health": 0.31}]})
        tracker.parse_event({"timestamp": "2026-09-17T12:41:00Z", "event": "AfmuRepairs",
                             "Module": "$int_shieldgenerator_size3_class2_name;",
                             "Module_Localised": "Shield Generator",
                             "FullyRepaired": True, "Health": 1})
        state = tracker.state
        self.assertAlmostEqual(state.modules["Slot03_Size3"].health, 1.0, places=3)
        self.assertFalse(state.modules["Slot03_Size3"].suspect)
        self.assertTrue(state.incidents, "починка обязана попасть в ленту HUD")

    def test_afmu_partial_repair_keeps_health_from_event(self):
        """AFMU чинит не полностью (кончились заряды) — берём Health события."""
        tracker = st.ShipTracker()
        tracker.parse_event(dict(LOADOUT, Modules=list(LOADOUT["Modules"]) + [
            {"Slot": "Tiny02", "Item": "int_shieldbooster_size1_class1", "On": True,
             "Priority": 1, "Health": 0.2, "Power": 0.6}]))
        tracker.parse_event({"timestamp": "2026-09-17T12:41:00Z", "event": "AfmuRepairs",
                             "Module": "$ShieldBooster_Name;", "FullyRepaired": False,
                             "Health": 0.7})
        # Локализационный id без префикса int_ должен найтись по вхождению.
        self.assertAlmostEqual(tracker.state.modules["Tiny02"].health, 0.7, places=3)

    def test_repair_by_item_field(self):
        tracker = tracker_with(
            {"timestamp": "2026-09-17T12:40:00Z", "event": "ModuleInfo",
             "Slots": [{"Slot": "FrameShiftDrive", "Item": "int_hyperdrive_size3_class5",
                        "Health": 0.44}]})
        tracker.parse_event({"timestamp": "2026-09-17T12:42:00Z", "event": "Repair",
                             "ShopID": 1, "Item": "int_hyperdrive_size3_class5", "Cost": 900})
        self.assertAlmostEqual(tracker.state.modules["FrameShiftDrive"].health, 1.0, places=3)

    def test_repair_all_clears_everything(self):
        tracker = tracker_with({"timestamp": "2026-09-17T12:40:00Z", "event": "CockpitBreached"})
        tracker.parse_event({"timestamp": "2026-09-17T12:43:00Z", "event": "RepairAll",
                             "Cost": 12000})
        state = tracker.state
        self.assertEqual(state.hull_percent, 100)
        self.assertFalse(state.canopy_breached)
        self.assertFalse(state.modules_incomplete)
        self.assertEqual(len(state.damaged_modules), 0)

    def test_reboot_repair_touches_slots_without_rehealing(self):
        """Перезагрузка снимает отказ, но не лечит физическое повреждение."""
        tracker = tracker_with(
            {"timestamp": "2026-09-17T12:40:00Z", "event": "ModuleInfo",
             "Slots": [{"Slot": "FrameShiftDrive", "Item": "int_hyperdrive_size3_class5",
                        "Health": 0.44, "On": False}]})
        tracker.parse_event({"timestamp": "2026-09-17T12:44:00Z", "event": "RebootRepair",
                             "Modules": ["FrameShiftDrive"]})
        module = tracker.state.modules["FrameShiftDrive"]
        self.assertTrue(module.on)
        self.assertAlmostEqual(module.health, 0.44, places=3)

    def test_jet_cone_marks_suspect_without_inventing_damage(self):
        tracker = tracker_with()
        tracker.parse_event({"timestamp": "2026-09-17T12:45:00Z", "event": "JetConeDamage",
                             "Module": "int_hyperdrive_size3_class5"})
        module = tracker.state.modules["FrameShiftDrive"]
        self.assertTrue(module.suspect)
        self.assertAlmostEqual(module.health, 0.91, places=3,
                               msg="величины урона в событии нет — выдумывать её нельзя")


class AmmoAndFuelTests(unittest.TestCase):

    def test_ammo_used_decreases_total_only(self):
        tracker = tracker_with({"timestamp": "2026-09-17T12:50:00Z", "event": "AmmoUsed",
                                 "Clip": 7, "Restock": 7})
        self.assertEqual(tracker.state.ammo_total, 1193)

    def test_buy_ammo_marks_counter_stale(self):
        """`BuyAmmo.Total` — кредиты: сказать точное число нельзя, честнее «?»."""
        tracker = tracker_with({"timestamp": "2026-09-17T12:51:00Z", "event": "BuyAmmo",
                                "Total": 41162})
        self.assertTrue(tracker.state.ammo_stale)
        self.assertEqual(tracker.state.ammo_total, 1200, "значение не должно измениться само")

    def test_refuel_all_is_full_tank_not_credits(self):
        tracker = tracker_with({"timestamp": "2026-09-17T12:52:00Z", "event": "RefuelAll",
                                 "Amount": 1354, "Price": 2209})
        self.assertAlmostEqual(tracker.state.fuel_level, 32.0, places=3,
                               msg="стоимость заправки не прибавляется к тоннам")

    def test_refuel_partial_adds_tonnes(self):
        tracker = tracker_with()
        tracker.state.fuel_level = 10.0
        tracker.parse_event({"timestamp": "2026-09-17T12:53:00Z", "event": "RefuelPartial",
                             "Amount": 5.0, "Cost": 133})
        self.assertAlmostEqual(tracker.state.fuel_level, 15.0, places=3)

    def test_fuel_scoop_sets_level_from_total(self):
        tracker = tracker_with({"timestamp": "2026-09-17T12:54:00Z", "event": "FuelScoop",
                                 "Scooped": 0.4987, "Total": 16.0})
        self.assertAlmostEqual(tracker.state.fuel_level, 16.0, places=3)


class StatusFileTests(unittest.TestCase):
    """`Status.json` — флаги и pips; ни щитов в процентах, ни прочности модулей там нет."""

    def test_shields_flag_drives_shield_state(self):
        tracker = tracker_with()
        tracker.parse_status_json({"timestamp": "2026-09-17T13:00:00Z", "Flags": 0x8,
                                   "Pips": [4, 4, 0]})
        self.assertEqual(tracker.state.shield_state, "up")
        tracker.parse_status_json({"timestamp": "2026-09-17T13:00:01Z", "Flags": 0x0,
                                   "Pips": [4, 4, 0]})
        self.assertEqual(tracker.state.shield_state, "down")

    def test_ship_without_shield_generator_reports_none(self):
        tracker = st.ShipTracker()
        tracker.parse_event(dict(LOADOUT, Modules=[
            {"Slot": "MainEngines", "Item": "int_engine_size3_class5", "Health": 1.0}]))
        tracker.parse_status_json({"timestamp": "2026-09-17T13:00:00Z", "Flags": 0x8})
        self.assertEqual(tracker.state.shield_state, "none")

    def test_state_unknown_before_first_status(self):
        tracker = tracker_with()
        self.assertEqual(tracker.state.shield_state, "unknown")

    def test_state_dict_carries_sources(self):
        tracker = tracker_with()
        data = tracker.get_state_dict()
        self.assertEqual(data["hull_source"], "Loadout")
        self.assertEqual(data["shield_state"], "unknown")
        self.assertFalse(data["modules_incomplete"])
        self.assertIn("ammo_total", data)
        self.assertIn("afmu", data)
        self.assertIn("incidents", data)


class HelpersTests(unittest.TestCase):

    def test_normalize_module_ref(self):
        self.assertEqual(st.normalize_module_ref("$int_shieldbooster_size1_class1_name;"),
                         "intshieldboostersize1class1")
        self.assertEqual(st.normalize_module_ref("$ShieldBooster_Name;"), "shieldbooster")
        self.assertEqual(st.normalize_module_ref(""), "")

    def test_find_slot_for_ref_by_name_and_slot(self):
        modules = {"Slot03_Size3": st.ShipModule(slot="Slot03_Size3",
                                                 name="int_shieldgenerator_size3_class2")}
        self.assertEqual(st.find_slot_for_ref(modules, "$int_shieldgenerator_name;"),
                         "Slot03_Size3")
        self.assertEqual(st.find_slot_for_ref(modules, "Slot03_Size3"), "Slot03_Size3")
        self.assertIsNone(st.find_slot_for_ref(modules, "int_buggybay_size2_class1"))

    def test_incidents_are_bounded(self):
        tracker = tracker_with()
        for index in range(st.INCIDENTS_HISTORY + 8):
            tracker.state.note("2026-09-17T13:00:00Z", f"событие {index}")
        self.assertEqual(len(tracker.state.incidents), st.INCIDENTS_HISTORY)
        self.assertEqual(tracker.state.incidents[-1]["text"], f"событие {st.INCIDENTS_HISTORY + 7}")


if __name__ == "__main__":
    unittest.main()
