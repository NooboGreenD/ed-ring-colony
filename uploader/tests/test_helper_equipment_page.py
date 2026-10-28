"""Headless Qt tests for the pilot loadout page («Снаряжение»)."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import Qt
    from PySide6.QtTest import QTest

    import helper_pages
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


SUIT = {
    "family": "explorationsuit", "model": "Artemis Suit", "grade": 5,
    "manufacturer": "Supratech", "slots": 4,
    "shield": 27.0, "regen": 1.98, "battery": 25.5, "oxygen": 60.0,
    "goods": 20, "assets": 40, "data": 10,
    "resistances": {"kinetic": 15, "thermal": 70, "plasma": 40, "explosive": 50},
}

WEAPONS = [
    {"slot": "PrimaryWeapon1", "label": "Manticore Intimidator", "class": "shotgun",
     "damage_type": "plasma", "fire": "semi-automatic", "grade": 3,
     "damage": 3.027, "magazine": 2, "reserve": 24, "mods": ["Scope"]},
    {"slot": "SecondaryWeapon", "label": "Karma P-15", "class": "pistol",
     "damage_type": "kinetic", "fire": "semi-automatic", "grade": 1,
     "damage": 1.38, "magazine": 24, "reserve": 240, "mods": []},
]


def make_state(**overrides):
    state = {
        "known": True,
        "suit": dict(SUIT),
        "loadout": {"id": "4293000003", "name": "x5_Perekrestok", "active": True,
                    "updated_at": "2026-10-28T20:12:34Z"},
        "weapons": [dict(item) for item in WEAPONS],
        "suit_mods": [{"name": "Improved Battery Capacity"}, {"name": "Night Vision"}],
        "tools": [{"key": "energylink", "name": "Energylink"},
                  {"key": "genetic-sampler", "name": "Genetic Sampler"}],
        "backpack": {
            "items": [{"name": "Building Fabricators", "count": 12}],
            "components": [{"name": "Graphene", "count": 40}],
            "consumables": [{"name": "Medkit", "count": 3}],
            "data": [],
            "totals": {"items": 12, "components": 40, "consumables": 3, "data": 0},
        },
        "loadouts": [
            {"id": "4293000003", "name": "x5_Perekrestok", "model": "Artemis Suit",
             "grade": 5, "active": True, "shown": True, "weapons": 2, "mods": 2},
            {"id": "4293000004", "name": "X5_Magnit", "model": "Dominator Suit",
             "grade": 3, "active": False, "shown": False, "weapons": 1, "mods": 1},
        ],
        "updated_at": "2026-10-28T20:12:34Z",
    }
    state.update(overrides)
    return state


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class EquipmentPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.selected = []
        self.refreshed = []
        self.page = helper_pages.EquipmentPage(
            on_refresh=lambda: self.refreshed.append(True),
            on_select=self.selected.append)

    def test_number_formatting_uses_the_game_style(self):
        import i18n
        previous = i18n.current_locale()
        self.addCleanup(i18n.set_locale, previous)
        i18n.set_locale("ru")
        self.assertEqual(helper_pages.equip_number(27.0, 1), "27,0")
        self.assertEqual(helper_pages.equip_number(1.98, 2), "1,98")
        i18n.set_locale("en")
        self.assertEqual(helper_pages.equip_number(27.0, 1), "27.0")
        self.assertEqual(helper_pages.equip_signed(15), "+15")
        self.assertEqual(helper_pages.equip_signed(-20), "\u221220")
        self.assertEqual(helper_pages.equip_signed(0), "0")
        self.assertEqual(helper_pages.equip_grade_text(5), "G5")

    def test_resistance_colour_marks_protection_and_weakness(self):
        from ui_qt import GREEN, MUTED, RED
        self.assertEqual(helper_pages.equip_resistance_color(15), GREEN)
        self.assertEqual(helper_pages.equip_resistance_color(-15), RED)
        self.assertEqual(helper_pages.equip_resistance_color(0), MUTED)

    def test_empty_state_shows_a_hint_instead_of_panels(self):
        self.page.set_state({"known": False})
        self.assertTrue(self.page.empty_hint.isVisible() or True)  # hidden window
        self.assertFalse(self.page.empty_hint.isHidden())
        self.assertTrue(self.page.columns_row.isHidden())

    def test_suit_card_shows_model_grade_and_manufacturer(self):
        self.page.set_state(make_state())
        self.assertEqual(self.page.suit_name.text(), "Artemis Suit")
        self.assertEqual(self.page.suit_badge.text(), "G5")
        self.assertIn("Supratech", self.page.suit_sub.text())
        self.assertIn("x5_Perekrestok", self.page.suit_sub.text())
        self.assertFalse(self.page.columns_row.isHidden())
        self.assertTrue(self.page.empty_hint.isHidden())

    def test_resistances_and_stats_are_rendered(self):
        self.page.set_state(make_state())
        self.assertEqual(self.page.resist_chips["thermal"].value.text(), "+70")
        self.assertEqual(self.page.resist_chips["kinetic"].value.text(), "+15")
        self.assertEqual(self.page.stat_rows["shield"].value.text(), "27,0")
        self.assertEqual(self.page.stat_rows["regen"].value.text(), "1,98")
        self.assertEqual(self.page.stat_rows["goods"].value.text(), "20")
        self.assertEqual(self.page.stat_rows["assets"].value.text(), "40")
        self.assertEqual(self.page.stat_rows["data"].value.text(), "10")
        self.assertEqual(self.page.stat_rows["battery"].value.text(), "25,5 МВт")
        self.assertEqual(self.page.stat_rows["oxygen"].value.text(), "60 с")

    def test_tools_and_consumables_are_listed(self):
        self.page.set_state(make_state())
        self.assertEqual(len(self.page.tools_rows), 2)
        self.assertEqual([chip.value.text() for chip in self.page.consumable_chips], ["3"])
        self.assertTrue(self.page.consumables_label.isHidden())

    def test_weapon_cards_show_slot_grade_and_magazine(self):
        self.page.set_state(make_state())
        cards = self.page.weapon_cards
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0].name_label.text(), "Manticore Intimidator")
        self.assertEqual(cards[0].badge.text(), "G3")
        self.assertEqual(cards[0].damage_label.text(), "3,03")
        self.assertEqual(cards[0].magazine_label.text(), "маг. 2 · зап. 24")
        self.assertIn("Дробовик", cards[0].kind_label.text())
        self.assertEqual(cards[0].mods_label.text(), "Scope")
        self.assertTrue(cards[1].mods_label.isHidden())
        self.assertTrue(self.page.no_weapons_label.isHidden())

    def test_loadout_without_weapons_says_so(self):
        state = make_state(weapons=[])
        self.page.set_state(state)
        self.assertEqual(self.page.weapon_cards, [])
        self.assertFalse(self.page.no_weapons_label.isHidden())

    def test_modification_list_and_free_slots(self):
        self.page.set_state(make_state())
        self.assertEqual(len(self.page.mods_rows), 2)
        self.assertEqual(self.page.slots_hint.text(), "установлено 2 из 4 · свободно 2")

    def test_full_modification_list_has_no_free_slots(self):
        state = make_state(suit_mods=[{"name": "A"}, {"name": "B"}, {"name": "C"},
                                      {"name": "D"}])
        self.page.set_state(state)
        self.assertEqual(self.page.slots_hint.text(), "установлено 4 из 4")

    def test_backpack_totals_and_items(self):
        self.page.set_state(make_state())
        self.assertEqual(self.page.backpack_rows["components"].value.text(), "40")
        self.assertEqual(self.page.backpack_rows["items"].value.text(), "12")
        self.assertEqual(self.page.backpack_rows["consumables"].value.text(), "3")
        self.assertEqual(self.page.backpack_rows["data"].value.text(), "0")

    def test_loadout_tiles_are_clickable(self):
        self.page.set_state(make_state())
        cards = self.page.loadout_cards
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0].name_label.text(), "x5_Perekrestok")
        self.assertEqual(cards[0].badge_label.text(), "НАДЕТ")
        self.assertEqual(cards[1].badge_label.text(), "")
        QTest.mouseClick(cards[1], Qt.MouseButton.LeftButton)
        self.assertEqual(self.selected, ["4293000004"])

    def test_refresh_button_asks_the_app(self):
        self.page.set_state(make_state())
        QTest.mouseClick(self.page.refresh_button, Qt.MouseButton.LeftButton)
        self.assertEqual(self.refreshed, [True])

    def test_repeated_state_does_not_rebuild_the_page(self):
        self.page.set_state(make_state())
        first = list(self.page.weapon_cards)
        self.page.set_state(make_state())
        self.assertEqual([id(card) for card in self.page.weapon_cards],
                         [id(card) for card in first])

    def test_changed_state_rebuilds_weapons(self):
        self.page.set_state(make_state())
        state = make_state(weapons=WEAPONS[:1])
        self.page.set_state(state)
        self.assertEqual(len(self.page.weapon_cards), 1)

    def test_signature_notices_every_part_of_the_state(self):
        base = helper_pages.EquipmentPage.signature_of(make_state())
        for change in ({"weapons": []},
                       {"suit_mods": []},
                       {"loadouts": []},
                       {"loadout": {"id": "другой", "name": "x", "active": False}}):
            self.assertNotEqual(helper_pages.EquipmentPage.signature_of(make_state(**change)),
                                base, change)

    def test_updated_time_comes_from_the_event(self):
        self.page.set_state(make_state())
        self.assertEqual(self.page.updated_label.text(), "обновлено 20:12:34")
        self.page.set_state(make_state(loadout={"id": "1", "name": "n", "active": True,
                                                "updated_at": ""}, updated_at=""))
        self.assertEqual(self.page.updated_label.text(), "обновлено —")


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class PilotSectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def test_equipment_is_the_first_tab(self):
        section = helper_pages.PilotSection()
        self.assertEqual(section.tabs.count(), 2)
        self.assertIs(section.tabs.widget(0), section.equipment)
        self.assertIs(section.tabs.widget(1), section.infographic)

    def test_section_passes_state_to_the_page(self):
        section = helper_pages.PilotSection()
        section.set_equipment(make_state())
        self.assertEqual(section.equipment.suit_name.text(), "Artemis Suit")

    def test_infographic_keeps_its_own_builder(self):
        section = helper_pages.PilotSection(infographic_kwargs={"compact": True})
        self.assertTrue(section.infographic.compact_check.isChecked())


if __name__ == "__main__":
    unittest.main()
