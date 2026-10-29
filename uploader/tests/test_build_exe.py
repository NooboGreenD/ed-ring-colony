"""The frozen desktop runtime must ship Qt, not the retired Tk stack."""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPLOADER = HERE.parent
sys.path.insert(0, str(UPLOADER))

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

    def test_start_screen_is_not_frozen_so_it_can_arrive_with_the_package(self):
        """Экран лаунчера — в пакете, а не в exe.

        Замороженный модуль ищется раньше пути на диске, поэтому заморозка
        экрана означала: правка лаунчера (профиль пилота, привязка устройства,
        синхронизация раскладки) доезжает только новой базовой сборкой на
        43 МиБ. Пилоты при этом видели старый экран при свежем пакете.
        """
        for module in ("launcher_ui", "launcher_window", "launcher_profile",
                       "launcher_account", "launcher_content", "launcher_settings", "ui_qt"):
            self.assertNotIn(module, build_exe.LAUNCHER_MODULES)
        # Механизм запуска и переводы ошибок остаются в exe: программа обязана
        # открыться, даже если пакет не установлен.
        for module in ("bundle", "bundle_updater", "i18n", "i18n_catalogs"):
            self.assertIn(module, build_exe.LAUNCHER_MODULES)

    def test_launcher_modules_are_not_frozen(self):
        """`launcher.py` не должен импортировать экран статически.

        PyInstaller разворачивает и `from launcher_ui import show_launcher`, и
        `importlib.import_module("launcher_ui")`. Первое замораживает модуль в
        exe, а замороженная копия ищется раньше пути на диске — экран перестал
        бы обновляться пакетом. Поэтому такие импорты идут через
        `launcher.import_dashboard()`.
        """
        import ast
        tree = ast.parse((UPLOADER / "launcher.py").read_text(encoding="utf-8"))
        own = {path.stem for path in UPLOADER.glob("*.py")}
        screen = own - set(build_exe.LAUNCHER_MODULES)
        static: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                static += [alias.name for alias in node.names if alias.name in screen]
            elif isinstance(node, ast.ImportFrom) and node.module in screen:
                static.append(node.module)
        self.assertEqual(static, [], "статический импорт экрана заморозит его в exe: "
                                   + ", ".join(sorted(set(static))))

    def test_start_screen_ships_inside_the_executable_as_a_fallback(self):
        """Запасная копия экрана лежит в exe каталогом `app_bundle`."""
        import inspect
        source = inspect.getsource(build_exe.main)
        self.assertIn('--add-data', source)
        self.assertIn('app_bundle', source)

    def test_translation_catalog_is_frozen_into_the_launcher(self):
        # Сообщения об ошибках запуска идут через `tr()`, и они должны быть
        # доступны до того, как установлен пакет программы.
        for module in ("i18n", "i18n_catalogs"):
            self.assertIn(module, build_exe.LAUNCHER_MODULES)

    def test_retired_tk_layers_are_not_frozen_any_more(self):
        # Эмуляционный слой Tk удалён из кода: если он вернётся в сборку,
        # значит его случайно импортируют обратно.
        for module in ("qt_compat", "qt_lazy", "qt_factions", "tk_factions"):
            self.assertNotIn(module, build_exe.ALWAYS_INCLUDE)
            self.assertNotIn(module, build_exe.LAUNCHER_MODULES)
        self.assertFalse((HERE.parent / "qt_compat.py").exists())
        self.assertFalse((HERE.parent / "qt_lazy.py").exists())

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
        """`QTextCursor` живёт в QtGui; из QtWidgets он не импортируется."""
        import ast

        offenders = []
        for path in sorted(HERE.parent.glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if (isinstance(node, ast.ImportFrom)
                        and node.module == "PySide6.QtWidgets"
                        and "QTextCursor" in [alias.name for alias in node.names]):
                    offenders.append(path.name)
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
