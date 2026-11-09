"""Растягивание окна за края: коды ``WM_NCHITTEST`` и поведение окна.

У окон программы нет системного заголовка, а содержимое (панели, таблицы,
боковая колонка) занимает всю площадь. Курсор у края попадает в дочерний
виджет, поэтому Qt не присылает окну событие мыши и «потянуть за край» было
нельзя. На Windows окно само отвечает на ``WM_NCHITTEST`` — здесь проверяется
таблица соответствия краёв и то, что на других системах обработчик молчит.
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

    import ui_qt
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


class HitTestCodeTests(unittest.TestCase):
    def test_each_edge_has_its_own_code(self):
        self.assertEqual(ui_qt.hit_test_code(Qt.Edge.LeftEdge), ui_qt.HT_LEFT)
        self.assertEqual(ui_qt.hit_test_code(Qt.Edge.RightEdge), ui_qt.HT_RIGHT)
        self.assertEqual(ui_qt.hit_test_code(Qt.Edge.TopEdge), ui_qt.HT_TOP)
        self.assertEqual(ui_qt.hit_test_code(Qt.Edge.BottomEdge), ui_qt.HT_BOTTOM)

    def test_corners_win_over_plain_edges(self):
        self.assertEqual(
            ui_qt.hit_test_code(Qt.Edge.LeftEdge | Qt.Edge.TopEdge), ui_qt.HT_TOPLEFT)
        self.assertEqual(
            ui_qt.hit_test_code(Qt.Edge.RightEdge | Qt.Edge.BottomEdge),
            ui_qt.HT_BOTTOMRIGHT)

    def test_middle_of_the_window_is_not_a_resize(self):
        self.assertEqual(ui_qt.hit_test_code(Qt.Edge(0)), 0)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class FramelessWindowResizeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.window = ui_qt.FramelessWindow("test")
        self.window.resize(900, 600)
        self.addCleanup(self.window.deleteLater)

    def test_edges_are_detected_inside_the_margin(self):
        from PySide6.QtCore import QPoint

        self.assertTrue(self.window._edges_at(QPoint(1, 1)) & Qt.Edge.LeftEdge)
        self.assertTrue(self.window._edges_at(QPoint(1, 1)) & Qt.Edge.TopEdge)
        self.assertTrue(self.window._edges_at(QPoint(898, 598)) & Qt.Edge.RightEdge)
        self.assertTrue(self.window._edges_at(QPoint(898, 598)) & Qt.Edge.BottomEdge)
        self.assertEqual(self.window._edges_at(QPoint(450, 300)), Qt.Edge(0))

    def test_edges_give_a_resize_cursor(self):
        from PySide6.QtCore import QPoint

        corners = self.window._cursor_for(
            self.window._edges_at(QPoint(1, 1)))
        self.assertEqual(corners, Qt.CursorShape.SizeFDiagCursor)
        self.assertEqual(self.window._cursor_for(Qt.Edge(0)),
                         Qt.CursorShape.ArrowCursor)

    def test_native_hit_test_is_used_on_windows_only(self):
        """На Linux и macOS обработчик не вмешивается: там своя рамка."""
        enabled = ui_qt.native_hit_test_enabled
        self.assertTrue(enabled("win32", resizable=True, maximized=False))
        self.assertFalse(enabled("win32", resizable=False, maximized=False))
        self.assertFalse(enabled("win32", resizable=True, maximized=True))
        self.assertFalse(enabled("linux", resizable=True, maximized=False))
        self.assertFalse(enabled("darwin", resizable=True, maximized=False))

    def test_non_resizable_window_has_no_resize_edges(self):
        fixed = ui_qt.FramelessWindow("fixed", resizable=False)
        self.addCleanup(fixed.deleteLater)
        from PySide6.QtCore import QPoint

        self.assertEqual(fixed._edges_at(QPoint(1, 1)), Qt.Edge(0))


if __name__ == "__main__":
    unittest.main()
