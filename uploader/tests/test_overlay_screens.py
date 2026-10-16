"""Отвязка блоков HUD от игры и перенос на другой экран (2.15.0).

Пилот попросил: «нужна возможность открепить оверлей от игры и вывести его на
другой экран». Здесь проверяется:

* геометрия экранов (`screens.py`) — чистые функции, без Tk и Win32;
* менеджер: отвязанный блок раскладывается по якорю внутри СВОЕГО экрана,
  переезжает на выбранный монитор, возвращается к игре и не теряется за
  краем, если монитор отключили;
* создание окон оверлея подключает к каждому блоку обработчики (раньше цикл
  перепутал ключ и окно и падал на первом же блоке).
"""

import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_overlay_layout import _FakeMaster  # noqa: E402
from test_overlay_management import _ManagerTestCase, _ensure_gui_stubs  # noqa: E402

_ensure_gui_stubs()

from screens import (  # noqa: E402
    MonitorInfo,
    fit_into_area,
    header_visible,
    list_monitors,
    monitor_for_area,
    order_monitors,
    translate_between_areas,
)

#: Основной 1920×1080 (панель задач снизу) и второй 2560×1440 справа.
PRIMARY = MonitorInfo(1, (0, 0, 1920, 1040), (0, 0, 1920, 1080), primary=True)
SECOND = MonitorInfo(2, (1920, 0, 4480, 1440), (1920, 0, 4480, 1440))
TWO_SCREENS = [PRIMARY, SECOND]


class ScreenGeometryTests(unittest.TestCase):
    def test_primary_first_then_left_to_right(self):
        monitors = order_monitors([
            ((1920, 0, 4480, 1440), (1920, 0, 4480, 1440), False, r"\\.\DISPLAY2"),
            ((-1280, 0, 0, 1024), (-1280, 0, 0, 1024), False, r"\\.\DISPLAY3"),
            ((0, 0, 1920, 1040), (0, 0, 1920, 1080), True, r"\\.\DISPLAY1"),
        ])
        self.assertEqual([m.index for m in monitors], [1, 2, 3])
        self.assertTrue(monitors[0].primary)
        self.assertEqual(monitors[1].bounds[0], -1280, "второй — левый")
        self.assertEqual(monitors[2].bounds[0], 1920)

    def test_broken_entries_are_dropped(self):
        monitors = order_monitors([
            ((0, 0, 0, 0), (0, 0, 0, 0), True, ""),
            (None, (0, 0, 10, 10), False, ""),
            ((0, 0, 1920, 1040), (0, 0, 1920, 1080), True, ""),
        ])
        self.assertEqual(len(monitors), 1)

    def test_label_and_work_area(self):
        self.assertEqual(SECOND.label(), "Экран 2 · 2560×1440")
        self.assertIn("основной", PRIMARY.label())
        self.assertEqual(PRIMARY.work_area, (0, 0, 1920, 1040))

    def test_monitor_for_area_takes_largest_overlap(self):
        # Окно 300 px шириной, 200 px из них — на втором экране.
        self.assertIs(monitor_for_area((1820, 100, 300, 200), TWO_SCREENS), SECOND)
        self.assertIs(monitor_for_area((100, 100, 300, 200), TWO_SCREENS), PRIMARY)

    def test_lost_window_gets_nearest_monitor(self):
        self.assertIs(monitor_for_area((6000, 100, 300, 200), TWO_SCREENS), SECOND)
        self.assertIs(monitor_for_area((-900, 100, 300, 200), TWO_SCREENS), PRIMARY)
        self.assertIsNone(monitor_for_area((0, 0, 10, 10), []))

    def test_header_visibility(self):
        self.assertTrue(header_visible((100, 100, 300, 200), TWO_SCREENS))
        self.assertFalse(header_visible((5000, 100, 300, 200), TWO_SCREENS))
        # Шапка ушла выше экрана — схватить нечего.
        self.assertFalse(header_visible((100, -150, 300, 200), TWO_SCREENS))
        # Видно 100 px шапки на краю — достаточно.
        self.assertTrue(header_visible((1820, 100, 300, 200), [PRIMARY]))

    def test_fit_into_area(self):
        self.assertEqual(fit_into_area(5000, 5000, 300, 200, (0, 0, 1920, 1040)), (1620, 840))
        self.assertEqual(fit_into_area(-50, -50, 300, 200, (0, 0, 1920, 1040)), (0, 0))
        # Окно больше области — прижимаем к левому верхнему углу.
        self.assertEqual(fit_into_area(10, 10, 3000, 2000, (0, 0, 1920, 1040)), (0, 0))

    def test_translate_keeps_relative_place(self):
        src, dst = PRIMARY.work_area, SECOND.work_area
        # Правый верхний угол первого экрана -> правый верхний угол второго.
        self.assertEqual(translate_between_areas(1620, 0, 300, 200, src, dst), (4180, 0))
        # Центр -> центр.
        x, y = translate_between_areas(810, 420, 300, 200, src, dst)
        self.assertEqual((x, y), (1920 + (2560 - 300) // 2, (1440 - 200) // 2))
        # Без исходного экрана — в левый верхний угол цели с отступом.
        self.assertEqual(translate_between_areas(9999, 9999, 300, 200, None, dst), (1944, 24))

    def test_list_monitors_is_empty_outside_windows(self):
        if sys.platform == "win32":
            self.skipTest("на Windows список реальный")
        self.assertEqual(list_monitors(), [])

    def test_list_monitors_reads_win32_structures(self):
        """EnumDisplayMonitors + GetMonitorInfoW разбираются в MonitorInfo."""
        import ctypes

        import screens

        displays = {
            1: ((1920, 0, 4480, 1440), (1920, 0, 4480, 1440), 0),
            2: ((0, 0, 1920, 1080), (0, 0, 1920, 1040), 1),   # основной
        }

        class _Func:
            def __init__(self, impl):
                self.impl = impl
                self.argtypes = None
                self.restype = None

            def __call__(self, *args):
                return self.impl(*args)

        def enum_monitors(_hdc, _clip, callback, _lparam):
            for handle in displays:
                callback(handle, None, None, 0)
            return 1

        def monitor_info(handle, info_ref):
            info = info_ref._obj
            bounds, work, flags = displays[handle]
            for rect, values in ((info.rcMonitor, bounds), (info.rcWork, work)):
                rect.left, rect.top, rect.right, rect.bottom = values
            info.dwFlags = flags
            info.szDevice = f"\\\\.\\DISPLAY{handle}"
            return 1

        class _Lib:
            EnumDisplayMonitors = _Func(enum_monitors)
            GetMonitorInfoW = _Func(monitor_info)

        with mock.patch.object(screens, "IS_WINDOWS", True), \
                mock.patch.object(ctypes, "WinDLL", create=True, return_value=_Lib()), \
                mock.patch.object(ctypes, "WINFUNCTYPE", create=True, new=ctypes.CFUNCTYPE):
            monitors = screens.list_monitors()
        self.assertEqual([m.index for m in monitors], [1, 2])
        self.assertTrue(monitors[0].primary)
        self.assertEqual(monitors[0].work, (0, 0, 1920, 1040))
        self.assertEqual(monitors[1].bounds, (1920, 0, 4480, 1440))
        self.assertIn("DISPLAY1", monitors[1].name)


class DetachedBlockManagerTests(_ManagerTestCase):
    def setUp(self):
        super().setUp()
        import overlay

        patcher = mock.patch.object(overlay, "list_monitors", return_value=list(TWO_SCREENS))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.manager._monitors_cache = []

    def test_monitors_fall_back_to_main_screen(self):
        import overlay

        self.manager._monitors_cache = []
        with mock.patch.object(overlay, "list_monitors", return_value=[]):
            monitors = self.manager.monitors()
        self.assertEqual(len(monitors), 1)
        self.assertEqual(monitors[0].work_area, (0, 0, 1920, 1080))

    def test_detached_block_anchors_inside_its_own_screen(self):
        self.attach("carrier")
        self.manager.settings.update({"carrier_x": 3000, "carrier_y": 200})
        self.assertEqual(self.manager.block_area("carrier"), self.manager.overlay_area(),
                         "привязанный блок — в области игры (без игры — основной экран)")
        self.manager.settings["carrier_detached"] = True
        self.assertEqual(self.manager.block_area("carrier"), SECOND.work_area)
        self.assertIs(self.manager.block_monitor("carrier"), SECOND)

    def test_move_to_monitor_detaches_and_moves(self):
        blocks = self.attach("carrier")
        self.manager.settings.update({"carrier_x": 1590, "carrier_y": 0})
        blocks["carrier"].window.width, blocks["carrier"].window.height = 330, 300
        self.assertTrue(self.manager.move_block_to_monitor("carrier", 2))
        self.assertTrue(self.manager.settings["carrier_detached"])
        self.assertIn(("set_detached", {"detached": True}), blocks["carrier"].calls)
        moves = [kw for name, kw in blocks["carrier"].calls if name == "set_position"]
        self.assertTrue(moves, "блок должен переехать")
        self.assertEqual(moves[-1], {"x": 4480 - 330, "y": 0}, "у правого края — и там у правого")
        self.assertFalse(self.manager.move_block_to_monitor("carrier", 9))

    def test_move_without_running_overlay_moves_saved_position(self):
        """Оверлей выключен — переносим сохранённую позицию: блок появится уже там."""
        self.manager.settings.update({"exobio_x": 100, "exobio_y": 50})
        self.assertTrue(self.manager.move_block_to_monitor("exobio", 2))
        self.assertTrue(self.manager.settings["exobio_detached"])
        self.assertGreaterEqual(self.manager.settings["exobio_x"], 1920)
        self.assertIs(self.manager.block_monitor("exobio"), SECOND)

    def test_anchored_block_is_reanchored_on_new_screen(self):
        blocks = self.attach("route")
        self.manager.settings["route_anchor"] = "top_right"
        self.manager.move_block_to_monitor("route", 2)
        anchors = [kw["area"] for name, kw in blocks["route"].calls if name == "apply_anchor"]
        self.assertEqual(anchors[-1], SECOND.work_area)

    def test_return_to_game_moves_block_back(self):
        import overlay
        from game_monitor import GameState

        blocks = self.attach("carrier")
        self.manager.settings.update({"carrier_x": 3000, "carrier_y": 100,
                                      "carrier_detached": True})
        state = GameState(running=True, focused=True, monitor=(0, 0, 1920, 1040))
        with mock.patch.object(type(self.manager.game_monitor), "state",
                               new_callable=mock.PropertyMock, return_value=state):
            self.manager.set_block_detached("carrier", False, move_to_game=True)
        self.assertFalse(self.manager.settings["carrier_detached"])
        x = self.manager.settings["carrier_x"]
        self.assertTrue(0 <= x <= 1920 - 300, x)
        self.assertIn(("set_detached", {"detached": False}), blocks["carrier"].calls)
        self.assertTrue(overlay.load_overlay_settings(self.config_path)["carrier_x"] == x)

    def test_lost_block_returns_to_screen(self):
        blocks = self.attach("cargo")
        self.manager.settings.update({"cargo_x": 7000, "cargo_y": 300})
        self.assertTrue(self.manager.ensure_block_on_screen("cargo"))
        x = self.manager.settings["cargo_x"]
        self.assertTrue(1920 <= x <= 4480 - 300, f"на ближайший экран, а не в никуда: {x}")
        # Видимый блок не трогаем.
        blocks["cargo"].calls.clear()
        self.assertFalse(self.manager.ensure_block_on_screen("cargo"))
        self.assertEqual(blocks["cargo"].calls, [])


class CreateWindowsTests(unittest.TestCase):
    """_create_windows подключает к каждому блоку менеджер.

    Раньше цикл был `for ov, key in self._blocks()` при том, что _blocks()
    отдаёт (ключ, окно): на первом же блоке — AttributeError. Создание
    оверлея обрывалось: перетаскивание не сохраняло позицию, горячие клавиши
    не регистрировались, свои прозрачность и шрифт блоков не применялись.
    """

    def test_every_block_is_wired(self):
        from hotkeys import HotkeyManager
        from overlay import OverlayManager

        with tempfile.TemporaryDirectory() as tmp:
            manager = OverlayManager(_FakeMaster(), Path(tmp) / "config.json")
            manager._stop = threading.Event()
            manager.enabled = True
            with mock.patch.object(HotkeyManager, "start", autospec=True,
                                   side_effect=lambda self: True), \
                    mock.patch.object(HotkeyManager, "register", autospec=True,
                                      return_value=True) as register:
                manager._create_windows()
            blocks = dict(manager._blocks())
            self.assertEqual(set(blocks), set(OverlayManager.BLOCKS))
            for key, overlay in blocks.items():
                with self.subTest(block=key):
                    self.assertIs(overlay._controller, manager)
                    self.assertTrue(callable(overlay._on_move_callback))
                    self.assertTrue(callable(overlay._on_release_callback))
                    self.assertEqual(overlay._area_provider(), manager.block_area(key))
            combos = [call.args[1] for call in register.call_args_list]
            self.assertIn("F12", combos)
            self.assertIn("Ctrl+F12", combos)
            # Перетаскивание теперь доезжает до настроек.
            blocks["route"]._on_move_callback(321, 123)
            self.assertEqual((manager.settings["route_x"], manager.settings["route_y"]), (321, 123))
            manager.hotkeys.stop()


if __name__ == "__main__":
    unittest.main(verbosity=2)
