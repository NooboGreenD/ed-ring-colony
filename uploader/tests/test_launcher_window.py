"""Headless Qt tests for the Launcher start screen.

These run the real widgets through the offscreen platform plugin: no Tk
emulation, no manual clicking. Skipped automatically when PySide6 or its
libraries are unavailable on the machine running the tests.
"""
import json
import os
import re
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import Qt
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QLabel

    import launcher_settings
    import launcher_window
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


def wait_until(app, predicate, timeout_ms=4000):
    """Spin the Qt event loop until the condition holds or time runs out."""
    elapsed = 0
    while elapsed < timeout_ms:
        app.processEvents()
        if predicate():
            return True
        QTest.qWait(10)
        elapsed += 10
    app.processEvents()
    return predicate()


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class LauncherWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = self.root / ".colonial_helper.json"
        self.fetch_calls = []

    def tearDown(self):
        # Язык процесса общий для всех окон: тест не должен оставлять его
        # включённым для следующих проверок.
        import i18n

        i18n.set_locale("ru")
        self.temp.cleanup()

    def _window(self, *, fetcher=None, autostart=False):
        def default_fetcher(locale=None, **_kwargs):
            self.fetch_calls.append((locale, threading.current_thread().name))
            return {"news": [], "galnet": []}

        window = launcher_window.LauncherWindow(
            self.root, "1.2.0", "stable",
            settings_path=self.settings,
            fetcher=fetcher or default_fetcher,
            autostart=autostart)
        window.show()
        self.app.processEvents()
        return window

    # ------------------------------------------------------------------ frame
    def test_window_is_visible_with_custom_frameless_title_bar(self):
        window = self._window()
        self.assertTrue(window.isVisible())
        self.assertTrue(window.windowFlags() & Qt.WindowType.FramelessWindowHint)
        self.assertEqual(window.titlebar.title.text(), window.windowTitle())
        self.assertTrue(window.titlebar.close_button.isVisible())
        window.close()

    # --------------------------------------------------------------- language
    def test_every_project_language_is_offered_and_persisted(self):
        from locale_config import SUPPORTED_LOCALES

        self.settings.write_text(json.dumps({"token": "secret", "update_channel": "beta"}),
                                 encoding="utf-8")
        window = self._window()
        offered = [window.locale_combo.itemData(index)
                   for index in range(window.locale_combo.count())]
        self.assertEqual(offered, list(SUPPORTED_LOCALES))
        window.locale_combo.setCurrentIndex(window.locale_combo.findData("ja"))
        self.app.processEvents()

        saved = json.loads(self.settings.read_text(encoding="utf-8"))
        self.assertEqual(saved["site_locale"], "ja")
        self.assertEqual(saved["token"], "secret")
        self.assertEqual(saved["update_channel"], "beta")
        self.assertEqual(stat.S_IMODE(self.settings.stat().st_mode), 0o600)
        window.close()

    def test_switching_language_retranslates_the_window_at_once(self):
        import i18n

        launcher_settings.save_site_locale("en", self.settings)
        window = self._window()
        self.assertEqual(window.launch_button.text(), "▶   Launch Colonial Helper")
        self.assertEqual(window.titlebar.title.text(), window.windowTitle())
        self.assertIn("INTERFACE", window.locale_label.text())

        window.locale_combo.setCurrentIndex(window.locale_combo.findData("de"))
        self.app.processEvents()

        self.assertEqual(i18n.current_locale(), "de")
        self.assertEqual(window.launch_button.text(), "▶   Colonial Helper starten")
        self.assertIn("SPRACHE VON OBERFLÄCHE", window.locale_label.text())
        self.assertIn("signiert", window.update_detail.text())
        # В окне не должно остаться ни одной русской подписи: язык меняется
        # целиком, а не только там, где о нём вспомнили.
        russian = [item.text() for item in window.findChildren(QLabel)
                   if item.text() and re.search("[А-Яа-яЁё]", item.text())]
        self.assertEqual(russian, [])
        # Лента могла успеть загрузиться или ещё грузиться — важен язык, а не
        # конкретное состояние связи.
        self.assertIn(window.connection_indicator.text(),
                      {"●  OFFLINE-START MÖGLICH", "●  SEITE VERBUNDEN",
                       "●  NACHRICHTEN NICHT ERREICHBAR"})
        window.close()

    def test_saved_language_is_restored_on_the_next_start(self):
        launcher_settings.save_site_locale("de", self.settings)
        window = self._window()
        self.assertEqual(window.site_locale, "de")
        self.assertEqual(window.locale_combo.currentData(), "de")
        window.close()

    # ------------------------------------------------------------------- feed
    def test_articles_are_rendered_and_tabs_switch_between_news_and_galnet(self):
        window = self._window()
        window._news_loaded({
            "news": [{"id": "1", "nid": "", "title": "Новость проекта",
                      "body": "<p>Текст <b>новости</b></p>", "published_at": "2026-10-25T12:00:00Z"}],
            "galnet": [{"id": "2", "nid": "galnet-1", "title": "Сообщение Galnet",
                        "body": "История", "published_at": ""}],
        })
        self.app.processEvents()
        self.assertEqual(self._titles(window), ["Новость проекта"])
        self.assertIn("1 новостей проекта", window.feed_status.text())
        self.assertIn("САЙТ ПОДКЛЮЧЁН", window.connection_indicator.text())

        window._select_tab("galnet")
        self.app.processEvents()
        self.assertEqual(self._titles(window), ["Сообщение Galnet"])
        self.assertTrue(window.tab_buttons["galnet"].isChecked())
        window.close()

    def test_failed_feed_keeps_offline_launch_available(self):
        window = self._window()
        window._news_failed(RuntimeError("сеть недоступна"))
        self.app.processEvents()
        self.assertIn("офлайн", window.feed_status.text())
        self.assertIn("НЕДОСТУПНЫ", window.connection_indicator.text())
        self.assertTrue(window.launch_button.isEnabled())
        self.assertEqual(window.last_error, "RuntimeError: сеть недоступна")
        window.close()

    def test_refresh_fetches_off_the_gui_thread_and_renders_result(self):
        payload = {"news": [{"id": "7", "title": "Свежая новость", "body": "Текст",
                             "published_at": "", "nid": ""}], "galnet": []}
        window = self._window(fetcher=lambda locale=None, **_kw: payload)
        window.refresh_news()
        self.assertTrue(wait_until(self.app, lambda: window.feed_loaded))
        self.assertEqual(self._titles(window), ["Свежая новость"])
        window.close()

    def test_empty_feed_explains_there_is_nothing_to_show(self):
        window = self._window()
        window._news_loaded({"news": [], "galnet": []})
        self.app.processEvents()
        self.assertIn("пуста", window.feed_status.text())
        window.close()

    # ---------------------------------------------------------------- actions
    def test_launch_button_requests_helper_start_and_closes_the_window(self):
        window = self._window()
        window.launch_button.click()
        self.app.processEvents()
        self.assertTrue(window.launch_requested)
        self.assertFalse(window.isVisible())
        window.deleteLater()

    def test_update_check_enables_install_with_the_offered_version(self):
        window = self._window()
        original_check = launcher_window.bundle_updater.check_for_update
        original_plan = launcher_window.bundle_updater.plan_update
        launcher_window.bundle_updater.check_for_update = lambda *a, **k: {
            "ok": True, "latest": "1.4.0", "update_available": True,
            "manifest": {"version": "1.4.0"},
        }
        launcher_window.bundle_updater.plan_update = lambda *a, **k: {
            "bytes": 2048, "download": ["a", "b"]}
        try:
            window.check_updates()
            self.assertTrue(wait_until(self.app, window.install_button.isEnabled))
            self.assertEqual(window.install_button.text(), "Установить v1.4.0")
            self.assertIn("2 файлов", window.update_detail.text())
        finally:
            launcher_window.bundle_updater.check_for_update = original_check
            launcher_window.bundle_updater.plan_update = original_plan
            window.close()

    def test_update_check_failure_is_reported_without_blocking_launch(self):
        window = self._window()
        original = launcher_window.bundle_updater.check_for_update

        def boom(*_args, **_kwargs):
            raise OSError("сервер недоступен")

        launcher_window.bundle_updater.check_for_update = boom
        try:
            window.check_updates()
            self.assertTrue(wait_until(
                self.app, lambda: "не удалась" in window.update_status.text()))
            self.assertIn("сервер недоступен", window.update_detail.text())
            self.assertTrue(window.launch_button.isEnabled())
            self.assertFalse(window.install_button.isEnabled())
        finally:
            launcher_window.bundle_updater.check_for_update = original
            window.close()

    @staticmethod
    def _titles(window):
        return [widget.text() for widget in window.feed_container.findChildren(QLabel)
                if widget.objectName() == "articleTitle"]


if __name__ == "__main__":
    unittest.main()
