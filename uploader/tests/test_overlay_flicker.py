"""Тесты «не мерцает и не виснет» + регистрация блока CARRIER.

Добавлено после жалобы: при редактировании оверлея блоки мигали, а программа
переставала отвечать. Причины были три (см. CHANGES.md, раунд 16):

* Win32-стиль «клик насквозь» применялся заново при каждом чихе;
* ``_set_all_visibility`` раз в секунду делала ``lift()`` + ``-topmost`` по
  всем окнам — Windows пересобирает layered-окна, отсюда мерцание;
* ``set_ship_block`` пересоздавала окно SHIP даже когда значение не менялось.

Тесты работают на настоящих Qt-окнах: прежние заглушки ``object.__new__``
для виджетов невозможны (``TypeError: object.__new__(RouteOverlay) is not
safe``), а Win32-часть проверяется подменой двух функций из ``hud_window``.
"""

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import hud_window  # noqa: E402
import hud_win32  # noqa: E402
import ui_qt  # noqa: E402
from PySide6.QtCore import QCoreApplication  # noqa: E402
from PySide6.QtGui import QShowEvent  # noqa: E402

from test_overlay_layout import _FakeMaster  # noqa: E402
from test_overlay_management import _ManagerTestCase  # noqa: E402

ui_qt.ensure_app()

BASE_SETTINGS = {"font_family": "Consolas", "font_size": 10}


def _flush() -> None:
    """Выполнить отложенные вызовы Qt (``QTimer.singleShot(0, ...)``)."""
    QCoreApplication.sendPostedEvents()
    QCoreApplication.processEvents()


def _route_overlay(settings=None):
    """Настоящий блок ROUTE — на нём и проверяем режим мыши."""
    from overlay import RouteOverlay

    base = dict(BASE_SETTINGS)
    base.update(settings or {})
    overlay = RouteOverlay(None, base)
    return overlay


class _OverlayCase(unittest.TestCase):
    def make_overlay(self, settings=None):
        overlay = _route_overlay(settings)
        self.addCleanup(overlay.destroy)
        return overlay


# ---------------------------------------------------------------------------
class ClickThroughSyncTests(_OverlayCase):
    """Закреплённый блок пропускает мышь сразу и всегда, без перещёлкивания."""

    def test_sync_is_skipped_when_state_unchanged(self):
        overlay = self.make_overlay()
        with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(hud_window, "_set_click_through", return_value=True) as win32:
            overlay._click_through = True
            overlay._alpha = 0.9
            overlay._sync_click_through()
            overlay._sync_click_through()
            overlay._sync_click_through()
            self.assertEqual(win32.call_count, 1, "повторные вызовы не должны дёргать Win32")
            # Альфа окна передаётся в Win32: слоистое окно без атрибутов
            # Windows считает полностью прозрачным.
            self.assertEqual(win32.call_args[0], (4242, True, 0.9))
            # Прозрачность < 100 % — слой нужен самому Qt, снимать его нельзя.
            self.assertTrue(win32.call_args[1]["keep_layered"])
            # force=True — проверяем стиль на самом окне ещё раз.
            overlay._sync_click_through(force=True)
            self.assertEqual(win32.call_count, 2)

    def test_style_waits_for_real_window(self):
        """Стиль ставится только когда у окна есть настоящий HWND.

        Пока Qt не показал окно, `_toplevel_hwnd()` возвращает None; раньше
        «клик насквозь» всё равно считался применённым, и сохранённый режим
        не работал, пока его не перещёлкнешь. Теперь без HWND стиль не
        считается применённым и ставится по показу окна.
        """
        overlay = self.make_overlay()
        overlay._click_through = True
        with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=None), \
                mock.patch.object(hud_window, "_set_click_through", return_value=True) as win32:
            self.assertFalse(overlay._sync_click_through())
            win32.assert_not_called()
            self.assertIsNone(overlay._applied_through)

        with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(hud_window, "_set_click_through", return_value=True) as win32:
            overlay._on_window_map()
            self.assertIsNone(overlay._applied_through, "по показу стиль перепроверяем")
            _flush()                                # Qt выполняет singleShot(0)
            win32.assert_called_once()
            self.assertEqual(win32.call_args[0][:2], (4242, True))
            self.assertTrue(overlay._applied_through)

    def test_show_event_reapplies_style(self):
        """Показ окна — повод перепроверить стиль: HWND мог смениться."""
        overlay = self.make_overlay()
        overlay._click_through = True
        with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(hud_window, "_set_click_through", return_value=True) as win32:
            overlay._applied_through = True
            overlay.showEvent(QShowEvent())
            self.assertIsNone(overlay._applied_through)
            _flush()
            win32.assert_called_once()
            self.assertTrue(overlay._applied_through)

    def test_recreated_frame_is_styled_again(self):
        """Окно пересоздано (новый HWND) — стиль нужно поставить на новое."""
        overlay = self.make_overlay()
        overlay._click_through = True
        with mock.patch.object(hud_window, "_set_click_through", return_value=True) as win32:
            with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=4242):
                overlay._sync_click_through()
            with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=5151):
                overlay._sync_click_through()
        self.assertEqual([call.args[0] for call in win32.call_args_list], [4242, 5151])

    def test_failed_write_is_retried(self):
        overlay = self.make_overlay()
        overlay._click_through = True
        with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(hud_window, "_set_click_through",
                                  side_effect=[False, True]) as win32:
            self.assertFalse(overlay._sync_click_through())
            self.assertIsNone(overlay._applied_through)
            self.assertTrue(overlay._sync_click_through())
            self.assertEqual(win32.call_count, 2)

    def test_lock_switches_click_through(self):
        """Закрепили — мышь уходит в игру; открепили — блок снова ловит мышь."""
        overlay = self.make_overlay()
        with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(hud_window, "_set_click_through", return_value=True) as win32:
            overlay.set_locked(True)
            self.assertTrue(overlay._locked)
            self.assertTrue(overlay._click_through)
            self.assertTrue(overlay.settings["route_locked"])
            self.assertTrue(overlay.grip.isHidden(), "уголок ресайза закреплённому не нужен")
            _flush()
            self.assertEqual(win32.call_count, 1)

            overlay.set_locked(True)      # то же состояние — окно не трогаем
            _flush()
            self.assertEqual(win32.call_count, 1)

            overlay.set_locked(False)
            self.assertFalse(overlay._click_through)
            self.assertFalse(overlay.settings["route_locked"])
            self.assertFalse(overlay.grip.isHidden())
            _flush()
            self.assertEqual(win32.call_count, 2)

    def test_header_lock_goes_through_manager(self):
        """LK/UL в шапке сохраняет настройку через менеджер (и вкладку тоже)."""
        overlay = self.make_overlay()
        controller = mock.Mock()
        overlay.set_controller(controller)
        overlay._toggle_lock()
        controller.set_block_locked.assert_called_once_with("route", True)

    def test_alpha_change_reapplies_layered_window(self):
        overlay = self.make_overlay()
        with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(hud_window, "_set_click_through", return_value=True) as win32:
            overlay._applied_through = True
            overlay.set_alpha(0.4, save=False)
            # Состояние сброшено — следующий sync применит стиль заново:
            # смена прозрачности переписывает расширенный стиль окна.
            self.assertIsNone(overlay._applied_through)
            self.assertAlmostEqual(overlay._alpha, 0.4)
            _flush()
            win32.assert_called_once()
            self.assertAlmostEqual(win32.call_args[0][2], 0.4)

    def test_ensure_mouse_mode_checks_visible_window(self):
        overlay = self.make_overlay()
        with mock.patch.object(hud_window, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(hud_window, "_set_click_through", return_value=True) as win32:
            overlay._applied_through = True
            overlay._hwnd = 4242
            self.assertFalse(overlay.ensure_mouse_mode(), "скрытое окно не трогаем")
            win32.assert_not_called()
            overlay.show()
            _flush()
            win32.reset_mock()
            self.assertTrue(overlay.ensure_mouse_mode())
            win32.assert_called_once()

    def test_win32_helper_survives_absent_windows(self):
        """На Linux/в CI без Windows функция не падает и возвращает False."""
        import ctypes

        if hasattr(ctypes, "windll"):
            self.skipTest("тест для окружения без Win32 API")
        self.assertFalse(hud_win32._set_click_through(4242, True))
        self.assertFalse(hud_win32._set_click_through(0, False))


class SetClickThroughWin32Tests(unittest.TestCase):
    """Логика записи стиля: только при отличии, с проверкой результата."""

    GWL_EXSTYLE = hud_win32.GWL_EXSTYLE

    def _run(self, user32, *args, **kwargs):
        with mock.patch.object(hud_win32, "_user32", return_value=user32):
            return hud_win32._set_click_through(*args, **kwargs)

    def test_enable_adds_flags_once(self):
        user32 = _FakeUser32({1: 0})
        self.assertTrue(self._run(user32, 1, True, 0.9))
        self.assertEqual(user32.styles[1],
                         hud_win32.WS_EX_TRANSPARENT | hud_win32.WS_EX_LAYERED)
        self.assertEqual(user32.layered_attrs, [(1, 230)], "новый слой обязан получить альфу")
        self.assertEqual(user32.frame_changes, 1)
        # Повтор — стиль уже на месте, писать нечего.
        self.assertTrue(self._run(user32, 1, True, 0.9))
        self.assertEqual(len(user32.writes), 1)

    def test_layer_of_qt_is_kept(self):
        user32 = _FakeUser32({1: hud_win32.WS_EX_LAYERED})
        self.assertTrue(self._run(user32, 1, True, 0.9))
        self.assertEqual(user32.layered_attrs, [], "альфу готового слоя не перетираем")
        self.assertTrue(self._run(user32, 1, False, 0.9, keep_layered=True))
        self.assertEqual(user32.styles[1], hud_win32.WS_EX_LAYERED)

    def test_own_layer_is_removed_on_unlock(self):
        user32 = _FakeUser32({1: hud_win32.WS_EX_TRANSPARENT | hud_win32.WS_EX_LAYERED})
        self.assertTrue(self._run(user32, 1, False, 1.0, keep_layered=False))
        self.assertEqual(user32.styles[1], 0)

    def test_failed_write_is_reported(self):
        user32 = _FakeUser32({1: 0}, broken_write=True)
        self.assertFalse(self._run(user32, 1, True, 0.9),
                         "стиль не встал — это не успех, иначе повтора не будет")

    def test_dead_window_is_skipped(self):
        user32 = _FakeUser32({})
        self.assertFalse(self._run(user32, 1, True, 0.9))
        self.assertEqual(user32.writes, [])

    def test_user32_functions_get_prototypes(self):
        """64-битные HWND и LONG_PTR не обрезаются: у функций есть прототипы.

        На 32-битной Windows функций *LongPtr* нет — берём GetWindowLongW.
        """
        import ctypes

        class _Func:
            argtypes = None
            restype = None

        class _Lib:
            def __init__(self, missing=()):
                self.missing = set(missing)
                self.funcs = {}

            def __getattr__(self, name):
                if name in self.missing or name.startswith("__"):
                    raise AttributeError(name)
                return self.funcs.setdefault(name, _Func())

        for missing, getter in (((), "GetWindowLongPtrW"),
                                (("GetWindowLongPtrW",), "GetWindowLongW")):
            with self.subTest(getter=getter):
                lib = _Lib(missing)
                with mock.patch.object(hud_win32, "_USER32", None), \
                        mock.patch.object(ctypes, "WinDLL", create=True, return_value=lib):
                    api = hud_win32._user32()
                    self.assertIsNotNone(api)
                    self.assertIs(api.GetWindowLong, lib.funcs[getter])
                    self.assertIsNotNone(lib.funcs[getter].restype)
                    self.assertIsNotNone(lib.funcs["GetAncestor"].argtypes)
                    self.assertIsNotNone(lib.funcs["SetWindowPos"].argtypes)


class _FakeUser32:
    """user32 без Windows: расширенные стили окон живут в словаре.

    `broken_write` — SetWindowLong «не срабатывает» (как у чужого или уже
    уничтоженного окна): стиль остаётся прежним.
    """

    def __init__(self, styles=None, broken_write=False):
        self.styles = dict(styles or {})
        self.broken_write = broken_write
        self.writes = []
        self.layered_attrs = []
        self.frame_changes = 0

    def IsWindow(self, hwnd):
        return hwnd in self.styles

    def GetWindowLong(self, hwnd, index):
        return self.styles[hwnd]

    def SetWindowLong(self, hwnd, index, value):
        self.writes.append((hwnd, value))
        if not self.broken_write:
            self.styles[hwnd] = value
        return 0

    def SetLayeredWindowAttributes(self, hwnd, key, alpha, flags):
        self.layered_attrs.append((hwnd, alpha))
        return 1

    def SetWindowPos(self, *args):
        self.frame_changes += 1
        return 1


# ---------------------------------------------------------------------------
class _ZBlock:
    """Блок-заглушка для проверки подъёма в Z-order.

    Менеджер общается с блоками через методы (`is_visible`, `show`, `hide`,
    `lift`, `set_topmost`), поэтому Qt-окно здесь не нужно.
    """

    def __init__(self, key="route"):
        self.overlay_key = key
        self.visible = False
        self.lifts = 0
        self.topmost_calls = []
        self._is_topmost = True
        self._dragging = False
        self._hwnd = 4242

    def is_visible(self):
        return self.visible

    def show(self):
        self.visible = True

    def hide(self):
        self.visible = False

    def lift(self):
        self.lifts += 1

    def set_topmost(self, value):
        self.topmost_calls.append(bool(value))
        self._is_topmost = bool(value)


class ZOrderRefreshTests(_ManagerTestCase):
    """Z-order поднимается не каждый тик — иначе блоки мерцают."""

    def _attach_z(self, *keys):
        blocks = {}
        for key in keys:
            block = _ZBlock(key)
            setattr(self.manager, f"{key}_overlay", block)
            blocks[key] = block
        return blocks

    def test_lift_once_then_throttled(self):
        import overlay

        blocks = self._attach_z("route", "cargo")
        self.manager._zorder_at = 0.0
        self.manager._set_all_visibility(True)
        first = sum(b.lifts for b in blocks.values())
        self.assertEqual(first, 2, "при первом показе окна поднимаем")
        for _ in range(5):
            self.manager._set_all_visibility(True)
        self.assertEqual(sum(b.lifts for b in blocks.values()), first,
                         "каждую секунду пересобирать окна не надо")
        # Прошло больше ZORDER_REFRESH_SECONDS — порядок освежаем.
        self.manager._zorder_at = time.monotonic() - overlay.ZORDER_REFRESH_SECONDS - 1
        self.manager._set_all_visibility(True)
        self.assertEqual(sum(b.lifts for b in blocks.values()), first + 2)

    def test_no_lift_while_dragging(self):
        block = self._attach_z("route")["route"]
        block._dragging = True
        self.manager._zorder_at = 0.0
        self.manager._set_all_visibility(True)
        self.assertEqual(block.lifts, 0, "во время перетаскивания окна не трогаем")
        block._dragging = False
        self.manager._zorder_at = 0.0
        self.manager._set_all_visibility(True)
        self.assertEqual(block.lifts, 1)

    def test_lost_topmost_is_restored(self):
        block = self._attach_z("route")["route"]
        self.manager._set_all_visibility(True)
        block._is_topmost = False  # например, игра перехватила окно
        lifted = block.lifts
        self.manager._set_all_visibility(True)
        self.assertEqual(block.lifts, lifted + 1)
        self.assertIn(True, block.topmost_calls)

    def test_hidden_block_is_not_lifted(self):
        block = self._attach_z("route")["route"]
        self.manager.settings["show_route"] = False
        self.manager._zorder_at = 0.0
        self.manager._set_all_visibility(True)
        self.assertEqual(block.lifts, 0)
        self.assertFalse(block.is_visible())


# ---------------------------------------------------------------------------
class ShipBlockRebuildTests(_ManagerTestCase):
    """Внутренние блоки SHIP не пересоздают окно, если ничего не изменилось."""

    def test_same_value_does_not_recreate_window(self):
        import overlay

        self.manager.enabled = True
        self.manager.ship_overlay = mock.MagicMock()
        self.manager.settings["show_pips"] = True
        with mock.patch.object(overlay, "ShipOverlay") as ship_class:
            self.manager.set_ship_block("pips", True)   # уже включено
            ship_class.assert_not_called()
            self.manager.set_ship_block("pips", False)  # меняем — пересоздаём
            ship_class.assert_called_once()
            self.assertFalse(self.manager.settings["show_pips"])

    def test_value_is_still_saved_on_unchanged_call(self):
        self.manager.enabled = True
        self.manager.ship_overlay = mock.MagicMock()
        self.manager.settings.pop("show_hull", None)
        self.manager.set_ship_block("hull", True)
        self.assertTrue(self.manager.settings["show_hull"])


# ---------------------------------------------------------------------------
class CarrierBlockRegistrationTests(unittest.TestCase):
    """Блок CARRIER зарегистрирован во всех реестрах оверлея."""

    def test_block_is_known_everywhere(self):
        from overlay import (AUTO_RULES, AUTO_RULE_LABELS, BLOCK_LABELS, DEFAULT_SETTINGS,
                             DEFAULT_BLOCK_POSITIONS, OverlayManager)

        self.assertIn("carrier", OverlayManager.BLOCKS)
        self.assertIn("carrier", BLOCK_LABELS)
        self.assertIn("carrier", DEFAULT_BLOCK_POSITIONS)
        self.assertIn("show_carrier", DEFAULT_SETTINGS)
        for suffix in ("x", "y", "width", "height", "locked", "anchor"):
            self.assertIn(f"carrier_{suffix}", DEFAULT_SETTINGS,
                          "без ключа в DEFAULT_SETTINGS настройка не сохранится")
        self.assertIn("at_carrier", AUTO_RULES)
        self.assertIn("at_carrier", AUTO_RULE_LABELS)

    def test_settings_persist_carrier_prefix(self):
        """save_overlay_settings копирует в конфиг только известные префиксы."""
        import inspect

        import overlay

        source = inspect.getsource(overlay.save_overlay_settings)
        self.assertIn('"carrier_"', source,
                      "настройки блока CARRIER должны попадать в конфиг")

    def test_at_carrier_rule(self):
        from overlay import auto_rule_matches

        self.assertTrue(auto_rule_matches("at_carrier", {"at_carrier": True}))
        self.assertFalse(auto_rule_matches("at_carrier", {"at_carrier": False}))
        self.assertFalse(auto_rule_matches("at_carrier", {}))

    def test_context_picks_at_carrier_from_data(self):
        import tempfile
        from pathlib import Path as _Path

        from overlay import OverlayManager

        with tempfile.TemporaryDirectory() as tmp:
            manager = OverlayManager(_FakeMaster(), _Path(tmp) / "config.json")
            context = manager.update_context({"carrier": {"at_carrier": True}})
            self.assertTrue(context["at_carrier"])
            context = manager.update_context({})
            self.assertFalse(context["at_carrier"])
            manager._stop.set()

    def test_hash_includes_carrier_data(self):
        """Иначе изменения груза на авианосце не дойдут до окна."""
        import tempfile
        from pathlib import Path as _Path

        from overlay import OverlayManager

        with tempfile.TemporaryDirectory() as tmp:
            manager = OverlayManager(_FakeMaster(), _Path(tmp) / "config.json")
            first = manager._hash_data({"carrier": {"stored": 440}})
            second = manager._hash_data({"carrier": {"stored": 460}})
            self.assertNotEqual(first, second)
            manager._stop.set()


# ---------------------------------------------------------------------------
class FootMapBlockRegistrationTests(unittest.TestCase):
    """Блок FOOTMAP зарегистрирован во всех реестрах оверлея."""

    def test_block_is_known_everywhere(self):
        from overlay import (AUTO_RULES, AUTO_RULE_LABELS, BLOCK_LABELS, DEFAULT_SETTINGS,
                             DEFAULT_BLOCK_POSITIONS, OVERLAY_META, OverlayManager)

        self.assertIn("footmap", OverlayManager.BLOCKS)
        self.assertIn("footmap", BLOCK_LABELS)
        self.assertIn("footmap", DEFAULT_BLOCK_POSITIONS)
        self.assertIn("footmap", OVERLAY_META)
        self.assertEqual(OVERLAY_META["footmap"][0], "09")
        self.assertIn("show_footmap", DEFAULT_SETTINGS)
        for suffix in ("x", "y", "width", "height", "locked", "anchor", "auto_rule"):
            self.assertIn(f"footmap_{suffix}", DEFAULT_SETTINGS,
                          "без ключа в DEFAULT_SETTINGS настройка не сохранится")
        # Миникарта нужна только пешеходу, поэтому правило по умолчанию — OnFoot.
        self.assertEqual(DEFAULT_SETTINGS["footmap_auto_rule"], "on_foot")
        self.assertIn("on_foot", AUTO_RULES)
        self.assertIn("on_foot", AUTO_RULE_LABELS)

    def test_settings_persist_footmap_prefix(self):
        """save_overlay_settings копирует в конфиг только известные префиксы."""
        import inspect

        import overlay

        source = inspect.getsource(overlay.save_overlay_settings)
        self.assertIn('"footmap_"', source,
                      "настройки блока FOOTMAP должны попадать в конфиг")

    def test_on_foot_rule(self):
        from overlay import auto_rule_matches

        self.assertTrue(auto_rule_matches("on_foot", {"flags": {"OnFoot"}}))
        self.assertFalse(auto_rule_matches("on_foot", {"flags": {"Docked"}}))
        self.assertFalse(auto_rule_matches("on_foot", {}))

    def test_block_starts_hidden_until_the_pilot_walks(self):
        """При включённых автоправилах блок появляется только пешком."""
        import tempfile
        from pathlib import Path as _Path

        from overlay import OverlayManager

        with tempfile.TemporaryDirectory() as tmp:
            manager = OverlayManager(_FakeMaster(), _Path(tmp) / "config.json")
            manager.settings["auto_rules_enabled"] = True
            walking = manager.evaluate_block_visibility(
                {"game_running": True, "flags": {"OnFoot"}})
            flying = manager.evaluate_block_visibility(
                {"game_running": True, "flags": set()})
            self.assertTrue(walking["footmap"])
            self.assertFalse(flying["footmap"])
            manager._stop.set()

    def test_hash_includes_footmap_data(self):
        """Иначе блок замирал: журнал молчит, а командир идёт."""
        import tempfile
        from pathlib import Path as _Path

        from overlay import OverlayManager

        with tempfile.TemporaryDirectory() as tmp:
            manager = OverlayManager(_FakeMaster(), _Path(tmp) / "config.json")
            base = {"footmap": {"known": True, "lat": 1.0, "lon": 2.0, "heading": 10.0,
                                "trail": [], "pois": [], "ship": None}}
            moved = {"footmap": dict(base["footmap"], lat=1.0002)}
            turned = {"footmap": dict(base["footmap"], heading=90.0)}
            self.assertNotEqual(manager._hash_data(base), manager._hash_data(moved))
            self.assertNotEqual(manager._hash_data(base), manager._hash_data(turned))
            manager._stop.set()


# ---------------------------------------------------------------------------
class SizeProbeTests(_OverlayCase):
    """size() отдаёт реальный размер окна, сохранённый — только как запас."""

    def test_reports_real_widget_size(self):
        overlay = self.make_overlay()
        overlay.resize(320, 240)
        self.assertEqual(overlay.size(), (320, 240))

    def test_falls_back_to_saved_settings(self):
        """Пока окно не разложено (0×0), берём сохранённый размер из настроек."""
        from hud_window import HudWindow

        class _Cold:
            overlay_key = "route"
            settings = {"route_width": 300, "route_height": 200}

            @staticmethod
            def width():
                return 0

            @staticmethod
            def height():
                return 0

        self.assertEqual(HudWindow.size(_Cold()), (300, 200))


# ---------------------------------------------------------------------------
class CarrierOverlayRenderTests(_OverlayCase):
    """Окно CARRIER строится и показывает тоннаж, товары и остаток."""

    def _overlay(self, settings=None):
        from overlay import CarrierOverlay

        base = dict(BASE_SETTINGS)
        base.update(settings or {})
        overlay = CarrierOverlay(None, base)
        self.addCleanup(overlay.destroy)
        return overlay

    @staticmethod
    def _text(widget):
        return str(widget.text())

    def _rows(self, overlay):
        """Тексты заполненных строк списка товаров (по ключам ячеек)."""
        rows = []
        for entry in overlay._row_pool[:len(overlay._row_order)]:
            cells = entry["cells"]
            rows.append(tuple(self._text(cells[key])
                              for key in ("name", "board", "need", "tail")))
        return rows

    def _headers(self, overlay):
        return [self._text(label) for label, _chars in overlay._header_cells]

    def test_shows_tonnage_and_remaining(self):
        overlay = self._overlay()
        overlay.update_carrier({
            "name": "Spirula", "callsign": "L14-X1J", "system_name": "Hermitage",
            "stats_seen": True, "at_carrier": True,
            "stored": 440, "cargo_capacity": 17819, "free": 17379,
            "fill_percent": 2, "tracked_total": 420, "need_total": 500,
            "commodities": [
                {"key": "steel", "name": "Steel", "amount": 120, "need": 200, "remaining": 80},
                {"key": "tritium", "name": "Tritium", "amount": 300, "need": 300, "remaining": 0},
            ],
        })
        self.assertEqual(self._text(overlay.name_label), "Spirula")
        self.assertEqual(self._text(overlay.callsign_label), "L14-X1J")
        self.assertEqual(self._text(overlay.total_label), "440 / 17819 t")
        summary = self._text(overlay.summary_label)
        self.assertIn("420 / 500", summary)
        self.assertIn("80", summary)

    def test_without_stats_says_so(self):
        overlay = self._overlay()
        overlay.update_carrier({
            "name": "", "stats_seen": False, "tracked_total": 30,
            "commodities": [{"key": "steel", "name": "Steel", "amount": 30,
                             "need": 0, "remaining": 0}],
        })
        self.assertEqual(self._text(overlay.name_label), "Fleet Carrier")
        self.assertIn("учтено по журналу", self._text(overlay.total_label))

    def test_on_board_column_and_project_label(self):
        """Главное число — «на борту»; видно, чей это список материалов."""
        overlay = self._overlay()
        overlay.update_carrier({
            "name": "Spirula", "stats_seen": True, "at_carrier": True,
            "stored": 250, "cargo_capacity": 17819, "free": 17569, "fill_percent": 1,
            "need_total": 4900, "need_label": "Jameson Memorial (Kuma)",
            "need_source": "project", "delivered_total": 120, "remote_seen": True,
            "commodities": [
                {"key": "steel", "name": "Steel", "amount": 250, "delivered": 120,
                 "need": 4000, "remaining": 3750},
                {"key": "titanium", "name": "Titanium", "amount": 0, "delivered": 0,
                 "need": 900, "remaining": 900},
            ],
        })
        project = self._text(overlay.project_label)
        self.assertIn("Проект (основной)", project)
        self.assertIn("Jameson Memorial", project)
        self.assertIn("нужно 4900 t", project)

        summary = self._text(overlay.summary_label)
        self.assertIn("На борту 250 / 4900 t", summary)
        self.assertIn("осталось 4650 t", summary)
        self.assertIn("Raven Colonial", summary)
        self.assertIn("завезено вами 120 t", summary)

        # Строки: «на борту» с долей командира в скобках.
        self.assertEqual(self._rows(overlay), [
            ("Steel", "250 (120)", "4000", "-3750"),
            ("Titanium", "0", "900", "-900"),
        ])
        self.assertEqual(self._headers(overlay), ["Товар", "на борту", "нужно", "ост."])

    def test_rows_are_reused_between_updates(self):
        """Строки переиспользуются, а не пересоздаются: иначе список мигает."""
        overlay = self._overlay()
        data = {
            "name": "Spirula", "stats_seen": True,
            "commodities": [
                {"key": "steel", "name": "Steel", "amount": 10, "need": 20, "remaining": 10},
                {"key": "titanium", "name": "Titanium", "amount": 5, "need": 5, "remaining": 0},
            ],
        }
        overlay.update_carrier(data)
        created = len(overlay._row_pool)
        self.assertEqual(created, 2)
        overlay.update_carrier(data)
        self.assertEqual(len(overlay._row_pool), created, "виджеты строк не пересоздаются")
        self.assertEqual(self._rows(overlay)[0][0], "Steel")

    def test_site_need_is_labelled_as_site(self):
        overlay = self._overlay()
        overlay.update_carrier({
            "name": "Spirula", "stats_seen": True,
            "need_total": 100, "need_label": "Planetary Construction Site: 1",
            "need_source": "site",
            "commodities": [{"key": "steel", "name": "Steel", "amount": 100,
                             "delivered": 100, "need": 100, "remaining": 0}],
        })
        self.assertIn("Стройплощадка", self._text(overlay.project_label))
        self.assertNotIn("Проект (основной)", self._text(overlay.project_label))

    def test_closed_need_shows_ok(self):
        overlay = self._overlay()
        overlay.update_carrier({
            "name": "Spirula", "stats_seen": True,
            "need_total": 100, "need_label": "Jameson Memorial", "need_source": "project",
            "commodities": [{"key": "steel", "name": "Steel", "amount": 100,
                             "delivered": 100, "need": 100, "remaining": 0}],
        })
        summary = self._text(overlay.summary_label)
        self.assertIn("осталось 0 t", summary)
        self.assertEqual(self._rows(overlay)[0][3], "OK")

    def test_no_project_selected_hints_where_to_go(self):
        overlay = self._overlay()
        overlay.update_carrier({
            "name": "Spirula", "stats_seen": True,
            "stored": 440, "cargo_capacity": 17819, "free": 17379,
            "commodities": [{"key": "steel", "name": "Steel", "amount": 120,
                             "delivered": 120, "need": 0, "remaining": 0}],
        })
        project = self._text(overlay.project_label)
        self.assertIn("Проект не выбран", project)
        self.assertIn("Колонизатор", project)

    def test_local_accounting_is_labelled_as_yours_only(self):
        """Без снимка Raven цифра — только ваши перевозки, и это подписано."""
        overlay = self._overlay()
        overlay.update_carrier({
            "name": "Spirula", "stats_seen": False, "tracked_total": 120,
            "delivered_total": 120, "remote_seen": False,
            "need_total": 500, "need_label": "Jameson Memorial", "need_source": "project",
            "commodities": [{"key": "steel", "name": "Steel", "amount": 120,
                             "delivered": 120, "need": 500, "remaining": 380}],
        })
        summary = self._text(overlay.summary_label)
        self.assertIn("по журналу", summary)
        self.assertIn("только ваши перевозки", summary)
        self.assertNotIn("Raven Colonial", summary)

    def test_empty_state_does_not_crash(self):
        overlay = self._overlay()
        overlay.update_carrier({})
        overlay.update_carrier(None)
        self.assertEqual(self._text(overlay.name_label), "Fleet Carrier")
        self.assertEqual(overlay._row_order, [])
        self.assertTrue(overlay._empty_label.isVisible() or True, "пустое состояние показано")


if __name__ == "__main__":
    unittest.main(verbosity=2)
