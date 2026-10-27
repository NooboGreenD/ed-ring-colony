"""Desktop start screen for Colonial Helper.

The bootstrapper remains responsible for signed bundles, version selection and
rollback. This module adds a lightweight news dashboard in front of it; it does
not alter the Helper's own updater or account configuration.
"""
from __future__ import annotations

import html
import json
import os
import re
import sys
import threading
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import requests

import bundle
import bundle_updater
from site_config import DEFAULT_SITE_URL
from qt_lazy import ensure_app, tk, ttk
from locale_config import SUPPORTED_LOCALES, DEFAULT_LOCALE, normalize_locale, localized_url

_launcher_module = sys.modules.get("launcher")
if _launcher_module is None:
    _launcher_module = sys.modules.get("__main__")
LAUNCHER_VERSION = str(getattr(_launcher_module, "LAUNCHER_VERSION", "1.1.0"))


def _launcher_runtime():
    """Resolve the entry-point module without importing a second frozen copy."""
    module = sys.modules.get("__main__")
    if not hasattr(module, "choose_version"):
        module = sys.modules.get("launcher")
    if module is None or not hasattr(module, "choose_version"):
        raise RuntimeError("Не найден модуль bootstrapper")
    return module

BG = "#1e2022"
PANEL = "#2a2d30"
PANEL_ALT = "#25282b"
LINE = "#3b4044"
TEXT = "#f2f3f4"
MUTED = "#a1a8ad"
ORANGE = "#e57b28"
ORANGE_HOVER = "#f18b35"
CYAN = "#42b9d4"
GREEN = "#65c78a"
RED = "#e27676"


def normalize_home_data(payload: Any) -> Dict[str, List[Dict[str, str]]]:
    """Reduce the public site response to safe, displayable article fields."""
    if not isinstance(payload, dict):
        raise ValueError("Ответ сайта имеет неверный формат")
    output: Dict[str, List[Dict[str, str]]] = {}
    for key in ("news", "galnet"):
        records = payload.get(key, [])
        if not isinstance(records, list):
            records = []
        cleaned: List[Dict[str, str]] = []
        for record in records[:3]:
            if not isinstance(record, dict):
                continue
            cleaned.append({
                name: str(record.get(name) if record.get(name) is not None else "").strip()
                for name in ("id", "nid", "title", "body", "published_at")
            })
        output[key] = cleaned
    return output


def fetch_home_data(session=None, site_url: str = DEFAULT_SITE_URL,
                    timeout: Tuple[float, float] = (4.0, 8.0), locale: str = DEFAULT_LOCALE) -> Dict[str, List[Dict[str, str]]]:
    """Fetch the same localized, public home feed shown on the project site."""
    http = session or requests.Session()
    response = http.get(
        f"{site_url.rstrip('/')}/api/home-data",
        params={"locale": normalize_locale(locale)},
        headers={"Accept": "application/json", "User-Agent": f"ColonialHelperLauncher/{LAUNCHER_VERSION}"},
        timeout=timeout,
    )
    response.raise_for_status()
    return normalize_home_data(response.json())


def update_channel() -> str:
    """Use the existing app config's channel without loading or changing credentials."""
    config_path = Path.home() / ".colonial_helper.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "stable"
    channel = str(config.get("update_channel") or "stable").strip().lower() if isinstance(config, dict) else "stable"
    return channel if channel in ("stable", "beta") else "stable"


def format_date(value: str) -> str:
    if not value:
        return "НОВОСТИ ПРОЕКТА"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone().strftime("%d.%m.%Y  ·  %H:%M")
    except (ValueError, OverflowError):
        return value[:32]


def _article_markup(value: str) -> str:
    """Convert safe CMS HTML/Markdown fragments into a small Markdown subset."""
    text = html.unescape(str(value or ""))
    text = re.sub(r"<\s*script\b[^>]*>.*?</\s*script\s*>", "", text,
                  flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<\s*style\b[^>]*>.*?</\s*style\s*>", "", text,
                  flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*/?\s*(p|div|section|article)\b[^>]*>", "\n\n", text,
                  flags=re.IGNORECASE)
    text = re.sub(r"<\s*h[1-6]\b[^>]*>", "\n\n# ", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*h[1-6]\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*li\b[^>]*>", "\n- ", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*li\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*(strong|b)\b[^>]*>", "**", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*(strong|b)\s*>", "**", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*(em|i)\b[^>]*>", "*", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*(em|i)\s*>", "*", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*code\b[^>]*>", "`", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*code\s*>", "`", text, flags=re.IGNORECASE)
    text = re.sub(r"<\s*blockquote\b[^>]*>", "\n> ", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*blockquote\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]*>", "", text)
    text = text.replace("\\n", "\n").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    normalized = []
    blank = False
    for line in lines:
        if not line:
            if normalized and not blank:
                normalized.append("")
            blank = True
            continue
        normalized.append(line)
        blank = False
    return "\n".join(normalized).strip()


_INLINE_MARKUP = re.compile(
    r"(?P<link>\[([^\]]+)\]\((?:https?://|/)[^)]*\))"
    r"|(?P<strong>\*\*.+?\*\*|__.+?__)"
    r"|(?P<code>`[^`]+`)"
    r"|(?P<em>(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_))"
)


def article_blocks(value: str):
    """Parse headings, paragraphs, lists and inline emphasis for Tk Text."""
    text = _article_markup(value)
    blocks = []
    paragraph = []

    def inline_segments(line):
        segments = []
        cursor = 0
        for match in _INLINE_MARKUP.finditer(line):
            if match.start() > cursor:
                segments.append((line[cursor:match.start()], ()))
            token = match.group(0)
            if match.lastgroup == "link":
                segments.append((match.group(2), ("link",)))
            elif match.lastgroup == "strong":
                segments.append((token[2:-2], ("strong",)))
            elif match.lastgroup == "code":
                segments.append((token[1:-1], ("code",)))
            else:
                segments.append((token[1:-1], ("em",)))
            cursor = match.end()
        if cursor < len(line):
            segments.append((line[cursor:], ()))
        return segments

    def flush_paragraph():
        if paragraph:
            blocks.append(("paragraph", inline_segments(" ".join(paragraph))))
            paragraph.clear()

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            flush_paragraph()
            continue
        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        bullet = re.match(r"^[-*+]\s+(.+)$", stripped)
        ordered = re.match(r"^(\d+)[.)]\s+(.+)$", stripped)
        quote = re.match(r"^>\s?(.*)$", stripped)
        if heading or bullet or ordered or quote:
            flush_paragraph()
            if heading:
                blocks.append(("heading", inline_segments(heading.group(2))))
            elif bullet:
                blocks.append(("bullet", inline_segments(bullet.group(1))))
            elif ordered:
                blocks.append((f"ordered:{ordered.group(1)}", inline_segments(ordered.group(2))))
            else:
                blocks.append(("quote", inline_segments(quote.group(1))))
        else:
            paragraph.append(stripped)
    flush_paragraph()
    return blocks


def plain_text(value: str) -> str:
    """Readable plain-text preview used by tests and non-rich-text fallbacks."""
    lines = []
    for kind, segments in article_blocks(value):
        text = "".join(segment for segment, _tags in segments)
        if kind == "bullet":
            text = f"• {text}"
        elif kind.startswith("ordered:"):
            text = f"{kind.split(':', 1)[1]}. {text}"
        elif kind == "quote":
            text = f"“{text}”"
        lines.append(text)
    return "\n".join(lines)


def _article_url(kind: str, article: Dict[str, str]) -> str:
    if kind == "galnet":
        nid = article.get("nid", "")
        return f"{DEFAULT_SITE_URL}/galnet/{quote(nid, safe='')}" if nid else f"{DEFAULT_SITE_URL}/galnet"
    return f"{DEFAULT_SITE_URL}/news/{quote(article.get('id', ''), safe='')}"


class LauncherDashboard:
    """Tk dashboard; network and package work always run off the UI thread."""

    def __init__(self, root, install_root: Path, version: str, channel: str):
        self.tk = tk
        self.ttk = ttk
        self.root = root
        style = ttk.Style(root)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure("Vertical.TScrollbar", background=LINE, troughcolor=PANEL,
                        arrowcolor=TEXT, bordercolor=PANEL, lightcolor=LINE,
                        darkcolor=LINE, relief="flat")
        self.install_root = Path(install_root)
        self.version = str(version or "—")
        self.channel = channel
        self.settings_path = Path.home() / ".colonial_helper.json"
        self.site_locale = self._read_locale()
        self.launch_requested = False
        self.update_manifest: Optional[Dict[str, Any]] = None
        self.current_tab = "news"
        self.feed_data: Dict[str, List[Dict[str, str]]] = {"news": [], "galnet": []}
        self.feed_loaded = False
        self.feed_error = False
        self._busy = False

        root.title("ED Ring Colony — Colonial Helper")
        root.geometry("1120x730")
        root.minsize(900, 610)
        root.configure(bg=BG)
        root.protocol("WM_DELETE_WINDOW", self.close)
        self._center_window()
        self._build()
        self._render_feed("news")
        self.root.after(250, self.refresh_news)
        self.root.after(450, self.check_updates)

    def _center_window(self):
        self.root.update_idletasks()
        width = min(1120, max(900, self.root.winfo_screenwidth() - 100))
        height = min(730, max(610, self.root.winfo_screenheight() - 100))
        x = max(0, (self.root.winfo_screenwidth() - width) // 2)
        y = max(0, (self.root.winfo_screenheight() - height) // 2)
        self.root.geometry(f"{width}x{height}+{x}+{y}")

    def _frame(self, parent, **kwargs):
        return self.tk.Frame(parent, bg=kwargs.pop("bg", PANEL), **kwargs)

    def _label(self, parent, text, **kwargs):
        return self.tk.Label(parent, text=text, bg=kwargs.pop("bg", PANEL),
                             fg=kwargs.pop("fg", TEXT), **kwargs)

    def _button(self, parent, text, command, primary=False, **kwargs):
        bg = kwargs.pop("bg", ORANGE if primary else PANEL_ALT)
        fg = kwargs.pop("fg", TEXT)
        active = kwargs.pop("activebackground", ORANGE_HOVER if primary else LINE)
        active_fg = kwargs.pop("activeforeground", TEXT)
        return self.tk.Button(
            parent, text=text, command=command, bg=bg, fg=fg,
            activebackground=active, activeforeground=active_fg,
            disabledforeground="#70777c", relief="flat", bd=0,
            cursor="hand2", font=kwargs.pop("font", ("Segoe UI", 10, "bold")),
            padx=kwargs.pop("padx", 15), pady=kwargs.pop("pady", 11),
            highlightthickness=0, **kwargs,
        )

    def _read_locale(self) -> str:
        try:
            payload=json.loads(self.settings_path.read_text(encoding="utf-8"))
            return normalize_locale(payload.get("site_locale")) if isinstance(payload,dict) else DEFAULT_LOCALE
        except (OSError,ValueError):
            return DEFAULT_LOCALE

    def _save_locale(self, locale: str) -> None:
        locale=normalize_locale(locale)
        try:payload=json.loads(self.settings_path.read_text(encoding="utf-8"))
        except (OSError,ValueError):payload={}
        if not isinstance(payload,dict):payload={}
        payload["site_locale"]=locale
        temporary=self.settings_path.with_suffix(self.settings_path.suffix+".tmp")
        try:
            fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
            with os.fdopen(fd,"w",encoding="utf-8") as stream:
                json.dump(payload,stream,ensure_ascii=False,indent=2)
                stream.flush();os.fsync(stream.fileno())
            try:os.chmod(temporary,0o600)
            except OSError:pass
            temporary.replace(self.settings_path)
        except OSError:pass

    def _on_locale_changed(self, _event=None):
        label=self.locale_combo.get()
        code=next((key for key,value in SUPPORTED_LOCALES.items() if f"{key} — {value}"==label),DEFAULT_LOCALE)
        self.site_locale=normalize_locale(code);self._save_locale(self.site_locale)
        self.feed_loaded=False;self.refresh_news()

    def _build(self):
        tk = self.tk
        outer = tk.Frame(self.root, bg=BG)
        outer.pack(fill="both", expand=True, padx=22, pady=18)
        outer.grid_rowconfigure(1, weight=1)
        outer.grid_columnconfigure(1, weight=1)

        top = self._frame(outer, bg=PANEL_ALT, height=88)
        top.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 14))
        top.grid_propagate(False)
        tk.Frame(top, bg=ORANGE, width=5).pack(side="left", fill="y")
        identity = self._frame(top, bg=PANEL_ALT)
        identity.pack(side="left", fill="both", expand=True, padx=18, pady=12)
        self._label(identity, "ED RING COLONY", fg=CYAN,
                    font=("Segoe UI", 9, "bold")).pack(anchor="w")
        self._label(identity, "COLONIAL HELPER", font=("Segoe UI", 20, "bold")).pack(anchor="w", pady=(0, 1))
        self._label(top, "DESKTOP COMMAND", fg=MUTED,
                    font=("Consolas", 9, "bold")).pack(side="right", padx=20)

        side = self._frame(outer, width=260)
        side.grid(row=1, column=0, sticky="nsew", padx=(0, 14))
        side.grid_propagate(False)
        self._label(side, "УПРАВЛЕНИЕ", fg=MUTED, font=("Segoe UI", 9, "bold")).pack(anchor="w", padx=18, pady=(20, 10))
        self._button(side, "▶   Запустить Colonial Helper", self.launch, primary=True).pack(fill="x", padx=16, pady=(0, 14))
        self._label(side, "УСТАНОВЛЕННАЯ ВЕРСИЯ", fg=MUTED,
                    font=("Segoe UI", 8, "bold")).pack(anchor="w", padx=18, pady=(8, 3))
        self.version_value = self._label(side, f"v{self.version}", font=("Consolas", 13, "bold"))
        self.version_value.pack(anchor="w", padx=18)
        self._label(side, f"Канал обновлений: {self.channel}", fg=MUTED,
                    font=("Segoe UI", 9)).pack(anchor="w", padx=18, pady=(4, 8))
        self._label(side, "ЯЗЫК САЙТА И HELPER", fg=MUTED,
                    font=("Segoe UI", 8, "bold")).pack(anchor="w", padx=18, pady=(0, 4))
        self.locale_combo = self.ttk.Combobox(
            side, state="readonly", width=22,
            values=[f"{code} — {name}" for code,name in SUPPORTED_LOCALES.items()],
        )
        self.locale_combo.pack(fill="x", padx=16, pady=(0, 12))
        self.locale_combo.set(f"{self.site_locale} — {SUPPORTED_LOCALES[self.site_locale]}")
        self.locale_combo.bind("<<ComboboxSelected>>", self._on_locale_changed)
        tk.Frame(side, bg=LINE, height=1).pack(fill="x", padx=16, pady=(0, 14))
        self.update_status = self._label(side, "Проверяем обновления…", fg=MUTED,
                                         justify="left", wraplength=220,
                                         font=("Segoe UI", 9))
        self.update_status.pack(anchor="w", padx=18, pady=(0, 10))
        self.check_button = self._button(side, "Проверить обновления", self.check_updates)
        self.check_button.pack(fill="x", padx=16, pady=(0, 8))
        self.install_button = self._button(side, "Установить обновление", self.install_update, primary=True)
        self.install_button.pack(fill="x", padx=16, pady=(0, 14))
        self.install_button.configure(state="disabled")
        self.update_detail = self._label(side, "Обновления подписаны и проверяются перед установкой.",
                                         fg=MUTED, justify="left", wraplength=220,
                                         font=("Segoe UI", 8))
        self.update_detail.pack(anchor="w", padx=18, pady=(2, 16))
        tk.Frame(side, bg=LINE, height=1).pack(fill="x", padx=16, pady=(0, 12))
        self._button(side, "Открыть сайт проекта ↗",
                     lambda: webbrowser.open(localized_url(DEFAULT_SITE_URL,self.site_locale))).pack(fill="x", padx=16, pady=(0, 8))
        self._label(side, "Новости загружаются с сайта проекта.\nДля запуска Helper сеть не нужна.",
                    fg=MUTED, justify="left", wraplength=220,
                    font=("Segoe UI", 8)).pack(anchor="w", padx=18, pady=(12, 10))

        main = self._frame(outer)
        main.grid(row=1, column=1, sticky="nsew")
        main.grid_rowconfigure(2, weight=1)
        main.grid_columnconfigure(0, weight=1)
        heading = self._frame(main)
        heading.grid(row=0, column=0, sticky="ew", padx=20, pady=(18, 8))
        heading.grid_columnconfigure(0, weight=1)
        self._label(heading, "СВОДКА ГАЛАКТИКИ", fg=CYAN,
                    font=("Segoe UI", 9, "bold")).grid(row=0, column=0, sticky="w")
        self.feed_status = self._label(heading, "Подключение к ED Ring Colony…", fg=MUTED,
                                       font=("Segoe UI", 8))
        self.feed_status.grid(row=1, column=0, sticky="w", pady=(3, 0))
        self._button(heading, "↻  Обновить ленту", self.refresh_news).grid(row=0, column=1, rowspan=2, padx=(12, 0))

        tabs = self._frame(main, bg=PANEL)
        tabs.grid(row=1, column=0, sticky="ew", padx=20, pady=(5, 0))
        self.tab_buttons = {}
        for key, title in (("news", "НОВОСТИ ПРОЕКТА"), ("galnet", "GALNET")):
            button = tk.Button(tabs, text=title, command=lambda k=key: self._select_tab(k),
                               bg=PANEL, fg=MUTED, activebackground=PANEL,
                               activeforeground=TEXT, relief="flat", bd=0,
                               font=("Segoe UI", 9, "bold"), padx=14, pady=10,
                               cursor="hand2", highlightthickness=0)
            button.pack(side="left")
            self.tab_buttons[key] = button
        self.tab_accent = tk.Frame(tabs, bg=ORANGE, height=2)
        self.tab_accent.place(x=0, y=38, width=146)

        feed = self._frame(main)
        feed.grid(row=2, column=0, sticky="nsew", padx=20, pady=(0, 18))
        feed.grid_rowconfigure(0, weight=1)
        feed.grid_columnconfigure(0, weight=1)
        self.canvas = tk.Canvas(feed, bg=PANEL, bd=0, highlightthickness=0)
        scrollbar = self.ttk.Scrollbar(feed, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=scrollbar.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.feed_inner = tk.Frame(self.canvas, bg=PANEL)
        self.feed_window = self.canvas.create_window((0, 0), window=self.feed_inner, anchor="nw")
        self.feed_inner.bind("<Configure>", lambda _event: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda event: self.canvas.itemconfigure(self.feed_window, width=event.width))
        self._last_feed_wraplength = 0
        self.canvas.bind("<Configure>", self._on_feed_canvas_resize, add="+")
        self.canvas.bind_all("<MouseWheel>", self._mousewheel)

        footer = self._frame(outer, bg=BG)
        footer.grid(row=2, column=0, columnspan=2, sticky="ew", pady=(10, 0))
        self._label(footer, "ED RING COLONY   /   СООБЩЕСТВО ИССЛЕДОВАТЕЛЕЙ ГАЛАКТИКИ",
                    bg=BG, fg=MUTED, font=("Consolas", 8)).pack(side="left")
        self.connection_indicator = self._label(footer, "●  ОФЛАЙН-ЗАПУСК ДОСТУПЕН",
                                                bg=BG, fg=GREEN, font=("Consolas", 8, "bold"))
        self.connection_indicator.pack(side="right")
        self._select_tab("news")

    def _schedule(self, callback):
        try:
            self.root.after(0, callback)
        except Exception:
            # The user may close the window while a network operation finishes.
            pass

    def _mousewheel(self, event):
        try:
            self.canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
        except Exception:
            pass

    def _select_tab(self, key: str):
        self.current_tab = key
        for name, button in self.tab_buttons.items():
            button.configure(fg=TEXT if name == key else MUTED)
        self.tab_accent.place(x=0 if key == "news" else 147, y=38,
                              width=146 if key == "news" else 67)
        self._render_feed(key)

    def _feed_wraplength(self, canvas_width=None) -> int:
        width = int(canvas_width or 0)
        if width < 100:
            try:
                width = int(self.canvas.winfo_width())
            except Exception:
                width = 0
        if width < 100:
            try:
                width = int(self.root.winfo_width()) - 330
            except Exception:
                width = 420
        return max(240, min(900, width - 56))

    def _on_feed_canvas_resize(self, event):
        wraplength = self._feed_wraplength(event.width)
        previous = getattr(self, "_last_feed_wraplength", 0)
        if abs(wraplength - previous) < 24:
            return
        self._last_feed_wraplength = wraplength
        if getattr(self, "feed_loaded", False):
            try:
                self.root.after_idle(lambda: self._render_feed(self.current_tab))
            except Exception:
                pass

    def _render_article_body(self, parent, raw: str, wraplength: int):
        tk = self.tk
        blocks = article_blocks(raw)
        if not blocks:
            return
        readable = plain_text(raw)
        if len(readable) > 900:
            readable = readable[:897].rsplit(" ", 1)[0] + "…"
            blocks = [("paragraph", [(readable, ())])]
        chars_per_line = max(34, int(wraplength / 7.2))
        estimated_lines = sum(
            max(1, (len("".join(part for part, _tags in segments)) + chars_per_line - 1)
                // chars_per_line)
            for _kind, segments in blocks
        ) + max(0, len(blocks) - 1)
        body = tk.Text(
            parent, width=1, height=max(2, min(14, estimated_lines)),
            bg=PANEL_ALT, fg=MUTED, wrap="word", relief="flat", bd=0,
            highlightthickness=0, padx=0, pady=0, takefocus=False,
            font=("Segoe UI", 9), spacing1=1, spacing3=2,
        )
        body.tag_configure("strong", font=("Segoe UI", 9, "bold"), foreground=TEXT)
        body.tag_configure("em", font=("Segoe UI", 9, "italic"))
        body.tag_configure("code", font=("Consolas", 9), foreground=CYAN,
                           background=BG)
        body.tag_configure("link", foreground=CYAN, underline=True)
        body.tag_configure("heading", font=("Segoe UI", 10, "bold"), foreground=TEXT,
                           spacing1=4, spacing3=3)
        body.tag_configure("quote", foreground=MUTED, lmargin1=14, lmargin2=14)
        body.tag_configure("bullet", foreground=ORANGE, font=("Segoe UI", 9, "bold"))
        for index, (kind, segments) in enumerate(blocks):
            if index:
                body.insert("end", "\n")
            is_ordered = kind.startswith("ordered:")
            block_style = "heading" if kind == "heading" else "quote" if kind == "quote" else None
            if kind == "bullet":
                body.insert("end", "•  ", ("bullet",))
            elif is_ordered:
                body.insert("end", f"{kind.split(':', 1)[1]}.  ", ("bullet",))
            for segment, tags in segments:
                applied = tuple(tags) + ((block_style,) if block_style else ())
                if applied:
                    body.insert("end", segment, applied)
                else:
                    body.insert("end", segment)
        body.configure(state="disabled")
        body.pack(fill="x", anchor="w", pady=(0, 9))

    def _render_feed(self, key: str):
        tk = self.tk
        for child in self.feed_inner.winfo_children():
            child.destroy()
        articles = self.feed_data.get(key, [])
        if not articles:
            if not self.feed_loaded:
                title = "Загружаем новости проекта…" if key == "news" else "Загружаем Galnet…"
            elif self.feed_error:
                title = "Лента сейчас недоступна. Проверьте соединение или откройте сайт проекта."
            else:
                title = "Новых публикаций пока нет."
            self._label(self.feed_inner, title, bg=PANEL, fg=MUTED,
                        justify="left", wraplength=560, font=("Segoe UI", 11)).pack(anchor="w", padx=22, pady=22)
            return
        wraplength = self._feed_wraplength()
        for article in articles:
            card = tk.Frame(self.feed_inner, bg=PANEL_ALT, highlightbackground=LINE,
                            highlightthickness=1)
            card.pack(fill="x", padx=9, pady=(10, 2))
            tk.Frame(card, bg=CYAN if key == "galnet" else ORANGE, width=4).pack(side="left", fill="y")
            content = tk.Frame(card, bg=PANEL_ALT)
            content.pack(side="left", fill="both", expand=True, padx=16, pady=12)
            self._label(content, format_date(article.get("published_at", "")),
                        bg=PANEL_ALT, fg=CYAN if key == "galnet" else ORANGE,
                        font=("Consolas", 8, "bold")).pack(anchor="w")
            title = article.get("title") or "Без заголовка"
            self._label(content, title, bg=PANEL_ALT, fg=TEXT,
                        justify="left", anchor="w", wraplength=wraplength,
                        font=("Segoe UI", 12, "bold")).pack(fill="x", anchor="w", pady=(5, 4))
            self._render_article_body(content, article.get("body", ""), wraplength)
            self._button(content, "Читать на сайте ↗",
                         lambda item=article, kind=key: webbrowser.open(_article_url(kind, item)),
                         fg=CYAN, bg=PANEL_ALT, activebackground=LINE,
                         font=("Segoe UI", 8, "bold"), padx=0, pady=2).pack(anchor="w")

    def refresh_news(self):
        if getattr(self, "_news_busy", False):
            return
        self._news_busy = True
        self.feed_status.configure(text="Загружаем новости проекта и Galnet…", fg=MUTED)

        def work():
            try:
                data, error = fetch_home_data(locale=self.site_locale), ""
            except Exception as exc:
                data, error = None, str(exc)
            self._schedule(lambda: self._news_complete(data, error))

        threading.Thread(target=work, daemon=True, name="launcher-news").start()

    def _news_complete(self, data, error: str):
        self._news_busy = False
        self.feed_loaded = True
        if data is None:
            self.feed_error = True
            self.feed_status.configure(text="Не удалось загрузить ленту. Можно запустить Helper офлайн.", fg=RED)
            self.connection_indicator.configure(text="●  НОВОСТИ НЕДОСТУПНЫ", fg=RED)
            self.feed_data = {"news": [], "galnet": []}
            self._render_feed(self.current_tab)
            return
        self.feed_error = False
        self.feed_data = data
        total = len(data["news"]) + len(data["galnet"])
        self.feed_status.configure(text=f"{len(data['news'])} новостей проекта  ·  {len(data['galnet'])} сообщений Galnet",
                                   fg=MUTED)
        self.connection_indicator.configure(text="●  САЙТ ПОДКЛЮЧЁН", fg=GREEN)
        self._render_feed(self.current_tab)
        if total == 0:
            self.feed_status.configure(text="Лента пока пуста — загляните на сайт проекта.", fg=MUTED)

    def check_updates(self):
        if self._busy:
            return
        self._busy = True
        self.check_button.configure(state="disabled")
        self.install_button.configure(state="disabled", text="Установить обновление")
        self.update_status.configure(text="Проверяем подписанный манифест…", fg=MUTED)

        def work():
            try:
                state = bundle.load_state(self.install_root)
                current = str(state.get("current") or self.version)
                result = bundle_updater.check_for_update(
                    current, channel=self.channel, launcher_version=LAUNCHER_VERSION)
                plan = bundle_updater.plan_update(self.install_root, result["manifest"]) if result.get("update_available") else None
                error = ""
            except Exception as exc:
                result, plan, error = {}, None, str(exc)
            self._schedule(lambda: self._update_check_complete(result, plan, error))

        threading.Thread(target=work, daemon=True, name="launcher-update-check").start()

    def _update_check_complete(self, result, plan, error: str):
        self._busy = False
        self.check_button.configure(state="normal")
        if error:
            self.update_status.configure(text="Проверка обновлений не удалась.", fg=RED)
            self.update_detail.configure(text=error[:240])
            return
        if not result.get("ok"):
            self.update_status.configure(text="Обновления сейчас недоступны.", fg=RED)
            self.update_detail.configure(text=str(result.get("error") or "Нет связи с сервером обновлений.")[:240])
            return
        latest = str(result.get("latest") or self.version)
        if result.get("needs_launcher"):
            self.update_status.configure(text=f"Для v{latest} нужен новый лаунчер.", fg=ORANGE)
            self.update_detail.configure(text="Скачайте актуальный установщик с сайта проекта. Текущая версия Helper сохранена.")
            return
        if result.get("update_available"):
            self.update_manifest = result.get("manifest")
            size = int((plan or {}).get("bytes", 0))
            count = len((plan or {}).get("download", []))
            direction = "Откат канала" if result.get("rollback") else "Доступно обновление"
            self.update_status.configure(text=f"{direction}: v{latest}", fg=ORANGE)
            self.update_detail.configure(text=f"К загрузке: {count} файлов · {size / 1024:.0f} КБ. Пакет будет проверен подписью и хешами.")
            self.install_button.configure(state="normal", text=f"Установить v{latest}")
        else:
            self.update_manifest = None
            self.update_status.configure(text=f"Установлена актуальная версия v{self.version}.", fg=GREEN)
            self.update_detail.configure(text="Проверка выполнена по текущему каналу обновлений.")

    def install_update(self):
        manifest = self.update_manifest
        if not manifest or self._busy:
            return
        self._busy = True
        self.check_button.configure(state="disabled")
        self.install_button.configure(state="disabled", text="Установка…")
        version = str(manifest.get("version") or "")
        self.update_status.configure(text=f"Устанавливаем v{version}…", fg=CYAN)

        def progress(done, total):
            percent = int(100 * done / max(1, total))
            self._schedule(lambda: self.update_status.configure(
                text=f"Загружаем v{version}… {percent}%", fg=CYAN))

        def work():
            try:
                result = bundle_updater.apply_update(self.install_root, manifest, progress=progress)
            except Exception as exc:
                result = {"ok": False, "error": str(exc), "version": version}
            self._schedule(lambda: self._install_complete(result))

        threading.Thread(target=work, daemon=True, name="launcher-update-install").start()

    def _install_complete(self, result):
        self._busy = False
        self.check_button.configure(state="normal")
        if not result.get("ok"):
            self.install_button.configure(state="disabled", text="Установить обновление")
            self.update_status.configure(text="Не удалось установить обновление.", fg=RED)
            self.update_detail.configure(text=str(result.get("error") or "Ошибка установки.")[:240])
            return
        self.version = str(result.get("version") or self.version)
        self.version_value.configure(text=f"v{self.version}")
        self.update_manifest = None
        self.install_button.configure(state="disabled", text="Установлено")
        self.update_status.configure(text=f"Версия v{self.version} установлена.", fg=GREEN)
        self.update_detail.configure(text="Запустите Colonial Helper. Если новая версия не откроется, лаунчер автоматически откатится.")

    def launch(self):
        self.launch_requested = True
        self.root.destroy()

    def close(self):
        self.launch_requested = False
        self.root.destroy()


def show_launcher(install_root: Path, embedded_dir: Optional[Path],
                  embedded_manifest: Optional[Dict[str, Any]]) -> bool:
    """Prepare/verify a runnable local version, then show the news dashboard."""
    ensure_app()
    launcher = _launcher_runtime()
    launcher.configure_tls_ca_bundle(install_root)
    try:
        version = launcher.choose_version(install_root, embedded_dir, embedded_manifest,
                                          record_launch=False)
    except Exception as exc:
        launcher.log(install_root, f"не удалось подготовить версию для стартового экрана: {exc}")
        version = str(bundle.load_state(install_root).get("current") or "")
    root = None
    try:
        root = tk.Tk()
        dashboard = LauncherDashboard(root, install_root, version or "—", update_channel())
        root.mainloop()
        return dashboard.launch_requested
    except Exception as exc:
        # A damaged/missing GUI runtime must not strand the user outside Helper.
        if root is not None:
            try:
                root.destroy()
            except Exception:
                pass
        launcher.log(install_root, f"не удалось открыть стартовый экран: {exc}; запускаем Helper напрямую")
        return True
