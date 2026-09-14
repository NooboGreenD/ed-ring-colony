"""Тесты вкладки «Экзобиология»: фильтры EXOBIO на уровне приложения.

Проверяем связку «чекбокс на вкладке → настройки оверлея → состояние блока»:
именно её легко сломать, передав не тот ключ или забыв перерисовать блок.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from exobiology import PLANET_SEARCH_PRESETS  # noqa: E402


class ExobioTabTests(unittest.TestCase):
    def setUp(self):
        from test_initial_upload_flow import install_gui_stubs, make_root

        install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch", "journal_parser",
                     "overlay", "ship_tracker", "route_tracker", "game_monitor",
                     "exobiology", "colonisation", "carrier", "raven_colonial_api"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.root = make_root()

        import colonial_helper

        self.module = colonial_helper
        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    # -- вкладка собрана ----------------------------------------------------
    def test_tab_exists_with_all_presets_and_genera(self):
        self.assertTrue(hasattr(self.app, "tab_exobio"))
        preset_ids = {str(row.get("id")) for row in PLANET_SEARCH_PRESETS}
        self.assertEqual(set(self.app._exobio_planet_vars), preset_ids)
        # Список родов — вся таблица стоимости, иначе фильтр неполный.
        from exobiology import GENUS_VALUE_CR

        self.assertEqual(set(self.app._exobio_genus_vars), set(GENUS_VALUE_CR))

    def test_tab_is_added_to_notebook(self):
        texts = [call.kwargs.get("text") for call in self.app.notebook.add.call_args_list]
        self.assertIn(" Экзобиология ", texts)

    # -- чекбоксы доезжают до настроек --------------------------------------
    def test_checking_boxes_writes_settings(self):
        self.app._exobio_genus_vars["Osseus"].set(True)
        self.app._exobio_planet_vars["icy_land"].set(True)
        self.app.exobio_show_planets_var.set(True)
        self.app._on_exobio_filters_changed()

        settings = self.app.overlay_manager.settings
        self.assertEqual(settings["exobio_genera"], ["Osseus"])
        self.assertEqual(settings["exobio_planet_search"], ["icy_land"])
        self.assertTrue(settings["exobio_show_planet_search"])

    def test_unchecking_clears_settings(self):
        self.app._set_all_genera(True)
        self.assertTrue(self.app.overlay_manager.settings["exobio_genera"])
        self.app._set_all_genera(False)
        self.assertEqual(self.app.overlay_manager.settings["exobio_genera"], [])

        self.app._exobio_planet_vars["icy_land"].set(True)
        self.app._on_exobio_filters_changed()
        self.app._clear_planet_filters()
        self.assertEqual(self.app.overlay_manager.settings["exobio_planet_search"], [])

    # -- состояние оверлея ---------------------------------------------------
    def test_overlay_state_carries_filters_and_found_planets(self):
        from test_exobiology import scan_event

        self.app.exobiology.handle(scan_event())
        self.app._exobio_planet_vars["rocky_atmo_land"].set(True)
        self.app._exobio_genus_vars["Osseus"].set(True)
        self.app._on_exobio_filters_changed()

        state = self.app._exobiology_overlay_state()
        self.assertEqual(state["genera_filter"], ["Osseus"])
        self.assertEqual([row["id"] for row in state["planet_criteria"]], ["rocky_atmo_land"])
        self.assertEqual([row["body"] for row in state["planets"]], ["HIP 12345 A 3"])

    def test_disabled_planet_section_drops_criteria(self):
        from test_exobiology import scan_event

        self.app.exobiology.handle(scan_event())
        self.app._exobio_planet_vars["rocky_atmo_land"].set(True)
        self.app.exobio_show_planets_var.set(False)
        self.app._on_exobio_filters_changed()

        state = self.app._exobiology_overlay_state()
        self.assertEqual(state["planet_criteria"], [])
        self.assertEqual(state["planets"], [])

    def test_no_filters_no_planet_rows(self):
        from test_exobiology import scan_event

        self.app.exobiology.handle(scan_event())
        state = self.app._exobiology_overlay_state()
        self.assertEqual(state["planet_criteria"], [])
        self.assertEqual(state["planets"], [])

    # -- смена фильтра перерисовывает блок ----------------------------------
    def test_state_provider_is_wired(self):
        provider = self.app.overlay_manager._exobio_state_provider
        self.assertIsNotNone(provider)
        from test_exobiology import scan_event

        self.app.exobiology.handle(scan_event())
        state = provider()
        self.assertEqual(state["body"], "HIP 12345 A 3")

    def test_settings_are_saved_on_change(self):
        with mock.patch.object(self.app.overlay_manager, "save_settings") as save:
            self.app._exobio_planet_vars["icy_land"].set(True)
            self.app._on_exobio_filters_changed()
        save.assert_called_once()

    def test_save_failure_does_not_raise(self):
        with mock.patch.object(self.app.overlay_manager, "save_settings",
                               side_effect=OSError("нет доступа")):
            self.app._exobio_planet_vars["icy_land"].set(True)
            self.app._on_exobio_filters_changed()  # не должно бросить


if __name__ == "__main__":
    unittest.main(verbosity=2)
