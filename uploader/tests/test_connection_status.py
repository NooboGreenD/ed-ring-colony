"""Регрессии вкладки «Подключение»: состояние связи, проверки и фоновые тики.

Три жалобы после перехода Helper на Qt проверяются здесь как факты:

* строка «Подключено / Не подключено» не показывалась и не обновлялась —
  `set_connection_status` писал в Tk-виджеты, которых в Qt-оболочке нет;
* кнопка «Проверить токен» ничего не делала, а ключ Raven Colonial вечно
  висел на «проверка…»: результат из рабочего потока возвращался через
  `root.after(0, …)`, а тот создавал `QTimer` прямо в этом потоке, и Qt
  отказывался запускать таймер;
* вместе с индикатором игры молча перестали обновляться груз авианосца и
  проекты колонизатора — они идут в том же тике, ниже упавшей строки.
"""
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import QCoreApplication

    import colonial_helper
    import helper_window
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


def _wait(app, predicate, timeout=5.0):
    """Крутить очередь событий, пока условие не выполнится."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        app.processEvents()
        if predicate():
            return True
        time.sleep(0.01)
    app.processEvents()
    return bool(predicate())


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class DeferredCallTests(unittest.TestCase):
    """`after()` вызывается из фоновых потоков — и обязан их обслуживать."""

    def setUp(self):
        self.app = ensure_app()
        self.window = helper_window.HelperWindow("test")
        self.addCleanup(self.window.deleteLater)

    def test_callback_from_worker_thread_runs(self):
        seen = []
        worker = threading.Thread(
            target=lambda: self.window.after(0, lambda: seen.append("done")))
        worker.start()
        worker.join(5)
        self.assertTrue(_wait(self.app, lambda: seen), "колбэк из потока не выполнился")
        self.assertEqual(seen, ["done"])

    def test_cancelled_deferred_call_from_worker_thread_is_dropped(self):
        seen = []
        worker = threading.Thread(
            target=lambda: self.window.after_cancel(
                self.window.after(0, lambda: seen.append("late"))))
        worker.start()
        worker.join(5)
        _wait(self.app, lambda: False, timeout=0.2)
        self.assertEqual(seen, [], "отменённый вызов выполнился")

    def test_deferred_call_runs_on_the_gui_thread(self):
        seen = []

        def record():
            seen.append(threading.current_thread() is threading.main_thread())

        worker = threading.Thread(target=lambda: self.window.after(0, record))
        worker.start()
        worker.join(5)
        self.assertTrue(_wait(self.app, lambda: seen))
        self.assertEqual(seen, [True], "колбэк выполнился не в потоке окна")


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class ConnectionStatusTests(unittest.TestCase):
    """Строка состояния и подпись на вкладке обязаны отражать связь с сайтом."""

    def setUp(self):
        from test_initial_upload_flow import install_gui_stubs

        install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch",
                     "journal_parser", "overlay", "ship_tracker", "route_tracker",
                     "game_monitor", "exobiology"):
            sys.modules.pop(name, None)

        self.app_module = __import__("colonial_helper")
        self.app = ensure_app()
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.window = helper_window.HelperWindow("test")
        self.addCleanup(self.window.deleteLater)
        with mock.patch.object(self.app_module, "DEFAULT_JOURNAL_PATH", self.home), \
                mock.patch.object(self.app_module.ColonialHelperApp, "save_config"), \
                mock.patch("pathlib.Path.home", return_value=self.home):
            self.helper = self.app_module.ColonialHelperApp(self.window)

    def tearDown(self):
        try:
            self.tmp.cleanup()
        except OSError:
            pass

    # -- строка состояния ---------------------------------------------------
    def test_connection_status_updates_shell_and_page(self):
        self.helper.set_connection_status(True, "CMDR TEST")
        self.assertEqual(self.helper.shell.connection(), (True, "CMDR TEST"))
        self.assertIn("CMDR TEST", self.helper.auth_result.text())

        self.helper.set_connection_status(False, "Сервер обновлений недоступен")
        online, detail = self.helper.shell.connection()
        self.assertFalse(online)
        self.assertIn("недоступен", detail)
        self.assertIn("✗", self.helper.auth_result.text(),
                      "настоящий отказ помечается красным крестом")

    def test_startup_state_is_visible_without_network(self):
        """Пустое поле токена — тоже состояние, и оно должно быть видно."""
        online, detail = self.helper.shell.connection()
        self.assertFalse(online)
        self.assertTrue(detail, "подробность пустая: непонятно, ждать ли проверки")
        self.assertTrue(self.helper.auth_result.text())

    # -- проверка токена ----------------------------------------------------
    def test_token_check_finishes_and_reports_success(self):
        api = self.helper.api
        self.helper.api.validate_token = lambda token: {"ok": True}
        self.helper.token_entry.setText("token")
        self.helper.log = lambda *a, **k: None
        with mock.patch.object(type(api), "is_connected",
                               new_callable=mock.PropertyMock, return_value=True), \
                mock.patch.object(type(api), "display_name",
                                  new_callable=mock.PropertyMock, return_value="CMDR TEST"):
            self.helper._on_validate_token()
            self.assertTrue(
                _wait(self.app, lambda: not self.helper._token_check_busy),
                "флаг проверки не снялся: кнопка «Проверить токен» осталась мертвой")
            self.assertIn("CMDR TEST", self.helper.auth_result.text())
            self.assertTrue(self.helper.shell.connection()[0])

    def test_token_check_failure_is_shown(self):
        self.helper.api.validate_token = lambda token: {"ok": False,
                                                        "error": "Токен неверный"}
        self.helper.token_entry.setText("token")
        self.helper.log = lambda *a, **k: None

        self.helper._on_validate_token()
        self.assertTrue(_wait(self.app, lambda: not self.helper._token_check_busy))
        self.assertIn("Токен неверный", self.helper.auth_result.text())

    def test_busy_flag_is_released_even_if_result_handler_breaks(self):
        self.helper.api.validate_token = lambda token: {"ok": True}
        self.helper.token_entry.setText("token")
        self.helper.log = lambda *a, **k: None
        # Qt печатает исключение из слота через sys.excepthook — в тесте это
        # ожидаемый сбой, поэтому вывод глушим, а не «лечим» его.
        original_hook = sys.excepthook
        sys.excepthook = lambda *args: None
        self.addCleanup(setattr, sys, "excepthook", original_hook)
        with mock.patch.object(type(self.helper), "_apply_token_result",
                               side_effect=RuntimeError("boom")):
            self.helper._on_validate_token()
            self.assertTrue(_wait(self.app, lambda: not self.helper._token_check_busy))

    # -- Raven --------------------------------------------------------------
    def test_raven_check_stops_at_a_result(self):
        self.helper.raven_api.get_cmdr_by_key = lambda key: {"ok": True}
        self.helper.raven_api.cmdr_display_name = lambda result: "CMDR TEST"
        self.helper.raven_key_entry.setText("rcc-key")
        self.helper.log = lambda *a, **k: None
        self.helper.save_config = lambda *a, **k: None
        self.helper._update_colony_key_label = lambda *a, **k: None
        self.helper._apply_rcc_commander = lambda *a, **k: None
        self.helper._flush_raven_deliveries = lambda *a, **k: None

        self.helper._on_check_raven()
        self.assertTrue(
            _wait(self.app, lambda: "подключено" in self.helper.raven_status_label.text()),
            "проверка ключа Raven Colonial не завершилась")

    def test_raven_network_failure_is_reported_not_stuck(self):
        def boom(key):
            raise RuntimeError("network down")

        self.helper.raven_api.get_cmdr_by_key = boom
        self.helper.raven_key_entry.setText("rcc-key")
        self.helper.log = lambda *a, **k: None
        self.helper.save_config = lambda *a, **k: None
        self.helper._update_colony_key_label = lambda *a, **k: None

        self.helper._on_check_raven()
        self.assertTrue(
            _wait(self.app, lambda: "проверка" not in self.helper.raven_status_label.text()),
            "сбой сети оставил вечную «проверку…»")

    # -- тик индикатора игры ------------------------------------------------
    def test_game_tick_reaches_other_refreshes(self):
        """Раньше тик падал на `game_dot.config(...)` и обрывал всё после."""
        calls = []
        self.helper._refresh_carrier_cargo = lambda *a, **k: calls.append("cargo")
        self.helper._refresh_site_project = lambda *a, **k: calls.append("site")
        self.helper._refresh_primary_project = lambda *a, **k: calls.append("primary")
        self.helper._update_layout_info = lambda *a, **k: calls.append("layout")
        self.helper.after = lambda ms, callback: None        # не зацикливаем тик

        self.helper._tick_game_status()

        self.assertEqual(calls, ["layout", "cargo", "site", "primary"])
        self.assertTrue(self.helper.shell.game_state().startswith("Игра:"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
