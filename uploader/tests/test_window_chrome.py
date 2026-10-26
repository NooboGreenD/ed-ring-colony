"""Windows-only custom chrome keeps native resize behavior and degrades safely."""
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import window_chrome  # noqa: E402


class WindowChromeTests(unittest.TestCase):
    def test_caption_removal_preserves_other_styles_and_notifies_windows(self):
        hwnd = 0x1234
        original = window_chrome.WS_CAPTION | 0x00040000 | 0x00010000
        user32 = mock.Mock()
        user32.GetWindowLongPtrW.return_value = original
        user32.SetWindowPos.return_value = 1

        class Window:
            def wm_frame(self):
                return hex(hwnd)

        with mock.patch.object(window_chrome.sys, "platform", "win32"):
            self.assertTrue(window_chrome.remove_native_caption(Window(), user32=user32))

        user32.SetWindowLongPtrW.assert_called_once_with(
            hwnd, window_chrome.GWL_STYLE, original & ~window_chrome.WS_CAPTION,
        )
        self.assertEqual(
            user32.SetWindowPos.call_args.args[-1],
            window_chrome.SWP_NOMOVE | window_chrome.SWP_NOSIZE
            | window_chrome.SWP_NOZORDER | window_chrome.SWP_NOACTIVATE
            | window_chrome.SWP_FRAMECHANGED,
        )

    def test_non_windows_keeps_native_decorations(self):
        with mock.patch.object(window_chrome.sys, "platform", "linux"):
            self.assertFalse(window_chrome.remove_native_caption(object()))
            self.assertIsNone(window_chrome.add_custom_titlebar(object(), object(), "title"))


if __name__ == "__main__":
    unittest.main()
