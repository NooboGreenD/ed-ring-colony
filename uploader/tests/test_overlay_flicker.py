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

    def __init__(self):
        from overlay import OverlayWindow

        self.block = OverlayWindow.__new__(OverlayWindow)
        self.block.overlay_key = "route"
        self.block.settings = {}
        self.block._click_through = False
        self.block._alpha = 0.9
        self.block._applied_through = None
        self.block._hwnd = 4242
        self.block._is_topmost = True
        self.block.through_btn = mock.MagicMock()
        self.block.window = mock.MagicMock()


# ---------------------------------------------------------------------------
class ClickThroughSyncTests(unittest.TestCase):
    """Win32-режим «клик насквозь» применяется один раз на изменение."""

    def test_sync_is_skipped_when_state_unchanged(self):
        import overlay

        fixture = _ClickThroughBlock()
        with mock.patch.object(overlay, "_set_click_through", return_value=True) as win32:
            fixture.block._click_through = True
            fixture.block._sync_click_through()
            fixture.block._sync_click_through()
            fixture.block._sync_click_through()
            self.assertEqual(win32.call_count, 1, "повторные вызовы не должны дёргать Win32")
            # Альфа окна передаётся в Win32: слоистое окно без атрибутов
            # Windows считает полностью прозрачным.
            self.assertEqual(win32.call_args[0][1:], (True, 0.9))
            # force=True — применяем заново (например, окно пересоздали).
            fixture.block._sync_click_through(force=True)
            self.assertEqual(win32.call_count, 2)

    def test_set_click_through_reacts_only_to_change(self):
        fixture = _ClickThroughBlock()
        fixture.block._flash_indicator = mock.MagicMock()
        with mock.patch.object(fixture.block.window, "after_idle") as after_idle:
            fixture.block.set_click_through(True, "route_click_through")
            fixture.block.set_click_through(True, "route_click_through")
            self.assertEqual(after_idle.call_count, 1)
            self.assertEqual(fixture.block.settings["route_click_through"], True)
            fixture.block.set_click_through(False, "route_click_through")
            self.assertEqual(after_idle.call_count, 2)

    def test_alpha_change_reapplies_layered_window(self):
        fixture = _ClickThroughBlock()
        fixture.block._click_through = True
        fixture.block._applied_through = True
        fixture.block.set_alpha(0.4, save=False)
        # Состояние сброшено — следующий sync применит новую альфу.
        self.assertIsNone(fixture.block._applied_through)
        self.assertEqual(fixture.block._alpha, 0.4)

    def test_win32_helper_survives_absent_windows(self):
        """На Linux/в CI без Windows функция не падает и возвращает False."""
        import ctypes

        import overlay

        if hasattr(ctypes, "windll"):
            self.skipTest("тест для окружения без Win32 API")
        self.assertFalse(overlay._set_click_through(4242, True))
        self.assertFalse(overlay._set_click_through(0, False))


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

    def test_empty_state_does_not_crash(self):
        overlay = self._overlay()
        overlay.update_carrier({})
        overlay.update_carrier(None)
        self.assertEqual(self._text(overlay.name_label), "Fleet Carrier")


if __name__ == "__main__":
    unittest.main(verbosity=2)
