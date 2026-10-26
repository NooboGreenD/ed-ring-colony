"""Windows-only custom chrome keeps resize policy and drag geometry stable."""
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import window_chrome  # noqa: E402


class WindowChromeTests(unittest.TestCase):
    def test_caption_is_removed_from_the_outer_toplevel_hwnd(self):
        child_hwnd = 0x1234
        outer_hwnd = 0x5678
        original = window_chrome.WS_CAPTION | window_chrome.WS_THICKFRAME | window_chrome.WS_MAXIMIZEBOX
        user32 = mock.Mock()
        user32.GetAncestor.return_value = outer_hwnd
        user32.GetWindowLongPtrW.return_value = original
        user32.SetWindowPos.return_value = 1

        class Window:
            def winfo_id(self):
                return child_hwnd

        with mock.patch.object(window_chrome.sys, "platform", "win32"):
            self.assertTrue(window_chrome.remove_native_caption(Window(), user32=user32))

        user32.GetAncestor.assert_called_once_with(child_hwnd, window_chrome.GA_ROOT)
        user32.SetWindowLongPtrW.assert_called_once_with(
            outer_hwnd, window_chrome.GWL_STYLE, original & ~window_chrome.WS_CAPTION,
        )
        self.assertEqual(
            user32.SetWindowPos.call_args.args[-1],
            window_chrome.SWP_NOMOVE | window_chrome.SWP_NOSIZE
            | window_chrome.SWP_NOZORDER | window_chrome.SWP_NOACTIVATE
            | window_chrome.SWP_FRAMECHANGED,
        )

    def test_fixed_setup_style_disables_resize_and_maximize(self):
        hwnd = 0x1234
        original = window_chrome.WS_CAPTION | window_chrome.WS_THICKFRAME | window_chrome.WS_MAXIMIZEBOX
        user32 = mock.Mock()
        user32.GetAncestor.return_value = hwnd
        user32.GetWindowLongPtrW.return_value = original
        user32.SetWindowPos.return_value = 1

        class Window:
            def winfo_id(self):
                return hwnd

        with mock.patch.object(window_chrome.sys, "platform", "win32"):
            self.assertTrue(window_chrome.remove_native_caption(
                Window(), user32=user32, allow_resize=False, allow_maximize=False,
            ))

        self.assertEqual(
            user32.SetWindowLongPtrW.call_args.args[-1],
            original & ~window_chrome.WS_CAPTION & ~window_chrome.WS_THICKFRAME
            & ~window_chrome.WS_MAXIMIZEBOX,
        )

    def test_drag_uses_native_move_on_the_outer_toplevel(self):
        child_hwnd = 0x1234
        outer_hwnd = 0x5678
        user32 = mock.Mock()
        user32.GetAncestor.return_value = outer_hwnd
        user32.ReleaseCapture.return_value = 1

        class Window:
            def winfo_id(self):
                return child_hwnd

        with mock.patch.object(window_chrome.sys, "platform", "win32"):
            self.assertTrue(window_chrome._begin_native_drag(Window(), user32=user32))

        user32.ReleaseCapture.assert_called_once_with()
        user32.SendMessageW.assert_called_once_with(
            outer_hwnd, window_chrome.WM_NCLBUTTONDOWN, window_chrome.HTCAPTION, 0,
        )

    def test_drag_geometry_only_changes_position(self):
        start = {"left": 120, "top": 75, "pointer_x": 150, "pointer_y": 90,
                 "width": 600, "height": 455}
        self.assertEqual(window_chrome._drag_geometry(start, 210, 130), "600x455+180+115")

    def test_non_windows_keeps_native_decorations(self):
        with mock.patch.object(window_chrome.sys, "platform", "linux"):
            self.assertFalse(window_chrome.remove_native_caption(object()))
            self.assertIsNone(window_chrome.add_custom_titlebar(object(), object(), "title"))


if __name__ == "__main__":
    unittest.main()
