"""Headless Qt tests for the «Путешествия» tab and the «Маршрут» section.

Страница ничего не считает: она рисует снимок `route_travel.travel_state`.
Поэтому тесты проверяют две вещи — что каждая кнопка зовёт своё действие и что
готовый снимок действительно доезжает до надписей, таблицы и полосы прогресса
(«в тестах зелено, а на экране прочерки» — известная болезнь миграции на Qt).
"""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QLabel, QPlainTextEdit, QProgressBar, QPushButton

    import helper_pages
    import i18n
    import route_travel
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


STATE = {
    "loaded": True,
    "status": "Следующая: Wolf 359 · осталось прыжков: 1",
    "follow": True,
    "progress": 66.7,
    "stats": {
        "visited": "2 из 3", "jumps_left": "1", "distance_left": "3.0 св. л.",
        "elapsed": "10 мин", "tempo": "5 мин", "eta": "около 21:34",
    },
    "info": {
        "star": "M · заправка есть", "jump": "3.0 св. л.",
        "construction": "42% готово · осталось 1200 т",
        "discoverer": "Someone", "bodies": "12 тел",
    },
    "upcoming": [(1, "Wolf 359", "3.0 св. л.")],
    "next": "Wolf 359",
    "note": "Слежение включено: имя следующей системы копируется в буфер обмена.",
}


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class TravelPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        i18n.set_locale("ru")
        self.events = []
        self.actions = helper_pages.TravelPageActions(
            paste_route=lambda: self.events.append("paste"),
            load_file=lambda: self.events.append("load"),
            follow_changed=lambda value: self.events.append(("follow", value)),
            copy_next=lambda: self.events.append("copy"),
            refresh_info=lambda: self.events.append("info"),
            restart=lambda: self.events.append("restart"),
            clear=lambda: self.events.append("clear"),
        )
        self.page = helper_pages.TravelPage(self.actions)

    def tearDown(self):
        import i18n

        i18n.set_locale("ru")

    # ------------------------------------------------------------- structure
    def test_keeps_the_attribute_names_the_app_uses(self):
        for name in ("route_input", "paste_btn", "load_btn", "copy_btn", "info_btn",
                     "restart_btn", "clear_btn", "follow_check", "status_label",
                     "progress", "table", "note_label"):
            self.assertTrue(hasattr(self.page, name), name)
        self.assertIsInstance(self.page.route_input, QPlainTextEdit)
        self.assertIsInstance(self.page.progress, QProgressBar)
        self.assertEqual(self.page.table.columnCount(), 3)

    def test_buttons_fire_their_callbacks(self):
        for button in (self.page.paste_btn, self.page.load_btn, self.page.copy_btn,
                       self.page.info_btn, self.page.restart_btn, self.page.clear_btn):
            self.assertIsInstance(button, QPushButton)
            button.click()
        self.assertEqual(self.events, ["paste", "load", "copy", "info", "restart", "clear"])

    def test_missing_callbacks_do_not_crash(self):
        page = helper_pages.TravelPage(helper_pages.TravelPageActions())
        for button in (page.paste_btn, page.load_btn, page.copy_btn, page.info_btn,
                       page.restart_btn, page.clear_btn):
            button.click()
        page.follow_check.setChecked(True)

    def test_follow_switch_reports_its_state(self):
        self.page.follow_check.setChecked(True)
        self.assertEqual(self.events[-1], ("follow", True))
        self.assertTrue(self.page.is_following())

    def test_set_following_does_not_call_back(self):
        self.page.set_following(True)
        self.assertTrue(self.page.is_following())
        self.assertEqual(self.events, [], "программная установка не дёргает приложение")

    # ---------------------------------------------------------------- text field
    def test_route_text_round_trip(self):
        self.page.set_route_text("Sol\nWolf 359")
        self.assertEqual(self.page.route_text(), "Sol\nWolf 359")
        self.page.clear_route_text()
        self.assertEqual(self.page.route_text(), "")

    # ------------------------------------------------------------------- state
    def test_state_reaches_every_widget(self):
        self.page.set_state(STATE)
        self.assertEqual(self.page.status_label.text(), STATE["status"])
        self.assertEqual(self.page.stat_text("visited"), "2 из 3")
        self.assertEqual(self.page.stat_text("eta"), "около 21:34")
        self.assertEqual(self.page.info_text("construction"),
                         "42% готово · осталось 1200 т")
        self.assertEqual(self.page.info_text("bodies"), "12 тел")
        self.assertEqual(self.page.upcoming_count(), 1)
        self.assertEqual(self.page.table.item(0, 1).text(), "Wolf 359")
        self.assertEqual(self.page.progress_value(), 667)
        self.assertEqual(self.page.note_label.text(), STATE["note"])
        self.assertTrue(self.page.is_following())
        self.assertTrue(self.page.copy_btn.isEnabled())

    def test_state_switches_copy_button_off_without_next_system(self):
        state = dict(STATE, next="")
        state["stats"] = dict(STATE["stats"], jumps_left="0")
        self.page.set_state(state)
        self.assertFalse(self.page.copy_btn.isEnabled())

    def test_state_without_progress_does_not_raise(self):
        self.page.set_state({"status": "—", "stats": {}, "info": {},
                             "upcoming": [], "progress": None})
        self.assertEqual(self.page.progress_value(), 0)
        self.assertEqual(self.page.stat_text("visited"), "—")
        self.assertEqual(self.page.upcoming_count(), 0)

    def test_empty_state_clears_the_tables(self):
        self.page.set_state(STATE)
        self.page.set_state({})
        self.assertEqual(self.page.upcoming_count(), 0)
        self.assertEqual(self.page.status_label.text(), "")

    def test_upcoming_rows_are_text_and_centred(self):
        self.page.set_upcoming([(1, "Sol", "—"), (2, 359, None)])
        self.assertEqual(self.page.upcoming_count(), 2)
        self.assertEqual(self.page.table.item(0, 1).text(), "Sol")
        self.assertEqual(self.page.table.item(1, 2).text(), "None")

    # ----------------------------------------------------------------- drawing
    def test_page_renders_with_state(self):
        self.page.set_state(STATE)
        self.page.resize(1000, 700)
        self.page.show()
        self.app.processEvents()
        image = self.page.grab().toImage()
        self.assertFalse(image.isNull())
        self.assertEqual((image.width(), image.height()), (1000, 700))
        self.page.hide()

    def test_language_follows_the_launcher(self):
        """Вкладка не должна остаться русской в другом языке."""
        import re

        for code in ("en", "zh"):
            i18n.set_locale(code)
            page = helper_pages.TravelPage()
            try:
                texts = [item.text() for item in page.findChildren(QLabel)]
                texts += [item.text() for item in page.findChildren(QPushButton)]
                texts += [page.table.horizontalHeaderItem(i).text()
                          for i in range(page.table.columnCount())]
                russian = [text for text in texts
                           if text and re.search("[А-Яа-яЁё]", text)]
                self.assertEqual(russian, [], f"{code}: остались русские подписи")
            finally:
                i18n.set_locale("ru")
                page.deleteLater()


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class RouteSectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def test_section_has_both_tabs(self):
        section = helper_pages.RouteSection()
        self.assertEqual(section.tabs.count(), 2)
        self.assertEqual(section.tab_index("route"), 0)
        self.assertEqual(section.tab_index("travel"), 1)
        self.assertIsInstance(section.route, helper_pages.RoutePage)
        self.assertIsInstance(section.travel, helper_pages.TravelPage)

    def test_section_switches_tabs(self):
        section = helper_pages.RouteSection()
        section.show_travel()
        self.assertIs(section.tabs.currentWidget(), section.travel)
        section.show_route()
        self.assertIs(section.tabs.currentWidget(), section.route)

    def test_old_route_page_behaviour_is_untouched(self):
        """Прежние тесты страницы «Маршрут» остаются верными."""
        section = helper_pages.RouteSection()
        section.route.set_rows([(1, "Sol", "✓ Посещена", "", "visited")])
        self.assertEqual(section.route.row_count(), 1)
        self.assertEqual(section.route.row_values(0)[1], "Sol")


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class ConstantsMatchModuleTests(unittest.TestCase):
    """Подписи плиток на странице и ключи статистики в модуле не разъезжаются."""

    def test_page_columns_exist_in_travel_module(self):
        stat_keys = {key for key, _title in route_travel.STAT_KEYS}
        info_keys = {key for key, _title in route_travel.INFO_KEYS}
        self.assertTrue({key for key, _title in helper_pages.TRAVEL_STAT_COLUMNS} <= stat_keys)
        self.assertTrue({key for key, _title in helper_pages.TRAVEL_INFO_COLUMNS} <= info_keys)


if __name__ == "__main__":
    unittest.main()
