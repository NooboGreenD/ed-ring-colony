"""Regression tests for the desktop sidebar's ttk widget options."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from ui_navigation import SidebarNavigator  # noqa: E402


class SidebarNavigatorTests(unittest.TestCase):
    def test_navigation_button_uses_only_supported_ttk_widget_options(self):
        toolkit = Mock()
        navigator = SidebarNavigator(Mock(), toolkit)
        page = Mock()

        navigator.add(page, "Подключение")

        button_options = toolkit.Button.call_args.kwargs
        self.assertNotIn("anchor", button_options)
        self.assertEqual(button_options["text"], "Подключение")
        self.assertEqual(navigator.select(page), str(page))


if __name__ == "__main__":
    unittest.main()
