"""Headless Qt tests for the migrated Coloniser page."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QCheckBox, QComboBox, QLineEdit, QPushButton, QTableWidget

    import helper_pages
    import i18n
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


ROWS = [
    ("★", "Kuma", "Hestia Depot", "hestia", "1200 / 9025 (13%)", "build-1"),
    ("", "Sol", "Jameson Terminal", "coriolis", "0 / 5000 (0%)", "build-2"),
]


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class ColonyPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        i18n.set_locale("ru")
        self.events = []
        self.actions = helper_pages.ColonyPageActions(
            **{name: (lambda n=name: self.events.append(n)) for name in (
                "refresh", "select", "open_project", "set_primary", "clear_primary",
                "complete", "copy_id", "bind_site", "unbind_site", "fill_current",
                "reconcile", "options_changed", "plan_selected", "body_choices",
                "body_selected", "create", "clear_form", "check_system")})
        self.page = helper_pages.ColonyPage(cmdr="CMDR Test", actions=self.actions)

    # ------------------------------------------------------------- structure
    def test_form_has_every_field_the_payload_needs(self):
        expected = {"systemName", "marketId", "systemAddress", "buildName",
                    "buildType", "maxNeed", "bodyName", "bodyNum",
                    "architectName", "discordLink", "notes"}
        self.assertEqual(set(self.page.fields), expected)

    def test_field_widget_types(self):
        self.assertIsInstance(self.page.fields["buildName"], QLineEdit)
        self.assertIsInstance(self.page.fields["buildType"], QComboBox)
        self.assertIsInstance(self.page.fields["bodyName"], helper_pages.RefreshingCombo)
        self.assertIsInstance(self.page.table, QTableWidget)
        self.assertIsInstance(self.page.autofill_check, QCheckBox)
        self.assertIsInstance(self.page.primary_port_check, QCheckBox)
        self.assertIsInstance(self.page.create_btn, QPushButton)

    def test_initial_state(self):
        self.assertEqual(self.page.cmdr_text(), "CMDR Test")
        self.assertEqual(self.page.row_count(), 0)
        self.assertTrue(self.page.autofill_check.isChecked())
        self.assertTrue(self.page.open_page_check.isChecked())
        self.assertEqual(self.page.plan_index(), 0)
        self.assertEqual(self.page.plan_text(), helper_pages.ColonyPage.PLAN_NONE_LABEL)
        self.assertFalse(self.page.create_btn.isEnabled() is False)  # enabled by default

    def test_actions_start_disabled_until_a_project_is_selected(self):
        self.assertTrue(all(not button.isEnabled() for button in self.page.action_buttons))
        self.page.set_actions_enabled(True)
        self.assertTrue(all(button.isEnabled() for button in self.page.action_buttons))

    # ----------------------------------------------------------------- values
    def test_value_and_set_value_work_for_entries_and_combos(self):
        self.page.set_value("systemName", "Kuma")
        self.page.set_value("buildType", "hestia")
        self.assertEqual(self.page.value("systemName"), "Kuma")
        self.assertEqual(self.page.value("buildType"), "hestia")
        self.assertEqual(self.page.fields["systemName"].text(), "Kuma")

    def test_set_value_adds_an_unknown_option_instead_of_dropping_it(self):
        self.page.set_value("buildType", "неизвестный тип")
        self.assertEqual(self.page.value("buildType"), "неизвестный тип")

    def test_set_value_tolerates_none_and_unknown_keys(self):
        self.page.set_value("buildName", None)
        self.assertEqual(self.page.value("buildName"), "")
        self.page.set_value("nope", "x")
        self.assertEqual(self.page.value("nope"), "")

    def test_clear_fields_empties_the_whole_form(self):
        self.page.set_value("systemName", "Kuma")
        self.page.set_value("buildName", "Hestia Depot")
        self.page.clear_fields()
        self.assertEqual(self.page.value("systemName"), "")
        self.assertEqual(self.page.value("buildName"), "")

    def test_combo_values_are_replaced_and_the_choice_is_kept(self):
        self.page.set_combo_values("buildType", ["hestia", "coriolis"])
        self.page.set_value("buildType", "coriolis")
        self.page.set_combo_values("buildType", ["coriolis", "zeus"])
        self.assertEqual([self.page.fields["buildType"].itemText(i)
                          for i in range(self.page.fields["buildType"].count())],
                         ["coriolis", "zeus"])
        self.assertEqual(self.page.value("buildType"), "coriolis")

    # ------------------------------------------------------------------ table
    def test_rows_replace_the_previous_contents(self):
        self.page.set_rows(ROWS)
        self.assertEqual(self.page.row_count(), 2)
        self.assertEqual(self.page.row_values(0)[1:4], ("Kuma", "Hestia Depot", "hestia"))
        self.page.set_rows([])
        self.assertEqual(self.page.row_count(), 0)

    def test_selection_is_reported_as_a_row_tuple(self):
        self.page.set_rows(ROWS)
        self.assertIsNone(self.page.selected_values())
        self.page.select_row(1)
        values = self.page.selected_values()
        self.assertEqual(values[2], "Jameson Terminal")
        self.assertEqual(values[5], "build-2")

    def test_selection_notifies_the_app(self):
        self.page.set_rows(ROWS)
        self.page.select_row(0)
        self.assertIn("select", self.events)

    def test_rows_are_read_only(self):
        self.page.set_rows(ROWS)
        from PySide6.QtCore import Qt
        flags = self.page.table.item(0, 1).flags()
        self.assertFalse(flags & Qt.ItemFlag.ItemIsEditable)

    # ---------------------------------------------------------------- buttons
    def test_buttons_fire_their_callbacks(self):
        self.page.set_actions_enabled(True)
        for action, button in zip(("set_primary", "clear_primary", "complete", "copy_id",
                                   "open_project", "bind_site", "unbind_site"),
                                  self.page.action_buttons):
            button.click()
            self.assertIn(action, self.events)
        self.page.refresh_btn.click()
        self.page.fill_btn.click()
        self.page.reconcile_btn.click()
        self.page.create_btn.click()
        self.page.clear_form_btn.click()
        self.page.check_system_btn.click()
        for action in ("refresh", "fill_current", "reconcile", "create",
                       "clear_form", "check_system"):
            self.assertIn(action, self.events)

    def test_missing_callbacks_do_not_crash(self):
        page = helper_pages.ColonyPage(actions=helper_pages.ColonyPageActions())
        page.refresh_btn.click()
        page.create_btn.click()
        page.autofill_check.setChecked(False)
        page.fields["bodyName"].showPopup()

    def test_checkboxes_report_changes(self):
        self.page.autofill_check.setChecked(False)
        self.page.open_page_check.setChecked(False)
        self.assertEqual(self.events.count("options_changed"), 2)

    # ------------------------------------------------------------- site plans
    def test_plan_list_keeps_the_bare_option_first(self):
        labels = [helper_pages.ColonyPage.PLAN_NONE_LABEL, "Alpha (hestia)", "Beta (zeus)"]
        self.page.set_plan_labels(labels)
        self.assertEqual(self.page.plan_labels(), labels)
        self.page.set_plan_text("Beta (zeus)")
        self.assertEqual(self.page.plan_index(), 2)

    def test_plan_set_text_adds_unknown_values(self):
        self.page.set_plan_labels(["Нет (создать новый план)", "Alpha (hestia)"])
        self.page.set_plan_text("Gamma (zeus)")
        self.assertEqual(self.page.plan_text(), "Gamma (zeus)")

    def test_plan_change_notifies_the_app(self):
        self.page.set_plan_labels(["Нет (создать новый план)", "Alpha (hestia)"])
        self.page.plan_combo.setCurrentIndex(1)
        self.assertIn("plan_selected", self.events)

    # ------------------------------------------------------------------ labels
    def test_status_site_and_key_texts(self):
        self.page.set_status("Проектов: 3")
        self.assertEqual(self.page.status_text(), "Проектов: 3")
        self.page.set_site_text("Kuma · вы на площадке", helper_pages.GREEN)
        self.assertEqual(self.page.site_text(), "Kuma · вы на площадке")
        self.page.set_key_status("RCC ключ задан", helper_pages.GREEN)
        self.assertEqual(self.page.key_text(), "RCC ключ задан")

    def test_busy_switches_buttons_and_the_create_button(self):
        self.page.set_actions_enabled(False)
        self.page.set_create_enabled(False)
        self.assertFalse(self.page.create_btn.isEnabled())
        self.page.set_actions_enabled(True)
        self.page.set_create_enabled(True)
        self.assertTrue(self.page.create_btn.isEnabled())

    # -------------------------------------------------------------- language
    def test_page_follows_the_language_chosen_in_the_launcher(self):
        import re

        cyrillic = re.compile("[А-Яа-яЁё]")
        for code, marker in (("en", "Create project"), ("ko", "프로젝트"), ("zh", "项目")):
            i18n.set_locale(code)
            page = helper_pages.ColonyPage(cmdr="CMDR Test")
            try:
                texts = [page.create_btn.text(), page.clear_form_btn.text(),
                         page.refresh_btn.text(), page.cmdr_entry.placeholderText()]
                for widget in page.findChildren(QCheckBox):
                    texts.append(widget.text())
                self.assertIn(marker, " ".join(texts))
                self.assertEqual([text for text in texts if cyrillic.search(text)], [],
                                 f"{code}: остались русские подписи")
            finally:
                page.close()
        i18n.set_locale("ru")

    def test_plan_none_item_follows_the_language_and_still_means_none(self):
        for code in ("en", "ja"):
            i18n.set_locale(code)
            page = helper_pages.ColonyPage()
            try:
                labels = [helper_pages.ColonyPage.PLAN_NONE_LABEL, "Alpha (hestia)"]
                page.set_plan_labels(labels)
                self.assertEqual(page.plan_index(), 0)
                self.assertTrue(page.plan_none_selected())
                self.assertNotEqual(page.plan_text(), helper_pages.ColonyPage.PLAN_NONE_LABEL)
                page.set_plan_text("Alpha (hestia)")
                self.assertFalse(page.plan_none_selected())
                page.set_plan_text(helper_pages.ColonyPage.PLAN_NONE_LABEL)
                self.assertTrue(page.plan_none_selected())
            finally:
                page.close()
        i18n.set_locale("ru")

    def test_table_headers_are_translated_but_field_names_are_not(self):
        i18n.set_locale("de")
        page = helper_pages.ColonyPage()
        try:
            headers = [page.table.horizontalHeaderItem(i).text()
                       for i in range(page.table.columnCount())]
            translated = dict((key, headers[index])
                              for index, (key, _t, _w)
                              in enumerate(helper_pages.COLONY_COLUMNS))
            self.assertEqual(translated["buildId"], "buildId")
            self.assertEqual(translated["primary"], "★")
            self.assertEqual(translated["system"], "System")
        finally:
            page.close()
        i18n.set_locale("ru")

    # ---------------------------------------------------------------- drawing
    def test_page_renders_with_rows(self):
        self.page.set_rows(ROWS)
        self.page.set_status("Проектов: 2")
        self.page.resize(1100, 760)
        self.page.show()
        self.app.processEvents()
        image = self.page.grab().toImage()
        self.assertFalse(image.isNull())
        self.assertEqual((image.width(), image.height()), (1100, 760))
        self.page.hide()

    def test_form_stays_usable_at_a_narrow_width(self):
        self.page.resize(820, 700)
        self.page.show()
        self.app.processEvents()
        self.assertLessEqual(self.page.fields["buildName"].x() + 40, 820)
        self.page.hide()


if __name__ == "__main__":
    unittest.main()
