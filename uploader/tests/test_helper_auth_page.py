"""Headless Qt tests for the migrated Connection page."""
import inspect
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QCheckBox, QLineEdit, QPushButton

    import helper_pages
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


def make_state(**overrides):
    values = dict(
        site_url="https://example.test",
        token="project-token",
        journal_path="/journals",
        raven_key="rcc",
        edsm_key="edsm",
        edsm_name="CMDR One",
        eddn_enabled=False,
        inara_key="inara",
        inara_name="CMDR Two",
    )
    values.update(overrides)
    return helper_pages.AuthPageState(**values)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class AuthPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.calls = []
        actions = helper_pages.AuthPageActions(
            open_tokens=lambda: self.calls.append("tokens"),
            change_server=lambda: self.calls.append("server"),
            validate_token=lambda: self.calls.append("validate"),
            paste_token=lambda: self.calls.append("paste"),
            capi_link=lambda: self.calls.append("capi_link"),
            capi_fetch=lambda: self.calls.append("capi_fetch"),
            browse_journal=lambda: self.calls.append("browse"),
            save_edsm=lambda: self.calls.append("save_edsm"),
            save_inara=lambda: self.calls.append("save_inara"),
            check_raven=lambda: self.calls.append("check_raven"),
            eddn_toggle=lambda checked: self.calls.append(("eddn", checked)),
        )
        self.page = helper_pages.AuthPage(make_state(), actions)
        self.page.show()
        self.app.processEvents()

    def tearDown(self):
        self.page.deleteLater()

    # ------------------------------------------------------------- structure
    def test_page_is_built_from_native_inputs(self):
        for name in ("token_entry", "raven_key_entry", "edsm_key_entry", "edsm_name_entry",
                     "inara_key_entry", "inara_name_entry", "path_entry"):
            self.assertIsInstance(getattr(self.page, name), QLineEdit, name)
        self.assertIsInstance(self.page.eddn_enabled_var, QCheckBox)
        for name in ("capi_link_btn", "capi_fetch_btn", "toggle_token_btn"):
            self.assertIsInstance(getattr(self.page, name), QPushButton, name)

    def test_initial_values_come_from_the_application_state(self):
        self.assertEqual(self.page.token_entry.text(), "project-token")
        self.assertEqual(self.page.edsm_name_entry.text(), "CMDR One")
        self.assertEqual(self.page.path_entry.text(), "/journals")
        self.assertIn("example.test", self.page.server_label.text())
        self.assertFalse(self.page.eddn_enabled_var.isChecked())

    def test_secrets_are_masked_until_the_user_reveals_them(self):
        self.assertTrue(self.page.token_is_hidden())
        self.assertEqual(self.page.toggle_token_btn.text(), "Показать")
        self.page.toggle_token_btn.click()
        self.app.processEvents()
        self.assertFalse(self.page.token_is_hidden())
        self.assertEqual(self.page.toggle_token_btn.text(), "Скрыть")
        self.page.toggle_token_btn.click()
        self.assertTrue(self.page.token_is_hidden())

    # --------------------------------------------------------------- actions
    def test_buttons_call_the_application_handlers(self):
        def click(label_text):
            for button in self.page.findChildren(QPushButton):
                if button.text() == label_text:
                    button.click()
                    self.app.processEvents()
                    return
            self.fail(f"кнопка не найдена: {label_text}")

        click("Проверить токен")
        click("Вставить из буфера")
        click("Открыть Frontier CAPI на сайте")
        click("Обновить досье")
        click("Обзор...")
        click("Сохранить EDSM настройки")
        click("Сохранить Inara настройки")
        click("Проверить ключ")
        self.assertEqual(self.calls, ["validate", "paste", "capi_link", "capi_fetch",
                                      "browse", "save_edsm", "save_inara", "check_raven"])

    def test_eddn_toggle_reports_the_new_state(self):
        self.page.eddn_enabled_var.setChecked(True)
        self.app.processEvents()
        self.assertEqual(self.calls, [("eddn", True)])

    # ---------------------------------------------------------------- status
    def test_status_labels_update_through_one_setter(self):
        self.page.set_auth_result("✓ Подключено как CMDR One", "#65c78a")
        self.page.capi_status.set_status("Frontier не привязан", "#a1a8ad")
        self.page.raven_status_label.set_status("Raven Colonial: подключено", "#65c78a")
        self.assertIn("CMDR One", self.page.auth_result.text())
        self.assertIn("#65c78a", self.page.auth_result.styleSheet())
        self.assertIn("не привязан", self.page.capi_status.text())

    def test_site_error_is_shown_only_when_present(self):
        self.assertFalse(self.page.site_error_label.isVisible())
        page = helper_pages.AuthPage(make_state(site_error="сервер не отвечает"),
                                     helper_pages.AuthPageActions())
        page.show()
        self.app.processEvents()
        self.assertTrue(page.site_error_label.isVisible())
        page.deleteLater()


class AuthPageIntegrationTests(unittest.TestCase):
    def test_helper_no_longer_builds_tk_inputs_for_the_connection_tab(self):
        import colonial_helper

        source = inspect.getsource(colonial_helper.ColonialHelperApp._build_tab_auth)
        for legacy in ("tb.Entry", "tb.Button", "tb.Label", "tb.Checkbutton", "pack("):
            self.assertNotIn(legacy, source)
        self.assertIn("AuthPage", source)
        self.assertIn("AuthPageActions", source)

    def test_helper_keeps_the_attribute_names_used_by_the_rest_of_the_program(self):
        import colonial_helper

        source = inspect.getsource(colonial_helper.ColonialHelperApp._build_tab_auth)
        for name in ("token_entry", "auth_result", "capi_status", "path_entry",
                     "raven_key_entry", "edsm_key_entry", "inara_key_entry",
                     "eddn_enabled_var"):
            self.assertIn(f"self.{name} = ", source)


if __name__ == "__main__":
    unittest.main()
