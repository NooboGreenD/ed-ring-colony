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

    def test_qt_runtime_and_facades_are_explicitly_frozen(self):
        for module in ("PySide6.QtCore", "PySide6.QtGui", "PySide6.QtWidgets",
                       "qt_compat", "qt_lazy", "qt_factions", "theme_tokens", "locale_config"):
            self.assertIn(module, build_exe.ALWAYS_INCLUDE)

    def test_tk_and_ttkbootstrap_are_not_runtime_dependencies(self):
        self.assertFalse(any(name == "tkinter" or name.startswith("tkinter.")
                             or name == "ttkbootstrap" or name.startswith("ttkbootstrap.")
                             for name in build_exe.ALWAYS_INCLUDE))
        self.assertNotIn("ttkbootstrap", build_exe.COLLECT_PACKAGES)
        self.assertEqual(build_exe.COLLECT_PACKAGES, ())


if __name__ == "__main__":
    unittest.main()
