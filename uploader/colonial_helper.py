#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Colonial Helper — standalone uploader for ED Ring Colony.
GUI приложение на ttkbootstrap с live-watcher журналов Elite Dangerous
и оверлеем HUD для игры (Borderless Windowed).
"""

import os
import sys
import json
import time
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from datetime import datetime
from pathlib import Path
import traceback
from typing import Optional, List
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed

# -- Проверка tkinter --
try:
    import tkinter
except ImportError:
    print("=" * 60)
    print("ОШИБКА: tkinter не найден!")
    print("=" * 60)
    print("Python установлен без поддержки графического интерфейса.")
    print("Решение: переустановите Python с официального сайта")
    print("         и убедитесь, что галочка 'tcl/tk and IDLE' включена.")
    print("=" * 60)
    input("Нажмите Enter для выхода...")
    sys.exit(1)

# -- Импорт ttkbootstrap --
try:
    import ttkbootstrap as tb
    from ttkbootstrap.constants import *
except ImportError as e:
    print("=" * 60)
    print("ОШИБКА: не удалось импортировать ttkbootstrap!")
    print(f"Детали: {e}")
    print("=" * 60)
    print("Решение: pip install -r requirements.txt")
    print("         или: pip install ttkbootstrap requests")
    print("=" * 60)
    input("Нажмите Enter для выхода...")
    sys.exit(1)

# -- ScrolledText fallback --
try:
    from ttkbootstrap.scrolled import ScrolledText
except ImportError:
    class ScrolledText(tb.Frame):
        def __init__(self, master=None, **kwargs):
            self.bootstyle = kwargs.pop("bootstyle", "")
            self.autohide = kwargs.pop("autohide", False)
            super().__init__(master)
            self.text = tk.Text(self, **kwargs)
            self.scrollbar = tb.Scrollbar(self, command=self.text.yview)
            self.text.config(yscrollcommand=self.scrollbar.set)
            self.text.pack(side=LEFT, fill=BOTH, expand=True)
            self.scrollbar.pack(side=RIGHT, fill=Y)

# -- pyperclip --
try:
    import pyperclip
except ImportError:
    pyperclip = None

from api_client import ApiClient
from journal_parser import parse_file, parse_journal
from route_tracker import RouteTracker
from overlay import OverlayManager
from edsm_api import EDSMAPI
from ship_tracker import ShipTracker

# -- Константы --
APP_NAME = "Colonial Helper"
VERSION = "1.2.0"
DEFAULT_JOURNAL_PATH = Path.home() / "Saved Games" / "Frontier Developments" / "Elite Dangerous"

COLOR_BG = "#1e2022"
COLOR_PANEL = "#2a2d30"
COLOR_LINE = "#3a3d40"
COLOR_TEXT = "#eeeeee"
COLOR_MUTED = "#9ca3af"
COLOR_ORANGE = "#e67e22"
COLOR_CYAN = "#3498db"
COLOR_GREEN = "#2ecc71"
COLOR_RED = "#e74c3c"


class ColonialHelperApp:
    def __init__(self, root: tb.Window):
        self.root = root
        self.root.title(f"{APP_NAME} v{VERSION}")
        self.root.geometry("900x650")
        self.root.minsize(800, 550)

        try:
            self.root.iconbitmap("colonial_helper.ico")
        except Exception:
            pass

        # Данные
        self.api = ApiClient()
        self.route = RouteTracker()
        self.ship = ShipTracker()
        self.watcher_active = False
        self.watcher_thread = None
        self.watcher_stop_event = threading.Event()
        self.journal_path = Path(DEFAULT_JOURNAL_PATH)
        self.last_file_mtimes = {}

        # Счётчики сессии для SessionOverlay
        self._session_deliveries = 0
        self._session_cargo_tons = 0.0
        self._session_route_deliveries = 0  # доставки только в системы маршрута
        self._session_route_cargo_tons = 0.0  # тонны только в системы маршрута
        self._session_construction_cargo_tons = 0.0  # ColonisationContribution за сессию
        self._session_systems_visited = set()
        self._last_cargo: dict = {}  # последний инвентарь для parse_journal
        self._last_depot_state: dict = {}  # snapshot стройплощадки для отображения прогресса
        self._last_contribution_state: dict = {}  # { (market_id, resource): amount } для diff
        self._seen_events: set = set()  # ключи событий — защита от дублей
        self._last_delivery_system: str = ""  # последняя система доставки для оверлея
        self._watcher_cmdr_name: Optional[str] = None  # CMDR, привязанный к текущей watcher-сессии
        self._pending_watcher_deliveries: list = []  # очередь повторной отправки при временной ошибке API
        self._navroute_mtime = 0.0

        # Конфиг
        self.config = {}
        self.config_path = Path.home() / ".colonial_helper.json"
        self.load_config()

        # Raven Colonial API
        from raven_colonial_api import RavenColonialAPI
        self.raven_api = RavenColonialAPI(self.config.get("raven_colonial_key", ""))
        self.edsm_api = EDSMAPI(
            self.config.get("edsm_api_key", ""),
            self.config.get("edsm_commander_name", ""),
        )
        self._edsm_seen_events: set = set()
        # Восстанавливаем ключ из конфига (load_config вызывался раньше создания raven_api)
        raven_key = self.config.get("raven_colonial_key", "")
        if raven_key:
            self.raven_api.set_key(raven_key)

        # Оверлей
        self.overlay_manager = OverlayManager(self.root, self.config_path)

        # Стили
        self.style = None
        try:
            self.style = tb.Style(theme="darkly")
        except Exception:
            try:
                self.style = tb.Style()
            except Exception:
                pass
        self._setup_styles()

        # UI
        self._build_header()
        self._build_notebook()
        self._build_status_bar()

        # Горячие клавиши
        self.root.bind("<F12>", lambda e: self._on_toggle_overlay_visibility())
        self.root.bind("<Control-o>", lambda e: self._on_toggle_overlay())
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        # Авто-проверка токена
        if self.api.token:
            self.after(500, self._auto_validate)

    # ============================================================
    #  Стили
    # ============================================================
    def _setup_styles(self):
        s = self.style
        s.configure("Orange.TButton", foreground=COLOR_ORANGE, bordercolor=COLOR_ORANGE)
        s.configure("Cyan.TButton", foreground=COLOR_CYAN, bordercolor=COLOR_CYAN)
        s.configure("Green.TButton", foreground=COLOR_GREEN, bordercolor=COLOR_GREEN)
        s.configure("Red.TButton", foreground=COLOR_RED, bordercolor=COLOR_RED)
        s.configure("Orange.TEntry", fieldbackground=COLOR_PANEL)
        s.configure("Muted.TLabel", foreground=COLOR_MUTED)

    # ============================================================
    #  Шапка
    # ============================================================
    def _build_header(self):
        frame = tb.Frame(self.root, padding=10)
        frame.pack(fill=X, pady=(0, 5))

        title = tb.Label(
            frame,
            text="◆ COLONIAL HELPER",
            font=("Consolas", 14, "bold"),
            foreground=COLOR_ORANGE,
        )
        title.pack(anchor=W)

        subtitle = tb.Label(
            frame,
            text="Standalone uploader for ED Ring Colony  |  F12 — показать/скрыть оверлей",
            font=("Segoe UI", 9),
            foreground=COLOR_MUTED,
        )
        subtitle.pack(anchor=W)

        self.status_frame = tb.Frame(frame, relief="solid", borderwidth=1, padding=8)
        self.status_frame.pack(fill=X, pady=(10, 0))

        self.status_dot = tb.Label(self.status_frame, text="●", font=("Segoe UI", 12), foreground=COLOR_MUTED)
        self.status_dot.pack(side=LEFT, padx=(0, 8))

        self.status_text = tb.Label(
            self.status_frame,
            text="Не подключено",
            font=("Consolas", 11, "bold"),
            foreground=COLOR_MUTED,
        )
        self.status_text.pack(side=LEFT)

        self.status_detail = tb.Label(
            self.status_frame,
            text="Введите API токен",
            font=("Consolas", 10),
            foreground=COLOR_MUTED,
        )
        self.status_detail.pack(side=RIGHT)

    # ============================================================
    #  Notebook
    # ============================================================
    def _build_notebook(self):
        self.notebook = tb.Notebook(self.root, padding=10)
        self.notebook.pack(fill=BOTH, expand=True, padx=10, pady=5)

        self.tab_auth = tb.Frame(self.notebook)
        self.notebook.add(self.tab_auth, text=" Подключение ")
        self._build_tab_auth()

        self.tab_upload = tb.Frame(self.notebook)
        self.notebook.add(self.tab_upload, text=" Загрузка логов ")
        self._build_tab_upload()

        self.tab_route = tb.Frame(self.notebook)
        self.notebook.add(self.tab_route, text=" Маршрут ")
        self._build_tab_route()

        self.tab_overlay = tb.Frame(self.notebook)
        self.notebook.add(self.tab_overlay, text=" Оверлей ")
        self._build_tab_overlay()

        self.tab_log = tb.Frame(self.notebook)
        self.notebook.add(self.tab_log, text=" Лог ")
        self._build_tab_log()

    # ============================================================
    #  Вкладка: Подключение
    # ============================================================
    def _build_tab_auth(self):
        # Вкладка содержит несколько API и полей. На небольших окнах вся
        # форма должна прокручиваться, а не обрезаться снизу.
        viewport = tb.Frame(self.tab_auth)
        viewport.pack(fill=BOTH, expand=True)
        canvas = tk.Canvas(viewport, highlightthickness=0, borderwidth=0)
        scrollbar = tb.Scrollbar(viewport, orient=VERTICAL, command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=RIGHT, fill=Y)
        canvas.pack(side=LEFT, fill=BOTH, expand=True)
        frame = tb.Frame(canvas, padding=15)
        window_id = canvas.create_window((0, 0), window=frame, anchor="nw")
        frame.bind("<Configure>", lambda _e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(window_id, width=e.width))
        canvas.bind_all("<MouseWheel>", lambda e: canvas.yview_scroll(int(-e.delta / 120), "units"))

        tb.Label(frame, text="Основной API ED Ring Colony", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        tb.Label(frame, text="API-токен сайта", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(0, 4))
        tb.Label(
            frame,
            text="Поле для API-токена ED Ring Colony из профиля сайта. Используется для загрузки журналов.",
            foreground=COLOR_MUTED,
        ).pack(anchor=W)

        self.token_entry = tb.Entry(frame, width=60, font=("Consolas", 11))
        self.token_entry.pack(fill=X, pady=(5, 10))
        if self.api.token:
            self.token_entry.insert(0, self.api.token)

        btn_frame = tb.Frame(frame)
        btn_frame.pack(anchor=W, pady=(0, 10))

        tb.Button(
            btn_frame,
            text="Проверить токен",
            command=self._on_validate_token,
            bootstyle="warning-outline",
            width=20,
        ).pack(side=LEFT, padx=(0, 10))

        tb.Button(
            btn_frame,
            text="Вставить из буфера",
            command=self._on_paste_token,
            bootstyle="info-outline",
            width=20,
        ).pack(side=LEFT, padx=(0, 10))

        self.toggle_token_btn = tb.Button(
            btn_frame,
            text="Скрыть",
            command=self._toggle_token_visibility,
            bootstyle="secondary-outline",
            width=12,
        )
        self.toggle_token_btn.pack(side=LEFT)

        self.auth_result = tb.Label(frame, text="", font=("Segoe UI", 11), wraplength=700)
        self.auth_result.pack(anchor=W, pady=(5, 0))

        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=20)

        tb.Label(frame, text="Папка журналов Elite Dangerous", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        path_frame = tb.Frame(frame)
        path_frame.pack(fill=X, pady=(0, 10))

        self.path_entry = tb.Entry(path_frame, font=("Consolas", 10))
        self.path_entry.pack(side=LEFT, fill=X, expand=True, padx=(0, 10))
        self.path_entry.insert(0, str(self.journal_path))

        tb.Button(
            path_frame,
            text="Обзор...",
            command=self._on_browse_journal_path,
            bootstyle="info-outline",
            width=12,
        ).pack(side=RIGHT)

        tb.Label(
            frame,
            text="По умолчанию: Saved Games\\Frontier Developments\\Elite Dangerous",
            foreground=COLOR_MUTED,
            font=("Segoe UI", 9),
        ).pack(anchor=W)

        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=20)

        tb.Label(frame, text="Raven Colonial API", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        tb.Label(frame, text="API-ключ Raven Colonial", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(0, 4))
        tb.Label(
            frame,
            text="Вставьте сюда ключ из профиля ravencolonial.com. Нажмите «Проверить ключ» и сохраните настройки.",
            foreground=COLOR_MUTED,
        ).pack(anchor=W)

        self.raven_key_entry = tb.Entry(frame, width=60, font=("Consolas", 11), show="*")
        self.raven_key_entry.pack(fill=X, pady=(5, 10))
        if self.raven_api.api_key:
            self.raven_key_entry.insert(0, self.raven_api.api_key)

        raven_btn_frame = tb.Frame(frame)
        raven_btn_frame.pack(anchor=W, pady=(0, 10))

        tb.Button(
            raven_btn_frame,
            text="Проверить ключ",
            command=self._on_check_raven,
            bootstyle="warning-outline",
            width=20,
        ).pack(side=LEFT, padx=(0, 10))

        self.raven_status_label = tb.Label(frame, text="Raven Colonial: не подключено", font=("Segoe UI", 11), foreground=COLOR_MUTED)
        self.raven_status_label.pack(anchor=W, pady=(5, 0))

        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=20)
        tb.Label(frame, text="EDSM Journal API", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))
        tb.Label(frame, text="Необязательно: отправка событий FSDJump, Location, Docked и Scan в EDSM.", foreground=COLOR_MUTED).pack(anchor=W)
        tb.Label(frame, text="EDSM API key", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(8, 2))
        tb.Label(frame, text="Ключ EDSM API для отправки событий журнала. Можно оставить пустым.", foreground=COLOR_MUTED).pack(anchor=W)
        self.edsm_key_entry = tb.Entry(frame, width=60, font=("Consolas", 11), show="*")
        self.edsm_key_entry.pack(fill=X, pady=(4, 5))
        self.edsm_key_entry.insert(0, self.edsm_api.api_key)
        tb.Label(frame, text="Имя командира в EDSM", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(3, 2))
        tb.Label(frame, text="Точное имя CMDR, зарегистрированное в EDSM.", foreground=COLOR_MUTED).pack(anchor=W)
        self.edsm_name_entry = tb.Entry(frame, width=60, font=("Consolas", 11))
        self.edsm_name_entry.pack(fill=X, pady=(4, 8))
        self.edsm_name_entry.insert(0, self.edsm_api.commander_name)
        tb.Button(frame, text="Сохранить EDSM настройки", command=self._save_edsm_settings, bootstyle="info-outline", width=28).pack(anchor=W)
        self.edsm_status_label = tb.Label(frame, text="EDSM: включён" if self.edsm_api.enabled else "EDSM: не настроен", foreground=COLOR_MUTED)
        self.edsm_status_label.pack(anchor=W, pady=(5, 0))

    def _save_edsm_settings(self):
        self.edsm_api.set_credentials(self.edsm_key_entry.get(), self.edsm_name_entry.get())
        self.config["edsm_api_key"] = self.edsm_api.api_key
        self.config["edsm_commander_name"] = self.edsm_api.commander_name
        self.save_config()
        self.edsm_status_label.config(text="EDSM: включён" if self.edsm_api.enabled else "EDSM: не настроен")

    # ============================================================
    #  Вкладка: Загрузка логов
    # ============================================================
    def _build_tab_upload(self):
        frame = tb.Frame(self.tab_upload, padding=15)
        frame.pack(fill=BOTH, expand=True)

        tb.Label(frame, text="Загрузка журналов", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        btn_frame = tb.Frame(frame)
        btn_frame.pack(anchor=W, pady=(0, 10))

        tb.Button(
            btn_frame,
            text="Выбрать файлы .log",
            command=self._on_select_files,
            bootstyle="info-outline",
            width=22,
        ).pack(side=LEFT, padx=(0, 10))

        self.upload_btn = tb.Button(
            btn_frame,
            text="Загрузить",
            command=self._on_upload,
            bootstyle="warning-outline",
            width=15,
            state=DISABLED,
        )
        self.upload_btn.pack(side=LEFT, padx=(0, 10))

        self.watcher_btn = tb.Button(
            btn_frame,
            text="▶ Следить за игрой",
            command=self._on_toggle_watcher,
            bootstyle="success-outline",
            width=22,
        )
        self.watcher_btn.pack(side=LEFT)

        self.files_label = tb.Label(frame, text="Файлы не выбраны", foreground=COLOR_MUTED)
        self.files_label.pack(anchor=W, pady=(5, 0))

        self.progress = tb.Progressbar(frame, mode="determinate", bootstyle="warning")
        self.progress.pack(fill=X, pady=(15, 5))
        self.progress["value"] = 0

        self.progress_label = tb.Label(frame, text="", foreground=COLOR_MUTED)
        self.progress_label.pack(anchor=W)

        self.selected_files: list[Path] = []

    # ============================================================
    #  Вкладка: Маршрут
    # ============================================================
    def _build_tab_route(self):
        frame = tb.Frame(self.tab_route, padding=15)
        frame.pack(fill=BOTH, expand=True)

        tb.Label(frame, text="Отслеживание маршрута", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        btn_frame = tb.Frame(frame)
        btn_frame.pack(anchor=W, pady=(0, 10))

        tb.Button(
            btn_frame,
            text="Импорт маршрута",
            command=self._on_import_route,
            bootstyle="info-outline",
            width=18,
        ).pack(side=LEFT, padx=(0, 10))

        tb.Button(
            btn_frame,
            text="Экспорт CSV",
            command=self._on_export_route,
            bootstyle="warning-outline",
            width=15,
        ).pack(side=LEFT, padx=(0, 10))

        tb.Button(
            btn_frame,
            text="Очистить",
            command=self._on_clear_route,
            bootstyle="success-outline",
            width=12,
        ).pack(side=LEFT)

        tb.Label(
            frame,
            text="Импортируйте маршрут из NavRoute.json или CSV. Системы отмечаются автоматически при разборе журналов.",
            foreground=COLOR_MUTED,
            wraplength=700,
        ).pack(anchor=W, pady=(5, 10))

        tree_frame = tb.Frame(frame, relief="solid", borderwidth=1)
        tree_frame.pack(fill=BOTH, expand=True)

        columns = ("index", "system", "status", "visited")
        self.route_tree = tb.Treeview(
            tree_frame,
            columns=columns,
            show="headings",
            bootstyle="dark",
            height=15,
        )
        self.route_tree.heading("index", text="#")
        self.route_tree.heading("system", text="Система")
        self.route_tree.heading("status", text="Статус")
        self.route_tree.heading("visited", text="Посещена")
        self.route_tree.column("index", width=40, anchor=CENTER)
        self.route_tree.column("system", width=300, anchor=W)
        self.route_tree.column("status", width=120, anchor=CENTER)
        self.route_tree.column("visited", width=180, anchor=CENTER)

        vsb = tb.Scrollbar(tree_frame, orient=VERTICAL, command=self.route_tree.yview)
        self.route_tree.configure(yscrollcommand=vsb.set)

        self.route_tree.pack(side=LEFT, fill=BOTH, expand=True)
        vsb.pack(side=RIGHT, fill=Y)

        self.route_counter = tb.Label(frame, text="Маршрут не загружен", foreground=COLOR_MUTED)
        self.route_counter.pack(anchor=W, pady=(8, 0))

    # ============================================================
    #  Вкладка: Оверлей
    # ============================================================
    def _build_tab_overlay(self):
        # The overlay settings contain more controls than a small window can
        # display. Put the whole settings panel in a scrollable canvas.
        viewport = tb.Frame(self.tab_overlay)
        viewport.pack(fill=BOTH, expand=True)
        canvas = tk.Canvas(viewport, highlightthickness=0, borderwidth=0)
        scrollbar = tb.Scrollbar(viewport, orient=VERTICAL, command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=RIGHT, fill=Y)
        canvas.pack(side=LEFT, fill=BOTH, expand=True)
        frame = tb.Frame(canvas, padding=15)
        window_id = canvas.create_window((0, 0), window=frame, anchor="nw")
        frame.bind("<Configure>", lambda _e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(window_id, width=e.width))
        canvas.bind_all("<MouseWheel>", lambda e: canvas.yview_scroll(int(-e.delta / 120), "units"))

        tb.Label(frame, text="Настройки оверлея HUD", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))
        tb.Label(
            frame,
            text="Оверлей работает поверх Elite Dangerous в режиме Borderless Windowed.\nПеретаскивайте окна мышью. ПКМ по заголовку — меню управления. F12 — показать/скрыть.",
            foreground=COLOR_MUTED,
            wraplength=700,
        ).pack(anchor=W, pady=(0, 10))

        # Кнопки вкл/выкл
        btn_frame = tb.Frame(frame)
        btn_frame.pack(anchor=W, pady=(0, 15))

        self.overlay_toggle_btn = tb.Button(
            btn_frame,
            text="▶ Включить оверлей",
            command=self._on_toggle_overlay,
            bootstyle="success-outline",
            width=22,
        )
        self.overlay_toggle_btn.pack(side=LEFT, padx=(0, 10))

        tb.Button(
            btn_frame,
            text="Сбросить позиции",
            command=self._on_reset_overlay_positions,
            bootstyle="secondary-outline",
            width=18,
        ).pack(side=LEFT)

        # Прозрачность
        alpha_frame = tb.Frame(frame)
        alpha_frame.pack(fill=X, pady=5)
        tb.Label(alpha_frame, text="Прозрачность:", width=18, anchor=W).pack(side=LEFT)
        self.alpha_var = tk.DoubleVar(value=self.overlay_manager.settings.get("alpha", 0.90))
        alpha_scale = tb.Scale(
            alpha_frame, from_=0.1, to=1.0, orient=HORIZONTAL,
            variable=self.alpha_var, length=250,
            command=lambda v: self._on_alpha_changed(float(v)),
        )
        alpha_scale.pack(side=LEFT, padx=(10, 0))
        self.alpha_label = tb.Label(alpha_frame, text=f"{self.alpha_var.get():.0%}")
        self.alpha_label.pack(side=LEFT, padx=(10, 0))

        # Шрифт
        font_frame = tb.Frame(frame)
        font_frame.pack(fill=X, pady=5)
        tb.Label(font_frame, text="Шрифт:", width=18, anchor=W).pack(side=LEFT)
        self.font_var = tk.StringVar(value=self.overlay_manager.settings.get("font_family", "Consolas"))
        font_combo = tb.Combobox(
            font_frame, textvariable=self.font_var,
            values=["Consolas", "Courier New", "Segoe UI", "Arial", "Lucida Console"],
            width=20, state="readonly",
        )
        font_combo.pack(side=LEFT, padx=(10, 0))
        font_combo.bind("<<ComboboxSelected>>", lambda e: self._on_font_changed())

        # Размер шрифта
        size_frame = tb.Frame(frame)
        size_frame.pack(fill=X, pady=5)
        tb.Label(size_frame, text="Размер шрифта:", width=18, anchor=W).pack(side=LEFT)
        self.font_size_var = tk.IntVar(value=self.overlay_manager.settings.get("font_size", 10))
        size_scale = tb.Scale(
            size_frame, from_=8, to=18, orient=HORIZONTAL,
            variable=self.font_size_var, length=250,
            command=lambda v: self._on_font_size_changed(int(float(v))),
        )
        size_scale.pack(side=LEFT, padx=(10, 0))
        self.size_label = tb.Label(size_frame, text=str(self.font_size_var.get()))
        self.size_label.pack(side=LEFT, padx=(10, 0))

        # Чекбоксы оверлеев
        tb.Label(frame, text="Активные оверлеи:", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(10, 5))
        ov_frame = tb.Frame(frame)
        ov_frame.pack(fill=X, pady=5)

        self.show_route_var = tk.BooleanVar(value=self.overlay_manager.settings.get("show_route", True))
        tb.Checkbutton(ov_frame, text="ROUTE — маршрут", variable=self.show_route_var,
                       command=self._on_show_route_changed).pack(anchor=W, pady=2)

        self.show_status_var = tk.BooleanVar(value=self.overlay_manager.settings.get("show_status", True))
        tb.Checkbutton(ov_frame, text="STATUS — статус подключения", variable=self.show_status_var,
                       command=self._on_show_status_changed).pack(anchor=W, pady=2)

        self.show_ship_var = tk.BooleanVar(value=self.overlay_manager.settings.get("show_ship", True))
        tb.Checkbutton(ov_frame, text="SHIP — состояние корабля", variable=self.show_ship_var,
                       command=self._on_show_ship_changed).pack(anchor=W, pady=2)

        self.show_cargo_var = tk.BooleanVar(value=self.overlay_manager.settings.get("show_cargo", True))
        tb.Checkbutton(ov_frame, text="CARGO — товары в трюме", variable=self.show_cargo_var,
                       command=self._on_show_cargo_changed).pack(anchor=W, pady=2)

        self.show_session_var = tk.BooleanVar(value=self.overlay_manager.settings.get("show_session", True))
        tb.Checkbutton(ov_frame, text="SESSION — статистика сессии + график", variable=self.show_session_var,
                       command=self._on_show_session_changed).pack(anchor=W, pady=2)

        tb.Separator(ov_frame, orient=HORIZONTAL).pack(fill=X, pady=6)

        self.attach_game_var = tk.BooleanVar(value=self.overlay_manager.settings.get("attach_to_game", True))
        tb.Checkbutton(ov_frame, text="Привязать оверлей к окну Elite Dangerous (только поверх игры)",
                       variable=self.attach_game_var,
                       command=self._on_attach_game_changed).pack(anchor=W, pady=2)

        # Чекбоксы блоков ShipOverlay
        tb.Label(frame, text="Блоки корабля (SHIP):", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(10, 5))
        ship_chk = tb.Frame(frame)
        ship_chk.pack(fill=X, pady=5)

        self._ship_blocks = {}
        for block_key, block_label in [
            ("flags", "Флаги состояния"),
            ("pips", "Pips (SYS/ENG/WEP)"),
            ("hull", "Корпус"),
            ("shield", "Щиты"),
            ("fuel", "Топливо"),
            ("power", "Энергия"),
            ("cargo_info", "Груз"),
            ("balance", "Баланс"),
            ("legal", "Юридический статус"),
            ("destination", "Назначение"),
            ("modules", "Модули"),
        ]:
            var = tk.BooleanVar(value=self.overlay_manager.settings.get(f"show_{block_key}", True))
            self._ship_blocks[block_key] = var
            tb.Checkbutton(ship_chk, text=block_label, variable=var,
                           command=lambda k=block_key, v=var: self._on_ship_block_changed(k, v.get())).pack(anchor=W, pady=1)

        # Горячие клавиши подсказка
        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=15)
        tb.Label(
            frame,
            text="Управление оверлеями:\n"
                 "  • Перетаскивайте за заголовок (если не заблокировано)\n"
                 "  • ПКМ по [L/U] — блокировка позиции\n"
                 "  • ПКМ по [*] — меню: привязка, размер, прозрачность\n"
                 "  • Потяните за угол — изменение размера\n"
                 "  • F12 — показать/скрыть все оверлеи\n"
                 "  • Ctrl+O — включить/выключить оверлей",
            foreground=COLOR_MUTED,
            font=("Consolas", 10),
            justify=LEFT,
        ).pack(anchor=W)

    def _on_toggle_overlay(self):
        # NavRoute.json is produced by the game independently of Watcher.
        # Load it when the HUD is enabled as well, so ROUTE works on its own.
        if not self.overlay_manager.enabled:
            self._auto_load_navroute()
        self.overlay_manager.toggle(self._get_overlay_data)
        if self.overlay_manager.enabled:
            self.overlay_toggle_btn.config(text="⏹ Выключить оверлей", bootstyle="danger-outline")
            self.log("Оверлей включён. Используйте F12 для показа/скрытия.", "success")
            # Загружаем текущее состояние корабля для оверлея
            if not self.ship.state.current_system:
                detected_system, detected_addr = self._determine_cmdr_system()
                if detected_system:
                    self.ship.state.current_system = detected_system
                    if detected_addr:
                        self.ship.state.system_address = detected_addr
            self._load_latest_loadout()
            self._load_current_state_files()
        else:
            self.overlay_toggle_btn.config(text="▶ Включить оверлей", bootstyle="success-outline")
            self.log("Оверлей выключён", "info")

    def _on_toggle_overlay_visibility(self):
        self.overlay_manager.toggle_visibility()
        state = "visible" if (self.overlay_manager.route_overlay and self.overlay_manager.enabled) else "hidden"
        self.log(f"Overlay toggled: {state} (F12)", "info")

    def _on_alpha_changed(self, value: float):
        self.alpha_label.config(text=f"{value:.0%}")
        self.overlay_manager.set_alpha(value)

    def _on_font_changed(self):
        self.overlay_manager.set_font(self.font_var.get(), self.font_size_var.get())

    def _on_font_size_changed(self, value: int):
        self.size_label.config(text=str(value))
        self.overlay_manager.set_font(self.font_var.get(), value)

    def _on_show_route_changed(self):
        self.overlay_manager.set_show_route(self.show_route_var.get())

    def _on_show_status_changed(self):
        self.overlay_manager.set_show_status(self.show_status_var.get())

    def _on_show_ship_changed(self):
        self.overlay_manager.set_show_ship(self.show_ship_var.get())

    def _on_show_cargo_changed(self):
        self.overlay_manager.set_show_cargo(self.show_cargo_var.get())

    def _on_show_session_changed(self):
        self.overlay_manager.set_show_session(self.show_session_var.get())

    def _on_attach_game_changed(self):
        self.overlay_manager.set_attach_to_game(self.attach_game_var.get())
        state = "включена" if self.attach_game_var.get() else "отключена"
        self.log(f"Привязка к окну игры {state}", "info")

    def _on_ship_block_changed(self, block: str, show: bool):
        self.overlay_manager.set_ship_block(block, show)

    def _on_reset_overlay_positions(self):
        defaults = {
            "route": (50, 50), "status": (50, 230), "ship": (50, 440),
            "cargo": (50, 1000), "session": (400, 50),
        }
        for key, (x, y) in defaults.items():
            self.overlay_manager.settings[f"{key}_x"] = x
            self.overlay_manager.settings[f"{key}_y"] = y
            self.overlay_manager.settings[f"{key}_anchor"] = "custom"
        self.overlay_manager.save_settings()
        self.log("Позиции оверлея сброшены. Перезапустите оверлей для применения.", "info")

    def _get_overlay_data(self) -> dict:
        """Собрать данные для обновления оверлея."""
        data = {
            "online": self.api.is_connected,
            "status_detail": (
                f"{self.api.display_name} | ED Ring: {'ON' if self.api.is_connected else 'OFF'} | "
                f"Raven: {'ON' if self.raven_api.is_connected else 'OFF'} | "
                f"EDSM: {'ON' if self.edsm_api.enabled else 'OFF'}"
            ),
            "watcher_active": self.watcher_active,
            "progress": self.progress_label.cget("text") or "",
            "log_lines": [],
            "current": "—",
            "next": "—",
            "visited": 0,
            "total": 0,
            "remaining": [],
            "next_system_info": self.route.get_next_system_info(),
            "new_deliveries": 0,
            "cargo_total_tons": self._session_cargo_tons,
        }
        # Маршрут
        systems = self.route.systems
        if systems:
            data["total"] = len(systems)
            data["visited"] = self.route.visited_count
            current_idx = None
            for i, s in enumerate(systems):
                if s["status"] in ("current", "pending"):
                    current_idx = i
                    data["current"] = s["name"]
                    if i + 1 < len(systems):
                        data["next"] = systems[i + 1]["name"]
                    break
            if current_idx is not None:
                data["remaining"] = [s["name"] for s in systems[current_idx + 2:] if s["status"] == "pending"]
        # Корабль
        ship_dict = self.ship.get_state_dict()
        data["ship"] = ship_dict
        # Cargo overlay data
        data["cargo"] = {
            "cargo_count": ship_dict.get("cargo_count", 0),
            "cargo_capacity": ship_dict.get("cargo_capacity", 0),
            "inventory": ship_dict.get("inventory", []),
        }
        # Session overlay data
        data["systems_visited"] = len(self._session_systems_visited)
        data["deliveries_count"] = self._session_deliveries
        data["cargo_total_tons"] = self._session_cargo_tons
        data["route_deliveries_count"] = self._session_route_deliveries
        data["route_cargo_tons"] = self._session_route_cargo_tons
        data["construction_cargo_tons"] = self._session_construction_cargo_tons
        data["last_delivery_system"] = self._last_delivery_system
        return data

    # ============================================================
    #  Вкладка: Лог
    # ============================================================
    def _build_tab_log(self):
        frame = tb.Frame(self.tab_log, padding=15)
        frame.pack(fill=BOTH, expand=True)

        tb.Label(frame, text="Информационное окно", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        self.log_text = ScrolledText(
            frame,
            wrap=tk.WORD,
            font=("Consolas", 10),
            height=20,
            autohide=True,
            bootstyle="dark",
        )
        self.log_text.pack(fill=BOTH, expand=True)
        self.log_text.text.config(state=DISABLED, bg=COLOR_PANEL, fg=COLOR_TEXT, insertbackground=COLOR_TEXT)

        tb.Button(
            frame,
            text="Очистить лог",
            command=self._on_clear_log,
            bootstyle="secondary-outline",
            width=15,
        ).pack(anchor=W, pady=(10, 0))

        self.log("Colonial Helper готов к работе", "info")

    # ============================================================
    #  Статус-бар внизу
    # ============================================================
    def _build_status_bar(self):
        self.bottom_status = tb.Label(
            self.root,
            text="Готов",
            font=("Consolas", 9),
            foreground=COLOR_MUTED,
            anchor=W,
            padding=5,
        )
        self.bottom_status.pack(fill=X, side=BOTTOM)

    # ============================================================
    #  Логирование
    # ============================================================
    def log(self, message: str, level: str = "info"):
        colors = {
            "info": COLOR_CYAN,
            "success": COLOR_GREEN,
            "error": COLOR_RED,
            "warn": COLOR_ORANGE,
        }
        color = colors.get(level, COLOR_TEXT)
        timestamp = datetime.now().strftime("%H:%M:%S")
        line = f"[{timestamp}] {message}\n"

        self.log_text.text.config(state=NORMAL)
        self.log_text.text.insert(END, line)
        end_idx = self.log_text.text.index(END)
        start_idx = f"{end_idx} linestart -1 lines"
        tag_name = f"log_{level}_{timestamp.replace(':','')}"
        self.log_text.text.tag_add(tag_name, start_idx, f"{start_idx} lineend")
        self.log_text.text.tag_config(tag_name, foreground=color)
        self.log_text.text.see(END)
        self.log_text.text.config(state=DISABLED)

        # Также в оверлей
        self.overlay_manager.log(message, level)

    # ============================================================
    #  Статус подключения
    # ============================================================
    def set_connection_status(self, online: bool, detail: str = ""):
        if online:
            self.status_dot.config(foreground=COLOR_GREEN)
            self.status_text.config(text="● Подключено", foreground=COLOR_GREEN)
            self.status_detail.config(text=detail or "Готов к работе")
            self.auth_result.config(text=f"✓ Подключено как {detail}", foreground=COLOR_GREEN)
        else:
            self.status_dot.config(foreground=COLOR_RED)
            self.status_text.config(text="○ Не подключено", foreground=COLOR_RED)
            self.status_detail.config(text=detail or "Введите API токен")
            if detail and "ошибка" in detail.lower():
                self.auth_result.config(text=f"✗ {detail}", foreground=COLOR_RED)

    # ============================================================
    #  Конфиг
    # ============================================================
    def load_config(self):
        if self.config_path.exists():
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    self.config = json.load(f)
                self.api.token = self.config.get("token", "")
                self.journal_path = Path(self.config.get("journal_path", str(DEFAULT_JOURNAL_PATH)))
                # Восстанавливаем Raven Colonial ключ
                raven_key = self.config.get("raven_colonial_key", "")
                if raven_key and hasattr(self, 'raven_api'):
                    self.raven_api.set_key(raven_key)
            except Exception:
                self.config = {}
        else:
            self.config = {}

    def save_config(self):
        self.config["token"] = self.api.token
        self.config["journal_path"] = str(self.journal_path)
        # Поле ввода могло быть изменено (вставлен/вписан новый ключ), но
        # пользователь мог не нажать "Проверить" перед закрытием приложения —
        # раньше в этом случае self.raven_api.api_key оставался старым (или
        # пустым), и введённый ключ молча терялся. Синхронизируем перед
        # каждым сохранением конфига, а не только после проверки ключа.
        if hasattr(self, "raven_key_entry"):
            try:
                entry_key = self.raven_key_entry.get().strip()
            except Exception:
                entry_key = ""
            if entry_key and entry_key != self.raven_api.api_key:
                self.raven_api.set_key(entry_key)
        self.config["raven_colonial_key"] = self.raven_api.api_key
        if hasattr(self, "edsm_key_entry"):
            self.edsm_api.set_credentials(self.edsm_key_entry.get(), self.edsm_name_entry.get())
        self.config["edsm_api_key"] = self.edsm_api.api_key
        self.config["edsm_commander_name"] = self.edsm_api.commander_name
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            self.log(f"Не удалось сохранить конфиг: {e}", "warn")
        # Сохраняем и настройки оверлея
        self.overlay_manager.save_settings()

    def _on_close(self):
        self.overlay_manager.stop()
        self.save_config()
        self.root.destroy()

    # ============================================================
    #  Обработчики: Подключение
    # ============================================================
    def _on_validate_token(self):
        token = self.token_entry.get().strip()
        if not token:
            self.set_connection_status(False, "Токен не введён")
            self.log("Введите API токен", "error")
            return

        self.log("Проверка токена...", "info")
        self.bottom_status.config(text="Проверка токена...")
        self.root.update_idletasks()

        result = self.api.validate_token(token)
        if result["ok"]:
            self.set_connection_status(True, self.api.display_name)
            self.log(f"Авторизован как {self.api.display_name}", "success")
            self.save_config()
            if not self.watcher_active:
                self.root.after(300, self._auto_start_watcher)
        else:
            self.set_connection_status(False, result.get("error", "Ошибка"))
            self.log(f"Ошибка: {result.get('error')}", "error")

        self.bottom_status.config(text="Готов")

    def _auto_validate(self):
        self._on_validate_token()

    def _auto_start_watcher(self):
        if self.watcher_active or not self.api.is_connected:
            return
        self._start_watcher()

    def _on_paste_token(self):
        if pyperclip is None:
            self.log("Модуль pyperclip не установлен. Установите: pip install pyperclip", "error")
            return
        try:
            text = pyperclip.paste()
            if text and text.strip():
                self.token_entry.delete(0, END)
                self.token_entry.insert(0, text.strip())
                self.log("Токен вставлен из буфера обмена", "success")
            else:
                self.log("Буфер обмена пуст", "warn")
        except Exception as e:
            self.log(f"Ошибка вставки: {e}", "error")

    def _toggle_token_visibility(self):
        current = self.token_entry.cget("show")
        if current == "":
            self.token_entry.config(show="•")
            self.toggle_token_btn.config(text="Показать")
        else:
            self.token_entry.config(show="")
            self.toggle_token_btn.config(text="Скрыть")

    def _on_check_raven(self):
        key = self.raven_key_entry.get().strip()
        if not key:
            self.raven_status_label.config(text="Raven Colonial: ключ пустой", foreground="#f85149")
            self.log("Raven Colonial API ключ пустой", "warn")
            return
        self.raven_api.set_key(key)
        self.config["raven_colonial_key"] = key
        self.save_config()
        self.raven_status_label.config(text="Raven Colonial: проверка...", foreground="#d29922")
        self.log("Raven Colonial: проверка ключа...", "info")
        # Асинхронная проверка ключа через API
        threading.Thread(target=self._check_raven_key_async, args=(key,), daemon=True).start()

    def _check_raven_key_async(self, key: str):
        try:
            import requests
            # Проверяем ключ через корневой endpoint /api
            # 200 = ключ валиден, 401 = ключ неверный, остальное = ошибка
            resp = requests.get(
                "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api",
                headers={"rcc-key": key},
                timeout=10,
            )
            if resp.status_code == 200:
                self.root.after(0, lambda: self.raven_status_label.config(
                    text="Raven Colonial: подключено", foreground="#3fb950"
                ))
                self.root.after(0, lambda: self.log("Raven Colonial: ключ действителен", "success"))
            elif resp.status_code == 401:
                self.root.after(0, lambda: self.raven_status_label.config(
                    text="Raven Colonial: ключ неверный", foreground="#f85149"
                ))
                self.root.after(0, lambda: self.log("Raven Colonial: ключ неверный (401)", "error"))
            else:
                # 404 или другой код — возможно endpoint другой, но ключ может быть валидным
                # Пробуем альтернативный endpoint /api/system/0/0
                resp2 = requests.get(
                    "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api/system/0/0",
                    headers={"rcc-key": key},
                    timeout=10,
                )
                if resp2.status_code in (200, 404):
                    # 404 = проект не найден, но доступ есть (ключ валиден)
                    self.root.after(0, lambda: self.raven_status_label.config(
                        text="Raven Colonial: подключено", foreground="#3fb950"
                    ))
                    self.root.after(0, lambda: self.log("Raven Colonial: ключ действителен", "success"))
                elif resp2.status_code == 401:
                    self.root.after(0, lambda: self.raven_status_label.config(
                        text="Raven Colonial: ключ неверный", foreground="#f85149"
                    ))
                    self.root.after(0, lambda: self.log("Raven Colonial: ключ неверный (401)", "error"))
                else:
                    self.root.after(0, lambda: self.raven_status_label.config(
                        text=f"Raven Colonial: ошибка {resp2.status_code}", foreground="#f85149"
                    ))
                    self.root.after(0, lambda: self.log(f"Raven Colonial: ошибка {resp2.status_code}", "error"))
        except Exception as e:
            self.root.after(0, lambda: self.raven_status_label.config(
                text="Raven Colonial: сетевая ошибка", foreground="#f85149"
            ))
            self.root.after(0, lambda: self.log(f"Raven Colonial: сетевая ошибка: {e}", "error"))

    def _on_browse_journal_path(self):
        path = filedialog.askdirectory(initialdir=str(self.journal_path))
        if path:
            self.journal_path = Path(path)
            self.path_entry.delete(0, END)
            self.path_entry.insert(0, str(self.journal_path))
            self.save_config()

    # ============================================================
    #  Обработчики: Загрузка
    # ============================================================
    def _on_select_files(self):
        files = filedialog.askopenfilenames(
            initialdir=str(self.journal_path),
            filetypes=[("Journal logs", "*.log"), ("All files", "*.*")],
        )
        if files:
            # Диалог выбора файлов не гарантирует хронологический порядок
            # (зависит от порядка клика/ОС), а последовательный diff
            # (Cargo/ColonisationContribution/CargoDepot) обязан обрабатывать
            # файлы строго по времени — иначе снапшоты состояния (last_cargo,
            # last_depot_state, last_contribution_state) собьются и часть
            # доставок будет посчитана неверно или пропущена. Имена файлов
            # журнала ED (Journal.YYYY-MM-DDThhmmss.NN.log) сортируются
            # лексикографически так же, как и хронологически.
            self.selected_files = sorted((Path(f) for f in files), key=lambda p: p.name)
            self.files_label.config(text=f"Выбрано файлов: {len(self.selected_files)}")
            self.upload_btn.config(state=NORMAL)
            self.log(f"Выбрано {len(self.selected_files)} файлов", "info")

    def _on_upload(self):
        if not self.selected_files:
            return
        if not self.api.is_connected:
            self.log("Сначала введите и проверьте API токен", "error")
            return

        self.upload_btn.config(state=DISABLED)
        self.progress["value"] = 0
        self.progress_label.config(text="Обработка...")
        self.root.update_idletasks()

        threading.Thread(target=self._do_upload_thread, daemon=True).start()

    def _read_file_text(self, filepath: Path) -> str:
        with open(filepath, "r", encoding="utf-8") as fh:
            return fh.read()

    @staticmethod
    def _delivery_for_api(d: dict) -> dict:
        """Payload для основного API (/api/logs/upload).

        `system_address` — поле, добавленное локально для группировки
        доставок по Raven Colonial (сторонний API, raven-colonial.com), и
        никогда не было частью схемы, которую ожидает основной сервер
        (ed-ring-colony.vercel.app). Если там Zod-схема строгая
        (.strict()) — отправка неизвестного поля роняет запрос целиком
        ошибкой валидации, что выглядит как "ошибка загрузки логов".
        Поэтому наружу уходит только исторически ожидаемый набор полей, а
        system_address остаётся только во внутреннем представлении
        (используется для Raven Colonial и не покидает этот процесс).
        """
        return {
            "system_name": d.get("system_name"),
            "commodity": d.get("commodity"),
            "amount": d.get("amount"),
            "delivered_at": d.get("delivered_at"),
            "market_id": d.get("market_id"),
            "is_hub": d.get("is_hub"),
            "route_system_id": d.get("route_system_id"),
            "source_hash": d.get("source_hash"),
        }

    def _format_import_summary(self, files_count: int, event_counts: "Counter", deliveries: list, elapsed: float) -> str:
        """Собрать текст итоговой таблицы импорта (моноширинный текст)."""
        total_events = sum(event_counts.values())
        total_tons = sum(d.get("amount", 0) for d in deliveries)
        width = 44
        lines = []
        lines.append("═" * width)
        lines.append(" ИТОГИ ИМПОРТА")
        lines.append("─" * width)
        lines.append(f" Файлов обработано:      {files_count}")
        lines.append(f" Событий прочитано:      {total_events}")
        lines.append(f" Найдено доставок:       {len(deliveries)}")
        lines.append(f" Общий вес доставок:     {total_tons:.0f} t")
        lines.append(f" Время обработки:        {elapsed:.1f} с")
        if event_counts:
            lines.append("─" * width)
            lines.append(" События по типам:")
            name_width = min(34, max((len(k) for k in event_counts), default=10) + 1)
            for name, count in sorted(event_counts.items(), key=lambda kv: (-kv[1], kv[0])):
                lines.append(f"   {name:<{name_width}} {count:>7}")
        lines.append("═" * width)
        return "\n".join(lines)

    def log_block(self, text: str, level: str = "info"):
        """Вставить многострочный блок текста в лог одним куском, без
        временной метки на каждой строке (в отличие от log()) — используется
        для итоговой таблицы импорта."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        colors = {
            "info": COLOR_CYAN,
            "success": COLOR_GREEN,
            "error": COLOR_RED,
            "warn": COLOR_ORANGE,
        }
        color = colors.get(level, COLOR_TEXT)
        block = f"[{timestamp}]\n{text}\n"

        self.log_text.text.config(state=NORMAL)
        self.log_text.text.insert(END, block)
        end_idx = self.log_text.text.index(END)
        line_count = block.count("\n")
        start_idx = f"{end_idx} linestart -{line_count} lines"
        tag_name = f"log_{level}_{timestamp.replace(':', '')}_block"
        self.log_text.text.tag_add(tag_name, start_idx, f"{start_idx} lineend +{line_count - 1} lines")
        self.log_text.text.tag_config(tag_name, foreground=color)
        self.log_text.text.see(END)
        self.log_text.text.config(state=DISABLED)

    # Сколько файлов держим в памяти одновременно (текст файла + пул чтения).
    # При выборе всей истории журналов (сотни файлов) чтение и хранение ВСЕХ
    # текстов разом могло съедать сотни МБ/несколько ГБ памяти одновременно —
    # с большим количеством файлов это может быть первопричиной сбоя загрузки
    # на менее мощных машинах. Обрабатываем файлы пачками: пока парсится
    # текущая пачка, read-память предыдущей уже освобождена.
    _UPLOAD_BATCH_SIZE = 40

    def _do_upload_thread(self):
        all_deliveries = []
        cmdr_name = None
        total_event_counts: Counter = Counter()
        files_processed = 0
        t_start = time.time()

        # Хронологический порядок уже гарантирован сортировкой в
        # _on_select_files, но подстрахуемся и здесь на случай, если
        # selected_files когда-нибудь будет заполняться иначе.
        files = sorted(self.selected_files, key=lambda p: p.name)
        total = len(files)
        batch_size = self._UPLOAD_BATCH_SIZE

        self.root.after(
            0,
            lambda t=total: self.log(
                f"Начинаю обработку {t} файлов" + (f" (пачками по {batch_size})" if t > batch_size else "") + "...",
                "info",
            ),
        )

        processed_count = 0
        for batch_start in range(0, total, batch_size):
            batch_files = files[batch_start: batch_start + batch_size]

            # 1) Параллельно читаем содержимое файлов ТЕКУЩЕЙ ПАЧКИ с диска —
            # I/O-bound операция (особенно медленная, если папка Saved Games
            # синхронизируется через OneDrive/облако). Пачками — чтобы не
            # держать в памяти сразу тексты всех выбранных файлов, если их
            # сотни (например, вся история игры).
            batch_texts: List[Optional[str]] = [None] * len(batch_files)
            with ThreadPoolExecutor(max_workers=min(8, len(batch_files)) or 1) as pool:
                future_to_idx = {
                    pool.submit(self._read_file_text, f): i for i, f in enumerate(batch_files)
                }
                for fut in as_completed(future_to_idx):
                    idx = future_to_idx[fut]
                    try:
                        batch_texts[idx] = fut.result()
                    except Exception as e:
                        self.root.after(
                            0,
                            lambda n=batch_files[idx].name, e=e: self.log(f"Ошибка чтения {n}: {e}", "error"),
                        )

            # 2) Сам разбор ТЕКУЩЕЙ ПАЧКИ — CPU-bound и стейтфул
            # (Cargo/ColonisationContribution diff зависят от порядка),
            # поэтому строго последовательно, в хронологическом порядке.
            for offset, filepath in enumerate(batch_files):
                text = batch_texts[offset]
                processed_count += 1
                if text is None:
                    continue  # ошибка чтения уже залогирована выше
                self.root.after(0, lambda n=filepath.name: self.log(f"Обработка {n}...", "info"))
                try:
                    self._send_edsm_text(text)
                    current_system = self.ship.state.current_system if self.ship.state else None
                    current_system_address = self.ship.state.system_address if self.ship.state else 0
                    (
                        cname, deliveries, self._last_cargo, self._last_depot_state,
                        self._last_contribution_state, self._seen_events, event_counts,
                    ) = parse_journal(
                        text, current_system, self._last_cargo, self._last_depot_state,
                        self._last_contribution_state, self._seen_events, current_system_address,
                    )
                    total_event_counts.update(event_counts)
                    files_processed += 1
                    # Проверка: все файлы от одного командира
                    if cname:
                        if cmdr_name is None:
                            cmdr_name = cname
                        elif cname != cmdr_name:
                            self.root.after(
                                0,
                                lambda n=filepath.name, c=cname, expected=cmdr_name: self.log(
                                    f"Предупреждение: {n} принадлежит CMDR '{c}', ожидался '{expected}'. Файл пропущен.",
                                    "warn",
                                ),
                            )
                            continue
                    all_deliveries.extend(deliveries)
                    self.root.after(
                        0,
                        lambda n=filepath.name, d=len(deliveries), e=sum(event_counts.values()): self.log(
                            f"{n}: {e} событий, найдено {d} доставок", "success"
                        ),
                    )
                    for d in deliveries:
                        if self.route.mark_visited(d["system_name"]):
                            self.root.after(0, self._refresh_route_tree)
                except Exception as e:
                    self.root.after(
                        0, lambda n=filepath.name, e=e: self.log(f"Ошибка обработки {n}: {e}", "error")
                    )

                # Отдаём под загрузку/парсинг 0-90%, оставшиеся 10% — под отправку на сервер.
                progress_val = processed_count / total * 90
                self.root.after(0, lambda v=progress_val: self.progress.config(value=v))

            # Освобождаем память пачки явно перед чтением следующей.
            del batch_texts

        elapsed = time.time() - t_start
        try:
            summary_text = self._format_import_summary(files_processed, total_event_counts, all_deliveries, elapsed)
            self.root.after(0, lambda s=summary_text: self.log_block(s, "info"))
        except Exception as e:
            # Сама таблица — это просто отображение в логе; ошибка её
            # форматирования не должна прерывать процесс загрузки доставок.
            self.root.after(0, lambda e=e: self.log(f"Не удалось построить сводную таблицу: {e}", "warn"))

        self._record_session_deliveries(all_deliveries)
        if not all_deliveries:
            self.root.after(0, lambda: self.log("Доставки не найдены", "warn"))
            self.root.after(0, lambda: self.upload_btn.config(state=NORMAL))
            self.root.after(0, lambda: self.progress.config(value=0))
            self.root.after(0, lambda: self.progress_label.config(text=""))
            return

        self.root.after(
            0,
            lambda: self.log(f"Всего доставок: {len(all_deliveries)}. Отправка...", "info"),
        )
        self.root.after(
            0,
            lambda: self.progress_label.config(text=f"Отправка {len(all_deliveries)} записей..."),
        )

        try:
            result = self.api.upload_deliveries(
                [self._delivery_for_api(d) for d in all_deliveries], cmdr_name
            )
        except Exception as e:
            # Подстраховка: api_client уже ловит сетевые и JSON-ошибки сам,
            # но если сюда всё же прилетит что-то неожиданное — не оставляем
            # кнопку/прогресс-бар в подвешенном состоянии.
            self.root.after(
                0, lambda e=e: self.log(f"Непредвиденная ошибка при отправке: {e}", "error")
            )
            self.root.after(
                0, lambda e=str(e): self.progress_label.config(text=f"Ошибка: {e[:100]}")
            )
            self.root.after(0, lambda: self.progress.config(value=0))
            self.root.after(0, lambda: self.upload_btn.config(state=NORMAL))
            return

        self.root.after(0, lambda: self.progress.config(value=100))

        if result["ok"]:
            inserted = result['inserted']
            route_deliveries = [d for d in all_deliveries if self.route.is_on_route(d["system_name"])]
            route_tons = sum(d.get("amount", 0) for d in route_deliveries)
            self._send_deliveries_to_raven(all_deliveries, cmdr_name or "")
            self.root.after(
                0,
                lambda ins=inserted, rt=route_tons: self.log(
                    f"Готово! Загружено: {ins} записей ({rt:.0f}t на маршрут)", "success"
                ),
            )
            self.root.after(
                0,
                lambda ins=inserted, rt=route_tons: self.progress_label.config(
                    text=f"Загружено: {ins} записей ({rt:.0f}t на маршрут)"
                ),
            )
        else:
            # result может быть "partial" (часть чанков доставок всё же
            # загрузилась) — не теряем эту информацию молча и хотя бы
            # засчитываем то, что реально попало на сервер.
            inserted = result.get("inserted", 0) or 0
            if inserted:
                self._session_deliveries += inserted
            error_text = str(result.get("error", "неизвестная ошибка"))
            self.root.after(
                0,
                lambda e=error_text, ins=inserted: self.log(
                    f"Ошибка загрузки"
                    + (f" (частично загружено {ins} записей)" if ins else "")
                    + f": {e}",
                    "error",
                ),
            )
            # Раньше здесь была нераскрывающая суть надпись "Ошибка загрузки" —
            # с ней в интерфейсе не видно, что именно пошло не так, не открывая
            # вкладку "Лог". Показываем хотя бы начало реального текста ошибки.
            self.root.after(
                0,
                lambda e=error_text: self.progress_label.config(
                    text=f"Ошибка: {e[:100]}"
                ),
            )
        self.root.after(0, lambda: self.upload_btn.config(state=NORMAL))

    # ============================================================
    #  Watcher
    # ============================================================
    def _on_toggle_watcher(self):
        if self.watcher_active:
            self._stop_watcher()
        else:
            self._start_watcher()

    def _start_watcher(self):
        if not self.api.is_connected:
            self.log("Сначала введите API токен", "error")
            return
        if not self.journal_path.exists():
            self.log(f"Папка не найдена: {self.journal_path}", "error")
            return

        self.watcher_active = True
        self.watcher_stop_event.clear()
        # Сброс счётчиков сессии
        self._session_deliveries = 0
        self._session_cargo_tons = 0.0
        self._session_route_deliveries = 0
        self._session_route_cargo_tons = 0.0
        self._session_construction_cargo_tons = 0.0
        self._session_systems_visited.clear()
        self._last_cargo = {}
        self._last_depot_state = {}
        self._last_contribution_state = {}
        self._seen_events = set()
        self._last_delivery_system = ""
        # CMDR из уже проверенного токена (если сервер его вернул) — используется
        # как основа для всех тиков watcher'а, пока журнал не назовёт другого CMDR.
        self._watcher_cmdr_name = self.api.cmdr_name
        self._pending_watcher_deliveries = []

        self._auto_load_navroute()

        # Определяем текущую систему CMDR ДО старта потока watcher'а.
        # Иначе, если приложение запущено, когда игрок уже находится в
        # системе (нет свежих FSDJump/Location/Docked с момента запуска),
        # current_system/system_address останутся пустыми, и
        # parse_journal() будет отбрасывать все доставки до первого
        # прыжка/стыковки (там есть проверка "if current_system:").
        detected_system, detected_addr = self._determine_cmdr_system()
        if detected_system:
            self.ship.state.current_system = detected_system
            if detected_addr:
                self.ship.state.system_address = detected_addr
            self.log(f"Текущая система CMDR: {detected_system}", "info")
        else:
            self.log(
                "Не удалось определить текущую систему CMDR из журналов — "
                "будет определена по первому FSDJump/Location/Docked событию.",
                "warn",
            )

        self.watcher_btn.config(text="⏹ Остановить", bootstyle="danger-outline")
        self.log("Watcher запущен. Мониторинг журналов...", "success")
        self.bottom_status.config(text="Watcher: активен")
        self.overlay_manager.log("Watcher запущен", "success")

        self.watcher_thread = threading.Thread(target=self._watcher_loop, daemon=True)
        self.watcher_thread.start()

        # Сразу загружаем текущее состояние: сначала Loadout (базовая конфигурация),
        # потом JSON-файлы (текущее состояние — может уточнить систему из Status.json,
        # если он новее данных из журнала).
        self._load_latest_loadout()
        self._load_current_state_files()

    def _send_edsm_text(self, text: str):
        if not self.edsm_api.enabled:
            return
        for line in text.splitlines():
            try:
                event = json.loads(line)
                self._send_edsm_event(event)
                self._send_carrier_event_to_raven(event)
            except (ValueError, TypeError):
                continue

    def _send_edsm_event(self, event: dict):
        if not self.edsm_api.enabled or event.get("event") not in {
            "Location", "FSDJump", "Docked", "Scan", "FSSDiscoveryScan", "SAAScanComplete",
        }:
            return
        key = f"{event.get('timestamp', '')}:{event.get('event', '')}:{event.get('SystemAddress', '')}:{event.get('BodyID', '')}"
        if key in self._edsm_seen_events:
            return
        self._edsm_seen_events.add(key)
        threading.Thread(target=self.edsm_api.submit_event, args=(dict(event),), daemon=True).start()

    def _auto_load_navroute(self) -> bool:
        """Автоматически загрузить свежий NavRoute.json из папки журналов."""
        candidates = [self.journal_path / "NavRoute.json", self.journal_path.parent / "NavRoute.json"]
        for path in candidates:
            try:
                if path.exists():
                    mtime = path.stat().st_mtime
                    if mtime == self._navroute_mtime:
                        return bool(self.route.systems)
                    with open(path, "r", encoding="utf-8-sig") as fh:
                        payload = json.load(fh)
                    route = (payload.get("Route") or payload.get("NavRoute") or []) if isinstance(payload, dict) else []
                    if route:
                        self._navroute_mtime = mtime
                        self.route.load_from_navroute(payload)
                        self.root.after(0, self._refresh_route_tree)
                        self.route.refresh_next_system_info(force=True)
                        self.root.after(0, lambda n=len(route), p=path: self.log(f"NavRoute загружен автоматически: {n} систем ({p.name})", "success"))
                        return True
            except Exception as exc:
                self.root.after(0, lambda e=exc: self.log(f"Не удалось загрузить NavRoute: {e}", "warn"))
        return False

    def _determine_cmdr_system(self) -> tuple:
        """Найти последнюю известную систему CMDR, просматривая journal-файлы
        с конца (самые свежие файлы и строки — в первую очередь).

        Возвращает (star_system, system_address) — любое из значений может
        быть None/0, если найти не удалось.
        """
        try:
            files = sorted(
                self.journal_path.glob("Journal.*.log"),
                key=lambda f: f.stat().st_mtime,
                reverse=True,
            )
        except Exception:
            return None, 0

        for f in files:
            try:
                with open(f, "r", encoding="utf-8") as fh:
                    lines = fh.readlines()
            except Exception:
                continue
            for line in reversed(lines):
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if ev.get("event") in ("Location", "FSDJump", "Docked", "CarrierJump"):
                    sys_name = ev.get("StarSystem")
                    if sys_name:
                        sys_addr = ev.get("SystemAddress")
                        return sys_name, int(sys_addr) if sys_addr else 0
        return None, 0

    def _load_current_state_files(self):
        """Прочитать текущие JSON-файлы состояния (Status, ModulesInfo, Cargo)."""
        loaded = []
        st = self.ship.state
        try:
            status_file = self.journal_path / "Status.json"
            if status_file.exists():
                with open(status_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # Напрямую обновляем состояние корабля
                fuel = data.get("Fuel")
                if fuel and isinstance(fuel, dict):
                    st.fuel_level = float(fuel.get("FuelMain", 0))
                    st.fuel_reservoir = float(fuel.get("FuelReservoir", 0))
                pips = data.get("Pips")
                if pips and isinstance(pips, list) and len(pips) >= 3:
                    st.pips_sys = int(pips[0])
                    st.pips_eng = int(pips[1])
                    st.pips_wep = int(pips[2])
                st.flags = int(data.get("Flags", 0))
                st.flags2 = int(data.get("Flags2", 0))
                st.balance = int(data.get("Balance", 0))
                st.legal_state = str(data.get("LegalState", "Clean"))
                st.fire_group = int(data.get("FireGroup", 0))
                st.gui_focus = int(data.get("GuiFocus", 0))
                cargo = data.get("Cargo")
                if cargo is not None:
                    st.cargo_count = int(cargo)
                dest = data.get("Destination")
                if dest and isinstance(dest, dict):
                    st.destination_system = str(dest.get("System", ""))
                    st.destination_body = str(dest.get("Body", ""))
                    st.destination_name = str(dest.get("Name", ""))
                # HullHealth / ShieldHealth (если есть в новых версиях Status.json)
                hh = data.get("HullHealth")
                if hh is not None:
                    st.hull_health = float(hh)
                sh = data.get("ShieldHealth")
                if sh is not None:
                    st.shield_health = float(sh)
                # Текущая система из Status.json (fallback если нет Location/FSDJump в журнале)
                star_system = data.get("StarSystem")
                if star_system:
                    st.current_system = star_system
                loaded.append("Status")
        except Exception as e:
            self.root.after(0, lambda e=e: self.log(f"Ошибка чтения Status.json: {e}", "warn"))
        try:
            modules_file = self.journal_path / "ModulesInfo.json"
            if modules_file.exists():
                with open(modules_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # Напрямую обновляем модули
                for m in data.get("Modules", []):
                    slot = str(m.get("Slot", ""))
                    if not slot:
                        continue
                    if slot not in st.modules:
                        from ship_tracker import ShipModule
                        st.modules[slot] = ShipModule(slot=slot, name=str(m.get("Item", "Unknown")))
                    health = m.get("Health")
                    if health is not None:
                        # Не "чиним" модули из устаревшего JSON:
                        # ModulesInfo.json обновляется редко и может содержать
                        # health=1.0 для всех модулей. Принимаем только если
                        # новый health <= текущего (модуль повредился дальше).
                        new_health = float(health)
                        current_health = st.modules[slot].health
                        if new_health <= current_health:
                            st.modules[slot].health = new_health
                    power = m.get("Power")
                    if power is not None:
                        st.modules[slot].power = float(power)
                    if m.get("On") is not None:
                        st.modules[slot].on = bool(m.get("On"))
                    if m.get("Engineering") is not None:
                        st.modules[slot].engineered = bool(m.get("Engineering"))
                    priority = m.get("Priority")
                    if priority is not None:
                        st.modules[slot].priority = int(priority)
                    item = m.get("Item")
                    if item is not None:
                        st.modules[slot].name = str(item)
                # Пересчитать энергопотребление и мощность PowerPlant
                used = 0.0
                for m in st.modules.values():
                    if m.on and m.power > 0:
                        used += m.power
                st.power_used = round(used, 3)
                pp = st.modules.get("PowerPlant")
                if pp and "size" in pp.name:
                    try:
                        size = int(pp.name.split("size")[1].split("_")[0])
                        cls = 1
                        if "class" in pp.name:
                            cls = int(pp.name.split("class")[1].split("_")[0])
                        base = {1: 1.20, 2: 1.50, 3: 2.00, 4: 3.00,
                                5: 5.00, 6: 7.00, 7: 10.00, 8: 12.00}.get(size, size * 1.5)
                        mult = 1.0 + (cls - 1) * (1.0 / 6.0)
                        st.power_capacity = round(base * mult, 2)
                    except (IndexError, ValueError):
                        pass
                loaded.append("ModulesInfo")
                damaged = sum(1 for m in st.modules.values() if m.health < 1.0)
                self.root.after(
                    0,
                    lambda: self.log(
                        f"Модули: {len(st.modules)} шт., повреждено: {damaged}, "
                        f"энергия: {st.power_used:.2f}/{st.power_capacity:.2f} MW",
                        "info",
                    ),
                )
        except Exception as e:
            self.root.after(0, lambda e=e: self.log(f"Ошибка чтения ModulesInfo.json: {e}", "warn"))
        try:
            cargo_file = self.journal_path / "Cargo.json"
            if cargo_file.exists():
                with open(cargo_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                count = data.get("Count")
                if count is not None:
                    st.cargo_count = int(count)
                # Inventory для CargoOverlay
                st.inventory = data.get("Inventory", [])
                loaded.append("Cargo")
        except Exception as e:
            self.root.after(0, lambda e=e: self.log(f"Ошибка чтения Cargo.json: {e}", "warn"))
        if loaded:
            self.root.after(0, lambda: self.log(f"Загружено состояние: {', '.join(loaded)}", "info"))

    def _load_latest_loadout(self):
        """Найти и применить последнее событие Loadout из журналов."""
        try:
            files = list(self.journal_path.glob("Journal.*.log"))
            if not files:
                self.log("Journal-файлы не найдены", "warn")
                return
            # Сортируем по времени изменения (самые свежие в конце)
            files.sort(key=lambda f: f.stat().st_mtime)
            self.log(f"Найдено {len(files)} journal-файлов", "info")
            # Ищем Loadout с конца (в самых свежих файлах)
            for f in reversed(files):
                try:
                    with open(f, "r", encoding="utf-8") as fh:
                        lines = fh.readlines()
                except Exception:
                    continue
                # Ищем последнее Loadout в файле
                last_loadout = None
                for line in lines:
                    line = line.strip()
                    if not line or not line.startswith("{"):
                        continue
                    try:
                        ev = json.loads(line)
                        if ev.get("event") == "Loadout":
                            last_loadout = ev
                    except json.JSONDecodeError:
                        continue
                if last_loadout:
                    ship = last_loadout.get("Ship", "")
                    modules = last_loadout.get("Modules", [])
                    ship_name = last_loadout.get("ShipName", "").strip()
                    ship_ident = last_loadout.get("ShipIdent", "").strip()
                    if ship and modules:
                        self.ship.parse_event(last_loadout)
                        self.log(
                            f"Loadout загружен из {f.name}: {ship} '{ship_name}' [{ship_ident}] ({len(modules)} мод.)",
                            "info",
                        )
                        return
                    else:
                        self.log(f"Loadout в {f.name} пропущен (нет Ship/Modules)", "warn")
            self.log("Loadout с полными данными не найден", "warn")
        except Exception as e:
            self.log(f"Ошибка поиска Loadout: {e}", "warn")

    def _stop_watcher(self):
        self.watcher_active = False
        self.watcher_stop_event.set()
        self.watcher_btn.config(text="▶ Следить за игрой", bootstyle="success-outline")
        self.log("Watcher остановлен", "info")
        self.bottom_status.config(text="Готов")
        self.overlay_manager.log("Watcher остановлен", "info")

    def _watcher_loop(self):
        self.last_file_mtimes = {}
        for f in sorted(self.journal_path.glob("Journal.*.log"), key=lambda f: f.stat().st_mtime):
            try:
                self.last_file_mtimes[str(f)] = f.stat().st_size
            except Exception:
                pass

        while not self.watcher_stop_event.is_set():
            time.sleep(5)
            if self.watcher_stop_event.is_set():
                break

            # 1. Сначала читаем журналы — события урона в реальном времени
            try:
                files = sorted(self.journal_path.glob("Journal.*.log"), key=lambda f: f.stat().st_mtime)
                for f in files:
                    fpath = str(f)
                    try:
                        current_size = f.stat().st_size
                    except Exception:
                        continue
                    last_size = self.last_file_mtimes.get(fpath, 0)
                    if current_size > last_size:
                        processed = self._process_journal_changes(f, last_size, current_size)
                        # Обновляем только на фактически обработанные байты (полные строки)
                        self.last_file_mtimes[fpath] = last_size + processed
            except Exception as e:
                self.root.after(0, lambda e=e: self.log(f"Watcher ошибка: {e}", "error"))

            # 2. Потом читаем JSON-файлы — НЕ перезаписываем health модулей
            self._load_current_state_files()
            # Frontier перезаписывает NavRoute.json при построении нового
            # маршрута. Подхватываем изменение без ручного импорта.
            self._auto_load_navroute()
            self.route.refresh_next_system_info()

    def _record_session_deliveries(self, deliveries: list):
        """Учесть событие в SESSION сразу после разбора, независимо от ответа API."""
        if not deliveries:
            return
        self._session_deliveries += len(deliveries)
        self._session_cargo_tons += sum(float(d.get("amount", 0) or 0) for d in deliveries)
        route_deliveries = [d for d in deliveries if self.route.is_on_route(d.get("system_name", ""))]
        self._session_route_deliveries += len(route_deliveries)
        self._session_route_cargo_tons += sum(float(d.get("amount", 0) or 0) for d in route_deliveries)
        self._session_construction_cargo_tons += sum(
            float(d.get("amount", 0) or 0) for d in deliveries
            if d.get("source") == "colonisation_contribution"
        )
        self._last_delivery_system = deliveries[-1].get("system_name", self._last_delivery_system)

    def _send_carrier_event_to_raven(self, event: dict):
        if not self.raven_api.is_connected or event.get("event") not in ("MarketSell", "MarketBuy"):
            return
        market_id = event.get("MarketID")
        count = event.get("Count")
        commodity = event.get("Type_Localised") or event.get("Type")
        if not market_id or not count or not commodity:
            return
        # As in SrvSurvey: selling to the FC adds cargo, buying from it removes cargo.
        delta = int(count) if event.get("event") == "MarketSell" else -int(count)
        result = self.raven_api.supply_fc(int(market_id), str(commodity), delta)
        if not result.get("ok"):
            self.root.after(0, lambda e=result.get("error", "unknown"): self.log(f"Raven FC cargo: {e}", "warn"))

    def _send_deliveries_to_raven(self, deliveries: list, cmdr_name: str = ""):
        if not self.raven_api.is_connected:
            return
        batches = {}
        for delivery in deliveries:
            market_id = delivery.get("market_id")
            if not market_id:
                continue
            address = delivery.get("system_address") or (self.ship.state.system_address if self.ship.state else 0)
            if not address:
                continue
            project = self.raven_api.get_project(address, market_id)
            if not project or not project.get("buildId"):
                continue
            build_id = project["buildId"]
            commodity = delivery.get("commodity", "Unknown")
            batches.setdefault(build_id, {})[commodity] = batches.setdefault(build_id, {}).get(commodity, 0) + int(delivery.get("amount", 0))
        for build_id, commodities in batches.items():
            result = self.raven_api.contribute(build_id, cmdr_name or "Unknown", commodities)
            if result.get("ok"):
                self.root.after(0, lambda total=sum(commodities.values()): self.log(f"Raven Colonial: +{total}t", "success"))
            else:
                self.root.after(0, lambda e=result.get("error", "unknown"): self.log(f"Raven Colonial: {e}", "warn"))

    def _process_journal_changes(self, filepath: Path, old_size: int, new_size: int) -> int:
        """Обработать изменения в журнале. Возвращает количество обработанных байт.

        Читает только полные строки (заканчивающиеся на \\n).
        Неполная строка в конце блока остаётся для следующего тика.
        """
        try:
            with open(filepath, "rb") as f:
                f.seek(old_size)
                raw = f.read(new_size - old_size)
        except Exception as e:
            self.root.after(0, lambda e=e: self.log(f"Ошибка чтения {filepath.name}: {e}", "error"))
            return 0

        if not raw:
            return 0

        # Берём только полные строки — до последнего \\n
        last_nl = raw.rfind(b'\n')
        if last_nl == -1:
            # Нет полных строк — ждём следующего тика
            return 0

        # raw[:last_nl] — все полные строки (без последнего \\n, он нам не нужен)
        # +1 чтобы включить \\n в обработанные байты
        processed_bytes = last_nl + 1
        new_text = raw[:processed_bytes].decode("utf-8", errors="replace")

        if not new_text.strip():
            return processed_bytes

        current_system = self.ship.state.current_system if self.ship.state else None
        current_system_address = self.ship.state.system_address if self.ship.state else 0
        tick_cmdr_name, deliveries, self._last_cargo, self._last_depot_state, self._last_contribution_state, self._seen_events, _tick_event_counts = parse_journal(
            new_text, current_system, self._last_cargo, self._last_depot_state,
            self._last_contribution_state, self._seen_events, current_system_address,
        )
        # Commander/LoadGame встречаются обычно только один раз в начале файла,
        # поэтому в большинстве тиков tick_cmdr_name будет None — переиспользуем
        # CMDR, установленный в начале watcher-сессии (или токеном), и валидируем,
        # что новый журнал не принадлежит другому командиру.
        if tick_cmdr_name:
            if self._watcher_cmdr_name and tick_cmdr_name != self._watcher_cmdr_name:
                mismatch_msg = (
                    f"Обнаружен журнал другого CMDR '{tick_cmdr_name}' "
                    f"(ожидался '{self._watcher_cmdr_name}'). Доставки из {filepath.name} пропущены."
                )
                self.root.after(0, lambda m=mismatch_msg: self.log(m, "warn"))
                return processed_bytes
            self._watcher_cmdr_name = tick_cmdr_name
        cmdr_name = self._watcher_cmdr_name
        # ВСЕГДА парсим события для трекинга корабля/маршрута/оверлея
        for line in new_text.splitlines():
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
                self._send_edsm_event(ev)
                self._send_carrier_event_to_raven(ev)
                if ev.get("event") in ("FSDJump", "Location", "Docked", "CarrierJump"):
                    sys_name = ev.get("StarSystem")
                    if sys_name:
                        self._session_systems_visited.add(sys_name)
                        if self.route.mark_visited(sys_name):
                            self.root.after(0, self._refresh_route_tree)
                            self.overlay_manager.log(f"Jump: {sys_name}", "info")
                # Отслеживание корабля
                self.ship.parse_event(ev)
                ev_name = ev.get("event")
                if ev_name in ("HullDamage", "HeatDamage", "ShieldState", "ModuleDamage", "CockpitBreached", "AfmuRepairs", "Repair", "RepairAll"):
                    st = self.ship.state
                    damaged = [f"{m.slot}={m.health:.0%}" for m in st.damaged_modules]
                    dmg_str = f" ({', '.join(damaged)})" if damaged else ""
                    self.overlay_manager.log(
                        f"{ev_name}: hull {st.hull_health:.0%}, shields {st.shield_health:.0%}, "
                        f"damaged {len(st.damaged_modules)} mod.{dmg_str}",
                        "info",
                    )
            except Exception:
                pass

        self._record_session_deliveries(deliveries)

        # Отдельно — аплоад доставок. Не теряем распарсенные строки, если
        # сервер временно занят: парсер уже пометил события как обработанные,
        # поэтому следующий тик сам по себе их больше не повторит.
        upload_deliveries = self._pending_watcher_deliveries + deliveries
        self._pending_watcher_deliveries = []
        if upload_deliveries:
            result = self.api.upload_deliveries(
                [self._delivery_for_api(d) for d in upload_deliveries], cmdr_name
            )
            if result["ok"]:
                inserted = result['inserted']
                route_deliveries = [d for d in upload_deliveries if self.route.is_on_route(d["system_name"])]
                route_tons = sum(d.get("amount", 0) for d in route_deliveries)
                # Сохраняем последнюю систему доставки для оверлея
                if deliveries:
                    self._last_delivery_system = deliveries[-1]["system_name"]
                msg = f"[Watcher] {filepath.name}: +{inserted} deliveries ({route_tons:.0f}t на маршрут)"
                self.root.after(0, lambda m=msg: self.log(m, "success"))
                self.overlay_manager.log(f"+{inserted} deliveries ({route_tons:.0f}t route)", "success")
                for d in deliveries:
                    if self.route.mark_visited(d["system_name"]):
                        self.root.after(0, self._refresh_route_tree)
                # Отправка на Raven Colonial
                if self.raven_api.is_connected:
                    # Группируем доставки по build_id (как в SRV Survey)
                    raven_batches: dict = {}  # build_id -> {commodity: amount}
                    for d in upload_deliveries:
                        # Fleet Carrier cargo is sent through /api/fc/.../cargo,
                        # not as a construction contribution.
                        if d.get("source") == "carrier_delivery":
                            continue
                        market_id = d.get("market_id")
                        if not market_id:
                            continue
                        # Берём систему, зафиксированную В МОМЕНТ этой доставки
                        # (journal_parser проставляет её по SystemAddress из
                        # Location/FSDJump/Docked/CarrierJump на момент события),
                        # а не текущее состояние корабля — к моменту отправки
                        # батча на сервер игрок мог уже прыгнуть в другую систему,
                        # и подстановка "текущей" system_address привела бы к
                        # поиску проекта не в той системе и потере доставки.
                        system_address = d.get("system_address") or (
                            self.ship.state.system_address if self.ship.state else 0
                        )
                        if not system_address:
                            self.root.after(
                                0,
                                lambda c=d.get("commodity", "?"): self.log(
                                    f"Raven Colonial: пропущена доставка '{c}' — не удалось "
                                    f"определить SystemAddress", "warn"
                                ),
                            )
                            continue
                        project = self.raven_api.get_project(system_address, market_id)
                        if project and project.get("buildId"):
                            bid = project["buildId"]
                            if bid not in raven_batches:
                                raven_batches[bid] = {}
                            comm = d["commodity"]
                            raven_batches[bid][comm] = raven_batches[bid].get(comm, 0) + d["amount"]
                    # Отправляем сгруппированные батчи
                    for bid, commodities in raven_batches.items():
                        rc_result = self.raven_api.contribute(
                            bid, cmdr_name or "Unknown", commodities
                        )
                        if rc_result["ok"]:
                            total = sum(commodities.values())
                            self.root.after(
                                0,
                                lambda t=total, n=len(commodities): self.log(
                                    f"Raven Colonial: +{t}t ({n} ресурсов)", "success"
                                ),
                            )
            else:
                # Оставляем события в очереди: следующий тик повторит отправку
                # с тем же source_hash, а сервер безопасно устранит дубли.
                self._pending_watcher_deliveries = upload_deliveries + self._pending_watcher_deliveries
                msg = f"[Watcher] Upload error: {result.get('error')}"
                self.root.after(0, lambda m=msg: self.log(m, "error"))
                self.overlay_manager.log(f"Error: {result.get('error')}", "error")

        return processed_bytes

    # ============================================================
    #  Маршрут
    # ============================================================
    def _on_import_route(self):
        filepath = filedialog.askopenfilename(
            filetypes=[
                ("NavRoute JSON", "NavRoute.json"),
                ("JSON", "*.json"),
                ("CSV", "*.csv"),
                ("All files", "*.*"),
            ],
        )
        if not filepath:
            return

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                text = f.read()

            if filepath.lower().endswith(".csv"):
                self.route.load_from_csv(text)
            else:
                data = json.loads(text)
                if "Route" in data:
                    self.route.load_from_navroute(data)
                elif isinstance(data, list):
                    self.route.systems = [
                        {"index": i + 1, "name": str(s), "status": "pending", "visited_at": None}
                        for i, s in enumerate(data)
                    ]
                else:
                    self.route.load_from_csv(text)

            self._refresh_route_tree()
            self.log(f"Маршрут загружен: {len(self.route.systems)} систем", "success")
        except Exception as e:
            self.log(f"Ошибка импорта маршрута: {e}", "error")

    def _on_export_route(self):
        if not self.route.systems:
            self.log("Нет данных для экспорта", "warn")
            return
        filepath = filedialog.asksaveasfilename(
            defaultextension=".csv",
            filetypes=[("CSV", "*.csv")],
            initialfile="route_export.csv",
        )
        if filepath:
            try:
                csv_text = self.route.export_csv()
                with open(filepath, "w", encoding="utf-8-sig", newline="") as f:
                    f.write(csv_text)
                self.log(f"Маршрут экспортирован: {filepath}", "success")
            except Exception as e:
                self.log(f"Ошибка экспорта: {e}", "error")

    def _on_clear_route(self):
        self.route.clear()
        self._refresh_route_tree()
        self.log("Маршрут очищен", "info")

    def _refresh_route_tree(self):
        for item in self.route_tree.get_children():
            self.route_tree.delete(item)

        if not self.route.systems:
            self.route_counter.config(text="Маршрут не загружен")
            return

        for s in self.route.systems:
            status_label = {
                "visited": "✓ Посещена",
                "current": "● Текущая",
                "pending": "○ Ожидает",
            }.get(s["status"], s["status"])

            visited_str = ""
            if s.get("visited_at"):
                try:
                    dt = datetime.fromisoformat(s["visited_at"])
                    visited_str = dt.strftime("%d.%m.%Y %H:%M")
                except Exception:
                    visited_str = str(s["visited_at"])

            self.route_tree.insert(
                "",
                END,
                values=(s["index"], s["name"], status_label, visited_str),
                tags=(s["status"],),
            )

        self.route_tree.tag_configure("visited", foreground=COLOR_GREEN)
        self.route_tree.tag_configure("current", foreground=COLOR_ORANGE)
        self.route_tree.tag_configure("pending", foreground=COLOR_MUTED)

        visited = self.route.visited_count
        total = len(self.route.systems)
        self.route_counter.config(
            text=f"Всего: {total} | Посещено: {visited} | Осталось: {total - visited}"
        )

    # ============================================================
    #  Лог
    # ============================================================
    def _on_clear_log(self):
        self.log_text.text.config(state=NORMAL)
        self.log_text.text.delete("1.0", END)
        self.log_text.text.config(state=DISABLED)
        self.log("Лог очищен", "info")

    # ============================================================
    #  Утилиты
    # ============================================================
    def after(self, ms: int, callback):
        self.root.after(ms, callback)


def main():
    try:
        try:
            import requests
        except ImportError:
            print("=" * 60)
            print("ОШИБКА: не найден модуль 'requests'")
            print("Решение: pip install requests")
            print("=" * 60)
            sys.exit(1)

        root = None
        try:
            root = tb.Window(themename="darkly")
        except Exception:
            try:
                root = tb.Window()
            except Exception:
                root = tk.Tk()
                root.configure(bg=COLOR_BG)

        root.title(f"{APP_NAME} v{VERSION}")
        app = ColonialHelperApp(root)
        root.mainloop()
    except Exception as e:
        error_file = Path.home() / "colonial_helper_error.log"
        with open(error_file, "w", encoding="utf-8") as f:
            f.write("=" * 60 + "\n")
            f.write(f"КРИТИЧЕСКАЯ ОШИБКА при запуске:\n")
            f.write(f"  {type(e).__name__}: {e}\n")
            f.write("-" * 60 + "\n")
            traceback.print_exc(file=f)
            f.write("=" * 60 + "\n")
        try:
            import tkinter.messagebox as msgbox
            msgbox.showerror(
                "Colonial Helper — Ошибка запуска",
                f"{type(e).__name__}: {e}\n\n"
                f"Подробности сохранены в:\n{error_file}"
            )
        except Exception:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
