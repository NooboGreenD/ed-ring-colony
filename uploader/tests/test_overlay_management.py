"""Тесты управления оверлеями: настройки блоков, поведение, горячие клавиши.

Проверяется то, что пользователь меняет чаще всего и что раньше требовало
перезапуска оверлея:

* персональные настройки блока (прозрачность, шрифт, размер, блокировка,
  клик-сквозь) применяются к живому окну, а не после перезапуска;
* пресеты размера и сброс блока считают размеры от стандарта;
* правила «показывать по ситуации» и автоскрытие при простое решают,
  какие блоки видны;
* профиль раскладки теперь захватывает и поведение блоков;
* горячие клавиши разбираются, а вне Windows менеджер просто молчит.
"""

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

from test_overlay_layout import _FakeMaster, _FakeWindow  # noqa: E402


def _ensure_gui_stubs():
    """Подменить tkinter/ttkbootstrap (в песочнице настоящего Tk нет)."""
    sys.path.insert(0, str(HERE))
    from test_initial_upload_flow import install_gui_stubs

    install_gui_stubs()
    # В общей заглушке tb.Label(...) возвращает один и тот же объект на все
    # вызовы, из-за чего нельзя проверить текст конкретной подписи.
    widgets = ("Frame", "Labelframe", "Label", "Button", "Checkbutton",
               "Radiobutton", "Entry", "Combobox", "Progressbar", "Scale",
               "Spinbox", "Separator", "Notebook", "Treeview", "Text", "Meter")
    for module_name, names in (("ttkbootstrap", widgets), ("tkinter", ("Canvas", "Toplevel", "Frame"))):
        module = sys.modules.get(module_name)
        if module is None:
            continue
        for name in names:
            widget = getattr(module, name, None)
            if widget is None:
                continue
            widget.side_effect = lambda *args, _name=name, **kwargs: mock.MagicMock(name=_name)


_ensure_gui_stubs()


class _FakeBlock:
    """Оверлей-заглушка, которая запоминает все обращения менеджера."""

    def __init__(self, key="route"):
        self.overlay_key = key
        self.window = _FakeWindow(10, 20, 300, 200)
        self._anchor = "custom"
        self.calls = []
        self.shown = True

    def _record(self, name, **kwargs):
        self.calls.append((name, kwargs))

    def show(self):
        self.shown = True
        self._record("show")

    def hide(self):
        self.shown = False
        self._record("hide")

    def set_alpha(self, alpha, save=True):
        self._record("set_alpha", alpha=alpha, save=save)

    def apply_font(self, family, size):
        self._record("apply_font", family=family, size=size)

    def set_locked(self, locked):
        self._record("set_locked", locked=locked)

    def set_click_through(self, enabled, save_key=None):
        self._record("set_click_through", enabled=enabled, save_key=save_key)

    def set_size(self, width, height, save=True):
        self.window.width = width
        self.window.height = height
        self._record("set_size", width=width, height=height)

    def set_geometry(self, x, y, width, height):
        self.window.x, self.window.y = x, y
        self.window.width, self.window.height = width, height
        self._record("set_geometry", x=x, y=y, width=width, height=height)

    def names(self):
        return [name for name, _kwargs in self.calls]


class _ManagerTestCase(unittest.TestCase):
    def setUp(self):
        from overlay import OverlayManager

        self.tmp = tempfile.TemporaryDirectory()
        self.config_path = Path(self.tmp.name) / "config.json"
        self.manager = OverlayManager(_FakeMaster(), self.config_path)
        self.manager._stop = threading.Event()

    def tearDown(self):
        self.manager._stop.set()
        self.manager.hotkeys.stop()
        self.tmp.cleanup()

    def attach(self, *keys):
        """Подсунуть менеджеру живые окна-заглушки."""
        blocks = {}
        for key in keys:
            block = _FakeBlock(key)
            setattr(self.manager, f"{key}_overlay", block)
            blocks[key] = block
        return blocks


# ---------------------------------------------------------------------------
class BlockSettingHelpersTests(unittest.TestCase):
    """Чистые функции настроек блоков."""

    def test_preset_size_is_multiple_of_default(self):
        from overlay import DEFAULT_BLOCK_POSITIONS, preset_size

        _x, _y, width, height = DEFAULT_BLOCK_POSITIONS["route"]
        self.assertEqual(preset_size("route", "M"), (width, height))
        self.assertEqual(preset_size("route", "L"),
                         (int(round(width * 1.25)), int(round(height * 1.25))))
        self.assertEqual(preset_size("route", "XS"),
                         (int(round(width * 0.75)), int(round(height * 0.75))))
        self.assertIsNone(preset_size("route", "нет такого"))
        self.assertIsNone(preset_size("нет блока", "M"))

    def test_alpha_falls_back_to_global(self):
        from overlay import resolve_block_alpha

        settings = {"alpha": 0.5}
        self.assertEqual(resolve_block_alpha(settings, "route"), 0.5)
        settings["route_alpha"] = 0.8
        self.assertEqual(resolve_block_alpha(settings, "route"), 0.8)
        self.assertEqual(resolve_block_alpha(settings, "ship"), 0.5)
        settings["ship_alpha"] = "плохо"
        self.assertEqual(resolve_block_alpha(settings, "ship"), 0.5)

    def test_font_size_falls_back_and_clamps(self):
        from overlay import resolve_block_font_size

        settings = {"font_size": 12}
        self.assertEqual(resolve_block_font_size(settings, "route"), 12)
        settings["route_font_size"] = 16
        self.assertEqual(resolve_block_font_size(settings, "route"), 16)
        settings["ship_font_size"] = 999
        self.assertEqual(resolve_block_font_size(settings, "ship"), 28)
        settings["cargo_font_size"] = None
        self.assertEqual(resolve_block_font_size(settings, "cargo"), 12)

    def test_click_through_prefers_block_value(self):
        from overlay import block_click_through

        settings = {"click_through": True}
        self.assertTrue(block_click_through(settings, "route"))
        settings["route_click_through"] = False
        self.assertFalse(block_click_through(settings, "route"))
        self.assertTrue(block_click_through(settings, "ship"))

    def test_auto_rule_matches_situation(self):
        from overlay import auto_rule_matches

        context = {
            "flags": ["Docked"], "cargo_count": 12.0, "bio_signals": 3,
            "route_total": 5, "game_running": True, "game_focused": True,
        }
        self.assertTrue(auto_rule_matches("always", context))
        self.assertFalse(auto_rule_matches("never", context))
        self.assertTrue(auto_rule_matches("docked", context))
        self.assertFalse(auto_rule_matches("in_space", context))
        self.assertTrue(auto_rule_matches("has_cargo", context))
        self.assertTrue(auto_rule_matches("has_bio", context))
        self.assertTrue(auto_rule_matches("has_route", context))
        self.assertTrue(auto_rule_matches("game_focused", context))
        self.assertFalse(auto_rule_matches("in_srv", context))
        self.assertFalse(auto_rule_matches("on_foot", context))
        # неизвестное правило не должно внезапно прятать блок
        self.assertTrue(auto_rule_matches("что-то новое", context))

        flying = dict(context, flags=["Supercruise"], cargo_count=0, bio_signals=0)
        self.assertTrue(auto_rule_matches("in_space", flying))
        self.assertFalse(auto_rule_matches("docked", flying))
        self.assertFalse(auto_rule_matches("has_cargo", flying))
        self.assertFalse(auto_rule_matches("has_bio", flying))

        srv = dict(context, flags=["SRV"])
        self.assertTrue(auto_rule_matches("in_srv", srv))
        foot = dict(context, flags=["OnFoot"])
        self.assertTrue(auto_rule_matches("on_foot", foot))

    def test_auto_rule_with_empty_context(self):
        from overlay import auto_rule_matches

        self.assertTrue(auto_rule_matches("always", {}))
        self.assertFalse(auto_rule_matches("never", {}))
        self.assertFalse(auto_rule_matches("has_cargo", {}))
        self.assertFalse(auto_rule_matches("in_space", {}))


# ---------------------------------------------------------------------------
class BlockSettingsLiveTests(_ManagerTestCase):
    """Изменения настроек должны доезжать до живого окна."""

    def test_visible_toggle_hits_window(self):
        blocks = self.attach("route")
        self.manager.set_block_visible("route", False)
        self.assertFalse(self.manager.settings["show_route"])
        self.assertIn("hide", blocks["route"].names())
        self.manager.set_block_visible("route", True)
        self.assertIn("show", blocks["route"].names())

    def test_toggle_block_flips_setting_and_notifies(self):
        self.attach("cargo")
        events = []
        self.manager.on_settings_changed = lambda key, name, value: events.append((key, name, value))
        self.manager.settings["show_cargo"] = True
        self.manager.toggle_block("cargo")
        self.assertFalse(self.manager.settings["show_cargo"])
        self.manager.toggle_block("cargo")
        self.assertTrue(self.manager.settings["show_cargo"])
        self.assertEqual([event[1] for event in events], ["visible", "visible"])

    def test_toggle_all_blocks_hides_when_any_visible(self):
        self.attach("route", "ship")
        self.manager.toggle_all_blocks()
        self.assertTrue(all(not self.manager.settings[f"show_{key}"] for key in self.manager.BLOCKS))
        self.manager.toggle_all_blocks()
        self.assertTrue(all(self.manager.settings[f"show_{key}"] for key in self.manager.BLOCKS))

    def test_block_alpha_is_applied_without_restart(self):
        blocks = self.attach("ship")
        self.manager.set_block_alpha("ship", 0.4)
        self.assertEqual(self.manager.settings["ship_alpha"], 0.4)
        self.assertIn(("set_alpha", {"alpha": 0.4, "save": False}), blocks["ship"].calls)
        # None — вернуть общую прозрачность
        self.manager.set_block_alpha("ship", None)
        self.assertNotIn("ship_alpha", self.manager.settings)
        self.assertEqual(blocks["ship"].calls[-1][1]["alpha"],
                         self.manager.settings["alpha"])

    def test_block_alpha_is_clamped(self):
        self.attach("ship")
        self.manager.set_block_alpha("ship", 5)
        self.assertEqual(self.manager.settings["ship_alpha"], 1.0)
        self.manager.set_block_alpha("ship", 0)
        self.assertEqual(self.manager.settings["ship_alpha"], 0.1)

    def test_block_font_size_is_applied_live(self):
        blocks = self.attach("session")
        self.manager.set_block_font_size("session", 16)
        self.assertEqual(self.manager.settings["session_font_size"], 16)
        self.assertIn(("apply_font", {"family": "Consolas", "size": 16}),
                      blocks["session"].calls)
        self.manager.set_block_font_size("session", None)
        self.assertNotIn("session_font_size", self.manager.settings)
        self.assertEqual(blocks["session"].calls[-1][1]["size"],
                         self.manager.settings["font_size"])

    def test_block_size_and_preset(self):
        blocks = self.attach("cargo")
        self.manager.set_block_size("cargo", 400, 500)
        self.assertEqual((self.manager.settings["cargo_width"],
                          self.manager.settings["cargo_height"]), (400, 500))
        self.assertIn(("set_size", {"width": 400, "height": 500}), blocks["cargo"].calls)

        self.manager.apply_size_preset("L", "cargo")
        from overlay import preset_size

        self.assertEqual((self.manager.settings["cargo_width"],
                          self.manager.settings["cargo_height"]),
                         preset_size("cargo", "L"))

    def test_preset_applies_to_all_blocks(self):
        self.attach()
        from overlay import preset_size

        self.manager.apply_size_preset("S")
        for key in self.manager.BLOCKS:
            self.assertEqual((self.manager.settings[f"{key}_width"],
                              self.manager.settings[f"{key}_height"]),
                             preset_size(key, "S"), key)
        self.assertFalse(self.manager.apply_size_preset("нет такого"))

    def test_lock_is_applied_live(self):
        blocks = self.attach("route")
        self.manager.set_block_locked("route", True)
        self.assertTrue(self.manager.settings["route_locked"])
        self.assertIn(("set_locked", {"locked": True}), blocks["route"].calls)

    def test_click_through_global_skips_blocks_with_own_value(self):
        blocks = self.attach("route", "ship")
        self.manager.settings["ship_click_through"] = False
        self.manager.set_click_through(True)
        self.assertTrue(self.manager.settings["click_through"])
        self.assertIn("set_click_through", blocks["route"].names())
        self.assertNotIn("set_click_through", blocks["ship"].names())

    def test_click_through_per_block(self):
        blocks = self.attach("exobio")
        self.manager.set_click_through(True, key="exobio")
        self.assertTrue(self.manager.settings["exobio_click_through"])
        self.assertEqual(blocks["exobio"].calls[-1][1], {"enabled": True, "save_key": None})

    def test_reset_block_returns_defaults(self):
        blocks = self.attach("session")
        from overlay import DEFAULT_BLOCK_POSITIONS

        self.manager.settings["session_alpha"] = 0.3
        self.manager.settings["session_font_size"] = 20
        self.manager.settings["session_locked"] = True
        self.manager.settings["session_anchor"] = "top_right"
        self.manager.settings["session_auto_rule"] = "never"
        self.manager.reset_block("session")

        self.assertNotIn("session_alpha", self.manager.settings)
        self.assertNotIn("session_font_size", self.manager.settings)
        self.assertFalse(self.manager.settings["session_locked"])
        self.assertEqual(self.manager.settings["session_anchor"], "custom")
        self.assertEqual(self.manager.settings["session_auto_rule"], "always")
        x, y, width, height = DEFAULT_BLOCK_POSITIONS["session"]
        self.assertEqual(self.manager.settings["session_x"], x)
        self.assertEqual(self.manager.settings["session_y"], y)
        self.assertEqual(self.manager.settings["session_width"], width)
        self.assertEqual(self.manager.settings["session_height"], height)
        self.assertIn("set_geometry", blocks["session"].names())

    def test_unknown_auto_rule_falls_back_to_always(self):
        self.manager.set_auto_rule("route", "когда-нибудь")
        self.assertEqual(self.manager.settings["route_auto_rule"], "always")

    def test_set_font_does_not_restart_overlay(self):
        blocks = self.attach("route", "ship")
        self.manager.enabled = True
        self.manager.settings["ship_font_size"] = 18
        self.manager.set_font("Courier New", 14)

        self.assertEqual(self.manager.settings["font_family"], "Courier New")
        self.assertEqual(self.manager.settings["font_size"], 14)
        self.assertTrue(self.manager.enabled, "оверлей не должен перезапускаться")
        # у блока со своим размером он сохраняется
        self.assertIn(("apply_font", {"family": "Courier New", "size": 18}),
                      blocks["ship"].calls)
        self.assertIn(("apply_font", {"family": "Courier New", "size": 14}),
                      blocks["route"].calls)


# ---------------------------------------------------------------------------
class _FakeWidget:
    """Виджет Tk: отдаёт шрифт через cget и запоминает configure."""

    def __init__(self, font, children=()):
        self._font = font
        self.children = list(children)
        self.applied = []

    def winfo_children(self):
        return list(self.children)

    def cget(self, key):
        if key == "font":
            return self._font
        raise AttributeError(key)

    def configure(self, **kwargs):
        if "font" in kwargs:
            self.applied.append(kwargs["font"])
            self._font = kwargs["font"]


class OverlayFontTests(unittest.TestCase):
    """Живая смена шрифта: все подписи блока масштабируются, а не сравниваются."""

    def _overlay(self, base=10):
        from overlay import OverlayWindow

        child_a = _FakeWidget(("Consolas", 12, "bold"))
        child_b = _FakeWidget(("Consolas", 8))
        nested = _FakeWidget(("Consolas", 10), children=[child_b])
        root = _FakeWidget(("Consolas", 9), children=[child_a, nested])

        overlay = OverlayWindow.__new__(OverlayWindow)  # без настоящего Tk
        overlay.window = root
        overlay._font_base = base
        overlay._font_specs = {}
        overlay._applied_font = ("Consolas", base)
        return overlay, (child_a, child_b, nested, root)

    def test_fonts_are_scaled_proportionally(self):
        overlay, (child_a, child_b, _nested, _root) = self._overlay(base=10)
        overlay._register_fonts()
        overlay.apply_font("Arial", 20)     # масштаб 2.0
        self.assertEqual(child_a.applied[-1], ("Arial", 24, "bold"))
        self.assertEqual(child_b.applied[-1], ("Arial", 16))
        self.assertEqual(overlay._applied_font, ("Arial", 20))

        # второй вызов считается от исходных размеров, а не от предыдущих
        overlay.apply_font("Arial", 10)
        self.assertEqual(child_a.applied[-1], ("Arial", 12, "bold"))
        self.assertEqual(child_b.applied[-1], ("Arial", 8))

    def test_string_font_is_skipped(self):
        from overlay import OverlayWindow

        widget = _FakeWidget("TkDefaultFont")
        root = _FakeWidget(("Consolas", 10), children=[widget])
        overlay = OverlayWindow.__new__(OverlayWindow)
        overlay.window = root
        overlay._font_base = 10
        overlay._font_specs = {}
        overlay._applied_font = ("Consolas", 10)
        overlay._register_fonts()
        overlay.apply_font("Arial", 20)
        self.assertEqual(widget.applied, [], "именованный шрифт не трогаем")
        self.assertEqual(root.applied[-1], ("Arial", 20))

    def test_broken_widget_does_not_break_fonts(self):
        class _Broken:
            def winfo_children(self):
                raise RuntimeError("умер")

            def cget(self, _key):
                raise RuntimeError("умер")

        root = _FakeWidget(("Consolas", 10), children=[_Broken()])
        from overlay import OverlayWindow

        overlay = OverlayWindow.__new__(OverlayWindow)
        overlay.window = root
        overlay._font_base = 10
        overlay._font_specs = {}
        overlay._applied_font = ("Consolas", 10)
        overlay._register_fonts()
        overlay.apply_font("Arial", 14)
        self.assertEqual(root.applied[-1], ("Arial", 14))


class OverlayBehaviourTests(_ManagerTestCase):
    """Правила показа по ситуации и автоскрытие при простое."""

    def test_visibility_follows_user_setting_without_rules(self):
        self.manager.settings["show_cargo"] = False
        self.manager.settings["auto_rules_enabled"] = False
        result = self.manager.evaluate_block_visibility({}, game_visible=True)
        self.assertFalse(result["cargo"])
        self.assertTrue(result["route"])

    def test_visibility_follows_auto_rules(self):
        self.manager.settings["auto_rules_enabled"] = True
        self.manager.set_auto_rule("cargo", "has_cargo")
        self.manager.set_auto_rule("route", "has_route")
        context = {"cargo_count": 0, "route_total": 3}
        result = self.manager.evaluate_block_visibility(context, game_visible=True)
        self.assertFalse(result["cargo"])
        self.assertTrue(result["route"])

    def test_visibility_is_off_without_game(self):
        self.manager.settings["auto_rules_enabled"] = True
        result = self.manager.evaluate_block_visibility({}, game_visible=False)
        self.assertTrue(all(not visible for visible in result.values()))

    def test_idle_hides_everything_until_activity(self):
        self.manager.set_idle_timeout(1)
        self.manager._last_activity = time.monotonic() - 10
        result = self.manager.evaluate_block_visibility({}, game_visible=True)
        self.assertTrue(self.manager._hidden_by_idle)
        self.assertTrue(all(not visible for visible in result.values()))

        self.manager.mark_activity()
        result = self.manager.evaluate_block_visibility({}, game_visible=True)
        self.assertTrue(all(result.values()))

    def test_new_global_settings_are_persisted(self):
        """Новые общие настройки должны доживать до перезапуска программы."""
        from overlay import load_overlay_settings

        self.manager.set_idle_timeout(120)
        self.manager.set_click_through(True)
        self.manager.set_auto_rules_enabled(True)
        self.manager.set_block_hotkey("route", "F7")

        reloaded = load_overlay_settings(self.config_path)
        self.assertEqual(reloaded.get("idle_timeout"), 120)
        self.assertTrue(reloaded.get("click_through"))
        self.assertTrue(reloaded.get("auto_rules_enabled"))
        self.assertEqual(reloaded.get("route_hotkey"), "F7")

    def test_idle_disabled_by_zero(self):
        self.manager.set_idle_timeout(0)
        self.manager._last_activity = time.monotonic() - 10_000
        result = self.manager.evaluate_block_visibility({}, game_visible=True)
        self.assertTrue(all(result.values()))

    def test_context_is_built_from_data(self):
        data = {
            "ship": {"flags_list": ["Docked", "Shields"], "cargo_count": 42},
            "exobiology": {"bio_signals": 2},
            "total": 7,
            "game_running": True,
            "game_focused": True,
        }
        context = self.manager.update_context(data)
        self.assertTrue(context["docked"])
        self.assertEqual(context["cargo_count"], 42.0)
        self.assertEqual(context["bio_signals"], 2)
        self.assertEqual(context["route_total"], 7)
        self.assertTrue(context["game_running"])

    def test_context_decodes_raw_flags(self):
        context = self.manager.update_context({"ship": {"flags": 1 << 0}})
        self.assertTrue(context["docked"])

    def test_context_survives_empty_data(self):
        context = self.manager.update_context({})
        self.assertEqual(context["flags"], [])
        self.assertEqual(context["cargo_count"], 0.0)
        self.assertEqual(context["route_total"], 0)


# ---------------------------------------------------------------------------
class ProfileBehaviourTests(_ManagerTestCase):
    """Профиль раскладки сохраняет и вид, и поведение блоков."""

    def test_profile_captures_block_settings(self):
        self.manager.settings["ship_alpha"] = 0.4
        self.manager.settings["ship_font_size"] = 18
        self.manager.settings["ship_auto_rule"] = "has_cargo"
        self.manager.settings["ship_hotkey"] = "F5"
        self.manager.settings["ship_locked"] = True
        self.manager.settings["idle_timeout"] = 120
        self.manager.settings["auto_rules_enabled"] = True

        self.assertTrue(self.manager.capture_layout("Хаул"))
        snapshot = self.manager.settings["profiles"]["Хаул"]["ship"]
        self.assertEqual(snapshot["alpha"], 0.4)
        self.assertEqual(snapshot["font_size"], 18)
        self.assertEqual(snapshot["auto_rule"], "has_cargo")
        self.assertEqual(snapshot["hotkey"], "F5")
        self.assertTrue(snapshot["locked"])
        self.assertEqual(self.manager.settings["profiles"]["Хаул"]["idle_timeout"], 120)
        self.assertTrue(self.manager.settings["profiles"]["Хаул"]["auto_rules_enabled"])

    def test_profile_restores_and_clears_overrides(self):
        blocks = self.attach("ship")
        self.manager.settings["ship_alpha"] = 0.4
        self.manager.capture_layout("Хаул")

        self.manager.settings["ship_alpha"] = 0.9
        self.assertTrue(self.manager.apply_layout("Хаул"))
        self.assertEqual(self.manager.settings["ship_alpha"], 0.4)
        # прозрачность доехала до живого окна без перезапуска
        self.assertIn(("set_alpha", {"alpha": 0.4, "save": False}), blocks["ship"].calls)

        # профиль, снятый без персональной прозрачности, возвращает общую
        self.manager.settings.pop("ship_alpha", None)
        self.manager.capture_layout("Общий")
        self.assertIsNone(self.manager.settings["profiles"]["Общий"]["ship"]["alpha"])
        self.manager.settings["ship_alpha"] = 0.2
        self.manager.apply_layout("Общий")
        self.assertNotIn("ship_alpha", self.manager.settings)

    def test_apply_layout_restores_block_overrides_and_hotkeys(self):
        self.attach("ship")
        self.manager.enabled = True
        self.manager.settings["ship_font_size"] = 20
        self.manager.settings["ship_hotkey"] = "F6"
        self.manager.capture_layout("Экзобиология")
        self.manager.settings["ship_font_size"] = 10
        self.manager.settings["ship_hotkey"] = ""

        with mock.patch.object(self.manager, "register_hotkeys") as register:
            self.manager.apply_layout("Экзобиология")
        self.assertEqual(self.manager.settings["ship_font_size"], 20)
        self.assertEqual(self.manager.settings["ship_hotkey"], "F6")
        register.assert_called()

    def test_profile_without_block_override_removes_it(self):
        """Профиль с `alpha: None` должен вернуть общую прозрачность."""
        self.manager.settings["ship_alpha"] = 0.4
        self.manager.capture_layout("Хаул")
        self.manager.settings["profiles"]["Хаул"]["ship"]["alpha"] = None
        self.manager.settings["ship_alpha"] = 0.9
        self.manager.apply_layout("Хаул")
        self.assertNotIn("ship_alpha", self.manager.settings)


# ---------------------------------------------------------------------------
class OverlayTabTests(unittest.TestCase):
    """Вкладка «Оверлей»: новые элементы управления и их обработчики."""

    def setUp(self):
        from test_initial_upload_flow import make_root

        for name in ("colonial_helper", "api_client", "event_dispatch",
                     "journal_parser", "overlay", "ship_tracker",
                     "route_tracker", "game_monitor", "exobiology", "hotkeys"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.root = make_root()

        import colonial_helper  # noqa: E402

        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)
        # Горячие клавиши реально не регистрируем (в песочнице это Windows-only).
        self.app.overlay_manager.hotkeys.available = False

    def tearDown(self):
        self.tmp.cleanup()

    def test_rows_are_built_for_every_block(self):
        rows = self.app._overlay_block_vars
        self.assertEqual(tuple(sorted(rows)), tuple(sorted(self.app.overlay_manager.BLOCKS)))
        for key, widgets in rows.items():
            for name in ("visible", "locked", "click_through", "alpha",
                         "font_size", "size", "auto_rule", "hotkey"):
                self.assertIn(name, widgets, f"{key}: нет настройки {name}")

    def test_alpha_choice_is_applied(self):
        widgets = self.app._overlay_block_vars["ship"]
        widgets["alpha"].set("55%")
        self.app._on_block_alpha_changed("ship")
        self.assertEqual(self.app.overlay_manager.settings["ship_alpha"], 0.55)

        widgets["alpha"].set("общая")
        self.app._on_block_alpha_changed("ship")
        self.assertNotIn("ship_alpha", self.app.overlay_manager.settings)

    def test_font_choice_is_applied(self):
        widgets = self.app._overlay_block_vars["session"]
        widgets["font_size"].set("16")
        self.app._on_block_font_changed("session")
        self.assertEqual(self.app.overlay_manager.settings["session_font_size"], 16)

        widgets["font_size"].set("общий")
        self.app._on_block_font_changed("session")
        self.assertNotIn("session_font_size", self.app.overlay_manager.settings)

    def test_size_preset_is_applied(self):
        from overlay import preset_size

        widgets = self.app._overlay_block_vars["cargo"]
        widgets["size"].set("L — 125%")
        self.app._on_block_size_changed("cargo")
        self.assertEqual((self.app.overlay_manager.settings["cargo_width"],
                          self.app.overlay_manager.settings["cargo_height"]),
                         preset_size("cargo", "L"))

    def test_all_size_preset_applies_to_every_block(self):
        from overlay import preset_size

        self.app.all_size_var.set("S — 85%")
        self.app._on_all_size_preset_changed()
        for key in self.app.overlay_manager.BLOCKS:
            self.assertEqual((self.app.overlay_manager.settings[f"{key}_width"],
                              self.app.overlay_manager.settings[f"{key}_height"]),
                             preset_size(key, "S"), key)

    def test_rule_choice_enables_auto_rules(self):
        widgets = self.app._overlay_block_vars["exobio"]
        widgets["auto_rule"].set("когда есть биосигналы")
        self.app._on_block_rule_changed("exobio")
        self.assertEqual(self.app.overlay_manager.settings["exobio_auto_rule"], "has_bio")
        self.assertTrue(self.app.overlay_manager.settings["auto_rules_enabled"])
        self.assertTrue(self.app.auto_rules_var.get())

    def test_hotkey_choice_is_saved(self):
        widgets = self.app._overlay_block_vars["route"]
        widgets["hotkey"].set("F5")
        self.app._on_block_hotkey_changed("route")
        self.assertEqual(self.app.overlay_manager.settings["route_hotkey"], "F5")

        widgets["hotkey"].set("—")
        self.app._on_block_hotkey_changed("route")
        self.assertNotIn("route_hotkey", self.app.overlay_manager.settings)

    def test_reset_block_syncs_widgets_back(self):
        manager = self.app.overlay_manager
        manager.settings["cargo_alpha"] = 0.4
        manager.settings["cargo_font_size"] = 18
        manager.settings["cargo_locked"] = True
        self.app._on_block_reset("cargo")

        self.assertNotIn("cargo_alpha", manager.settings)
        self.assertNotIn("cargo_font_size", manager.settings)
        self.assertFalse(manager.settings["cargo_locked"])
        widgets = self.app._overlay_block_vars["cargo"]
        self.assertEqual(widgets["alpha"].get(), "общая")
        self.assertEqual(widgets["font_size"].get(), "общий")
        self.assertFalse(widgets["locked"].get())

    def test_click_through_switch_applies_to_blocks_without_own_value(self):
        manager = self.app.overlay_manager
        manager.settings["exobio_click_through"] = True
        self.app.click_through_var.set(True)
        self.app._on_click_through_changed()
        self.assertTrue(manager.settings["click_through"])
        self.assertTrue(self.app._overlay_block_vars["route"]["click_through"].get())
        self.assertTrue(self.app._overlay_block_vars["exobio"]["click_through"].get())

    def test_idle_choice_roundtrip(self):
        self.assertEqual(self.app._idle_label(0), "не скрывать")
        self.assertEqual(self.app._idle_label(45), "45 с")
        self.assertEqual(self.app._idle_label(120), "2 мин")
        self.assertEqual(self.app._idle_seconds("не скрывать"), 0)
        self.assertEqual(self.app._idle_seconds("45 с"), 45)
        self.assertEqual(self.app._idle_seconds("2 мин"), 120)

        self.app.idle_var.set("2 мин")
        self.app._on_idle_changed()
        self.assertEqual(self.app.overlay_manager.settings["idle_timeout"], 120)

    def test_settings_changed_from_overlay_updates_widgets(self):
        """Горячая клавиша скрыла блок — галочка во вкладке должна погаснуть."""
        manager = self.app.overlay_manager
        manager.settings["show_ship"] = True
        manager.toggle_block("ship")
        self.assertFalse(manager.settings["show_ship"])
        self.assertFalse(self.app._overlay_block_vars["ship"]["visible"].get())

    def test_hotkey_hint_is_filled(self):
        self.app._overlay_block_vars["route"]["hotkey"].set("F5")
        self.app._on_block_hotkey_changed("route")
        calls = list(self.app.hotkey_hint_label.configure.call_args_list)
        calls += list(self.app.hotkey_hint_label.config.call_args_list)
        texts = [call.kwargs.get("text") for call in calls if call.kwargs.get("text")]
        self.assertTrue(texts, "подсказка должна обновляться")
        self.assertIn("F5", texts[-1])


class HotkeyTests(unittest.TestCase):
    def test_parse_hotkey(self):
        from hotkeys import parse_hotkey

        self.assertEqual(parse_hotkey("F5"), (0, 0x74))
        self.assertEqual(parse_hotkey("f12"), (0, 0x7B))
        self.assertEqual(parse_hotkey("Ctrl+Alt+F5"), (0x0002 | 0x0001, 0x74))
        self.assertEqual(parse_hotkey("shift+g"), (0x0004, ord("G")))
        self.assertEqual(parse_hotkey("7"), (0, ord("7")))
        self.assertIsNone(parse_hotkey(""))
        self.assertIsNone(parse_hotkey("   "))
        self.assertIsNone(parse_hotkey("нет такой клавиши"))
        self.assertIsNone(parse_hotkey("F5+F6"))

    def test_normalize_hotkey(self):
        from hotkeys import normalize_hotkey

        self.assertEqual(normalize_hotkey("ctrl+alt+f5"), "Ctrl+Alt+F5")
        self.assertEqual(normalize_hotkey("F12"), "F12")
        self.assertEqual(normalize_hotkey(""), "")
        self.assertEqual(normalize_hotkey("shift + x"), "Shift+X")

    def test_manager_is_inert_without_windows(self):
        from hotkeys import HotkeyManager

        manager = HotkeyManager()
        self.assertTrue(manager.register("F5", lambda: None))
        self.assertFalse(manager.start())
        self.assertFalse(manager.running)
        manager.stop()  # не должно падать
        self.assertEqual(manager.combos(), ["F5"])

    def test_bad_combo_is_rejected(self):
        from hotkeys import HotkeyManager

        manager = HotkeyManager()
        self.assertFalse(manager.register("", lambda: None))
        self.assertFalse(manager.register("Ctrl+", lambda: None))
        self.assertFalse(manager.register("нет", lambda: None))
        self.assertEqual(manager.combos(), [])

    def test_dispatch_goes_through_master(self):
        from hotkeys import HotkeyManager

        calls = []
        manager = HotkeyManager(master=mock.MagicMock())
        manager._dispatch(lambda: calls.append("fired"))
        self.assertEqual(calls, [], "колбэк уходит в главный поток Tk, а не вызывается сразу")
        self.assertTrue(manager.master.after.called)


class HotkeyBindingTests(_ManagerTestCase):
    def test_block_hotkey_is_stored_and_reregistered(self):
        with mock.patch.object(self.manager, "register_hotkeys") as register:
            self.manager.set_block_hotkey("route", "F5")
        self.assertEqual(self.manager.settings["route_hotkey"], "F5")
        register.assert_not_called()  # оверлей выключен — регистрировать нечего

        self.manager.enabled = True
        with mock.patch.object(self.manager, "register_hotkeys") as register:
            self.manager.set_block_hotkey("route", "")
        self.assertNotIn("route_hotkey", self.manager.settings)
        register.assert_called()

    def test_register_hotkeys_binds_blocks_and_all(self):
        self.manager.enabled = True
        self.manager.settings["route_hotkey"] = "F5"
        self.manager.settings["toggle_all_hotkey"] = "F12"
        with mock.patch.object(self.manager.hotkeys, "register") as register:
            self.manager.register_hotkeys()
        combos = [call.args[0] for call in register.call_args_list]
        self.assertIn("F5", combos)
        self.assertIn("F12", combos)

    def test_hotkey_callback_toggles_block(self):
        self.manager.enabled = True
        self.manager.settings["route_hotkey"] = "F5"
        self.manager.settings["show_route"] = True
        callbacks = {}

        def fake_register(combo, callback):
            callbacks[combo] = callback
            return True

        with mock.patch.object(self.manager.hotkeys, "register", side_effect=fake_register):
            self.manager.register_hotkeys()
        callbacks["F5"]()
        self.assertFalse(self.manager.settings["show_route"])


if __name__ == "__main__":
    unittest.main()
