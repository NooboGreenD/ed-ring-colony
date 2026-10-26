"""Small Windows-only custom title bar for the desktop Tk windows."""
from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

WS_CAPTION = 0x00C00000
GWL_STYLE = -16
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020

WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2


def _window_handle(window) -> int:
    """Get Tk's outer HWND (``wm frame``), falling back to its client HWND."""
    try:
        value = str(window.wm_frame())
        return int(value, 0)
    except (AttributeError, TypeError, ValueError):
        return int(window.winfo_id())


def remove_native_caption(window, user32=None) -> bool:
    """Hide only the native caption while preserving system resize borders."""
    if not sys.platform.startswith("win"):
        return False
    try:
        api = user32 or ctypes.WinDLL("user32", use_last_error=True)
        hwnd = _window_handle(window)
        if not hwnd:
            return False
        pointer_sized = ctypes.c_ssize_t
        if ctypes.sizeof(ctypes.c_void_p) == 8 and hasattr(api, "GetWindowLongPtrW"):
            get_style = api.GetWindowLongPtrW
            set_style = api.SetWindowLongPtrW
            get_style.restype = pointer_sized
            get_style.argtypes = [wintypes.HWND, ctypes.c_int]
            set_style.restype = pointer_sized
            set_style.argtypes = [wintypes.HWND, ctypes.c_int, pointer_sized]
        else:
            get_style = api.GetWindowLongW
            set_style = api.SetWindowLongW
            get_style.restype = wintypes.LONG
            get_style.argtypes = [wintypes.HWND, ctypes.c_int]
            set_style.restype = wintypes.LONG
            set_style.argtypes = [wintypes.HWND, ctypes.c_int, wintypes.LONG]
        style = int(get_style(hwnd, GWL_STYLE))
        desired = style & ~WS_CAPTION
        if desired != style:
            previous = set_style(hwnd, GWL_STYLE, desired)
            if not previous:
                return False
        flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
        api.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                     ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        api.SetWindowPos.restype = wintypes.BOOL
        if not api.SetWindowPos(hwnd, None, 0, 0, 0, 0, flags):
            return False
        return True
    except Exception:
        return False


def _begin_native_drag(window) -> bool:
    if not sys.platform.startswith("win"):
        return False
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        hwnd = _window_handle(window)
        user32.ReleaseCapture.restype = wintypes.BOOL
        user32.SendMessageW.argtypes = [
            wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
        ]
        user32.SendMessageW.restype = wintypes.LPARAM
        user32.ReleaseCapture()
        user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)
        return True
    except Exception:
        return False


def add_custom_titlebar(window, tk, title: str, *, close_command=None,
                        background="#25282b", foreground="#f2f3f4",
                        accent="#e57b28", allow_maximize=True):
    """Add branded controls and schedule native-caption removal on Windows.

    Other platforms keep their native decorations instead of getting a duplicate
    title bar. The OS thick-frame style is retained for resizing and snapping.
    """
    if not sys.platform.startswith("win"):
        return None

    bar = tk.Frame(window, bg=background, height=34, highlightthickness=0)
    bar.pack(side="top", fill="x")
    bar.pack_propagate(False)
    marker = tk.Frame(bar, bg=accent, width=4, height=34)
    marker.pack(side="left", fill="y")
    label = tk.Label(bar, text=title, bg=background, fg=foreground,
                     font=("Segoe UI", 9, "bold"), anchor="w", padx=10)
    label.pack(side="left", fill="both", expand=True)

    controls = tk.Frame(bar, bg=background)
    controls.pack(side="right", fill="y")

    def button(text, command, hover):
        widget = tk.Button(
            controls, text=text, command=command, bg=background, fg=foreground,
            activebackground=hover, activeforeground=foreground,
            relief="flat", bd=0, highlightthickness=0,
            font=("Segoe UI Symbol", 10), cursor="hand2", width=4,
        )
        widget.pack(side="left", fill="y")
        widget.bind("<Enter>", lambda _event, w=widget, c=hover: w.configure(bg=c))
        widget.bind("<Leave>", lambda _event, w=widget: w.configure(bg=background))
        return widget

    button("—", window.iconify, "#3b4044")
    if allow_maximize:
        def toggle_maximize():
            try:
                if window.state() in ("zoomed", "maximized"):
                    window.state("normal")
                else:
                    window.state("zoomed")
            except Exception:
                pass
        button("□", toggle_maximize, "#3b4044")
    button("×", close_command or window.destroy, "#c84343")

    def drag(event):
        if not _begin_native_drag(window):
            try:
                window.geometry(f"+{event.x_root - 80}+{event.y_root - 16}")
            except Exception:
                pass

    for widget in (bar, marker, label):
        widget.bind("<ButtonPress-1>", drag)
        widget.bind("<Double-Button-1>", lambda _event: toggle_maximize() if allow_maximize else None)

    def apply_chrome():
        if not remove_native_caption(window):
            # Prefer the familiar Windows frame over a duplicate title bar if
            # this Tk/Windows combination does not permit changing its style.
            try:
                bar.destroy()
            except Exception:
                pass

    try:
        # Let Tk create/map the native HWND before altering its frame style.
        window.after(50, apply_chrome)
    except Exception:
        apply_chrome()
    return bar
