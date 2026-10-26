"""Windows-only custom chrome removes the native caption and uses native dragging."""
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
        style = {"value": original}
        user32.GetWindowLongPtrW.side_effect = lambda _hwnd, _index: style["value"]

        def set_style(_hwnd, _index, value):
            old = style["value"]
            style["value"] = value
            return old

        user32.SetWindowLongPtrW.side_effect = set_style
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
        style = {"value": original}
        user32.GetWindowLongPtrW.side_effect = lambda _hwnd, _index: style["value"]

        def set_style(_hwnd, _index, value):
            old = style["value"]
            style["value"] = value
            return old

        user32.SetWindowLongPtrW.side_effect = set_style
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
            outer_hwnd, window_chrome.WM_SYSCOMMAND,
            window_chrome.SC_MOVE | window_chrome.HTCAPTION, 0,
        )

    def test_drag_uses_native_window_manager_instead_of_geometry_updates(self):
        tk = mock.Mock()
        window = mock.Mock()
        window.state.return_value = "normal"
        window.after.return_value = "after#1"
        with mock.patch.object(window_chrome.sys, "platform", "win32"), \
             mock.patch.object(window_chrome, "remove_native_caption", return_value=True), \
             mock.patch.object(window_chrome, "_begin_native_drag", return_value=True) as drag:
            bar = window_chrome.add_custom_titlebar(window, tk, "Test")
            bindings = [call for call in bar.bind.call_args_list if call.args[0] == "<ButtonPress-1>"]
            self.assertTrue(bindings)
            self.assertEqual(bindings[0].args[1](mock.Mock()), "break")
            drag.assert_called_once_with(window)
            window.geometry.assert_not_called()

    def test_non_windows_keeps_native_decorations(self):
        with mock.patch.object(window_chrome.sys, "platform", "linux"):
            self.assertFalse(window_chrome.remove_native_caption(object()))
            self.assertIsNone(window_chrome.add_custom_titlebar(object(), object(), "title"))


if __name__ == "__main__":
    unittest.main()
