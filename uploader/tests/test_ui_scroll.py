"""Wheel routing and smooth-scroll animation behavior without a real Tk display."""
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from ui_scroll import SmoothScrollController  # noqa: E402


class FakeFrame:
    def __init__(self, master=None):
        self.master = master


class FakeCanvas(FakeFrame):
    def __init__(self, master=None, *, height=200, bbox=(0, 0, 400, 1000)):
        super().__init__(master)
        self._height = height
        self._bbox = bbox
        self._top = 0.0

    def bbox(self, _target):
        return self._bbox

    def winfo_height(self):
        return self._height

    def yview(self):
        total = self._bbox[3] - self._bbox[1]
        top = max(0.0, min(1.0, self._top / total))
        return top, min(1.0, top + self._height / total)

    def yview_moveto(self, fraction):
        self._top = fraction * (self._bbox[3] - self._bbox[1])


class FakeNativeScroller(FakeFrame):
    def yview(self):
        return (0.0, 1.0)


class FakeRoot:
    def __init__(self):
        self.bindings = []
        self.jobs = {}
        self._next_job = 0

    def bind_all(self, sequence, callback, add=None):
        self.bindings.append((sequence, callback, add))

    def after(self, _delay, callback):
        self._next_job += 1
        self.jobs[self._next_job] = callback
        return self._next_job

    def after_cancel(self, job):
        self.jobs.pop(job, None)


class SmoothScrollTests(unittest.TestCase):
    def setUp(self):
        self.root = FakeRoot()
        self.controller = SmoothScrollController(self.root, platform="win32")
        self.canvas = FakeCanvas()
        self.viewport = FakeFrame()
        self.inner = FakeFrame(master=self.canvas)
        self.scrollbar = FakeFrame(master=self.viewport)
        self.controller.register(self.canvas, self.viewport, self.inner, self.scrollbar)

    def test_controller_owns_single_non_destructive_global_dispatcher(self):
        self.assertEqual([binding[0] for binding in self.root.bindings],
                         ["<MouseWheel>", "<Button-4>", "<Button-5>"])
        self.controller.unregister(self.canvas)
        self.assertEqual(len(self.root.bindings), 3)

    def test_fractional_wheel_delta_routes_to_hovered_canvas(self):
        event = mock.Mock(widget=FakeFrame(master=self.inner), delta=-60)
        self.assertEqual(self.controller._on_mousewheel(event), "break")
        animation = self.controller._animations[self.canvas]
        self.assertAlmostEqual(animation["target"] - animation["start"], 42.0)

    def test_input_accumulates_into_one_smooth_animation(self):
        event = mock.Mock(widget=self.inner, delta=-120)
        self.controller._on_mousewheel(event)
        animation = self.controller._animations[self.canvas]
        animation_id = id(animation)
        first_target = animation["target"]
        self.controller._on_mousewheel(event)
        self.assertEqual(id(self.controller._animations[self.canvas]), animation_id)
        self.assertAlmostEqual(animation["target"] - first_target, 84.0)

    def test_animation_moves_canvas_to_target_without_blocking(self):
        self.controller._on_mousewheel(mock.Mock(widget=self.inner, delta=-120))
        animation = self.controller._animations[self.canvas]
        animation["started"] -= 1.0
        self.controller._animate(self.canvas, animation)
        self.assertAlmostEqual(self.canvas._top, animation["target"], places=2)
        self.assertNotIn(self.canvas, self.controller._animations)

    def test_nested_native_scroll_widget_is_not_stolen_by_parent(self):
        nested = FakeNativeScroller(master=self.inner)
        event = mock.Mock(widget=nested, delta=-120)
        self.assertIsNone(self.controller._on_mousewheel(event))
        self.assertNotIn(self.canvas, self.controller._animations)

    def test_linux_and_macos_wheel_units_are_supported(self):
        linux = SmoothScrollController(FakeRoot(), platform="linux")
        linux_canvas = FakeCanvas()
        linux_canvas._top = 250.0
        linux.register(linux_canvas)
        linux_event = mock.Mock(widget=linux_canvas, num=5)
        self.assertEqual(linux._on_button_wheel(linux_event), "break")
        self.assertAlmostEqual(linux._animations[linux_canvas]["target"], 334.0)
        mac = SmoothScrollController(FakeRoot(), platform="darwin")
        mac_canvas = FakeCanvas()
        mac_canvas._top = 250.0
        mac.register(mac_canvas)
        event = mock.Mock(widget=mac_canvas, delta=2)
        self.assertEqual(mac._on_mousewheel(event), "break")
        self.assertAlmostEqual(mac._animations[mac_canvas]["target"], 186.0)


if __name__ == "__main__":
    unittest.main()
