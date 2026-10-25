"""Centralized, pixel-based wheel routing for Tk canvas-backed pages.

Tk's ``bind_all`` is process-wide. Attaching and removing it independently on
several pages lets one page silently cancel another page's wheel handler. This
controller owns one dispatcher and animates canvas movement without blocking
Tk's event loop.
"""
from __future__ import annotations

import sys
import time
from typing import Any, Dict, Iterable, Optional, Tuple


class SmoothScrollController:
    """Route wheel input to the hovered scroll area and animate it smoothly."""

    def __init__(self, root, *, platform: Optional[str] = None,
                 pixels_per_notch: float = 84.0, duration_ms: int = 115,
                 frame_ms: int = 16):
        self.root = root
        self.platform = platform or sys.platform
        self.pixels_per_notch = float(pixels_per_notch)
        self.duration = max(1, int(duration_ms)) / 1000.0
        self.frame_ms = max(8, int(frame_ms))
        self._owners: Dict[Any, Any] = {}
        self._animations: Dict[Any, Dict[str, Any]] = {}
        # One application-wide dispatcher; registered areas are selected by
        # the pointer's widget ancestry. It is never removed on page changes.
        root.bind_all("<MouseWheel>", self._on_mousewheel, add="+")
        root.bind_all("<Button-4>", self._on_button_wheel, add="+")
        root.bind_all("<Button-5>", self._on_button_wheel, add="+")

    def register(self, canvas, *scope_widgets) -> None:
        """Register a canvas and any sibling viewport/scrollbar hit targets."""
        self._owners[canvas] = canvas
        for widget in scope_widgets:
            if widget is not None:
                self._owners[widget] = canvas

    def unregister(self, canvas) -> None:
        for widget, owner in list(self._owners.items()):
            if owner is canvas:
                self._owners.pop(widget, None)
        animation = self._animations.pop(canvas, None)
        if animation and animation.get("job"):
            try:
                self.root.after_cancel(animation["job"])
            except Exception:
                pass

    def _owner_at_pointer(self, event) -> Tuple[Optional[Any], Optional[Any]]:
        try:
            widget = getattr(event, "widget", None)
            if widget is None:
                widget = self.root.winfo_containing(event.x_root, event.y_root)
        except Exception:
            widget = getattr(event, "widget", None)
        current = widget
        while current is not None:
            owner = self._owners.get(current)
            # Text/Listbox/Treeview and nested canvases keep their native wheel
            # behavior instead of also scrolling the containing page.
            if current is not owner and callable(getattr(current, "yview", None)):
                return None, current
            if owner is not None:
                return owner, current
            current = getattr(current, "master", None)
        return None, widget

    def _on_mousewheel(self, event):
        try:
            delta = float(getattr(event, "delta", 0) or 0)
        except (TypeError, ValueError):
            delta = 0.0
        if not delta:
            return None
        if self.platform == "darwin":
            pixels = -delta * 32.0
        else:
            # Preserve high-resolution wheel deltas instead of truncating all
            # sub-notch events to zero as int(delta / 120) does.
            pixels = -(delta / 120.0) * self.pixels_per_notch
        return self._route(event, pixels)

    def _on_button_wheel(self, event):
        number = getattr(event, "num", 0)
        if number not in (4, 5):
            return None
        pixels = -self.pixels_per_notch if number == 4 else self.pixels_per_notch
        return self._route(event, pixels)

    def _route(self, event, pixels: float):
        canvas, _widget = self._owner_at_pointer(event)
        if canvas is None:
            return None
        return self._scroll(canvas, pixels)

    @staticmethod
    def _metrics(canvas):
        try:
            bounds = canvas.bbox("all")
            viewport = int(canvas.winfo_height())
            view = canvas.yview()
            if not bounds or viewport <= 1 or not view:
                return None
            top, bottom = float(bounds[1]), float(bounds[3])
            content_height = max(0.0, bottom - top)
            if content_height <= viewport:
                return None
            current = top + float(view[0]) * content_height
            return top, content_height, float(viewport), current
        except Exception:
            return None

    def _scroll(self, canvas, pixels: float):
        metrics = self._metrics(canvas)
        if metrics is None or not pixels:
            return "break"
        top, content_height, viewport, current = metrics
        max_top = top + content_height - viewport
        animation = self._animations.get(canvas)
        if animation is None:
            start = min(max(current, top), max_top)
            target = min(max(start + pixels, top), max_top)
            if abs(target - start) < 0.5:
                return "break"
            animation = {
                "start": start,
                "target": target,
                "started": time.monotonic(),
                "job": None,
            }
            self._animations[canvas] = animation
            self._schedule(canvas, animation)
        else:
            animation["target"] = min(max(animation["target"] + pixels, top), max_top)
        return "break"

    def _schedule(self, canvas, animation) -> None:
        try:
            animation["job"] = self.root.after(
                self.frame_ms, lambda c=canvas, a=animation: self._animate(c, a))
        except Exception:
            self._animations.pop(canvas, None)

    def _animate(self, canvas, animation) -> None:
        if self._animations.get(canvas) is not animation:
            return
        animation["job"] = None
        metrics = self._metrics(canvas)
        if metrics is None:
            self._animations.pop(canvas, None)
            return
        top, content_height, viewport, current = metrics
        max_top = top + content_height - viewport
        start = min(max(animation["start"], top), max_top)
        target = min(max(animation["target"], top), max_top)
        fraction = min(1.0, (time.monotonic() - animation["started"]) / self.duration)
        eased = 1.0 - (1.0 - fraction) ** 3
        position = start + (target - start) * eased
        try:
            canvas.yview_moveto(max(0.0, min(1.0, (position - top) / content_height)))
        except Exception:
            self._animations.pop(canvas, None)
            return
        if fraction >= 1.0 or abs(target - position) < 0.5:
            self._animations.pop(canvas, None)
            return
        self._schedule(canvas, animation)
