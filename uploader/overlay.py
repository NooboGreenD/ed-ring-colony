"""Оверлейные окна для Colonial Helper — HUD-стиль ED Ring Colony."""
import tkinter as tk
from tkinter import END
from typing import Dict, Any, Optional, Callable
import threading
import time
from pathlib import Path
from collections import deque

from ship_tracker import decode_status_flags


# ============================================================
#  Win32 API helpers для привязки оверлея к окну игры
# ============================================================
def _get_ed_hwnd() -> Optional[int]:
    """Найти HWND окна Elite Dangerous."""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        EnumWindows = user32.EnumWindows
        EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_int, ctypes.POINTER(ctypes.c_int))
        GetWindowTextW = user32.GetWindowTextW
        GetWindowTextLengthW = user32.GetWindowTextLengthW
        IsWindowVisible = user32.IsWindowVisible

        ed_hwnd = []

        def foreach_window(hwnd, _):
            if IsWindowVisible(hwnd):
                length = GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    GetWindowTextW(hwnd, buf, length + 1)
                    title = buf.value
                    if "Elite - Dangerous" in title or "Elite Dangerous" in title:
                        ed_hwnd.append(hwnd)
                        return False
            return True

        EnumWindows(EnumWindowsProc(foreach_window), 0)
        return ed_hwnd[0] if ed_hwnd else None
    except Exception:
        return None


def _is_ed_foreground() -> bool:
    """Проверить, активно ли сейчас окно Elite Dangerous."""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        fg = user32.GetForegroundWindow()
        if not fg:
            # GetForegroundWindow вернул 0 — возможно, игра запущена от админа,
            # а uploader — нет. Считаем ED активной, чтобы оверлей не пропал.
            return True
        ed = _get_ed_hwnd()
        if ed and fg == ed:
            return True
        # Fallback: проверяем по заголовку foreground окна
        length = user32.GetWindowTextLengthW(fg)
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(fg, buf, length + 1)
            title = buf.value
            return "Elite" in title and "Dangerous" in title
    except Exception:
        pass
    return True  # Fallback: считаем активной, чтобы оверлей не пропал


def _set_window_topmost(hwnd: int, topmost: bool):
    """Установить/снять WS_EX_TOPMOST для окна через Win32 API.
    
    ПРИМЕЧАНИЕ: Для overrideredirect окон tkinter Win32 API SetWindowPos
    может полностью сломать Z-order окна. Используем только tkinter.
    """
    pass


# ============================================================
#  Цветовая схема в стиле ED Ring Colony сайта
# ============================================================
COLOR_BG = "#0d1117"
COLOR_PANEL = "#161b22"
COLOR_PANEL_HOVER = "#1c2128"
COLOR_TEXT = "#e6edf3"
COLOR_TEXT_MUTED = "#8b949e"
COLOR_ACCENT = "#e67e22"
COLOR_ACCENT_HOVER = "#f39c12"
COLOR_CYAN = "#58a6ff"
COLOR_GREEN = "#238636"
COLOR_GREEN_TEXT = "#3fb950"
COLOR_RED = "#da3633"
COLOR_RED_TEXT = "#f85149"
COLOR_YELLOW = "#d29922"
COLOR_BORDER = "#30363d"
COLOR_BORDER_ACTIVE = "#58a6ff"
COLOR_LINE = "#21262d"


# ============================================================
#  Утилиты стиля
# ============================================================
def _make_separator(parent, color=COLOR_LINE) -> tk.Frame:
    sep = tk.Frame(parent, bg=color, height=1)
    return sep


# ============================================================
#  Базовое оверлейное окно с управлением
# ============================================================
class OverlayWindow:
    """Базовое оверлейное окно: без рамки, всегда сверху, перетаскиваемое,
    с возможностью изменения размера, фиксации и привязки к экрану."""

    ANCHOR_POSITIONS = {
        "top_left": (20, 20),
        "top_center": lambda w, h: (w // 2 - 150, 20),
        "top_right": lambda w, h: (w - 320, 20),
        "mid_left": lambda w, h: (20, h // 2 - 200),
        "mid_right": lambda w, h: (w - 320, h // 2 - 200),
        "bottom_left": lambda w, h: (20, h - 300),
        "bottom_center": lambda w, h: (w // 2 - 150, h - 300),
        "bottom_right": lambda w, h: (w - 320, h - 300),
        "custom": None,
    }

    def __init__(
        self,
        master: tk.Tk,
        title: str,
        x: int,
        y: int,
        width: int,
        height: int,
        settings: Dict[str, Any],
        overlay_key: str,
    ):
        self.master = master
        self.settings = settings
        self.overlay_key = overlay_key
        self._alpha = settings.get("alpha", 0.90)
        self._drag_data = {"x": 0, "y": 0}
        self._resize_data = {"x": 0, "y": 0, "w": 0, "h": 0}
        self._locked = settings.get(f"{overlay_key}_locked", False)
        self._anchor = settings.get(f"{overlay_key}_anchor", "custom")
        self._min_width = 200
        self._min_height = 100

        self.window = tk.Toplevel(master)
        self.window.title(title)
        self.window.geometry(f"{width}x{height}+{x}+{y}")
        self.window.overrideredirect(True)
        # Всегда topmost — базовое поведение для оверлея
        self.window.attributes("-topmost", True)
        self.window.attributes("-alpha", self._alpha)
        self.window.configure(bg=COLOR_BG)
        self._hwnd: Optional[int] = None
        self._is_topmost = True

        # Главный контейнер с границей
        self.outer = tk.Frame(self.window, bg=COLOR_BORDER, bd=1)
        self.outer.pack(fill=tk.BOTH, expand=True)

        # Header
        self.header = tk.Frame(self.outer, bg=COLOR_BG, height=26)
        self.header.pack(fill=tk.X, padx=1, pady=(1, 0))
        self.header.pack_propagate(False)

        # Цветной индикатор слева
        self.header_indicator = tk.Frame(self.header, bg=COLOR_ACCENT, width=4)
        self.header_indicator.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 6))

        # Заголовок
        self.title_label = tk.Label(
            self.header,
            text=title,
            font=(settings.get("font_family", "Consolas"), 9, "bold"),
            fg=COLOR_ACCENT,
            bg=COLOR_BG,
        )
        self.title_label.pack(side=tk.LEFT, padx=(0, 4))

        # Кнопки управления
        self._build_control_buttons()

        # Drag area
        self.header.bind("<Button-1>", self._on_drag_start)
        self.header.bind("<B1-Motion>", self._on_drag_motion)
        self.title_label.bind("<Button-1>", self._on_drag_start)
        self.title_label.bind("<B1-Motion>", self._on_drag_motion)

        # Content
        self.content = tk.Frame(self.outer, bg=COLOR_PANEL)
        self.content.pack(fill=tk.BOTH, expand=True, padx=1, pady=1)

        # Resize handle
        self.resize_handle = tk.Frame(self.window, bg=COLOR_BORDER, width=12, height=12, cursor="size_nw_se")
        self.resize_handle.place(relx=1.0, rely=1.0, anchor="se")
        self.resize_handle.bind("<Button-1>", self._on_resize_start)
        self.resize_handle.bind("<B1-Motion>", self._on_resize_motion)

        self._on_move_callback: Optional[Callable] = None
        self._on_resize_callback: Optional[Callable] = None

        self._apply_anchor()

    def _build_control_buttons(self):
        btn_frame = tk.Frame(self.header, bg=COLOR_BG)
        btn_frame.pack(side=tk.RIGHT, padx=(0, 4))

        lock_text = "L" if self._locked else "U"
        self.lock_btn = tk.Label(
            btn_frame, text=lock_text,
            font=("Consolas", 8), fg=COLOR_TEXT_MUTED, bg=COLOR_BG,
            cursor="hand2", width=2
        )
        self.lock_btn.pack(side=tk.LEFT, padx=(0, 4))
        self.lock_btn.bind("<Button-1>", lambda e: self._toggle_lock())

        self.edit_btn = tk.Label(
            btn_frame, text="*",
            font=("Consolas", 10), fg=COLOR_TEXT_MUTED, bg=COLOR_BG,
            cursor="hand2", width=2
        )
        self.edit_btn.pack(side=tk.LEFT, padx=(0, 4))
        self.edit_btn.bind("<Button-1>", lambda e: self._show_edit_menu())

        self.drag_label = tk.Label(
            btn_frame, text="=",
            font=("Consolas", 10), fg=COLOR_TEXT_MUTED, bg=COLOR_BG,
            cursor="fleur" if not self._locked else "no",
            width=2
        )
        self.drag_label.pack(side=tk.LEFT)
        if not self._locked:
            self.drag_label.bind("<Button-1>", self._on_drag_start)
            self.drag_label.bind("<B1-Motion>", self._on_drag_motion)

    def _toggle_lock(self):
        self._locked = not self._locked
        self.settings[f"{self.overlay_key}_locked"] = self._locked
        lock_text = "L" if self._locked else "U"
        self.lock_btn.config(text=lock_text)
        cursor = "no" if self._locked else "fleur"
        self.drag_label.config(cursor=cursor)
        if self._locked:
            self.drag_label.unbind("<Button-1>")
            self.drag_label.unbind("<B1-Motion>")
        else:
            self.drag_label.bind("<Button-1>", self._on_drag_start)
            self.drag_label.bind("<B1-Motion>", self._on_drag_motion)
        self._flash_indicator(COLOR_GREEN_TEXT if self._locked else COLOR_ACCENT)

    def _flash_indicator(self, color: str, duration_ms: int = 300):
        self.header_indicator.config(bg=color)
        self.window.after(duration_ms, lambda: self.header_indicator.config(bg=COLOR_ACCENT))

    def _show_edit_menu(self):
        menu = tk.Menu(self.window, tearoff=0, bg=COLOR_PANEL, fg=COLOR_TEXT,
                       activebackground=COLOR_PANEL_HOVER, activeforeground=COLOR_ACCENT,
                       borderwidth=1, relief="solid")

        anchor_menu = tk.Menu(menu, tearoff=0, bg=COLOR_PANEL, fg=COLOR_TEXT,
                              activebackground=COLOR_PANEL_HOVER, activeforeground=COLOR_ACCENT)
        for pos in ["custom", "top_left", "top_center", "top_right",
                    "mid_left", "mid_right", "bottom_left", "bottom_center", "bottom_right"]:
            label = {
                "custom": "Custom",
                "top_left": "Top Left", "top_center": "Top Center", "top_right": "Top Right",
                "mid_left": "Mid Left", "mid_right": "Mid Right",
                "bottom_left": "Bottom Left", "bottom_center": "Bottom Center", "bottom_right": "Bottom Right",
            }.get(pos, pos)
            anchor_menu.add_command(
                label=f"{'[x] ' if self._anchor == pos else '[ ] '}{label}",
                command=lambda p=pos: self._set_anchor(p)
            )
        menu.add_cascade(label="Anchor", menu=anchor_menu)
        menu.add_separator()
        menu.add_command(label=f"Width: {self.window.winfo_width()}px", state="disabled")
        menu.add_command(label=f"Height: {self.window.winfo_height()}px", state="disabled")
        menu.add_command(label="Reset size", command=self._reset_size)
        menu.add_separator()
        alpha_menu = tk.Menu(menu, tearoff=0, bg=COLOR_PANEL, fg=COLOR_TEXT,
                             activebackground=COLOR_PANEL_HOVER, activeforeground=COLOR_ACCENT)
        for a in [0.3, 0.5, 0.7, 0.85, 0.95, 1.0]:
            alpha_menu.add_command(
                label=f"{'[x] ' if abs(self._alpha - a) < 0.05 else '[ ] '}{int(a*100)}%",
                command=lambda v=a: self.set_alpha(v)
            )
        menu.add_cascade(label="Alpha", menu=alpha_menu)
        menu.post(self.edit_btn.winfo_rootx(), self.edit_btn.winfo_rooty() + 20)

    def _set_anchor(self, position: str):
        self._anchor = position
        self.settings[f"{self.overlay_key}_anchor"] = position
        self._apply_anchor()
        self._flash_indicator(COLOR_CYAN)

    def _apply_anchor(self):
        if self._anchor == "custom" or not self._anchor:
            return
        self.master.update_idletasks()
        screen_w = self.master.winfo_screenwidth()
        screen_h = self.master.winfo_screenheight()
        pos = self.ANCHOR_POSITIONS.get(self._anchor)
        if pos is None:
            return
        if callable(pos):
            x, y = pos(screen_w, screen_h)
        else:
            x, y = pos
        self.window.geometry(f"+{x}+{y}")
        if self._on_move_callback:
            self._on_move_callback(x, y)

    def _reset_size(self):
        defaults = {
            "route": (280, 160),
            "status": (280, 220),
            "ship": (360, 540),
            "cargo": (300, 340),
            "session": (320, 300),
        }
        default = defaults.get(self.overlay_key, (280, 200))
        self.window.geometry(f"{default[0]}x{default[1]}+{self.window.winfo_x()}+{self.window.winfo_y()}")
        self.settings[f"{self.overlay_key}_width"] = default[0]
        self.settings[f"{self.overlay_key}_height"] = default[1]

    def set_on_move(self, callback: Callable):
        self._on_move_callback = callback

    def set_on_resize(self, callback: Callable):
        self._on_resize_callback = callback

    def _on_drag_start(self, event):
        if self._locked:
            return
        self._drag_data["x"] = event.x_root - self.window.winfo_x()
        self._drag_data["y"] = event.y_root - self.window.winfo_y()

    def _on_drag_motion(self, event):
        if self._locked:
            return
        x = event.x_root - self._drag_data["x"]
        y = event.y_root - self._drag_data["y"]
        self.window.geometry(f"+{x}+{y}")
        if self._anchor != "custom":
            self._anchor = "custom"
            self.settings[f"{self.overlay_key}_anchor"] = "custom"
        if self._on_move_callback:
            self._on_move_callback(x, y)

    def _on_resize_start(self, event):
        if self._locked:
            return
        self._resize_data["x"] = event.x_root
        self._resize_data["y"] = event.y_root
        self._resize_data["w"] = self.window.winfo_width()
        self._resize_data["h"] = self.window.winfo_height()

    def _on_resize_motion(self, event):
        if self._locked:
            return
        dx = event.x_root - self._resize_data["x"]
        dy = event.y_root - self._resize_data["y"]
        new_w = max(self._min_width, self._resize_data["w"] + dx)
        new_h = max(self._min_height, self._resize_data["h"] + dy)
        self.window.geometry(f"{new_w}x{new_h}")
        self.settings[f"{self.overlay_key}_width"] = new_w
        self.settings[f"{self.overlay_key}_height"] = new_h
        if self._on_resize_callback:
            self._on_resize_callback(new_w, new_h)

    def set_alpha(self, alpha: float):
        self._alpha = alpha
        self.settings["alpha"] = alpha
        self.window.attributes("-alpha", alpha)

    def set_topmost(self, topmost: bool):
        """Установить/снять topmost через tkinter (безопасно для overrideredirect)."""
        if self._is_topmost == topmost:
            return
        self._is_topmost = topmost
        self.window.attributes("-topmost", topmost)

    def show(self):
        self.window.deiconify()

    def hide(self):
        self.window.withdraw()

    def toggle(self):
        if self.window.winfo_viewable():
            self.hide()
        else:
            self.show()

    def destroy(self):
        self.window.destroy()


# ============================================================
#  RouteOverlay
# ============================================================
class RouteOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "ROUTE",
            settings.get("route_x", 50), settings.get("route_y", 50),
            settings.get("route_width", 280), settings.get("route_height", 160),
            settings, "route",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)

        self.progress_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.progress_frame.pack(fill=tk.X, pady=(4, 6))
        self.progress_bg = tk.Frame(self.progress_frame, bg=COLOR_LINE, height=6)
        self.progress_bg.pack(fill=tk.X)
        self.progress_fill = tk.Frame(self.progress_bg, bg=COLOR_ACCENT, height=6, width=0)
        self.progress_fill.place(x=0, y=0)

        tk.Label(self.content, text="CURRENT", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(anchor=tk.W)
        self.current_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.current_frame.pack(fill=tk.X, pady=(2, 0))
        self.current_dot = tk.Label(self.current_frame, text=">", font=(ff, 8), fg=COLOR_ACCENT, bg=COLOR_PANEL)
        self.current_dot.pack(side=tk.LEFT)
        self.current_label = tk.Label(self.current_frame, text="-", font=(ff, fs + 1, "bold"), fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W)
        self.current_label.pack(side=tk.LEFT, padx=(4, 0))

        tk.Label(self.content, text="NEXT", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(anchor=tk.W, pady=(6, 0))
        self.next_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.next_frame.pack(fill=tk.X, pady=(2, 0))
        self.next_dot = tk.Label(self.next_frame, text=">", font=(ff, 8), fg=COLOR_CYAN, bg=COLOR_PANEL)
        self.next_dot.pack(side=tk.LEFT)
        self.next_label = tk.Label(self.next_frame, text="-", font=(ff, fs), fg=COLOR_CYAN, bg=COLOR_PANEL, anchor=tk.W)
        self.next_label.pack(side=tk.LEFT, padx=(4, 0))

        self.stats_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.stats_frame.pack(fill=tk.X, pady=(6, 0))
        self.progress_label = tk.Label(self.stats_frame, text="0 / 0", font=(ff, fs - 1, "bold"), fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W)
        self.progress_label.pack(side=tk.LEFT)
        self.remaining_label = tk.Label(self.stats_frame, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.E)
        self.remaining_label.pack(side=tk.RIGHT)

        self.remaining_list = tk.Label(self.content, text="", font=(ff, fs - 3), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W, wraplength=260)
        self.remaining_list.pack(fill=tk.X, pady=(2, 0))

    def update_route(self, current: str, next_system: str, visited: int, total: int, remaining: Optional[list] = None):
        self.current_label.config(text=current[:30])
        self.next_label.config(text=next_system[:30])
        self.progress_label.config(text=f"{visited} / {total}")
        if total > 0:
            pct = visited / total
            bar_width = int(260 * pct)
            self.progress_fill.config(width=bar_width)
            self.progress_fill.config(bg=COLOR_GREEN_TEXT if pct >= 1.0 else COLOR_ACCENT)
        remaining_count = total - visited
        self.remaining_label.config(text=f"Left: {remaining_count}")
        if remaining and len(remaining) <= 4:
            text = " -> ".join(remaining[:4])
        elif remaining:
            text = " -> ".join(remaining[:4]) + f" ... (+{len(remaining) - 4})"
        else:
            text = ""
        self.remaining_list.config(text=text)


# ============================================================
#  StatusOverlay
# ============================================================
class StatusOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "STATUS",
            settings.get("status_x", 50), settings.get("status_y", 220),
            settings.get("status_width", 280), settings.get("status_height", 220),
            settings, "status",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)

        self.status_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.status_frame.pack(fill=tk.X, pady=(4, 0))
        self.status_dot = tk.Label(self.status_frame, text="*", font=(ff, 12), fg=COLOR_RED, bg=COLOR_PANEL)
        self.status_dot.pack(side=tk.LEFT, padx=(0, 6))
        self.status_text = tk.Label(self.status_frame, text="Offline", font=(ff, fs, "bold"), fg=COLOR_RED_TEXT, bg=COLOR_PANEL, anchor=tk.W)
        self.status_text.pack(side=tk.LEFT)

        self.watcher_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.watcher_frame.pack(fill=tk.X, pady=(4, 0))
        self.watcher_dot = tk.Label(self.watcher_frame, text="o", font=(ff, 10), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.watcher_dot.pack(side=tk.LEFT, padx=(0, 6))
        self.watcher_text = tk.Label(self.watcher_frame, text="Watcher: off", font=(ff, fs - 1), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.watcher_text.pack(side=tk.LEFT)

        self.progress_text = tk.Label(self.content, text="", font=(ff, fs - 1), fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W)
        self.progress_text.pack(fill=tk.X, pady=(4, 0))

        _make_separator(self.content).pack(fill=tk.X, pady=6)
        tk.Label(self.content, text="EVENT LOG", font=(ff, fs - 2, "bold"), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(anchor=tk.W)

        self.log_text = tk.Text(
            self.content, height=6, font=(ff, fs - 2), fg=COLOR_TEXT, bg=COLOR_BG,
            wrap=tk.WORD, state=tk.DISABLED, highlightthickness=0, borderwidth=0, padx=6, pady=4,
        )
        self.log_text.pack(fill=tk.BOTH, expand=True, pady=(4, 0))

    def set_status(self, online: bool, detail: str = ""):
        if online:
            self.status_dot.config(fg=COLOR_GREEN_TEXT)
            self.status_text.config(text=f"Online  {detail}", fg=COLOR_GREEN_TEXT)
        else:
            self.status_dot.config(fg=COLOR_RED_TEXT)
            self.status_text.config(text="Offline", fg=COLOR_RED_TEXT)

    def set_watcher(self, active: bool):
        self.watcher_dot.config(fg=COLOR_GREEN_TEXT if active else COLOR_TEXT_MUTED, text="*" if active else "o")
        self.watcher_text.config(text="Watcher: ON" if active else "Watcher: off", fg=COLOR_GREEN_TEXT if active else COLOR_TEXT_MUTED)

    def set_progress(self, text: str):
        self.progress_text.config(text=text)

    def add_log(self, message: str, level: str = "info"):
        color = {"success": COLOR_GREEN_TEXT, "error": COLOR_RED_TEXT, "warn": COLOR_YELLOW, "info": COLOR_TEXT}.get(level, COLOR_TEXT)
        timestamp = time.strftime("%H:%M:%S")
        self.log_text.config(state=tk.NORMAL)
        self.log_text.insert(tk.END, f"[{timestamp}] ")
        tag_name = f"log_{level}_{int(time.time()*1000)%10000}"
        start_idx = self.log_text.index("end-1c linestart")
        self.log_text.insert(tk.END, f"{message}\n")
        end_idx = self.log_text.index("end-2c")
        self.log_text.tag_add(tag_name, start_idx, end_idx)
        self.log_text.tag_config(tag_name, foreground=color)
        self.log_text.see(tk.END)
        lines = int(self.log_text.index("end-1c").split(".")[0])
        if lines > 60:
            self.log_text.delete("1.0", "7.0")
        self.log_text.config(state=tk.DISABLED)


# ============================================================
#  ShipOverlay
# ============================================================
class ShipOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        h = max(settings.get("ship_height", 540), 540)
        super().__init__(
            master, "SHIP",
            settings.get("ship_x", 50), settings.get("ship_y", 440),
            settings.get("ship_width", 360), h,
            settings, "ship",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)
        s = settings

        self.ship_header = tk.Frame(self.content, bg=COLOR_PANEL)
        self.ship_header.pack(fill=tk.X, pady=(4, 0))
        self.ship_icon = tk.Label(self.ship_header, text="[+]", font=(ff, 10), fg=COLOR_ACCENT, bg=COLOR_PANEL)
        self.ship_icon.pack(side=tk.LEFT, padx=(0, 6))
        self.ship_name_label = tk.Label(self.ship_header, text="Unknown", font=(ff, fs + 1, "bold"), fg=COLOR_ACCENT, bg=COLOR_PANEL)
        self.ship_name_label.pack(side=tk.LEFT)

        self.flags_label = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_CYAN, bg=COLOR_PANEL, anchor=tk.W)
        self.flags_label.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_flags", True):
            self.flags_label.pack_forget()

        self.pips_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.pips_frame.pack(fill=tk.X, pady=(4, 0))
        self.pips_sys = self._make_pip_bar(self.pips_frame, "SYS", COLOR_CYAN, ff, fs)
        self.pips_eng = self._make_pip_bar(self.pips_frame, "ENG", COLOR_ACCENT, ff, fs)
        self.pips_wep = self._make_pip_bar(self.pips_frame, "WEP", COLOR_RED_TEXT, ff, fs)
        if not s.get("show_pips", True):
            self.pips_frame.pack_forget()

        _make_separator(self.content).pack(fill=tk.X, pady=4)

        self.hull_frame = self._make_stat_bar("HULL", COLOR_GREEN_TEXT)
        self.hull_frame.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_hull", True):
            self.hull_frame.pack_forget()

        self.shield_frame = self._make_stat_bar("SHIELD", COLOR_CYAN)
        self.shield_frame.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_shield", True):
            self.shield_frame.pack_forget()

        self.fuel_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.fuel_frame.pack(fill=tk.X, pady=(2, 0))
        tk.Label(self.fuel_frame, text="FUEL", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, width=10, anchor=tk.W).pack(side=tk.LEFT)
        self.fuel_text = tk.Label(self.fuel_frame, text="0.00 / 0.00", font=(ff, fs - 1), fg=COLOR_TEXT, bg=COLOR_PANEL)
        self.fuel_text.pack(side=tk.LEFT, padx=(6, 0))
        self.fuel_res_text = tk.Label(self.fuel_frame, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.fuel_res_text.pack(side=tk.RIGHT)
        if not s.get("show_fuel", True):
            self.fuel_frame.pack_forget()

        self.power_frame = self._make_stat_bar("POWER", COLOR_YELLOW)
        self.power_frame.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_power", True):
            self.power_frame.pack_forget()

        self.info_frame = tk.Frame(self.content, bg=COLOR_PANEL)
        self.info_frame.pack(fill=tk.X, pady=(4, 0))
        self.cargo_text = tk.Label(self.info_frame, text="Cargo: 0 / 0 t", font=(ff, fs - 1), fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W)
        self.cargo_text.pack(side=tk.LEFT)
        self.balance_text = tk.Label(self.info_frame, text="", font=(ff, fs - 1), fg=COLOR_GREEN_TEXT, bg=COLOR_PANEL, anchor=tk.E)
        self.balance_text.pack(side=tk.RIGHT)
        if not s.get("show_cargo_info", True):
            self.cargo_text.pack_forget()
        if not s.get("show_balance", True):
            self.balance_text.pack_forget()
        if not s.get("show_cargo_info", True) and not s.get("show_balance", True):
            self.info_frame.pack_forget()

        self.legal_text = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.legal_text.pack(fill=tk.X, pady=(2, 0))
        if not s.get("show_legal", True):
            self.legal_text.pack_forget()

        self.dest_text = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.dest_text.pack(fill=tk.X, pady=(0, 2))
        if not s.get("show_destination", True):
            self.dest_text.pack_forget()

        _make_separator(self.content).pack(fill=tk.X, pady=4)

        self.mod_header = tk.Frame(self.content, bg=COLOR_PANEL)
        self.mod_header.pack(fill=tk.X)
        tk.Label(self.mod_header, text="MODULES", font=(ff, fs - 2, "bold"), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(side=tk.LEFT)
        self.mod_count_text = tk.Label(self.mod_header, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.mod_count_text.pack(side=tk.RIGHT)

        self.modules_canvas = tk.Canvas(self.content, bg=COLOR_PANEL, highlightthickness=0, height=260)
        self.modules_canvas.pack(fill=tk.BOTH, expand=True, pady=(2, 0))

        scrollbar = tk.Scrollbar(self.content, orient=tk.VERTICAL, command=self.modules_canvas.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.modules_canvas.configure(yscrollcommand=scrollbar.set)

        self.modules_inner = tk.Frame(self.modules_canvas, bg=COLOR_PANEL)
        self.modules_canvas.create_window((0, 0), window=self.modules_inner, anchor=tk.NW, width=330)
        self.modules_inner.bind("<Configure>", lambda e: self.modules_canvas.configure(scrollregion=self.modules_canvas.bbox("all")))

        self.damage_counter = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W)
        self.damage_counter.pack(fill=tk.X, pady=(2, 0))

        # Кэш виджетов модулей: slot -> widget dict
        self._module_widgets: Dict[str, dict] = {}
        self._last_modules_hash = ""

        if not s.get("show_modules", True):
            self.mod_header.pack_forget()
            self.modules_canvas.pack_forget()
            scrollbar.pack_forget()
            self.damage_counter.pack_forget()

    def _make_pip_bar(self, parent, name, color, ff, fs):
        frame = tk.Frame(parent, bg=COLOR_PANEL)
        frame.pack(side=tk.LEFT, padx=(0, 10))
        tk.Label(frame, text=name, font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL).pack(side=tk.LEFT)
        bar_frame = tk.Frame(frame, bg=COLOR_LINE, width=60, height=10)
        bar_frame.pack(side=tk.LEFT, padx=(4, 0))
        bar_frame.pack_propagate(False)
        fill = tk.Frame(bar_frame, bg=color, width=0, height=10)
        fill.place(x=0, y=0)
        lbl = tk.Label(frame, text="0/8", font=(ff, fs - 2), fg=color, bg=COLOR_PANEL, width=3)
        lbl.pack(side=tk.LEFT, padx=(4, 0))
        lbl._fill = fill
        lbl._bar_frame = bar_frame
        return lbl

    def _make_stat_bar(self, label, color):
        ff = self.settings.get("font_family", "Consolas")
        fs = self.settings.get("font_size", 10)
        frame = tk.Frame(self.content, bg=COLOR_PANEL)
        tk.Label(frame, text=label, font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, width=10, anchor=tk.W).pack(side=tk.LEFT)
        bar_bg = tk.Frame(frame, bg=COLOR_LINE, height=12, width=120)
        bar_bg.pack(side=tk.LEFT, padx=(6, 0))
        bar_bg.pack_propagate(False)
        bar_fill = tk.Frame(bar_bg, bg=color, height=12, width=0)
        bar_fill.place(x=0, y=0)
        bar_text = tk.Label(frame, text="100%", font=(ff, fs - 1, "bold"), fg=color, bg=COLOR_PANEL)
        bar_text.pack(side=tk.RIGHT)
        frame._bar_fill = bar_fill
        frame._bar_text = bar_text
        frame._bar_bg = bar_bg
        return frame

    def _health_color(self, percent: int) -> str:
        if percent >= 80:
            return COLOR_GREEN_TEXT
        elif percent >= 50:
            return COLOR_YELLOW
        else:
            return COLOR_RED_TEXT

    def _modules_hash(self, modules: list) -> str:
        """Быстрый хеш списка модулей для сравнения."""
        parts = []
        for m in sorted(modules, key=lambda x: x.get("slot", "")):
            parts.append(f"{m.get('slot')}:{m.get('health',100)}:{m.get('power',0):.3f}")
        return "|".join(parts)

    def update_ship(self, data: dict):
        ship_type = data.get("ship_type", "Unknown")
        ship_name = data.get("ship_name", "")
        ident = data.get("ship_ident", "")
        display = f"{ship_type}"
        if ship_name:
            display += f"  '{ship_name}'"
        if ident:
            display += f"  [{ident}]"
        self.ship_name_label.config(text=display[:42])

        flags = data.get("flags_list", [])
        important = [f for f in flags if f in ("Supercruise", "Hardpoints", "MassLock", "FsdCharging", "FsdCooldown", "LowFuel", "Overheat", "Danger", "Interdicted", "Scooping", "FsdJump", "FsdHyper", "FsdTransit")]
        self.flags_label.config(text="  ".join(important) if important else "")

        for pips_label, pips_key in [(self.pips_sys, "pips_sys"), (self.pips_eng, "pips_eng"), (self.pips_wep, "pips_wep")]:
            pips = data.get(pips_key, 0)
            pips_label.config(text=f"{pips}/8")
            if hasattr(pips_label, '_fill'):
                fill_width = int((pips / 8) * 60)
                pips_label._fill.config(width=fill_width)

        hull = data.get("hull_percent", 100)
        hull_color = self._health_color(hull)
        if hasattr(self.hull_frame, '_bar_fill'):
            fill_w = int((hull / 100) * 120)
            self.hull_frame._bar_fill.config(width=fill_w, bg=hull_color)
            self.hull_frame._bar_text.config(text=f"{hull}%", fg=hull_color)

        shield = data.get("shield_percent", 100)
        has_shield_gen = any("shieldgenerator" in m.get("name", "").lower() for m in data.get("modules", []))
        if not has_shield_gen and shield == 100:
            if hasattr(self.shield_frame, '_bar_fill'):
                self.shield_frame._bar_fill.config(width=0)
                self.shield_frame._bar_text.config(text="NO", fg=COLOR_TEXT_MUTED)
        else:
            shield_color = self._health_color(shield)
            if hasattr(self.shield_frame, '_bar_fill'):
                fill_w = int((shield / 100) * 120)
                self.shield_frame._bar_fill.config(width=fill_w, bg=shield_color)
                self.shield_frame._bar_text.config(text=f"{shield}%", fg=shield_color)

        fuel_lvl = data.get("fuel_level", 0)
        fuel_cap = data.get("fuel_capacity", 0)
        fuel_res = data.get("fuel_reservoir", 0)
        self.fuel_text.config(text=f"{fuel_lvl:.2f} / {fuel_cap:.2f} t")
        self.fuel_res_text.config(text=f"Res: {fuel_res:.3f} t" if fuel_res > 0 else "")

        power_used = data.get("power_used", 0)
        power_cap = data.get("power_capacity", 0)
        power_pct = data.get("power_percent", 0)
        if power_cap > 0:
            pcolor = COLOR_GREEN_TEXT if power_pct < 80 else (COLOR_YELLOW if power_pct < 100 else COLOR_RED_TEXT)
            if hasattr(self.power_frame, '_bar_fill'):
                fill_w = int((min(power_pct, 100) / 100) * 120)
                self.power_frame._bar_fill.config(width=fill_w, bg=pcolor)
                self.power_frame._bar_text.config(text=f"{power_used:.2f} / {power_cap:.2f} MW ({power_pct}%)", fg=pcolor)
        elif power_used > 0:
            if hasattr(self.power_frame, '_bar_fill'):
                self.power_frame._bar_fill.config(width=0)
                self.power_frame._bar_text.config(text=f"{power_used:.2f} MW (no gen data)", fg=COLOR_YELLOW)
        else:
            if hasattr(self.power_frame, '_bar_fill'):
                self.power_frame._bar_fill.config(width=0)
                self.power_frame._bar_text.config(text="-", fg=COLOR_TEXT_MUTED)

        cargo = data.get("cargo_count", 0)
        cargo_cap = data.get("cargo_capacity", 0)
        self.cargo_text.config(text=f"Cargo: {cargo} / {cargo_cap} t")

        balance = data.get("balance", 0)
        self.balance_text.config(text=f"{balance:,} CR".replace(",", " ") if balance > 0 else "")

        legal = data.get("legal_state", "Clean")
        lcolor = COLOR_GREEN_TEXT if legal == "Clean" else COLOR_RED_TEXT
        self.legal_text.config(text=f"Legal: {legal}", fg=lcolor)

        dest = data.get("destination_name", "")
        self.dest_text.config(text=f"-> {dest}" if dest else "")

        modules = data.get("modules", [])
        show_modules = sorted(modules, key=lambda m: (m.get("health", 100), -m.get("power", 0)))

        # Проверяем, изменился ли список модулей (health/power)
        current_hash = self._modules_hash(show_modules)
        if current_hash != self._last_modules_hash:
            self._last_modules_hash = current_hash
            self._update_module_widgets(show_modules)

        self.mod_count_text.config(text=f"{len(modules)} mod." if modules else "")

        damaged_count = data.get("damaged_count", 0)
        critical_count = data.get("critical_count", 0)
        if damaged_count > 0:
            color = COLOR_RED_TEXT if critical_count > 0 else COLOR_YELLOW
            self.damage_counter.config(text=f"! Damaged: {damaged_count}  Critical: {critical_count}", fg=color)
        else:
            self.damage_counter.config(text="OK All modules functional", fg=COLOR_GREEN_TEXT)

    def _update_module_widgets(self, show_modules: list):
        """Обновить виджеты модулей: переиспользуем существующие, создаём новые, удаляем лишние."""
        ff = self.settings.get("font_family", "Consolas")
        fs = self.settings.get("font_size", 10)
        needed_slots = set()

        for m in show_modules:
            slot = m.get("slot", "")
            if not slot:
                continue
            needed_slots.add(slot)
            hp = m.get("health", 100)
            color = self._health_color(hp)
            power = m.get("power", 0)

            if slot in self._module_widgets:
                # Обновляем существующий виджет
                widgets = self._module_widgets[slot]
                widgets["bar_fill"].config(width=int((hp / 100) * 30), bg=color)
                widgets["name_label"].config(text=m['name'].replace("int_", "").replace("hpt_", "")[:20], fg=color)
                widgets["hp_label"].config(text=f"{hp:3}%", fg=color)
                if power > 0:
                    widgets["power_label"].config(text=f"{power:.2f}MW")
            else:
                # Создаём новый виджет
                row = tk.Frame(self.modules_inner, bg=COLOR_PANEL)
                row.pack(fill=tk.X, pady=1)
                bar_bg = tk.Frame(row, bg=COLOR_LINE, width=30, height=8)
                bar_bg.pack(side=tk.LEFT, padx=(0, 6))
                bar_bg.pack_propagate(False)
                fill_w = int((hp / 100) * 30)
                bar_fill = tk.Frame(bar_bg, bg=color, width=fill_w, height=8)
                bar_fill.place(x=0, y=0)
                name_text = m['name'].replace("int_", "").replace("hpt_", "")[:20]
                name_label = tk.Label(row, text=name_text, font=(ff, fs - 2), fg=color, bg=COLOR_PANEL, anchor=tk.W, width=18)
                name_label.pack(side=tk.LEFT)
                hp_label = tk.Label(row, text=f"{hp:3}%", font=(ff, fs - 2), fg=color, bg=COLOR_PANEL, anchor=tk.E, width=4)
                hp_label.pack(side=tk.LEFT)
                power_label = tk.Label(row, text=f"{power:.2f}MW" if power > 0 else "", font=(ff, fs - 3), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.E, width=6)
                power_label.pack(side=tk.RIGHT)
                self._module_widgets[slot] = {
                    "row": row,
                    "bar_fill": bar_fill,
                    "name_label": name_label,
                    "hp_label": hp_label,
                    "power_label": power_label,
                }

        # Удаляем виджеты для модулей, которых больше нет
        for slot in list(self._module_widgets.keys()):
            if slot not in needed_slots:
                widgets = self._module_widgets.pop(slot)
                widgets["row"].destroy()

        self.modules_inner.update_idletasks()
        self.modules_canvas.configure(scrollregion=self.modules_canvas.bbox("all"))


# ============================================================
#  CargoOverlay
# ============================================================
class CargoOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "CARGO",
            settings.get("cargo_x", 50), settings.get("cargo_y", 980),
            settings.get("cargo_width", 300), settings.get("cargo_height", 340),
            settings, "cargo",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)

        header = tk.Frame(self.content, bg=COLOR_PANEL)
        header.pack(fill=tk.X, pady=(4, 0))
        self.total_label = tk.Label(header, text="0 / 0 t", font=(ff, fs + 1, "bold"), fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W)
        self.total_label.pack(side=tk.LEFT)
        self.fill_pct = tk.Label(header, text="0%", font=(ff, fs - 1), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.E)
        self.fill_pct.pack(side=tk.RIGHT)

        self.cargo_bar_bg = tk.Frame(self.content, bg=COLOR_LINE, height=6)
        self.cargo_bar_bg.pack(fill=tk.X, pady=(4, 6))
        self.cargo_bar_fill = tk.Frame(self.cargo_bar_bg, bg=COLOR_ACCENT, height=6, width=0)
        self.cargo_bar_fill.place(x=0, y=0)

        _make_separator(self.content).pack(fill=tk.X, pady=2)

        self.cargo_canvas = tk.Canvas(self.content, bg=COLOR_PANEL, highlightthickness=0, height=240)
        self.cargo_canvas.pack(fill=tk.BOTH, expand=True)

        scrollbar = tk.Scrollbar(self.content, orient=tk.VERTICAL, command=self.cargo_canvas.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.cargo_canvas.configure(yscrollcommand=scrollbar.set)

        self.cargo_inner = tk.Frame(self.cargo_canvas, bg=COLOR_PANEL)
        self.cargo_canvas.create_window((0, 0), window=self.cargo_inner, anchor=tk.NW, width=270)
        self.cargo_inner.bind("<Configure>", lambda e: self.cargo_canvas.configure(scrollregion=self.cargo_canvas.bbox("all")))

        self.empty_label = tk.Label(self.cargo_inner, text="[ Empty hold ]", font=(ff, fs), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL)
        self.empty_label.pack(pady=30)

    def update_cargo(self, data: dict):
        total = data.get("cargo_count", 0)
        capacity = data.get("cargo_capacity", 0)
        self.total_label.config(text=f"{total} / {capacity} t")

        pct = int((total / capacity * 100)) if capacity > 0 else 0
        self.fill_pct.config(text=f"{pct}%")

        bar_width = int((pct / 100) * 270) if capacity > 0 else 0
        self.cargo_bar_fill.config(width=bar_width)
        self.cargo_bar_fill.config(bg=COLOR_GREEN_TEXT if pct < 80 else (COLOR_YELLOW if pct < 100 else COLOR_RED_TEXT))

        inventory = data.get("inventory", [])
        for widget in self.cargo_inner.winfo_children():
            widget.destroy()

        if not inventory:
            self.empty_label = tk.Label(
                self.cargo_inner, text="[ Empty hold ]",
                font=(self.settings.get("font_family", "Consolas"), self.settings.get("font_size", 10)),
                fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL,
            )
            self.empty_label.pack(pady=30)
        else:
            ff = self.settings.get("font_family", "Consolas")
            fs = self.settings.get("font_size", 10)
            for item in inventory:
                name = item.get("Name_Localised") or item.get("Name", "Unknown")
                count = item.get("Count", 0)
                stolen = item.get("Stolen", 0)

                row = tk.Frame(self.cargo_inner, bg=COLOR_PANEL)
                row.pack(fill=tk.X, pady=2)

                icon = "!" if stolen > 0 else "-"
                icon_color = COLOR_RED_TEXT if stolen > 0 else COLOR_ACCENT

                tk.Label(row, text=icon, font=(ff, 8), fg=icon_color, bg=COLOR_PANEL, width=2).pack(side=tk.LEFT)
                tk.Label(row, text=f"{name[:22]}", font=(ff, fs - 1), fg=COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.W, width=22).pack(side=tk.LEFT)

                count_text = f"{count:>4}"
                if stolen > 0:
                    count_text += f" ({stolen} stl)"

                tk.Label(row, text=count_text, font=(ff, fs - 1, "bold"), fg=COLOR_ACCENT if stolen > 0 else COLOR_TEXT, bg=COLOR_PANEL, anchor=tk.E).pack(side=tk.RIGHT)

        self.cargo_inner.update_idletasks()
        self.cargo_canvas.configure(scrollregion=self.cargo_canvas.bbox("all"))


# ============================================================
#  SessionOverlay — статистика сессии с графиком
# ============================================================
class SessionOverlay(OverlayWindow):
    def __init__(self, master: tk.Tk, settings: Dict[str, Any]):
        super().__init__(
            master, "SESSION",
            settings.get("session_x", 400), settings.get("session_y", 50),
            settings.get("session_width", 320), settings.get("session_height", 300),
            settings, "session",
        )
        ff = settings.get("font_family", "Consolas")
        fs = settings.get("font_size", 10)

        self.session_header = tk.Label(self.content, text="SESSION STATS", font=(ff, fs, "bold"), fg=COLOR_ACCENT, bg=COLOR_PANEL, anchor=tk.W)
        self.session_header.pack(fill=tk.X, pady=(4, 0))

        _make_separator(self.content).pack(fill=tk.X, pady=4)

        self.stats_grid = tk.Frame(self.content, bg=COLOR_PANEL)
        self.stats_grid.pack(fill=tk.X, pady=(0, 4))

        self.systems_label = self._make_stat_row(self.stats_grid, "Systems:", "0", COLOR_CYAN)
        self.deliveries_label = self._make_stat_row(self.stats_grid, "Deliveries:", "0", COLOR_GREEN_TEXT)
        self.cargo_label = self._make_stat_row(self.stats_grid, "Cargo (t):", "0", COLOR_ACCENT)
        self.route_cargo_label = self._make_stat_row(self.stats_grid, "Route (t):", "0", COLOR_YELLOW)
        self.time_label = self._make_stat_row(self.stats_grid, "Time:", "00:00", COLOR_TEXT_MUTED)

        self.route_system_label = tk.Label(self.content, text="", font=(ff, fs - 1), fg=COLOR_YELLOW, bg=COLOR_PANEL, anchor=tk.W)
        self.route_system_label.pack(fill=tk.X, pady=(2, 0))

        _make_separator(self.content).pack(fill=tk.X, pady=4)

        tk.Label(self.content, text="CARGO HISTORY", font=(ff, fs - 2, "bold"), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W).pack(fill=tk.X)

        self.chart_canvas = tk.Canvas(self.content, bg=COLOR_PANEL, highlightthickness=0, height=100)
        self.chart_canvas.pack(fill=tk.X, pady=(4, 0))

        self.route_info = tk.Label(self.content, text="", font=(ff, fs - 2), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, anchor=tk.W, wraplength=280)
        self.route_info.pack(fill=tk.X, pady=(4, 0))

        self.cargo_history: deque = deque(maxlen=20)
        self.jump_history: deque = deque(maxlen=20)
        self.session_start = time.time()
        self.start_system = ""
        self.current_system = ""

    def _make_stat_row(self, parent, label, value, value_color):
        ff = self.settings.get("font_family", "Consolas")
        fs = self.settings.get("font_size", 10)
        row = tk.Frame(parent, bg=COLOR_PANEL)
        row.pack(fill=tk.X, pady=1)
        tk.Label(row, text=label, font=(ff, fs - 1), fg=COLOR_TEXT_MUTED, bg=COLOR_PANEL, width=12, anchor=tk.W).pack(side=tk.LEFT)
        lbl = tk.Label(row, text=value, font=(ff, fs, "bold"), fg=value_color, bg=COLOR_PANEL, anchor=tk.E)
        lbl.pack(side=tk.RIGHT)
        return lbl

    def update_session(self, data: dict):
        systems_visited = data.get("systems_visited", 0)
        self.systems_label.config(text=str(systems_visited))

        deliveries = data.get("deliveries_count", 0)
        self.deliveries_label.config(text=str(deliveries))

        cargo_total = data.get("cargo_total_tons", 0)
        self.cargo_label.config(text=f"{cargo_total:.1f}")

        route_cargo = data.get("route_cargo_tons", 0)
        self.route_cargo_label.config(text=f"{route_cargo:.1f}")

        elapsed = int(time.time() - self.session_start)
        hours = elapsed // 3600
        mins = (elapsed % 3600) // 60
        self.time_label.config(text=f"{hours:02d}:{mins:02d}")

        last_system = data.get("last_delivery_system", "")
        if last_system:
            self.route_system_label.config(text=f"-> {last_system}")
        else:
            self.route_system_label.config(text="")

        current = data.get("current_system", "")
        if current and not self.start_system:
            self.start_system = current
        self.current_system = current

        if self.start_system and self.current_system:
            self.route_info.config(text=f">> {self.start_system}  ->  {self.current_system}")
        else:
            self.route_info.config(text="")

        cargo_count = data.get("cargo_count", 0)
        self.cargo_history.append(cargo_count)
        if current:
            self.jump_history.append(current)

        self._draw_chart()

    def _draw_chart(self):
        canvas = self.chart_canvas
        canvas.delete("all")

        history = list(self.cargo_history)
        if len(history) < 2:
            canvas.create_text(140, 50, text="Collecting data...", fill=COLOR_TEXT_MUTED, font=("Consolas", 9))
            return

        w = canvas.winfo_width() or 280
        h = canvas.winfo_height() or 100
        padding = 20

        max_val = max(history) if max(history) > 0 else 1
        min_val = 0

        for i in range(5):
            y = padding + (h - 2 * padding) * i / 4
            canvas.create_line(padding, y, w - padding, y, fill=COLOR_LINE, width=1)

        points = []
        for i, val in enumerate(history):
            x = padding + (w - 2 * padding) * i / max(len(history) - 1, 1)
            y = padding + (h - 2 * padding) * (1 - val / max_val)
            points.append((x, y))

        for i in range(len(points) - 1):
            canvas.create_line(points[i][0], points[i][1], points[i+1][0], points[i+1][1], fill=COLOR_ACCENT, width=2)

        for x, y in points:
            canvas.create_oval(x-3, y-3, x+3, y+3, fill=COLOR_ACCENT, outline=COLOR_TEXT)

        canvas.create_text(padding, h - 5, text=str(min_val), fill=COLOR_TEXT_MUTED, font=("Consolas", 7), anchor=tk.W)
        canvas.create_text(padding, padding, text=str(max_val), fill=COLOR_TEXT_MUTED, font=("Consolas", 7), anchor=tk.W)


# ============================================================
#  OverlayManager
# ============================================================
class OverlayManager:
    def __init__(self, master: tk.Tk, config_path: Path):
        self.master = master
        self.config_path = config_path
        self.settings = load_overlay_settings(config_path)
        self.route_overlay: Optional[RouteOverlay] = None
        self.status_overlay: Optional[StatusOverlay] = None
        self.ship_overlay: Optional[ShipOverlay] = None
        self.cargo_overlay: Optional[CargoOverlay] = None
        self.session_overlay: Optional[SessionOverlay] = None
        self.enabled = False
        self._update_callback: Optional[Callable] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._pending_logs: list = []
        self._log_lock = threading.Lock()
        self._session_stats = {
            "systems_visited": 0,
            "deliveries_count": 0,
            "cargo_total_tons": 0.0,
            "current_system": "",
            "cargo_count": 0,
        }

    def start(self, update_callback: Callable):
        if self.enabled:
            return
        self.enabled = True
        self._update_callback = update_callback
        self.master.after(0, self._create_windows)
        self._stop.clear()
        self._thread = threading.Thread(target=self._update_loop, daemon=True)
        self._thread.start()

    def _create_windows(self):
        self.route_overlay = RouteOverlay(self.master, self.settings)
        self.status_overlay = StatusOverlay(self.master, self.settings)
        self.ship_overlay = ShipOverlay(self.master, self.settings)
        self.cargo_overlay = CargoOverlay(self.master, self.settings)
        self.session_overlay = SessionOverlay(self.master, self.settings)

        for ov, key in [(self.route_overlay, "route"), (self.status_overlay, "status"),
                        (self.ship_overlay, "ship"), (self.cargo_overlay, "cargo"),
                        (self.session_overlay, "session")]:
            ov.set_on_move(getattr(self, f"_on_{key}_moved"))
            ov.set_on_resize(lambda w, h, k=key: self._on_resized(k, w, h))

        for ov, key in [(self.route_overlay, "show_route"), (self.status_overlay, "show_status"),
                        (self.ship_overlay, "show_ship"), (self.cargo_overlay, "show_cargo"),
                        (self.session_overlay, "show_session")]:
            if not self.settings.get(key, True):
                ov.hide()

    def _on_resized(self, key: str, w: int, h: int):
        self.settings[f"{key}_width"] = w
        self.settings[f"{key}_height"] = h

    def _on_route_moved(self, x: int, y: int):
        self.settings["route_x"] = x
        self.settings["route_y"] = y

    def _on_status_moved(self, x: int, y: int):
        self.settings["status_x"] = x
        self.settings["status_y"] = y

    def _on_ship_moved(self, x: int, y: int):
        self.settings["ship_x"] = x
        self.settings["ship_y"] = y

    def _on_cargo_moved(self, x: int, y: int):
        self.settings["cargo_x"] = x
        self.settings["cargo_y"] = y

    def _on_session_moved(self, x: int, y: int):
        self.settings["session_x"] = x
        self.settings["session_y"] = y

    def _update_loop(self):
        last_data_hash = None
        ed_active_counter = 0
        attach = self.settings.get("attach_to_game", True)
        while not self._stop.is_set():
            # Проверяем, активна ли игра — оверлей topmost только над игрой
            if attach:
                try:
                    ed_active = _is_ed_foreground()
                    if ed_active:
                        ed_active_counter = 3  # держим visible ещё 3 цикла после потери фокуса
                    elif ed_active_counter > 0:
                        ed_active_counter -= 1
                    should_show = ed_active_counter > 0
                    self.master.after(0, lambda s=should_show: self._set_all_visibility(s))
                except Exception:
                    pass
            else:
                # Режим "всегда поверх" — показываем и поднимаем
                self.master.after(0, lambda: self._set_all_visibility(True))

            if self._update_callback:
                try:
                    data = self._update_callback()
                    # Хешируем ключевые данные, чтобы не обновлять оверлей без изменений
                    current_hash = self._hash_data(data)
                    if current_hash != last_data_hash:
                        last_data_hash = current_hash
                        self.master.after(0, lambda d=data: self._apply_update(d))
                except Exception:
                    pass
            with self._log_lock:
                logs = list(self._pending_logs)
                self._pending_logs.clear()
            for msg, level in logs:
                self.master.after(0, lambda m=msg, l=level: self._add_log_safe(m, l))
            time.sleep(1.0)

    def _set_all_visibility(self, show: bool):
        """Показать/скрыть оверлеи. При показе — lift() + topmost для гарантии Z-order."""
        for ov in [self.route_overlay, self.status_overlay, self.ship_overlay, self.cargo_overlay, self.session_overlay]:
            if ov:
                try:
                    if show:
                        if not ov.window.winfo_viewable():
                            ov.show()
                        ov.window.lift()
                        ov.window.attributes("-topmost", True)
                    else:
                        ov.hide()
                except Exception:
                    pass

    def _hash_data(self, data: dict) -> str:
        """Быстрый хеш ключевых данных для сравнения изменений."""
        import hashlib
        parts = []
        ship = data.get("ship", {})
        parts.append(str(ship.get("hull_percent", 0)))
        parts.append(str(ship.get("shield_percent", 0)))
        parts.append(str(ship.get("fuel_level", 0)))
        parts.append(str(ship.get("cargo_count", 0)))
        parts.append(str(ship.get("flags", 0)))
        parts.append(str(ship.get("flags2", 0)))
        parts.append(str(ship.get("pips_sys", 0)))
        parts.append(str(ship.get("pips_eng", 0)))
        parts.append(str(ship.get("pips_wep", 0)))
        parts.append(str(ship.get("balance", 0)))
        parts.append(str(ship.get("damaged_count", 0)))
        parts.append(str(data.get("visited", 0)))
        parts.append(str(data.get("total", 0)))
        parts.append(str(data.get("online", False)))
        parts.append(str(data.get("watcher_active", False)))
        return hashlib.md5("|".join(parts).encode()).hexdigest()

    def _apply_update(self, data: dict):
        if self.route_overlay:
            self.route_overlay.update_route(
                data.get("current", "-"), data.get("next", "-"),
                data.get("visited", 0), data.get("total", 0), data.get("remaining"),
            )
        if self.status_overlay:
            self.status_overlay.set_status(data.get("online", False), data.get("status_detail", ""))
            self.status_overlay.set_watcher(data.get("watcher_active", False))
            self.status_overlay.set_progress(data.get("progress", ""))
            for msg, level in data.get("log_lines", []):
                self._add_log_safe(msg, level)
        if self.ship_overlay:
            ship_data = data.get("ship", {})
            if ship_data:
                self.ship_overlay.update_ship(ship_data)
        if self.cargo_overlay:
            cargo_data = data.get("cargo", {})
            if cargo_data:
                self.cargo_overlay.update_cargo(cargo_data)

        if self.session_overlay:
            current_sys = data.get("current", "-")
            if current_sys != "-" and current_sys != self._session_stats["current_system"]:
                self._session_stats["systems_visited"] += 1
                self._session_stats["current_system"] = current_sys

            deliveries = data.get("new_deliveries", 0)
            if deliveries:
                self._session_stats["deliveries_count"] += deliveries

            cargo_tons = data.get("cargo_total_tons", 0)
            if cargo_tons:
                self._session_stats["cargo_total_tons"] += cargo_tons

            ship = data.get("ship", {})
            self._session_stats["cargo_count"] = ship.get("cargo_count", 0)

            self.session_overlay.update_session(self._session_stats)

    def _add_log_safe(self, message: str, level: str = "info"):
        if self.status_overlay:
            self.status_overlay.add_log(message, level)

    def log(self, message: str, level: str = "info"):
        with self._log_lock:
            self._pending_logs.append((message, level))

    def stop(self):
        self.enabled = False
        self._stop.set()
        self.save_settings()
        for ov in [self.route_overlay, self.status_overlay, self.ship_overlay, self.cargo_overlay, self.session_overlay]:
            if ov:
                self.master.after(0, ov.destroy)
        self.route_overlay = None
        self.status_overlay = None
        self.ship_overlay = None
        self.cargo_overlay = None
        self.session_overlay = None

    def toggle(self, update_callback: Callable):
        if self.enabled:
            self.stop()
        else:
            self.start(update_callback)

    def toggle_visibility(self):
        for ov in [self.route_overlay, self.status_overlay, self.ship_overlay, self.cargo_overlay, self.session_overlay]:
            if ov:
                ov.toggle()

    def set_alpha(self, alpha: float):
        self.settings["alpha"] = alpha
        for ov in [self.route_overlay, self.status_overlay, self.ship_overlay, self.cargo_overlay, self.session_overlay]:
            if ov:
                ov.set_alpha(alpha)

    def set_font(self, family: str, size: int):
        self.settings["font_family"] = family
        self.settings["font_size"] = size
        was_enabled = self.enabled
        cb = self._update_callback
        self.stop()
        if was_enabled and cb:
            self.start(cb)

    def set_show_route(self, show: bool):
        self.settings["show_route"] = show
        if self.route_overlay:
            self.route_overlay.show() if show else self.route_overlay.hide()

    def set_show_status(self, show: bool):
        self.settings["show_status"] = show
        if self.status_overlay:
            self.status_overlay.show() if show else self.status_overlay.hide()

    def set_show_ship(self, show: bool):
        self.settings["show_ship"] = show
        if self.ship_overlay:
            self.ship_overlay.show() if show else self.ship_overlay.hide()

    def set_show_cargo(self, show: bool):
        self.settings["show_cargo"] = show
        if self.cargo_overlay:
            self.cargo_overlay.show() if show else self.cargo_overlay.hide()

    def set_show_session(self, show: bool):
        self.settings["show_session"] = show
        if self.session_overlay:
            self.session_overlay.show() if show else self.session_overlay.hide()

    def set_ship_block(self, block: str, show: bool):
        self.settings[f"show_{block}"] = show
        if self.ship_overlay and self.enabled:
            was_visible = self.ship_overlay.window.winfo_viewable()
            self.ship_overlay.destroy()
            self.ship_overlay = ShipOverlay(self.master, self.settings)
            self.ship_overlay.set_on_move(self._on_ship_moved)
            self.ship_overlay.set_on_resize(lambda w, h: self._on_resized("ship", w, h))
            if not was_visible or not self.settings.get("show_ship", True):
                self.ship_overlay.hide()

    def set_attach_to_game(self, attach: bool):
        self.settings["attach_to_game"] = attach

    def save_settings(self):
        save_overlay_settings(self.config_path, self.settings)


# ============================================================
#  Настройки оверлея
# ============================================================
DEFAULT_SETTINGS = {
    "alpha": 0.90,
    "font_family": "Consolas",
    "font_size": 10,
    "show_route": True,
    "show_status": True,
    "show_ship": True,
    "show_cargo": True,
    "show_session": True,
    "show_flags": True,
    "show_pips": True,
    "show_hull": True,
    "show_shield": True,
    "show_fuel": True,
    "show_power": True,
    "show_cargo_info": True,
    "show_balance": True,
    "show_legal": True,
    "show_destination": True,
    "show_modules": True,
    "route_x": 50,
    "route_y": 50,
    "route_width": 280,
    "route_height": 160,
    "route_locked": False,
    "route_anchor": "custom",
    "status_x": 50,
    "status_y": 220,
    "status_width": 280,
    "status_height": 220,
    "status_locked": False,
    "status_anchor": "custom",
    "ship_x": 50,
    "ship_y": 440,
    "ship_width": 360,
    "ship_height": 540,
    "ship_locked": False,
    "ship_anchor": "custom",
    "cargo_x": 50,
    "cargo_y": 1000,
    "cargo_width": 300,
    "cargo_height": 340,
    "cargo_locked": False,
    "cargo_anchor": "custom",
    "session_x": 400,
    "session_y": 50,
    "session_width": 320,
    "session_height": 300,
    "session_locked": False,
    "session_anchor": "custom",
    "attach_to_game": True,
}


def load_overlay_settings(config_path: Path) -> dict:
    if config_path.exists():
        try:
            import json
            with open(config_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            merged = dict(DEFAULT_SETTINGS)
            merged.update(data)
            return merged
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)


def save_overlay_settings(config_path: Path, settings: dict):
    try:
        import json
        config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
    except Exception:
        pass
