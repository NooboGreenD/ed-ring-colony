"""Тесты раскладки оверлеев и монитора игры.

Покрывает то, что раньше вообще отсутствовало:

* привязка блоков к краям/углам (`compute_anchored_position`) — включая
  второй монитор и окна, которые не влезают в область;
* профили раскладки (сохранение/применение/удаление);
* определение запущенной игры (`GameMonitor`).

Всё считается без настоящего Tk: менеджер создаётся с мастер-заглушкой,
а проверки идут над настройками и чистыми функциями.
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


class _FakeMaster:
    """Минимальная замена tk.Tk: размер экрана и отложенные вызовы."""

    def __init__(self, width: int = 1920, height: int = 1080):
        self._w = width
        self._h = height
        self.after_calls = 0

    def winfo_screenwidth(self):
        return self._w

    def winfo_screenheight(self):
        return self._h

    def after(self, _delay, callback=None):
        self.after_calls += 1
        if callable(callback):
            callback()
        return "after-id"


class _FakeWindow:
    """Окно Tk-заглушка: отдаёт сохранённую геометрию."""

    def __init__(self, x=0, y=0, width=100, height=100):
        self.x, self.y = x, y
        self.width, self.height = width, height

    def winfo_x(self):
        return self.x

    def winfo_y(self):
        return self.y

    def winfo_width(self):
        return self.width

    def winfo_height(self):
        return self.height


class _FakeOverlay:
    """Оверлей-заглушка в том виде, в каком его видит менеджер."""

    def __init__(self, x=0, y=0, width=100, height=100, anchor="custom"):
        self.window = _FakeWindow(x, y, width, height)
        self._anchor = anchor

    def winfo_x(self):
        return self.x

    def winfo_y(self):
        return self.y

    def winfo_width(self):
        return self.width

    def winfo_height(self):
        return self.height


class AnchorMathTests(unittest.TestCase):
    def test_all_anchors_place_window_inside_area(self):
        from overlay import ANCHOR_KEYS, compute_anchored_position

        area = (0, 0, 1000, 800)
        for anchor in ANCHOR_KEYS:
            if anchor == "custom":
                continue
            pos = compute_anchored_position(anchor, *area, 200, 100, margin=20)
            self.assertIsNotNone(pos, anchor)
            x, y = pos
            self.assertGreaterEqual(x, area[0], anchor)
            self.assertGreaterEqual(y, area[1], anchor)
            self.assertLessEqual(x + 200, area[0] + area[2], anchor)
            self.assertLessEqual(y + 100, area[1] + area[3], anchor)

    def test_corner_and_center_positions(self):
        from overlay import compute_anchored_position

        # 1920x1080, окно 200x100, отступ 20
        self.assertEqual(compute_anchored_position("top_left", 0, 0, 1920, 1080, 200, 100, 20), (20, 20))
        self.assertEqual(compute_anchored_position("top_right", 0, 0, 1920, 1080, 200, 100, 20), (1700, 20))
        self.assertEqual(compute_anchored_position("bottom_right", 0, 0, 1920, 1080, 200, 100, 20), (1700, 960))
        self.assertEqual(compute_anchored_position("mid_center", 0, 0, 1920, 1080, 200, 100, 20), (860, 490))

    def test_second_monitor_offset_is_respected(self):
        """Окно игры на втором мониторе (сдвиг по X) — блоки не уезжают на первый."""
        from overlay import compute_anchored_position

        # Второй монитор: x от 1920, ширина 1280
        pos = compute_anchored_position("top_left", 1920, 0, 1280, 1024, 200, 100, 20)
        self.assertEqual(pos, (1940, 20))

    def test_oversized_window_is_clamped_into_area(self):
        from overlay import compute_anchored_position

        # Окно выше области: якорь «низ» не должен вытолкнуть его за верхний край
        pos = compute_anchored_position("bottom_left", 0, 0, 800, 600, 200, 900, 10)
        x, y = pos
        self.assertEqual(x, 10)
        self.assertEqual(y, 0)  # зажато по верхней границе области

    def test_custom_anchor_returns_none(self):
        from overlay import compute_anchored_position

        self.assertIsNone(compute_anchored_position("custom", 0, 0, 1920, 1080, 200, 100))
        self.assertIsNone(compute_anchored_position("", 0, 0, 1920, 1080, 200, 100))
        self.assertIsNone(compute_anchored_position("нет такого", 0, 0, 1920, 1080, 200, 100))


class LayoutProfileTests(unittest.TestCase):
    def setUp(self):
        from overlay import OverlayManager

        self.tmp = tempfile.TemporaryDirectory()
        self.config_path = Path(self.tmp.name) / "config.json"
        self.manager = OverlayManager(_FakeMaster(), self.config_path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_profile_roundtrip(self):
        self.manager.settings["route_x"] = 111
        self.manager.settings["route_y"] = 222
        self.manager.settings["show_cargo"] = False

        self.assertTrue(self.manager.capture_layout("Хаул"))
        self.assertEqual(self.manager.active_profile, "Хаул")
        self.assertIn("Хаул", self.manager.list_profiles())

        # Меняем раскладку, затем возвращаем сохранённую
        self.manager.settings["route_x"] = 999
        self.manager.settings["route_y"] = 999
        self.manager.settings["show_cargo"] = True

        self.assertTrue(self.manager.apply_layout("Хаул"))
        self.assertEqual(self.manager.settings["route_x"], 111)
        self.assertEqual(self.manager.settings["route_y"], 222)
        self.assertFalse(self.manager.settings["show_cargo"])
        self.assertEqual(self.manager.settings["active_profile"], "Хаул")

    def test_profile_is_persisted(self):
        self.manager.capture_layout("Бой")
        from overlay import load_overlay_settings

        reloaded = load_overlay_settings(self.config_path)
        self.assertIn("Бой", (reloaded.get("profiles") or {}))
        self.assertEqual(reloaded.get("active_profile"), "Бой")

    def test_apply_unknown_profile_is_noop(self):
        self.assertFalse(self.manager.apply_layout("нет такого"))

    def test_delete_profile(self):
        self.manager.capture_layout("Эксобиология")
        self.assertTrue(self.manager.delete_profile("Эксобиология"))
        self.assertNotIn("Эксобиология", self.manager.list_profiles())
        self.assertEqual(self.manager.active_profile, "")
        self.assertFalse(self.manager.delete_profile("Эксобиология"))

    def test_capture_uses_live_window_geometry(self):
        """Снимок берёт фактическую геометрию окна, а не устаревшие настройки."""
        from overlay import OverlayManager

        self.manager.settings["ship_x"] = 10
        self.manager.settings["ship_y"] = 10
        fake_overlay = _FakeOverlay(640, 480, 300, 400)
        with mock.patch.object(OverlayManager, "_blocks", return_value=[("ship", fake_overlay)]):
            self.manager.capture_layout("Живая раскладка")
        snapshot = self.manager.settings["profiles"]["Живая раскладка"]["ship"]
        self.assertEqual(snapshot["x"], 640)
        self.assertEqual(snapshot["y"], 480)
        self.assertEqual(snapshot["width"], 300)
        self.assertEqual(snapshot["height"], 400)

    def test_reset_positions_clears_anchors(self):
        self.manager.settings["route_anchor"] = "top_right"
        self.manager.settings["route_x"] = 12345
        self.manager.reset_positions()
        self.assertEqual(self.manager.settings["route_anchor"], "custom")
        self.assertEqual(self.manager.settings["route_x"], self.manager.DEFAULT_POSITIONS["route"][0])


class OverlayAreaTests(unittest.TestCase):
    def setUp(self):
        from overlay import OverlayManager

        self.tmp = tempfile.TemporaryDirectory()
        self.manager = OverlayManager(_FakeMaster(1920, 1080), Path(self.tmp.name) / "config.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_area_is_screen_without_game(self):
        self.manager.settings["attach_to_game"] = True
        self.assertEqual(self.manager.overlay_area(), (0, 0, 1920, 1080))

    def test_area_follows_game_monitor(self):
        """Область берётся с монитора, где запущена игра, а не с основного экрана."""
        from game_monitor import GameState

        state = GameState(running=True, focused=True, rect=(1920, 0, 3200, 1024),
                          monitor=(1920, 0, 3200, 1024))
        with mock.patch.object(type(self.manager.game_monitor), "state", new_callable=mock.PropertyMock) as prop:
            prop.return_value = state
            self.manager.settings["attach_to_game"] = True
            self.assertEqual(self.manager.overlay_area(), (1920, 0, 1280, 1024))

    def test_area_is_screen_when_attach_disabled(self):
        from game_monitor import GameState

        state = GameState(running=True, monitor=(1920, 0, 3200, 1024))
        with mock.patch.object(type(self.manager.game_monitor), "state", new_callable=mock.PropertyMock) as prop:
            prop.return_value = state
            self.manager.settings["attach_to_game"] = False
            self.assertEqual(self.manager.overlay_area(), (0, 0, 1920, 1080))


class OverlayAutoHideTests(unittest.TestCase):
    """HUD не должен висеть над рабочим столом, когда игры нет."""

    def setUp(self):
        from overlay import OverlayManager

        self.tmp = tempfile.TemporaryDirectory()
        self.manager = OverlayManager(_FakeMaster(), Path(self.tmp.name) / "config.json")
        self.manager._stop = threading.Event()

    def tearDown(self):
        self.manager._stop.set()
        self.tmp.cleanup()

    def _run_loop(self, state, seconds=1.3):
        from overlay import OverlayManager

        with mock.patch.object(type(self.manager.game_monitor), "state",
                               new_callable=mock.PropertyMock) as prop:
            prop.return_value = state
            with mock.patch.object(OverlayManager, "_set_all_visibility") as visibility:
                thread = threading.Thread(target=self.manager._update_loop, daemon=True)
                thread.start()
                time.sleep(seconds)
                self.manager._stop.set()
                thread.join(10)
                return [call.args for call in visibility.call_args_list]

    def test_overlay_is_hidden_without_game(self):
        from game_monitor import GameState

        calls = self._run_loop(GameState(running=False))
        self.assertTrue(calls, "видимость должна пересчитываться")
        self.assertTrue(all(args == (False,) for args in calls), calls)

    def test_overlay_is_shown_when_game_is_focused(self):
        from game_monitor import GameState

        calls = self._run_loop(GameState(running=True, focused=True))
        self.assertTrue(calls, "видимость должна пересчитываться")
        self.assertTrue(all(args == (True,) for args in calls), calls)


class GameMonitorTests(unittest.TestCase):
    def test_running_game_is_detected_by_process(self):
        from game_monitor import GameMonitor

        monitor = GameMonitor(process_lister=lambda: [(4242, "EliteDangerous64.exe"), (7, "explorer.exe")])
        state = monitor.refresh()
        self.assertTrue(state.running)
        self.assertEqual(state.pid, 4242)
        self.assertEqual(state.process_name, "EliteDangerous64.exe")

    def test_missing_game_is_reported(self):
        from game_monitor import GameMonitor

        monitor = GameMonitor(process_lister=lambda: [(7, "explorer.exe")])
        state = monitor.refresh()
        self.assertFalse(state.running)
        self.assertFalse(state.focused)
        self.assertEqual(state.pid, 0)

    def test_process_lister_failure_does_not_crash(self):
        from game_monitor import GameMonitor

        def boom():
            raise RuntimeError("snapshot failed")

        monitor = GameMonitor(process_lister=boom)
        state = monitor.refresh()
        self.assertFalse(state.running)
        self.assertIn("process list unavailable", state.error)

    def test_state_is_cached_between_probes(self):
        from game_monitor import GameMonitor

        calls = {"n": 0}

        def lister():
            calls["n"] += 1
            return [(1, "EliteDangerous64.exe")]

        monitor = GameMonitor(cache_ttl=30.0, process_lister=lister)
        monitor.state
        monitor.state
        monitor.state
        self.assertEqual(calls["n"], 1)

    @unittest.skipIf(sys.platform == "win32", "только для не-Windows")
    def test_unsupported_platform_is_reported(self):
        from game_monitor import GameMonitor

        state = GameMonitor().refresh()
        self.assertFalse(state.running)
        self.assertEqual(state.error, "unsupported platform")
        self.assertIn("недоступно", state.label())

    def test_state_label(self):
        from game_monitor import GameState

        self.assertEqual(GameState(running=False).label(), "не запущена")
        self.assertEqual(GameState(running=True).label(), "запущена")
        self.assertEqual(GameState(running=True, focused=True).label(), "в фокусе")


if __name__ == "__main__":
    unittest.main()
