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
from tkinter import filedialog, messagebox, simpledialog, ttk
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
from journal_parser import (
    parse_file,          # noqa: F401 — оставлен как публичный API парсера
    parse_journal,       # noqa: F401
    parse_events,
    iter_journal_events,
    extract_construction_events,  # noqa: F401
    ConstructionSnapshotCollector,
    PARSER_VERSION,
)
from route_tracker import RouteTracker
from overlay import OverlayManager, ANCHOR_KEYS, ANCHOR_LABELS
from exobiology import ExobiologyTracker
from edsm_api import EDSMAPI
from inara_api import InaraAPI
from ship_tracker import ShipTracker
from event_dispatch import ThirdPartyDispatcher

# -- Константы --
APP_NAME = "Colonial Helper"
VERSION = "2.2.1"
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
        self.exobiology = ExobiologyTracker()  # тела, биосигналы, образцы (только свой журнал)
        self._last_contribution_state: dict = {}  # { (market_id, resource): amount } для diff
        self._seen_events: set = set()  # ключи событий — защита от дублей
        self._last_delivery_system: str = ""  # последняя система доставки для оверлея
        self._session_event_count = 0
        self._last_session_event = ""
        self._watcher_cmdr_name: Optional[str] = None  # CMDR, привязанный к текущей watcher-сессии
        self._pending_watcher_deliveries: list = []  # очередь повторной отправки при временной ошибке API
        # Накопители для первичной сверки: доставки/snapshots не уходят на сайт
        # после каждого файла (сотни запросов), а отправляются одним пакетом.
        self._defer_uploads = False
        self._backfill_deliveries: list = []
        self._backfill_construction: list = []
        self._navroute_mtime = 0.0

        # Конфиг
        self.config = {}
        self.config_path = Path.home() / ".colonial_helper.json"
        # Отдельное хранилище credentials переживает обновление приложения и
        # не может быть затёрто настройками HUD/overlay.
        self.credentials_path = Path.home() / ".colonial_helper_credentials.json"
        self.load_config()

        # Raven Colonial API
        from raven_colonial_api import RavenColonialAPI
        self.raven_api = RavenColonialAPI(self.config.get("raven_colonial_key", ""))
        self.edsm_api = EDSMAPI(
            self.config.get("edsm_api_key", ""),
            self.config.get("edsm_commander_name", ""),
            app_version=VERSION,
        )
        self.inara_api = InaraAPI(
            self.config.get("inara_api_key", ""),
            self.config.get("inara_commander_name", ""),
            app_version=VERSION,
        )
        # Дедупликация событий для внешних API живёт в self.dispatcher
        # (event_dispatch.py), а не в приложении.
        # Восстанавливаем ключ из конфига (load_config вызывался раньше создания raven_api)
        raven_key = self.config.get("raven_colonial_key", "")
        if raven_key:
            self.raven_api.set_key(raven_key)

        # Внешние API (EDSM / Inara / Raven Colonial) отправляются из
        # фонового диспетчера: см. комментарии в event_dispatch.py. Раньше
        # каждое событие журнала уходило синхронным HTTP-запросом прямо из
        # потока обработки, из-за чего первичная загрузка истории занимала
        # часы при подключённых API.
        self.dispatcher = ThirdPartyDispatcher(
            edsm_api=self.edsm_api,
            inara_api=self.inara_api,
            raven_api=self.raven_api,
            logger=lambda message: self.root.after(0, lambda m=message: self.log(m, "info")),
            # Историю (первичную загрузку) во внешние сервисы не отправляем,
            # если пользователь это явно не включил в настройках.
            backfill_enabled=bool(self.config.get("backfill_send_third_party", False)),
        )
        self.dispatcher.on_result = self._on_third_party_result

        # EDSM требует версию и сборку игры (иначе msgnum 207/208 и событие
        # никуда не попадает). Fileheader стоит в самом начале журнала и в
        # live-тиках уже не встретится, поэтому читаем его отдельно.
        self._detect_game_version()

        # Кэш уже загруженных файлов журнала (локальный, рядом с конфигом).
        # Позволяет не переразбирать и не переотправлять файлы, которые уже
        # были успешно импортированы — повторная первичная загрузка вместо
        # десятков минут занимает секунды.
        self.imported_files_path = self.config_path.with_name(".colonial_helper_imported_files.json")
        self.imported_files: dict = self._load_imported_files()
        self.skip_imported_files = bool(self.config.get("skip_imported_files", True))
        # Прогресс обновляем не чаще, чем раз в _PROGRESS_MIN_INTERVAL секунд:
        # на 800 файлов постоянные root.after() забивали очередь Tkinter и
        # сами по себе тормозили загрузку.
        self._progress_interval = 0.1
        self._last_progress_ts = 0.0

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

        # Фоновый индикатор игры (опрос ~1 раз в 1.5 с, сам монитор
        # кэширует результат, лишних снимков процессов не делается).
        self._game_was_running = False
        self.after(1000, self._tick_game_status)

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

        # Индикатор игры: запущен ли клиент Elite Dangerous и в фокусе ли он.
        game_frame = tb.Frame(frame)
        game_frame.pack(fill=X, pady=(6, 0))

        self.game_dot = tb.Label(game_frame, text="●", font=("Segoe UI", 11), foreground=COLOR_MUTED)
        self.game_dot.pack(side=LEFT, padx=(0, 6))

        self.game_label = tb.Label(
            game_frame,
            text="Игра: проверка…",
            font=("Consolas", 10),
            foreground=COLOR_MUTED,
        )
        self.game_label.pack(side=LEFT)

        self.game_hint = tb.Label(
            game_frame,
            text="",
            font=("Consolas", 9),
            foreground=COLOR_MUTED,
        )
        self.game_hint.pack(side=RIGHT)

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

        self.tab_pilot = tb.Frame(self.notebook)
        self.notebook.add(self.tab_pilot, text=" Пилот ")
        self._build_tab_pilot()

        self.tab_upload = tb.Frame(self.notebook)
        self.notebook.add(self.tab_upload, text=" Загрузка логов ")
        self._build_tab_upload()

        self.tab_route = tb.Frame(self.notebook)
        self.notebook.add(self.tab_route, text=" Маршрут ")
        self._build_tab_route()

        self.tab_colony = tb.Frame(self.notebook)
        self.notebook.add(self.tab_colony, text=" Колонизатор ")
        self._build_tab_colony()

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

        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=20)
        tb.Label(frame, text="Inara API", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))
        tb.Label(frame, text="Необязательно: отправка навигации, стыковок, сканирования и грузовых событий в Inara.", foreground=COLOR_MUTED).pack(anchor=W)
        tb.Label(frame, text="Inara API key", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(8, 2))
        self.inara_key_entry = tb.Entry(frame, width=60, font=("Consolas", 11), show="*")
        self.inara_key_entry.pack(fill=X, pady=(4, 5))
        self.inara_key_entry.insert(0, self.inara_api.api_key)
        tb.Label(frame, text="Имя командира в Inara", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(3, 2))
        self.inara_name_entry = tb.Entry(frame, width=60, font=("Consolas", 11))
        self.inara_name_entry.pack(fill=X, pady=(4, 8))
        self.inara_name_entry.insert(0, self.inara_api.commander_name)
        tb.Button(frame, text="Сохранить Inara настройки", command=self._save_inara_settings, bootstyle="info-outline", width=28).pack(anchor=W)
        self.inara_status_label = tb.Label(frame, text="Inara: включена" if self.inara_api.enabled else "Inara: не настроена", foreground=COLOR_MUTED)
        self.inara_status_label.pack(anchor=W, pady=(5, 0))

    def _save_inara_settings(self):
        self.inara_api.set_credentials(self.inara_key_entry.get(), self.inara_name_entry.get())
        self.config["inara_api_key"] = self.inara_api.api_key
        self.config["inara_commander_name"] = self.inara_api.commander_name
        self.save_config()
        self.inara_status_label.config(text="Inara: включена" if self.inara_api.enabled else "Inara: не настроена")

    def _save_edsm_settings(self):
        self.edsm_api.set_credentials(self.edsm_key_entry.get(), self.edsm_name_entry.get())
        self.config["edsm_api_key"] = self.edsm_api.api_key
        self.config["edsm_commander_name"] = self.edsm_api.commander_name
        self.save_config()
        self.edsm_status_label.config(text="EDSM: включён" if self.edsm_api.enabled else "EDSM: не настроен")

    # ============================================================
    #  Вкладка: Инфографика пилота
    # ============================================================
    def _pilot_card(self, parent, title: str, row: int, column: int):
        card = tb.LabelFrame(parent, text=title, padding=12, bootstyle="secondary")
        card.grid(row=row, column=column, sticky="nsew", padx=6, pady=6)
        return card

    def _pilot_value(self, parent, key: str, text: str = "—", color=COLOR_TEXT):
        label = tb.Label(parent, text=text, font=("Segoe UI", 14, "bold"), foreground=color)
        label.pack(anchor=W, pady=(2, 5))
        self._pilot_values[key] = label
        return label

    def _pilot_metric(self, parent, key: str, title: str, color=COLOR_CYAN):
        row = tb.Frame(parent)
        row.pack(fill=X, pady=3)
        tb.Label(row, text=title, foreground=COLOR_MUTED, width=23, anchor=W).pack(side=LEFT)
        value = tb.Label(row, text="—", font=("Consolas", 10, "bold"), foreground=color, anchor=E)
        value.pack(side=RIGHT)
        self._pilot_values[key] = value

    def _pilot_bar(self, parent, key: str, title: str, color="info"):
        tb.Label(parent, text=title, foreground=COLOR_MUTED).pack(anchor=W, pady=(5, 1))
        bar = tb.Progressbar(parent, mode="determinate", maximum=100, bootstyle=color)
        bar.pack(fill=X, pady=(0, 4))
        self._pilot_bars[key] = bar

    def _build_tab_pilot(self):
        self._pilot_values = {}
        self._pilot_bars = {}
        viewport = tb.Frame(self.tab_pilot)
        viewport.pack(fill=BOTH, expand=True)

        header = tb.Frame(viewport, padding=(15, 12, 15, 4))
        header.pack(fill=X)
        tb.Label(header, text="ИНФОГРАФИКА ПИЛОТА", font=("Consolas", 15, "bold"), foreground=COLOR_ORANGE).pack(side=LEFT)
        tb.Button(header, text="Обновить", command=self._refresh_pilot_infographic, bootstyle="info-outline", width=12).pack(side=RIGHT)
        self._pilot_values["updated"] = tb.Label(header, text="", foreground=COLOR_MUTED)
        self._pilot_values["updated"].pack(side=RIGHT, padx=(0, 12))

        subtitle = tb.Label(
            viewport,
            text="Живые данные из Journal, Ship Tracker, маршрута и текущей сессии. Сетевые запросы для инфографики не выполняются.",
            foreground=COLOR_MUTED,
            wraplength=850,
        )
        subtitle.pack(anchor=W, padx=15, pady=(0, 8))

        grid = tb.Frame(viewport, padding=(9, 0, 9, 9))
        grid.pack(fill=BOTH, expand=True)
        for column in range(2):
            grid.columnconfigure(column, weight=1, uniform="pilot")
        for row in range(3):
            grid.rowconfigure(row, weight=1)

        identity = self._pilot_card(grid, "ПИЛОТ И ПОДКЛЮЧЕНИЯ", 0, 0)
        self._pilot_value(identity, "commander", "CMDR не определён", COLOR_ORANGE)
        self._pilot_metric(identity, "system", "Система")
        self._pilot_metric(identity, "ship", "Корабль")
        self._pilot_metric(identity, "watcher", "Watcher")
        self._pilot_metric(identity, "services", "Сервисы")

        route = self._pilot_card(grid, "МАРШРУТ", 0, 1)
        self._pilot_value(route, "route_status", "Маршрут не загружен", COLOR_CYAN)
        self._pilot_metric(route, "route_current", "Текущая")
        self._pilot_metric(route, "route_next", "Следующая")
        self._pilot_metric(route, "route_remaining", "Осталось")
        self._pilot_bar(route, "route_progress", "Прогресс маршрута", "info")

        ship = self._pilot_card(grid, "СОСТОЯНИЕ КОРАБЛЯ", 1, 0)
        self._pilot_metric(ship, "hull", "Корпус")
        self._pilot_metric(ship, "shield", "Щиты")
        self._pilot_metric(ship, "fuel", "Топливо")
        self._pilot_metric(ship, "power", "Энергия")
        self._pilot_metric(ship, "modules", "Модули")
        self._pilot_bar(ship, "hull_bar", "Корпус", "success")
        self._pilot_bar(ship, "fuel_bar", "Топливо", "warning")

        cargo = self._pilot_card(grid, "ГРУЗ И ЭКОНОМИКА", 1, 1)
        self._pilot_value(cargo, "cargo", "0 / 0 t", COLOR_GREEN)
        self._pilot_bar(cargo, "cargo_bar", "Заполнение трюма", "warning")
        self._pilot_metric(cargo, "balance", "Баланс")
        self._pilot_metric(cargo, "rebuy", "Страховка")
        self._pilot_metric(cargo, "legal", "Правовой статус")
        self._pilot_metric(cargo, "last_delivery", "Последняя доставка")

        session = self._pilot_card(grid, "ТЕКУЩАЯ СЕССИЯ", 2, 0)
        self._pilot_value(session, "session_tons", "0 t", COLOR_GREEN)
        self._pilot_metric(session, "session_deliveries", "Доставки")
        self._pilot_metric(session, "session_route", "На маршруте")
        self._pilot_metric(session, "session_construction", "На стройки")
        self._pilot_metric(session, "session_systems", "Системы посещены")

        activity = self._pilot_card(grid, "АКТИВНОСТЬ И ДАННЫЕ", 2, 1)
        self._pilot_value(activity, "event_summary", "Ожидание событий", COLOR_CYAN)
        self._pilot_metric(activity, "journal_state", "Журналы")
        self._pilot_metric(activity, "raven", "Raven Colonial")
        self._pilot_metric(activity, "edsm", "EDSM")
        self._pilot_metric(activity, "inara", "Inara")
        self._pilot_metric(activity, "last_event", "Последнее событие")

        self._refresh_pilot_infographic()

    @staticmethod
    def _pilot_percent(value) -> float:
        try:
            return max(0.0, min(100.0, float(value or 0)))
        except (TypeError, ValueError):
            return 0.0

    def _refresh_pilot_infographic(self):
        """Обновить инфографику только локальным состоянием приложения."""
        if not hasattr(self, "_pilot_values"):
            return
        try:
            state = self.ship.get_state_dict()
            route_total = len(self.route.systems)
            visited = self.route.visited_count
            route_percent = (visited / route_total * 100) if route_total else 0
            current = self.ship.state.current_system or "—"
            ship_name = state.get("ship_type") or "Корабль не определён"
            services = " / ".join(name for name, enabled in (
                ("ED", self.api.is_connected), ("Raven", self.raven_api.is_connected),
                ("EDSM", self.edsm_api.enabled), ("Inara", self.inara_api.enabled),
            ) if enabled) or "нет подключений"
            cargo = float(state.get("cargo_count", 0) or 0)
            capacity = float(state.get("cargo_capacity", 0) or 0)
            cargo_percent = cargo / capacity * 100 if capacity > 0 else 0
            damaged = int(state.get("damaged_count", 0) or 0)
            total_modules = len(state.get("modules", []))
            event_count = self._session_event_count

            values = {
                "commander": self.api.display_name if self.api.cmdr_name or self.api.email else (self._watcher_cmdr_name or "CMDR не определён"),
                "system": current,
                "ship": ship_name,
                "watcher": "АКТИВЕН" if self.watcher_active else "остановлен",
                "services": services,
                "route_status": f"{visited}/{route_total} систем" if route_total else "Маршрут не загружен",
                "route_current": self._get_overlay_data().get("current", "—"),
                "route_next": self._get_overlay_data().get("next", "—"),
                "route_remaining": str(max(0, route_total - visited)),
                "hull": f"{self._pilot_percent(state.get('hull_percent')):.0f}%",
                "shield": f"{self._pilot_percent(state.get('shield_percent')):.0f}%",
                "fuel": f"{state.get('fuel_level', 0):.1f} / {state.get('fuel_capacity', 0):.1f} t",
                "power": f"{self._pilot_percent(state.get('power_percent')):.0f}%",
                "modules": f"{total_modules - damaged}/{total_modules} исправны",
                "cargo": f"{cargo:.0f} / {capacity:.0f} t",
                "balance": f"{int(state.get('balance', 0) or 0):,} cr".replace(",", " "),
                "rebuy": f"{int(state.get('rebuy', 0) or 0):,} cr".replace(",", " "),
                "legal": state.get("legal_state") or "неизвестно",
                "last_delivery": self._last_delivery_system or "—",
                "session_tons": f"{self._session_cargo_tons:.0f} t",
                "session_deliveries": str(self._session_deliveries),
                "session_route": f"{self._session_route_deliveries} / {self._session_route_cargo_tons:.0f} t",
                "session_construction": f"{self._session_construction_cargo_tons:.0f} t",
                "session_systems": str(len(self._session_systems_visited)),
                "event_summary": f"{event_count} событий" if event_count else "Ожидание событий",
                "journal_state": "watcher читает" if self.watcher_active else "ожидание",
                "raven": "подключён" if self.raven_api.is_connected else "выключен",
                "edsm": "подключён" if self.edsm_api.enabled else "выключен",
                "inara": "подключена" if self.inara_api.enabled else "выключена",
                "last_event": self._last_session_event or "—",
            }
            for key, text in values.items():
                if key in self._pilot_values:
                    self._pilot_values[key].configure(text=text)
            for key, value in {
                "route_progress": route_percent, "hull_bar": self._pilot_percent(state.get("hull_percent")),
                "fuel_bar": self._pilot_percent(state.get("fuel_percent")), "cargo_bar": cargo_percent,
            }.items():
                if key in self._pilot_bars:
                    self._pilot_bars[key].configure(value=value)
            self._pilot_values["updated"].configure(text=datetime.now().strftime("%H:%M:%S"))
        except Exception:
            # Инфографика не должна мешать watcher/UI при неполном состоянии
            # трекера во время самого первого чтения Journal.
            pass
        if self.root.winfo_exists():
            self.root.after(1000, self._refresh_pilot_infographic)

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

        # -- Настройки первичной загрузки --
        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=(15, 10))
        tb.Label(
            frame,
            text="Первичная загрузка (вся история журналов)",
            font=("Segoe UI", 10, "bold"),
        ).pack(anchor=W, pady=(0, 6))

        self.skip_imported_var = tb.BooleanVar(value=self.skip_imported_files)
        tb.Checkbutton(
            frame,
            text="Пропускать файлы, загруженные ранее (быстрый повторный импорт)",
            variable=self.skip_imported_var,
            bootstyle="success-round-toggle",
            command=self._on_skip_imported_changed,
        ).pack(anchor=W)

        self.backfill_third_party_var = tb.BooleanVar(value=bool(self.dispatcher.backfill_enabled))
        tb.Checkbutton(
            frame,
            text="Отправлять историю в EDSM / Inara / Raven Colonial (очень медленно)",
            variable=self.backfill_third_party_var,
            bootstyle="warning-round-toggle",
            command=self._on_backfill_third_party_changed,
        ).pack(anchor=W, pady=(2, 0))

        tb.Label(
            frame,
            text="По умолчанию история отправляется только на ED Ring Colony: внешние сервисы "
                 "получают лишь live-события watcher'а. Отправка тысяч исторических событий "
                 "в EDSM/Inara/Raven — это часы ожидания и риск блокировки по rate limit.",
            foreground=COLOR_MUTED,
            wraplength=760,
            font=("Segoe UI", 9),
        ).pack(anchor=W, pady=(2, 8))

        cache_frame = tb.Frame(frame)
        cache_frame.pack(anchor=W)
        tb.Button(
            cache_frame,
            text="Сбросить кэш импорта",
            command=self._reset_import_cache,
            bootstyle="secondary-outline",
            width=22,
        ).pack(side=LEFT)

        self.selected_files: list[Path] = []

    def _on_skip_imported_changed(self):
        self.skip_imported_files = bool(self.skip_imported_var.get())
        self.config["skip_imported_files"] = self.skip_imported_files
        self.save_config()

    def _on_backfill_third_party_changed(self):
        enabled = bool(self.backfill_third_party_var.get())
        self.dispatcher.configure(backfill_enabled=enabled)
        self.config["backfill_send_third_party"] = enabled
        self.save_config()
        self.log(
            "История журналов будет отправляться во внешние API (медленно)"
            if enabled
            else "История журналов не отправляется во внешние API (только live-события)",
            "warn" if enabled else "info",
        )

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
    #  Вкладка: Колонизатор (Raven Colonial)
    # ============================================================
    def _build_tab_colony(self):
        frame = tb.Frame(self.tab_colony, padding=15)
        frame.pack(fill=BOTH, expand=True)

        tb.Label(frame, text="Колонизатор — проекты Raven Colonial",
                 font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 8))
        tb.Label(
            frame,
            text="Просмотр своих проектов, назначение основного, завершение стройки и создание "
                 "нового проекта. Запись (создание/изменение/завершение) требует ключа RCC — "
                 "его выдают на сайте Raven Colonial.",
            foreground=COLOR_MUTED,
            wraplength=780,
        ).pack(anchor=W, pady=(0, 10))

        # ---- Командир и обновление ----
        top = tb.Frame(frame)
        top.pack(fill=X, pady=(0, 8))
        tb.Label(top, text="Командир:", width=12, anchor=W).pack(side=LEFT)
        self.colony_cmdr_var = tk.StringVar(value=self._current_cmdr_name())
        tb.Entry(top, textvariable=self.colony_cmdr_var, width=28).pack(side=LEFT, padx=(0, 10))
        tb.Button(top, text="Обновить список", command=self._on_colony_refresh,
                  bootstyle="info-outline", width=18).pack(side=LEFT, padx=(0, 8))
        self.colony_key_label = tb.Label(top, text="", foreground=COLOR_MUTED, font=("Consolas", 9))
        self.colony_key_label.pack(side=LEFT)

        # ---- Таблица проектов ----
        tree_frame = tb.Frame(frame, relief="solid", borderwidth=1)
        tree_frame.pack(fill=BOTH, expand=True)
        columns = ("primary", "system", "build", "type", "progress", "build_id")
        self.colony_tree = tb.Treeview(
            tree_frame, columns=columns, show="headings", bootstyle="dark", height=10,
        )
        for col, title, width, anchor in [
            ("primary", "★", 34, CENTER),
            ("system", "Система", 170, W),
            ("build", "Стройка", 190, W),
            ("type", "Тип", 160, W),
            ("progress", "Прогресс", 150, CENTER),
            ("build_id", "buildId", 260, W),
        ]:
            self.colony_tree.heading(col, text=title)
            self.colony_tree.column(col, width=width, anchor=anchor)
        vsb = tb.Scrollbar(tree_frame, orient=VERTICAL, command=self.colony_tree.yview)
        self.colony_tree.configure(yscrollcommand=vsb.set)
        self.colony_tree.pack(side=LEFT, fill=BOTH, expand=True)
        vsb.pack(side=RIGHT, fill=Y)
        self.colony_tree.bind("<<TreeviewSelect>>", lambda _e: self._on_colony_select())

        # ---- Действия с выбранным проектом ----
        actions = tb.Frame(frame)
        actions.pack(fill=X, pady=(10, 0))
        self.colony_action_buttons = []
        for text, command, style in [
            ("★ Сделать основным", self._on_colony_set_primary, "success-outline"),
            ("Снять основной", self._on_colony_clear_primary, "secondary-outline"),
            ("Завершить проект", self._on_colony_complete, "danger-outline"),
            ("Копировать buildId", self._on_colony_copy_id, "info-outline"),
        ]:
            btn = tb.Button(actions, text=text, command=command, bootstyle=style, width=22,
                            state="disabled")
            btn.pack(side=LEFT, padx=(0, 8))
            self.colony_action_buttons.append(btn)

        self.colony_status = tb.Label(frame, text="", foreground=COLOR_MUTED, font=("Consolas", 9),
                                      wraplength=780)
        self.colony_status.pack(anchor=W, pady=(6, 0))

        # ---- Создание проекта ----
        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=12)
        tb.Label(frame, text="Создать проект", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(0, 6))

        form = tb.Frame(frame)
        form.pack(fill=X)
        self.colony_fields = {}
        rows = [
            ("systemName", "Система *", ""),
            ("buildName", "Название *", ""),
            ("buildType", "Тип постройки *", ""),
            ("marketId", "Market ID", ""),
            ("systemAddress", "System address", ""),
            ("maxNeed", "maxNeed", ""),
            ("notes", "Заметки", ""),
        ]
        for index, (key, label, default) in enumerate(rows):
            tb.Label(form, text=label, width=16, anchor=W).grid(row=index, column=0, sticky=W, pady=2)
            var = tk.StringVar(value=default)
            self.colony_fields[key] = var
            entry = tb.Entry(form, textvariable=var, width=44)
            entry.grid(row=index, column=1, sticky=W, pady=2)
            if key == "buildType":
                self.colony_build_type_entry = entry  # подсказки берём из своих проектов

        self.colony_primary_port_var = tk.BooleanVar(value=False)
        tb.Checkbutton(form, text="Основной порт системы", variable=self.colony_primary_port_var).grid(
            row=len(rows), column=1, sticky=W, pady=2)
        tb.Label(
            form,
            text="Товары (необязательно), формат: aluminium:1200, steel:900",
            width=46, anchor=W,
        ).grid(row=len(rows) + 1, column=1, sticky=W, pady=(6, 0))
        self.colony_commodities_var = tk.StringVar(value="")
        tb.Entry(form, textvariable=self.colony_commodities_var, width=44).grid(
            row=len(rows) + 2, column=1, sticky=W)

        buttons = tb.Frame(frame)
        buttons.pack(anchor=W, pady=(10, 0))
        tb.Button(buttons, text="Создать проект", command=self._on_colony_create,
                  bootstyle="success-outline", width=20).pack(side=LEFT, padx=(0, 8))
        tb.Button(buttons, text="Подставить текущую систему",
                  command=self._on_colony_fill_current, bootstyle="secondary-outline", width=26).pack(side=LEFT)

        self._update_colony_key_label()

    # ---------- Колонизатор: состояние ----------
    def _current_cmdr_name(self) -> str:
        """Имя командира: из токена сайта, из журнала или вручную."""
        for candidate in (
            getattr(self.api, "cmdr_name", "") or "",
            self._watcher_cmdr_name or "",
            self.config.get("cmdr_name", "") or "",
        ):
            if candidate:
                return str(candidate)
        return ""

    def _update_colony_key_label(self):
        if not hasattr(self, "colony_key_label"):
            return
        if self.raven_api.is_connected:
            self.colony_key_label.config(text="RCC ключ задан", foreground=COLOR_GREEN)
        else:
            self.colony_key_label.config(text="RCC ключ не задан — только просмотр",
                                         foreground=COLOR_ORANGE)

    def _selected_colony_project(self) -> Optional[dict]:
        if not hasattr(self, "colony_tree"):
            return None
        selection = self.colony_tree.selection()
        if not selection:
            return None
        values = self.colony_tree.item(selection[0], "values")
        if not values or len(values) < 6:
            return None
        return {
            "primary": values[0] == "★",
            "systemName": values[1],
            "buildName": values[2],
            "buildType": values[3],
            "progress": values[4],
            "buildId": values[5],
        }

    def _on_colony_select(self):
        project = self._selected_colony_project()
        state = "normal" if (project and project["buildId"]) else "disabled"
        for btn in getattr(self, "colony_action_buttons", []):
            btn.config(state=state)
        if project:
            self.colony_status.config(
                text=f"{project['systemName']}: {project['buildName']} "
                     f"({project['buildType']}) — {project['progress']}"
            )

    def _set_colony_busy(self, busy: bool, text: str = ""):
        """Блокируем кнопки на время запроса, чтобы не спамить Raven."""
        for btn in getattr(self, "colony_action_buttons", []):
            btn.config(state="disabled" if busy else "normal")
        if text:
            self.colony_status.config(text=text)
        if not busy:
            self._on_colony_select()

    # ---------- Колонизатор: запросы (в фоне) ----------
    def _on_colony_refresh(self):
        cmdr = (self.colony_cmdr_var.get() or "").strip()
        if not cmdr:
            self.log("Укажите имя командира для поиска проектов.", "warn")
            return
        self._set_colony_busy(True, "Загружаю проекты Raven Colonial…")
        threading.Thread(target=self._colony_refresh_thread, args=(cmdr,), daemon=True).start()

    def _colony_refresh_thread(self, cmdr: str):
        result = self.raven_api.get_cmdr_active(cmdr)
        primary = self.raven_api.get_primary(cmdr) if result.get("ok") else {"ok": False}
        self.after(0, lambda: self._colony_refresh_done(result, primary))

    def _colony_refresh_done(self, result: dict, primary: dict):
        self._set_colony_busy(False)
        if not result.get("ok"):
            self.colony_status.config(text=f"Не удалось загрузить проекты: {result.get('error')}")
            self.log(f"Raven Colonial: не удалось получить проекты — {result.get('error')}", "error")
            return

        data = result.get("data")
        projects = self._extract_colony_projects(data)
        primary_id = self._extract_primary_id(primary)
        self._fill_colony_tree(projects, primary_id)
        self.colony_status.config(text=f"Проектов: {len(projects)}")
        self.log(f"Raven Colonial: загружено проектов — {len(projects)}", "success")

    @staticmethod
    def _extract_colony_projects(data) -> list:
        """Ответ /cmdr/{cmdr}/active — это список проектов или {'projects': [...]}."""
        if isinstance(data, dict):
            for key in ("projects", "Projects"):
                if isinstance(data.get(key), list):
                    return [p for p in data[key] if isinstance(p, dict)]
            return [data] if "buildId" in data else []
        if isinstance(data, list):
            # Без buildId проект бесполезен: к нему нельзя обратиться ни по
            # одному из действий вкладки.
            return [p for p in data if isinstance(p, dict) and p.get("buildId")]
        return []

    @staticmethod
    def _extract_primary_id(primary: dict):
        data = primary.get("data") if isinstance(primary, dict) else None
        if isinstance(data, dict):
            return str(data.get("primaryBuildId") or data.get("buildId") or "")
        if isinstance(data, str):
            return data.strip().strip('"')
        return ""

    @staticmethod
    def _project_progress(project: dict) -> str:
        need = project.get("sumNeed")
        total = project.get("sumTotal")
        if need is None and total is None:
            return "—"
        try:
            need = int(need or 0)
            total = int(total or 0)
        except (TypeError, ValueError):
            return "—"
        if total <= 0:
            return f"{need}"
        percent = 100 * need // total if total else 0
        return f"{need} / {total} ({percent}%)"

    def _fill_colony_tree(self, projects: list, primary_id: str = ""):
        self.colony_tree.delete(*self.colony_tree.get_children())
        build_types = []
        for project in projects:
            build_id = str(project.get("buildId", "") or "")
            is_primary = bool(primary_id and build_id and build_id == primary_id)
            build_type = str(project.get("buildType", "") or "")
            if build_type and build_type not in build_types:
                build_types.append(build_type)
            self.colony_tree.insert(
                "", END,
                values=(
                    "★" if is_primary else "",
                    str(project.get("systemName", "") or ""),
                    str(project.get("buildName", "") or ""),
                    build_type,
                    self._project_progress(project),
                    build_id,
                ),
            )
        # Типы построек подсказываем из уже существующих проектов —
        # так список всегда актуальный и не зависит от захардкоженных данных.
        entry = getattr(self, "colony_build_type_entry", None)
        if entry is not None:
            current = entry.cget("values") or ()
            merged = list(current) + [t for t in build_types if t not in current]
            entry.config(values=merged)
        self._colony_projects_cache = {p.get("buildId"): p for p in projects}

    # ---------- Колонизатор: действия ----------
    def _on_colony_set_primary(self):
        project = self._selected_colony_project()
        if not project:
            return
        cmdr = (self.colony_cmdr_var.get() or "").strip()
        if not cmdr:
            self.log("Укажите имя командира.", "warn")
            return
        self._set_colony_busy(True, "Назначаю основной проект…")
        threading.Thread(target=self._colony_simple_call_thread,
                         args=("set_primary", (cmdr, project["buildId"]),
                               f"Основной проект: {project['buildName']}"), daemon=True).start()

    def _on_colony_clear_primary(self):
        cmdr = (self.colony_cmdr_var.get() or "").strip()
        if not cmdr:
            self.log("Укажите имя командира.", "warn")
            return
        self._set_colony_busy(True, "Снимаю основной проект…")
        threading.Thread(target=self._colony_simple_call_thread,
                         args=("clear_primary", (cmdr,), "Основной проект снят"), daemon=True).start()

    def _on_colony_complete(self):
        project = self._selected_colony_project()
        if not project:
            return
        if not messagebox.askyesno(
            "Завершить проект",
            f"Отметить «{project['buildName']}» ({project['systemName']}) завершённым?\n"
            "Это действие необратимо.",
            parent=self.root,
        ):
            return
        self._set_colony_busy(True, "Завершаю проект…")
        threading.Thread(target=self._colony_simple_call_thread,
                         args=("mark_complete", (project["buildId"],), "Проект завершён"),
                         daemon=True).start()

    def _colony_simple_call_thread(self, method_name: str, args: tuple, success_text: str):
        method = getattr(self.raven_api, method_name, None)
        result = method(*args) if method else {"ok": False, "error": f"нет метода {method_name}"}
        self.after(0, lambda: self._colony_action_done(result, success_text))

    def _colony_action_done(self, result: dict, success_text: str):
        cmdr = (self.colony_cmdr_var.get() or "").strip()
        if result.get("ok"):
            self.log(f"Raven Colonial: {success_text}", "success")
            self.colony_status.config(text=success_text)
            if cmdr:
                self._on_colony_refresh()
            else:
                self._set_colony_busy(False)
        else:
            self._set_colony_busy(False)
            error = result.get("error") or "неизвестная ошибка"
            self.colony_status.config(text=f"Ошибка: {error}")
            self.log(f"Raven Colonial: {error}", "error")

    def _on_colony_copy_id(self):
        project = self._selected_colony_project()
        if not project:
            return
        build_id = project["buildId"]
        try:
            import pyperclip

            pyperclip.copy(build_id)
            self.log(f"buildId скопирован: {build_id}", "info")
        except Exception:
            self.root.clipboard_clear()
            self.root.clipboard_append(build_id)
            self.log(f"buildId скопирован: {build_id}", "info")

    def _on_colony_fill_current(self):
        """Подставить систему, в которой командир находится сейчас."""
        state = getattr(self.ship, "state", None)
        system = (getattr(state, "current_system", "") or "").strip()
        if not system:
            self.log("Текущая система неизвестна — включите Watcher или загрузите журналы.", "warn")
            return
        self.colony_fields["systemName"].set(system)
        market_id = str(self._last_depot_state.get("_market_id", "") or "")
        if market_id and market_id != "0":
            self.colony_fields["marketId"].set(market_id)
        address = getattr(state, "system_address", 0) or 0
        if address:
            self.colony_fields["systemAddress"].set(str(address))
        depot = self._last_depot_state or {}
        commodities = [
            f"{name}:{amount}"
            for name, amount in sorted(depot.items())
            if not name.startswith("_") and isinstance(amount, (int, float))
        ]
        if commodities:
            self.colony_commodities_var.set(", ".join(commodities))
        self.log(f"Подставлена текущая система: {system}", "info")

    @staticmethod
    def _parse_commodities(text: str) -> dict:
        """'aluminium:1200, steel:900' -> {'aluminium': 1200, 'steel': 900}."""
        result = {}
        for chunk in (text or "").split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            name, _, amount = chunk.partition(":")
            name = name.strip().lower()
            try:
                value = int(float(amount.strip()))
            except ValueError:
                continue
            if name:
                result[name] = value
        return result

    def _on_colony_create(self):
        if not self.raven_api.is_connected:
            self.log("Для создания проекта нужен RCC ключ (вкладка «Подключение»).", "error")
            return
        system = self.colony_fields["systemName"].get().strip()
        build_name = self.colony_fields["buildName"].get().strip()
        build_type = self.colony_fields["buildType"].get().strip()
        if not (system and build_name and build_type):
            self.log("Заполните поля: система, название, тип постройки.", "warn")
            return

        def as_int(key: str) -> Optional[int]:
            raw = self.colony_fields[key].get().strip()
            if not raw:
                return None
            try:
                return int(raw)
            except ValueError:
                self.log(f"Поле «{key}» должно быть числом, получено: {raw}", "warn")
                return None

        market_id, system_address, max_need = as_int("marketId"), as_int("systemAddress"), as_int("maxNeed")
        if any(value is None and self.colony_fields[key].get().strip()
               for key, value in (("marketId", market_id), ("systemAddress", system_address),
                                  ("maxNeed", max_need))):
            return

        project = {
            "systemName": system,
            "buildName": build_name,
            "buildType": build_type,
            "marketId": market_id,
            "systemAddress": system_address,
            "maxNeed": max_need,
            "isPrimaryPort": bool(self.colony_primary_port_var.get()),
            "notes": self.colony_fields["notes"].get().strip() or None,
            "commodities": self._parse_commodities(self.colony_commodities_var.get()),
        }
        cmdr = (self.colony_cmdr_var.get() or "").strip()
        self.colony_status.config(text="Создаю проект…")
        threading.Thread(target=self._colony_create_thread, args=(project, cmdr), daemon=True).start()

    def _colony_create_thread(self, project: dict, cmdr: str):
        result = self.raven_api.create_project(project)
        build_id = ""
        data = result.get("data")
        if isinstance(data, dict):
            build_id = str(data.get("buildId", "") or "")
        if result.get("ok") and build_id and cmdr:
            # Сразу привязываем проект к командиру, иначе он не попадёт в
            # список «моих проектов» на сайте и в этой вкладке.
            self.raven_api.link_cmdr(build_id, cmdr, True)
        self.after(0, lambda: self._colony_create_done(result, build_id, cmdr))

    def _colony_create_done(self, result: dict, build_id: str, cmdr: str):
        if result.get("ok"):
            name = f"{self.colony_fields['systemName'].get()}: {self.colony_fields['buildName'].get()}"
            self.log(f"Raven Colonial: проект создан — {name} (buildId {build_id})", "success")
            self.colony_status.config(text=f"Проект создан, buildId: {build_id}")
            if cmdr:
                self._on_colony_refresh()
        else:
            error = result.get("error") or "неизвестная ошибка"
            self.colony_status.config(text=f"Создать проект не удалось: {error}")
            self.log(f"Raven Colonial: проект не создан — {error}", "error")

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

        self.show_events_var = tk.BooleanVar(value=self.overlay_manager.settings.get("show_events", True))
        tb.Checkbutton(ov_frame, text="EVENTS — события сессии", variable=self.show_events_var,
                       command=self._on_show_events_changed).pack(anchor=W, pady=2)

        self.show_exobio_var = tk.BooleanVar(value=self.overlay_manager.settings.get("show_exobio", True))
        tb.Checkbutton(ov_frame, text="EXOBIO — экзобиология (тело, сигналы, образцы)",
                       variable=self.show_exobio_var,
                       command=self._on_show_exobio_changed).pack(anchor=W, pady=2)

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

        # ---------- Раскладка: якоря, отступы, профили ----------
        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=15)
        tb.Label(frame, text="Раскладка и привязка", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(0, 5))
        tb.Label(
            frame,
            text="Блоки прилипают к краям и углам области. Область — весь экран, либо экран с "
                 "окном игры, если включена привязка к игре. Профиль сохраняет всю раскладку "
                 "(позиции, размеры, видимость, прозрачность) — например «Хаул», «Эксобиология», «Бой».",
            foreground=COLOR_MUTED,
            wraplength=700,
        ).pack(anchor=W, pady=(0, 8))

        # Профили раскладки
        prof_frame = tb.Frame(frame)
        prof_frame.pack(fill=X, pady=(0, 6))
        tb.Label(prof_frame, text="Профиль:", width=18, anchor=W).pack(side=LEFT)
        self.profile_var = tk.StringVar(value=self.overlay_manager.active_profile)
        self.profile_combo = tb.Combobox(
            prof_frame, textvariable=self.profile_var,
            values=self.overlay_manager.list_profiles(), width=22,
        )
        self.profile_combo.pack(side=LEFT, padx=(10, 6))
        tb.Button(prof_frame, text="Применить", command=self._on_profile_apply,
                  bootstyle="success-outline", width=12).pack(side=LEFT, padx=(0, 6))
        tb.Button(prof_frame, text="Сохранить", command=self._on_profile_save,
                  bootstyle="info-outline", width=12).pack(side=LEFT, padx=(0, 6))
        tb.Button(prof_frame, text="Удалить", command=self._on_profile_delete,
                  bootstyle="danger-outline", width=10).pack(side=LEFT)

        # Отступ от края
        margin_frame = tb.Frame(frame)
        margin_frame.pack(fill=X, pady=5)
        tb.Label(margin_frame, text="Отступ от края:", width=18, anchor=W).pack(side=LEFT)
        self.margin_var = tk.IntVar(value=int(self.overlay_manager.settings.get("layout_margin", 24)))
        margin_scale = tb.Scale(
            margin_frame, from_=0, to=120, orient=HORIZONTAL,
            variable=self.margin_var, length=250,
            command=lambda v: self._on_margin_changed(int(float(v))),
        )
        margin_scale.pack(side=LEFT, padx=(10, 0))
        self.margin_label = tb.Label(margin_frame, text=f"{self.margin_var.get()} px")
        self.margin_label.pack(side=LEFT, padx=(10, 0))

        # Якоря для каждого блока
        tb.Label(frame, text="Привязка блоков:", font=("Segoe UI", 10)).pack(anchor=W, pady=(8, 2))
        anchor_values = [ANCHOR_LABELS[key] for key in ANCHOR_KEYS]
        self._anchor_vars = {}
        for block_key, block_label in [
            ("route", "ROUTE — маршрут"),
            ("status", "STATUS — статус"),
            ("ship", "SHIP — корабль"),
            ("cargo", "CARGO — трюм"),
            ("session", "SESSION — сессия"),
            ("events", "EVENTS — события"),
            ("exobio", "EXOBIO — экзобиология"),
        ]:
            row = tb.Frame(frame)
            row.pack(fill=X, pady=1)
            tb.Label(row, text=block_label, width=24, anchor=W).pack(side=LEFT)
            current = self.overlay_manager.settings.get(f"{block_key}_anchor", "custom")
            var = tk.StringVar(value=ANCHOR_LABELS.get(current, ANCHOR_LABELS["custom"]))
            self._anchor_vars[block_key] = var
            combo = tb.Combobox(row, textvariable=var, values=anchor_values,
                                width=18, state="readonly")
            combo.pack(side=LEFT, padx=(6, 0))
            combo.bind("<<ComboboxSelected>>",
                       lambda _e, k=block_key, v=var: self._on_anchor_changed(k, v.get()))

        # Кнопки раскладки
        layout_btn_frame = tb.Frame(frame)
        layout_btn_frame.pack(anchor=W, pady=(8, 0))
        tb.Button(layout_btn_frame, text="Пересчитать по якорям",
                  command=self._on_apply_anchors, bootstyle="info-outline", width=24).pack(side=LEFT, padx=(0, 8))
        tb.Button(layout_btn_frame, text="Сбросить позиции",
                  command=self._on_reset_overlay_positions, bootstyle="secondary-outline", width=18).pack(side=LEFT)

        self.hide_without_game_var = tk.BooleanVar(
            value=self.overlay_manager.settings.get("hide_when_game_off", True)
        )
        tb.Checkbutton(
            frame,
            text="Скрывать оверлей, когда игра не запущена",
            variable=self.hide_without_game_var,
            command=self._on_hide_without_game_changed,
        ).pack(anchor=W, pady=(6, 0))

        self.layout_info_label = tb.Label(
            frame,
            text="",
            font=("Consolas", 9),
            foreground=COLOR_MUTED,
            wraplength=700,
        )
        self.layout_info_label.pack(anchor=W, pady=(6, 0))

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

    # ---------- Раскладка: профили, отступы, якоря ----------
    def _refresh_profile_combo(self, selected: str = ""):
        names = self.overlay_manager.list_profiles()
        self.profile_combo.config(values=names)
        if selected:
            self.profile_var.set(selected)
        elif self.profile_var.get() not in names:
            self.profile_var.set(self.overlay_manager.active_profile)

    def _on_profile_save(self):
        name = (self.profile_var.get() or "").strip()
        if not name:
            name = simpledialog.askstring(
                "Профиль раскладки",
                "Имя профиля (например: Хаул, Эксобиология, Бой):",
                parent=self.root,
            )
            if not name:
                return
        if self.overlay_manager.capture_layout(name):
            self._refresh_profile_combo(name)
            self.log(f"Профиль раскладки «{name}» сохранён.", "success")
        else:
            self.log("Не удалось сохранить профиль раскладки.", "error")

    def _on_profile_apply(self):
        name = (self.profile_var.get() or "").strip()
        if not name:
            self.log("Выберите профиль раскладки.", "warn")
            return
        if not self.overlay_manager.apply_layout(name):
            self.log(f"Профиль «{name}» не найден.", "error")
            return
        # Прозрачность/шрифт из профиля подтягиваем и в элементы вкладки.
        self.alpha_var.set(float(self.overlay_manager.settings.get("alpha", 0.9)))
        self.alpha_label.config(text=f"{self.alpha_var.get():.0%}")
        self.font_var.set(self.overlay_manager.settings.get("font_family", "Consolas"))
        self.font_size_var.set(int(self.overlay_manager.settings.get("font_size", 10)))
        self.size_label.config(text=str(self.font_size_var.get()))
        self._refresh_profile_combo(name)
        if self.overlay_manager.enabled:
            self._restart_overlay()
        self.log(f"Профиль раскладки «{name}» применён.", "success")

    def _on_profile_delete(self):
        name = (self.profile_var.get() or "").strip()
        if not name:
            return
        if not messagebox.askyesno("Удалить профиль", f"Удалить профиль «{name}»?", parent=self.root):
            return
        if self.overlay_manager.delete_profile(name):
            self._refresh_profile_combo("")
            self.log(f"Профиль раскладки «{name}» удалён.", "info")
        else:
            self.log(f"Профиль «{name}» не найден.", "warn")

    def _on_margin_changed(self, value: int):
        self.margin_label.config(text=f"{value} px")
        self.overlay_manager.set_layout_margin(value)
        self._update_layout_info()

    def _on_anchor_changed(self, block_key: str, label: str):
        anchor = "custom"
        for key, text in ANCHOR_LABELS.items():
            if text == label:
                anchor = key
                break
        self.overlay_manager.snap_block(block_key, anchor)
        self.overlay_manager.save_settings()
        self._update_layout_info()

    def _on_apply_anchors(self):
        self.overlay_manager.apply_anchors()
        self._update_layout_info()
        self.log("Блоки расставлены по якорям.", "info")

    def _on_hide_without_game_changed(self):
        enabled = bool(self.hide_without_game_var.get())
        self.overlay_manager.settings["hide_when_game_off"] = enabled
        self.overlay_manager.save_settings()
        self.log(
            "Оверлей прячется, когда игра не запущена" if enabled
            else "Оверлей показывается всегда, даже без игры",
            "info",
        )

    def _restart_overlay(self):
        """Пересоздать окна оверлея (после смены шрифта/профиля)."""
        was_enabled = self.overlay_manager.enabled
        callback = getattr(self.overlay_manager, "_update_callback", None)
        self.overlay_manager.stop()
        if was_enabled:
            self.overlay_manager.start(callback or self._get_overlay_data)

    def _update_layout_info(self):
        """Строка состояния под настройками раскладки."""
        try:
            area = self.overlay_manager.overlay_area()
            state = self.overlay_manager.game_state()
            source = "экран с игрой" if (state.running and state.monitor) else "основной экран"
            self.layout_info_label.config(
                text=f"Область раскладки: {source} {area[2]}x{area[3]} "
                     f"(сдвиг {area[0]},{area[1]}), отступ {self.overlay_manager.settings.get('layout_margin', 24)} px"
            )
        except Exception:
            pass

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

    def _on_show_events_changed(self):
        """EVENTS создаётся вместе с остальными окнами, поэтому просто
        показываем/прячем существующее окно."""
        show = bool(self.show_events_var.get())
        self.overlay_manager.settings["show_events"] = show
        self.overlay_manager.save_settings()
        overlay = self.overlay_manager.events_overlay
        if overlay:
            overlay.show() if show else overlay.hide()

    def _on_show_exobio_changed(self):
        """Блок экзобиологии показывает данные по текущему телу из журнала."""
        show = bool(self.show_exobio_var.get())
        self.overlay_manager.settings["show_exobio"] = show
        self.overlay_manager.save_settings()
        overlay = self.overlay_manager.exobio_overlay
        if overlay:
            overlay.show() if show else overlay.hide()

    def _on_attach_game_changed(self):
        self.overlay_manager.set_attach_to_game(self.attach_game_var.get())
        state = "включена" if self.attach_game_var.get() else "отключена"
        self.log(f"Привязка к окну игры {state}", "info")

    def _on_ship_block_changed(self, block: str, show: bool):
        self.overlay_manager.set_ship_block(block, show)

    def _on_reset_overlay_positions(self):
        self.overlay_manager.reset_positions()
        self._refresh_profile_combo()
        if self.overlay_manager.enabled:
            self._restart_overlay()
        self.log("Позиции оверлея сброшены на стандартные.", "info")

    def _get_overlay_data(self) -> dict:
        """Собрать данные для обновления оверлея."""
        data = {
            "online": self.api.is_connected,
            "status_detail": (
                f"{self.api.display_name} | ED Ring: {'ON' if self.api.is_connected else 'OFF'} | "
                f"Raven: {'ON' if self.raven_api.is_connected else 'OFF'} | "
                f"EDSM: {'ON' if self.edsm_api.enabled else 'OFF'} | "
                f"Inara: {'ON' if self.inara_api.enabled else 'OFF'}"
            ),
            "watcher_active": self.watcher_active,
            "game_running": self.overlay_manager.game_running,
            "game_focused": bool(self.overlay_manager.game_state().focused),
            "game_detail": self.overlay_manager.game_state().process_name or "",
            "exobiology": self.exobiology.current_body_state(),
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
    #  Индикатор игры
    # ============================================================
    def _tick_game_status(self):
        """Обновить индикатор запуска игры в шапке и статус-баре."""
        try:
            state = self.overlay_manager.game_state()
            if state.error:
                color, text = COLOR_MUTED, f"Игра: нет данных ({state.error})"
            elif state.running:
                color = COLOR_GREEN if state.focused else COLOR_ORANGE
                text = "Игра: в фокусе" if state.focused else "Игра: запущена (не в фокусе)"
            else:
                color, text = COLOR_RED, "Игра: не запущена"

            self.game_dot.config(foreground=color)
            self.game_label.config(text=text, foreground=color)

            if state.running:
                details = [state.process_name or "Elite Dangerous"]
                if state.rect:
                    details.append(f"{state.width}x{state.height}")
                if state.title:
                    details.append(state.title)
                self.game_hint.config(text="  |  ".join(details))
            else:
                self.game_hint.config(text="оверлей скрыт, пока игры нет"
                                      if self.overlay_manager.settings.get("hide_when_game_off", True)
                                      else "")

            # Логируем только смену состояния, чтобы не засорять лог.
            if state.running != self._game_was_running:
                self._game_was_running = state.running
                if state.running:
                    self.log("Elite Dangerous запущена — оверлей активен", "success")
                else:
                    self.log("Elite Dangerous не запущена — оверлей скрыт", "info")
            if hasattr(self, "layout_info_label"):
                self._update_layout_info()
        except Exception:
            pass
        finally:
            self.after(1500, self._tick_game_status)

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

        # Сначала используем legacy-конфиг, затем накладываем отдельное
        # credentials-хранилище. Это даёт бесшовную миграцию для старых
        # установок и сохраняет ключи при обновлении EXE.
        try:
            with open(self.credentials_path, "r", encoding="utf-8") as f:
                credentials = json.load(f)
            if isinstance(credentials, dict):
                for key in (
                    "token", "raven_colonial_key", "edsm_api_key",
                    "edsm_commander_name", "inara_api_key", "inara_commander_name",
                ):
                    if credentials.get(key):
                        self.config[key] = credentials[key]
        except (OSError, ValueError):
            pass

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
        if hasattr(self, "inara_key_entry"):
            self.inara_api.set_credentials(self.inara_key_entry.get(), self.inara_name_entry.get())
        self.config["inara_api_key"] = self.inara_api.api_key
        self.config["inara_commander_name"] = self.inara_api.commander_name
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            self.log(f"Не удалось сохранить конфиг: {e}", "warn")
        # Дублируем только credentials в отдельном state-файле. Он не зависит
        # от формата общего config-файла и не затирается OverlayManager.
        credentials = {
            key: self.config.get(key, "")
            for key in (
                "token", "raven_colonial_key", "edsm_api_key",
                "edsm_commander_name", "inara_api_key", "inara_commander_name",
            )
        }
        try:
            tmp = self.credentials_path.with_suffix(self.credentials_path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(credentials, f, indent=2, ensure_ascii=False)
            tmp.replace(self.credentials_path)
        except Exception as e:
            self.log(f"Не удалось сохранить credentials: {e}", "warn")
        # Сохраняем и настройки оверлея
        self.overlay_manager.save_settings()

    # ============================================================
    #  Кэш уже загруженных файлов журнала
    # ============================================================
    def _load_imported_files(self) -> dict:
        """Прочитать локальный список уже успешно загруженных файлов."""
        try:
            with open(self.imported_files_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_imported_files(self):
        """Записать кэш загруженных файлов атомарно (tmp + replace)."""
        tmp = self.imported_files_path.with_suffix(".tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.imported_files, fh)
            tmp.replace(self.imported_files_path)
        except OSError as exc:
            self.root.after(0, lambda e=exc: self.log(f"Не удалось сохранить кэш импорта: {e}", "warn"))

    def _is_file_imported(self, path: Path) -> bool:
        """Файл уже загружался и с тех пор не менялся?

        Проверяем размер и mtime: если файл дописывался, он будет разобран
        заново. Версия парсера в ключе гарантирует переимпорт после смены
        правил разбора (например, после исправления источника доставок).
        """
        try:
            stat = path.stat()
        except OSError:
            return False
        record = self.imported_files.get(str(path))
        if not isinstance(record, dict):
            return False
        return (
            int(record.get("size", -1)) == int(stat.st_size)
            and int(record.get("mtime", -1)) == int(stat.st_mtime)
            and int(record.get("parser", -1)) == int(PARSER_VERSION)
        )

    def _mark_files_imported(self, files: list):
        """Отметить файлы как успешно загруженные (только после удачной отправки).

        Если часть чанков не загрузилась — файлы НЕ отмечаются, чтобы
        следующая попытка пере-отправила их заново.
        """
        now_iso = datetime.now().isoformat(timespec="seconds")
        for path in files:
            try:
                stat = path.stat()
            except OSError:
                continue
            self.imported_files[str(path)] = {
                "size": int(stat.st_size),
                "mtime": int(stat.st_mtime),
                "parser": int(PARSER_VERSION),
                "at": now_iso,
            }
        self._save_imported_files()

    def _reset_import_cache(self):
        """Забыть все записи об импорте (кнопка на вкладке загрузки).

        Заодно сбрасывается и внутрисессионная дедупликация событий
        (`_seen_events`) с состоянием diff'ов: иначе повторный импорт в том же
        запуске приложения всё равно не нашёл бы ни одной доставки, и кнопка
        выглядела бы "ничего не делающей".
        """
        count = len(self.imported_files)
        self.imported_files = {}
        try:
            if self.imported_files_path.exists():
                self.imported_files_path.unlink()
        except OSError:
            pass
        self._seen_events = set()
        self._last_cargo = {}
        self._last_depot_state = {}
        self._last_contribution_state = {}
        self.log(
            f"Кэш импорта сброшен ({count} записей) — файлы будут разобраны и загружены заново",
            "info",
        )

    def _on_close(self):
        self.overlay_manager.stop()
        try:
            self.dispatcher.stop(wait=False)
        except Exception:
            pass
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
        self._update_colony_key_label()
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

    def _update_progress(self, value=None, text=None, force=False):
        """Обновить прогресс-бар из фонового потока.

        Обновление идёт не чаще `_progress_interval` (0.1 с): на сотнях файлов
        постоянные `root.after()` сами по себе забивали очередь Tkinter и
        тормозили загрузку.
        """
        now = time.monotonic()
        if not force and (now - self._last_progress_ts) < self._progress_interval:
            return
        self._last_progress_ts = now

        def apply():
            try:
                if value is not None:
                    self.progress.configure(value=max(0.0, min(100.0, float(value))))
                if text is not None:
                    self.progress_label.configure(text=text)
            except Exception:
                pass

        self.root.after(0, apply)

    def _any_third_party_enabled(self) -> bool:
        return bool(self.edsm_api.enabled or self.inara_api.enabled or self.raven_api.is_connected)

    def _do_upload_thread(self):
        all_deliveries = []
        # Snapshots стройки собираются попутно, за тот же один проход по файлу,
        # и сразу с отсевом повторов (подробнее — в ConstructionSnapshotCollector).
        collector = ConstructionSnapshotCollector()
        cmdr_name = None
        total_event_counts: Counter = Counter()
        files_processed = 0
        t_start = time.time()

        # Хронологический порядок уже гарантирован сортировкой в
        # _on_select_files, но подстрахуемся и здесь на случай, если
        # selected_files когда-нибудь будет заполняться иначе.
        files = sorted(self.selected_files, key=lambda p: p.name)

        # Файлы, уже отправленные ранее, не переразбираем: повторная первичная
        # загрузка после этого занимает секунды вместо десятков минут.
        files_skipped = 0
        if self.skip_imported_files:
            pending = []
            for path in files:
                if self._is_file_imported(path):
                    files_skipped += 1
                else:
                    pending.append(path)
            files = pending
        total = len(files)

        if files_skipped:
            self.root.after(
                0,
                lambda n=files_skipped: self.log(
                    f"Пропущено уже загруженных ранее файлов: {n} "
                    f"(сбросить — кнопка «Сбросить кэш импорта»)",
                    "info",
                ),
            )
        if not total:
            self.root.after(0, lambda: self.log("Нет файлов для загрузки — все выбранные уже импортированы", "warn"))
            self.root.after(0, lambda: self._update_progress(100, "Все выбранные файлы уже загружены", force=True))
            self.root.after(0, lambda: self.upload_btn.config(state=NORMAL))
            return

        batch_size = self._UPLOAD_BATCH_SIZE
        self.root.after(
            0,
            lambda t=total, b=batch_size: self.log(
                f"Начинаю обработку {t} файлов" + (f" (пачками по {b})" if t > b else "") + "...",
                "info",
            ),
        )
        if self._any_third_party_enabled() and not self.dispatcher.backfill_enabled:
            self.root.after(
                0,
                lambda: self.log(
                    "История не уходит в EDSM/Inara/Raven Colonial: эти сервисы получают только "
                    "live-события watcher'а. Отправку истории можно включить галочкой ниже.",
                    "info",
                ),
            )

        # Один проход по каждому файлу: доставки + snapshots стройки + внешние
        # API. Раньше текст файла разбирался трижды (доставки, snapshots,
        # отправка в EDSM/Inara), и на сотнях файлов это было заметной частью
        # времени первичной загрузки.
        def dispatch_hook(line, ev):
            station_type = str(self._last_depot_state.get("_station_type", "") or "")
            self.dispatcher.submit(ev, live=False, station_type=station_type)

        # Экзобиология собирается тем же проходом: тела, биосигналы и образцы
        # нужны оверлею EXOBIO, отдельный проход по файлам для них не нужен.
        hooks = [collector, dispatch_hook, self.exobiology.handle]

        # Только те файлы, которые реально разобраны и чьи доставки приняты:
        # файл другого CMDR пропускается и в кэш импорта не попадает, иначе
        # он больше никогда не был бы пере-отправлен.
        accepted_files: list = []
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
                    current_system = self.ship.state.current_system if self.ship.state else None
                    current_system_address = self.ship.state.system_address if self.ship.state else 0
                    (
                        cname, deliveries, self._last_cargo, self._last_depot_state,
                        self._last_contribution_state, self._seen_events, event_counts,
                    ) = parse_events(
                        iter_journal_events(text), current_system, self._last_cargo, self._last_depot_state,
                        self._last_contribution_state, self._seen_events, current_system_address,
                        hooks=hooks,
                    )
                    total_event_counts.update(event_counts)
                    files_processed += 1
                    accepted_files.append(filepath)
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

                # Отдаём под чтение/разбор 0-85%, остальное — под отправку.
                self._update_progress(
                    processed_count / total * 85,
                    f"Разбор файлов: {processed_count}/{total}",
                )

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

        construction_events = collector.events
        if collector.duplicates:
            self.root.after(
                0,
                lambda d=collector.duplicates, k=len(construction_events): self.log(
                    f"Snapshots стройки: {k} уникальных состояний "
                    f"({d} повторов с неизменным состоянием отфильтровано)",
                    "info",
                ),
            )

        if not all_deliveries and not construction_events:
            self.root.after(0, lambda: self.log("Доставки и события строительства не найдены", "warn"))
            self.root.after(0, lambda: self._mark_files_imported(accepted_files))
            self.root.after(0, lambda: self.upload_btn.config(state=NORMAL))
            self.root.after(0, lambda: self._update_progress(0, "", force=True))
            return

        # ---- Отправка snapshots стройплощадок (общий прогресс проекта) ----
        construction_ok = True
        if construction_events:
            self._update_progress(85, f"Отправка snapshots стройки: {len(construction_events)}...", force=True)

            def construction_progress(done, total_chunks):
                self._update_progress(
                    85 + 5.0 * done / max(1, total_chunks),
                    f"Отправка snapshots стройки: {done}/{total_chunks} пачек",
                )

            construction_result = self.api.upload_construction_events(
                construction_events, cmdr_name, progress_cb=construction_progress
            )
            if construction_result.get("ok"):
                self.root.after(
                    0,
                    lambda n=len(construction_events): self.log(
                        f"Прогресс строек: отправлено snapshots — {n}", "info"
                    ),
                )
            else:
                construction_ok = False
                self.root.after(
                    0,
                    lambda e=construction_result.get("error", "ошибка"): self.log(
                        f"Прогресс строек не отправлен: {e}", "warn"
                    ),
                )

        # ---- Отправка доставок ----
        if not all_deliveries:
            self.root.after(0, lambda: self.log("Доставки не найдены", "warn"))
            if construction_ok:
                self.root.after(0, lambda: self._mark_files_imported(accepted_files))
            self.root.after(0, lambda: self._update_progress(100, "Готово", force=True))
            self.root.after(0, lambda: self.upload_btn.config(state=NORMAL))
            return

        self.root.after(
            0,
            lambda: self.log(f"Всего доставок: {len(all_deliveries)}. Отправка...", "info"),
        )

        def delivery_progress(done, total_chunks):
            self._update_progress(
                90 + 10.0 * done / max(1, total_chunks),
                f"Отправка доставок: {done}/{total_chunks} пачек",
            )

        self._update_progress(90, f"Отправка {len(all_deliveries)} записей...", force=True)
        try:
            result = self.api.upload_deliveries(
                [self._delivery_for_api(d) for d in all_deliveries],
                cmdr_name,
                progress_cb=delivery_progress,
            )
        except Exception as e:
            # Подстраховка: api_client уже ловит сетевые и JSON-ошибки сам,
            # но если сюда всё же прилетит что-то неожиданное — не оставляем
            # кнопку/прогресс-бар в подвешенном состоянии.
            self.root.after(
                0, lambda e=e: self.log(f"Непредвиденная ошибка при отправке: {e}", "error")
            )
            self.root.after(
                0, lambda e=str(e): self._update_progress(None, f"Ошибка: {e[:100]}", force=True)
            )
            self.root.after(0, lambda: self.upload_btn.config(state=NORMAL))
            return

        self.root.after(0, lambda: self._update_progress(100, None, force=True))

        if result["ok"]:
            inserted = result["inserted"]
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
            if construction_ok:
                self.root.after(0, lambda: self._mark_files_imported(accepted_files))
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
                lambda e=error_text: self.progress_label.config(text=f"Ошибка: {e[:100]}"),
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
        self._session_event_count = 0
        self._last_session_event = ""
        # CMDR из уже проверенного токена (если сервер его вернул) — используется
        # как основа для всех тиков watcher'а, пока журнал не назовёт другого CMDR.
        self._watcher_cmdr_name = self.api.cmdr_name
        self._pending_watcher_deliveries = []
        # Накопители первичной сверки + статистика внешних API — с нуля.
        self._defer_uploads = False
        self._backfill_deliveries = []
        self._backfill_construction = []
        self.dispatcher.reset_stats()

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

    def _log_session_event(self, event: dict):
        event_name = str(event.get("event", ""))
        tracked = {
            "Location", "FSDJump", "Docked", "Undocked", "CarrierJump", "Market", "MarketBuy", "MarketSell",
            "Cargo", "CargoDepot", "ColonisationContribution", "Scan", "FSSDiscoveryScan", "SAAScanComplete",
            "Loadout", "ModuleInfo", "ModuleDamage", "Repair", "RepairAll", "HullDamage", "ShieldState",
        }
        if event_name not in tracked:
            return
        system = event.get("StarSystem") or self.ship.state.current_system or "?"
        details = []
        if event.get("Count") is not None:
            details.append(f"{event.get('Type_Localised') or event.get('Type') or 'cargo'} x{event.get('Count')}")
        if event_name == "ColonisationContribution":
            details.append(", ".join(f"{c.get('Name_Localised') or c.get('Name')}: {c.get('Amount', 0)}" for c in event.get("Contributions", [])))
        if event_name in ("FSDJump", "Location", "Docked", "CarrierJump"):
            details.append(system)
        message = f"{event_name}: {' | '.join(details) if details else system}"
        self._session_event_count += 1
        self._last_session_event = message
        self.overlay_manager.log_session_event(message)

    def _on_third_party_result(self, service: str, ok: bool, message: str):
        """Результат отправки во внешний API (вызывается из потока диспетчера)."""
        # В лог попадают только проблемы/особые случаи: успешных отправок на
        # истории могут быть тысячи, и засорять ими лог бессмысленно.
        if ok:
            if message:
                self.root.after(0, lambda m=message: self.log(m, "info"))
            return
        self.root.after(
            0,
            lambda m=message, s=service: self.log(
                f"{s.upper()}: {m}" if not m.lower().startswith(s.lower()) else m, "warn"
            ),
        )

    def _detect_game_version(self):
        """Прочитать версию и сборку игры из Fileheader свежего журнала.

        EDSM с 2022 года требует `fromGameVersion`/`fromGameBuild` (коды 207 и
        208 — «версия не найдена» / «устаревшая»). Fileheader пишется один раз
        в начале файла, поэтому в live-разборе новых строк он уже не попадётся.
        """
        try:
            files = sorted(
                self.journal_path.glob("Journal.*.log"),
                key=lambda f: f.stat().st_mtime,
            ) if self.journal_path and self.journal_path.exists() else []
        except OSError:
            files = []
        if not files:
            return
        try:
            with open(files[-1], "r", encoding="utf-8-sig") as fh:
                for _index, line in enumerate(fh):
                    if _index > 20:
                        break
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    if event.get("event") in ("Fileheader", "LoadGame"):
                        self.dispatcher.set_game_version(
                            event.get("GameVersion") or event.get("gameversion"),
                            event.get("Build") or event.get("build"),
                        )
                        return
        except OSError:
            return

    def _send_inara_event(self, event: dict, live: bool = True):
        """Поставить Inara-событие в очередь диспетчера (без блокировки потока)."""
        self.dispatcher.submit(event, live=live)

    def _send_edsm_event(self, event: dict, live: bool = True):
        """Поставить EDSM-событие в очередь диспетчера.

        Раньше здесь был `threading.Thread(...).start()` на каждое событие —
        при первичной загрузке истории это тысячи одновременных потоков.
        """
        self.dispatcher.submit(event, live=live)

    def _send_carrier_event_to_raven(self, event: dict, live: bool = True):
        """Поставить операцию с грузом Fleet Carrier в очередь диспетчера."""
        station_type = str(self._last_depot_state.get("_station_type", "") or "")
        self.dispatcher.submit(event, live=live, station_type=station_type)

    def _send_edsm_text(self, text: str, live: bool = True):
        """Прогнать текст журнала через диспетчер внешних API.

        Используется только для совместимости со старыми вызовами: основной
        путь — хуки parse_events() (файл разбирается один раз, а не по разу на
        каждого потребителя).
        """
        if not live and not self.dispatcher.backfill_enabled:
            return
        for _line, event in iter_journal_events(text):
            self.dispatcher.submit(event, live=live)

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

    def _load_journal_offsets(self) -> dict:
        path = self.config_path.with_name(".colonial_helper_journal_offsets.json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_journal_offsets(self):
        path = self.config_path.with_name(".colonial_helper_journal_offsets.json")
        tmp = path.with_suffix(".tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.last_file_mtimes, fh)
            tmp.replace(path)
        except OSError as exc:
            self.root.after(0, lambda e=exc: self.log(f"Не удалось сохранить состояние журналов: {e}", "warn"))

    def _show_journal_reconciliation_progress(
        self, done_bytes: int, total_files: int, total_bytes: int, done_files: int, current_file: str
    ):
        """Обновить общий progressbar из фонового watcher-потока.

        Объём считается по байтам, поэтому большой журнал занимает на шкале
        столько же, сколько несколько маленьких, и пользователь видит не
        только номер текущего файла, но и фактически прочитанный объём.
        """
        if total_bytes:
            percent = min(100.0, done_bytes * 100.0 / total_bytes)
            done_mb = done_bytes / (1024 * 1024)
            total_mb = total_bytes / (1024 * 1024)
            detail = (
                f"Первичная загрузка: {percent:.1f}% | "
                f"файлы {done_files}/{total_files} | "
                f"{done_mb:.1f}/{total_mb:.1f} MB | {current_file}"
            )
        else:
            percent = 100.0
            detail = f"Первичная загрузка: файлов для чтения нет | {done_files}/{total_files}"
        self.progress.configure(value=percent, maximum=100)
        self.progress_label.configure(text=detail)

    def _finish_journal_reconciliation(self, message: str):
        """Оставить результат первичной сверки в UI, не стирая прогресс."""
        self.progress.configure(value=100, maximum=100)
        self.progress_label.configure(text=message)
        self.log(message, "success")

        # Итог по внешним сервисам за время первичной сверки — чтобы было
        # видно, почему она больше не длится часами.
        stats = self.dispatcher.snapshot_stats()
        if stats.get("skipped_backfill"):
            self.log(
                f"История отправлена только на ED Ring Colony: {stats['skipped_backfill']} "
                f"исторических событий не ушли в EDSM/Inara/Raven "
                f"(включается галочкой на вкладке «Загрузка логов»)",
                "info",
            )
        elif stats.get("sent") or stats.get("failed"):
            self.log(
                f"Внешние API: отправлено {stats.get('sent', 0)}, ошибок {stats.get('failed', 0)}, "
                f"в очереди {stats.get('pending', 0)}",
                "info",
            )

    def _flush_deferred_uploads(self):
        """Отправить на сайт всё, накопленное за время первичной сверки.

        Один пакет вместо сотни мелких запросов (по одному на файл), что на
        истории из 800 файлов экономило десятки минут: доставки уходят
        параллельными пачками по 100, snapshots — по 100 (лимит сервера).
        """
        self._defer_uploads = False
        deliveries, construction = self._backfill_deliveries, self._backfill_construction
        self._backfill_deliveries, self._backfill_construction = [], []
        if not deliveries and not construction:
            return
        cmdr_name = self._watcher_cmdr_name or ""

        def log(message: str, level: str = "info"):
            self.root.after(0, lambda m=message, l=level: self.log(m, l))

        log(f"Первичная загрузка: отправка на сайт — {len(deliveries)} доставок, "
            f"{len(construction)} snapshots стройки", "info")

        if construction and self.api.is_connected:
            def construction_progress(done, total_chunks):
                self._update_progress(100.0, f"Отправка snapshots стройки: {done}/{total_chunks} пачек")

            result = self.api.upload_construction_events(
                construction, cmdr_name, progress_cb=construction_progress
            )
            if result.get("ok"):
                log(f"Первичная загрузка: snapshots стройки отправлены ({len(construction)})", "success")
            else:
                log(f"Первичная загрузка: snapshots стройки не отправлены — "
                    f"{result.get('error', 'ошибка')}", "warn")

        if deliveries and self.api.is_connected:
            def delivery_progress(done, total_chunks):
                self._update_progress(100.0, f"Отправка доставок: {done}/{total_chunks} пачек")

            result = self.api.upload_deliveries(
                [self._delivery_for_api(d) for d in deliveries], cmdr_name, progress_cb=delivery_progress
            )
            if result.get("ok"):
                route_tons = sum(
                    d.get("amount", 0) for d in deliveries
                    if self.route.is_on_route(d.get("system_name", ""))
                )
                log(f"Первичная загрузка: загружено {result['inserted']} доставок "
                    f"({route_tons:.0f}t на маршрут)", "success")
                self._send_deliveries_to_raven(deliveries, cmdr_name)
            else:
                # Не теряем распарсенные доставки: сервер дедуплицирует по
                # source_hash, поэтому повторная попытка безопасна.
                self._pending_watcher_deliveries = deliveries + self._pending_watcher_deliveries
                log(f"Первичная загрузка: доставки не отправлены — {result.get('error', 'ошибка')}", "error")

        # События строительства и доставки уже обработаны — прогресс-бар
        # возвращаем в состояние "завершено".
        self.root.after(0, lambda: self._update_progress(100.0, None, force=True))

    def _watcher_loop(self):
        offsets = self._load_journal_offsets()
        self.last_file_mtimes = {}
        first_reconciliation = not bool(offsets)
        for f in sorted(self.journal_path.glob("Journal.*.log"), key=lambda f: f.stat().st_mtime):
            try:
                # Первый запуск проверяет историю с начала файлов; после этого
                # сохраняются byte offsets, как в EDDiscovery.
                self.last_file_mtimes[str(f)] = int(offsets.get(str(f), 0)) if not first_reconciliation else 0
            except (OSError, ValueError):
                pass
        startup_reconciliation = first_reconciliation or any(
            self.last_file_mtimes.get(str(f), 0) < f.stat().st_size
            for f in self.journal_path.glob("Journal.*.log")
            if f.exists()
        )
        if startup_reconciliation:
            self.root.after(0, lambda: self.log("Проверка ранее не отправленных журналов...", "info"))
            # Первичная сверка выполняется отдельным проходом, чтобы в UI был
            # виден реальный прогресс, а не только сообщение "обработка".
            reconciliation_files = []
            total_bytes = 0
            for f in sorted(self.journal_path.glob("Journal.*.log"), key=lambda p: p.stat().st_mtime):
                try:
                    size = f.stat().st_size
                    start = max(0, int(self.last_file_mtimes.get(str(f), 0)))
                    if size > start:
                        reconciliation_files.append((f, start, size))
                        total_bytes += size - start
                except OSError:
                    continue
            done_bytes = 0
            total_files = len(reconciliation_files)
            self.root.after(0, lambda n=total_files, b=total_bytes: self._show_journal_reconciliation_progress(
                0, n, b, 0, "Подготовка журналов..."
            ))
            # Отправку на сайт откладываем до конца сверки: иначе на каждый
            # файл уходит отдельный запрос (на 800 файлах — сотни запросов).
            self._defer_uploads = True
            try:
                for file_index, (f, start, size) in enumerate(reconciliation_files, 1):
                    if self.watcher_stop_event.is_set():
                        break
                    self.root.after(0, lambda i=file_index, n=total_files, p=f.name, d=done_bytes, t=total_bytes:
                        self._show_journal_reconciliation_progress(d, n, t, i - 1, p)
                    )
                    # live=False: историческая сверка. События во внешние API
                    # (EDSM/Inara/Raven) не уходят и в оверлей сессии не пишутся.
                    processed = self._process_journal_changes(f, start, size, live=False)
                    self.last_file_mtimes[str(f)] = start + processed
                    done_bytes += processed
                    self._save_journal_offsets()
                    self.root.after(0, lambda i=file_index, n=total_files, p=f.name, d=done_bytes, t=total_bytes:
                        self._show_journal_reconciliation_progress(d, n, t, i, p)
                    )
            finally:
                self._flush_deferred_uploads()
            if total_files == 0:
                self.root.after(0, lambda: self._finish_journal_reconciliation("Новых строк для загрузки не найдено"))
            elif not self.watcher_stop_event.is_set():
                self.root.after(0, lambda: self._finish_journal_reconciliation("Первичная загрузка журналов завершена"))

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
                    if current_size < last_size:
                        # Новый файл/ротация журнала.
                        last_size = 0
                    if current_size > last_size:
                        # live=True: это текущая игра, события уходят в
                        # EDSM/Inara/Raven и в оверлей.
                        processed = self._process_journal_changes(f, last_size, current_size, live=True)
                        # Обновляем только на фактически обработанные байты (полные строки)
                        self.last_file_mtimes[fpath] = last_size + processed
                        self._save_journal_offsets()
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
            # Проект ищем через кэш: все доставки на одну стройплощадку дают
            # один и тот же buildId, а раньше на каждую доставку уходил
            # отдельный HTTP-запрос (с таймаутом до 15 с).
            project = self.raven_api.get_project(address, market_id)
            if not project or not project.get("buildId"):
                continue
            build_id = project["buildId"]
            commodity = delivery.get("commodity", "Unknown")
            batch = batches.setdefault(build_id, {})
            batch[commodity] = batch.get(commodity, 0) + int(delivery.get("amount", 0))
        for build_id, commodities in batches.items():
            result = self.raven_api.contribute(build_id, cmdr_name or "Unknown", commodities)
            if result.get("ok"):
                self.root.after(
                    0,
                    lambda total=sum(commodities.values()): self.log(f"Raven Colonial: +{total}t", "success"),
                )
            else:
                self.root.after(
                    0,
                    lambda e=result.get("error", "unknown"): self.log(f"Raven Colonial: {e}", "warn"),
                )

    def _handle_tracked_event(self, ev: dict, live: bool = True):
        """Обработка одного события журнала: маршрут, корабль, оверлей.

        Вызывается из хука parse_events() — для live-тиков watcher'а и для
        исторического разбора. Оверлей сессии обновляем только в live-режиме:
        при первичной загрузке истории событий десятки тысяч, и каждый
        `overlay_manager.log_session_event()` — это отдельный `root.after()`,
        который забивает очередь Tkinter и сам по себе тормозит загрузку.
        """
        if live:
            self._log_session_event(ev)
        if ev.get("event") in ("FSDJump", "Location", "Docked", "CarrierJump"):
            sys_name = ev.get("StarSystem")
            if sys_name:
                self._session_systems_visited.add(sys_name)
                if self.route.mark_visited(sys_name):
                    self.root.after(0, self._refresh_route_tree)
                    if live:
                        self.overlay_manager.log(f"Jump: {sys_name}", "info")
        # Отслеживание корабля
        self.ship.parse_event(ev)
        ev_name = ev.get("event")
        if live and ev_name in (
            "HullDamage", "HeatDamage", "ShieldState", "ModuleDamage",
            "CockpitBreached", "AfmuRepairs", "Repair", "RepairAll",
        ):
            st = self.ship.state
            damaged = [f"{m.slot}={m.health:.0%}" for m in st.damaged_modules]
            dmg_str = f" ({', '.join(damaged)})" if damaged else ""
            self.overlay_manager.log(
                f"{ev_name}: hull {st.hull_health:.0%}, shields {st.shield_health:.0%}, "
                f"damaged {len(st.damaged_modules)} mod.{dmg_str}",
                "info",
            )

    def _process_journal_changes(self, filepath: Path, old_size: int, new_size: int, live: bool = False) -> int:
        """Обработать изменения в журнале. Возвращает количество обработанных байт.

        Читает только полные строки (заканчивающиеся на \\n).
        Неполная строка в конце блока остаётся для следующего тика.

        `live=False` — исторический разбор (первичная сверка при старте
        watcher'а). В этом режиме события НЕ уходят в EDSM/Inara/Raven и не
        пишутся в оверлей сессии: на всей истории это десятки тысяч событий,
        из-за которых первичная загрузка шла часами. `live=True` — обычный тик
        watcher'а за игрой, там поведение прежнее.
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

        # ОДИН проход по тексту: доставки, snapshots стройки, трекинг корабля
        # и (только в live-режиме) внешние API. Раньше текст разбирался дважды
        # — parse_journal() плюс отдельный построчный цикл на каждое событие.
        collector = ConstructionSnapshotCollector()

        def dispatch_hook(line, ev):
            station_type = str(self._last_depot_state.get("_station_type", "") or "")
            self.dispatcher.submit(ev, live=live, station_type=station_type)

        def tracking_hook(line, ev):
            try:
                self._handle_tracked_event(ev, live=live)
            except Exception:
                pass

        tick_cmdr_name, deliveries, self._last_cargo, self._last_depot_state, self._last_contribution_state, self._seen_events, _tick_event_counts = parse_events(
            iter_journal_events(new_text), current_system, self._last_cargo, self._last_depot_state,
            self._last_contribution_state, self._seen_events, current_system_address,
            hooks=[collector, tracking_hook, dispatch_hook, self.exobiology.handle],
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
        # Трекинг корабля/маршрута/оверлея и внешние API выполняются в хуках
        # parse_events() — тем же однопроходным разбором текста.

        self._record_session_deliveries(deliveries)
        # Snapshots стройки собираются тем же проходом, что и доставки, с
        # отсевом повторов (состояние ColonisationConstructionDepot меняется
        # заметно реже, чем пишется в журнал).
        construction_events = collector.events

        # Первичная сверка: НЕ отправляем на сайт после каждого файла (на
        # истории это сотни отдельных запросов), а накапливаем и отправляем
        # одним пакетом в конце — см. _flush_deferred_uploads().
        if self._defer_uploads:
            if deliveries:
                self._backfill_deliveries.extend(deliveries)
            if construction_events:
                self._backfill_construction.extend(construction_events)
            return processed_bytes

        if construction_events and self.api.is_connected:
            construction_result = self.api.upload_construction_events(construction_events, cmdr_name)
            if not construction_result.get("ok"):
                self.root.after(0, lambda e=construction_result.get("error", "ошибка"):
                    self.log(f"[Watcher] Прогресс строек не отправлен: {e}", "warn"))

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
