"""The frozen desktop runtime must ship Qt, not the retired Tk stack."""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import build_exe  # noqa: E402


class BuildExeTests(unittest.TestCase):
    def test_certifi_is_imported_and_its_ca_bundle_is_explicitly_collected(self):
        self.assertIn("certifi", build_exe.ALWAYS_INCLUDE)
        options = build_exe.collect_package_args()
        certifi_index = options.index("certifi")
        self.assertEqual(options[certifi_index - 1], "--collect-data")
        self.assertNotIn("--collect-submodules", options[certifi_index + 1:])

    def test_qt_runtime_is_explicitly_frozen(self):
        for module in ("PySide6.QtCore", "PySide6.QtGui", "PySide6.QtWidgets", "shiboken6"):
            self.assertIn(module, build_exe.ALWAYS_INCLUDE)

    def test_native_launcher_windows_are_frozen_into_the_launcher(self):
        for module in ("ui_qt", "launcher_window", "launcher_content", "launcher_settings"):
            self.assertIn(module, build_exe.LAUNCHER_MODULES)

    def test_tk_facade_is_not_frozen_into_the_launcher_any_more(self):
        # qt_compat belongs to the updatable code bundle: a frozen copy would
        # shadow updated program modules inside the launcher EXE.
        for module in ("qt_compat", "qt_lazy", "qt_factions"):
            self.assertNotIn(module, build_exe.ALWAYS_INCLUDE)
            self.assertNotIn(module, build_exe.LAUNCHER_MODULES)

    def test_tk_and_ttkbootstrap_are_not_runtime_dependencies(self):
        self.assertFalse(any(name == "tkinter" or name.startswith("tkinter.")
                             or name == "ttkbootstrap" or name.startswith("ttkbootstrap.")
                             for name in build_exe.ALWAYS_INCLUDE))
        self.assertNotIn("ttkbootstrap", build_exe.COLLECT_PACKAGES)
        self.assertEqual(build_exe.COLLECT_PACKAGES, ())


class BuildPreflightTests(unittest.TestCase):
    def test_missing_qt_stops_launcher_before_freezing(self):
        from unittest.mock import patch
        import subprocess
        failed = subprocess.CompletedProcess([], 1, '', "No module named 'PySide6'")
        with patch.object(build_exe.subprocess, 'run', return_value=failed) as run:
            with self.assertRaisesRegex(SystemExit, 'Qt runtime check failed'):
                build_exe.main()
        self.assertEqual(run.call_args.args[0],
                         [sys.executable, '-c',
                          'import ' + ', '.join(build_exe.GUI_PREFLIGHT)])

    def test_missing_qt_stops_installer_before_freezing(self):
        from unittest.mock import patch
        import subprocess
        import build_installer

        self.assertIn("installer_window", build_installer.SETUP_MODULES)
        failed = subprocess.CompletedProcess([], 1, '', "No module named 'PySide6'")
        with patch.object(build_installer.sys, 'platform', 'win32'), \
             patch.object(Path, 'is_file', return_value=True), \
             patch.object(build_installer.subprocess, 'run', return_value=failed):
            with self.assertRaisesRegex(SystemExit, 'Qt runtime check failed'):
                build_installer.main()

    def test_qtextcursor_is_not_imported_from_widgets(self):
        import ast
        tree = ast.parse((HERE.parent / 'qt_compat.py').read_text(encoding='utf-8'))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == 'PySide6.QtWidgets':
                self.assertNotIn('QTextCursor', [alias.name for alias in node.names])


if __name__ == "__main__":
    unittest.main()
