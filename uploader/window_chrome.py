"""Small Windows-only custom title bars for the desktop Tk windows."""
from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_MAXIMIZEBOX = 0x00010000
GWL_STYLE = -16
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
GA_ROOT = 2


def _window_handle(window, user32=None) -> int:
    """Resolve Tk's client HWND to the actual top-level HWND on Windows."""
    try:
        hwnd = int(window.winfo_id())
    except (AttributeError, TypeError, ValueError):
        try:
            hwnd = int(str(window.wm_frame()), 0)
        except (AttributeError, TypeError, ValueError):
            return 0

    if not hwnd or user32 is None:
        return hwnd
    try:
        user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        user32.GetAncestor.restype = wintypes.HWND
        top_level = user32.GetAncestor(hwnd, GA_ROOT)
        if top_level:
            return int(top_level)
    except Exception:
        # Older/nonstandard Tk builds may already return the top-level HWND.
        pass
    return hwnd


def remove_native_caption(window, user32=None, *, allow_resize=True,
                          allow_maximize=True) -> bool:
    """Hide the native caption on the outer Tk window and set resize policy."""
    if not sys.platform.startswith("win"):
        return False
    try:
        api = user32 or ctypes.WinDLL("user32", use_last_error=True)
        hwnd = _window_handle(window, api)
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
        if not allow_resize:
            desired &= ~WS_THICKFRAME
        if not allow_maximize:
            desired &= ~WS_MAXIMIZEBOX
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


def _drag_geometry(start: dict, pointer_x: int, pointer_y: int) -> str:
    """Move using the original dimensions; title-bar dragging can never resize."""
    left = max(0, int(start["left"]) + int(pointer_x) - int(start["pointer_x"]))
    top = max(0, int(start["top"]) + int(pointer_y) - int(start["pointer_y"]))
    return f"{int(start['width'])}x{int(start['height'])}+{left}+{top}"


def add_custom_titlebar(window, tk, title: str, *, close_command=None,
                        background="#25282b", foreground="#f2f3f4",
                        accent="#e57b28", allow_maximize=True,
                        allow_resize=True):
    """Add branded controls and remove the native title bar on Windows.

    Other platforms retain their native decorations. Dragging updates only the
    position component of a fixed geometry, so it cannot accidentally stretch a
    non-resizable installer window.
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

    def start_drag(event):
        try:
            if allow_maximize and window.state() in ("zoomed", "maximized"):
                window.state("normal")
                window.update_idletasks()
                width = int(window.winfo_width())
                height = int(window.winfo_height())
                start = {
                    "pointer_x": int(event.x_root), "pointer_y": int(event.y_root),
                    "left": max(0, int(event.x_root) - 80),
                    "top": max(0, int(event.y_root) - 16),
                    "width": width, "height": height,
                }
            else:
                window.update_idletasks()
                start = {
                    "pointer_x": int(event.x_root), "pointer_y": int(event.y_root),
                    "left": int(window.winfo_x()), "top": int(window.winfo_y()),
                    "width": int(window.winfo_width()),
                    "height": int(window.winfo_height()),
                }
            window._custom_chrome_drag = start
        except Exception:
            window._custom_chrome_drag = None
        return "break"

    def move_drag(event):
        start = getattr(window, "_custom_chrome_drag", None)
        if start:
            try:
                window.geometry(_drag_geometry(start, event.x_root, event.y_root))
            except Exception:
                pass
        return "break"

    def stop_drag(_event):
        window._custom_chrome_drag = None
        return "break"

    for widget in (bar, marker, label):
        widget.bind("<ButtonPress-1>", start_drag)
        widget.bind("<B1-Motion>", move_drag)
        widget.bind("<ButtonRelease-1>", stop_drag)
        widget.bind("<Double-Button-1>", lambda _event: toggle_maximize() if allow_maximize else None)

    def apply_chrome():
        if not remove_native_caption(
            window, allow_resize=allow_resize, allow_maximize=allow_maximize,
        ):
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
