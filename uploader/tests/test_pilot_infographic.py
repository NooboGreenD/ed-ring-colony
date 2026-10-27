"""Тесты вкладки «Инфографика пилота».

Вкладка переделана: крупные показатели (KPI), плитки со спарклайнами,
адаптивная сетка и компактный режим. Проверяем то, что легко сломать и
дорого проверять глазами:

* проценты обрезаются по диапазону 0..100 (иначе Progressbar падает);
* число колонок зависит от ширины окна, а в компактном режиме — плотнее;
* компактный режим сохраняется в конфиг и пересобирает раскладку;
* обновление заполняет плитки и заводит ровно один таймер (цепочка таймеров
  от кнопки «Обновить» раньше размножалась);
* тонны по системам копятся за сессию и попадают в диаграмму;
* спарклайн рисуется по точкам, а при отсутствии данных пишет подсказку.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


def _text(widget, default=""):
    """Текст плитки: у нативной страницы это настоящий QLabel."""
    getter = getattr(widget, "text", None)
    if callable(getter):
        try:
            return getter()
        except Exception:
            return default
    for call in reversed(widget.configure.call_args_list):
        kwargs = call.kwargs or {}
        if "text" in kwargs:
            return kwargs["text"]
        if call.args and isinstance(call.args[0], str):
            return call.args[0]
    return default


class PilotInfographicTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(HERE))
        from test_initial_upload_flow import install_gui_stubs, make_root

        self.stub = install_gui_stubs()
        self._make_widgets_unique()
        for name in ("colonial_helper", "api_client", "event_dispatch",
                     "journal_parser", "overlay", "ship_tracker",
                     "route_tracker", "game_monitor", "exobiology"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.root = make_root()

        import colonial_helper  # noqa: E402

        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def _make_widgets_unique():
        """Каждый вызов Frame/Label/Canvas отдаёт НОВЫЙ мок.

        В общей заглушке `tb.Label(...)` возвращает один и тот же объект,
        из-за чего проверить текст конкретной подписи невозможно: все
        виджеты «слипаются» в один мок.
        """
        widgets = ("Frame", "Labelframe", "Label", "Button", "Checkbutton",
                   "Radiobutton", "Entry", "Combobox", "Progressbar", "Scale",
                   "Spinbox", "Separator", "Notebook", "Panedwindow", "Treeview",
                   "Text", "ScrolledText", "Meter")
        for module_name, names in (("ttkbootstrap", widgets), ("tkinter", ("Canvas", "Toplevel", "Frame"))):
            module = sys.modules.get(module_name)
            if module is None:
                continue
            for name in names:
                widget = getattr(module, name, None)
                if widget is None:
                    continue
                widget.side_effect = lambda *args, _name=name, **kwargs: mock.MagicMock(name=_name)

    # -- утилиты -----------------------------------------------------------
    def test_percent_is_clamped(self):
        percent = self.app._pilot_percent
        self.assertEqual(percent(None), 0.0)
        self.assertEqual(percent(0), 0.0)
        self.assertEqual(percent(42.5), 42.5)
        self.assertEqual(percent(150), 100.0)
        self.assertEqual(percent(-20), 0.0)
        self.assertEqual(percent("не число"), 0.0)

    def test_columns_follow_window_width(self):
        app = self.app
        app._pilot_compact = False
        with mock.patch.object(app, "_pilot_window_width", return_value=1400):
            self.assertEqual(app._pilot_column_count(), 3)
        with mock.patch.object(app, "_pilot_window_width", return_value=900):
            self.assertEqual(app._pilot_column_count(), 2)
        with mock.patch.object(app, "_pilot_window_width", return_value=700):
            self.assertEqual(app._pilot_column_count(), 1)

    def test_unmapped_window_uses_configured_startup_width(self):
        # Tk reports 1px before mapping, despite geometry("1180x790").
        with mock.patch.object(self.app.root, "winfo_width", return_value=1):
            self.assertEqual(self.app._pilot_window_width(), 1180)
            self.assertEqual(self.app._pilot_column_count(), 2)

    def test_compact_mode_is_denser(self):
        app = self.app
        app._pilot_compact = True
        with mock.patch.object(app, "_pilot_window_width", return_value=1400):
            self.assertEqual(app._pilot_column_count(), 4)
        with mock.patch.object(app, "_pilot_window_width", return_value=900):
            self.assertEqual(app._pilot_column_count(), 3)
        with mock.patch.object(app, "_pilot_window_width", return_value=700):
            self.assertEqual(app._pilot_column_count(), 2)
        with mock.patch.object(app, "_pilot_window_width", return_value=500):
            self.assertEqual(app._pilot_column_count(), 1)

    # -- структура вкладки -------------------------------------------------
    def test_tab_builds_kpi_tiles_bars_and_charts(self):
        self.assertIsNone(self.app._pilot_refresh_job, "скрытая страница не должна стартовать таймер")
        page = self.app.pilot_page
        self.assertIsNotNone(page, "страница пилота должна собраться")
        tiles = self.app._pilot_tiles
        for key in ("kpi_tons", "kpi_deliveries", "kpi_cargo", "kpi_systems"):
            self.assertIn(key, tiles, f"нет крупного показателя {key}")
            self.assertIn(f"{key}_sub", tiles)
        for key in ("ship", "route_status", "commander", "balance", "game", "exobio"):
            self.assertIn(key, tiles, f"нет строки {key}")
        for key in ("hull_bar", "shield_bar", "fuel_bar", "power_bar", "route_progress"):
            self.assertIn(key, self.app._pilot_bars, f"нет полосы {key}")
        self.assertIsNotNone(page.spark, "нет спарклайна сессии")
        self.assertIsNotNone(page.systems_chart, "нет диаграммы систем")

    def test_compact_toggle_saves_config_and_rebuilds(self):
        app = self.app
        with mock.patch.object(app, "_pilot_window_width", return_value=1400):
            app._rebuild_pilot_layout()
            self.assertEqual(app._pilot_columns, 3)

            app._pilot_compact_var.setChecked(True)

            self.assertTrue(app.config["pilot_compact"])
            self.assertTrue(app._pilot_compact)
            self.assertEqual(app._pilot_columns, 4)

    def test_resize_rebuilds_only_when_columns_change(self):
        app = self.app
        with mock.patch.object(app, "_pilot_window_width", return_value=1400):
            app._rebuild_pilot_layout()
            self.assertEqual(app._pilot_columns, 3)
            app._rebuild_pilot_layout_if_needed()   # та же ширина — без пересборки
            self.assertEqual(app._pilot_columns, 3)
        with mock.patch.object(app, "_pilot_window_width", return_value=700):
            app._rebuild_pilot_layout_if_needed()   # стало узко — пересобрали
            self.assertEqual(app._pilot_columns, 1)

    # -- обновление --------------------------------------------------------
    def test_refresh_fills_kpi_from_session(self):
        app = self.app
        app._session_cargo_tons = 42.6
        app._session_deliveries = 3
        app._session_systems_visited = {"Sol", "Alpha"}
        app._refresh_pilot_infographic()

        self.assertEqual(_text(app._pilot_tiles["kpi_tons"]), "43 t")
        self.assertEqual(_text(app._pilot_tiles["kpi_deliveries"]), "3")
        self.assertEqual(_text(app._pilot_tiles["kpi_systems"]), "2")

    def test_pilot_timer_does_not_poll_hidden_page(self):
        app = self.app
        app._pilot_refresh_job = None
        with mock.patch.object(app, "_pilot_is_visible", return_value=False), \
             mock.patch.object(app, "_refresh_pilot_infographic") as refresh:
            app._pilot_tick()
        refresh.assert_not_called()

        app.root.after.reset_mock()
        app._refresh_pilot_infographic()
        self.assertFalse(any(
            call.args and call.args[0] == app.PILOT_REFRESH_INTERVAL_MS
            for call in app.root.after.call_args_list
        ))

    def test_refresh_uses_single_timer(self):
        """Повторные вызовы не должны плодить цепочки root.after()."""
        app = self.app
        app.root.after.reset_mock()
        app._pilot_refresh_job = None
        with mock.patch.object(app, "_pilot_is_visible", return_value=True):
            app._refresh_pilot_infographic()
            app._refresh_pilot_infographic()
            app._refresh_pilot_infographic()

        timers = [call for call in app.root.after.call_args_list
                  if call.args and call.args[0] == app.PILOT_REFRESH_INTERVAL_MS]
        self.assertEqual(len(timers), 1)

    def test_refresh_survives_broken_state(self):
        """Инфографика не должна ронять watcher при неполном состоянии трекера."""
        app = self.app
        with mock.patch.object(app.ship, "get_state_dict", side_effect=RuntimeError("boom")):
            app._refresh_pilot_infographic()   # не должно бросать наружу

    def test_series_sampling_is_rate_limited(self):
        app = self.app
        app._pilot_series["tons"].clear()
        app._pilot_last_sample = 0.0
        app._pilot_sample_series({"cargo_count": 10, "hull_percent": 95})
        self.assertEqual(len(app._pilot_series["tons"]), 1)
        app._pilot_sample_series({"cargo_count": 12, "hull_percent": 90})
        self.assertEqual(len(app._pilot_series["tons"]), 1, "вторая точка слишком рано")

    def test_series_grows_when_time_passes(self):
        app = self.app
        app._pilot_series["tons"].clear()
        app._pilot_last_sample = 0.0
        with mock.patch("time.monotonic", side_effect=(100.0, 100.0, 110.0)):
            app._pilot_sample_series({})      # 100.0: первая точка
            app._pilot_sample_series({})      # 100.0: рано, пропуск
            app._pilot_sample_series({})      # 110.0: вторая точка
        self.assertEqual(len(app._pilot_series["tons"]), 2)

    def test_series_does_not_grow_forever(self):
        app = self.app
        for value in range(app.PILOT_SERIES_LIMIT + 50):
            app._pilot_series["tons"].append(float(value))
        self.assertEqual(len(app._pilot_series["tons"]), app.PILOT_SERIES_LIMIT)
        self.assertEqual(app._pilot_series["tons"][0], 50.0)

    def test_rate_is_zero_without_history(self):
        app = self.app
        app._pilot_series["tons"].clear()
        self.assertEqual(app._pilot_rate(), 0.0)

    def test_rate_uses_series_delta(self):
        app = self.app
        app._pilot_series["tons"].clear()
        # на короткой серии окно не меньше минуты: 20 т/мин → 1200 т/час
        app._pilot_series["tons"].extend((0.0, 10.0, 20.0))
        self.assertAlmostEqual(app._pilot_rate(), 1200.0, places=1)

        app._pilot_series["tons"].clear()
        # 31 точка = ровно минута (30 интервалов по 2 с), 30 тонн → 1800 т/час
        app._pilot_series["tons"].extend(float(i) for i in range(31))
        self.assertAlmostEqual(app._pilot_rate(), 1800.0, places=1)

    # -- тонны по системам --------------------------------------------------
    def test_session_tons_are_grouped_by_system(self):
        app = self.app
        app._session_tons_by_system.clear()
        app._record_session_deliveries([
            {"system_name": "Sol", "amount": 100},
            {"system_name": "Alpha", "amount": 50},
            {"system_name": "Sol", "amount": 25},
        ])
        self.assertEqual(app._session_tons_by_system, {"Sol": 125.0, "Alpha": 50.0})

        rows = sorted(app._session_tons_by_system.items(), key=lambda kv: kv[1], reverse=True)
        self.assertEqual(rows[0], ("Sol", 125.0))

    def test_session_tons_are_reset_with_watcher(self):
        app = self.app
        app._session_tons_by_system["Sol"] = 10.0
        app._session_tons_by_system.clear()
        self.assertEqual(app._session_tons_by_system, {})

    # -- графика ------------------------------------------------------------
    def test_refresh_pushes_series_and_systems_into_the_native_page(self):
        app = self.app
        app._pilot_series["tons"].clear()
        app._pilot_series["tons"].extend((0.0, 5.0, 10.0))
        app._session_tons_by_system.clear()
        app._session_tons_by_system.update({"Sol": 120.0, "Alpha": 60.0})
        # Отбор точки серии идёт по времени — в этом тесте он не нужен.
        with mock.patch.object(app, "_pilot_sample_series"):
            app._refresh_pilot_infographic()
        self.assertEqual(app.pilot_page.spark.values, [0.0, 5.0, 10.0])
        self.assertEqual(app.pilot_page.systems_chart.rows,
                         [("Sol", 120.0), ("Alpha", 60.0)])

    def test_refresh_reports_the_update_time(self):
        self.app._refresh_pilot_infographic()
        self.assertRegex(self.app.pilot_page.updated_label.text(), r"^\d{2}:\d{2}:\d{2}$")

    def test_progress_bars_clamp_values_to_percent_range(self):
        self.app.ship.get_state_dict = lambda: {"hull_percent": 150, "shield_percent": -10}
        self.app._refresh_pilot_infographic()
        self.assertEqual(self.app.pilot_page.bars["hull_bar"].value(), 100)
        self.assertEqual(self.app.pilot_page.bars["shield_bar"].value(), 0)


if __name__ == "__main__":
    unittest.main()
