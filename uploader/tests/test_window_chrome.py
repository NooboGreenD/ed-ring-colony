"""Windows-only custom chrome removes the native caption and uses native dragging."""
import ctypes
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import window_chrome  # noqa: E402


class WindowChromeTests(unittest.TestCase):
    def test_prefers_tk_outer_frame_handle_over_client_handle(self):
        class Window:
            def wm_frame(self):
                return "0x5678"

            def winfo_id(self):
                return 0x1234

        user32 = mock.Mock()
        self.assertEqual(window_chrome._window_handle(Window(), user32), 0x5678)
        user32.GetAncestor.assert_not_called()

    def test_native_caption_is_tinted_to_match_the_dark_ui(self):
        hwnd = 0x5678
        window = mock.Mock()
        window.wm_frame.return_value = hex(hwnd)
        user32 = mock.Mock()
        dwmapi = mock.Mock()
        dwmapi.DwmSetWindowAttribute.return_value = 0

        with mock.patch.object(window_chrome.sys, "platform", "win32"):
            self.assertTrue(window_chrome.style_native_caption(window, dwmapi, user32))

        calls = dwmapi.DwmSetWindowAttribute.call_args_list
        self.assertEqual([call.args[1] for call in calls], [
            window_chrome.DWMWA_USE_IMMERSIVE_DARK_MODE,
            window_chrome.DWMWA_CAPTION_COLOR,
            window_chrome.DWMWA_TEXT_COLOR,
            window_chrome.DWMWA_BORDER_COLOR,
        ])
        self.assertEqual(calls[1].args[0], hwnd)
        self.assertEqual(
            ctypes.cast(calls[1].args[2], ctypes.POINTER(ctypes.c_int)).contents.value,
            window_chrome.CAPTION_BG_COLORREF,
        )

    def test_caption_is_removed_from_the_outer_toplevel_hwnd(self):
        child_hwnd = 0x1234
        outer_hwnd = 0x5678
        original = window_chrome.WS_CAPTION | window_chrome.WS_THICKFRAME | window_chrome.WS_MAXIMIZEBOX
        user32 = mock.Mock()
        user32.GetAncestor.return_value = outer_hwnd
        style = {
            window_chrome.GWL_STYLE: original,
            window_chrome.GWL_EXSTYLE: window_chrome.WS_EX_TOOLWINDOW,
        }
        user32.GetWindowLongPtrW.side_effect = lambda _hwnd, index: style[index]

        def set_style(_hwnd, index, value):
            old = style[index]
            style[index] = value
            return old

        user32.SetWindowLongPtrW.side_effect = set_style
        user32.SetWindowPos.return_value = 1

        class Window:
            def winfo_id(self):
                return child_hwnd

        with mock.patch.object(window_chrome.sys, "platform", "win32"):
            self.assertTrue(window_chrome.remove_native_caption(Window(), user32=user32))

        user32.GetAncestor.assert_called_once_with(child_hwnd, window_chrome.GA_ROOT)
        user32.SetWindowLongPtrW.assert_has_calls([
            mock.call(outer_hwnd, window_chrome.GWL_STYLE,
                      original & ~window_chrome.WS_CAPTION),
            mock.call(outer_hwnd, window_chrome.GWL_EXSTYLE,
                      window_chrome.WS_EX_APPWINDOW),
        ])
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
        style = {
            window_chrome.GWL_STYLE: original,
            window_chrome.GWL_EXSTYLE: window_chrome.WS_EX_TOOLWINDOW,
        }
        user32.GetWindowLongPtrW.side_effect = lambda _hwnd, index: style[index]

        def set_style(_hwnd, index, value):
            old = style[index]
            style[index] = value
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

        user32.SetWindowLongPtrW.assert_has_calls([
            mock.call(hwnd, window_chrome.GWL_STYLE,
                      original & ~window_chrome.WS_CAPTION & ~window_chrome.WS_THICKFRAME
                      & ~window_chrome.WS_MAXIMIZEBOX),
            mock.call(hwnd, window_chrome.GWL_EXSTYLE,
                      window_chrome.WS_EX_APPWINDOW),
        ])

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
            window.overrideredirect.assert_called_once_with(True)
            bindings = [call for call in bar.bind.call_args_list if call.args[0] == "<ButtonPress-1>"]
            self.assertTrue(bindings)
            self.assertEqual(bindings[0].args[1](mock.Mock()), "break")
            drag.assert_called_once_with(window)
            window.geometry.assert_not_called()

    def test_non_windows_keeps_native_decorations(self):
        with mock.patch.object(window_chrome.sys, "platform", "linux"):
            self.assertFalse(window_chrome.remove_native_caption(object()))
            self.assertFalse(window_chrome.style_native_caption(object()))
            self.assertIsNone(window_chrome.add_custom_titlebar(object(), object(), "title"))


if __name__ == "__main__":
    unittest.main()
