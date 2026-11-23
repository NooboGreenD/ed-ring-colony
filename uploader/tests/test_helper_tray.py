"""Tray/window lifetime unit tests; native Windows Alt+Tab requires a desktop.

The controller methods here are the production bodies with a fake window base;
real Qt timer/lifetime tests additionally live in test_window_lifecycle.
"""
import ast
import sys
import subprocess
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))


class FakeWindow:
    def showMinimized(self): self.minimized = True
    def hide(self): self.visible = False
    def isMaximized(self): return self.maximized
    def showMaximized(self): self.visible = True; self.maximized = True
    def showNormal(self): self.visible = True; self.maximized = False; self.minimized = False
    def raise_(self): self.raised = True
    def activateWindow(self): self.activated = True


def window_class():
    tree = ast.parse((HERE.parent/'helper_window.py').read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'HelperWindow')
    selected = {'minimize_to_tray', 'restore_from_tray', 'showMinimized', '_tray_activated', '_start_timer'}
    body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in selected]
    base = ast.Name(id='FakeWindow', ctx=ast.Load())
    cls = ast.ClassDef(name='Window', bases=[base], keywords=[], body=body, decorator_list=[])
    tray = SimpleNamespace(isSystemTrayAvailable=mock.Mock(return_value=True),
                           ActivationReason=SimpleNamespace(Trigger=1, DoubleClick=2, Context=3))
    env = {'FakeWindow': FakeWindow, 'QSystemTrayIcon': tray, 'Callable': object,
           'call_safely': lambda callback: callback(), 'QTimer': mock.Mock()}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[])), '<tray-window>', 'exec'), env)
    return env['Window'], env


class TrayControllerTests(unittest.TestCase):
    def setUp(self):
        cls, self.env = window_class()
        self.window = cls()
        self.window._tray = mock.Mock()
        self.window._in_tray = False
        self.window._tray_was_maximized = False
        self.window.visible = True
        self.window.maximized = self.window.minimized = False

    def test_minimize_really_hides_not_a_minimized_taskbar_window(self):
        self.window.showMinimized()
        self.assertTrue(self.window._in_tray)
        self.assertFalse(self.window.visible)
        self.assertFalse(self.window.minimized)

    def test_restore_is_only_explicit_via_tray_trigger_or_menu(self):
        self.window.showMinimized()
        self.window._tray_activated(3)  # context menu itself must not restore
        self.assertFalse(self.window.visible)
        self.window._tray_activated(1)
        self.assertTrue(self.window.visible)
        self.assertFalse(self.window._in_tray)
        self.assertTrue(self.window.activated)

    def test_maximized_geometry_survives_repeated_minimize_requests(self):
        self.window.maximized = True
        self.window.showMinimized()
        self.window.showMinimized()
        self.window.restore_from_tray()
        self.assertTrue(self.window.visible)
        self.assertTrue(self.window.maximized)

    def test_no_system_tray_falls_back_to_normal_minimization(self):
        self.env['QSystemTrayIcon'].isSystemTrayAvailable.return_value = False
        self.window.showMinimized()
        self.assertTrue(self.window.minimized)
        self.assertFalse(self.window._in_tray)
        self.assertTrue(self.window.visible)

    def test_fired_timer_is_removed_and_scheduled_for_qobject_deletion(self):
        self.window._timers = {}
        self.window._closing = False
        timer = self.env['QTimer'].return_value
        callback = mock.Mock()
        self.window._start_timer(1, 0, callback)
        fire = timer.timeout.connect.call_args.args[0]
        fire()
        self.assertNotIn(1, self.window._timers)
        timer.deleteLater.assert_called_once()
        callback.assert_called_once()

    def test_closing_does_not_run_pending_callbacks_but_still_deletes_timer(self):
        self.window._timers = {}
        self.window._closing = True
        timer = self.env['QTimer'].return_value
        callback = mock.Mock()
        self.window._start_timer(1, 0, callback)
        timer.timeout.connect.call_args.args[0]()
        callback.assert_not_called()
        timer.deleteLater.assert_called_once()

    def test_ensure_app_preserves_existing_tray_lifetime_policy(self):
        tree = ast.parse((HERE.parent/'ui_qt.py').read_text())
        func = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'ensure_app')
        app = mock.Mock()
        qapp = mock.Mock()
        qapp.instance.return_value = app
        env = {'QApplication': qapp, 'sys': sys, 'install_wheel_guard': mock.Mock()}
        exec(compile(ast.Module(body=[func], type_ignores=[]), '<ensure-app>', 'exec'), env)
        self.assertIs(env['ensure_app'](), app)
        app.setQuitOnLastWindowClosed.assert_not_called()


class RealQtCoreTimerTests(unittest.TestCase):
    @unittest.skipIf(importlib.util.find_spec('PySide6') is None, 'QtCore unavailable')
    def test_completed_timers_are_reclaimed_in_real_qt_event_loop(self):
        # Separate process: a QCoreApplication cannot later be upgraded to the
        # QApplication needed by other GUI tests in the same suite.
        script = r"""
import ast, sys
from pathlib import Path
from PySide6.QtCore import QObject, QCoreApplication, QEvent, QTimer
app = QCoreApplication([])
tree = ast.parse(Path(sys.argv[1]).read_text(encoding='utf-8'))
cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'HelperWindow')
method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == '_start_timer')
env = {'QTimer': QTimer, 'Callable': object, 'call_safely': lambda cb: cb()}
exec(compile(ast.Module(body=[method], type_ignores=[]), '<timer>', 'exec'), env)
root = QObject()
root._timers, root._closing = {}, False
for token in range(2000):
    env['_start_timer'](root, token, 0, lambda: None)
app.processEvents()
QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
assert not root._timers
assert len(root.findChildren(QTimer)) == 0
"""
        result = subprocess.run([sys.executable, '-c', script, str(HERE.parent/'helper_window.py')],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
