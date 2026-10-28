"""Тесты чистого слоя снаряжения пилота (без Qt и без сети).

Каталог статов — выгрузка Almanac-Core (данные Odyssey Materials Helper),
поэтому числа здесь проверяются как есть: если тест упадёт, значит либо
каталог поправили, либо сломали расчёт модификаций.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import pilot_equipment as equipment


SUIT_EVENT = {
    "timestamp": "2026-10-28T20:12:34Z",
    "event": "SuitLoadout",
    "SuitID": 1700532312591455,
    "SuitName": "tacticalsuit_class5",
    "SuitName_Localised": "Комбинезон Dominator",
    "LoadoutID": 4293000003,
    "LoadoutName": "X5_Magnit",
    "SuitMods": ["$suit_increasedbatterycapacity_name;", "$suit_nightvision_name;"],
    "Modules": [
        {"SlotName": "PrimaryWeapon1", "SuitModuleID": 1,
         "ModuleName": "wpn_m_assaultrifle_kinetic_fauto",
         "ModuleName_Localised": "Karma AR-50", "Class": 4,
         "WeaponMods": ["weapon_clipsize", "weapon_range_kinetic"]},
        {"SlotName": "SecondaryWeapon", "SuitModuleID": 2,
         "ModuleName": "wpn_s_pistol_kinetic_sauto",
         "ModuleName_Localised": "Karma P-15", "Class": 1, "WeaponMods": []},
    ],
}


class SymbolTests(unittest.TestCase):
    def test_journal_symbols_are_stripped(self):
        self.assertEqual(equipment.symbol_key("$suit_nightvision_name;"), "suit_nightvision")
        self.assertEqual(equipment.symbol_key("Suit_NightVision"), "suit_nightvision")
        self.assertEqual(equipment.symbol_key(None), "")

    def test_suit_symbol_gives_family_and_grade(self):
        self.assertEqual(equipment.suit_from_symbol("utilitysuit_class3"), ("utilitysuit", 3))
        self.assertEqual(equipment.suit_from_symbol("$explorationsuit_class5_name;"),
                         ("explorationsuit", 5))
        self.assertEqual(equipment.suit_from_symbol("flightsuit"), ("flightsuit", 1))

    def test_unknown_suit_keeps_the_grade_but_not_the_family(self):
        self.assertEqual(equipment.suit_from_symbol("unknownsuit_class4"), (None, 4))

    def test_weapon_symbol_must_exist_in_the_catalogue(self):
        self.assertEqual(equipment.weapon_from_symbol("$wpn_s_pistol_kinetic_sauto_name;"),
                         "wpn_s_pistol_kinetic_sauto")
        self.assertIsNone(equipment.weapon_from_symbol("wpn_fake_weapon"))

    def test_weapon_modification_falls_back_without_technology_suffix(self):
        # Журнал пишет общий символ, каталог знает три версии по технологии.
        found = equipment.modification("weapon_range")
        self.assertIsNotNone(found)
        self.assertEqual(found["name"], "Greater Range")

    def test_unknown_modification_gets_a_readable_name(self):
        self.assertIsNone(equipment.modification("weapon_unknown_thing"))
        self.assertEqual(equipment.modification_name("$weapon_unknown_thing_name;"),
                         "Weapon unknown thing")

    def test_tools_follow_the_suit_family(self):
        names = [tool["name"] for tool in equipment.tools_for("utilitysuit")]
        self.assertEqual(names, ["Energylink", "Profile Analyser", "Arc Cutter"])
        artemis = [tool["name"] for tool in equipment.tools_for("explorationsuit")]
        self.assertIn("Genetic Sampler", artemis)
        self.assertNotIn("Arc Cutter", artemis)
        self.assertEqual(equipment.tools_for(None), [])


class SuitStatsTests(unittest.TestCase):
    def test_dominator_grade_five_matches_the_catalogue(self):
        stats = equipment.suit_stats("tacticalsuit", 5)
        self.assertEqual(stats["model"], "Dominator Suit")
        self.assertEqual(stats["manufacturer"], "Manticore")
        self.assertAlmostEqual(stats["shield"], 33.8)
        self.assertAlmostEqual(stats["regen"], 2.48)
        self.assertEqual(stats["slots"], 4)
        self.assertEqual(stats["resistances"],
                         {"kinetic": 25, "thermal": 80, "plasma": 50, "explosive": 50})

    def test_grade_one_is_weaker_than_grade_five(self):
        low = equipment.suit_stats("tacticalsuit", 1)
        self.assertAlmostEqual(low["shield"], 15.0)
        self.assertEqual(low["slots"], 0)
        self.assertEqual(low["resistances"]["thermal"], 60)

    def test_flight_suit_has_a_single_secondary_mount(self):
        stats = equipment.suit_stats("flightsuit", 1)
        self.assertEqual(stats["mounts"], ("SecondaryWeapon",))
        self.assertAlmostEqual(stats["battery"], 7)

    def test_unknown_family_has_no_stats(self):
        self.assertEqual(equipment.suit_stats("nosuchsuit", 3), {})

    def test_battery_and_backpack_modifications_scale_the_values(self):
        plain = equipment.suit_stats("explorationsuit", 5)
        modded = equipment.suit_stats("explorationsuit", 5,
                                      ["suit_increasedbatterycapacity",
                                       "suit_backpackcapacity"])
        self.assertAlmostEqual(modded["battery"], plain["battery"] * 1.5)
        self.assertEqual(modded["goods"], plain["goods"] * 2)
        self.assertEqual(modded["assets"], plain["assets"] * 2)
        self.assertEqual(modded["data"], plain["data"] * 2)

    def test_air_and_shield_regen_modifications(self):
        plain = equipment.suit_stats("utilitysuit", 4)
        modded = equipment.suit_stats("utilitysuit", 4,
                                      ["suit_increasedo2capacity",
                                       "suit_increasedshieldregen"])
        self.assertAlmostEqual(modded["oxygen"], plain["oxygen"] * 5)
        self.assertAlmostEqual(modded["regen"], plain["regen"] * 1.25)

    def test_damage_resistance_reduces_incoming_damage_not_the_share(self):
        plain = equipment.suit_stats("tacticalsuit", 5)
        modded = equipment.suit_stats("tacticalsuit", 5, ["suit_improvedarmourrating"])
        # Термика 80 % -> урон 0.8 от прежнего -> 82 % сопротивления.
        self.assertEqual(modded["resistances"]["thermal"], 82)
        self.assertGreater(modded["resistances"]["kinetic"], plain["resistances"]["kinetic"])

    def test_unknown_and_foreign_modifications_do_not_change_anything(self):
        stats = equipment.suit_stats("utilitysuit", 3,
                                     ["weapon_clipsize", "suit_whatever"])
        plain = equipment.suit_stats("utilitysuit", 3)
        self.assertEqual(stats["resistances"], plain["resistances"])
        self.assertEqual(stats["mods_unknown"], ["Magazine Size", "Suit whatever"])
        self.assertEqual(stats["mods_applied"], [])

    def test_the_same_modification_is_applied_once(self):
        stats = equipment.suit_stats("utilitysuit", 3,
                                     ["suit_increasedbatterycapacity",
                                      "$suit_increasedbatterycapacity_name;"])
        self.assertEqual(stats["mods_applied"], ["Improved Battery Capacity"])
        self.assertAlmostEqual(stats["battery"], 13.5 * 1.5)


class WeaponStatsTests(unittest.TestCase):
    def test_grade_scales_damage(self):
        self.assertAlmostEqual(equipment.weapon_stats("wpn_s_pistol_kinetic_sauto", 1)["damage"],
                               1.38)
        self.assertAlmostEqual(equipment.weapon_stats("wpn_s_pistol_kinetic_sauto", 5)["damage"],
                               4.112)

    def test_grade_outside_the_catalogue_is_clamped(self):
        weapon = equipment.weapon_stats("wpn_s_pistol_kinetic_sauto", 9)
        self.assertEqual(weapon["grade"], 5)
        self.assertEqual(equipment.weapon_stats("wpn_s_pistol_kinetic_sauto", 0)["grade"], 1)

    def test_clip_size_modification_rounds_up(self):
        # 24 * 1.5 = 36; у дробовика 2 * 1.5 = 3, у снайперки 3 * 1.5 = 4.5 -> 5.
        self.assertEqual(equipment.weapon_stats("wpn_s_pistol_kinetic_sauto", 1,
                                                ["weapon_clipsize"])["magazine"], 36)
        self.assertEqual(equipment.weapon_stats("wpn_m_shotgun_plasma_doublebarrel", 1,
                                                ["weapon_clipsize"])["magazine"], 3)
        self.assertEqual(equipment.weapon_stats("wpn_m_sniper_plasma_charged", 1,
                                                ["weapon_clipsize"])["magazine"], 5)

    def test_range_modification_adds_half_the_distance(self):
        plain = equipment.weapon_stats("wpn_m_assaultrifle_kinetic_fauto", 3)
        modded = equipment.weapon_stats("wpn_m_assaultrifle_kinetic_fauto", 3,
                                        ["weapon_range_kinetic"])
        self.assertAlmostEqual(modded["range"], plain["range"] * 1.5)

    def test_weapon_keeps_its_modification_names(self):
        weapon = equipment.weapon_stats("wpn_m_assaultrifle_kinetic_fauto", 2,
                                        ["weapon_scope", "weapon_handling"])
        self.assertEqual(weapon["mods"], ["Scope", "Faster Handling"])

    def test_unknown_weapon_has_no_stats(self):
        self.assertEqual(equipment.weapon_stats("wpn_fake", 3), {})


class LoadoutEventTests(unittest.TestCase):
    def setUp(self):
        self.tracker = equipment.PilotEquipment()

    def test_suit_loadout_becomes_the_active_loadout(self):
        self.assertTrue(self.tracker.handle(SUIT_EVENT))
        state = self.tracker.state()
        self.assertTrue(state["known"])
        self.assertEqual(state["loadout"]["name"], "X5_Magnit")
        self.assertEqual(state["suit"]["model"], "Dominator Suit")
        # Грейд берётся из SuitName, а не из локализованного названия.
        self.assertEqual(state["suit"]["grade"], 5)

    def test_weapons_are_listed_by_slot_in_mount_order(self):
        self.tracker.handle(SUIT_EVENT)
        weapons = self.tracker.state()["weapons"]
        self.assertEqual([item["slot"] for item in weapons],
                         ["PrimaryWeapon1", "SecondaryWeapon"])
        self.assertEqual(weapons[0]["label"], "Karma AR-50")
        self.assertEqual(weapons[0]["magazine"], 75)      # 50 * 1.5, округление вверх
        self.assertAlmostEqual(weapons[0]["range"], 75.0)  # 50 * 1.5
        self.assertEqual(weapons[1]["damage_type"], "kinetic")

    def test_unknown_weapon_still_shows_with_its_journal_name(self):
        event = dict(SUIT_EVENT, Timestamp=None)
        event["Modules"] = [{"SlotName": "PrimaryWeapon1", "ModuleName": "wpn_modded_custom",
                             "ModuleName_Localised": "Custom Rifle", "Class": 2}]
        self.tracker.handle(event)
        weapons = self.tracker.state()["weapons"]
        self.assertEqual(len(weapons), 1)
        self.assertEqual(weapons[0]["label"], "Custom Rifle")
        self.assertEqual(weapons[0]["grade"], 2)

    def test_switch_loadout_changes_what_is_shown(self):
        self.tracker.handle(SUIT_EVENT)
        other = {"event": "SwitchSuitLoadout", "LoadoutID": 4293000004,
                 "LoadoutName": "Stealth", "SuitName": "utilitysuit_class4",
                 "SuitMods": [], "Modules": []}
        self.assertTrue(self.tracker.handle(other))
        state = self.tracker.state()
        self.assertEqual(state["loadout"]["name"], "Stealth")
        self.assertEqual(state["suit"]["model"], "Maverick Suit")
        self.assertEqual(state["weapons"], [])
        active = [item["id"] for item in state["loadouts"] if item["active"]]
        self.assertEqual(active, ["4293000004"])

    def test_switch_without_modules_keeps_the_weapons(self):
        self.tracker.handle(SUIT_EVENT)
        self.tracker.handle({"event": "SwitchSuitLoadout", "LoadoutID": 4293000003,
                             "LoadoutName": "X5_Magnit", "SuitName": "tacticalsuit_class5"})
        self.assertEqual(len(self.tracker.state()["weapons"]), 2)
        self.assertEqual(len(self.tracker.state()["suit_mods"]), 2)

    def test_upgrade_suit_changes_the_grade_of_the_loadout(self):
        self.tracker.handle(SUIT_EVENT)
        self.assertTrue(self.tracker.handle({"event": "UpgradeSuit", "SuitID": 1700532312591455,
                                             "SuitName": "utilitysuit_class4",
                                             "Class": 4}))
        stats = self.tracker.state()["suit"]
        self.assertEqual(stats["model"], "Maverick Suit")
        self.assertEqual(stats["grade"], 4)

    def test_upgrade_of_an_unknown_suit_changes_nothing(self):
        self.tracker.handle(SUIT_EVENT)
        self.assertFalse(self.tracker.handle({"event": "UpgradeSuit", "SuitID": 999}))

    def test_equip_and_remove_module(self):
        self.tracker.handle(SUIT_EVENT)
        self.tracker.handle({"event": "LoadoutEquipModule", "LoadoutID": 4293000003,
                             "SlotName": "PrimaryWeapon2",
                             "ModuleName": "wpn_m_sniper_plasma_charged",
                             "ModuleName_Localised": "Manticore Executioner",
                             "Class": 5, "WeaponMods": []})
        slots = [item["slot"] for item in self.tracker.state()["weapons"]]
        self.assertEqual(slots, ["PrimaryWeapon1", "PrimaryWeapon2", "SecondaryWeapon"])
        self.tracker.handle({"event": "LoadoutRemoveModule", "LoadoutID": 4293000003,
                             "SlotName": "PrimaryWeapon2"})
        slots = [item["slot"] for item in self.tracker.state()["weapons"]]
        self.assertEqual(slots, ["PrimaryWeapon1", "SecondaryWeapon"])

    def test_equip_module_for_unknown_loadout_creates_it(self):
        self.tracker.handle({"event": "LoadoutEquipModule", "LoadoutID": "77",
                             "LoadoutName": "New", "SuitName": "utilitysuit_class2",
                             "SlotName": "SecondaryWeapon",
                             "ModuleName": "wpn_s_pistol_kinetic_sauto",
                             "ModuleName_Localised": "Karma P-15", "Class": 1})
        state = self.tracker.state()
        self.assertEqual(len(state["loadouts"]), 1)
        self.assertEqual(len(state["weapons"]), 1)
        self.assertEqual(state["suit"]["grade"], 2)

    def test_rename_and_delete_loadouts(self):
        self.tracker.handle(SUIT_EVENT)
        self.assertTrue(self.tracker.handle({"event": "RenameSuitLoadout", "LoadoutID": 4293000003,
                                             "LoadoutName": "Rename"}))
        self.assertEqual(self.tracker.state()["loadout"]["name"], "Rename")
        self.assertTrue(self.tracker.handle({"event": "DeleteSuitLoadout",
                                             "LoadoutID": 4293000003}))
        self.assertFalse(self.tracker.state()["known"])

    def test_irrelevant_events_change_nothing(self):
        self.assertFalse(self.tracker.handle({"event": "FSDJump"}))
        self.assertFalse(self.tracker.handle({"event": "BuyWeapon", "Name": "wpn_s_pistol"}))
        self.assertFalse(self.tracker.handle({}))
        self.assertFalse(self.tracker.handle(None))

    def test_repeated_loadout_event_is_not_reported_as_change(self):
        self.tracker.handle(SUIT_EVENT)
        self.assertFalse(self.tracker.handle(dict(SUIT_EVENT)))

    def test_empty_state_before_any_event(self):
        state = self.tracker.state()
        self.assertFalse(state["known"])
        self.assertIsNone(state["suit"])
        self.assertEqual(state["weapons"], [])
        self.assertEqual(state["backpack"]["totals"],
                         {"items": 0, "components": 0, "data": 0, "consumables": 0})


class BackpackTests(unittest.TestCase):
    def setUp(self):
        self.tracker = equipment.PilotEquipment()

    def test_backpack_event_replaces_all_sections(self):
        self.assertTrue(self.tracker.handle({
            "event": "Backpack",
            "Items": [{"Name": "buildingfabricators", "Name_Localised": "Building Fabricators",
                       "Count": 12}],
            "Components": [{"Name": "graphene", "Name_Localised": "Graphene", "Count": 40},
                           {"Name": "microhydraulics", "Count": 7}],
            "Consumables": [{"Name": "healthpack", "Name_Localised": "Medkit", "Count": 3}],
            "Data": [{"Name": "settlementdata", "Name_Localised": "Settlement Data", "Count": 6}],
        }))
        backpack = self.tracker.state()["backpack"]
        self.assertEqual(backpack["items"], [{"name": "Building Fabricators", "count": 12}])
        self.assertEqual(backpack["components"][0], {"name": "Graphene", "count": 40})
        self.assertIn({"name": "Microhydraulics", "count": 7}, backpack["components"])
        self.assertEqual(backpack["totals"], {"items": 12, "components": 47,
                                              "data": 6, "consumables": 3})

    def test_backpack_change_adds_and_removes_by_type(self):
        self.tracker.handle({"event": "Backpack", "Items": [], "Components": [],
                             "Consumables": [], "Data": []})
        self.tracker.handle({"event": "BackpackChange",
                             "Added": [{"Name": "graphene", "Name_Localised": "Graphene",
                                        "Type": "Component", "Count": 5}],
                             "Removed": []})
        self.tracker.handle({"event": "BackpackChange",
                             "Added": [{"Name": "medkit", "Name_Localised": "Medkit",
                                        "Type": "Consumable", "Count": 2}],
                             "Removed": [{"Name": "graphene", "Name_Localised": "Graphene",
                                          "Type": "Component", "Count": 3}]})
        backpack = self.tracker.state()["backpack"]
        self.assertEqual(backpack["components"], [{"name": "Graphene", "count": 2}])
        self.assertEqual(backpack["consumables"], [{"name": "Medkit", "count": 2}])

    def test_backpack_never_goes_negative(self):
        self.tracker.handle({"event": "BackpackChange", "Added": [],
                             "Removed": [{"Name": "graphene", "Name_Localised": "Graphene",
                                          "Type": "Component", "Count": 4}]})
        self.assertEqual(self.tracker.state()["backpack"]["components"], [])

    def test_backpack_file_is_read_from_the_journal_folder(self):
        folder = Path(tempfile.mkdtemp())
        payload = {"timestamp": "2026-10-28T20:00:00Z", "event": "Backpack",
                   "Items": [{"Name": "graphene", "Name_Localised": "Graphene", "Count": 4}],
                   "Components": [], "Consumables": [], "Data": []}
        (folder / "Backpack.json").write_text(json.dumps(payload), encoding="utf-8")
        self.assertTrue(self.tracker.read_backpack_file(folder))
        self.assertEqual(self.tracker.state()["backpack"]["items"],
                         [{"name": "Graphene", "count": 4}])

    def test_missing_or_broken_backpack_file_is_ignored(self):
        folder = Path(tempfile.mkdtemp())
        self.assertFalse(self.tracker.read_backpack_file(folder))
        (folder / "Backpack.json").write_text("{ не json", encoding="utf-8")
        self.assertFalse(self.tracker.read_backpack_file(folder))
        self.assertFalse(self.tracker.read_backpack_file(None))


class SelectionAndCacheTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp())
        self.path = self.folder / "equipment.json"
        self.tracker = equipment.PilotEquipment(self.path)
        self.tracker.handle(SUIT_EVENT)
        self.tracker.handle({"event": "CreateSuitLoadout", "LoadoutID": 4293000009,
                             "LoadoutName": "Second", "SuitName": "utilitysuit_class3",
                             "SuitMods": [], "Modules": []})

    def test_active_loadout_is_shown_first(self):
        state = self.tracker.state()
        self.assertEqual(state["loadouts"][0]["active"], True)
        self.assertEqual(state["loadout"]["id"], "4293000003")

    def test_select_shows_another_loadout_without_changing_the_active_one(self):
        self.assertTrue(self.tracker.select("4293000009"))
        state = self.tracker.state()
        self.assertEqual(state["loadout"]["name"], "Second")
        self.assertFalse(state["loadout"]["active"])
        self.assertEqual([item["id"] for item in state["loadouts"] if item["active"]],
                         ["4293000003"])
        self.assertEqual([item["id"] for item in state["loadouts"] if item["shown"]],
                         ["4293000009"])

    def test_select_ignores_unknown_ids(self):
        self.assertFalse(self.tracker.select("нет-такого"))
        self.assertFalse(self.tracker.select(""))

    def test_cache_survives_restart(self):
        self.tracker.handle({"event": "Backpack", "Items": [], "Data": [],
                             "Components": [{"Name": "graphene", "Name_Localised": "Graphene",
                                             "Count": 9}],
                             "Consumables": []})
        self.tracker.select("4293000009")
        self.tracker.save(force=True)
        fresh = equipment.PilotEquipment(self.path)
        state = fresh.state()
        self.assertEqual(state["loadout"]["name"], "Second")
        self.assertEqual(state["backpack"]["components"], [{"name": "Graphene", "count": 9}])
        self.assertEqual(len(state["loadouts"]), 2)

    def test_broken_cache_file_is_ignored(self):
        self.path.write_text("не json", encoding="utf-8")
        fresh = equipment.PilotEquipment(self.path)
        self.assertFalse(fresh.state()["known"])

    def test_saving_without_a_path_is_harmless(self):
        equipment.PilotEquipment().save(force=True)


if __name__ == "__main__":
    unittest.main()
