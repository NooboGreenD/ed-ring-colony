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

    # -- дерево тел и панель экзобиологии -----------------------------------
    def test_exobio_treeview_exists_and_configured(self):
        self.assertTrue(hasattr(self.app, "exobio_tree"))
        self.assertTrue(hasattr(self.app, "exobio_system_label"))
        self.assertTrue(hasattr(self.app, "exobio_summary_label"))

    def test_update_tab_exobio_populates_treeview_and_labels(self):
        from test_exobiology import scan_event

        self.app.exobiology.handle({"event": "FSDJump", "StarSystem": "HIP 12345"})
        self.app.exobiology.handle(scan_event())
        self.app.exobiology.handle({
            "event": "FSSBodySignals",
            "StarSystem": "HIP 12345",
            "BodyName": "HIP 12345 A 3",
            "Signals": [{"Type": "$SAA_SignalType_Biological;", "Count": 3}],
        })

        self.app.exobio_tree.insert.reset_mock()
        self.app._update_tab_exobio()

        # Проверяем обновление подписей
        sys_calls = [str(call) for call in self.app.exobio_system_label.config.call_args_list]
        self.assertTrue(any("HIP 12345" in call for call in sys_calls))

        summary_calls = [str(call) for call in self.app.exobio_summary_label.config.call_args_list]
        self.assertTrue(any("Тел отсканировано: 1" in call for call in summary_calls))
        self.assertTrue(any("Всего биосигналов: 3" in call for call in summary_calls))

        # Проверяем вставку строк в дерево
        inserted_values = [call.kwargs.get("values") for call in self.app.exobio_tree.insert.call_args_list]
        self.assertEqual(len(inserted_values), 1)
        self.assertEqual(inserted_values[0][0], "A 3")
        self.assertEqual(inserted_values[0][4], "3")  # биосигналы

    def test_overlay_state_with_cached_system_bodies(self):
        # Если в памяти тел нет, но они есть в кэше — _exobiology_overlay_state подтягивает их
        self.app.exobiology.current_system = "CacheSys"
        self.app.exobio_cache.store_system("CacheSys", {
            "CacheSys 1": {
                "body_name": "CacheSys 1",
                "planet_class": "Rocky body",
                "atmosphere": "thin carbon dioxide atmosphere",
                "atmosphere_category": "carbon_dioxide",
                "landable": True,
                "bio_signals": 2,
            }
        }, known_body_count=5)

        state = self.app._exobiology_overlay_state()
        self.assertIsNotNone(state)
        self.assertEqual(state["system"], "CacheSys")
        self.assertEqual(state["system_known_bodies"], 5)
        self.assertEqual(state["system_scanned_bodies"], 1)
        self.assertEqual(len(state["system_bodies"]), 1)
        self.assertEqual(state["system_bodies"][0]["body"], "CacheSys 1")

    def test_notebook_tab_change_refreshes_exobio_tab(self):
        with mock.patch.object(self.app, "_update_tab_exobio") as update_mock:
            self.app.notebook.select = mock.MagicMock(return_value=str(self.app.tab_exobio))
            self.app._on_notebook_tab_changed(None)
            update_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
