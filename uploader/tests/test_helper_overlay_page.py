"""Headless Qt tests for the migrated Overlay settings page."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import (QComboBox, QLabel, QLineEdit, QPushButton,
                                   QSlider, QTabWidget)

    import helper_pages
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


ROWS = [
    ("ship", "Корабль", True, True),
    ("route", "Маршрут", True, False),
    ("cargo", "Груз авианосца", False, False),
]

ACTIONS = (
    "toggle", "reset_positions", "alpha_changed", "font_changed", "font_size_changed",
    "all_size_changed", "block_visible", "block_lock", "block_screen", "block_alpha",
    "block_font", "block_size", "block_rule", "block_hotkey", "block_reset",
    "screens_provider", "lock_all", "lock_hotkey_changed", "auto_rules_changed",
    "attach_game_changed", "idle_changed", "ship_block_changed", "ship_modules_changed",
    "content_changed", "carrier_filter_changed", "carrier_search_changed",
    "profile_apply", "profile_save", "profile_delete", "anchor_changed",
    "apply_anchors", "hide_without_game_changed", "margin_changed",
)


def _state(**overrides):
    data = dict(
        alpha=0.85,
        font_family="Consolas",
        font_size=11,
        font_choices=("Consolas", "Courier New"),
        alpha_choices=("общая", "55%", "70%", "85%", "100%"),
        hotkey_choices=("—", "F5", "F12"),
        lock_hotkey_choices=("—", "Ctrl+F12"),
        size_labels=["S — 85%", "M — 100%"],
        rule_labels=["всегда", "только в игре"],
        rows=[helper_pages.OverlayBlockRow(
            key=key, label=text, visible=visible, locked=locked,
            screen="с игрой", alpha="общая", font_size="общий", size="S — 85%",
            auto_rule="всегда", hotkey="—") for key, text, visible, locked in ROWS],
        anchors=[("ship", "Корабль", "слева сверху", ("слева сверху", "справа сверху")),
                 ("route", "Маршрут", "справа сверху", ("слева сверху", "справа сверху"))],
        screen_choices=("с игрой", "экран 1"),
        screens_text="Экраны: экран 1 — 1920×1080",
        all_size="M — 100%",
        lock_hotkey="Ctrl+F12",
        auto_rules=True,
        attach_game=True,
        idle_choices=("не скрывать", "2 мин"),
        idle="2 мин",
        ship_blocks=[("flags", "Флаги состояния", True), ("hull", "Корпус", False)],
        ship_modules="important",
        content=[("ship", "Корабль", [("overlay_ship_status", "Статус корабля", True),
                                      ("overlay_ship_modules", "Список модулей", False)]),
                 ("carrier", "Авианосец", [("overlay_carrier_cargo", "Груз", True)])],
        carrier_filters=[("all", "Все товары"), ("needed", "Только нужные")],
        carrier_filter="Все товары",
        carrier_search="steel",
        profiles=["Хаул", "Бой"],
        profile="Хаул",
        margin=32,
        hide_without_game=True,
        info_text="Область раскладки: основной экран",
        hotkey_hint="Назначено: F5 — Маршрут",
    )
    data.update(overrides)
    return helper_pages.OverlayPageState(**data)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class OverlayPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.events = []
        self.actions = helper_pages.OverlayPageActions(
            **{name: (lambda *a, n=name: self.events.append((n,) + a)) for name in ACTIONS})
        self.page = helper_pages.OverlayPage(_state(), self.actions)

    # ------------------------------------------------------------- structure
    def test_header_controls_exist(self):
        self.assertIsInstance(self.page.toggle_btn, QPushButton)
        self.assertIsInstance(self.page.reset_btn, QPushButton)
        self.assertIsInstance(self.page.alpha_slider, QSlider)
        self.assertIsInstance(self.page.font_combo, QComboBox)
        self.assertIsInstance(self.page.font_size_slider, QSlider)

    def test_every_block_gets_every_column(self):
        expected = {"visible", "locked", "screen", "alpha", "font_size", "size",
                    "auto_rule", "hotkey"}
        self.assertEqual(set(self.page.block_widgets), {"ship", "route", "cargo"})
        for widgets in self.page.block_widgets.values():
            self.assertEqual(set(widgets), expected)

    def test_block_rows_reflect_state(self):
        self.assertTrue(self.page.block_value("ship", "visible"))
        self.assertTrue(self.page.block_value("ship", "locked"))
        self.assertFalse(self.page.block_value("cargo", "visible"))
        self.assertEqual(self.page.block_value("route", "screen"), "с игрой")

    def test_initial_values(self):
        self.assertAlmostEqual(self.page.alpha_value(), 0.85, places=2)
        self.assertEqual(self.page.font_family(), "Consolas")
        self.assertEqual(self.page.font_size(), 11)
        self.assertEqual(self.page.margin_value(), 32)
        self.assertEqual(self.page.profile_text(), "Хаул")
        self.assertEqual(self.page.lock_hotkey_text(), "Ctrl+F12")
        self.assertTrue(self.page.auto_rules())
        self.assertTrue(self.page.attach_game())
        self.assertTrue(self.page.hide_without_game())
        self.assertEqual(self.page.idle_text(), "2 мин")

    def test_ship_and_content_widgets(self):
        self.assertEqual(set(self.page.ship_widgets), {"flags", "hull"})
        self.assertTrue(self.page.ship_block("flags"))
        self.assertFalse(self.page.ship_block("hull"))
        self.assertEqual(self.page.ship_modules_view(), "important")
        self.assertTrue(self.page.content_value("overlay_ship_status"))
        self.assertFalse(self.page.content_value("overlay_ship_modules"))
        self.assertIsInstance(self.page.content_tabs, QTabWidget)
        self.assertEqual(self.page.content_tabs.count(), 2)

    def test_carrier_tab_has_filter_and_search(self):
        self.assertEqual(self.page.carrier_filter_text(), "Все товары")
        self.assertEqual(self.page.carrier_search_text(), "steel")
        self.assertIsInstance(self.page.carrier_search_entry, QLineEdit)

    def test_text_labels_come_from_state(self):
        self.assertIn("экран 1", self.page.screens_label.text())
        self.assertIn("F5", self.page.hotkey_hint_label.text())
        self.assertEqual(self.page.info_label.text(), "Область раскладки: основной экран")
        self.assertIsInstance(self.page.info_label, QLabel)

    # --------------------------------------------------------------- wiring
    def test_user_edits_call_the_application(self):
        self.page.alpha_slider.setValue(55)
        self.assertEqual(self.events[-1], ("alpha_changed", 0.55))
        self.page.font_size_slider.setValue(14)
        self.assertEqual(self.events[-1], ("font_size_changed", 14))
        self.page.block_widgets["cargo"]["visible"].setChecked(True)
        self.assertIn(("block_visible", "cargo", True), self.events)
        self.page.ship_widgets["hull"].setChecked(True)
        self.assertIn(("ship_block_changed", "hull", True), self.events)
        self.page.content_widgets["overlay_ship_modules"].setChecked(True)
        self.assertIn(("content_changed", "overlay_ship_modules", True), self.events)

    def test_buttons_call_the_application(self):
        self.page.toggle_btn.click()
        self.page.reset_btn.click()
        self.page.lock_all_btn.click()
        self.page.unlock_all_btn.click()
        self.page.apply_anchors_btn.click()
        names = [event[0] for event in self.events]
        for expected in ("toggle", "reset_positions", "apply_anchors"):
            self.assertIn(expected, names)
        self.assertIn(("lock_all", True), self.events)
        self.assertIn(("lock_all", False), self.events)

    def test_block_reset_has_no_extra_arguments(self):
        self.page.block_widgets["ship"]["visible"].setChecked(False)
        self.events.clear()
        # Кнопка сброса — последняя ячейка строки.
        grid = self.page.block_table.layout()
        button = grid.itemAtPosition(1, 9).widget()
        self.assertIsInstance(button, QPushButton)
        button.click()
        self.assertEqual(self.events, [("block_reset", "ship")])

    # --------------------------------------------------------- programmatic
    def test_setters_do_not_echo_back(self):
        self.events.clear()
        self.page.set_block_value("ship", "visible", False)
        self.page.set_block_value("route", "size", "M — 100%")
        self.page.set_alpha(0.4)
        self.page.set_margin(8)
        self.assertEqual(self.events, [])
        self.assertFalse(self.page.block_value("ship", "visible"))
        self.assertEqual(self.page.block_value("route", "size"), "M — 100%")
        self.assertAlmostEqual(self.page.alpha_value(), 0.4, places=2)
        self.assertEqual(self.page.margin_label.text(), "8 px")

    def test_set_screen_choices_keeps_current_value(self):
        self.page.set_block_value("ship", "screen", "экран 1")
        self.page.set_screen_choices(("с игрой", "экран 1", "экран 2"))
        self.assertEqual(self.page.block_value("ship", "screen"), "экран 1")
        combo = self.page.block_widgets["ship"]["screen"]
        self.assertEqual(combo.count(), 3)

    def test_profiles_and_toggle_text(self):
        self.assertEqual(self.page.profiles(), ["Хаул", "Бой"])
        self.page.set_profiles(["Хаул", "Бой", "Разведка"], "Разведка")
        self.assertEqual(self.page.profiles(), ["Хаул", "Бой", "Разведка"])
        self.assertEqual(self.page.profile_text(), "Разведка")

        self.assertEqual(self.page.toggle_btn.text(), self.page.TOGGLE_ON_TEXT)
        self.page.set_toggle_running(True)
        self.assertEqual(self.page.toggle_btn.text(), self.page.TOGGLE_OFF_TEXT)
        self.assertEqual(self.page.toggle_btn.property("variant"), "danger")
        self.page.set_toggle_running(False)
        self.assertEqual(self.page.toggle_btn.text(), self.page.TOGGLE_ON_TEXT)

    def test_status_text_setters(self):
        self.page.set_screens_text("Экраны: нет данных")
        self.page.set_info_text("Область: 2560x1440")
        self.page.set_hotkey_hint_text("Назначено: F12")
        self.assertEqual(self.page.screens_label.text(), "Экраны: нет данных")
        self.assertEqual(self.page.info_label.text(), "Область: 2560x1440")
        self.assertEqual(self.page.hotkey_hint_label.text(), "Назначено: F12")

    def test_checkbox_state_roundtrip(self):
        self.page.set_auto_rules(False)
        self.page.set_attach_game(False)
        self.assertFalse(self.page.auto_rules())
        self.assertFalse(self.page.attach_game())
        self.page.set_ship_modules_view("important")
        self.assertEqual(self.page.ship_modules_view(), "important")

    def test_anchor_and_combo_accessors(self):
        self.assertEqual(self.page.anchor_text("ship"), "слева сверху")
        self.page.set_anchor_text("route", "справа сверху")
        self.assertEqual(self.page.anchor_text("route"), "справа сверху")
        self.page.set_carrier_search_text("gold")
        self.assertEqual(self.page.carrier_search_text(), "gold")
        self.page.set_all_size_text("M — 100%")
        self.assertEqual(self.page.all_size_text(), "M — 100%")

    def test_empty_state_builds_without_rows(self):
        page = helper_pages.OverlayPage(_state(rows=[], anchors=[], ship_blocks=[],
                                               content=[], carrier_filters=[],
                                               profiles=[], profile=""), None)
        self.assertEqual(page.block_widgets, {})
        self.assertEqual(page.profiles(), [])
        self.assertIsInstance(page.toggle_btn, QPushButton)


class OverlayPageHostTests(unittest.TestCase):
    """The page must work inside the helper shell, like every other tab."""

    @classmethod
    def setUpClass(cls):
        if QT_ERROR is not None:  # pragma: no cover - depends on the machine
            raise unittest.SkipTest(f"Qt runtime unavailable: {QT_ERROR}")
        cls.app = ensure_app()

    def test_page_can_be_added_to_a_tab(self):
        from PySide6.QtWidgets import QWidget

        import helper_shell

        root = QWidget()
        shell = helper_shell.build_shell(root, version="test")
        page = helper_pages.OverlayPage(
            _state(), helper_pages.OverlayPageActions())
        tab = helper_shell.PageHost(shell.content_area)
        tab._get_tk_layout("pack").addWidget(page)
        shell.add(tab, "Оверлей")
        shell.select(tab)
        self.assertEqual(shell.pages, [tab])
        self.assertIs(page.parent(), tab)


if __name__ == "__main__":
    unittest.main()
