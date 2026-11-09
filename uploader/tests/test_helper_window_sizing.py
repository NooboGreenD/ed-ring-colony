"""Окно Helper под разные разрешения экрана и его растягивание за края.

Раньше минимум окна был зашит числом ``980×630``: на 1366×768 окно ещё
помещалось, но на 1024×600 — уже нет, и пилот не мог ни ужать окно, ни
дотянуться до нижней строки. Здесь закреплено, что минимум считается от
свободного места экрана, а растягивание идёт за края окна.
"""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QApplication

    import helper_window
    from ui_qt import FramelessWindow, ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


class WindowLimitsTests(unittest.TestCase):
    """Чистый расчёт: какие границы получает окно на таком экране."""

    def test_big_screen_keeps_the_usual_minimum(self):
        self.assertEqual(helper_window.window_limits(1920, 1080), (980, 630))
        self.assertEqual(helper_window.window_limits(2560, 1440), (980, 630))

    def test_small_laptop_screen_shrinks_the_minimum(self):
        # 1366×660 — свободное место над панелью задач на типичном ноутбуке.
        width, height = helper_window.window_limits(1366, 660)
        self.assertLessEqual(width, 1366)
        self.assertLessEqual(height, 660, "иначе окно не влезет по высоте")
        self.assertLess(height, helper_window.MIN_HEIGHT)

    def test_tiny_screen_never_goes_below_the_floor(self):
        self.assertEqual(helper_window.window_limits(700, 460),
                         (helper_window.FLOOR_WIDTH, helper_window.FLOOR_HEIGHT))

    def test_limits_always_fit_the_screen(self):
        for width, height in ((1920, 1080), (1600, 900), (1366, 728), (1280, 720),
                              (1024, 568), (800, 480)):
            limit_w, limit_h = helper_window.window_limits(width, height)
            self.assertLessEqual(limit_w, max(width, helper_window.FLOOR_WIDTH))
            self.assertLessEqual(limit_h, max(height, helper_window.FLOOR_HEIGHT))


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class HelperWindowChromeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.window = helper_window.HelperWindow("test")
        self.addCleanup(self.window.destroy)

    def test_window_is_frameless_and_resizable_by_edges(self):
        self.assertIsInstance(self.window, FramelessWindow)
        self.assertTrue(self.window.windowFlags() & Qt.WindowType.FramelessWindowHint)
        self.assertTrue(self.window._resizable)
        # За краем окна курсор меняется на «тянуть»: это и есть растягивание.
        from PySide6.QtCore import QPoint

        edge = self.window._edges_at(QPoint(1, 1))
        self.assertTrue(edge & Qt.Edge.LeftEdge)
        self.assertTrue(edge & Qt.Edge.TopEdge)
        self.assertNotEqual(self.window._cursor_for(edge), Qt.CursorShape.ArrowCursor)

    def test_minimum_fits_the_screen_it_is_on(self):
        screen = self.window.screen() or QApplication.primaryScreen()
        available = screen.availableGeometry()
        self.assertLessEqual(self.window.minimumWidth(), max(available.width(),
                                                             helper_window.FLOOR_WIDTH))
        self.assertLessEqual(self.window.minimumHeight(), max(available.height(),
                                                              helper_window.FLOOR_HEIGHT))

    def test_window_is_not_larger_than_the_screen(self):
        self.window.resize(4000, 3000)
        self.window.fit_to_screen()
        screen = self.window.screen() or QApplication.primaryScreen()
        available = screen.availableGeometry()
        self.assertLessEqual(self.window.width(), max(available.width(),
                                                      self.window.minimumWidth()))
        self.assertLessEqual(self.window.height(), max(available.height(),
                                                       self.window.minimumHeight()))

    def test_window_off_screen_is_brought_back(self):
        self.window.move(-5000, -5000)
        self.window.fit_to_screen()
        screen = self.window.screen() or QApplication.primaryScreen()
        available = screen.availableGeometry()
        self.assertTrue(available.contains(self.window.frameGeometry()))

    def test_start_geometry_fits_the_screen(self):
        import colonial_helper

        width, _, height = colonial_helper.ColonialHelperApp._start_geometry().partition("x")
        screen = QApplication.primaryScreen()
        available = screen.availableGeometry()
        self.assertLessEqual(int(width), max(available.width(), 720))
        self.assertLessEqual(int(height), max(available.height(), 480))


if __name__ == "__main__":
    unittest.main()
