"""Тесты «не мерцает и не виснет» + регистрация блока CARRIER.

Добавлено после жалобы: при редактировании оверлея блоки мигали, а программа
переставала отвечать. Причины были три (см. CHANGES.md, раунд 16):

* Win32-стиль «клик насквозь» применялся заново при каждом чихе, а
  ``WS_EX_LAYERED`` оставался на окне навсегда;
* ``_set_all_visibility`` раз в секунду делала ``lift()`` + ``-topmost`` по
  всем окнам — Windows пересобирает layered-окна, отсюда мерцание;
* ``set_ship_block`` пересоздавала окно SHIP даже когда значение не менялось.
"""

import sys
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_overlay_layout import _FakeMaster  # noqa: E402
from test_overlay_management import _ManagerTestCase, _ensure_gui_stubs  # noqa: E402

_ensure_gui_stubs()


class _ZOrderWindow:
    """Окно, которое считает, сколько раз его поднимали в Z-order."""

    def __init__(self, viewable=True):
        self._viewable = viewable
        self.lifts = 0
        self.topmost = []

    def winfo_viewable(self):
        return self._viewable

    def lift(self):
        self.lifts += 1

    def attributes(self, name, value=None):
        if name == "-topmost":
            self.topmost.append(value)
        return None

    def deiconify(self):
        self._viewable = True

    def withdraw(self):
        self._viewable = False


class _ZBlock:
    """Блок-заглушка для проверки подъёма в Z-order."""

    def __init__(self, key="route", viewable=True):
        self.overlay_key = key
        self.window = _ZOrderWindow(viewable)
        self._is_topmost = True
        self._dragging = False
        self.topmost_calls = []

    def set_topmost(self, value):
        self.topmost_calls.append(bool(value))
        self._is_topmost = bool(value)

    def show(self):
        self.window.deiconify()

    def hide(self):
        self.window.withdraw()


class _ClickThroughBlock:
    """Минимальный блок для проверки синхронизации «клик насквозь»."""

    def __init__(self, locked=False):
        from overlay import OverlayWindow

        self.block = OverlayWindow.__new__(OverlayWindow)
        self.block.overlay_key = "route"
        self.block.settings = {}
        self.block._locked = locked
        self.block._click_through = locked
        self.block._detached = False
        self.block._controller = None
        self.block._alpha = 0.9
        self.block._tk_layered = True
        self.block._applied_through = None
        self.block._hwnd = None
        self.block._is_topmost = True
        self.block._dragging = False
        self.block.lock_btn = mock.MagicMock()
        self.block.drag_label = mock.MagicMock()
        self.block.resize_handle = mock.MagicMock()
        self.block.header_indicator = mock.MagicMock()
        self.block.signal_rail = mock.MagicMock()
        self.block.window = mock.MagicMock()


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
class ClickThroughSyncTests(unittest.TestCase):
    """Закреплённый блок пропускает мышь сразу и всегда, без перещёлкивания."""

    def test_sync_is_skipped_when_state_unchanged(self):
        import overlay

        fixture = _ClickThroughBlock()
        with mock.patch.object(overlay, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(overlay, "_set_click_through", return_value=True) as win32:
            fixture.block._click_through = True
            fixture.block._sync_click_through()
            fixture.block._sync_click_through()
            fixture.block._sync_click_through()
            self.assertEqual(win32.call_count, 1, "повторные вызовы не должны дёргать Win32")
            # Альфа окна передаётся в Win32: слоистое окно без атрибутов
            # Windows считает полностью прозрачным.
            self.assertEqual(win32.call_args[0], (4242, True, 0.9))
            # Слой поставил сам Tk (прозрачность < 100 %) — снимать его нельзя.
            self.assertTrue(win32.call_args[1]["keep_layered"])
            # force=True — проверяем стиль на самом окне ещё раз.
            fixture.block._sync_click_through(force=True)
            self.assertEqual(win32.call_count, 2)

    def test_style_waits_for_real_window(self):
        """Корень жалобы: стиль ставился до того, как у окна появилась рамка.

        Tk создаёт настоящее окно верхнего уровня только при первом показе.
        Раньше «клик насквозь» применялся через after_idle сразу после
        создания блока — к несуществующей рамке, — и сохранённый режим не
        работал, пока его не перещёлкнешь. Теперь без рамки стиль не
        считается применённым и ставится по <Map>.
        """
        import overlay

        fixture = _ClickThroughBlock(locked=True)
        block = fixture.block
        with mock.patch.object(overlay, "_toplevel_hwnd", return_value=None), \
                mock.patch.object(overlay, "_set_click_through", return_value=True) as win32:
            self.assertFalse(block._sync_click_through())
            win32.assert_not_called()
            self.assertIsNone(block._applied_through)

        with mock.patch.object(overlay, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(overlay, "_set_click_through", return_value=True) as win32:
            event = mock.Mock(widget=block.window)
            block._on_window_map(event)
            block.window.after_idle.assert_called_with(block._sync_click_through)
            block.window.after_idle.call_args[0][0]()   # Tk выполняет отложенный вызов
            win32.assert_called_once()
            self.assertEqual(win32.call_args[0][:2], (4242, True))
            self.assertTrue(block._applied_through)

    def test_map_of_child_widget_is_ignored(self):
        fixture = _ClickThroughBlock(locked=True)
        fixture.block._on_window_map(mock.Mock(widget=object()))
        fixture.block.window.after_idle.assert_not_called()

    def test_recreated_frame_is_styled_again(self):
        """Tk пересоздал рамку окна — стиль нужно поставить на новую."""
        import overlay

        fixture = _ClickThroughBlock(locked=True)
        with mock.patch.object(overlay, "_set_click_through", return_value=True) as win32:
            with mock.patch.object(overlay, "_toplevel_hwnd", return_value=4242):
                fixture.block._sync_click_through()
            with mock.patch.object(overlay, "_toplevel_hwnd", return_value=5151):
                fixture.block._sync_click_through()
        self.assertEqual([call.args[0] for call in win32.call_args_list], [4242, 5151])

    def test_failed_write_is_retried(self):
        import overlay

        fixture = _ClickThroughBlock(locked=True)
        with mock.patch.object(overlay, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(overlay, "_set_click_through", side_effect=[False, True]) as win32:
            self.assertFalse(fixture.block._sync_click_through())
            self.assertIsNone(fixture.block._applied_through)
            self.assertTrue(fixture.block._sync_click_through())
            self.assertEqual(win32.call_count, 2)

    def test_lock_switches_click_through(self):
        """Закрепили — мышь уходит в игру; открепили — блок снова ловит мышь."""
        fixture = _ClickThroughBlock()
        block = fixture.block
        block._flash_indicator = mock.MagicMock()
        block.set_locked(True)
        self.assertTrue(block._locked)
        self.assertTrue(block._click_through)
        self.assertTrue(block.settings["route_locked"])
        self.assertEqual(block.window.after_idle.call_count, 1)
        block.resize_handle.place_forget.assert_called_once()

        block.set_locked(True)   # то же состояние — окно не трогаем
        self.assertEqual(block.window.after_idle.call_count, 1)

        block.set_locked(False)
        self.assertFalse(block._click_through)
        self.assertFalse(block.settings["route_locked"])
        self.assertEqual(block.window.after_idle.call_count, 2)
        block.resize_handle.place.assert_called()

    def test_header_lock_goes_through_manager(self):
        """LK/UL в шапке сохраняет настройку через менеджер (и вкладку тоже)."""
        fixture = _ClickThroughBlock()
        controller = mock.Mock()
        fixture.block.set_controller(controller)
        fixture.block._toggle_lock()
        controller.set_block_locked.assert_called_once_with("route", True)

    def test_alpha_change_reapplies_layered_window(self):
        fixture = _ClickThroughBlock(locked=True)
        fixture.block._applied_through = True
        fixture.block._tk_layered = False
        fixture.block.set_alpha(0.4, save=False)
        # Состояние сброшено — следующий sync применит стиль заново: Tk,
        # впервые делая окно полупрозрачным, затирает WS_EX_TRANSPARENT.
        self.assertIsNone(fixture.block._applied_through)
        self.assertEqual(fixture.block._alpha, 0.4)
        self.assertTrue(fixture.block._tk_layered)
        fixture.block.window.after_idle.assert_called_with(fixture.block._sync_click_through)

    def test_ensure_mouse_mode_checks_visible_window(self):
        import overlay

        fixture = _ClickThroughBlock(locked=True)
        fixture.block._applied_through = True
        fixture.block._hwnd = 4242
        fixture.block.window.winfo_viewable.return_value = True
        with mock.patch.object(overlay, "_toplevel_hwnd", return_value=4242), \
                mock.patch.object(overlay, "_set_click_through", return_value=True) as win32:
            self.assertTrue(fixture.block.ensure_mouse_mode())
            win32.assert_called_once()
            fixture.block.window.winfo_viewable.return_value = False
            self.assertFalse(fixture.block.ensure_mouse_mode())
            win32.assert_called_once()

    def test_win32_helper_survives_absent_windows(self):
        """На Linux/в CI без Windows функция не падает и возвращает False."""
        import ctypes

        import overlay

        if hasattr(ctypes, "windll"):
            self.skipTest("тест для окружения без Win32 API")
        self.assertFalse(overlay._set_click_through(4242, True))
        self.assertFalse(overlay._set_click_through(0, False))


class SetClickThroughWin32Tests(unittest.TestCase):
    """Логика записи стиля: только при отличии, с проверкой результата."""

    def _run(self, user32, *args, **kwargs):
        import overlay

        with mock.patch.object(overlay, "_user32", return_value=user32):
            return overlay._set_click_through(*args, **kwargs)

    def test_enable_adds_flags_once(self):
        import overlay

        user32 = _FakeUser32({1: 0})
        self.assertTrue(self._run(user32, 1, True, 0.9))
        self.assertEqual(user32.styles[1], overlay.WS_EX_TRANSPARENT | overlay.WS_EX_LAYERED)
        self.assertEqual(user32.layered_attrs, [(1, 230)], "новый слой обязан получить альфу")
        self.assertEqual(user32.frame_changes, 1)
        # Повтор — стиль уже на месте, писать нечего.
        self.assertTrue(self._run(user32, 1, True, 0.9))
        self.assertEqual(len(user32.writes), 1)

    def test_layer_of_tk_is_kept(self):
        import overlay

        user32 = _FakeUser32({1: overlay.WS_EX_LAYERED})
        self.assertTrue(self._run(user32, 1, True, 0.9))
        self.assertEqual(user32.layered_attrs, [], "альфу слоя Tk не перетираем")
        self.assertTrue(self._run(user32, 1, False, 0.9, keep_layered=True))
        self.assertEqual(user32.styles[1], overlay.WS_EX_LAYERED)

    def test_own_layer_is_removed_on_unlock(self):
        import overlay

        user32 = _FakeUser32({1: overlay.WS_EX_TRANSPARENT | overlay.WS_EX_LAYERED})
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

        import overlay

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
                with mock.patch.object(overlay, "_USER32", None), \
                        mock.patch.object(ctypes, "WinDLL", create=True, return_value=lib):
                    api = overlay._user32()
                    self.assertIsNotNone(api)
                    self.assertIs(api.GetWindowLong, lib.funcs[getter])
                    self.assertIsNotNone(lib.funcs[getter].restype)
                    self.assertIsNotNone(lib.funcs["GetAncestor"].argtypes)
                    self.assertIsNotNone(lib.funcs["SetWindowPos"].argtypes)


# ---------------------------------------------------------------------------
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
        first = sum(b.window.lifts for b in blocks.values())
        self.assertEqual(first, 2, "при первом показе окна поднимаем")
        for _ in range(5):
            self.manager._set_all_visibility(True)
        self.assertEqual(sum(b.window.lifts for b in blocks.values()), first,
                         "каждую секунду пересобирать окна не надо")
        # Прошло больше ZORDER_REFRESH_SECONDS — порядок освежаем.
        self.manager._zorder_at = time.monotonic() - overlay.ZORDER_REFRESH_SECONDS - 1
        self.manager._set_all_visibility(True)
        self.assertEqual(sum(b.window.lifts for b in blocks.values()), first + 2)

    def test_no_lift_while_dragging(self):
        blocks = self._attach_z("route")
        block = blocks["route"]
        block._dragging = True
        self.manager._zorder_at = 0.0
        self.manager._set_all_visibility(True)
        self.assertEqual(block.window.lifts, 0, "во время перетаскивания окна не трогаем")
        block._dragging = False
        self.manager._zorder_at = 0.0
        self.manager._set_all_visibility(True)
        self.assertEqual(block.window.lifts, 1)

    def test_lost_topmost_is_restored(self):
        blocks = self._attach_z("route")
        block = blocks["route"]
        self.manager._set_all_visibility(True)
        block._is_topmost = False  # например, игра перехватила окно
        lifted = block.window.lifts
        self.manager._set_all_visibility(True)
        self.assertEqual(block.window.lifts, lifted + 1)
        self.assertIn(True, block.topmost_calls)

    def test_hidden_block_is_not_lifted(self):
        blocks = self._attach_z("route")
        self.manager.settings["show_route"] = False
        self.manager._zorder_at = 0.0
        self.manager._set_all_visibility(True)
        self.assertEqual(blocks["route"].window.lifts, 0)
        self.assertFalse(blocks["route"].window.winfo_viewable())


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


class SizeProbeTests(unittest.TestCase):
    """size() не дёргает update_idletasks(), когда Tk и так знает размер."""

    @staticmethod
    def _block(width, height):
        from overlay import OverlayWindow

        block = OverlayWindow.__new__(OverlayWindow)
        block.overlay_key = "route"
        block.settings = {"route_width": 300, "route_height": 200}
        block.window = mock.MagicMock()
        block.window.winfo_width.return_value = width
        block.window.winfo_height.return_value = height
        return block

    def test_known_size_skips_idle_flush(self):
        block = self._block(320, 240)
        self.assertEqual(block.size(), (320, 240))
        block.window.update_idletasks.assert_not_called()

    def test_unknown_size_asks_tk_once(self):
        block = self._block(1, 1)
        # После прохода по отложенным задачам Tk отдаёт реальный размер.
        block.window.winfo_width.side_effect = [1, 320]
        block.window.winfo_height.side_effect = [1, 240]
        self.assertEqual(block.size(), (320, 240))
        self.assertEqual(block.window.update_idletasks.call_count, 1)

    def test_falls_back_to_saved_settings(self):
        block = self._block(1, 1)
        self.assertEqual(block.size(), (300, 200))


class CarrierOverlayRenderTests(unittest.TestCase):
    """Окно CARRIER строится и показывает тоннаж, товары и остаток."""

    def setUp(self):
        # В общей GUI-заглушке `tk.Label(...)` возвращает один и тот же
        # MagicMock на все вызовы — не различишь, что написано в конкретной
        # подписи. Здесь каждый Label свой, как в настоящем Tk.
        import overlay

        patcher = mock.patch.object(
            overlay.tk, "Label",
            side_effect=lambda *args, **kwargs: mock.MagicMock(name="Label"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _overlay(self, settings=None):
        from overlay import CarrierOverlay

        base = {"font_family": "Consolas", "font_size": 10}
        base.update(settings or {})
        return CarrierOverlay(_FakeMaster(), base)

    @staticmethod
    def _text(widget, key="text"):
        call = widget.config.call_args_list[-1]
        if call.kwargs.get(key) is not None:
            return call.kwargs[key]
        return call.args[0] if call.args else ""

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
            "commodities": [{"key": "steel", "name": "Steel", "amount": 30, "need": 0, "remaining": 0}],
        })
        self.assertEqual(self._text(overlay.name_label), "Fleet Carrier")
        self.assertIn("учтено по журналу", self._text(overlay.total_label))

    def _labels(self):
        """Перехватить все создаваемые tk.Label вместе с их текстом.

        `text_arg` — последний известный текст: из конструктора либо из
        последующего `config(text=...)`. Строки списка товаров создаются
        пустыми и заполняются через `config()`, поэтому читать только
        аргументы конструктора нельзя.
        """
        import overlay as _ov

        created = []

        def factory(*args, **kwargs):
            widget = mock.MagicMock(name="Label")
            widget.text_arg = str(kwargs.get("text", ""))

            def _config(*c_args, **c_kwargs):
                if "text" in c_kwargs:
                    widget.text_arg = str(c_kwargs["text"])
                return widget.config_real(*c_args, **c_kwargs)

            widget.config_real = mock.MagicMock()
            widget.config.side_effect = _config
            created.append(widget)
            return widget

        patcher = mock.patch.object(_ov.tk, "Label", side_effect=factory)
        patcher.start()
        self.addCleanup(patcher.stop)
        return created

    def test_on_board_column_and_project_label(self):
        """Главное число — «на борту»; видно, чей это список материалов."""
        created = self._labels()
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
        texts = [w.text_arg for w in created]
        self.assertIn("250 (120)", texts)
        # Строки переиспользуются, а не пересоздаются: пустых ячеек нет.
        self.assertIn("4000", texts)
        self.assertIn("Steel", texts)
        self.assertIn("Titanium", texts)
        self.assertIn("-3750", texts)
        self.assertIn("на борту", texts)      # заголовок колонки

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
