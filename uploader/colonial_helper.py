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
import math
import time
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk
from datetime import datetime
from pathlib import Path
import traceback
from typing import Optional, List
from collections import Counter, deque
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
    site_deliveries_from_text,
    ConstructionSnapshotCollector,
    PARSER_VERSION,
)
from route_tracker import RouteTracker
from overlay import (
    OverlayManager, ANCHOR_KEYS, ANCHOR_LABELS, BLOCK_LABELS,
    SIZE_PRESETS, SIZE_PRESET_LABELS, AUTO_RULES, AUTO_RULE_LABELS, IDLE_TIMEOUTS,
)
from exobiology import (
    ExobiologyTracker, ExobiologyCache, PLANET_SEARCH_PRESETS, GENUS_VALUE_CR,
    scan_journals_for_system, scan_all_journals_for_exobio, body_matches,
)
from carrier import CarrierTracker
from colonisation import (
    ConstructionSiteTracker,
    build_project_draft,
    format_commodities,
)
from map_export import save_map_png
from system_map import (
    due_timestamp,
    BODY_LABELS,
    KIND_MOON,
    KIND_STAR,
    STATION_CARRIER,
    STATION_LABELS,
    STATION_SITE,
    MapRavenCache,
    MapStation,
    SystemMapBuilder,
    commodity_label,
    layout as map_layout,
    map_report,
    map_summary,
)
from edsm_api import EDSMAPI
from inara_api import InaraAPI
from ship_tracker import ShipTracker
from event_dispatch import (ThirdPartyDispatcher, canonical_commodity,
                          normalize_commodity)
from raven_colonial_api import RavenColonialAPI, project_url
import updater

# -- Константы --
APP_NAME = "Colonial Helper"
VERSION = "2.10.15"
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
COLOR_YELLOW = "#f1c40f"            # дедлайн стройки на исходе


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
        self._session_tons_by_system: dict = {}  # тонны по системам (для инфографики)
        self._last_cargo: dict = {}  # последний инвентарь для parse_journal
        self._last_depot_state: dict = {}  # snapshot стройплощадки для отображения прогресса
        self.exobiology = ExobiologyTracker()  # тела, биосигналы, образцы (только свой журнал)
        # Груз на авианосце: сколько завезено и сколько осталось завезти
        # (блок CARRIER в оверлее, см. carrier.py).
        self.carrier = CarrierTracker()
        self._carrier_remote_market = 0  # по какому FC уже запросили Raven
        # Стройплощадки колонизации: из них вкладка «Колонизатор» заполняет
        # форму создания проекта (см. colonisation.py).
        self.construction = ConstructionSiteTracker()
        # Карта системы: тела, станции и стройплощадки с процентом завезённого
        # груза. Собирается из тех же событий журнала, что идут в остальные
        # трекеры, плюс данные Raven Colonial (вкладка «Карта системы»).
        self.system_map = SystemMapBuilder()
        self._map_zoom_index = 2              # 1.0 — индекс в MAP_ZOOM_STEPS
        self._map_selected = ""               # выбранный объект (имя тела/buildId)
        self._map_center = ""                 # центр карты: пусто = звезда системы
        self._map_redraw_job = None           # id отложенной перерисовки
        self._map_items: list = []            # что нарисовано (для клика мышью)
        self._map_last_snapshot = None        # снимок последней отрисовки
        self._map_raven_fetched: dict = {}    # система -> время запроса Raven
        self._map_raven_inflight = False      # запрос к Raven уже летит
        self._map_autorefresh_job = None      # фоновое освежение открытой вкладки
        self._map_save_job = None             # отложенное сохранение вида в конфиг
        self._colony_draft_site = None        # площадка, по которой заполнена форма
        self._colony_selected_site_id = ""     # systemSiteId выбранного плана
        self._colony_autofilled_name = ""      # название, подставленное автозаполнением
        self._colony_announced_sites = set()   # о каких площадках уже сообщили
        # Проект, отмеченный основным во вкладке «Колонизатор». Его потребность
        # показывает блок CARRIER в оверлее (см. `_carrier_need_info`).
        self.colony_primary_project: dict = {}
        self._primary_remote_id = ""       # чей основной проект перечитывали
        self._primary_remote_at = 0.0      # и когда (monotonic)
        # Проект стройплощадки, у которой командир стоит сейчас. Перечитывается
        # из Raven Colonial по таймеру: остаток потребности там общий на всех,
        # поэтому груз, который завезли другие командиры, должен уменьшать
        # «осталось завезти» и у нас. Журнал этого не знает.
        self.site_project: dict = {}
        self._site_remote_market = 0           # по какой площадке уже спросили Raven
        self._site_remote_at = 0.0             # когда последний раз спрашивали
        self._carrier_remote_at = 0.0          # когда последний раз брали груз FC
        # Что уже написано в лог про стройплощадку/авианосец: обе строки
        # перечитываются по таймеру (300 с) и без сравнения повторялись бы
        # в логе без конца, даже когда цифры не менялись.
        self._site_project_log_sig = None
        self._carrier_cargo_log_sig = None
        self._last_contribution_state: dict = {}  # { (market_id, resource): amount } для diff
        self._seen_events: set = set()  # ключи событий — защита от дублей
        self._last_delivery_system: str = ""  # последняя система доставки для оверлея
        self._session_event_count = 0
        self._last_session_event = ""
        self._watcher_cmdr_name: Optional[str] = None  # CMDR, привязанный к текущей watcher-сессии
        self._pending_watcher_deliveries: list = []  # очередь повторной отправки при временной ошибке API
        # Отправка в Raven Colonial живёт ОТДЕЛЬНО от аплоада на сайт:
        # это два разных сервера, и сбой одного не должен терять данные для
        # другого. Очередь досылается на каждом тике watcher'а, а журнал
        # отправленного (`_raven_sent`) не даёт зачесть одну и ту же доставку
        # дважды — ни при повторе, ни после перезапуска программы.
        self._pending_raven_deliveries: list = []
        self._raven_lock = threading.RLock()   # очередь досылают несколько потоков
        self._raven_last_attempt = 0.0         # когда в последний раз пробовали дослать
        self._raven_fail_streak = 0            # подряд неудач (для шага повтора)
        self._raven_no_key_warned = False      # подсказка про ключ RCC пишется один раз
        self._raven_sent: dict = {}            # source_hash -> {"build_id", "tons", "at"}
        self._raven_cmdr_cache = ""            # имя командира, каким его знает Raven
        self._raven_cmdr_asked_at = 0.0        # когда в последний раз спрашивали
        self._raven_queue_sig = ""             # состав очереди на прошлой попытке
        self._raven_attempts: dict = {}        # ключ доставки -> сколько раз пробовали
        self._raven_skip_sig = None            # о каких отказах уже написали в лог
        self._raven_skip_prev_sig = None       # предыдущая подпись (против «качелей»)
        self._raven_site_miss: dict = {}       # (address, market_id) -> (попыток, когда)
        self._raven_bound_projects: dict = {}  # buildId -> карточка привязанного проекта
        self._raven_site_warned: set = set()   # каким площадкам уже объяснили, что делать
        self._site_remaining_prev: dict = {}   # остаток потребности на прошлом опросе
        self._raven_credit_pending: dict = {}  # товар -> тонны, зачтения которых ждём
        self._raven_credit_checks = 0          # сколько снимков потребности сравнивали
        self._raven_credit_warn_sig = None     # о незачтённых тоннах пишем один раз
        self._raven_credit_prev_sig = None
        self._colony_reconcile_busy = False    # сверка стройплощадки идёт
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
        # Кэш последнего ответа Raven: карта не ждёт сеть при старте приложения.
        self.map_cache = MapRavenCache(
            self.config_path.with_name(".colonial_helper_map_cache.json"))
        # Дисковый кэш экзобиологии: сохраняет ранее отсканированные системы
        self.exobio_cache = ExobiologyCache(
            self.config_path.with_name(".colonial_helper_exobio_cache.json"))
        self.exobiology.load_from_cache(self.exobio_cache)
        self._exobio_history_scanned_systems = set()
        self.load_config()

        # Raven Colonial API
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
        self.dispatcher.on_supply_sent = self._on_raven_supply_sent

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
        # Журнал того, что уже зачтено Raven Colonial (source_hash -> тонны).
        # Не даёт зачесть одну и ту же доставку проекту дважды — ни при повторе
        # в очереди досылки, ни после перезапуска программы.
        self._raven_sent = self._load_raven_ledger()
        # Прогресс обновляем не чаще, чем раз в _PROGRESS_MIN_INTERVAL секунд:
        # на 800 файлов постоянные root.after() забивали очередь Tkinter и
        # сами по себе тормозили загрузку.
        self._progress_interval = 0.1
        self._last_progress_ts = 0.0

        # Оверлей
        self.overlay_manager = OverlayManager(self.root, self.config_path)
        # Смена фильтров на вкладке «Экзобиология» должна перерисовывать блок
        # сразу, а не ждать следующего события журнала.
        self._wire_exobio_state_provider()

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
        # Подписи того, что уже написано в лог про состояние корабля.
        # `_load_current_state_files()` зовётся из watcher-цикла каждые 5 с,
        # и без сравнения подписей одни и те же строки про модули и
        # прочитанные файлы повторялись в логе без конца.
        self._modules_log_sig = None
        self._modules_log_prev_sig = None
        self._state_files_log_sig = None
        self.after(1000, self._tick_game_status)

        # Проверка обновлений — через пару секунд после старта, чтобы не
        # мешать отрисовке окна и автопроверке токена.
        self._update_busy = False
        self.after(2500, self._auto_check_update)

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
    #: Каналы обновлений: какие релизы GitHub предлагать.
    #: CI публикует сборки и с main (полноценный релиз), и с arena/**
    #: (prerelease) — см. .github/workflows/build-exe.yml.
    UPDATE_CHANNEL_LABELS = {
        "stable": "Только стабильные (main)",
        "all": "Все сборки (включая arena)",
    }

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

        # Обновления: кнопка проверки, канал и автопроверка при запуске.
        update_frame = tb.Frame(frame)
        update_frame.pack(fill=X, pady=(6, 0))

        self.update_button = tb.Button(
            update_frame,
            text="⟳  Обновить программу",
            width=22,
            bootstyle="info-outline",
            command=lambda: self._on_check_update(manual=True),
        )
        self.update_button.pack(side=LEFT, padx=(0, 8))

        self.update_channel_var = tk.StringVar(value=self._update_channel_label())
        self.update_channel_combo = tb.Combobox(
            update_frame,
            textvariable=self.update_channel_var,
            width=26,
            state="readonly",
            values=[text for text in self.UPDATE_CHANNEL_LABELS.values()],
        )
        self.update_channel_combo.pack(side=LEFT, padx=(0, 8))
        self.update_channel_combo.bind(
            "<<ComboboxSelected>>", lambda _e: self._on_update_settings_changed())

        self.update_auto_var = tk.BooleanVar(
            value=bool(self.config.get("update_check_enabled", True)))
        tb.Checkbutton(
            update_frame,
            text="проверять при запуске",
            variable=self.update_auto_var,
            command=self._on_update_settings_changed,
        ).pack(side=LEFT)

        self.update_hint = tb.Label(
            update_frame,
            text=f"установлена v{VERSION}",
            font=("Consolas", 9),
            foreground=COLOR_MUTED,
        )
        self.update_hint.pack(side=RIGHT)

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

        self.tab_map = tb.Frame(self.notebook)
        self.notebook.add(self.tab_map, text=" Карта системы ")
        self._build_tab_map()

        self.tab_overlay = tb.Frame(self.notebook)
        self.notebook.add(self.tab_overlay, text=" Оверлей ")
        self._build_tab_overlay()

        self.tab_exobio = tb.Frame(self.notebook)
        self.notebook.add(self.tab_exobio, text=" Экзобиология ")
        self._build_tab_exobio()

        self.tab_log = tb.Frame(self.notebook)
        self.notebook.add(self.tab_log, text=" Лог ")
        self._build_tab_log()

        # Карта системы перерисовывается, когда вкладку открыли: рисовать её
        # в фоне бессмысленно, а данные к тому времени уже успевают устареть.
        self.notebook.bind("<<NotebookTabChanged>>", self._on_notebook_tab_changed)

    # ============================================================
    #  Вкладка: Подключение
    # ============================================================
    def _build_tab_auth(self):
        # Вкладка содержит несколько API и полей. На небольших окнах вся
        # форма должна прокручиваться, а не обрезаться снизу.
        frame = self._scrollable_frame(self.tab_auth)

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
    #  Инфографика пилота: крупные плитки, спарклайны, компактный режим
    # ============================================================
    # Сколько точек держим в спарклайнах (при шаге 2 с — около 6 минут).
    PILOT_SERIES_LIMIT = 180
    PILOT_SAMPLE_SECONDS = 2.0

    @staticmethod
    def _pilot_percent(value) -> float:
        try:
            return max(0.0, min(100.0, float(value or 0)))
        except (TypeError, ValueError):
            return 0.0

    def _pilot_init_state(self):
        self._pilot_compact = bool(self.config.get("pilot_compact", False))
        self._pilot_series = {
            "tons": deque(maxlen=self.PILOT_SERIES_LIMIT),
            "cargo": deque(maxlen=self.PILOT_SERIES_LIMIT),
            "hull": deque(maxlen=self.PILOT_SERIES_LIMIT),
        }
        self._pilot_tiles = {}
        self._pilot_bars = {}
        self._pilot_canvases = {}
        self._pilot_columns = 0
        self._pilot_last_sample = 0.0
        self._pilot_resize_job = None
        self._pilot_refresh_job = None
        self._pilot_journal_cache = ("", 0.0)

    def _build_tab_pilot(self):
        self._pilot_init_state()
        viewport = tb.Frame(self.tab_pilot)
        viewport.pack(fill=BOTH, expand=True)

        header = tb.Frame(viewport, padding=(15, 12, 15, 4))
        header.pack(fill=X)
        tb.Label(header, text="ИНФОГРАФИКА ПИЛОТА", font=("Consolas", 15, "bold"),
                 foreground=COLOR_ORANGE).pack(side=LEFT)
        self._pilot_compact_var = tk.BooleanVar(value=self._pilot_compact)
        tb.Checkbutton(header, text="Компактный режим", variable=self._pilot_compact_var,
                       command=self._on_pilot_compact_changed).pack(side=RIGHT)
        tb.Button(header, text="Обновить", command=self._refresh_pilot_infographic,
                  bootstyle="info-outline", width=12).pack(side=RIGHT, padx=(0, 12))
        self._pilot_updated_label = tb.Label(header, text="", foreground=COLOR_MUTED)
        self._pilot_updated_label.pack(side=RIGHT, padx=(0, 12))

        tb.Label(
            viewport,
            text="Живые данные из журнала, трекера корабля, маршрута и текущей сессии. "
                 "Сетевых запросов инфографика не делает.",
            foreground=COLOR_MUTED,
            wraplength=900,
        ).pack(anchor=W, padx=15, pady=(0, 8))

        self._pilot_body = tb.Frame(viewport, padding=(9, 0, 9, 9))
        self._pilot_body.pack(fill=BOTH, expand=True)
        # Раскладка пересобирается при изменении ширины окна: на узком окне
        # три колонки превращаются в две и в одну, а не «сплющиваются».
        self.tab_pilot.bind("<Configure>", self._on_pilot_resize)

        self._rebuild_pilot_layout()
        self._refresh_pilot_infographic()

    # -- раскладка ---------------------------------------------------------
    def _on_pilot_compact_changed(self):
        self._pilot_compact = bool(self._pilot_compact_var.get())
        self.config["pilot_compact"] = self._pilot_compact
        self.save_config()
        self._rebuild_pilot_layout()
        self._refresh_pilot_infographic()

    def _on_pilot_resize(self, _event=None):
        if self._pilot_resize_job:
            try:
                self.root.after_cancel(self._pilot_resize_job)
            except Exception:
                pass
        self._pilot_resize_job = self.root.after(250, self._rebuild_pilot_layout_if_needed)

    def _rebuild_pilot_layout_if_needed(self):
        self._pilot_resize_job = None
        if self._pilot_column_count() != self._pilot_columns:
            self._rebuild_pilot_layout()
            self._refresh_pilot_infographic()

    def _pilot_window_width(self) -> int:
        try:
            width = int(self.root.winfo_width())
        except Exception:
            width = 0
        return width if width > 0 else 1100

    def _pilot_column_count(self) -> int:
        width = self._pilot_window_width()
        if self._pilot_compact:
            if width >= 1180:
                return 4
            if width >= 880:
                return 3
            return 2 if width >= 620 else 1
        if width >= 1300:
            return 3
        if width >= 840:
            return 2
        return 1

    def _rebuild_pilot_layout(self):
        for child in list(self._pilot_body.winfo_children()):
            try:
                child.destroy()
            except Exception:
                pass
        self._pilot_tiles.clear()
        self._pilot_bars.clear()
        self._pilot_canvases.clear()

        compact = self._pilot_compact
        columns = self._pilot_column_count()
        self._pilot_columns = columns
        pad = (6, 4) if compact else (10, 8)

        # 1. Крупные показатели — вся ширина окна
        kpi_row = tb.Frame(self._pilot_body)
        kpi_row.pack(fill=X, pady=(0, 8))
        for index in range(4):
            kpi_row.columnconfigure(index, weight=1, uniform="pilot_kpi")
        self._pilot_kpi(kpi_row, "kpi_tons", "ТОННЫ ЗА СЕССИЮ", COLOR_GREEN, index=0, pad=pad)
        self._pilot_kpi(kpi_row, "kpi_deliveries", "ДОСТАВКИ", COLOR_CYAN, index=1, pad=pad)
        self._pilot_kpi(kpi_row, "kpi_cargo", "ГРУЗ", COLOR_ORANGE, index=2, pad=pad)
        self._pilot_kpi(kpi_row, "kpi_systems", "СИСТЕМЫ", COLOR_CYAN, index=3, pad=pad)

        # 2. Плитки с деталями — сетка, число колонок зависит от ширины
        grid = tb.Frame(self._pilot_body)
        grid.pack(fill=BOTH, expand=True)
        for index in range(columns):
            grid.columnconfigure(index, weight=1, uniform="pilot_grid")

        tiles = [
            ("session", self._pilot_tile_session),
            ("ship", self._pilot_tile_ship),
            ("route", self._pilot_tile_route),
            ("systems", self._pilot_tile_systems),
            ("status", self._pilot_tile_status),
            ("journal", self._pilot_tile_journal),
        ]
        for index, (_key, builder) in enumerate(tiles):
            row, column = divmod(index, columns)
            grid.rowconfigure(row, weight=1)
            builder(grid, row=row, column=column, pad=pad)

    # -- строители плиток --------------------------------------------------
    def _pilot_card(self, parent, title, row=None, column=None, pad=(10, 8), columnspan=1):
        """Рамка плитки с заголовком; возвращает внутренний контейнер."""
        card = tb.Frame(parent, relief="solid", borderwidth=1, padding=pad)
        if row is None:
            card.pack(fill=BOTH, expand=True, padx=6, pady=6)
        else:
            card.grid(row=row, column=column, columnspan=columnspan,
                      sticky="nsew", padx=6, pady=6)
        title_font = ("Consolas", 9 if self._pilot_compact else 10, "bold")
        tb.Label(card, text=title, font=title_font, foreground=COLOR_ORANGE).pack(anchor=W)
        body = tb.Frame(card)
        body.pack(fill=BOTH, expand=True, pady=(4, 0))
        return body

    def _pilot_kpi(self, parent, key, title, color, index=0, pad=(10, 8)):
        card = tb.Frame(parent, relief="solid", borderwidth=1, padding=pad)
        card.grid(row=0, column=index, sticky="nsew", padx=6, pady=2)
        tb.Label(card, text=title, font=("Consolas", 9, "bold"),
                 foreground=COLOR_MUTED).pack(anchor=W)
        value_font = ("Consolas", 20 if self._pilot_compact else 28, "bold")
        self._pilot_tiles[key] = tb.Label(card, text="—", font=value_font, foreground=color)
        self._pilot_tiles[key].pack(anchor=W)
        self._pilot_tiles[f"{key}_sub"] = tb.Label(
            card, text="", font=("Consolas", 9), foreground=COLOR_MUTED, wraplength=260)
        self._pilot_tiles[f"{key}_sub"].pack(anchor=W)

    def _pilot_row(self, parent, key, label, value="—", color=None):
        """Строка «подпись … значение» внутри плитки."""
        row = tb.Frame(parent)
        row.pack(fill=X, pady=1)
        tb.Label(row, text=label, font=("Consolas", 9), foreground=COLOR_MUTED).pack(side=LEFT)
        value_label = tb.Label(
            row, text=value, font=("Consolas", 10, "bold"),
            foreground=color or COLOR_CYAN)
        value_label.pack(side=RIGHT)
        self._pilot_tiles[key] = value_label
        return value_label

    def _pilot_bar(self, parent, key, label):
        frame = tb.Frame(parent)
        frame.pack(fill=X, pady=(4, 0))
        tb.Label(frame, text=label, font=("Consolas", 9), foreground=COLOR_MUTED).pack(anchor=W)
        bar = tb.Progressbar(frame, mode="determinate", length=100)
        bar.pack(fill=X)
        self._pilot_bars[key] = bar

    def _pilot_canvas(self, parent, key, height=70):
        canvas = tk.Canvas(parent, height=height, highlightthickness=0, borderwidth=0)
        canvas.pack(fill=X, pady=(4, 2))
        self._pilot_canvases[key] = canvas
        return canvas

    def _pilot_tile_session(self, parent, row, column, pad):
        body = self._pilot_card(parent, "ДИНАМИКА СЕССИИ", row=row, column=column, pad=pad)
        self._pilot_canvas(body, "spark_tons", height=64)
        self._pilot_row(body, "session_rate", "Темп")
        self._pilot_row(body, "session_construction", "На стройки")
        self._pilot_row(body, "session_route", "На маршруте")

    def _pilot_tile_ship(self, parent, row, column, pad):
        body = self._pilot_card(parent, "КОРАБЛЬ", row=row, column=column, pad=pad)
        self._pilot_row(body, "ship", "Корабль")
        self._pilot_bar(body, "hull_bar", "Корпус")
        self._pilot_bar(body, "shield_bar", "Щиты")
        self._pilot_bar(body, "fuel_bar", "Топливо")
        self._pilot_bar(body, "power_bar", "Энергия")
        self._pilot_row(body, "modules", "Модули")

    def _pilot_tile_route(self, parent, row, column, pad):
        body = self._pilot_card(parent, "МАРШРУТ", row=row, column=column, pad=pad)
        self._pilot_row(body, "route_status", "Пройдено")
        self._pilot_bar(body, "route_progress", "Прогресс")
        self._pilot_row(body, "route_current", "Текущая")
        self._pilot_row(body, "route_next", "Следующая")
        self._pilot_row(body, "route_remaining", "Осталось")
        self._pilot_row(body, "last_delivery", "Последняя доставка")

    def _pilot_tile_systems(self, parent, row, column, pad):
        body = self._pilot_card(parent, "ТОП СИСТЕМ ПО ТОННАМ", row=row, column=column, pad=pad)
        self._pilot_canvas(body, "bars_systems", height=110)

    def _pilot_tile_status(self, parent, row, column, pad):
        body = self._pilot_card(parent, "СТАТУС И ПОДКЛЮЧЕНИЯ", row=row, column=column, pad=pad)
        self._pilot_row(body, "commander", "CMDR")
        self._pilot_row(body, "system", "Система")
        self._pilot_row(body, "game", "Игра")
        self._pilot_row(body, "watcher", "Watcher")
        self._pilot_row(body, "services", "Сервисы")
        self._pilot_row(body, "exobio", "Экзобиология")

    def _pilot_tile_journal(self, parent, row, column, pad):
        body = self._pilot_card(parent, "ЖУРНАЛЫ И ЭКОНОМИКА", row=row, column=column, pad=pad)
        self._pilot_row(body, "balance", "Баланс")
        self._pilot_row(body, "rebuy", "Страховка")
        self._pilot_row(body, "legal", "Правовой статус")
        self._pilot_row(body, "journal_state", "Журналы")
        self._pilot_row(body, "event_summary", "События")
        self._pilot_row(body, "last_event", "Последнее", color=COLOR_MUTED)

    # -- отрисовка графиков ------------------------------------------------
    def _pilot_draw_sparkline(self, canvas, values, color, label=""):
        """Спарклайн: линия с заливкой. Без внешних библиотек — чистый Canvas."""
        try:
            canvas.delete("all")
            width = int(canvas.winfo_width()) or 240
            height = int(canvas.winfo_height()) or 60
            if width < 10 or height < 10:
                return
            points = [float(v) for v in values]
            if len(points) < 2:
                canvas.create_text(6, height // 2, anchor="w", fill=COLOR_MUTED,
                                   text=label or "накопление данных…", font=("Consolas", 8))
                return
            low, high = min(points), max(points)
            if high - low < 1e-9:
                low, high = low - 1.0, high + 1.0
            pad_y = 4
            usable = max(1, height - pad_y * 2)
            step_x = width / float(len(points) - 1)
            coords = []
            for index, value in enumerate(points):
                x = index * step_x
                y = pad_y + (1.0 - (value - low) / (high - low)) * usable
                coords.extend((x, y))
            canvas.create_polygon([coords[0], height] + coords + [coords[-2], height],
                                  fill=color, stipple="gray50", outline="")
            canvas.create_line(*coords, fill=color, width=2, smooth=True)
            canvas.create_text(4, 10, anchor="w", fill=color, font=("Consolas", 9, "bold"),
                               text=f"{points[-1]:.0f}")
        except Exception:
            pass

    def _pilot_draw_bars(self, canvas, rows, color):
        """Горизонтальные полосы: [(подпись, значение), ...]."""
        try:
            canvas.delete("all")
            width = int(canvas.winfo_width()) or 240
            height = int(canvas.winfo_height()) or 100
            if width < 10 or height < 10 or not rows:
                canvas.create_text(6, height // 2 or 10, anchor="w", fill=COLOR_MUTED,
                                   text="данных пока нет", font=("Consolas", 8))
                return
            maximum = max(value for _label, value in rows) or 1
            row_height = max(14, min(26, height // max(1, len(rows))))
            for index, (label, value) in enumerate(rows[:8]):
                top = index * row_height + 2
                bar_width = int((width - 90) * (value / maximum))
                canvas.create_rectangle(0, top, max(2, bar_width), top + row_height - 6,
                                        fill=color, outline="")
                canvas.create_text(2, top + row_height - 4, anchor="sw", fill=COLOR_MUTED,
                                   font=("Consolas", 8), text=str(label)[:28])
                canvas.create_text(width - 2, top + row_height - 4, anchor="se",
                                   fill=COLOR_TEXT, font=("Consolas", 8, "bold"),
                                   text=f"{value:.0f} t")
        except Exception:
            return

    # -- обновление --------------------------------------------------------
    def _pilot_sample_series(self, state: dict):
        """Снять точку для спарклайнов (не чаще раза в PILOT_SAMPLE_SECONDS)."""
        now = time.monotonic()
        if now - self._pilot_last_sample < self.PILOT_SAMPLE_SECONDS:
            return
        self._pilot_last_sample = now
        self._pilot_series["tons"].append(float(self._session_cargo_tons or 0))
        self._pilot_series["cargo"].append(float(state.get("cargo_count", 0) or 0))
        self._pilot_series["hull"].append(self._pilot_percent(state.get("hull_percent")))

    def _pilot_rate(self) -> float:
        """Тонн в час по последним точкам серии."""
        series = self._pilot_series["tons"]
        if len(series) < 2:
            return 0.0
        delta = float(series[-1]) - float(series[0])
        minutes = max(1.0, (len(series) - 1) * self.PILOT_SAMPLE_SECONDS / 60.0)
        return delta / minutes * 60.0

    def _refresh_pilot_infographic(self):
        """Обновить инфографику только локальным состоянием приложения."""
        if not hasattr(self, "_pilot_tiles"):
            return
        try:
            state = self.ship.get_state_dict()
            route_total = len(self.route.systems)
            visited = self.route.visited_count
            route_percent = (visited / route_total * 100) if route_total else 0.0
            current = self.ship.state.current_system or "—"
            ship_name = state.get("ship_type") or "Корабль не определён"
            services = " / ".join(
                name for name, enabled in (
                    ("ED", self.api.is_connected), ("Raven", self.raven_api.is_connected),
                    ("EDSM", self.edsm_api.enabled), ("Inara", self.inara_api.enabled),
                ) if enabled
            ) or "нет подключений"
            cargo = float(state.get("cargo_count", 0) or 0)
            capacity = float(state.get("cargo_capacity", 0) or 0)
            cargo_percent = cargo / capacity * 100 if capacity > 0 else 0.0
            damaged = int(state.get("damaged_count", 0) or 0)
            total_modules = len(state.get("modules", []))
            event_count = self._session_event_count
            game_state = self.overlay_manager.game_state()
            exobio = self.exobiology.current_body_state() if hasattr(self, "exobiology") else None

            self._pilot_sample_series(state)

            # --- крупные показатели ---
            self._pilot_set("kpi_tons", f"{self._session_cargo_tons:.0f} t")
            self._pilot_set("kpi_tons_sub", f"на маршрут {self._session_route_cargo_tons:.0f} t · на стройки {self._session_construction_cargo_tons:.0f} t")
            self._pilot_set("kpi_deliveries", str(self._session_deliveries))
            self._pilot_set("kpi_deliveries_sub", f"событий в сессии: {event_count}")
            self._pilot_set("kpi_cargo", f"{cargo:.0f} / {capacity:.0f} t")
            self._pilot_set("kpi_cargo_sub", f"трюм заполнен на {cargo_percent:.0f}%")
            self._pilot_set("kpi_systems", str(len(self._session_systems_visited)))
            self._pilot_set("kpi_systems_sub", f"маршрут: {visited}/{route_total}" if route_total else "маршрут не загружен")

            # --- динамика ---
            self._pilot_set("session_rate", f"{self._pilot_rate():.0f} t/час")
            self._pilot_set("session_construction", f"{self._session_construction_cargo_tons:.0f} t")
            self._pilot_set("session_route", f"{self._session_route_deliveries} / {self._session_route_cargo_tons:.0f} t")

            # --- корабль ---
            self._pilot_set("ship", ship_name)
            self._pilot_set("modules", f"{total_modules - damaged}/{total_modules} исправны")
            for key, value in {
                "hull_bar": self._pilot_percent(state.get("hull_percent")),
                "shield_bar": self._pilot_percent(state.get("shield_percent")),
                "fuel_bar": self._pilot_percent(state.get("fuel_percent")),
                "power_bar": self._pilot_percent(state.get("power_percent")),
            }.items():
                if key in self._pilot_bars:
                    self._pilot_bars[key].configure(value=value)

            # --- маршрут ---
            self._pilot_set("route_status", f"{visited}/{route_total} систем" if route_total else "не загружен")
            if "route_progress" in self._pilot_bars:
                self._pilot_bars["route_progress"].configure(value=route_percent)
            overlay_data = self._get_overlay_data()
            self._pilot_set("route_current", str(overlay_data.get("current", "—")))
            self._pilot_set("route_next", str(overlay_data.get("next", "—")))
            self._pilot_set("route_remaining", str(max(0, route_total - visited)))
            self._pilot_set("last_delivery", self._last_delivery_system or "—")

            # --- статус и подключения ---
            self._pilot_set("commander", self._current_cmdr_name() or "CMDR не определён")
            self._pilot_set("system", current)
            game_text = "запущена (в фокусе)" if game_state.focused else ("запущена" if game_state.running else "не запущена")
            if game_state.error:
                game_text = f"нет данных ({game_state.error})"
            self._pilot_set("game", game_text)
            self._pilot_set("watcher", "АКТИВЕН" if self.watcher_active else "остановлен")
            self._pilot_set("services", services)
            if exobio:
                genera = ", ".join(row["genus"] for row in (exobio.get("predictions") or [])[:3])
                exobio_text = f"{exobio.get('body')}: {exobio.get('bio_signals', 0)} сигналов"
                if genera:
                    exobio_text += f" · {genera}"
            else:
                exobio_text = "тело не отсканировано"
            self._pilot_set("exobio", exobio_text)

            # --- журналы и экономика ---
            self._pilot_set("balance", f"{int(state.get('balance', 0) or 0):,} cr".replace(",", " "))
            self._pilot_set("rebuy", f"{int(state.get('rebuy', 0) or 0):,} cr".replace(",", " "))
            self._pilot_set("legal", state.get("legal_state") or "неизвестно")
            self._pilot_set("journal_state", self._pilot_journal_state())
            self._pilot_set("event_summary", f"{event_count} событий" if event_count else "ожидание событий")
            self._pilot_set("last_event", (self._last_session_event or "—")[:48])

            # --- графики ---
            if "spark_tons" in self._pilot_canvases:
                self._pilot_draw_sparkline(self._pilot_canvases["spark_tons"],
                                           self._pilot_series["tons"], COLOR_GREEN,
                                           "журнал пока пуст")
            if "bars_systems" in self._pilot_canvases:
                rows = sorted(getattr(self, "_session_tons_by_system", {}).items(),
                              key=lambda item: item[1], reverse=True)
                self._pilot_draw_bars(self._pilot_canvases["bars_systems"], rows, COLOR_CYAN)

            self._pilot_updated_label.configure(text=datetime.now().strftime("%H:%M:%S"))
        except Exception:
            # Инфографика не должна мешать watcher/UI при неполном состоянии
            # трекера во время самого первого чтения Journal.
            pass
        # Обновление идёт ровно одной цепочкой: кнопка «Обновить» и смена
        # раскладки не должны плодить параллельные таймеры.
        if self._pilot_refresh_job is None and self.root.winfo_exists():
            self._pilot_refresh_job = self.root.after(1000, self._pilot_tick)

    def _pilot_tick(self):
        """Плановый тик автообновления (освобождает слот таймера)."""
        self._pilot_refresh_job = None
        self._refresh_pilot_infographic()

    def _pilot_set(self, key: str, text: str):
        label = self._pilot_tiles.get(key)
        if label is not None:
            try:
                label.configure(text=text)
            except Exception:
                pass

    def _pilot_journal_count(self) -> int:
        """Сколько файлов журналов в папке (сканируем не чаще раза в 15 с)."""
        text, stamp = self._pilot_journal_cache
        if text and time.monotonic() - stamp < 15:
            return int(text)
        try:
            files = list(self.journal_path.glob("Journal.*.log")) if self.journal_path else []
        except OSError:
            files = []
        self._pilot_journal_cache = (str(len(files)), time.monotonic())
        return len(files)

    def _pilot_journal_state(self) -> str:
        """Короткая сводка по журналам: сколько файлов и отслеживается ли."""
        count = self._pilot_journal_count()
        if not count:
            return "папка журналов не выбрана"
        return f"{count} файлов · {'слежение' if self.watcher_active else 'ожидание'}"

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
    # ============================================================
    #  Вкладка: Колонизатор
    # ============================================================
    def _scrollable_frame(self, parent, padding: int = 15):
        """Прокручиваемая область вкладки.

        На вкладках «Подключение», «Колонизатор» и «Оверлей» элементов больше, чем
        помещается в окно 800×550, поэтому содержимое живёт внутри canvas.
        Колесо мыши привязывается к canvas при входе курсора и отвязывается
        при выходе — иначе последняя построенная вкладка перехватывала бы
        прокрутку у всех остальных (так было с `bind_all` на этапе сборки).
        """
        viewport = tb.Frame(parent)
        viewport.pack(fill=BOTH, expand=True)
        canvas = tk.Canvas(viewport, highlightthickness=0, borderwidth=0)
        scrollbar = tb.Scrollbar(viewport, orient=VERTICAL, command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side=RIGHT, fill=Y)
        canvas.pack(side=LEFT, fill=BOTH, expand=True)
        frame = tb.Frame(canvas, padding=padding)
        window_id = canvas.create_window((0, 0), window=frame, anchor="nw")
        frame.bind("<Configure>", lambda _e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda e: canvas.itemconfigure(window_id, width=e.width))

        def on_enter(_event=None):
            canvas.bind_all("<MouseWheel>", lambda ev: canvas.yview_scroll(int(-ev.delta / 120), "units"))

        def on_leave(_event=None):
            try:
                canvas.unbind_all("<MouseWheel>")
            except Exception:
                pass

        canvas.bind("<Enter>", on_enter)
        canvas.bind("<Leave>", on_leave)
        return frame

    def _build_tab_colony(self):
        frame = self._scrollable_frame(self.tab_colony)

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
        tree_frame.pack(fill=BOTH, expand=False)
        columns = ("primary", "system", "build", "type", "progress", "build_id")
        self.colony_tree = tb.Treeview(
            tree_frame, columns=columns, show="headings", bootstyle="dark", height=8,
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
        self.colony_tree.bind("<Double-1>", lambda _e: self._on_colony_open_project())

        # ---- Действия с выбранным проектом ----
        actions = tb.Frame(frame)
        actions.pack(fill=X, pady=(10, 0))
        self.colony_action_buttons = []
        for text, command, style in [
            ("★ Сделать основным", self._on_colony_set_primary, "success-outline"),
            ("Снять основной", self._on_colony_clear_primary, "secondary-outline"),
            ("Завершить проект", self._on_colony_complete, "danger-outline"),
            ("Копировать buildId", self._on_colony_copy_id, "info-outline"),
            ("Открыть в Raven Colonial", self._on_colony_open_project, "info-outline"),
            # Привязка нужна, когда автоматически сопоставить площадку с
            # проектом нельзя: проект создавали через сайт (marketId другой)
            # или в системе несколько активных проектов. Без неё тонны
            # зависают в очереди с «проект не найден».
            ("Привязать площадку к проекту", self._on_colony_bind_site, "warning-outline"),
            ("Снять привязку площадки", self._on_colony_unbind_site, "secondary-outline"),
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

        # Строка автозаполнения: что известно из журнала прямо сейчас.
        autofill = tb.Frame(frame)
        autofill.pack(fill=X, pady=(0, 6))
        tb.Button(autofill, text="Заполнить из журнала", command=self._on_colony_fill_current,
                  bootstyle="primary-outline", width=24).pack(side=LEFT, padx=(0, 10))
        # Сверка: сколько осталось завезти по данным Raven Colonial (там учтён
        # и груз других командиров) против того, что завезли вы по журналу, и
        # досылка того, что не ушло из-за прерванной сессии или сбоя сети.
        tb.Button(autofill, text="Сверить стройплощадку с Raven",
                  command=self._on_colony_reconcile,
                  bootstyle="warning-outline", width=30).pack(side=LEFT, padx=(0, 10))
        self.colony_autofill_var = tk.BooleanVar(value=bool(self.config.get("colony_autofill", True)))
        tb.Checkbutton(
            autofill, text="Заполнять автоматически при посадке на стройплощадку",
            variable=self.colony_autofill_var, command=self._on_colony_autofill_changed,
        ).pack(side=LEFT, padx=(0, 10))
        self.colony_open_page_var = tk.BooleanVar(
            value=bool(self.config.get("colony_open_page_after_create", True)))
        tb.Checkbutton(
            autofill, text="Открывать страницу проекта после создания",
            variable=self.colony_open_page_var, command=self._on_colony_autofill_changed,
        ).pack(side=LEFT)

        self.colony_site_label = tb.Label(
            frame, text="Стройплощадка не найдена — пристыкуйтесь к Construction Ship / площадке.",
            foreground=COLOR_MUTED, font=("Consolas", 9), wraplength=780,
        )
        self.colony_site_label.pack(anchor=W, pady=(0, 8))

        form = tb.Frame(frame)
        form.pack(fill=X)
        self.colony_fields = {}
        self.colony_entries = {}

        def add_field(key: str, label: str, row: int, column: int, values: tuple = ()):
            """Пара «подпись + поле» в сетке формы. `*` в подписи — поле обязательное."""
            tb.Label(form, text=label, width=18, anchor=W).grid(
                row=row, column=column * 2, sticky=W, pady=2, padx=(0 if column == 0 else 14, 4))
            var = tk.StringVar(value="")
            self.colony_fields[key] = var
            if values:
                entry = tb.Combobox(form, textvariable=var, width=26, values=values)
            else:
                entry = tb.Entry(form, textvariable=var, width=28)
            entry.grid(row=row, column=column * 2 + 1, sticky=W, pady=2)
            self.colony_entries[key] = entry
            if key == "buildType":
                # Подсказки берём из своих проектов и планов системы — список
                # всегда актуальный и не зависит от захардкоженных данных.
                self.colony_build_type_entry = entry
            return entry

        # Обязательные поля Raven Colonial (схема ProjectCreate) помечены *.
        add_field("systemName", "Система", 0, 0)
        add_field("marketId", "Market ID *", 0, 1)
        add_field("systemAddress", "System address *", 1, 0)
        add_field("buildName", "Название *", 1, 1)
        add_field("buildType", "Тип постройки", 2, 0)
        add_field("maxNeed", "maxNeed (всего)", 2, 1)
        add_field("bodyName", "Тело", 3, 0)
        add_field("bodyNum", "Номер тела", 3, 1)
        add_field("architectName", "Архитектор", 4, 0)
        add_field("discordLink", "Discord-ссылка", 4, 1)

        # Запланированные площадки Raven Colonial (systemSiteId): если площадка
        # уже внесена в план системы, проект привязывается к ней, а тип и тело
        # подставляются из плана.
        tb.Label(form, text="План площадки", width=18, anchor=W).grid(
            row=5, column=0, sticky=W, pady=2, padx=(0, 4))
        self.colony_site_plan_var = tk.StringVar(value="")
        self.colony_site_plan_combo = tb.Combobox(
            form, textvariable=self.colony_site_plan_var, width=26,
            values=("Нет (создать новый план)",),
        )
        self.colony_site_plan_combo.grid(row=5, column=1, sticky=W, pady=2)
        self.colony_site_plan_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_colony_plan_selected())
        self._colony_site_plans: list = []

        self.colony_primary_port_var = tk.BooleanVar(value=False)
        tb.Checkbutton(form, text="Основной порт системы", variable=self.colony_primary_port_var).grid(
            row=5, column=2, columnspan=2, sticky=W, pady=2, padx=(14, 0))

        tb.Label(form, text="Заметки", width=18, anchor=W).grid(
            row=6, column=0, sticky="nw", pady=2, padx=(0, 4))
        self.colony_fields["notes"] = tk.StringVar(value="")
        tb.Entry(form, textvariable=self.colony_fields["notes"], width=64).grid(
            row=6, column=1, columnspan=3, sticky=W, pady=2)

        tb.Label(form, text="StarPos", width=18, anchor=W).grid(
            row=7, column=0, sticky=W, pady=2, padx=(0, 4))
        self.colony_starpos_var = tk.StringVar(value="")
        tb.Entry(form, textvariable=self.colony_starpos_var, width=64, state="readonly").grid(
            row=7, column=1, columnspan=3, sticky=W, pady=2)

        tb.Label(
            form,
            text="Товары (остаток потребности), формат: aluminium:1200, steel:900",
            width=18, anchor=W,
        ).grid(row=8, column=0, sticky=W, pady=(6, 0), padx=(0, 4))
        self.colony_commodities_var = tk.StringVar(value="")
        tb.Entry(form, textvariable=self.colony_commodities_var, width=64).grid(
            row=8, column=1, columnspan=3, sticky=W)

        buttons = tb.Frame(frame)
        buttons.pack(anchor=W, pady=(10, 0))
        self.colony_create_btn = tb.Button(
            buttons, text="Создать проект", command=self._on_colony_create,
            bootstyle="success-outline", width=20,
        )
        self.colony_create_btn.pack(side=LEFT, padx=(0, 8))
        tb.Button(buttons, text="Очистить форму", command=self._on_colony_clear_form,
                  bootstyle="secondary-outline", width=18).pack(side=LEFT, padx=(0, 8))
        tb.Button(buttons, text="Проверить площадку в системе", command=self._on_colony_check_system,
                  bootstyle="info-outline", width=28).pack(side=LEFT)

        self._update_colony_key_label()
        self._colony_form_baseline = self._colony_form_snapshot()
        self._update_colony_site_label()
        # Если ключ RCC уже сохранён, имя пилота подставляем сразу, не дожидаясь
        # нажатия «Проверить ключ».
        if self.raven_api.is_connected:
            self._autofill_cmdr_from_key()

    # ---------- Колонизатор: состояние ----------
    def _autofill_cmdr_from_key(self):
        """Узнать имя пилота по сохранённому ключу RCC (в фоновом потоке)."""
        key = (self.raven_api.api_key or "").strip()
        if not key:
            return

        def worker():
            result = self.raven_api.get_cmdr_by_key(key)
            if not result.get("ok"):
                return
            name = self.raven_api.cmdr_display_name(result)
            if name:
                self.root.after(0, lambda n=name: self._apply_rcc_commander(n))

        threading.Thread(target=worker, daemon=True).start()

    def _current_cmdr_name(self) -> str:
        """Имя командира: из токена сайта, из журнала или вручную."""
        for candidate in (
            getattr(self.api, "cmdr_name", "") or "",
            self._watcher_cmdr_name or "",
            self.config.get("cmdr_name", "") or "",
            getattr(self.construction, "commander", "") or "",
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
        if hasattr(self, "colony_create_btn"):
            self.colony_create_btn.config(state="disabled" if busy else "normal")
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
        self._colony_add_build_type_hints(build_types)
        self._colony_projects_cache = {p.get("buildId"): p for p in projects}
        # Основной проект Raven — он же источник списка материалов в оверлее.
        self._sync_colony_primary_project(primary_id)

    def _sync_colony_primary_project(self, primary_id: str):
        """Запомнить проект, который Raven считает основным.

        Его `commodities` — актуальный список того, чего проекту ещё не хватает;
        именно его показывает блок CARRIER.
        """
        primary_id = str(primary_id or "").strip()
        cache = getattr(self, "_colony_projects_cache", {}) or {}
        project = cache.get(primary_id) if primary_id else None
        current_id = str(self.colony_primary_project.get("buildId") or "")
        if isinstance(project, dict):
            self.colony_primary_project = dict(project)
            # Пишем в лог только на смене проекта: метод зовётся на каждом
            # «Обновить список», иначе строка дублировалась бы без конца.
            if str(project.get("buildId") or "") != current_id:
                self.log(
                    "Колонизатор: основной проект — "
                    f"{project.get('buildName') or '?'} ({project.get('systemName') or '?'})",
                    "info")
            return
        if primary_id:
            # Сервер назвал проект, которого нет в списке командира, — не
            # показываем устаревший список материалов.
            self.colony_primary_project = {}
            return
        # Сервер основного проекта не назвал. Не стираем выбор, сделанный
        # только что: ответ Raven приходит с задержкой, а потребность в блоке
        # CARRIER нужна сразу. Сбрасываем лишь проект, которого у командира
        # уже нет в списке.
        if current_id and cache and current_id not in cache:
            self.colony_primary_project = {}

    def _colony_add_build_type_hints(self, build_types):
        """Добавить подсказки типов постройки в combobox (без повторов)."""
        entry = getattr(self, "colony_build_type_entry", None)
        if entry is None:
            return
        try:
            current = list(entry.cget("values") or ())
        except Exception:
            current = []
        merged = list(current) + [str(t) for t in (build_types or []) if t and str(t) not in current]
        if merged != current:
            try:
                entry.config(values=merged)
            except Exception:
                pass

    # ---------- Колонизатор: действия ----------
    def _current_site_market(self):
        """MarketID стройплощадки, с которой сейчас работаем: `(id, system)`.

        Сначала — площадка из журнала (командир у неё стоит). Если её нет,
        берём Market ID из формы создания проекта: привязать площадку к
        проекту должно быть можно и до стыковки.
        """
        site = self.construction.site
        if site is not None and site.market_id:
            try:
                return int(site.market_id), str(site.system_name or "")
            except (TypeError, ValueError):
                pass
        field = (getattr(self, "colony_fields", {}) or {}).get("marketId")
        raw = ""
        if field is not None:
            try:
                raw = str(field.get() or "").strip()
            except Exception:
                raw = ""
        try:
            return int(raw or 0), ""
        except ValueError:
            return 0, ""

    def _on_colony_bind_site(self):
        """Зачислять доставки этой стройплощадки выбранному проекту."""
        project = self._selected_colony_project()
        if not project or not project.get("buildId"):
            self.log("Выберите проект в списке проектов Raven Colonial.", "warn")
            return
        market_id, system = self._current_site_market()
        if not market_id:
            self.log("Стройплощадка не определена: пристыкуйтесь к Construction Ship / "
                     "площадке (или запустите watcher) либо заполните Market ID в форме "
                     "создания проекта.", "warn")
            return
        build_id = str(project["buildId"])
        name = str(project.get("buildName") or "")
        site = self.construction.site
        bindings = dict(self.config.get("raven_site_bindings") or {})
        bindings[str(market_id)] = {
            "build_id": build_id,
            "name": name,
            "system": system or str(project.get("systemName") or ""),
            "address": int(getattr(site, "system_address", 0) or 0) if site is not None else 0,
        }
        self.config["raven_site_bindings"] = bindings
        self.save_config()
        self.log(f"Площадка {market_id} привязана к проекту «{name}» ({build_id}): "
                 "доставки будут зачисляться ему.", "success")
        self.colony_status.config(text=f"Площадка {market_id} → проект «{name}»")

        # Привязка меняет ответ на «какой это проект»: сбрасываем кэш поиска,
        # счётчики промахов и сразу досылаем то, что ждало в очереди.
        invalidate = getattr(self.raven_api, "invalidate_project_cache", None)
        if callable(invalidate):
            invalidate()
        self._raven_site_miss.clear()
        self._raven_site_warned.clear()
        self._raven_bound_projects.clear()
        self._site_project_log_sig = None
        self.site_project = {}
        if self._pending_raven_deliveries:
            threading.Thread(target=self._flush_raven_after_binding, daemon=True).start()
        else:
            self._refresh_site_project(force=True)

    def _flush_raven_after_binding(self):
        """Фоновая досылка очереди после привязки площадки к проекту."""
        summary = self._flush_raven_deliveries(self._current_cmdr_name(), force=True)
        sent = int(summary.get("sent", 0) or 0)
        tons = int(summary.get("tons", 0) or 0)
        left = int(summary.get("pending", 0) or 0)
        self.root.after(
            0,
            lambda n=sent, t=tons, rest=left: self.log(
                f"Raven Colonial: после привязки дослано {n} доставок ({t} t)"
                + (f", в очереди осталось {rest}" if rest else ""),
                "success" if n else "info"),
        )
        self._refresh_site_project(force=True)

    def _on_colony_unbind_site(self):
        """Снять привязку: снова ищем проект по market_id площадки."""
        market_id, _system = self._current_site_market()
        bindings = dict(self.config.get("raven_site_bindings") or {})
        if not market_id or str(market_id) not in bindings:
            self.log("Привязки для этой стройплощадки нет.", "info")
            return
        record = bindings.pop(str(market_id))
        self.config["raven_site_bindings"] = bindings
        self.save_config()
        self.log(f"Привязка площадки {market_id} снята (была к проекту "
                 f"{record.get('build_id')}).", "info")
        self.colony_status.config(text=f"Привязка площадки {market_id} снята")
        self._raven_bound_projects.pop(str(record.get("build_id") or ""), None)
        invalidate = getattr(self.raven_api, "invalidate_project_cache", None)
        if callable(invalidate):
            invalidate()
        self.site_project = {}
        self._site_project_log_sig = None
        self._refresh_site_project(force=True)

    def _on_colony_set_primary(self):
        project = self._selected_colony_project()
        if not project:
            return
        cmdr = (self.colony_cmdr_var.get() or "").strip()
        if not cmdr:
            self.log("Укажите имя командира.", "warn")
            return
        self._set_colony_busy(True, "Назначаю основной проект…")
        # Запоминаем сразу: блок CARRIER должен показать материалы этого
        # проекта, не дожидаясь ответа сервера и обновления списка.
        cached = (getattr(self, "_colony_projects_cache", {}) or {}).get(project["buildId"])
        self.colony_primary_project = dict(cached or project)
        threading.Thread(target=self._colony_simple_call_thread,
                         args=("set_primary", (cmdr, project["buildId"]),
                               f"Основной проект: {project['buildName']}"), daemon=True).start()

    def _on_colony_clear_primary(self):
        cmdr = (self.colony_cmdr_var.get() or "").strip()
        if not cmdr:
            self.log("Укажите имя командира.", "warn")
            return
        self._set_colony_busy(True, "Снимаю основной проект…")
        self.colony_primary_project = {}
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

    def _on_colony_open_project(self):
        """Открыть страницу выбранного проекта в Raven Colonial."""
        project = self._selected_colony_project()
        if not project or not project["buildId"]:
            self.log("Выберите проект в списке.", "warn")
            return
        self._colony_open_url(project_url(project["buildId"]),
                              f"Проект {project['buildName']}")

    def _colony_open_url(self, url: str, what: str = ""):
        """Открыть ссылку в системном браузере (не блокируя UI)."""
        def open_in_thread():
            try:
                import webbrowser

                opened = webbrowser.open(url, new=2)
            except Exception as exc:
                self.after(0, lambda e=exc: self.log(f"Не удалось открыть браузер: {e}", "warn"))
                return
            label = f"{what}: " if what else ""
            if opened:
                self.after(0, lambda: self.log(f"Raven Colonial: открыта страница — {label}{url}", "info"))
            else:
                self.after(0, lambda: self.log(
                    f"Raven Colonial: браузер не открылся, скопируйте ссылку — {url}", "warn"))

        threading.Thread(target=open_in_thread, daemon=True).start()

    def _on_colony_autofill_changed(self):
        """Галочки формы создания сохраняем сразу, без кнопки «Применить»."""
        self.config["colony_autofill"] = bool(self.colony_autofill_var.get())
        self.config["colony_open_page_after_create"] = bool(self.colony_open_page_var.get())
        self.save_config()

    def _update_colony_site_label(self):
        """Подпись под кнопкой автозаполнения: что известно из журнала."""
        label = getattr(self, "colony_site_label", None)
        if label is None:
            return
        site = self.construction.site
        if site is None or not site.market_id:
            label.config(
                text="Стройплощадка не найдена — пристыкуйтесь к Construction Ship / площадке.",
                foreground=COLOR_MUTED,
            )
            return
        docked = "вы на площадке" if site.docked else "последняя посещённая площадка"
        color = COLOR_GREEN if site.has_depot else COLOR_ORANGE
        label.config(text=f"{site.summary()} · {docked}", foreground=color)

    # ---------- Колонизатор: автозаполнение из журнала ----------
    def _colony_form_snapshot(self) -> dict:
        """Снимок формы: по нему видно, правил ли пользователь поля руками."""
        snapshot = {key: var.get() for key, var in getattr(self, "colony_fields", {}).items()}
        snapshot["_commodities"] = (
            self.colony_commodities_var.get() if hasattr(self, "colony_commodities_var") else ""
        )
        snapshot["_primary"] = bool(self.colony_primary_port_var.get()) if hasattr(self, "colony_primary_port_var") else False
        snapshot["_starpos"] = self.colony_starpos_var.get() if hasattr(self, "colony_starpos_var") else ""
        snapshot["_plan"] = self.colony_site_plan_var.get() if hasattr(self, "colony_site_plan_var") else ""
        return snapshot

    def _colony_form_dirty(self) -> bool:
        return self._colony_form_snapshot() != getattr(self, "_colony_form_baseline", {})

    def _on_colony_fill_current(self):
        """Кнопка «Заполнить из журнала»: площадка из журнала, иначе текущая система."""
        site = self.construction.site
        if site is not None and site.market_id:
            self._colony_autofill_from_site(site, auto=False)
            return

        state = getattr(self.ship, "state", None)
        system = (getattr(state, "current_system", "") or "").strip()
        if not system:
            self.log(
                "Стройплощадка в журнале не найдена, а текущая система неизвестна — "
                "включите Watcher или загрузите журналы.", "warn",
            )
            return
        self.colony_fields["systemName"].set(system)
        address = getattr(state, "system_address", 0) or 0
        if address:
            self.colony_fields["systemAddress"].set(str(address))
        market_id = str(self._last_depot_state.get("_market_id", "") or "")
        if market_id and market_id != "0":
            self.colony_fields["marketId"].set(market_id)
        if not self.colony_fields["architectName"].get():
            self.colony_fields["architectName"].set(self._current_cmdr_name())
        self._colony_form_baseline = self._colony_form_snapshot()
        self.log(f"Подставлена текущая система: {system} (без данных стройплощадки)", "info")
        self._fetch_colony_site_context(system)

    def _colony_autofill_from_site(self, site, auto: bool = False):
        """Заполнить форму создания проекта данными стройплощадки из журнала."""
        if site is None or not site.market_id:
            self.log("Стройплощадка не найдена: в журнале нет ColonisationConstructionDepot.", "warn")
            return

        self.colony_fields["systemName"].set(site.system_name or "")
        self.colony_fields["marketId"].set(str(site.market_id))
        self.colony_fields["systemAddress"].set(str(site.system_address or ""))
        self.colony_starpos_var.set(
            ", ".join(f"{value:.4f}" for value in site.star_pos) if site.star_pos else ""
        )
        self.colony_fields["bodyName"].set(site.body_name or "")
        self.colony_fields["bodyNum"].set("" if site.body_num is None else str(site.body_num))
        self.colony_fields["maxNeed"].set(str(site.total_required) if site.total_required else "")
        self.colony_primary_port_var.set(bool(site.is_primary_port))

        # Название подставляем только если поле пустое или заполнено нами же
        # ранее: переименовывать проект за пользователем не нужно.
        current_name = self.colony_fields["buildName"].get().strip()
        if not current_name or current_name == getattr(self, "_colony_autofilled_name", ""):
            suggested = site.suggested_name
            self.colony_fields["buildName"].set(suggested)
            self._colony_autofilled_name = suggested

        if not self.colony_fields["architectName"].get().strip():
            architect = self.construction.commander or self._current_cmdr_name()
            if architect:
                self.colony_fields["architectName"].set(architect)

        remaining = site.remaining_by_commodity()
        if remaining:
            self.colony_commodities_var.set(format_commodities(remaining))
        elif not site.has_depot:
            self.log(
                "Ресурсы площадки ещё не получены: зайдите в Construction Services "
                "на площадке — тогда подставятся потребности по товарам.", "warn",
            )

        self._colony_draft_site = site
        self._colony_form_baseline = self._colony_form_snapshot()
        self._update_colony_site_label()
        prefix = "Автозаполнение" if auto else "Форма заполнена"
        self.log(f"{prefix}: {site.summary()}", "success" if site.has_depot else "info")
        self.colony_status.config(text=site.summary())
        # Планы площадок и архитектора системы берём из Raven Colonial — в
        # журнале их нет. Запрос фоновый, форма не блокируется.
        if site.system_name:
            self._fetch_colony_site_context(site.system_name)

    def _fetch_colony_site_context(self, system: str):
        """Фоновый запрос планов площадок и архитектора системы."""
        if not system or not self.raven_api.is_connected:
            return

        def worker():
            sites = self.raven_api.get_system_sites(system)
            architect = self.raven_api.get_system_architect(system)
            self.after(0, lambda: self._colony_site_context_done(system, sites, architect))

        threading.Thread(target=worker, daemon=True).start()

    def _colony_site_context_done(self, system: str, sites: dict, architect: dict):
        if architect.get("ok"):
            name = architect.get("data")
            if isinstance(name, dict):
                name = name.get("architectName") or name.get("architect") or name.get("name")
            name = str(name or "").strip().strip('"')
            if name and not self.colony_fields["architectName"].get().strip():
                self.colony_fields["architectName"].set(name)
                self._colony_form_baseline = self._colony_form_snapshot()
                self.log(f"Raven Colonial: архитектор системы {system} — {name}", "info")

        if not sites.get("ok"):
            return
        plans = self._extract_site_plans(sites.get("data"))
        self._colony_site_plans = plans
        labels = ["Нет (создать новый план)"] + [
            self._site_plan_label(plan) for plan in plans
        ]
        try:
            self.colony_site_plan_combo.config(values=tuple(labels))
        except Exception:
            pass
        # Типы построек из планов системы — самые точные подсказки: это ровно
        # те коды, которые Raven Colonial ожидает в buildType.
        self._colony_add_build_type_hints([plan.get("buildType") for plan in plans])
        if plans:
            self.log(
                f"Raven Colonial: в системе {system} запланировано площадок — {len(plans)}", "info")
            # Один план — выбираем его сами: тип и тело возьмутся из плана.
            if len(plans) == 1 and not self.colony_site_plan_var.get():
                self.colony_site_plan_var.set(labels[1])
                self._on_colony_plan_selected()

    @staticmethod
    def _extract_site_plans(data) -> list:
        """Из ответа /v2/system/{system}/sites — только незавершённые планы."""
        if isinstance(data, dict):
            for key in ("sites", "Sites"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
            else:
                data = [data] if data else []
        if not isinstance(data, list):
            return []
        plans = []
        for item in data:
            if not isinstance(item, dict):
                continue
            status = str(item.get("status") or "").lower()
            # Готовые и снесённые площадки привязывать не к чему.
            if status in ("complete", "completed", "demolish", "demolished"):
                continue
            plans.append({
                "id": str(item.get("id") or item.get("siteId") or ""),
                "name": str(item.get("name") or ""),
                "buildType": str(item.get("buildType") or ""),
                "bodyNum": item.get("bodyNum", item.get("bodyId")),
                "bodyName": str(item.get("bodyName") or ""),
            })
        return [plan for plan in plans if plan["id"]]

    @staticmethod
    def _site_plan_label(plan: dict) -> str:
        build_type = plan.get("buildType") or "?"
        name = plan.get("name") or plan.get("id")
        return f"{name} ({build_type})"

    def _on_colony_plan_selected(self):
        """Выбран план площадки — подставляем systemSiteId, тип и тело."""
        index = 0
        try:
            index = int(self.colony_site_plan_combo.current())
        except Exception:
            index = 0
        if index <= 0 or index - 1 >= len(self._colony_site_plans):
            self._colony_selected_site_id = ""
            return
        plan = self._colony_site_plans[index - 1]
        self._colony_selected_site_id = plan["id"]
        if plan.get("buildType") and not self.colony_fields["buildType"].get().strip():
            self.colony_fields["buildType"].set(plan["buildType"])
        if plan.get("bodyName") and not self.colony_fields["bodyName"].get().strip():
            self.colony_fields["bodyName"].set(plan["bodyName"])
        if plan.get("bodyNum") not in (None, "") and not self.colony_fields["bodyNum"].get().strip():
            self.colony_fields["bodyNum"].set(str(plan["bodyNum"]))
        if not self.colony_fields["buildName"].get().strip():
            self.colony_fields["buildName"].set(plan.get("name") or "")
        self._colony_form_baseline = self._colony_form_snapshot()
        self.log(f"Выбран план площадки: {self._site_plan_label(plan)}", "info")

    def _on_colony_clear_form(self):
        for var in self.colony_fields.values():
            var.set("")
        self.colony_starpos_var.set("")
        self.colony_commodities_var.set("")
        self.colony_primary_port_var.set(False)
        self.colony_site_plan_var.set("")
        self._colony_selected_site_id = ""
        self._colony_draft_site = None
        self._colony_autofilled_name = ""
        self._colony_form_baseline = self._colony_form_snapshot()
        self.colony_status.config(text="Форма очищена")
        self._update_colony_site_label()

    def _on_colony_check_system(self):
        """Есть ли уже проект на этой площадке/в этой системе?

        Создание проекта, который уже существует, Raven отклоняет, а сообщение
        об этом приходит только после запроса. Дешевле проверить заранее.
        """
        system = self.colony_fields["systemName"].get().strip()
        address = self.colony_fields["systemAddress"].get().strip()
        market_id = self.colony_fields["marketId"].get().strip()
        if not (system or address or market_id):
            self.log("Заполните систему, Market ID или System address.", "warn")
            return
        self.colony_status.config(text="Проверяю площадку в Raven Colonial…")
        threading.Thread(target=self._colony_check_system_thread,
                         args=(system, address, market_id), daemon=True).start()

    def _colony_check_system_thread(self, system: str, address: str, market_id: str):
        result = None
        if address and market_id:
            try:
                result = self.raven_api.get_project(int(address), int(market_id))
            except (TypeError, ValueError):
                result = None
        if not result:
            result = self.raven_api.get_system_projects(address or system)
        self.after(0, lambda: self._colony_check_system_done(result))

    def _colony_check_system_done(self, result):
        if not isinstance(result, dict) or not result.get("ok"):
            error = (result or {}).get("error") if isinstance(result, dict) else "нет ответа"
            self.colony_status.config(text=f"Проверить не удалось: {error}")
            self.log(f"Raven Colonial: проверка площадки — {error}", "warn")
            return
        projects = self._extract_colony_projects(result.get("data"))
        if not projects:
            self.colony_status.config(text="Проекта на этой площадке нет — можно создавать.")
            self.log("Raven Colonial: активного проекта на площадке нет", "success")
            return
        names = ", ".join(f"{p.get('buildName')} ({p.get('buildId')})" for p in projects[:3])
        self.colony_status.config(text=f"Внимание: в системе уже есть проект — {names}")
        self.log(f"Raven Colonial: найден существующий проект — {names}", "warn")

    # ---------- Колонизатор: создание проекта ----------
    @staticmethod
    def _parse_commodities(text: str) -> dict:
        """'aluminium:1200, steel:900' -> {'aluminium': 1200, 'steel': 900}."""
        result = {}
        for chunk in (text or "").split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            name, _, amount = chunk.partition(":")
            name = normalize_commodity(name)
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
        site = getattr(self, "_colony_draft_site", None)
        build_name = self.colony_fields["buildName"].get().strip()
        system = self.colony_fields["systemName"].get().strip()
        missing = [
            label for key, label in (("marketId", "Market ID"), ("systemAddress", "System address"),
                                     ("buildName", "Название"))
            if not self.colony_fields[key].get().strip()
        ]
        if missing:
            hint = ""
            if site is None and {"Market ID", "System address"} & set(missing):
                hint = " Пристыкуйтесь к стройплощадке и нажмите «Заполнить из журнала»."
            self.log(f"Raven Colonial требует заполнить: {', '.join(missing)}.{hint}", "warn")
            self.colony_status.config(text=f"Не заполнены обязательные поля: {', '.join(missing)}")
            return

        def as_int(key: str) -> Optional[int]:
            raw = self.colony_fields[key].get().strip()
            if not raw:
                return None
            try:
                return int(float(raw))
            except ValueError:
                self.log(f"Поле «{key}» должно быть числом, получено: {raw}", "warn")
                raise

        try:
            market_id = as_int("marketId")
            system_address = as_int("systemAddress")
            max_need = as_int("maxNeed")
            body_num = as_int("bodyNum")
        except ValueError:
            return

        # Событие депота относится ровно к той площадке, чей MarketID стоит в
        # форме. Если командир поправил Market ID руками, чужой snapshot
        # отправлять нельзя — Raven посчитает по нему исходную потребность.
        if site is not None and str(site.market_id) != str(self.colony_fields["marketId"].get().strip()):
            site = None

        # Форма — источник истины: даже если площадка известна, командир мог
        # поправить любое поле руками. Из площадки берём только то, чего в
        # форме нет (событие депота, starPos).
        project = build_project_draft(
            site,
            build_name=build_name,
            build_type=self.colony_fields["buildType"].get().strip(),
            architect_name=self.colony_fields["architectName"].get().strip(),
            discord_link=self.colony_fields["discordLink"].get().strip(),
            notes=self.colony_fields["notes"].get().strip(),
            is_primary_port=bool(self.colony_primary_port_var.get()),
            commanders={cmdr: [] for cmdr in [(self.colony_cmdr_var.get() or "").strip()] if cmdr},
            system_site_id=getattr(self, "_colony_selected_site_id", ""),
        )
        project["marketId"] = market_id
        project["systemAddress"] = system_address
        if system:
            project["systemName"] = system
        if max_need is not None:
            project["maxNeed"] = max_need
        if body_num is not None:
            project["bodyNum"] = body_num
        if self.colony_fields["bodyName"].get().strip():
            project["bodyName"] = self.colony_fields["bodyName"].get().strip()
        commodities = self._parse_commodities(self.colony_commodities_var.get())
        if commodities:
            project["commodities"] = commodities

        cmdr = (self.colony_cmdr_var.get() or "").strip()
        open_page = bool(self.colony_open_page_var.get())
        self._set_colony_busy(True, "Создаю проект…")
        threading.Thread(target=self._colony_create_thread,
                         args=(project, cmdr, open_page), daemon=True).start()

    def _colony_create_thread(self, project: dict, cmdr: str, open_page: bool = True):
        result = self.raven_api.create_project(project)
        build_id = ""
        data = result.get("data")
        if isinstance(data, dict):
            build_id = str(data.get("buildId", "") or "")
        if isinstance(data, str):
            build_id = data.strip().strip('"')
        if result.get("ok") and build_id and cmdr:
            # Сразу привязываем проект к командиру, иначе он не попадёт в
            # список «моих проектов» на сайте и в этой вкладке.
            link = self.raven_api.link_cmdr(build_id, cmdr, True)
            if not link.get("ok"):
                result["link_error"] = link.get("error")
        self.after(0, lambda: self._colony_create_done(result, build_id, cmdr, open_page))

    def _colony_create_done(self, result: dict, build_id: str, cmdr: str, open_page: bool = True):
        self._set_colony_busy(False)
        if result.get("ok"):
            # Проект только что создан: кэш поиска «проекта нет» нужно сбросить,
            # иначе доставки ближайших минут продолжат отбрасываться с
            # «проект не найден», хотя buildId уже существует.
            site = self.construction.site
            invalidate = getattr(self.raven_api, "invalidate_project_cache", None)
            if callable(invalidate):
                invalidate(int(site.system_address or 0) if site else 0,
                           int(site.market_id or 0) if site else 0)
            self.site_project = {}
            system = self.colony_fields["systemName"].get()
            name = f"{system}: {self.colony_fields['buildName'].get()}".strip(": ")
            message = f"Raven Colonial: проект создан — {name}"
            if build_id:
                message += f" (buildId {build_id})"
            self.log(message, "success")
            if result.get("link_error"):
                self.log(
                    f"Raven Colonial: проект создан, но не привязан к командиру — "
                    f"{result['link_error']}", "warn",
                )
            self.colony_status.config(text=f"Проект создан, buildId: {build_id or '—'}")
            # Запоминаем недавно использованные типы постройки: официальный
            # справочник кодов Raven не публикует, а свои значения команда
            # вводит из раза в раз одни и те же.
            self._remember_colony_build_type(self.colony_fields["buildType"].get().strip())
            if build_id and open_page:
                self._colony_open_url(project_url(build_id), f"Проект {name}")
            if cmdr:
                self._on_colony_refresh()
        else:
            error = result.get("error") or "неизвестная ошибка"
            self.colony_status.config(text=f"Создать проект не удалось: {error}")
            self.log(f"Raven Colonial: проект не создан — {error}", "error")

    def _remember_colony_build_type(self, build_type: str):
        build_type = (build_type or "").strip()
        if not build_type:
            return
        recent = [item for item in self.config.get("colony_build_types_recent", []) if item != build_type]
        recent.insert(0, build_type)
        self.config["colony_build_types_recent"] = recent[:10]
        self._colony_add_build_type_hints([build_type])
        self.save_config()


    # ============================================================
    #  Вкладка: Карта системы
    # ============================================================
    #: Шаги зума: кнопки «−»/«+» и колесо мыши переключают их по порядку.
    MAP_ZOOM_STEPS = (0.6, 0.8, 1.0, 1.3, 1.7, 2.2)
    #: Как часто можно дёргать Raven Colonial ради карты. События журнала
    #: обновляют её мгновенно, а сеть нужна только чтобы увидеть груз, который
    #: завезли другие командиры, и планы площадок.
    MAP_RAVEN_TTL = 120
    #: Пачка событий журнала не должна перерисовывать карту десятки раз:
    #: перерисовки склеиваются в одну.
    MAP_REDRAW_MS = 120
    #: Длинные имена станций урезаем, иначе подписи перекрывают полкарты.
    MAP_LABEL_LIMIT = 26

    def _build_tab_map(self):
        outer = tb.Frame(self.tab_map, padding=10)
        outer.pack(fill=BOTH, expand=True)

        tb.Label(outer, text="Карта системы — где вы и что строится",
                 font=("Segoe UI", 12, "bold")).pack(anchor=W)
        tb.Label(
            outer,
            text="Звезда, планеты и луны, станции, поселения и стройплощадки системы, в "
                 "которой находится пилот. У строящихся объектов — сколько процентов груза "
                 "завезено: журнал плюс Raven Colonial, включая доставки других командиров.",
            foreground=COLOR_MUTED, wraplength=820, justify=LEFT,
        ).pack(anchor=W, pady=(0, 8))

        # ---- Панель управления ----
        bar = tb.Frame(outer)
        bar.pack(fill=X, pady=(0, 6))
        tb.Button(bar, text="Обновить", command=self._on_map_refresh,
                  bootstyle="info-outline", width=11).pack(side=LEFT)
        tb.Button(bar, text="−", command=lambda: self._on_map_zoom(-1),
                  bootstyle="secondary-outline", width=3).pack(side=LEFT, padx=(8, 0))
        tb.Button(bar, text="+", command=lambda: self._on_map_zoom(1),
                  bootstyle="secondary-outline", width=3).pack(side=LEFT, padx=(4, 0))
        self.map_zoom_label = tb.Label(bar, text="100%", foreground=COLOR_MUTED, width=6)
        self.map_zoom_label.pack(side=LEFT, padx=(4, 12))
        self.map_moons_var = tk.BooleanVar(
            value=bool(self.config.get("map_show_moons", True)))
        tb.Checkbutton(bar, text="Луны", variable=self.map_moons_var,
                       command=self._on_map_toggle,
                       bootstyle="info-round-toggle").pack(side=LEFT, padx=(0, 8))
        self.map_labels_var = tk.BooleanVar(
            value=bool(self.config.get("map_show_labels", True)))
        tb.Checkbutton(bar, text="Подписи", variable=self.map_labels_var,
                       command=self._on_map_toggle,
                       bootstyle="info-round-toggle").pack(side=LEFT)
        self.map_system_label = tb.Label(bar, text="", font=("Consolas", 10),
                                         foreground=COLOR_ORANGE)
        self.map_system_label.pack(side=RIGHT)

        # ---- Холст слева, список объектов справа ----
        body = tb.Frame(outer)
        body.pack(fill=BOTH, expand=True)

        canvas_frame = tb.Frame(body, relief="solid", borderwidth=1)
        canvas_frame.pack(side=LEFT, fill=BOTH, expand=True)
        self.map_canvas = tk.Canvas(canvas_frame, bg=COLOR_BG, highlightthickness=0,
                                    borderwidth=0)
        self.map_canvas.pack(fill=BOTH, expand=True)
        self.map_canvas.bind("<Configure>", self._on_map_resize)
        self.map_canvas.bind("<Button-1>", self._on_map_click)
        # Двойной клик: отцентровать на объекте, по пустому месту — сброс.
        self.map_canvas.bind("<Double-Button-1>", self._on_map_double_click)
        # Esc ловим и на дереве: в Windows событие уходит виджету с фокусом,
        # а фокус после клика по строке — у списка, не у холста.
        self.map_canvas.bind("<Escape>", self._on_map_escape)
        self.map_canvas.bind("<Motion>", self._on_map_hover)
        self.map_canvas.bind("<Leave>", lambda _event: self._map_restore_hint())
        # Колесо мыши: в Windows/macOS это <MouseWheel>, в Linux — кнопки 4/5.
        for binding in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            self.map_canvas.bind(binding, self._on_map_wheel)

        side = tb.Frame(body)
        side.pack(side=RIGHT, fill=Y, padx=(8, 0))
        side_top = tb.Frame(side)
        side_top.pack(fill=X, pady=(0, 4))
        tb.Label(side_top, text="Объекты системы",
                 font=("Segoe UI", 10, "bold")).pack(side=LEFT)
        tb.Button(side_top, text="Сводка", command=self._on_map_copy_summary,
                  bootstyle="secondary-outline", width=8).pack(side=RIGHT)
        tb.Button(side_top, text="PNG", command=self._on_map_save_png,
                  bootstyle="secondary-outline", width=6).pack(side=RIGHT,
                                                               padx=(0, 4))
        filter_row = tb.Frame(side)
        filter_row.pack(fill=X, pady=(0, 4))
        tb.Label(filter_row, text="Фильтр:", foreground=COLOR_MUTED).pack(side=LEFT)
        self.map_filter_var = tk.StringVar(value="")
        filter_entry = tb.Entry(filter_row, textvariable=self.map_filter_var, width=22)
        filter_entry.pack(side=LEFT, padx=(6, 0), fill=X, expand=True)
        # Быстрый отбор «что ещё сканировать»: тела со сканом прячем из списка.
        self.map_unscanned_var = tk.BooleanVar(
            value=bool(self.config.get("map_unscanned", False)))
        tb.Checkbutton(filter_row, text="неотск.", variable=self.map_unscanned_var,
                       command=self._on_map_unscanned_toggle,
                       bootstyle="secondary-round-toggle").pack(side=LEFT, padx=(6, 0))
        self.map_filter_var.trace_add("write", lambda *_args: self._on_map_filter_changed())
        tree_frame = tb.Frame(side)
        tree_frame.pack(fill=BOTH, expand=True)
        columns = ("object", "type", "progress", "rest", "carry")
        self.map_tree = tb.Treeview(tree_frame, columns=columns, show="headings",
                                    bootstyle="dark", height=16)
        for col, title, width, anchor in (
            ("object", "Объект", 138, W),
            ("type", "Тип", 88, W),
            ("progress", "Завезено", 62, CENTER),
            ("rest", "Осталось", 66, "e"),
            ("carry", "Везти", 96, W),
        ):
            self.map_tree.heading(col, text=title)
            self.map_tree.column(col, width=width, anchor=anchor)
        # Двойной клик по строке — отцентровать карту на выбранном объекте.
        self.map_tree.bind("<Double-1>", self._on_map_tree_double)
        self.map_tree.bind("<Escape>", self._on_map_escape)
        # Стройки — самое важное на карте, поэтому они оранжевые и сверху списка.
        self.map_tree.tag_configure("site", foreground=COLOR_ORANGE)
        self.map_tree.tag_configure("planned", foreground=COLOR_MUTED)
        self.map_tree.tag_configure("built", foreground=COLOR_TEXT)
        self.map_tree.tag_configure("body", foreground=COLOR_MUTED)
        # Тревога по сроку стройки заметнее цвета её типа.
        self.map_tree.tag_configure("due_soon", foreground=COLOR_YELLOW)
        self.map_tree.tag_configure("overdue", foreground=COLOR_RED)
        tree_vsb = tb.Scrollbar(tree_frame, orient=VERTICAL, command=self.map_tree.yview)
        self.map_tree.configure(yscrollcommand=tree_vsb.set)
        self.map_tree.pack(side=LEFT, fill=BOTH, expand=True)
        tree_vsb.pack(side=RIGHT, fill=Y)
        self.map_tree.bind("<<TreeviewSelect>>", self._on_map_tree_select)

        # ---- Состояние ----
        footer = tb.Frame(outer)
        footer.pack(fill=X, pady=(6, 0))
        self.map_status = tb.Label(footer, text="Система неизвестна", foreground=COLOR_MUTED,
                                   wraplength=620, justify=LEFT)
        self.map_status.pack(side=LEFT, fill=X, expand=True)
        self.map_hint = tb.Label(footer, text="", foreground=COLOR_CYAN, font=("Consolas", 9),
                                 wraplength=280, justify=RIGHT)
        self.map_hint.pack(side=RIGHT)

        try:
            zoom_index = int(self.config.get("map_zoom_index", 2))
        except (TypeError, ValueError):
            zoom_index = 2
        self._map_zoom_index = max(0, min(len(self.MAP_ZOOM_STEPS) - 1, zoom_index))
        self._map_update_zoom_label()
        self._map_redraw_now()

    # ---------- карта: перерисовка ----------
    def _map_visible(self) -> bool:
        """Вкладка «Карта системы» сейчас открыта?"""
        notebook = getattr(self, "notebook", None)
        tab = getattr(self, "tab_map", None)
        if notebook is None or tab is None:
            return False
        try:
            return str(notebook.select()) == str(tab)
        except Exception:
            return False

    def _map_canvas_size(self):
        """Размер холста или (0, 0), если вкладка ещё не показана."""
        canvas = getattr(self, "map_canvas", None)
        if canvas is None:
            return 0, 0
        try:
            width = int(canvas.winfo_width())
            height = int(canvas.winfo_height())
        except Exception:
            return 0, 0
        if width <= 1 or height <= 1:
            return 0, 0
        return width, height

    def _map_zoom(self) -> float:
        try:
            return float(self.MAP_ZOOM_STEPS[self._map_zoom_index])
        except Exception:
            return 1.0

    def _map_update_zoom_label(self):
        label = getattr(self, "map_zoom_label", None)
        if label is None:
            return
        try:
            label.config(text=f"{int(round(self._map_zoom() * 100))}%")
        except Exception:
            pass

    def _map_schedule_redraw(self, delay_ms: int = None):
        """Отложить перерисовку: десятки событий журнала дают один кадр."""
        if delay_ms is None:
            delay_ms = self.MAP_REDRAW_MS if self._map_visible() else 1000
        if self._map_redraw_job is not None:
            try:
                self.root.after_cancel(self._map_redraw_job)
            except Exception:
                pass
            self._map_redraw_job = None
        try:
            self._map_redraw_job = self.root.after(int(delay_ms), self._map_redraw_now)
        except Exception:
            self._map_redraw_job = None

    def _map_redraw_now(self):
        """Кадр карты: холст, список объектов справа и строка состояния."""
        self._map_redraw_job = None
        snapshot = self.system_map.snapshot()
        self._map_last_snapshot = snapshot
        self._draw_system_map(snapshot)
        self._fill_map_tree(snapshot)
        self._map_update_status(snapshot)

    def _draw_system_map(self, snapshot=None):
        canvas = getattr(self, "map_canvas", None)
        if canvas is None:
            return
        width, height = self._map_canvas_size()
        if not width or not height:
            # Холст ещё не получил размеры (вкладка не показана) — повторим.
            self._map_schedule_redraw(delay_ms=250)
            return
        if snapshot is None:
            snapshot = self._map_last_snapshot or self.system_map.snapshot()
        show_labels = bool(getattr(self, "map_labels_var", None)
                           and self.map_labels_var.get())
        show_moons = not getattr(self, "map_moons_var", None) or bool(
            self.map_moons_var.get())
        items = map_layout(snapshot, width, height, zoom=self._map_zoom(),
                           show_moons=show_moons, selected=self._map_selected,
                           center_on=self._map_center)
        self._map_items = items
        try:
            canvas.delete("all")
        except Exception:
            return
        center_x, center_y = width / 2.0, height / 2.0
        # Центр карты после двойного клика: кольца едут вместе со всей картой.
        pan_x, pan_y = next(((item.pan_x, item.pan_y) for item in items
                             if getattr(item, "pan_x", 0.0) or getattr(item, "pan_y", 0.0)),
                            (0.0, 0.0))
        ring_x, ring_y = center_x + pan_x, center_y + pan_y
        # Орбитальные кольца — под объектами, иначе они режут значки.
        for item in items:
            if item.kind == "body" and item.orbit_radius > 0:
                # У лун центр кольца — планета, у планет — звезда (центр карты).
                cx = ring_x if item.orbit_cx is None else item.orbit_cx
                cy = ring_y if item.orbit_cy is None else item.orbit_cy
                canvas.create_oval(
                    cx - item.orbit_radius, cy - item.orbit_radius,
                    cx + item.orbit_radius, cy + item.orbit_radius,
                    outline=COLOR_LINE, dash=(2, 4))
        for wanted, painter in (
            ("star", self._map_draw_star), ("body", self._map_draw_body),
            ("station", self._map_draw_station), ("player", self._map_draw_player),
        ):
            for item in items:
                if item.kind == wanted:
                    painter(canvas, item, show_labels)
        self._map_draw_legend(canvas)

    @classmethod
    def _map_short_label(cls, text) -> str:
        text = str(text or "").strip()
        if len(text) <= cls.MAP_LABEL_LIMIT:
            return text
        return text[: cls.MAP_LABEL_LIMIT - 1].rstrip() + "…"

    def _map_draw_star(self, canvas, item, show_labels):
        radius = max(6.0, float(item.radius))
        dy = float(getattr(item, "label_dy", 0.0) or 0.0)
        # Свечение: звезда — центр карты, её видно сразу.
        canvas.create_oval(item.x - radius * 1.9, item.y - radius * 1.9,
                           item.x + radius * 1.9, item.y + radius * 1.9,
                           fill="#2b2410", outline="")
        canvas.create_oval(item.x - radius, item.y - radius, item.x + radius, item.y + radius,
                           fill=item.color,
                           outline=COLOR_ORANGE if item.selected else "#111315",
                           width=2 if item.selected else 1)
        if not show_labels:
            return
        if item.label:
            canvas.create_text(item.x, item.y - radius * 1.9 - 6 + dy,
                               text=self._map_short_label(item.label), fill=COLOR_TEXT,
                               font=("Consolas", 9, "bold"), anchor="s")
        if item.caption:
            canvas.create_text(item.x, item.y + radius * 1.9 + 6 + dy, text=item.caption,
                               fill=COLOR_MUTED, font=("Consolas", 8), anchor="n")

    def _map_draw_body(self, canvas, item, show_labels):
        radius = max(3.0, float(item.radius))
        dy = float(getattr(item, "label_dy", 0.0) or 0.0)
        canvas.create_oval(item.x - radius, item.y - radius, item.x + radius, item.y + radius,
                           fill=item.color,
                           outline=COLOR_ORANGE if item.selected else "#111315",
                           width=2 if item.selected else 1)
        if getattr(item.ref, "landable", False):
            canvas.create_text(item.x, item.y, text="L", fill="#111315",
                               font=("Consolas", 7, "bold"))
        if not show_labels or not item.label:
            return
        is_moon = getattr(item.ref, "kind", "") == KIND_MOON
        canvas.create_text(item.x, item.y + radius + 7 + dy,
                           text=self._map_short_label(item.label),
                           fill=COLOR_MUTED if is_moon else COLOR_TEXT,
                           font=("Consolas", 7 if is_moon else 8), anchor="n")
        if item.caption and not is_moon:
            canvas.create_text(item.x, item.y + radius + 18 + dy, text=item.caption,
                               fill=COLOR_MUTED, font=("Consolas", 7), anchor="n")

    def _map_draw_station(self, canvas, item, show_labels):
        station = item.ref
        dy = float(getattr(item, "label_dy", 0.0) or 0.0)
        radius = max(5.0, float(item.radius))
        is_site = isinstance(station, MapStation) and station.is_site
        planned = bool(getattr(station, "planned", False))
        outline = COLOR_ORANGE if item.selected else item.color
        line_width = 2 if item.selected else 1
        if is_site:
            # Ромб: стройплощадку должно быть видно среди обычных станций.
            spread = radius + 2.0
            points = [item.x, item.y - spread, item.x + spread, item.y,
                      item.x, item.y + spread, item.x - spread, item.y]
            options = {"outline": outline, "width": line_width}
            if planned:
                # План площадки: контур пунктиром, завозить туда ещё нечего.
                options["dash"] = (3, 2)
                options["fill"] = COLOR_PANEL
            else:
                options["fill"] = item.color
            canvas.create_polygon(points, **options)
        elif getattr(station, "kind", "") == STATION_CARRIER:
            canvas.create_rectangle(item.x - radius, item.y - radius,
                                    item.x + radius, item.y + radius,
                                    fill=item.color, outline=outline, width=line_width)
        else:
            canvas.create_oval(item.x - radius, item.y - radius, item.x + radius,
                               item.y + radius, fill=item.color, outline=outline,
                               width=line_width)
        used = radius + 4.0
        if item.progress is not None:
            used += self._map_draw_progress(canvas, item, radius, dy)
        if not show_labels or not item.label:
            return
        canvas.create_text(item.x, item.y + used + 4 + dy,
                           text=self._map_short_label(item.label),
                           fill=COLOR_ORANGE if is_site else COLOR_TEXT,
                           font=("Consolas", 8, "bold") if is_site else ("Consolas", 8),
                           anchor="n")

    def _map_draw_progress(self, canvas, item, radius, dy: float = 0.0) -> float:
        """Прогресс-бар под стройплощадкой: сколько процентов груза завезено.

        Возвращает, на сколько пикселей ниже значка занято место, — подпись
        объекта рисуется уже под полосой.
        """
        progress = max(0, min(100, int(item.progress or 0)))
        bar_width = max(20, int(item.bar_width))
        left = item.x - bar_width / 2.0
        top = item.y + radius + 6.0 + dy
        bottom = top + 9.0
        canvas.create_rectangle(left, top, left + bar_width, bottom,
                                fill="#111315", outline=COLOR_LINE)
        color = (COLOR_GREEN if progress >= 100
                 else (COLOR_ORANGE if progress >= 40 else COLOR_RED))
        fill_width = int(round((bar_width - 2) * progress / 100.0))
        if fill_width > 0:
            canvas.create_rectangle(left + 1, top + 1, left + 1 + fill_width, bottom - 1,
                                    fill=color, outline="")
        canvas.create_text(left + bar_width + 5, (top + bottom) / 2.0, text=f"{progress}%",
                           fill=color, font=("Consolas", 8, "bold"), anchor=W)
        return (bottom + 3.0) - (item.y + radius)

    def _map_draw_player(self, canvas, item, show_labels):
        radius = max(10.0, float(item.radius))
        dy = float(getattr(item, "label_dy", 0.0) or 0.0)
        canvas.create_oval(item.x - radius, item.y - radius, item.x + radius,
                           item.y + radius, outline=COLOR_GREEN, width=2)
        canvas.create_oval(item.x - 3, item.y - 3, item.x + 3, item.y + 3,
                           fill=COLOR_GREEN, outline="")
        if not show_labels:
            return
        canvas.create_text(item.x, item.y - radius - 6 + dy, text="Вы здесь",
                           fill=COLOR_GREEN, font=("Consolas", 8, "bold"), anchor="s")
        if item.caption:
            canvas.create_text(item.x, item.y + radius + 6 + dy,
                               text=self._map_short_label(item.caption),
                               fill=COLOR_MUTED, font=("Consolas", 7), anchor="n")

    def _map_draw_legend(self, canvas):
        """Подсказка значков в углу холста."""
        entries = (
            (STATION_LABELS.get(STATION_SITE, "стройка"), COLOR_ORANGE),
            ("тело", "#9fd8ef"),
            ("станция", "#eeeeee"),
            ("авианосец", COLOR_CYAN),
            ("вы", COLOR_GREEN),
        )
        x = 12.0
        for text, color in entries:
            canvas.create_rectangle(x, 9, x + 8, 17, fill=color, outline="")
            canvas.create_text(x + 12, 13, text=text, fill=COLOR_MUTED,
                               font=("Consolas", 8), anchor=W)
            x += 22 + 6.6 * len(text)

    # ---------- карта: список объектов и состояние ----------
    def _fill_map_tree(self, snapshot):
        tree = getattr(self, "map_tree", None)
        if tree is None:
            return
        try:
            tree.delete(*tree.get_children())
        except Exception:
            return
        rows = []
        now = time.time()
        for station in sorted(snapshot.stations, key=self._map_station_sort_key):
            percent = station.percent_delivered
            if station.planned and percent is None:
                progress = "план"
            elif percent is not None:
                progress = f"{percent}%"
            else:
                progress = "—"
            rest = (f"{station.remaining_tons:,}".replace(",", " ")
                    if station.remaining_tons else "")
            tag = ("planned" if station.planned
                   else ("site" if station.is_site else "built"))
            due = due_timestamp(station.due_at)
            if not station.complete and due != math.inf:
                # Просроченный и горящий срок важнее цвета типа стройки.
                tag = "overdue" if due < now else (
                    "due_soon" if due - now <= self.MAP_DUE_SOON_DAYS * 86400 else tag)
            rows.append((f"s:{station.build_id or station.name}",
                         (self._map_short_label(station.title),
                          STATION_LABELS.get(station.kind, "объект"), progress, rest,
                          self._map_carry_note(station)), tag))
        unscanned_only = bool(getattr(self, "map_unscanned_var", None)
                              and self.map_unscanned_var.get())
        for body in snapshot.bodies:
            if unscanned_only and body.scanned:
                continue
            kind = BODY_LABELS.get(body.kind, "тело")
            if body.kind == KIND_STAR and body.star_type:
                kind = f"звезда {body.star_type}"
            flags = [flag for flag, enabled in (
                ("скан", body.scanned), ("карта", body.mapped),
                ("посадка", body.landable), ("терраформ", body.terraformable),
                ("raven", bool(getattr(body, "from_raven", False)) and not body.scanned),
            ) if enabled]
            rows.append((f"b:{body.name}",
                         (self._map_short_label(body.name), kind, " · ".join(flags),
                          f"{body.distance_ls:.1f} ls", ""), "body"))
        for iid, values, tag in rows:
            if not self._map_filter_matches(values):
                continue
            try:
                tree.insert("", "end", iid=iid, values=values, tags=(tag,))
            except Exception:
                continue
        self._map_sync_tree_selection()

    def _map_sync_tree_selection(self):
        tree = getattr(self, "map_tree", None)
        if tree is None or not self._map_selected:
            return
        try:
            match = [iid for iid in tree.get_children()
                     if str(iid).split(":", 1)[-1] == self._map_selected]
            if match:
                tree.selection_set(match[0])
                tree.see(match[0])
        except Exception:
            pass

    def _map_set_status(self, text: str):
        label = getattr(self, "map_status", None)
        if label is None:
            return
        try:
            label.config(text=str(text or ""))
        except Exception:
            pass

    def _map_set_hint(self, text: str):
        label = getattr(self, "map_hint", None)
        if label is None:
            return
        try:
            label.config(text=str(text or ""))
        except Exception:
            pass

    def _map_update_status(self, snapshot, note: str = ""):
        text = map_summary(snapshot)
        if note:
            text = f"{text}\n{note}"
        self._map_set_status(text)
        label = getattr(self, "map_system_label", None)
        if label is None:
            return
        player = snapshot.player
        ship = " ".join(part for part in (player.ship_name, player.ship_type) if part)
        header = snapshot.system or "система неизвестна"
        try:
            label.config(text=f"{header} · {ship}" if ship else header)
        except Exception:
            pass

    def _map_restore_hint(self):
        """Курсор ушёл с объекта: показываем детали выбранного (если есть)."""
        if self._map_selected:
            self._map_show_details(self._map_selected)
        else:
            self._map_set_hint("")

    def _map_show_details(self, key: str):
        snapshot = self._map_last_snapshot
        if snapshot is None or not key:
            self._map_set_hint("")
            return
        for station in snapshot.stations:
            if key in (station.build_id, station.name):
                parts = [station.caption]
                if station.required_tons:
                    parts.append("нужно "
                                 + f"{station.required_tons:,}".replace(",", " ") + " t")
                if station.remaining_by_commodity:
                    top = sorted(station.remaining_by_commodity.items(),
                                 key=lambda pair: pair[1], reverse=True)[:3]
                    parts.append("осталось: " + ", ".join(
                        f"{name} {amount:,}".replace(",", " ") for name, amount in top))
                if station.body_name:
                    parts.append(f"тело: {station.body_name}")
                if station.build_id:
                    parts.append(f"buildId: {station.build_id}")
                self._map_set_hint(" · ".join(parts))
                return
        for body in snapshot.bodies:
            if body.name == key:
                parts = [body.label, f"{body.distance_ls:.1f} ls"]
                if body.stations:
                    parts.append(f"объектов: {len(body.stations)}")
                self._map_set_hint(" · ".join(parts))
                return
        self._map_set_hint("")

    # ---------- карта: мышь и выбор ----------
    def _map_item_at(self, x, y):
        """Объект под курсором. Станции важнее тел: они нарисованы поверх."""
        priority = {"station": 0, "player": 1, "body": 2, "star": 3}
        best = None
        best_key = None
        for item in getattr(self, "_map_items", []) or []:
            reach = max(9.0, float(item.radius) + 5.0)
            distance = ((float(item.x) - float(x)) ** 2
                        + (float(item.y) - float(y)) ** 2) ** 0.5
            if distance > reach:
                continue
            key = (priority.get(item.kind, 9), distance)
            if best_key is None or key < best_key:
                best_key = key
                best = item
        return best

    def _map_item_key(self, item) -> str:
        ref = getattr(item, "ref", None)
        if isinstance(ref, MapStation):
            return str(ref.build_id or ref.name or "")
        return str(getattr(item, "label", "") or "")

    def _on_map_resize(self, _event=None):
        self._map_schedule_redraw()

    def _on_map_zoom(self, step: int):
        index = int(self._map_zoom_index) + int(step or 0)
        self._map_zoom_index = max(0, min(len(self.MAP_ZOOM_STEPS) - 1, index))
        self._map_update_zoom_label()
        self._map_remember_view()
        self._draw_system_map(self._map_last_snapshot)

    def _on_map_unscanned_toggle(self):
        """Тумблер «неотск.»: перезаполнить список и запомнить до рестарта."""
        self._map_remember_view()
        self._on_map_filter_changed()

    def _on_map_toggle(self):
        """Переключили «Луны»/«Подписи»: перерисовать и запомнить вид."""
        self._map_remember_view()
        self._map_redraw_now()

    def _map_remember_view(self):
        """Вид вкладки (зум, луны, подписи) переживает перезапуск приложения."""
        self.config["map_zoom_index"] = int(self._map_zoom_index)
        self.config["map_show_moons"] = bool(self.map_moons_var.get())
        self.config["map_show_labels"] = bool(self.map_labels_var.get())
        self.config["map_unscanned"] = bool(getattr(self, "map_unscanned_var", None)
                                            and self.map_unscanned_var.get())
        # Запись файла откладываем: колесо мыши даёт несколько шагов зума подряд.
        if self._map_save_job is not None:
            try:
                self.root.after_cancel(self._map_save_job)
            except Exception:
                pass
            self._map_save_job = None
        try:
            self._map_save_job = self.root.after(1200, self._map_flush_view)
        except Exception:
            self._map_save_job = None

    def _map_flush_view(self):
        self._map_save_job = None
        try:
            self.save_config()
        except Exception:
            pass

    def _on_map_wheel(self, event):
        delta = 0
        try:
            delta = int(getattr(event, "delta", 0) or 0)
        except Exception:
            delta = 0
        if delta:
            self._on_map_zoom(1 if delta > 0 else -1)
            return
        # Linux: колесо приходит кнопками 4 (вверх) и 5 (вниз).
        try:
            number = int(getattr(event, "num", 0) or 0)
        except Exception:
            number = 0
        self._on_map_zoom(1 if number == 4 else -1)

    def _on_map_click(self, event):
        try:
            self.map_canvas.focus_set()   # иначе Esc не долетит до холста
        except Exception:
            pass
        item = self._map_item_at(getattr(event, "x", 0), getattr(event, "y", 0))
        if item is None or item.kind == "player":
            return
        self._select_map_object(self._map_item_key(item))

    def _on_map_escape(self, _event=None):
        """Esc — вернуть звезду в центр: панорама сбрасывается с клавиатуры."""
        if not self._map_center:
            return
        self._map_center = ""
        self._map_set_hint("Центр — звезда системы")
        self._map_redraw_now()

    def _on_map_double_click(self, event):
        """Двойной клик по объекту — центр карты на нём; по пустому месту — сброс.

        Дальние луны и внешние стройки уезжают за край холста на любом зуме;
        панорама дешевле, чем ещё три ступени зума.
        """
        item = self._map_item_at(getattr(event, "x", 0), getattr(event, "y", 0))
        if item is None or item.kind == "player":
            self._map_center = ""
            self._map_set_hint("Центр — звезда системы; двойной клик по объекту "
                               "отцентрует на нём, Esc сбросит")
        else:
            self._map_center = self._map_item_key(item)
            self._map_set_hint(f"Центр: {item.label} — двойной клик по пустому месту "
                               f"или Esc вернёт звезду в центр")
        self._map_redraw_now()

    def _on_map_tree_double(self, event=None):
        """Двойной клик по строке — центр карты на объекте.

        Ctrl+двойной клик — прежний жест: открыть проект стройки в Raven
        Colonial. Два отдельных bind на `<Double-1>` — ловушка: второй
        молча перезаписывает первый, поэтому модификатор разведён внутри.
        """
        if event is not None and int(getattr(event, "state", 0) or 0) & 0x4:
            self._on_map_open_project()
            return
        if self._map_selected:
            self._map_center = self._map_selected
            self._map_redraw_now()

    def _on_map_hover(self, event):
        item = self._map_item_at(getattr(event, "x", 0), getattr(event, "y", 0))
        if item is None:
            self._map_restore_hint()
            return
        if item.kind == "player":
            self._map_set_hint(f"Вы здесь · {item.caption}")
            return
        if item.progress is not None:
            self._map_set_hint(f"{item.label} · завезено {item.progress}%")
            return
        self._map_set_hint(" · ".join(part for part in (item.label, item.caption) if part))

    def _on_map_tree_select(self, _event=None):
        tree = getattr(self, "map_tree", None)
        if tree is None:
            return
        try:
            selection = tree.selection()
        except Exception:
            return
        if not selection:
            return
        key = str(selection[0]).split(":", 1)[-1]
        if not key or key == self._map_selected:
            return
        self._map_selected = key
        self._draw_system_map(self._map_last_snapshot)
        self._map_show_details(key)

    def _select_map_object(self, key: str):
        self._map_selected = str(key or "")
        self._draw_system_map(self._map_last_snapshot)
        self._map_sync_tree_selection()
        self._map_show_details(self._map_selected)

    def _on_map_filter_changed(self):
        """Фильтр списка объектов: перерисовывать холст не нужно."""
        self._fill_map_tree(self._map_last_snapshot or self.system_map.snapshot())

    #: Сколько дней до дедлайна стройки считать «горит».
    MAP_DUE_SOON_DAYS = 3

    @staticmethod
    def _map_station_sort_key(station):
        """Стройки с ближайшим дедлайном — сверху: это и есть план маршрута."""
        group = 0 if (station.is_site and not station.complete
                      and not station.planned) else (1 if station.planned else 2)
        return (group, due_timestamp(station.due_at), station.title or "")

    @staticmethod
    def _map_carry_note(station) -> str:
        """Что везти на стройку: главный товар остатка по-русски."""
        if not station.remaining_by_commodity:
            return ""
        name, amount = max(station.remaining_by_commodity.items(),
                           key=lambda pair: pair[1])
        return f"{commodity_label(name)} {amount:,}".replace(",", " ")

    def _map_filter_matches(self, values) -> bool:
        needle = str(self.map_filter_var.get() or "").strip().lower()
        if not needle:
            return True
        return any(needle in str(value).lower() for value in values)

    def _on_map_save_png(self):
        """Схему системы — в PNG: крылу картинка, а не простыня текста.

        Рендерим сами (`map_export`), без Pillow и скриншотов окна: файл
        открывается везде и не тащит в EXE ещё десяток мегабайт.
        """
        snapshot = self._map_last_snapshot or self.system_map.snapshot()
        try:
            path = filedialog.asksaveasfilename(
                title="Сохранить карту системы",
                defaultextension=".png",
                filetypes=(("PNG-изображение", "*.png"), ("Все файлы", "*.*")))
        except Exception:
            path = ""
        if not path:
            return
        show_moons = not getattr(self, "map_moons_var", None) or bool(
            self.map_moons_var.get())
        show_labels = not getattr(self, "map_labels_var", None) or bool(
            self.map_labels_var.get())
        if save_map_png(snapshot, str(path), zoom=self._map_zoom(),
                        show_moons=show_moons, show_labels=show_labels,
                        center_on=self._map_center):
            self._map_update_status(snapshot, f"Карта сохранена: {path}")
        else:
            self._map_update_status(snapshot,
                                    f"Не удалось сохранить карту: {path}")

    def _on_map_copy_summary(self):
        """Сводку системы — в буфер обмена: удобно кинуть в чат крыла."""
        snapshot = self._map_last_snapshot or self.system_map.snapshot()
        report = map_report(snapshot, VERSION)
        try:
            import pyperclip

            pyperclip.copy(report)
        except Exception:
            try:
                self.root.clipboard_clear()
                self.root.clipboard_append(report)
            except Exception:
                self._map_set_hint("Буфер обмена недоступен")
                return
        sites = len([station for station in snapshot.sites if not station.complete])
        self.log(f"Сводка системы {snapshot.system or '—'} скопирована "
                 f"(строек: {sites})", "info")
        self._map_set_hint("Сводка скопирована в буфер обмена")

    def _on_map_open_project(self):
        """Двойной клик по стройке — открыть её проект в Raven Colonial."""
        snapshot = self._map_last_snapshot
        key = self._map_selected
        if snapshot is None or not key:
            return
        build_id = ""
        for station in snapshot.stations:
            if key in (station.build_id, station.name):
                build_id = station.build_id
                break
        if not build_id:
            self._map_set_hint("У объекта нет buildId — проект в Raven не открываем")
            return
        name = ""
        for station in snapshot.stations:
            if station.build_id == build_id:
                name = station.title
                break
        try:
            url = project_url(build_id)
        except Exception:
            url = ""
        if not url:
            return
        self._colony_open_url(url, f"Проект {name}" if name else "Проект")

    # ---------- карта: данные Raven Colonial ----------
    def _on_map_refresh(self):
        self._map_redraw_now()
        if not self.system_map.current_system:
            self._map_set_status(
                "Система неизвестна — включите Watcher или загрузите журналы")
            return
        snapshot = self._map_last_snapshot or self.system_map.snapshot()
        if not getattr(self.raven_api, "is_connected", False):
            if not self._map_apply_raven_cache(self.system_map.current_system):
                self._map_update_status(
                    snapshot, "Raven Colonial не подключён: показаны только данные журнала")
            return
        self._map_update_status(snapshot, "Запрашиваю проекты и планы в Raven Colonial…")
        self._map_refresh_from_raven(force=True)

    def _map_refresh_from_raven(self, force: bool = False):
        """Фоновый запрос проектов и планов системы (не чаще MAP_RAVEN_TTL)."""
        system = self.system_map.current_system
        if not system:
            return
        key = f"{system}:{self.system_map.current_system_address}"
        if not self._map_raven_fetched.get(key):
            # Сеть ещё не ответила ни разу за этот запуск: показываем прошлый визит.
            self._map_apply_raven_cache(system)
        if not getattr(self.raven_api, "is_connected", False):
            return
        if self._map_raven_inflight:
            return
        address = self.system_map.current_system_address
        key = f"{system}:{address}"
        now = time.time()
        try:
            previous = float(self._map_raven_fetched.get(key) or 0.0)
        except (TypeError, ValueError):
            previous = 0.0
        if not force and now - previous < self.MAP_RAVEN_TTL:
            return
        self._map_raven_fetched[key] = now
        self._map_raven_inflight = True
        api = self.raven_api

        def worker():
            try:
                projects = api.get_system_projects(address or system)
                sites = api.get_system_sites(system)
                whole = api.get_system_v2(system)
            except Exception:
                projects = sites = whole = None
            self.after(0, lambda: self._map_raven_done(system, projects, sites, whole))

        threading.Thread(target=worker, daemon=True, name="map-raven").start()

    def _map_apply_raven_cache(self, system: str) -> bool:
        """Подставить прошлый ответ Raven, пока сеть молчит (или недоступна)."""
        cache = getattr(self, "map_cache", None)
        if cache is None or not system:
            return False
        entry = cache.load(system)
        bodies = entry.get("bodies") or []
        projects = entry.get("projects") or []
        plans = entry.get("plans") or []
        if not (bodies or projects or plans):
            return False
        changed = False
        if bodies:
            changed = bool(self.system_map.merge_bodies(system, bodies)) or changed
        if projects:
            changed = bool(self.system_map.merge_projects(system, projects)) or changed
        if plans:
            changed = bool(self.system_map.merge_site_plans(system, plans)) or changed
        if not changed:
            return False
        self._map_redraw_now()
        snapshot = self._map_last_snapshot or self.system_map.snapshot()
        self._map_update_status(snapshot,
                                f"Raven Colonial: кэш{self._map_cache_age(entry.get('ts'))}")
        return True

    @staticmethod
    def _map_cache_age(ts) -> str:
        """Возраст кэша человечески: «, данные от 12.09 21:40»."""
        try:
            stamp = datetime.fromtimestamp(float(ts))
        except (TypeError, ValueError, OSError, OverflowError):
            return ""
        return f", данные от {stamp:%d.%m %H:%M}"

    def _map_raven_done(self, system: str, projects_result, sites_result,
                        whole_result=None):
        self._map_raven_inflight = False
        if self.system_map.current_system != system:
            return   # пилот уже улетел: эти данные другой системы
        projects = []
        plans = []
        note = ""
        bodies = []
        if isinstance(whole_result, dict) and whole_result.get("ok"):
            bodies = self._map_extract_bodies(whole_result.get("data"))
        if isinstance(projects_result, dict) and projects_result.get("ok"):
            projects = self._map_extract_projects(projects_result.get("data"))
        elif isinstance(projects_result, dict) and projects_result.get("error"):
            note = f"Raven Colonial (проекты): {projects_result.get('error')}"
        if isinstance(sites_result, dict) and sites_result.get("ok"):
            plans = self._map_extract_plans(sites_result.get("data"))
        elif isinstance(sites_result, dict) and sites_result.get("error") and not note:
            note = f"Raven Colonial (планы): {sites_result.get('error')}"
        changed = False
        if bodies:
            # Тела — первыми: стройплощадки и планы привязываются к телам.
            changed = bool(self.system_map.merge_bodies(system, bodies)) or changed
        if projects:
            changed = bool(self.system_map.merge_projects(system, projects)) or changed
        if plans:
            changed = bool(self.system_map.merge_site_plans(system, plans)) or changed
        if projects or plans or bodies:
            note = (f"Raven Colonial: проектов — {len(projects)}, планов — {len(plans)}, "
                    f"тел — {len(bodies)}")
            cache = getattr(self, "map_cache", None)
            if cache is not None:
                # В следующий раз карта соберётся из этого кэша без ожидания сети.
                cache.store(system, bodies, projects, plans)
        if changed:
            self._map_redraw_now()
        if note:
            snapshot = self._map_last_snapshot or self.system_map.snapshot()
            self._map_update_status(snapshot, note)

    @staticmethod
    def _map_extract_projects(data) -> list:
        """Ответ /api/system/{addr}: список проектов или {'projects': [...]}.

        В отличие от вкладки «Колонизатор» здесь нужны и проекты без buildId:
        по ним карта показывает потребность и остаток, даже если проект ещё не
        привязан к командиру.
        """
        if isinstance(data, dict):
            for key in ("projects", "Projects", "builds", "data"):
                if isinstance(data.get(key), list):
                    return [item for item in data[key] if isinstance(item, dict)]
            if any(key in data for key in ("buildId", "buildName", "marketId", "sumTotal")):
                return [data]
            return []
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    @staticmethod
    def _map_extract_bodies(data) -> list:
        """Ответ /v2/system/{system}: тела могут лежать в 'bodies' или списком."""
        if isinstance(data, dict):
            for key in ("bodies", "Bodies", "stars", "planets"):
                if isinstance(data.get(key), list):
                    found = [item for item in data[key] if isinstance(item, dict)]
                    if found:
                        return found
            nested = data.get("body") or data.get("Body")
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
            return [data] if any(key in data for key in ("bodyName", "BodyName")) else []
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        return []

    @staticmethod
    def _map_extract_plans(data) -> list:
        """Ответ /api/v2/system/{system}/sites: все площадки вместе со статусом.

        Статус важен: `demolish` карта не показывает, `complete` — показывает
        построенный объект. Фильтрует статусы уже `merge_site_plans`.
        """
        if isinstance(data, dict):
            for key in ("sites", "Sites"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
            else:
                data = [data] if data else []
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, dict)]

    # ---------- карта: события журнала ----------
    def _feed_system_map(self, event: dict, live: bool = False):
        """Событие журнала — в карту системы.

        Вызывается из того же однопроходного разбора, что и остальные трекеры:
        отдельных чтений журнала карта не добавляет. В историческом разборе
        (`live=False`) сеть не трогаем — там десятки тысяч событий и сотни
        прыжков, а Raven Colonial нужен только для текущей системы.
        """
        try:
            changed = self.system_map.handle(event)
        except Exception:
            return
        if not changed:
            return
        name = str(event.get("event") or "")
        if not live:
            if self._map_visible():
                self._map_schedule_redraw()
            return
        self._map_schedule_redraw()
        if name in ("Location", "FSDJump", "CarrierJump", "ColonisationConstructionDepot",
                    "Docked"):
            # Прибыли в систему или открыли депо стройки: журнал не знает,
            # сколько груза завезли другие командиры, — спросим Raven Colonial.
            self._map_refresh_from_raven()

    def _on_notebook_tab_changed(self, _event=None):
        """Переключили вкладку: карте и экзобиологии нужны свежие данные."""
        if self._map_visible():
            self._map_redraw_now()
            self._map_refresh_from_raven()
            self._map_arm_autorefresh()
        if hasattr(self, "notebook") and hasattr(self, "tab_exobio"):
            try:
                selected_tab = self.notebook.select()
                if selected_tab == str(self.tab_exobio):
                    self._update_tab_exobio()
                    if hasattr(self, "exobiology") and self.exobiology.current_system:
                        self._ensure_system_exobio(self.exobiology.current_system)
            except Exception:
                pass

    def _map_arm_autorefresh(self):
        """Пока вкладка открыта, Raven опрашивается сам раз в MAP_RAVEN_TTL.

        Процент завезённого меняется не только когда пилот что-то привёз:
        другие командиры довозят груз, и карта открытой вкладки должна это
        показать без нажатия «Обновить». Цепочка сама обрывается, стоит
        переключить вкладку.
        """
        if self._map_autorefresh_job is not None:
            return
        try:
            self._map_autorefresh_job = self.root.after(
                self.MAP_RAVEN_TTL * 1000, self._map_autorefresh_tick)
        except Exception:
            self._map_autorefresh_job = None

    def _map_autorefresh_tick(self):
        self._map_autorefresh_job = None
        if not self._map_visible():
            return
        self._map_refresh_from_raven()
        self._map_arm_autorefresh()

    # ============================================================
    #  Вкладка: Оверлей
    # ============================================================
    def _build_tab_overlay(self):
        # Настроек оверлея больше, чем помещается в небольшое окно, поэтому
        # вся панель прокручивается (общий помощник `_scrollable_frame`).
        frame = self._scrollable_frame(self.tab_overlay)

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

        # ---- Блоки HUD: вид и поведение ----
        tb.Label(frame, text="Блоки HUD: вид и поведение", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(10, 5))
        tb.Label(
            frame,
            text="Каждый блок настраивается отдельно: показывать ли его, можно ли перетаскивать, "
                 "своя прозрачность и свой размер шрифта, размер окна, «клик насквозь» и правило "
                 "«показывать по ситуации». Всё применяется сразу — оверлей перезапускать не нужно.",
            foreground=COLOR_MUTED,
            wraplength=700,
        ).pack(anchor=W, pady=(0, 8))

        head = tb.Frame(frame)
        head.pack(fill=X, pady=(0, 2))
        for column_text, column_width in (
            ("Блок", 20), ("Показ", 6), ("Блокир.", 8), ("Сквозь", 7),
            ("Прозр.", 8), ("Шрифт", 7), ("Размер", 10), ("Показывать", 24), ("Клавиша", 8),
        ):
            tb.Label(head, text=column_text, width=column_width, anchor=W,
                     font=("Consolas", 8), foreground=COLOR_MUTED).pack(side=LEFT, padx=(0, 4))

        self._overlay_block_vars = {}
        for block_key in self.overlay_manager.BLOCKS:
            self._build_overlay_block_row(frame, block_key)

        # Общий размер всех блоков
        all_size_frame = tb.Frame(frame)
        all_size_frame.pack(fill=X, pady=(8, 0))
        tb.Label(all_size_frame, text="Размер всех блоков:", width=20, anchor=W).pack(side=LEFT)
        self.all_size_var = tk.StringVar(value="M — 100%")
        all_size_combo = tb.Combobox(
            all_size_frame, textvariable=self.all_size_var, width=10, state="readonly",
            values=[SIZE_PRESET_LABELS[name] for name, _factor in SIZE_PRESETS],
        )
        all_size_combo.pack(side=LEFT, padx=(0, 4))
        all_size_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_all_size_preset_changed())
        tb.Button(all_size_frame, text="Применить", command=self._on_all_size_preset_changed,
                  bootstyle="info-outline", width=12).pack(side=LEFT, padx=(6, 0))

        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=15)

        # ---- Поведение оверлея ----
        tb.Label(frame, text="Поведение оверлея", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(0, 5))

        self.click_through_var = tk.BooleanVar(
            value=bool(self.overlay_manager.settings.get("click_through", False))
        )
        tb.Checkbutton(
            frame,
            text="Клик-сквозь для всех блоков (HUD только для глаз, мышь работает в игре)",
            variable=self.click_through_var,
            command=self._on_click_through_changed,
        ).pack(anchor=W, pady=2)

        self.auto_rules_var = tk.BooleanVar(
            value=bool(self.overlay_manager.settings.get("auto_rules_enabled", False))
        )
        tb.Checkbutton(
            frame,
            text="Показывать блоки по ситуации (правила заданы в таблице выше)",
            variable=self.auto_rules_var,
            command=self._on_auto_rules_changed,
        ).pack(anchor=W, pady=2)

        self.attach_game_var = tk.BooleanVar(
            value=self.overlay_manager.settings.get("attach_to_game", True)
        )
        tb.Checkbutton(
            frame,
            text="Привязать оверлей к окну Elite Dangerous (только поверх игры)",
            variable=self.attach_game_var,
            command=self._on_attach_game_changed,
        ).pack(anchor=W, pady=2)

        idle_frame = tb.Frame(frame)
        idle_frame.pack(fill=X, pady=(6, 0))
        tb.Label(idle_frame, text="Скрывать при простое:", width=20, anchor=W).pack(side=LEFT)
        current_idle = int(self.overlay_manager.settings.get("idle_timeout", 0) or 0)
        self.idle_var = tk.StringVar(value=self._idle_label(current_idle))
        idle_combo = tb.Combobox(
            idle_frame, textvariable=self.idle_var, width=14, state="readonly",
            values=[self._idle_label(seconds) for seconds in IDLE_TIMEOUTS],
        )
        idle_combo.pack(side=LEFT, padx=(0, 4))
        idle_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_idle_changed())
        tb.Label(
            idle_frame,
            text="простой = нет новых событий в журнале",
            foreground=COLOR_MUTED,
        ).pack(side=LEFT, padx=(10, 0))

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
        tb.Label(frame, text="Горячие клавиши", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(0, 5))
        self.hotkey_hint_label = tb.Label(
            frame,
            text="",
            foreground=COLOR_MUTED,
            font=("Consolas", 9),
            wraplength=700,
            justify=LEFT,
        )
        self.hotkey_hint_label.pack(anchor=W, pady=(0, 6))
        tb.Label(
            frame,
            text="Управление оверлеями:\n"
                 "  • Перетаскивайте за заголовок (если блок не заблокирован)\n"
                 "  • [L/U] в шапке — блокировка позиции\n"
                 "  • [<] / [>] в шапке — клик-сквозь для этого блока\n"
                 "  • [*] в шапке — меню: привязка, размер, прозрачность\n"
                 "  • Потяните за угол — изменение размера\n"
                 "  • Клавиши из таблицы выше — показать/скрыть конкретный блок\n"
                 "  • F12 — показать/скрыть все блоки, Ctrl+O — включить/выключить оверлей",
            foreground=COLOR_MUTED,
            font=("Consolas", 10),
            justify=LEFT,
        ).pack(anchor=W)

        # Изменения из оверлея (горячие клавиши, профиль) должны догонять
        # виджеты вкладки, иначе галочки врут.
        self.overlay_manager.on_settings_changed = self._on_overlay_settings_changed
        self._update_overlay_hotkey_hint()

    # ---------- Блоки: персональные настройки ----------
    OVERLAY_ALPHA_CHOICES = ("общая", "40%", "55%", "70%", "85%", "100%")
    OVERLAY_FONT_CHOICES = ("общий", "8", "9", "10", "11", "12", "14", "16", "18")
    OVERLAY_HOTKEY_CHOICES = ("—", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8",
                              "F9", "F10", "F11", "F12")

    def _idle_label(self, seconds: int) -> str:
        """Подпись для выбора таймера простоя."""
        seconds = int(seconds or 0)
        if seconds <= 0:
            return "не скрывать"
        if seconds < 60:
            return f"{seconds} с"
        return f"{seconds // 60} мин"

    def _idle_seconds(self, label: str) -> int:
        """Обратно: подпись -> секунды."""
        text = (label or "").strip().lower()
        if not text or text.startswith("не "):
            return 0
        if "мин" in text:
            digits = "".join(ch for ch in text if ch.isdigit())
            return int(digits or 0) * 60
        digits = "".join(ch for ch in text if ch.isdigit())
        return int(digits or 0)

    def _block_size_preset(self, key: str) -> str:
        """Ближайший пресет к текущему размеру блока."""
        from overlay import DEFAULT_BLOCK_POSITIONS

        default = DEFAULT_BLOCK_POSITIONS.get(key)
        width = self.overlay_manager.settings.get(f"{key}_width")
        if not default or not width:
            return "M"
        try:
            ratio = float(width) / float(default[2])
        except (TypeError, ValueError, ZeroDivisionError):
            return "M"
        return min(SIZE_PRESETS, key=lambda item: abs(item[1] - ratio))[0]

    def _build_overlay_block_row(self, parent, key: str):
        """Строка настроек одного блока HUD."""
        settings = self.overlay_manager.settings
        row = tb.Frame(parent)
        row.pack(fill=X, pady=1)
        widgets = {}

        tb.Label(row, text=BLOCK_LABELS.get(key, key), width=20, anchor=W).pack(side=LEFT, padx=(0, 4))

        # Показ
        visible_var = tk.BooleanVar(value=bool(settings.get(f"show_{key}", True)))
        setattr(self, f"show_{key}_var", visible_var)   # совместимость со старыми обработчиками
        widgets["visible"] = visible_var
        tb.Checkbutton(row, variable=visible_var, width=3,
                       command=lambda: self._on_block_visible_changed(key)).pack(side=LEFT, padx=(0, 4))

        # Блокировка позиции
        lock_var = tk.BooleanVar(value=bool(settings.get(f"{key}_locked", False)))
        widgets["locked"] = lock_var
        tb.Checkbutton(row, variable=lock_var, width=3,
                       command=lambda: self._on_block_lock_changed(key)).pack(side=LEFT, padx=(0, 4))

        # Клик-сквозь
        through_var = tk.BooleanVar(value=self._block_through_value(key))
        widgets["click_through"] = through_var
        tb.Checkbutton(row, variable=through_var, width=3,
                       command=lambda: self._on_block_through_changed(key)).pack(side=LEFT, padx=(0, 4))

        # Прозрачность
        alpha_var = tk.StringVar(value=self._block_alpha_label(key))
        widgets["alpha"] = alpha_var
        alpha_combo = tb.Combobox(row, textvariable=alpha_var, width=8, state="readonly",
                                  values=list(self.OVERLAY_ALPHA_CHOICES))
        alpha_combo.pack(side=LEFT, padx=(0, 4))
        alpha_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_block_alpha_changed(key))

        # Шрифт
        font_var = tk.StringVar(value=self._block_font_label(key))
        widgets["font_size"] = font_var
        font_combo = tb.Combobox(row, textvariable=font_var, width=7, state="readonly",
                                 values=list(self.OVERLAY_FONT_CHOICES))
        font_combo.pack(side=LEFT, padx=(0, 4))
        font_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_block_font_changed(key))

        # Размер
        size_var = tk.StringVar(value=SIZE_PRESET_LABELS.get(self._block_size_preset(key), "M — 100%"))
        widgets["size"] = size_var
        size_combo = tb.Combobox(row, textvariable=size_var, width=10, state="readonly",
                                 values=[SIZE_PRESET_LABELS[name] for name, _f in SIZE_PRESETS])
        size_combo.pack(side=LEFT, padx=(0, 4))
        size_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_block_size_changed(key))

        # Правило показа
        rule = str(settings.get(f"{key}_auto_rule", "always") or "always")
        rule_var = tk.StringVar(value=AUTO_RULE_LABELS.get(rule, AUTO_RULE_LABELS["always"]))
        widgets["auto_rule"] = rule_var
        rule_combo = tb.Combobox(row, textvariable=rule_var, width=24, state="readonly",
                                 values=[AUTO_RULE_LABELS[name] for name in AUTO_RULES])
        rule_combo.pack(side=LEFT, padx=(0, 4))
        rule_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_block_rule_changed(key))

        # Горячая клавиша
        hotkey_var = tk.StringVar(value=str(settings.get(f"{key}_hotkey", "") or "—") or "—")
        widgets["hotkey"] = hotkey_var
        hotkey_combo = tb.Combobox(row, textvariable=hotkey_var, width=8, state="readonly",
                                   values=list(self.OVERLAY_HOTKEY_CHOICES))
        hotkey_combo.pack(side=LEFT, padx=(0, 4))
        hotkey_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_block_hotkey_changed(key))

        tb.Button(row, text="сброс", width=7, bootstyle="secondary-outline",
                  command=lambda: self._on_block_reset(key)).pack(side=LEFT)

        self._overlay_block_vars[key] = widgets

    # -- подписи и разбор значений --
    def _block_through_value(self, key: str) -> bool:
        from overlay import block_click_through

        return block_click_through(self.overlay_manager.settings, key)

    def _block_alpha_label(self, key: str) -> str:
        value = self.overlay_manager.settings.get(f"{key}_alpha")
        return "общая" if value is None else f"{int(round(float(value) * 100))}%"

    def _block_font_label(self, key: str) -> str:
        value = self.overlay_manager.settings.get(f"{key}_font_size")
        return "общий" if value in (None, "") else str(int(value))

    def _rule_key_by_label(self, label: str) -> str:
        for rule_key, text in AUTO_RULE_LABELS.items():
            if text == label:
                return rule_key
        return "always"

    def _preset_key_by_label(self, label: str) -> str:
        for name, text in SIZE_PRESET_LABELS.items():
            if text == label:
                return name
        return "M"

    # -- обработчики строки блока --
    def _on_block_visible_changed(self, key: str):
        show = bool(self._overlay_block_vars[key]["visible"].get())
        self.overlay_manager.set_block_visible(key, show)

    def _on_block_lock_changed(self, key: str):
        self.overlay_manager.set_block_locked(key, self._overlay_block_vars[key]["locked"].get())

    def _on_block_through_changed(self, key: str):
        enabled = bool(self._overlay_block_vars[key]["click_through"].get())
        self.overlay_manager.set_click_through(enabled, key=key)
        self.log(
            f"{BLOCK_LABELS.get(key, key)}: клик-сквозь {'включён' if enabled else 'выключен'}",
            "info",
        )

    def _on_block_alpha_changed(self, key: str):
        label = self._overlay_block_vars[key]["alpha"].get()
        if label == "общая":
            self.overlay_manager.set_block_alpha(key, None)
        else:
            digits = "".join(ch for ch in label if ch.isdigit())
            self.overlay_manager.set_block_alpha(key, int(digits or 100) / 100.0)

    def _on_block_font_changed(self, key: str):
        label = self._overlay_block_vars[key]["font_size"].get()
        if label == "общий":
            self.overlay_manager.set_block_font_size(key, None)
        else:
            digits = "".join(ch for ch in label if ch.isdigit())
            if digits:
                self.overlay_manager.set_block_font_size(key, int(digits))

    def _on_block_size_changed(self, key: str):
        preset = self._preset_key_by_label(self._overlay_block_vars[key]["size"].get())
        self.overlay_manager.apply_size_preset(preset, key)

    def _on_block_rule_changed(self, key: str):
        rule = self._rule_key_by_label(self._overlay_block_vars[key]["auto_rule"].get())
        self.overlay_manager.set_auto_rule(key, rule)
        if not self.overlay_manager.settings.get("auto_rules_enabled", False):
            self.auto_rules_var.set(True)
            self.overlay_manager.set_auto_rules_enabled(True)

    def _on_block_hotkey_changed(self, key: str):
        value = self._overlay_block_vars[key]["hotkey"].get().strip()
        combo = "" if value in ("", "—") else value
        self.overlay_manager.set_block_hotkey(key, combo)
        self._update_overlay_hotkey_hint()
        if combo and not self.overlay_manager.hotkeys.available:
            self.log(
                f"Горячая клавиша {combo} сохранена, но системные горячие клавиши "
                f"доступны только в Windows.",
                "warn",
            )
        elif combo:
            self.log(f"{BLOCK_LABELS.get(key, key)}: горячая клавиша {combo}", "success")

    def _on_block_reset(self, key: str):
        self.overlay_manager.reset_block(key)
        self._sync_overlay_block_rows()
        self.log(f"{BLOCK_LABELS.get(key, key)}: настройки сброшены", "info")

    def _on_all_size_preset_changed(self):
        preset = self._preset_key_by_label(self.all_size_var.get())
        if self.overlay_manager.apply_size_preset(preset):
            self._sync_overlay_block_rows()
            self.log(f"Размер всех блоков: {SIZE_PRESET_LABELS.get(preset, preset)}", "info")

    def _on_click_through_changed(self):
        enabled = bool(self.click_through_var.get())
        self.overlay_manager.set_click_through(enabled)
        self._sync_overlay_block_rows()
        self.log(
            "Клик-сквозь включён: HUD не перехватывает мышь" if enabled
            else "Клик-сквозь выключен",
            "info",
        )

    def _on_auto_rules_changed(self):
        self.overlay_manager.set_auto_rules_enabled(bool(self.auto_rules_var.get()))

    def _on_idle_changed(self):
        seconds = self._idle_seconds(self.idle_var.get())
        self.overlay_manager.set_idle_timeout(seconds)

    def _sync_overlay_block_rows(self):
        """Перечитать настройки в виджеты (после сброса, профиля, горячей клавиши)."""
        settings = self.overlay_manager.settings
        for key, widgets in getattr(self, "_overlay_block_vars", {}).items():
            widgets["visible"].set(bool(settings.get(f"show_{key}", True)))
            widgets["locked"].set(bool(settings.get(f"{key}_locked", False)))
            widgets["click_through"].set(self._block_through_value(key))
            widgets["alpha"].set(self._block_alpha_label(key))
            widgets["font_size"].set(self._block_font_label(key))
            widgets["size"].set(SIZE_PRESET_LABELS.get(self._block_size_preset(key), "M — 100%"))
            rule = str(settings.get(f"{key}_auto_rule", "always") or "always")
            widgets["auto_rule"].set(AUTO_RULE_LABELS.get(rule, AUTO_RULE_LABELS["always"]))
            widgets["hotkey"].set(str(settings.get(f"{key}_hotkey", "") or "—") or "—")
        if hasattr(self, "idle_var"):
            self.idle_var.set(self._idle_label(int(settings.get("idle_timeout", 0) or 0)))
        if hasattr(self, "click_through_var"):
            self.click_through_var.set(bool(settings.get("click_through", False)))
        if hasattr(self, "auto_rules_var"):
            self.auto_rules_var.set(bool(settings.get("auto_rules_enabled", False)))
        if hasattr(self, "all_size_var"):
            self.all_size_var.set("M — 100%")

    def _on_overlay_settings_changed(self, key: str, name: str, _value):
        """Настройка изменилась из оверлея (например, по горячей клавише)."""
        self._sync_overlay_block_rows()

    def _update_overlay_hotkey_hint(self):
        """Строка подсказки: какие клавиши за чем закреплены."""
        if not hasattr(self, "hotkey_hint_label"):
            return
        lines = []
        for key in self.overlay_manager.BLOCKS:
            combo = str(self.overlay_manager.settings.get(f"{key}_hotkey", "") or "")
            if combo:
                lines.append(f"{combo} — {BLOCK_LABELS.get(key, key)}")
        all_combo = str(self.overlay_manager.settings.get("toggle_all_hotkey", "F12") or "")
        if all_combo:
            lines.append(f"{all_combo} — показать/скрыть все блоки")
        hint = "Назначено: " + "; ".join(lines) if lines else "Клавиши не назначены."
        if not self.overlay_manager.hotkeys.available:
            hint += "  (системные горячие клавиши работают только в Windows)"
        try:
            self.hotkey_hint_label.config(text=hint)
        except Exception:
            pass

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
        """F12: показать/скрыть все блоки.

        Когда системные горячие клавиши зарегистрированы, нажатие обрабатывает
        отдельный поток (`HotkeyManager`) — иначе блоки переключились бы
        дважды: и по привязке Tk, и по глобальной клавише.
        """
        if self.overlay_manager.hotkeys.running:
            return
        self.overlay_manager.toggle_all_blocks()
        state = "visible" if any(
            self.overlay_manager.settings.get(f"show_{key}", True)
            for key in self.overlay_manager.BLOCKS
        ) else "hidden"
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
        self._sync_overlay_block_rows()
        self._update_overlay_hotkey_hint()
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
        self.overlay_manager.set_block_visible("route", self.show_route_var.get())

    def _on_show_status_changed(self):
        self.overlay_manager.set_block_visible("status", self.show_status_var.get())

    def _on_show_ship_changed(self):
        self.overlay_manager.set_block_visible("ship", self.show_ship_var.get())

    def _on_show_cargo_changed(self):
        self.overlay_manager.set_block_visible("cargo", self.show_cargo_var.get())

    def _on_show_session_changed(self):
        self.overlay_manager.set_block_visible("session", self.show_session_var.get())

    def _on_show_events_changed(self):
        """EVENTS создаётся вместе с остальными окнами, поэтому просто
        показываем/прячем существующее окно."""
        self.overlay_manager.set_block_visible("events", self.show_events_var.get())

    def _on_show_exobio_changed(self):
        """Блок экзобиологии показывает данные по текущему телу из журнала."""
        self.overlay_manager.set_block_visible("exobio", self.show_exobio_var.get())

    def _on_attach_game_changed(self):
        self.overlay_manager.set_attach_to_game(self.attach_game_var.get())
        state = "включена" if self.attach_game_var.get() else "отключена"
        self.log(f"Привязка к окну игры {state}", "info")

    def _on_ship_block_changed(self, block: str, show: bool):
        self.overlay_manager.set_ship_block(block, show)

    def _on_reset_overlay_positions(self):
        self.overlay_manager.reset_positions()
        self.overlay_manager.apply_block_style()
        self._refresh_profile_combo()
        self._sync_overlay_block_rows()
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
            "exobiology": self._exobiology_overlay_state(),
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
        # Авианосец: тоннаж из CarrierStats + товары поимённо (сколько уже
        # лежит на борту) + остаток до потребности основного проекта.
        need, need_label, need_source = self._carrier_need_info()
        data["carrier"] = self.carrier.get_state_dict(
            need, need_label=need_label, need_source=need_source)
        data["last_delivery_system"] = self._last_delivery_system
        return data

    # ============================================================
    #  Вкладка: Лог
    # ============================================================
    # ============================================================
    #  Вкладка: Экзобиология (тела, биосигналы, фильтры оверлея EXOBIO)
    # ============================================================
    def _build_tab_exobio(self):
        """Вкладка «Экзобиология»: текущая система, тела, биосигналы и фильтры оверлея."""
        frame = self._scrollable_frame(self.tab_exobio)
        settings = self.overlay_manager.settings

        tb.Label(frame, text="Экзобиология — поиск органики и фильтры оверлея",
                 font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 4))
        tb.Label(
            frame,
            text="Тела текущей системы, биосигналы, образцы и фильтры для оверлея EXOBIO. "
                 "Если система уже была отсканирована ранее, сканы подтягиваются автоматически "
                 "из истории журналов и кэша. Все изменения фильтров применяются сразу.",
            foreground=COLOR_MUTED, wraplength=780,
        ).pack(anchor=W, pady=(0, 10))

        # ---- Панель текущей системы и управление ----
        sys_box = tb.Frame(frame, padding=8, relief="solid", borderwidth=1)
        sys_box.pack(fill=X, pady=(0, 10))

        top_row = tb.Frame(sys_box)
        top_row.pack(fill=X)

        self.exobio_system_label = tb.Label(
            top_row, text="Текущая система: —", font=("Segoe UI", 11, "bold"), foreground=COLOR_CYAN
        )
        self.exobio_system_label.pack(side=LEFT)

        tb.Button(
            top_row, text="Сверить с журналами", command=lambda: self._scan_journals_for_current_system(force=True),
            bootstyle="info-outline", width=22
        ).pack(side=RIGHT, padx=(6, 0))
        tb.Button(
            top_row, text="Сканировать все журналы", command=self._scan_all_journals_for_exobio,
            bootstyle="secondary-outline", width=24
        ).pack(side=RIGHT)

        self.exobio_summary_label = tb.Label(
            sys_box, text="Тел отсканировано: 0 · С биосигналами: 0 · Всего биосигналов: 0",
            font=("Segoe UI", 9), foreground=COLOR_MUTED
        )
        self.exobio_summary_label.pack(anchor=W, pady=(4, 0))

        self.exobio_status_label = tb.Label(
            sys_box, text="", font=("Segoe UI", 9), foreground=COLOR_ORANGE
        )
        self.exobio_status_label.pack(anchor=W)

        # ---- Таблица тел текущей системы ----
        tb.Label(frame, text="Тела текущей системы", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(4, 2))
        tb.Label(
            frame,
            text="Отсканированные тела текущей системы: тип, атмосфера, посадка, число биосигналов "
                 "и совпадение с выбранными фильтрами поиска.",
            foreground=COLOR_MUTED, wraplength=780,
        ).pack(anchor=W, pady=(0, 4))

        tree_frame = tb.Frame(frame, relief="solid", borderwidth=1)
        tree_frame.pack(fill=X, expand=False, pady=(0, 10))

        columns = ("body", "class", "atmosphere", "landable", "signals", "mapped", "matched")
        self.exobio_tree = tb.Treeview(
            tree_frame, columns=columns, show="headings", bootstyle="dark", height=6,
        )
        for col, title, width, anchor in [
            ("body", "Тело", 160, W),
            ("class", "Класс", 130, W),
            ("atmosphere", "Атмосфера", 160, W),
            ("landable", "Посадка", 75, CENTER),
            ("signals", "Биосигналы", 90, CENTER),
            ("mapped", "Карта DSS", 85, CENTER),
            ("matched", "Подходит под фильтр", 200, W),
        ]:
            self.exobio_tree.heading(col, text=title)
            self.exobio_tree.column(col, width=width, anchor=anchor)

        vsb = tb.Scrollbar(tree_frame, orient=VERTICAL, command=self.exobio_tree.yview)
        self.exobio_tree.configure(yscrollcommand=vsb.set)
        self.exobio_tree.pack(side=LEFT, fill=BOTH, expand=True)
        vsb.pack(side=RIGHT, fill=Y)

        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=10)

        # ---- Фильтр по родам ----
        tb.Label(frame, text="Роды в прогнозе", font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(0, 5))
        tb.Label(
            frame,
            text="Отмеченные роды остаются в списке «Вероятные роды», остальные скрываются. "
                 "Если не отмечено ничего — фильтр выключен и показываются все роды.",
            foreground=COLOR_MUTED, wraplength=700,
        ).pack(anchor=W, pady=(0, 6))

        selected_genera = {str(g) for g in (settings.get("exobio_genera") or [])}
        self._exobio_genus_vars = {}
        genera_grid = tb.Frame(frame)
        genera_grid.pack(anchor=W, fill=X, pady=(0, 6))
        for index, genus in enumerate(sorted(GENUS_VALUE_CR)):
            var = tk.BooleanVar(value=genus in selected_genera)
            self._exobio_genus_vars[genus] = var
            tb.Checkbutton(
                genera_grid, text=genus, variable=var, width=22,
                command=self._on_exobio_filters_changed,
            ).grid(row=index // 3, column=index % 3, sticky=W, padx=(0, 12), pady=1)

        genera_btns = tb.Frame(frame)
        genera_btns.pack(anchor=W, pady=(0, 4))
        tb.Button(genera_btns, text="Отметить все", width=16, bootstyle="secondary-outline",
                  command=lambda: self._set_all_genera(True)).pack(side=LEFT, padx=(0, 8))
        tb.Button(genera_btns, text="Снять все", width=16, bootstyle="secondary-outline",
                  command=lambda: self._set_all_genera(False)).pack(side=LEFT)
        tb.Label(genera_btns, text="«Снять все» = показать все роды",
                 foreground=COLOR_MUTED).pack(side=LEFT, padx=(12, 0))

        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=15)

        # ---- Поиск планет ----
        tb.Label(frame, text="Поиск планет в системе",
                 font=("Segoe UI", 10, "bold")).pack(anchor=W, pady=(0, 5))
        tb.Label(
            frame,
            text="Отмеченные наборы критериев применяются к отсканированным телам текущей "
                 "системы. Подходящие планеты попадают в раздел «Поиск планет» оверлея — "
                 "с типом, атмосферой, возможностью посадки и причиной, по которой планета "
                 "нашлась. Данные берутся из вашего журнала и кэша.",
            foreground=COLOR_MUTED, wraplength=700,
        ).pack(anchor=W, pady=(0, 6))

        self.exobio_show_planets_var = tk.BooleanVar(
            value=bool(settings.get("exobio_show_planet_search", True)))
        tb.Checkbutton(
            frame, text="Показывать раздел «Поиск планет» в оверлее",
            variable=self.exobio_show_planets_var,
            command=self._on_exobio_filters_changed,
        ).pack(anchor=W, pady=(0, 6))

        selected_ids = {str(i) for i in (settings.get("exobio_planet_search") or [])}
        self._exobio_planet_vars = {}
        for preset in PLANET_SEARCH_PRESETS:
            preset_id = str(preset.get("id"))
            var = tk.BooleanVar(value=preset_id in selected_ids)
            self._exobio_planet_vars[preset_id] = var
            tb.Checkbutton(
                frame, text=str(preset.get("label") or preset_id), variable=var,
                command=self._on_exobio_filters_changed,
            ).pack(anchor=W, pady=1)

        planet_btns = tb.Frame(frame)
        planet_btns.pack(anchor=W, pady=(8, 0))
        tb.Button(planet_btns, text="Снять все", width=16, bootstyle="secondary-outline",
                  command=self._clear_planet_filters).pack(side=LEFT)
        tb.Label(planet_btns, text="без отмеченных наборов раздел пишет, что критерии не выбраны",
                 foreground=COLOR_MUTED).pack(side=LEFT, padx=(12, 0))

        self._update_tab_exobio()

    def _set_all_genera(self, value: bool):
        for var in getattr(self, "_exobio_genus_vars", {}).values():
            var.set(bool(value))
        self._on_exobio_filters_changed()

    def _clear_planet_filters(self):
        for var in getattr(self, "_exobio_planet_vars", {}).values():
            var.set(False)
        self._on_exobio_filters_changed()

    def _on_exobio_filters_changed(self):
        """Сохранить фильтры и сразу перерисовать блок EXOBIO."""
        genera = [genus for genus, var in getattr(self, "_exobio_genus_vars", {}).items()
                  if var.get()]
        planet_ids = [preset_id for preset_id, var
                      in getattr(self, "_exobio_planet_vars", {}).items() if var.get()]
        show_planets = bool(getattr(self, "exobio_show_planets_var", tk.BooleanVar(value=True)).get())
        try:
            self.overlay_manager.set_exobio_filters(
                genera=genera, planet_search=planet_ids, show_planets=show_planets)
            self.overlay_manager.save_settings()
        except Exception as exc:  # настройки не должны ронять интерфейс
            self.log(f"Не удалось сохранить фильтры EXOBIO: {exc}", "error")
        self._update_tab_exobio()

    def _update_tab_exobio(self):
        """Обновить сводку и таблицу тел на вкладке «Экзобиология»."""
        if not hasattr(self, "exobio_tree") or not hasattr(self, "exobiology"):
            return
        tracker = self.exobiology
        system = str(tracker.current_system or "").strip() or "не определена"
        if hasattr(self, "exobio_system_label"):
            try:
                self.exobio_system_label.config(text=f"Текущая система: {system}")
            except Exception:
                pass

        scanned = tracker.system_scanned_count()
        known = tracker.system_known_body_count()
        bio_bodies = tracker.system_bio_bodies_count()
        bio_total = tracker.system_bio_signals_total()

        body_text = f"Тел отсканировано: {scanned}" + (f" из {known}" if known and known > scanned else "")
        if hasattr(self, "exobio_summary_label"):
            try:
                self.exobio_summary_label.config(
                    text=f"{body_text}  ·  Тел с биосигналами: {bio_bodies}  ·  Всего биосигналов: {bio_total}"
                )
            except Exception:
                pass

        try:
            for item in self.exobio_tree.get_children():
                self.exobio_tree.delete(item)
        except Exception:
            return

        if not tracker.current_system:
            return

        criteria, _ = self._exobiology_filters()
        prefix = f"{tracker.current_system}|"
        system_bodies = [b for k, b in tracker.bodies.items() if k.startswith(prefix)]
        system_bodies.sort(key=lambda b: (
            -int(b.get("bio_signals") or 0),
            not bool(b.get("landable")),
            float(b.get("distance_ls") or 0.0),
            str(b.get("name") or "")
        ))

        from exobiology import body_matches
        for b in system_bodies:
            name = str(b.get("name") or "")
            disp_name = name
            if system and name.startswith(system):
                disp_name = name[len(system):].strip() or name

            p_class = str(b.get("planet_class") or "—")
            atmo = str(b.get("atmosphere") or b.get("atmosphere_type") or "нет")
            landable_str = "Да" if b.get("landable") else "Нет"
            signals = int(b.get("bio_signals") or 0)
            sig_str = str(signals) if signals else "—"
            mapped_str = "Да" if b.get("mapped") else "—"

            matched_rules = []
            for rule in criteria:
                if body_matches(b, rule):
                    matched_rules.append(str(rule.get("label") or rule.get("id") or ""))

            matched_str = ", ".join(matched_rules[:2]) if matched_rules else "—"
            if len(matched_rules) > 2:
                matched_str += f" (+{len(matched_rules)-2})"

            try:
                self.exobio_tree.insert(
                    "", END, values=(disp_name, p_class, atmo, landable_str, sig_str, mapped_str, matched_str)
                )
            except Exception:
                pass

    def _start_exobio_history_indexer(self):
        """Фоновая постепенная индексация всех файлов журналов в дисковый кэш экзобиологии."""
        if not getattr(self, "journal_path", None):
            return

        def worker():
            from exobiology import scan_all_journals_for_exobio
            tracker = getattr(self, "exobiology", None)
            cache = getattr(self, "exobio_cache", None)
            if tracker is None or cache is None:
                return
            try:
                count = scan_all_journals_for_exobio(
                    self.journal_path,
                    handle_func=tracker.handle,
                    cache=cache,
                )
                if count > 0:
                    tracker.save_to_cache(cache)
                    if hasattr(self, "root") and self.root:
                        def on_indexed():
                            if hasattr(self, "overlay_manager") and self.overlay_manager:
                                self.overlay_manager.refresh_exobio()
                            self._update_tab_exobio()
                            self.log(f"Экзобиология: проиндексировано {count} событий из истории журналов", "info")
                        self.root.after(0, on_indexed)
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="exobio-history-indexer").start()

    def _ensure_system_exobio(self, system: str, force_scan: bool = False):
        """Гарантировать наличие данных обо всех телах системы из всех сессий (кэш + журналы)."""
        sys_name = str(system or "").strip()
        if not sys_name:
            return
        tracker = getattr(self, "exobiology", None)
        if tracker is None:
            return

        # 1. Всегда немедленно подтягиваем всё, что есть в дисковом кэше
        cache = getattr(self, "exobio_cache", None)
        if cache:
            cached = cache.get_system(sys_name)
            if cached and cached.get("bodies"):
                tracker.import_system_data(sys_name, cached)

        # 2. Проверяем, сканировали ли мы уже все журналы для этой системы в текущем запуске
        scanned_systems = getattr(self, "_exobio_history_scanned_systems", None)
        if scanned_systems is None:
            self._exobio_history_scanned_systems = set()
            scanned_systems = self._exobio_history_scanned_systems

        if (force_scan or sys_name not in scanned_systems) and getattr(self, "journal_path", None):
            scanned_systems.add(sys_name)
            self._scan_journals_for_current_system(force=True, target_system=sys_name)

    def _ensure_body_exobio(self, system: str, body_name: str):
        """Гарантировать, что приближаемое тело загружено со всеми сканами из прошлых сессий."""
        tracker = getattr(self, "exobiology", None)
        if tracker is None or not system or not body_name:
            return
        if tracker.current_system != system:
            tracker.current_system = system
        tracker.current_body = body_name
        key = tracker._key(system, body_name)
        body = tracker.bodies.get(key)
        # Если сведений о теле нет или нет класса/сигналов, подтягиваем из истории:
        if not body or not body.get("planet_class"):
            self._ensure_system_exobio(system)

    def _scan_journals_for_current_system(self, force: bool = False, target_system: str = ""):
        """Быстро найти сканы системы во ВСЕХ файлах журналов за все игровые сессии."""
        tracker = getattr(self, "exobiology", None)
        if tracker is None or not getattr(self, "journal_path", None):
            return
        system = str(target_system or tracker.current_system or "").strip()
        if not system:
            return

        now = time.time()
        last_scanned = getattr(self, "_last_exobio_scan_system", None)
        if not force and last_scanned == system and (now - getattr(self, "_last_exobio_scan_time", 0.0)) < 15.0:
            return
        self._last_exobio_scan_system = system
        self._last_exobio_scan_time = now

        def worker():
            from exobiology import scan_journals_for_system
            events = scan_journals_for_system(self.journal_path, system)
            if events:
                def on_done():
                    for ev in events:
                        try:
                            tracker.handle(ev)
                        except Exception:
                            pass
                    cache = getattr(self, "exobio_cache", None)
                    if cache:
                        sys_data = tracker.export_system_data(system)
                        cache.store_system(system, sys_data.get("bodies"), sys_data.get("organics"),
                                           sys_data.get("known_body_count", 0))
                    if hasattr(self, "overlay_manager") and self.overlay_manager:
                        self.overlay_manager.refresh_exobio()
                    self._update_tab_exobio()
                    self.log(f"Экзобиология: подтянуто {len(events)} событий из всех сессий для {system}", "info")
                if hasattr(self, "root") and self.root:
                    try:
                        self.root.after(0, on_done)
                    except Exception:
                        pass
                else:
                    on_done()

        threading.Thread(target=worker, daemon=True, name=f"exobio-sys-scan-{system[:10]}").start()

    def _scan_all_journals_for_exobio(self):
        """Полное сканирование всех журналов на события экзобиологии для наполнения кэша."""
        tracker = getattr(self, "exobiology", None)
        if tracker is None or not getattr(self, "journal_path", None):
            return
        if getattr(self, "_exobio_full_scanning", False):
            return
        self._exobio_full_scanning = True
        if hasattr(self, "exobio_status_label"):
            try:
                self.exobio_status_label.config(text="Сканирование журналов...", foreground=COLOR_ORANGE)
            except Exception:
                pass

        def worker():
            from exobiology import scan_all_journals_for_exobio

            def on_progress(cur, total):
                if hasattr(self, "root") and self.root:
                    try:
                        self.root.after(0, lambda c=cur, t=total: getattr(self, "exobio_status_label", None) and
                                        self.exobio_status_label.config(text=f"Сканирование: файл {c} из {t}..."))
                    except Exception:
                        pass

            cache = getattr(self, "exobio_cache", None)
            count = scan_all_journals_for_exobio(
                self.journal_path,
                handle_func=tracker.handle,
                on_progress=on_progress,
                cache=cache,
            )

            def on_finish():
                self._exobio_full_scanning = False
                if cache:
                    tracker.save_to_cache(cache)
                if hasattr(self, "exobio_status_label"):
                    try:
                        self.exobio_status_label.config(
                            text=f"Сканирование завершено: учтено {count} новых событий",
                            foreground=COLOR_GREEN
                        )
                    except Exception:
                        pass
                self.log(f"Полное сканирование экзобиологии: {count} событий обработано", "info")
                if hasattr(self, "overlay_manager") and self.overlay_manager:
                    self.overlay_manager.refresh_exobio()
                self._update_tab_exobio()

            if hasattr(self, "root") and self.root:
                try:
                    self.root.after(0, on_finish)
                except Exception:
                    pass
            else:
                on_finish()

        threading.Thread(target=worker, daemon=True, name="exobio-all-scan").start()

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
    #  Обновление программы
    # ============================================================
    def _update_channel_label(self) -> str:
        channel = str(self.config.get("update_channel", "stable"))
        return self.UPDATE_CHANNEL_LABELS.get(
            channel, self.UPDATE_CHANNEL_LABELS["stable"])

    def _update_channel_value(self) -> str:
        label = str(self.update_channel_var.get())
        for value, text in self.UPDATE_CHANNEL_LABELS.items():
            if text == label:
                return value
        return "stable"

    def _on_update_settings_changed(self):
        """Канал и автопроверку сохраняем сразу: это настройки, не состояние."""
        self.config["update_channel"] = self._update_channel_value()
        self.config["update_check_enabled"] = bool(self.update_auto_var.get())
        self.save_config()

    def _auto_check_update(self):
        if not bool(self.config.get("update_check_enabled", True)):
            return
        self._on_check_update(manual=False)

    def _set_update_ui(self, busy: bool, hint: str = "", button_text: str = ""):
        """Состояние строки обновлений: кнопка занята/свободна + подсказка."""
        try:
            self.update_button.config(
                state="disabled" if busy else "normal",
                text=button_text or "⟳  Обновить программу",
            )
        except Exception:
            pass
        if hint and hasattr(self, "update_hint"):
            try:
                self.update_hint.config(text=hint)
            except Exception:
                pass

    def _on_check_update(self, manual: bool = False):
        """Спросить GitHub Releases, есть ли сборка новее установленной.

        Сетевой запрос — только в фоновом потоке: интерфейс не должен ждать
        ответа GitHub, тем более при автопроверке на старте.
        """
        if self._update_busy:
            return
        self._update_busy = True
        channel = self._update_channel_value()
        self._set_update_ui(True, hint="проверка обновлений…", button_text="Проверяю…")
        self.log("Проверяю обновления…", "info")

        def worker():
            result = updater.check_for_update(VERSION, channel=channel)
            self.after(0, lambda r=result: self._on_update_checked(r, manual))

        threading.Thread(target=worker, daemon=True).start()

    def _on_update_checked(self, result: dict, manual: bool):
        self._update_busy = False
        latest = str(result.get("latest") or VERSION)
        if not result.get("ok"):
            message = str(result.get("error") or "нет данных")
            self._set_update_ui(False, hint=f"не проверено: {message[:40]}")
            # Автопроверка без сети — обычное дело, в лог пишем только по кнопке.
            if manual:
                self.log(f"Обновления не проверены: {message}", "warn")
            return

        if not result.get("update_available"):
            if result.get("channel_empty"):
                # В канале нет ни одного релиза. Это не «версия свежая», а
                # «смотреть нечего»: писать «актуальная версия» было бы ложью.
                self._set_update_ui(
                    False, hint="в этом канале сборок нет — смените канал")
                if manual:
                    self.log(
                        f"В канале «{self._update_channel_label()}» нет ни одной "
                        "сборки. Переключите канал на «Все сборки».", "warn")
                return
            self._set_update_ui(False, hint=f"актуальная версия v{latest}")
            self.log(f"Установлена актуальная версия {VERSION}", "success")
            return

        release = result.get("release") or {}
        self._set_update_ui(False, hint=f"доступна v{latest}")
        self.log(
            f"Доступна новая версия {latest} (установлена {VERSION}): "
            f"{release.get('name') or release.get('tag') or ''}", "warn")
        if not manual:
            # При автопроверке окно не выпрыгивает: пишем в лог и подсказку.
            self.log("Нажмите «Обновить программу», чтобы скачать сборку.", "info")
            return

        size_mb = int(release.get("asset_size") or 0) / (1024 * 1024)
        if not messagebox.askyesno(
            "Обновление Colonial Helper",
            f"Доступна версия {latest} (у вас {VERSION}).\n\n"
            f"Файл: {release.get('asset_name') or 'ColonialHelper.exe'}"
            f"{f' ({size_mb:.1f} МБ)' if size_mb else ''}\n\n"
            "Скачать новую сборку?",
            parent=self.root,
        ):
            return
        self._start_update_download(release)

    def _start_update_download(self, release: dict):
        """Скачать сборку в «Загрузки» и показать папку."""
        folder = updater.download_folder()
        self._update_busy = True
        self._set_update_ui(True, hint="скачивание…", button_text="Скачиваю…")

        def report(done: int, total: int):
            if not total:
                return
            # Не чаще раза в ~5%, иначе очередь Tk забьётся прогрессом.
            percent = int(done * 100 / total)
            if percent - getattr(self, "_update_last_percent", -10) < 5:
                return
            self._update_last_percent = percent
            self.after(0, lambda p=percent: self._set_update_ui(
                True, hint=f"скачивание {p}%", button_text="Скачиваю…"))

        def worker():
            result = updater.download_asset(release, folder, progress=report)
            self.after(0, lambda r=result: self._on_update_downloaded(r, release))

        threading.Thread(target=worker, daemon=True).start()

    def _on_update_downloaded(self, result: dict, release: dict):
        self._update_busy = False
        self._update_last_percent = -10
        if not result.get("ok"):
            message = str(result.get("error") or "неизвестная ошибка")
            self._set_update_ui(False, hint="скачивание не удалось")
            self.log(f"Не удалось скачать обновление: {message}", "error")
            return
        path = str(result.get("path") or "")
        size_mb = int(result.get("size") or 0) / (1024 * 1024)
        self._set_update_ui(False, hint=f"скачано: {Path(path).name}")
        self.log(f"Сборка {release.get('version_text') or ''} скачана: {path} "
                 f"({size_mb:.1f} МБ)", "success")
        self.log("Закройте программу и замените ColonialHelper.exe скачанным файлом.", "info")
        # Показываем папку со сборкой: запускать новый exe из-под старого
        # не нужно, а найти файл пользователь должен сразу.
        def open_folder():
            try:
                import os
                import webbrowser

                if hasattr(os, "startfile"):
                    os.startfile(str(Path(path).parent))  # noqa: S606 - своя папка
                else:
                    webbrowser.open(Path(path).parent.as_uri())
            except Exception as exc:
                self.after(0, lambda e=exc: self.log(
                    f"Не удалось открыть папку со сборкой: {e}", "warn"))

        threading.Thread(target=open_folder, daemon=True).start()

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
            # Груз авианосца по товарам журнал не отдаёт: снимок из Raven
            # Colonial перечитывается по таймеру, иначе «на борту» устаревает,
            # пока груз возят другие командиры.
            self._refresh_carrier_cargo(int(self.carrier.state.market_id or 0))
            # То же для стройплощадки: остаток потребности там общий на всех
            # командиров, и груз, сданный другими, должен уменьшать «осталось
            # завезти» и у нас.
            self._refresh_site_project()
            # Основной проект колонизатора раньше перечитывался только в момент
            # назначения: блок CARRIER показывал потребность навеки замершей.
            self._refresh_primary_project()
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
        """Проверить ключ RCC и подставить имя командира.

        `GET /api/cmdr/` с заголовком `rcc-key` возвращает профиль владельца
        ключа (в том числе `displayName`) — это единственный способ узнать
        имя пилота, имея только ключ. Раньше ключ проверялся запросом к
        корневому `/api` с запасным вариантом `/api/system/0/0`, и имя
        приходилось вводить руками.
        """
        result = self.raven_api.get_cmdr_by_key(key)
        if result.get("ok"):
            cmdr = self.raven_api.cmdr_display_name(result)
            self.root.after(0, lambda: self.raven_status_label.config(
                text="Raven Colonial: подключено", foreground="#3fb950"))
            self.root.after(0, lambda: self.log("Raven Colonial: ключ действителен", "success"))
            if cmdr:
                self.root.after(0, lambda name=cmdr: self._apply_rcc_commander(name))
            # До появления ключа доставки копились в очереди досылки
            # (`_flush_raven_deliveries` без ключа ничего не отправляет).
            # Ключ есть — досылаем их сразу, а не ждём следующего тика.
            self.root.after(0, lambda: self._flush_raven_deliveries(
                cmdr or self._current_cmdr_name(), force=True))
            return

        status = int(result.get("status") or 0)
        error = str(result.get("error") or "неизвестная ошибка")
        if status == 401:
            text, log_text = "Raven Colonial: ключ неверный", "Raven Colonial: ключ неверный (401)"
            level = "error"
        elif status == 0:
            text, log_text = "Raven Colonial: сетевая ошибка", f"Raven Colonial: {error}"
            level = "error"
        else:
            text, log_text = f"Raven Colonial: ошибка {status}", f"Raven Colonial: {error}"
            level = "error"
        self.root.after(0, lambda t=text: self.raven_status_label.config(
            text=t, foreground="#f85149"))
        self.root.after(0, lambda m=log_text, lv=level: self.log(m, lv))

    def _apply_rcc_commander(self, name: str):
        """Подставить имя пилота, которое Raven Colonial отдал по ключу RCC.

        Имя из ключа — авторитетное: именно под ним сервис знает командира,
        поэтому поле «Командир» во вкладке «Колонизатор» перезаписывается.
        """
        name = str(name or "").strip()
        if not name:
            return
        self.config["cmdr_name"] = name
        self.save_config()
        if hasattr(self, "colony_cmdr_var"):
            self.colony_cmdr_var.set(name)
        if hasattr(self, "colony_key_label"):
            self.colony_key_label.config(
                text=f"RCC ключ задан · {name}", foreground=COLOR_GREEN)
        self.log(f"Raven Colonial: командир по ключу RCC — {name}", "success")
        # Список проектов сразу не обновляем: пользователь может нажать
        # «Обновить список» сам, а лишний запрос на каждое сохранение не нужен.

    def _on_browse_journal_path(self):
        path = filedialog.askdirectory(initialdir=str(self.journal_path))
        if path:
            self.journal_path = Path(path)
            self.path_entry.delete(0, END)
            self.path_entry.insert(0, str(self.journal_path))
            self.save_config()

    def _exobiology_overlay_state(self):
        """Состояние экзобиологии для оверлея: тело + карта тел системы.

        Отдельным методом, чтобы не дёргать трекер дважды и не тащить в оверлей
        весь список тел, когда блок выключен.
        """
        tracker = getattr(self, "exobiology", None)
        if tracker is None:
            return None

        # Обязательно подтягиваем исторические данные системы из кэша и всех прошлых сессий
        if tracker.current_system:
            self._ensure_system_exobio(tracker.current_system)

        state = tracker.current_body_state()
        try:
            bodies = tracker.system_bodies(limit=10)
        except Exception:
            bodies = []
        criteria, genera = self._exobiology_filters()
        planets = []
        if criteria:
            try:
                planets = tracker.search_system_planets(criteria)
            except Exception:
                planets = []
        # Выбранные фильтры обязаны дойти до блока даже при пустом трекере:
        # иначе оверлей рисует «критерии не выбраны» и выглядит сломанным.
        if state is None and not bodies and not planets and not criteria and not genera:
            return None
        state = dict(state or {})
        state["system_bodies"] = bodies
        state["system"] = state.get("system") or tracker.current_system
        try:
            state["system_scanned_bodies"] = tracker.system_scanned_count()
            state["system_known_bodies"] = tracker.system_known_body_count() or tracker.system_body_count()
        except Exception:
            state["system_scanned_bodies"] = 0
            state["system_known_bodies"] = 0
        # Фильтры и результат поиска планет (вкладка «Экзобиология»).
        state["genera_filter"] = genera
        state["planet_criteria"] = criteria
        state["planets"] = planets
        return state

    def _wire_exobio_state_provider(self):
        """Дать оверлею способ перерисовать EXOBIO после смены фильтров."""
        manager = getattr(self, "overlay_manager", None)
        if manager is None:
            return
        try:
            manager.set_exobio_state_provider(self._exobiology_overlay_state)
        except Exception:
            pass

    def _exobiology_filters(self):
        """Выбранные фильтры EXOBIO: (наборы критериев поиска, роды).

        Настройки читаем каждый раз, а не кэшируем: вкладка «Экзобиология»
        меняет их на лету, и блок должен обновиться без перезапуска оверлея.
        """
        settings = getattr(getattr(self, "overlay_manager", None), "settings", {}) or {}
        genera = [str(item) for item in (settings.get("exobio_genera") or []) if str(item).strip()]
        wanted_ids = {str(item) for item in (settings.get("exobio_planet_search") or [])}
        criteria = []
        if wanted_ids and bool(settings.get("exobio_show_planet_search", True)):
            criteria = [dict(row) for row in PLANET_SEARCH_PRESETS
                        if str(row.get("id")) in wanted_ids]
        return criteria, genera

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
        # Стройплощадки — тоже: они нужны вкладке «Колонизатор», а события
        # ColonisationConstructionDepot и так проходят через этот разбор.
        def construction_hook(line, ev):
            self._feed_construction_site(ev, live=False)

        # Карта системы наполняется тем же проходом: после импорта истории
        # вкладка показывает текущую систему сразу, не дожидаясь новых событий.
        def map_hook(line, ev):
            self._feed_system_map(ev, live=False)

        hooks = [collector, dispatch_hook, self.exobiology.handle, construction_hook,
                 map_hook]

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
            # Ручной импорт — это история, а не live-события. Raven Colonial
            # на `contribute` СУММИРУЕТ тонны, поэтому прогон одних и тех же
            # файлов ещё раз завысил бы вклад командира в общий проект.
            # Отправляем только если пользователь явно включил отправку
            # истории во внешние API (о чём вкладка и предупреждает).
            if self.dispatcher.backfill_enabled:
                self._send_deliveries_to_raven(all_deliveries, cmdr_name or "")
            elif all_deliveries and self.raven_api.is_connected:
                tons = sum(int(d.get("amount", 0) or 0) for d in all_deliveries)
                self.root.after(
                    0,
                    lambda n=len(all_deliveries), t=tons: self.log(
                        f"Raven Colonial: {n} доставок из импортированных файлов ({t} t) "
                        "не отправлены — это история, а не live-события. Живой watcher "
                        "отправляет доставки сам; дослать конкретную стройплощадку можно "
                        "кнопкой «Сверить стройплощадку с Raven» на вкладке «Колонизатор».",
                        "info"),
                )
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
        self._session_tons_by_system.clear()
        self._last_cargo = {}
        self._last_depot_state = {}
        self._last_contribution_state = {}
        self._seen_events = set()
        # Сессия новая — площадки и уведомления о них тоже с нуля.
        self.construction.reset()
        self._colony_announced_sites.clear()
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

        # Авианосец и стройплощадка — тоже из журнала. Без этого программа,
        # запущенная, когда командир УЖЕ стоит у площадки или на борту FC,
        # не знала ни market_id площадки, ни market_id авианосца: Raven не
        # опрашивался, «осталось завезти» не считалось, а доставки, которые
        # не успели уйти в прерванной сессии, не досылались.
        self.carrier.reset()
        self._restore_station_state_from_journal()

        self.watcher_btn.config(text="⏹ Остановить", bootstyle="danger-outline")
        self.log("Watcher запущен. Мониторинг журналов...", "success")
        self.bottom_status.config(text="Watcher: активен")
        self.overlay_manager.log("Watcher запущен", "success")

        self.watcher_thread = threading.Thread(target=self._watcher_loop, daemon=True)
        self.watcher_thread.start()
        self._start_exobio_history_indexer()

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

    #: Сколько последних журналов и байт читаем, восстанавливая место стоянки.
    RESTORE_STATE_MAX_FILES = 3
    RESTORE_STATE_MAX_BYTES = 6 * 1024 * 1024
    #: События, из которых восстанавливается «где мы сейчас стоим».
    RESTORE_STATE_EVENTS = frozenset({
        "Location", "Docked", "Undocked", "CarrierJump", "CarrierStats",
        "ColonisationConstructionDepot", "Market", "SupercruiseExit",
        "Touchdown", "Liftoff",
    })
    #: Для карты системы нужны ещё и сканы тел: без них до полного разбора
    #: журнала карта знала бы только станцию, у которой стоит пилот.
    RESTORE_MAP_EVENTS = RESTORE_STATE_EVENTS | frozenset({
        "Scan", "SAAScanComplete", "FSSDiscoveryScan", "FSSSignalDiscovered",
        "FSDJump", "ApproachBody", "LeaveBody", "LoadGame", "NavBeaconScan",
        "Touchdown", "Liftoff",
    })
    #: Трекеру экзобиологии дополнительно нужны биосигналы и образцы: без них
    #: блок EXOBIO после перезапуска «не видел» отсканированную систему.
    RESTORE_EXOBIO_EVENTS = frozenset({
        "FSSBodySignals", "SAASignalsFound", "ScanOrganic", "CodexEntry",
        "Touchdown", "Liftoff", "SupercruiseExit",
    })
    RESTORE_TRACK_EVENTS = RESTORE_MAP_EVENTS | RESTORE_EXOBIO_EVENTS

    def _restore_station_state_from_journal(self) -> dict:
        """Восстановить стройплощадку и авианосец по хвосту журнала.

        Зачем: `construction.site` и `carrier.state.market_id` наполняются
        событиями журнала. Если программу запустили (или перезапустили после
        сбоя/закрытия игры), когда командир уже стоит у стройплощадки или на
        борту своего авианосца, новых событий `Docked`/`CarrierStats` не
        будет, и приложение не знает ни `MarketID` площадки, ни `MarketID`
        авианосца. Следствия ровно те, на которые жаловался пользователь:

        * Raven Colonial не опрашивается → «осталось завезти» не считается
          и чужие доставки не учитываются;
        * поимённый груз авианосца не подтягивается → блок CARRIER пустой;
        * прерванная сессия не досылается.

        Читаем хвост последних журналов (не больше `RESTORE_STATE_MAX_FILES`
        файлов и `RESTORE_STATE_MAX_BYTES` байт) и прогоняем только нужные
        события через те же трекеры, что и живой watcher.
        """
        restored = {"site": False, "carrier": False}
        map_events: list = []
        try:
            files = sorted(
                self.journal_path.glob("Journal.*.log"),
                key=lambda f: f.stat().st_mtime,
                reverse=True,
            )[: self.RESTORE_STATE_MAX_FILES]
        except OSError:
            return restored
        if not files:
            return restored

        for path in files:
            try:
                size = path.stat().st_size
                with open(path, "rb") as fh:
                    if size > self.RESTORE_STATE_MAX_BYTES:
                        fh.seek(size - self.RESTORE_STATE_MAX_BYTES)
                        fh.readline()  # отбрасываем неполную строку
                    raw = fh.read()
            except OSError:
                continue

            events = []
            for _line, event in iter_journal_events(raw.decode("utf-8", errors="replace")):
                if event.get("event") in self.RESTORE_TRACK_EVENTS:
                    events.append(event)
            if not events:
                continue
            # Хронологический порядок важен: трекеры «отпускают» площадку по
            # Undocked и чужой авианосец по Docked к другой станции.
            for event in events:
                map_events.append(event)
                if event.get("event") not in self.RESTORE_STATE_EVENTS:
                    continue
                try:
                    self.construction.handle("", event)
                    self.carrier.handle(event)
                except Exception:
                    continue

            site = self.construction.site
            if site is not None and site.market_id and site.docked:
                restored["site"] = True
            if int(self.carrier.state.market_id or 0) and self.carrier.state.at_carrier:
                restored["carrier"] = True
            # Не прерываем сбор событий карты и экзобиологии: даже если пилот уже
            # пристыкован, сканы тел системы могли быть сделаны в предыдущих файлах.

        # Карта системы собирается хронологически: файлы идут от новых к
        # старым, а положение пилота определяет последнее событие, а не первое
        # попавшееся. Поэтому сортируем всё собранное и прогоняем одним списком.
        map_events.sort(key=lambda item: str(item.get("timestamp") or ""))
        for event in map_events:
            try:
                self.system_map.handle(event)
            except Exception:
                continue
        # Тот же хронологический хвост кормит трекер экзобиологии: блок EXOBIO
        # должен знать тела, отсканированные до запуска программы, — иначе
        # «Поиск планет» с вкладки «Экзобиология» выглядит сломанным. Повторный
        # учёт образцов исключает дедупликация событий по timestamp в трекере.
        tracker = getattr(self, "exobiology", None)
        if tracker is not None:
            for event in map_events:
                try:
                    tracker.handle(event)
                except Exception:
                    continue
            cache = getattr(self, "exobio_cache", None)
            if cache and tracker.current_system:
                sys_data = tracker.export_system_data(tracker.current_system)
                cache.store_system(tracker.current_system, sys_data.get("bodies"),
                                   sys_data.get("organics"), sys_data.get("known_body_count", 0))
        if self.system_map.current_system:
            self._map_schedule_redraw(delay_ms=0)

        notes = []
        site = self.construction.site
        if site is not None and site.market_id:
            notes.append(f"стройплощадка {site.market_id} ({site.system_name or 'система не известна'})")
        market_id = int(self.carrier.state.market_id or 0)
        if market_id:
            notes.append(f"авианосец {market_id}")
        if notes:
            self.log("Восстановлено из журнала: " + ", ".join(notes), "info")
            # Оба состояния теперь известны — сразу спрашиваем Raven Colonial,
            # сколько осталось завезти и что лежит на борту (включая груз,
            # который завезли другие командиры).
            self._refresh_site_project(force=True)
            self._refresh_carrier_cargo(market_id, force=True)
        return restored

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
                self._maybe_log_modules(len(st.modules), damaged, st.power_capacity)
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
            # Тот же метод зовётся каждые 5 секунд: без сравнения подписи
            # «Загружено состояние: Status, ModulesInfo, Cargo» писалось в лог
            # на каждом тике, хотя набор файлов не менялся.
            files_sig = tuple(loaded)
            if files_sig != self._state_files_log_sig:
                self._state_files_log_sig = files_sig
                self.root.after(
                    0, lambda: self.log(f"Загружено состояние: {', '.join(loaded)}", "info"))

    def _maybe_log_modules(self, count: int, damaged: int, capacity: float):
        """Строка про модули — только когда в корабле реально что-то изменилось.

        `_load_current_state_files()` зовётся из цикла watcher'а каждые пять
        секунд, и это была главная жалоба на лог: «постоянно пишет информацию
        о корабле, сколько модулей и т.д.».

        Подпись 2.9.0 включала текущее энергопотребление `power_used`, а оно
        меняется в полёте постоянно (вкл/выкл модулей, посадочные опоры,
        грузовой захват, выход из суперкруиза) — строка и печаталась снова и
        снова. Теперь в подписи только то, что действительно стоит сообщать:
        состав корабля (тип, имя, число модулей), число повреждённых и
        мощность реактора. Текущее потребление остаётся в тексте строки,
        в блоке SHIP оверлея и в инфографике пилота.

        Отдельно глушатся «качели»: устаревший ModulesInfo.json и события
        журнала (Repair/ModuleDamage) могут по очереди возвращать состояние
        туда-сюда. Возврат к уже сообщённой подписи не новость — его не пишем.
        """
        st = self.ship.state
        if st is None:
            return
        signature = (count, damaged, round(float(capacity or 0.0), 2),
                     str(getattr(st, "ship_type", "") or ""),
                     str(getattr(st, "ship_name", "") or ""))
        previous = self._modules_log_sig
        if signature == previous:
            return
        if signature == self._modules_log_prev_sig:
            # Состояние вернулось к тому, о котором уже сообщали (A -> B -> A).
            self._modules_log_sig = signature
            self._modules_log_prev_sig = previous
            return
        self._modules_log_prev_sig = previous
        self._modules_log_sig = signature
        self.root.after(
            0,
            lambda c=count, d=damaged: self.log(
                f"Модули: {c} шт., повреждено: {d}, "
                f"энергия: {st.power_used:.2f}/{st.power_capacity:.2f} MW",
                "info",
            ),
        )

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

    def _flush_deferred_uploads(self, full_history: bool = False):
        """Отправить на сайт всё, накопленное за время первичной сверки.

        Один пакет вместо сотни мелких запросов (по одному на файл), что на
        истории из 800 файлов экономило десятки минут: доставки уходят
        параллельными пачками по 100, snapshots — по 100 (лимит сервера).

        `full_history=True` — сверка читала журналы с самого начала (файл
        смещений пуст, то есть это первый запуск программы). В этом случае
        доставки в Raven Colonial уходят только если пользователь включил
        отправку истории: `contribute` суммирует тонны, и повторный прогон
        всей истории завысил бы вклад командира в общий проект.
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
            else:
                # Не теряем распарсенные доставки: сервер дедуплицирует по
                # source_hash, поэтому повторная попытка безопасна.
                self._pending_watcher_deliveries = deliveries + self._pending_watcher_deliveries
                log(f"Первичная загрузка: доставки не отправлены — {result.get('error', 'ошибка')}", "error")

        # Raven Colonial — отдельно от сайта и от его ответа: сбой ED Ring
        # Colony не должен уносить тонны стройплощадки (и наоборот).
        if deliveries:
            if full_history and not self.dispatcher.backfill_enabled:
                tons = sum(int(d.get("amount", 0) or 0) for d in deliveries)
                log(f"Raven Colonial: {len(deliveries)} доставок истории ({tons} t) НЕ отправлены — "
                    "первичная сверка читала журналы с начала, а contribute суммирует тонны. "
                    "Отправку истории можно включить галочкой «Отправлять историю в EDSM / Inara / "
                    "Raven Colonial» на вкладке «Загрузка логов».", "info")
            else:
                self._send_deliveries_to_raven(deliveries, cmdr_name)

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
                # full_history: смещений не было, читали журналы с самого
                # начала — это вся история, а не «недосланное за сессию».
                self._flush_deferred_uploads(full_history=first_reconciliation)
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
        for delivery in deliveries:
            system = delivery.get("system_name") or "—"
            self._session_tons_by_system[system] = (
                self._session_tons_by_system.get(system, 0.0)
                + float(delivery.get("amount", 0) or 0)
            )
        self._last_delivery_system = deliveries[-1].get("system_name", self._last_delivery_system)

    #: Источники доставок, которые в принципе не являются вкладом в проект.
    #: `carrier_delivery` — продажа своему авианосцу (уходит в
    #: PATCH /api/fc/{id}/cargo), `cargo_delta`/`cargo_depot` — изменение трюма
    #: и миссии: MarketID у них нет, а вклад в стройку игра пишет отдельным
    #: событием `ColonisationContribution`. Они не «отказы», поэтому в отчёт
    #: о пропущенных доставках не попадают (иначе лог забивался бы строками
    #: «в событии нет MarketID» на каждую разгрузку трюма).
    RAVEN_NON_PROJECT_SOURCES = frozenset({
        "carrier_delivery", "cargo_delta", "cargo_depot",
    })

    #: Сколько неудачных отправок подряд держим в очереди, прежде чем
    #: увеличить паузу между попытками (30 с -> 60 с -> 120 с, максимум 300 с).
    RAVEN_RETRY_BACKOFF = (30.0, 60.0, 120.0, 300.0)
    #: Очередь досылки не должна расти бесконечно: при долгом отсутствии сети
    #: важнее не уронить приложение, чем дослать deliveries месячной давности.
    RAVEN_PENDING_LIMIT = 500
    #: Недоставленная строка (проекта ещё нет, сеть лежит) не должна каждый тик
    #: вотчера порождать одно и то же сообщение: пока состав очереди не
    #: изменился, повторная попытка делается не чаще раза в минуту, а после
    #: RAVEN_MAX_ATTEMPTS попыток строка снимается с досылки (об этом пишется
    #: один раз — держать её в очереди вечно смысла нет).
    RAVEN_IDLE_RETRY_SECONDS = 60.0
    RAVEN_MAX_ATTEMPTS = 30
    #: То же для очереди аплоада на ED Ring Colony.
    WATCHER_PENDING_LIMIT = 500

    def _send_deliveries_to_raven(self, deliveries: list, cmdr_name: str = "",
                                  force: bool = False):
        """Поставить доставки в очередь Raven Colonial и сразу её дослать.

        Публичная точка входа для всех путей (живой тик watcher'а, первичная сверка,
        ручной импорт): метод сам решает, что уже отправлено (журнал
        `source_hash`), что можно отправить сейчас, а что оставить в очереди.

        Отправка в Raven НЕ зависит от результата аплоада на ED Ring Colony:
        это два разных сервера, и раньше сбой одного молча уносил данные для
        другого (и наоборот — успех одного заставлял слать доставку повторно).
        """
        self._queue_raven_deliveries(deliveries)
        return self._flush_raven_deliveries(cmdr_name, force=force)

    def _queue_raven_deliveries(self, deliveries: list) -> int:
        """Добавить доставки в очередь Raven Colonial. Возвращает сколько добавлено."""
        added = 0
        for delivery in deliveries or []:
            if not isinstance(delivery, dict):
                continue
            key = self._raven_delivery_key(delivery)
            if not key or key in self._raven_sent:
                # Уже зачтено Raven Colonial — повтор завысил бы тоннаж проекта.
                continue
            if any(self._raven_delivery_key(item) == key
                   for item in self._pending_raven_deliveries):
                continue
            self._pending_raven_deliveries.append(dict(delivery))
            added += 1
        if len(self._pending_raven_deliveries) > self.RAVEN_PENDING_LIMIT:
            dropped = len(self._pending_raven_deliveries) - self.RAVEN_PENDING_LIMIT
            self._pending_raven_deliveries = self._pending_raven_deliveries[-self.RAVEN_PENDING_LIMIT:]
            self.root.after(
                0,
                lambda n=dropped: self.log(
                    f"Raven Colonial: очередь досылки переполнена, отброшено {n} старых доставок",
                    "warn"),
            )
        return added

    @staticmethod
    def _raven_delivery_key(delivery: dict) -> str:
        """Ключ доставки для журнала отправленного.

        `source_hash` есть у всего, что пришло из журнала. Для доставок без
        него (старые записи, ручные вызовы) собираем ключ из тех же полей,
        которые определяют уникальность: площадка, товар, тонны, время.
        """
        raw = str(delivery.get("source_hash") or "").strip()
        if raw:
            return raw
        return "|".join(str(delivery.get(field, "") or "") for field in (
            "source", "market_id", "system_address", "commodity",
            "amount", "delivered_at",
        ))

    @staticmethod
    def _raven_commodity(name: str) -> str:
        """Имя товара в том виде, в каком его ждёт Raven Colonial.

        `normalize_commodity` делает каноническое имя из FDName-токена
        (`$liquidoxygen_name;` -> `liquidoxygen`). Но если токена в событии не
        оказалось и взято локализованное имя («Liquid oxygen»), нормализация
        даёт имя с пробелом — такое Raven с ресурсом проекта не сопоставит, и
        тонны молча не зачтутся. Документация API: «Commodity names are always
        lower case and language agnostic», то есть без пробелов.
        """
        return canonical_commodity(name or "")

    #: Как часто переспрашиваем Raven о проекте, который не нашёлся ни по
    #: market_id, ни по системе. Первые несколько попыток идут в обычном темпе
    #: (проект могли создать только что), дальше — редко: проект не появляется
    #: за минуту, а долбить сервис и лог каждые пять секунд смысла нет.
    RAVEN_SITE_MISS_FAST_TRIES = 3
    RAVEN_SITE_MISS_RETRY_SECONDS = 300.0

    def _raven_site_binding(self, market_id) -> dict:
        """Ручная привязка стройплощадки к проекту Raven Colonial.

        Нужна, когда автоматически площадку с проектом сопоставить нельзя:
        проект создавали через сайт (и `marketId` там другой) или в системе
        несколько активных проектов. Тогда пользователь сам указывает, какому
        проекту зачислять тонны.
        """
        try:
            key = str(int(market_id or 0))
        except (TypeError, ValueError):
            return {}
        if key in ("", "0"):
            return {}
        bindings = self.config.get("raven_site_bindings") or {}
        if not isinstance(bindings, dict):
            return {}
        record = bindings.get(key)
        if isinstance(record, dict) and str(record.get("build_id") or "").strip():
            return record
        if isinstance(record, str) and record.strip():
            return {"build_id": record.strip()}
        return {}

    def _resolve_site_project(self, address: int, market_id: int):
        """Какой проект Raven считать этой стройплощадкой: `(project, note)`.

        Порядок: ручная привязка (buildId известен точно) -> поиск по
        (systemAddress, marketId) -> поиск по системе (внутри
        `RavenColonialAPI.get_project`). Если проект не определён, возвращает
        `(None, причина)` — вызывающий код пишет причину в лог и оставляет
        доставки в очереди, а не выбрасывает их.
        """
        binding = self._raven_site_binding(market_id)
        if binding:
            build_id = str(binding.get("build_id") or "").strip()
            cached = self._raven_bound_projects.get(build_id)
            if isinstance(cached, dict) and cached.get("buildId"):
                return cached, "привязка площадки"
            resolve = getattr(self.raven_api, "resolve_project_by_id", None)
            if build_id and callable(resolve):
                try:
                    project = resolve(build_id)
                except Exception:
                    project = None
                if isinstance(project, dict) and project.get("buildId"):
                    # Карточка привязанного проекта нужна только чтобы показать
                    # название и остаток потребности: держим её в памяти, а не
                    # спрашиваем на каждую отправку.
                    self._raven_bound_projects[build_id] = project
                    return project, "привязка площадки"
            if build_id:
                # Карточку Raven сейчас не отдал (сеть/таймаут), но buildId
                # известен точно: тонны важнее названия проекта.
                minimal = {"buildId": build_id,
                           "buildName": str(binding.get("name") or "")}
                return minimal, "привязка площадки"
        try:
            project = self.raven_api.get_project(int(address or 0), int(market_id or 0))
        except Exception as exc:
            return None, f"Raven Colonial не ответил ({exc})"
        if isinstance(project, dict) and project.get("buildId"):
            # `last_lookup_source` показывает, как именно найден проект:
            # "market" (точная пара), "system" (единственный активный проект
            # системы), "system+market". Пользователю это важно: тонны ушли в
            # проект, который найден не по market_id площадки.
            return project, str(getattr(self.raven_api, "last_lookup_source", "") or "market")
        return None, str(getattr(self.raven_api, "last_lookup_error", "") or "")

    def _site_on_pause(self, site_key, now: float) -> bool:
        """Проект площадки не находится уже давно — пора перестать спрашивать."""
        record = self._raven_site_miss.get(site_key)
        if not record:
            return False
        attempts, last = record
        if int(attempts) < self.RAVEN_SITE_MISS_FAST_TRIES:
            return False
        return (now - float(last)) < self.RAVEN_SITE_MISS_RETRY_SECONDS

    def _note_site_miss(self, site_key, now: float) -> None:
        attempts, _last = self._raven_site_miss.get(site_key, (0, 0.0))
        self._raven_site_miss[site_key] = (int(attempts) + 1, now)

    def _clear_site_miss(self, site_key) -> None:
        """Проект нашёлся: счётчик промахов и «объяснение» больше не нужны."""
        if self._raven_site_miss.pop(site_key, None) is not None:
            self._raven_site_warned.discard(site_key)

    def _warn_site_unresolved(self, market_id, reason: str) -> None:
        """Один раз объяснить, почему тонны не уходят и что сделать.

        Без этой строки «проект не найден» повторялся бы в сводке каждую
        минуту, не говоря пользователю, что проект надо создать (или привязать
        площадку к существующему) — иначе тонны не зачтутся никогда.
        """
        try:
            wanted = int(market_id or 0)
        except (TypeError, ValueError):
            wanted = 0
        waiting = sum(
            int(item.get("amount", 0) or 0)
            for item in self._pending_raven_deliveries
            if int(item.get("market_id", 0) or 0) == wanted
        )
        self.root.after(
            0,
            lambda m=wanted, r=reason, t=waiting: self.log(
                f"Raven Colonial: проект стройплощадки {m} не найден ({r}). "
                f"{t} t ждут отправки. Создайте проект на вкладке «Колонизатор» "
                "или привяжите площадку к существующему проекту — иначе тонны "
                "не зачтутся.", "warn"),
        )

    #: Как часто можно спросить Raven Colonial об имени командира по ключу.
    RAVEN_CMDR_RETRY_SECONDS = 60.0

    def _raven_cmdr_name(self) -> str:
        """Имя командира для `POST /project/{buildId}/contribute/{cmdr}`.

        Raven зачисляет тонны тому командиру, чьё имя стоит в пути запроса, а
        без имени пишет их на «Unknown» — вклад в проект теряется. Обычно имя
        есть (токен сайта, `Commander` из журнала), но если программа запущена
        до `LoadGame`, его может не быть: тогда спрашиваем у самого Raven по
        ключу RCC (`GET /api/cmdr/` возвращает `displayName` — ровно то имя,
        под которым командир известен сервису).

        Запрос делается не чаще раза в минуту и только пока имя не найдено:
        метод зовётся из потока watcher'а, блокировать его надолго нельзя.
        """
        name = (self._current_cmdr_name() or "").strip()
        if name:
            self._raven_cmdr_cache = name
            return name
        cached = str(getattr(self, "_raven_cmdr_cache", "") or "").strip()
        if cached:
            return cached
        now = time.monotonic()
        if now - float(getattr(self, "_raven_cmdr_asked_at", 0.0) or 0.0) < self.RAVEN_CMDR_RETRY_SECONDS:
            return ""
        if not self.raven_api.is_connected:
            return ""
        self._raven_cmdr_asked_at = now
        try:
            result = self.raven_api.get_cmdr_by_key()
            resolved = self.raven_api.cmdr_display_name(result)
        except Exception:
            resolved = ""
        if resolved:
            self._raven_cmdr_cache = resolved
        return str(resolved or "")

    def _flush_raven_deliveries(self, cmdr_name: str = "", force: bool = False) -> dict:
        """Отправить очередь в Raven Colonial. Возвращает сводку попытки.

        Под блокировкой: очередь досылают и поток watcher'а, и UI (после
        проверки ключа, привязки площадки, сверки). Без блокировки два потока
        успевали отправить одну и ту же доставку до того, как она попадёт в
        журнал отправленного, — тонны проекту зачитывались дважды.
        """
        summary = {"sent": 0, "tons": 0, "skipped": 0, "pending": 0, "reasons": {}}
        with self._raven_lock:
            return self._flush_raven_deliveries_locked(cmdr_name, force, summary)

    def _flush_raven_deliveries_locked(self, cmdr_name: str, force: bool, summary: dict) -> dict:
        queue = [item for item in self._pending_raven_deliveries]
        if not queue:
            return summary

        if not self.raven_api.is_connected:
            # Без ключа RCC отправить нельзя, но и терять доставки нельзя:
            # очередь останется и уйдёт, как только ключ появится.
            if not self._raven_no_key_warned:
                self._raven_no_key_warned = True
                self.root.after(
                    0,
                    lambda n=len(queue): self.log(
                        f"Raven Colonial: ключ RCC не задан — {n} доставок на стройплощадку "
                        "ждут отправки (вкладка «Колонизатор»)", "warn"),
                )
            summary["pending"] = len(queue)
            return summary

        now = time.monotonic()
        # Одна и та же недоставленная строка не должна дёргать Raven и лог
        # каждые пять секунд: если состав очереди не изменился, повторяем
        # попытку не чаще RAVEN_IDLE_RETRY_SECONDS.
        queue_sig = "|".join(sorted(self._raven_delivery_key(item) for item in queue))
        if (not force and queue_sig == self._raven_queue_sig
                and now - self._raven_last_attempt < self.RAVEN_IDLE_RETRY_SECONDS):
            summary["pending"] = len(queue)
            return summary
        self._raven_queue_sig = queue_sig

        if not force and self._raven_fail_streak:
            pause = self.RAVEN_RETRY_BACKOFF[
                min(self._raven_fail_streak - 1, len(self.RAVEN_RETRY_BACKOFF) - 1)]
            if now - self._raven_last_attempt < pause:
                summary["pending"] = len(queue)
                return summary
        self._raven_last_attempt = now

        # Имя командира: Raven зачисляет тонны на командира из пути запроса,
        # а без имени пишет их на «Unknown».
        cmdr = (cmdr_name or self._raven_cmdr_name() or "").strip()

        batches: dict = {}
        batch_keys: dict = {}
        skipped: dict = {}
        forgotten: set = set()
        site_projects: dict = {}   # (address, market_id) -> (project, note)
        resolved_notes: dict = {}  # build_id -> как нашли проект

        def _skip(reason: str):
            skipped[reason] = skipped.get(reason, 0) + 1

        def _forget(delivery):
            """Убрать доставку из очереди (по идентичности, не по равенству)."""
            forgotten.add(id(delivery))
            self._raven_attempts.pop(self._raven_delivery_key(delivery), None)

        def _retry_later(reason: str, delivery):
            """Строку ещё можно отправить позже: считаем попытки и сдаёмся.

            Без счётчика «проект не найден» означал бы вечную очередь и вечное
            сообщение в логе: через RAVEN_MAX_ATTEMPTS попыток строка снимается
            с досылки, а причина пишется один раз.
            """
            key = self._raven_delivery_key(delivery)
            attempts = int(self._raven_attempts.get(key, 0)) + 1
            self._raven_attempts[key] = attempts
            if attempts >= self.RAVEN_MAX_ATTEMPTS:
                _forget(delivery)
                _skip(f"{reason} — после {attempts} попыток снято с досылки")
            else:
                _skip(reason)

        for delivery in queue:
            source = str(delivery.get("source") or "")
            if source in self.RAVEN_NON_PROJECT_SOURCES:
                # Не вклад в проект — уходит другим путём или не уходит вовсе.
                _forget(delivery)
                continue
            market_id = delivery.get("market_id")
            if not market_id:
                # MarketID в событии не появится никогда — повторять нечего.
                _skip("в событии нет MarketID")
                _forget(delivery)
                continue
            address = delivery.get("system_address") or (
                self.ship.state.system_address if self.ship.state else 0)
            if not address:
                # Позиция корабля может определиться позже — пробуем ещё.
                _retry_later("не определён SystemAddress", delivery)
                continue
            # Raven Colonial принимает только языконезависимые имена товаров в
            # нижнем регистре без пробелов (`steel`, `liquidoxygen` — не
            # `Steel`, не `Liquid oxygen` и не `$steel_name;`).
            commodity = self._raven_commodity(delivery.get("commodity") or "")
            if not commodity:
                _skip("пустое имя товара")
                _forget(delivery)
                continue
            site_key = (int(address or 0), int(market_id or 0))
            if self._site_on_pause(site_key, now):
                # Проект не находится уже несколько попыток подряд: не долбим
                # Raven и не повторяем сводку, доставка просто ждёт.
                continue
            # ОДИН поиск проекта на площадку, а не на каждую доставку: раньше
            # очередь из четырёх недоставленных строк делала четыре запроса за
            # тик и так далее по кругу — это и выглядело как «зацикливание».
            if site_key not in site_projects:
                site_projects[site_key] = self._resolve_site_project(*site_key)
            project, note = site_projects[site_key]
            if not isinstance(project, dict) or not project.get("buildId"):
                self._note_site_miss(site_key, now)
                if site_key not in self._raven_site_warned:
                    self._raven_site_warned.add(site_key)
                    self._warn_site_unresolved(market_id, note or "проекта пока нет")
                if note and "пока нет" not in note:
                    _retry_later(f"Raven Colonial: {note}", delivery)
                else:
                    _retry_later(f"проект не найден (market_id={market_id})", delivery)
                continue
            self._clear_site_miss(site_key)
            build_id = str(project["buildId"])
            try:
                amount = int(delivery.get("amount", 0) or 0)
            except (TypeError, ValueError):
                amount = 0
            if amount <= 0:
                _skip("в событии нет тоннажа")
                _forget(delivery)
                continue
            batch = batches.setdefault(build_id, {})
            batch[commodity] = batch.get(commodity, 0) + amount
            batch_keys.setdefault(build_id, []).append((delivery, project))
            resolved_notes.setdefault(build_id, str(note or ""))

        sent_any = False
        for build_id, commodities in batches.items():
            result = self.raven_api.contribute(build_id, cmdr, commodities)
            if result.get("ok"):
                sent_any = True
                tons = sum(commodities.values())
                project_name = ""
                for delivery, project in batch_keys.get(build_id, []):
                    self._raven_sent[self._raven_delivery_key(delivery)] = {
                        "build_id": build_id,
                        "tons": int(delivery.get("amount", 0) or 0),
                        "at": time.time(),
                    }
                    _forget(delivery)
                    project_name = project_name or str(
                        project.get("buildName") or project.get("systemName") or "")
                self._save_raven_ledger()
                summary["sent"] += len(batch_keys.get(build_id, []))
                summary["tons"] += tons
                label = f" ({project_name})" if project_name else ""
                how = resolved_notes.get(build_id, "")
                if how and how not in ("market",):
                    # Проект найден не по market_id площадки (или привязан
                    # вручную) — пользователю важно видеть, куда ушли тонны.
                    label += f", найден: {how}"
                for name, amount in commodities.items():
                    self._raven_credit_pending[name] = (
                        self._raven_credit_pending.get(name, 0) + int(amount))
                self._raven_credit_checks = 0
                self.root.after(
                    0,
                    lambda t=tons, name=label: self.log(
                        f"Raven Colonial: +{t}t{name}", "success"),
                )
            else:
                retryable = bool(result.get("retryable", True))
                error = str(result.get("error") or "неизвестная ошибка")
                if retryable:
                    # Оставляем в очереди: следующий тик повторит отправку,
                    # но не бесконечно — счётчик попыток общий для строки.
                    for delivery, _project in batch_keys.get(build_id, []):
                        _retry_later(
                            f"сервер не принял доставку, будет повтор ({error})", delivery)
                else:
                    # Повтор бессмыслен (неверный ключ/проект/данные): убираем
                    # из очереди, иначе она росла бы вечно.
                    for delivery, _project in batch_keys.get(build_id, []):
                        _forget(delivery)
                    _skip(f"отправка невозможна ({error})")
                self.root.after(
                    0,
                    lambda e=error, b=build_id: self.log(
                        f"Raven Colonial: проект {b} — {e}", "warn"),
                )

        if sent_any:
            self._raven_fail_streak = 0
            # «Осталось завезти» после нашей же доставки устарело: перечитываем
            # проект площадки сразу, а не через пять минут.
            self._refresh_site_project(force=True)
            self._refresh_primary_project(force=True)
        elif batches:
            self._raven_fail_streak += 1

        if forgotten:
            self._pending_raven_deliveries = [
                item for item in self._pending_raven_deliveries
                if id(item) not in forgotten]
        if not self._pending_raven_deliveries:
            self._raven_attempts.clear()
            self._raven_queue_sig = ""

        summary["skipped"] = sum(skipped.values())
        summary["reasons"] = skipped
        summary["pending"] = len(self._pending_raven_deliveries)
        if skipped:
            # Без этой строки «Raven Colonial не получил тоннаж» выглядело как
            # молчаливый отказ сервера: все ветки выше просто делали
            # `continue`. Чаще всего причина — проект не найден по market_id,
            # и пользователю нужно это видеть, а не догадываться.
            detail = "; ".join(f"{reason} — {count}"
                               for reason, count in sorted(skipped.items()))
            total = sum(skipped.values())
            # Повтор той же сводки — не новость (та же самая недоставленная
            # строка минуту спустя), поэтому пишем только при изменении.
            # «Качели» (A -> B -> A) тоже глушим: две последние подписи.
            report_sig = (total, detail)
            if report_sig not in (self._raven_skip_sig, self._raven_skip_prev_sig):
                self._raven_skip_prev_sig = self._raven_skip_sig
                self._raven_skip_sig = report_sig
                self.root.after(
                    0,
                    lambda d=detail, n=total: self.log(
                        f"Raven Colonial: не отправлено {n} доставок ({d})", "warn"),
                )
        return summary

    def _save_raven_ledger(self):
        """Сохранить журнал отправленного в Raven Colonial (рядом с конфигом).

        Именно он не даёт зачесть одну доставку дважды после перезапуска:
        offsets журнала отвечают за «какие байты прочитаны», а этот файл — за
        «какие тонны уже зачтены проекту».
        """
        try:
            path = self.config_path.with_name(".colonial_helper_raven_sent.json")
            items = sorted(
                self._raven_sent.items(), key=lambda item: item[1].get("at", 0.0)
            )[-5000:]
            self._raven_sent = dict(items)
            tmp = path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self._raven_sent, fh)
            tmp.replace(path)
        except OSError:
            # Журнал отправленного — страховка от дублей, не критичные данные.
            pass

    def _load_raven_ledger(self) -> dict:
        try:
            path = self.config_path.with_name(".colonial_helper_raven_sent.json")
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

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
                self._ensure_system_exobio(sys_name)
                if self.route.mark_visited(sys_name):
                    self.root.after(0, self._refresh_route_tree)
                    if live:
                        self.overlay_manager.log(f"Jump: {sys_name}", "info")
        if ev.get("event") in ("ApproachBody", "Touchdown"):
            bname = ev.get("Body") or ev.get("BodyName")
            sys_name = ev.get("StarSystem") or getattr(getattr(self, "exobiology", None), "current_system", "")
            if sys_name and bname:
                self._ensure_body_exobio(sys_name, bname)
        # Стройплощадка: из неё вкладка «Колонизатор» заполняет форму проекта.
        self._feed_construction_site(ev, live=live)
        # Карта системы: тела, станции, стройплощадки и где сейчас пилот.
        self._feed_system_map(ev, live=live)
        # Отслеживание корабля
        self.ship.parse_event(ev)
        # Груз авианосца: те же события, что уходят в Raven (/api/fc/.../cargo),
        # только считаются локально для блока CARRIER в оверлее.
        self._feed_carrier(ev, live=live)
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

    # ============================================================
    #  Стройплощадки колонизации (для вкладки «Колонизатор»)
    # ============================================================
    # ============================================================
    #  Груз на авианосце (блок CARRIER в оверлее)
    # ============================================================
    def _carrier_need(self) -> dict:
        """Потребность, которую показывает блок CARRIER (без подписи)."""
        return self._carrier_need_info()[0]

    def _carrier_need_info(self):
        """Что нужно завезти и откуда мы это знаем.

        Возвращает `(need, label, source)`.

        Приоритет источников:

        1. **Проект, отмеченный основным во вкладке «Колонизатор».** Его
           `commodities` в Raven Colonial — это актуальный остаток потребности,
           который видят все клиенты: и то, что завезли вы, и то, что завезли
           другие командиры. Именно этот список просил показывать пользователь.
        2. **Проект стройплощадки, у которой стоит игрок**, перечитанный из
           Raven Colonial (`site_project`). Тоже знает чужие доставки, но не
           требует отмечать проект основным.
        3. **Стройплощадка из журнала** (`ColonisationConstructionDepot`).
           Работает без ключа RCC, но знает только то, что написано в журнале:
           если часть груза сдал другой командир, остаток будет завышен.

        Если ни одного источника нет — потребность пуста, и блок показывает
        только груз на борту.
        """
        project = self.colony_primary_project or {}
        if isinstance(project, dict) and project:
            commodities = project.get("commodities")
            if isinstance(commodities, dict) and commodities:
                need = {}
                for raw, amount in commodities.items():
                    try:
                        value = int(float(amount))
                    except (TypeError, ValueError):
                        continue
                    if value > 0:
                        need[canonical_commodity(raw)] = value
                if need:
                    label = (f"{project.get('buildName') or 'проект'}"
                             f" · {project.get('systemName') or ''}").strip(" ·")
                    return need, label, "project"

        # 2. Проект стройплощадки, у которой стоит игрок, перечитанный из Raven
        #    Colonial. В отличие от журнала он знает и чужие доставки: если
        #    часть груза сдал другой командир, «осталось завезти» уменьшится.
        site_project = self.site_project or {}
        if isinstance(site_project, dict) and site_project.get("buildId"):
            commodities = site_project.get("commodities")
            if isinstance(commodities, dict) and commodities:
                need = {}
                for raw, amount in commodities.items():
                    try:
                        value = int(float(amount))
                    except (TypeError, ValueError):
                        continue
                    if value > 0:
                        need[canonical_commodity(raw)] = value
                if need:
                    label = (f"{site_project.get('buildName') or 'стройплощадка'}"
                             f" · {site_project.get('systemName') or ''}").strip(" ·")
                    return need, label, "site_project"

        # 3. Журнал: работает без ключа RCC, но знает только ваши доставки.
        site = self.construction.site
        if site is None:
            return {}, "", ""
        try:
            need = {canonical_commodity(key): value
                    for key, value in site.remaining_by_commodity().items()}
        except Exception:
            return {}, "", ""
        need = {k: int(v) for k, v in (need or {}).items() if int(v or 0) > 0}
        if not need:
            return {}, "", ""
        label = site.station_name or site.system_name or "стройплощадка"
        return need, label, "site"

    def _feed_carrier(self, event: dict, live: bool = False):
        """Передать событие журнала трекеру авианосца.

        Вызывается из того же однопроходного разбора, что и стройплощадки:
        отдельных чтений журнала не добавляет. В историческом разборе
        (`live=False`) Raven не опрашиваем — там десятки тысяч событий.
        """
        try:
            changed = self.carrier.handle(event)
        except Exception:
            return
        if not changed or not live:
            return
        market_id = int(self.carrier.state.market_id or 0)
        if not market_id:
            return
        # В лог — только заметные события. Писать строку на каждую продажу на
        # борту авианосца смысла нет: при разгрузке трюма их десятки.
        if str(event.get("event")) in (
            "CarrierStats", "Docked", "Location", "CarrierJump", "Undocked",
            "CarrierNameChanged", "CarrierDecommission",
        ):
            self.overlay_manager.log(self.carrier.state.summary(), "info")
        # Товары поимённо журнал не отдаёт: дельты считаем сами, а точную
        # картину (груз всех командиров) берём из Raven Colonial. Один раз на
        # FC мало — другие командиры возят груз параллельно, поэтому снимок
        # обновляется и по таймеру.
        self._refresh_carrier_cargo(market_id)

    #: Как часто перечитывать поимённый груз авианосца из Raven Colonial.
    CARRIER_CARGO_REFRESH_SECONDS = 300.0

    def _refresh_carrier_cargo(self, market_id: int, force: bool = False):
        """Запросить поимённый груз FC из Raven Colonial (в фоновом потоке).

        Без ключа RCC или без сети ничего не происходит: блок останется на
        локальном учёте по дельтам журнала и честно это подпишет.
        """
        market_id = int(market_id or 0)
        if market_id <= 0 or not self.raven_api.is_connected:
            return
        now = time.monotonic()
        fresh = now - float(self._carrier_remote_at or 0.0)
        same_carrier = market_id == self._carrier_remote_market
        if same_carrier and not force and fresh < self.CARRIER_CARGO_REFRESH_SECONDS:
            return
        self._carrier_remote_market = market_id
        self._carrier_remote_at = now
        threading.Thread(
            target=self._load_carrier_cargo, args=(market_id,), daemon=True
        ).start()

    def _load_carrier_cargo(self, market_id: int):
        """Фоновый запрос: поимённый груз авианосца из Raven Colonial.

        Ничего не блокирует и не падает: нет ключа/сети — останемся на
        локальном учёте по дельтам журнала.
        """
        try:
            result = self.raven_api.get_fc_cargo(market_id)
        except Exception as exc:
            self.log(f"Raven Colonial: груз авианосца не получен ({exc})", "warn")
            return
        if not result.get("ok"):
            self.log(
                f"Raven Colonial: груз авианосца {market_id} не получен "
                f"({result.get('error') or 'нет данных'})", "info")
            return
        # Raven может отдать и объект с полем `cargo`, и саму карту
        # «товар -> тонны» (это под-ресурс /api/fc/{id}/cargo). Принимаем оба
        # варианта: числовые значения и есть груз, остальное — служебные поля.
        data = result.get("data")
        if isinstance(data, dict) and isinstance(data.get("cargo"), dict):
            cargo = data["cargo"]
        elif isinstance(data, dict):
            cargo = {
                key: value for key, value in data.items()
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            }
        else:
            cargo = data
        if not isinstance(cargo, dict) or not cargo:
            return
        # Подписываем в лог только РЕАЛЬНО изменившийся снимок: запрос уходит
        # по таймеру каждые пять минут, и «груз получен» на каждом обновлении
        # превращалось в фоновый шум, даже когда другие командиры ничего не
        # завозили.
        signature = tuple(sorted(
            (normalize_commodity(key), int(float(value or 0)))
            for key, value in cargo.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ))
        if self.carrier.merge_remote(cargo):
            if signature != self._carrier_cargo_log_sig:
                self._carrier_cargo_log_sig = signature
                self.log(
                    f"Авианосец {market_id}: груз по товарам обновлён из Raven Colonial "
                    f"({len(signature)} позиц., {sum(item[1] for item in signature)} t)", "info")

    #: Как часто перечитывать проект стройплощадки из Raven Colonial.
    SITE_PROJECT_REFRESH_SECONDS = 300.0

    #: Как часто перечитываем ОСНОВНОЙ проект колонизатора по таймеру.
    PRIMARY_PROJECT_REFRESH_SECONDS = 300.0

    def _refresh_primary_project(self, force: bool = False):
        """Перечитать основной проект колонизатора из Raven Colonial.

        Блок CARRIER оверлея показывает `commodities` основного проекта —
        актуальный остаток потребности на сервере. Раньше словарь проекта
        копировался один раз при назначении основным (или при загрузке
        списка), и после наших же доставок и ProjectUpdate, а также после
        сдач других командиров оверлей продолжал показывать потребность на
        момент назначения.
        """
        build_id = str(self.colony_primary_project.get("buildId") or "")
        if not build_id or not self.raven_api.is_connected:
            return
        now = time.monotonic()
        same = build_id == self._primary_remote_id
        if (not force and same
                and now - float(self._primary_remote_at or 0.0)
                < self.PRIMARY_PROJECT_REFRESH_SECONDS):
            return
        self._primary_remote_id = build_id
        self._primary_remote_at = now
        threading.Thread(target=self._load_primary_project,
                         args=(build_id,), daemon=True).start()

    def _load_primary_project(self, build_id: str):
        project = self.raven_api.resolve_project_by_id(build_id)
        if not isinstance(project, dict) or not project.get("buildId"):
            return

        def apply():
            # Пока запрос летел, основным могли назначить другой проект —
            # чужой список материалов не подменяем.
            if str(self.colony_primary_project.get("buildId") or "") != build_id:
                return
            self.colony_primary_project = dict(project)
            cache = getattr(self, "_colony_projects_cache", None)
            if isinstance(cache, dict):
                cache[build_id] = dict(project)
            self._maybe_confirm_project_complete(project)

        self.root.after(0, apply)

    # ============================================================
    #  Подтверждение завершения проекта в Raven Colonial
    # ============================================================
    def _maybe_confirm_project_complete(self, project):
        """Остаток потребности занулился — подтвердить завершение проекта.

        Raven Colonial не отмечает проект завершённым сам: клиент, который
        увидел полную завозку, отправляет `POST /api/project/{buildId}/complete`.
        Мы видим это при перечитке основного проекта и проекта стройплощадки —
        когда в `commodities` не осталось положительных остатков. Вызов
        планируется в главный поток: `_load_site_project` работает в фоне.
        """
        if not isinstance(project, dict):
            return
        if not str(project.get("buildId") or "").strip():
            return
        self.after(0, lambda p=dict(project): self._confirm_project_complete(p))

    def _confirm_project_complete(self, project: dict):
        """Главный поток: проверить остаток и один раз отправить /complete."""
        build_id = str(project.get("buildId") or "").strip()
        if not build_id or not self.raven_api.is_connected:
            return
        commodities = project.get("commodities")
        if not isinstance(commodities, dict) or not commodities:
            return  # данных о потребности нет — повода завершать нет
        values = []
        for amount in commodities.values():
            try:
                values.append(int(float(amount)))
            except (TypeError, ValueError):
                return  # остаток не читается — лучше не трогать
        if not values or any(value > 0 for value in values):
            return
        notified = {str(item) for item in (self.config.get("raven_complete_notified") or [])}
        if build_id in notified:
            return
        status = str(project.get("status") or "").strip().lower()
        if status in ("complete", "completed", "done"):
            # Сервер уже считает проект завершённым — запоминаем и не дёргаем API.
            notified.add(build_id)
            self.config["raven_complete_notified"] = sorted(notified)
            self.save_config()
            return
        notified.add(build_id)
        self.config["raven_complete_notified"] = sorted(notified)
        self.save_config()
        name = str(project.get("buildName") or build_id)
        self.log(f"Raven Colonial: «{name}» — потребность завезена полностью, "
                 "отправляю подтверждение завершения…", "info")
        threading.Thread(target=self._confirm_complete_thread,
                         args=(build_id, name), daemon=True).start()

    def _confirm_complete_thread(self, build_id: str, name: str):
        """Фоновый POST /complete; сетевой сбой снимает метку ради повтора."""
        try:
            result = self.raven_api.mark_complete(build_id)
        except Exception as exc:
            result = {"ok": False, "status": 0, "error": str(exc)}
        if not isinstance(result, dict):
            result = {"ok": False, "status": 0, "error": "пустой ответ"}

        def done():
            if result.get("ok"):
                self.log(f"Raven Colonial: завершение проекта «{name}» подтверждено.",
                         "success")
                return
            try:
                status = int(result.get("status") or 0)
            except (TypeError, ValueError):
                status = 0
            if status == 0:
                # Сеть не ответила — убираем метку, следующая перечитка повторит.
                notified = [str(item)
                            for item in (self.config.get("raven_complete_notified") or [])
                            if str(item) != build_id]
                self.config["raven_complete_notified"] = notified
                self.save_config()
                self.log(f"Raven Colonial: подтверждение завершения «{name}» не ушло "
                         f"({result.get('error') or 'сеть'}) — повторю позже.", "warn")
            else:
                self.log(f"Raven Colonial: завершение «{name}» не принял "
                         f"({result.get('error') or status}).", "error")

        self.after(0, done)

    def _on_raven_supply_sent(self, build_id: str = ""):
        """ProjectUpdate дошёл до Raven: потребность изменилась — перечитать."""
        self.after(0, lambda: self._refresh_site_project(force=True))
        self.after(0, lambda: self._refresh_primary_project(force=True))

    def _refresh_site_project(self, force: bool = False):
        """Перечитать из Raven Colonial проект площадки, у которой стоит игрок.

        Остаток потребности проекта на Raven общий на всех командиров. Журнал
        знает только то, что завезли вы, поэтому без этого запроса «осталось
        завезти» не уменьшалось, когда часть груза сдавал кто-то другой (или
        когда сессия прервалась и доставки досылались в другой заход).

        Без ключа RCC или без сети ничего не происходит: потребность останется
        на данных журнала из `ColonisationConstructionDepot`.
        """
        site = self.construction.site
        if site is None:
            return
        try:
            market_id = int(site.market_id or 0)
            address = int(site.system_address or 0)
        except (TypeError, ValueError):
            return
        if market_id <= 0 or address <= 0 or not self.raven_api.is_connected:
            return
        now = time.monotonic()
        fresh = now - float(self._site_remote_at or 0.0)
        same_site = market_id == self._site_remote_market
        if same_site and not force and fresh < self.SITE_PROJECT_REFRESH_SECONDS:
            return
        self._site_remote_market = market_id
        self._site_remote_at = now
        if force:
            # «Перечитать сразу» ничего не давало: ответ приходил из кэша на
            # 300 секунд, и после нашей же доставки пользователь продолжал
            # видеть прежний остаток потребности.
            invalidate = getattr(self.raven_api, "invalidate_project_cache", None)
            if callable(invalidate):
                invalidate(address, market_id)
        threading.Thread(
            target=self._load_site_project, args=(address, market_id), daemon=True
        ).start()

    def _load_site_project(self, address: int, market_id: int):
        """Фоновый запрос: проект стройплощадки из Raven Colonial.

        Ищем тем же путём, что и для отправки доставок (привязка площадки ->
        market_id -> система), иначе «осталось завезти» показывало бы не тот
        проект, которому зачисляются тонны.
        """
        project, _note = self._resolve_site_project(address, market_id)
        if not isinstance(project, dict) or not project.get("buildId"):
            # Площадка есть в журнале, но проекта на Raven ещё нет (никто не
            # создал) — это не ошибка, а состояние. Молча остаёмся на журнале.
            self.site_project = {}
            return
        self.site_project = dict(project)
        self._maybe_confirm_project_complete(project)
        commodities = project.get("commodities")
        if isinstance(commodities, dict):
            remaining = {
                canonical_commodity(key): int(float(value))
                for key, value in commodities.items()
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            }
            self._check_raven_credit(market_id, remaining)
            left = sum(remaining.values())
            # Пишем строку только когда остаток действительно изменился:
            # опрос идёт по таймеру каждые пять минут, и одинаковое
            # «осталось завезти» на каждом опросе — просто шум.
            signature = (market_id, tuple(sorted(remaining.items())))
            if signature != self._site_project_log_sig:
                self._site_project_log_sig = signature
                # Тысячи разделяем пробелом, но только в самом числе: глобальный
                # .replace(",", " ") по всей строке съел бы запятую после «позиц.».
                tons = f"{left:,}".replace(",", " ")
                self.log(
                    f"Стройплощадка {market_id}: осталось завезти {tons} t "
                    f"({len(remaining)} позиц., данные Raven Colonial)",
                    "info")

    #: Сколько снимков потребности ждём, прежде чем сказать «тонны не зачтены».
    #: Raven может применить вклад не мгновенно, а первый снимок делается сразу
    #: после отправки: ругаться по нему — значит пугать пользователя зря.
    RAVEN_CREDIT_GRACE_CHECKS = 2

    def _check_raven_credit(self, market_id: int, remaining: dict):
        """Зачёл ли Raven тонны, которые мы отправили.

        `contribute` отвечает 200 и когда товар не входит в потребность
        проекта, и когда проект оказался не тем: со стороны это ровно то, на
        что жаловался пользователь — «запросы уходят, а ресурсы в проект не
        приходят». Сравниваем остаток потребности до и после отправки и, если
        он не уменьшился, говорим прямо, что не так.

        Товар считается зачтённым, как только его остаток уменьшился, — после
        этого он из ожидания убирается и больше не проверяется.
        """
        expected = dict(self._raven_credit_pending)
        previous = dict(self._site_remaining_prev)
        self._site_remaining_prev = dict(remaining)
        if not expected or not previous:
            return

        still_waiting = {}
        problems = []
        for name, tons in sorted(expected.items()):
            after = remaining.get(name)
            before = previous.get(name)
            if after is None:
                problems.append(f"{name} ({tons} t) — товара нет в потребности проекта")
                still_waiting[name] = tons
            elif before is not None and int(after) >= int(before):
                problems.append(f"{name} ({tons} t) — потребность не уменьшилась "
                                f"({before} -> {after})")
                still_waiting[name] = tons

        if not problems:
            # Всё зачтено: сбрасываем ожидание и «память» о прошлой жалобе,
            # чтобы следующая реальная проблема снова была видна.
            self._raven_credit_pending = {}
            self._raven_credit_checks = 0
            self._raven_credit_warn_sig = None
            self._raven_credit_prev_sig = None
            return

        self._raven_credit_pending = still_waiting
        self._raven_credit_checks += 1
        if self._raven_credit_checks < self.RAVEN_CREDIT_GRACE_CHECKS:
            return

        signature = (int(market_id or 0), tuple(sorted(still_waiting)))
        if signature in (self._raven_credit_warn_sig, self._raven_credit_prev_sig):
            return
        self._raven_credit_prev_sig = self._raven_credit_warn_sig
        self._raven_credit_warn_sig = signature
        self.log(
            f"Raven Colonial: запрос принят, но тонны не зачтены проекту "
            f"{market_id}: " + "; ".join(problems)
            + ". Проверьте, тот ли это проект (вкладка «Колонизатор» — «Привязать "
              "площадку к проекту»), и входит ли товар в потребность.",
            "warn")

    # ============================================================
    #  Сверка стройплощадки с Raven Colonial
    #
    #  Отвечает на вопрос «сколько осталось завезти» честно: журнал знает
    #  только то, что завезли ВЫ, а остаток потребности на Raven Colonial
    #  общий на всех командиров. Плюс — досылает то, что не ушло из-за
    #  прерванной сессии или сбоя сети.
    # ============================================================
    #: Сколько последних журналов читаем в поисках доставок на площадку.
    RECONCILE_MAX_FILES = 10
    RECONCILE_MAX_BYTES = 20 * 1024 * 1024

    def _journal_site_deliveries(self, market_id: int) -> dict:
        """Что по журналу завезено на конкретную стройплощадку.

        Возвращает `{"deliveries": [...], "tons": {...}, "total": int,
        "count": int, "last_at": str}`. Читаем хвост последних журналов:
        стройка живёт днями, а вся история для сверки не нужна.
        """
        deliveries: list = []
        budget = self.RECONCILE_MAX_BYTES
        try:
            files = sorted(
                self.journal_path.glob("Journal.*.log"),
                key=lambda f: f.stat().st_mtime,
                reverse=True,
            )[: self.RECONCILE_MAX_FILES]
        except OSError:
            files = []
        site = self.construction.site
        fallback_system = (site.system_name if site is not None else "") or (
            self.ship.state.current_system if self.ship.state else "")
        fallback_address = (site.system_address if site is not None else 0) or (
            self.ship.state.system_address if self.ship.state else 0)

        for path in files:
            if budget <= 0:
                break
            try:
                size = path.stat().st_size
                with open(path, "rb") as fh:
                    chunk = min(size, budget)
                    if size > chunk:
                        fh.seek(size - chunk)
                        fh.readline()  # отбрасываем неполную строку
                    raw = fh.read()
                budget -= chunk
            except OSError:
                continue
            deliveries.extend(site_deliveries_from_text(
                raw.decode("utf-8", errors="replace"),
                market_id=market_id,
                current_system=fallback_system,
                current_system_address=fallback_address,
            ))

        deliveries.sort(key=lambda d: str(d.get("delivered_at") or ""))
        tons: dict = {}
        total = 0
        for delivery in deliveries:
            key = normalize_commodity(delivery.get("commodity") or "")
            amount = int(delivery.get("amount", 0) or 0)
            if not key or amount <= 0:
                continue
            tons[key] = tons.get(key, 0) + amount
            total += amount
        return {
            "deliveries": deliveries,
            "tons": tons,
            "total": total,
            "count": len(deliveries),
            "last_at": str(deliveries[-1].get("delivered_at") or "") if deliveries else "",
        }

    def _on_colony_reconcile(self):
        """Кнопка «Сверить стройплощадку»: журнал против Raven Colonial."""
        if not self.raven_api.is_connected:
            self.log("Raven Colonial: ключ RCC не задан — сверка невозможна "
                     "(вкладка «Колонизатор»)", "warn")
            return
        site = self.construction.site
        if site is None or not site.market_id:
            self.log("Стройплощадка не найдена: пристыкуйтесь к Construction Ship / "
                     "площадке или запустите watcher (состояние восстановится из журнала).",
                     "warn")
            return
        if getattr(self, "_colony_reconcile_busy", False):
            return
        self._colony_reconcile_busy = True
        self.colony_status.config(text="Сверяю стройплощадку с Raven Colonial…")
        threading.Thread(
            target=self._colony_reconcile_thread,
            args=(int(site.market_id), int(site.system_address or 0)),
            daemon=True,
        ).start()

    def _colony_reconcile_thread(self, market_id: int, address: int):
        """Фоновая часть сверки: свежие данные проекта из Raven Colonial.

        Проект определяется тем же путём, что и для отправки доставок
        (привязка площадки -> market_id -> поиск по системе): иначе сверка
        показывала бы один проект, а тонны уходили в другой.
        """
        project = None
        error = ""
        how = ""
        try:
            invalidate = getattr(self.raven_api, "invalidate_project_cache", None)
            if callable(invalidate):
                invalidate(address, market_id)
            project, note = self._resolve_site_project(address, market_id)
            if isinstance(project, dict) and project.get("buildId"):
                how = str(note or "")
                self._push_raven_supply(project, market_id)
            else:
                project = None
                error = str(note or "")
        except Exception as exc:
            error = str(exc)
        self.after(0, lambda: self._colony_reconcile_done(market_id, address, project,
                                                          error, how))

    def _push_raven_supply(self, project: dict, market_id: int) -> None:
        """Дослать остаток потребности в Raven (ProjectUpdate по depot-состоянию).

        Доставки (`contribute`) прибавляют тонны к заслугам командира, но
        колонку Need по материалам Raven пересчитывает только из ProjectUpdate
        клиента архитектора. Без этого вызова сайт выглядит так: «груз завезён,
        а потребность не уменьшилась».
        """
        site = getattr(self.construction, "site", None)
        if site is None or int(getattr(site, "market_id", 0) or 0) != int(market_id or 0):
            return
        needed = {res.name: res.remaining for res in getattr(site, "resources", [])
                  if getattr(res, "name", "")}
        max_need = sum(res.required for res in getattr(site, "resources", [])
                       if (getattr(res, "required", 0) or 0) > 0)
        if not needed:
            return
        self.dispatcher.submit_supply_update(
            int(market_id), int(getattr(site, "system_address", 0) or 0),
            needed, max_need)

    def _colony_reconcile_done(self, market_id: int, address: int, project, error: str = "",
                              how: str = ""):
        self._colony_reconcile_busy = False
        site = self.construction.site
        journal = self._journal_site_deliveries(market_id)
        head = f"Сверка стройплощадки {market_id}"
        if site is not None and site.system_name:
            head += f" ({site.system_name})"

        if not isinstance(project, dict) or not project.get("buildId"):
            self.site_project = {}
            reason = error or "проекта пока нет в Raven Colonial"
            self.log(f"{head}: {reason}. По журналу вы завезли {journal['total']:,} t "
                     f"({journal['count']} дост.) — тонны не зачтутся, пока проект не создан."
                     .replace(",", " "), "warn")
            self.colony_status.config(text="Проект на Raven Colonial не найден")
            return

        self.site_project = dict(project)
        self._maybe_confirm_project_complete(project)
        commodities = project.get("commodities") if isinstance(project.get("commodities"), dict) else {}
        remaining = {
            canonical_commodity(key): int(float(value))
            for key, value in commodities.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
        left = sum(remaining.values())
        name = str(project.get("buildName") or site.station_name or "площадка").strip()

        def fmt(number: int) -> str:
            return f"{number:,}".replace(",", " ")

        def top(mapping: dict, limit: int = 4) -> str:
            rows = sorted(mapping.items(), key=lambda item: -item[1])[:limit]
            return ", ".join(f"{key} {fmt(value)}" for key, value in rows if value > 0)

        lines = [f"{head}: проект «{name}» (buildId {project.get('buildId')}"
                 + (f", найден: {how}" if how and how != "market" else "") + ")"]
        lines.append(f"  Raven Colonial: осталось завезти {fmt(left)} t"
                     + (f" — {top(remaining)}" if remaining else " — потребность закрыта"))
        lines.append(f"  По журналу: вы завезли {fmt(journal['total'])} t "
                     f"({journal['count']} доставок"
                     + (f", последняя {journal['last_at'][:16].replace('T', ' ')}" if journal["last_at"] else "")
                     + ")")
        sent_rows = [
            item for item in self._raven_sent.values()
            if isinstance(item, dict)
        ]
        sent_tons = sum(int(item.get("tons", 0) or 0) for item in sent_rows)
        lines.append(f"  Отправлено этим приложением в Raven Colonial: {fmt(sent_tons)} t "
                     f"({len(sent_rows)} доставок)")
        carrier_market = int(self.carrier.state.market_id or 0)
        if carrier_market:
            state = self.carrier.state
            on_board = state.tracked_total
            source = "Raven Colonial" if state.remote_seen else "локальный учёт по журналу"
            lines.append(f"  Авианосец {carrier_market}: на борту {fmt(on_board)} t "
                         f"({source})"
                         + (f" — {top({row['key']: row['amount'] for row in state.get_state_dict()['commodities'] if row['amount'] > 0})}"
                            if on_board else ""))
        self.log("\n".join(lines), "info")
        self.colony_status.config(
            text=f"Осталось завезти {fmt(left)} t · по журналу вы завезли {fmt(journal['total'])} t")

        # Состояние рынка авианосца тоже освежаем: груз туда возят и другие
        # командиры, а журнал знает только наши переводы.
        if carrier_market:
            self._refresh_carrier_cargo(carrier_market, force=True)

        # Что не ушло в Raven Colonial: прерванная сессия, сбой сети, отсутствие
        # ключа в момент доставки. Досылаем только с согласия пользователя —
        # если он параллельно пользуется SrvSurvey/EDMC, тонны могут быть
        # уже засчитаны ими.
        unsent = [
            delivery for delivery in journal["deliveries"]
            if self._raven_delivery_key(delivery) not in self._raven_sent
        ]
        pending = list(self._pending_raven_deliveries)
        if pending:
            summary = self._flush_raven_deliveries(self._current_cmdr_name(), force=True)
            self.log(f"Raven Colonial: дослано из очереди {summary.get('sent', 0)} доставок "
                     f"({fmt(int(summary.get('tons', 0)))} t), в очереди осталось "
                     f"{summary.get('pending', 0)}", "info")
        if not unsent:
            return
        tons = sum(int(d.get("amount", 0) or 0) for d in unsent)
        if not messagebox.askyesno(
            "Дослать доставки в Raven Colonial",
            f"По журналу на эту площадку завезено {fmt(tons)} t ({len(unsent)} доставок), "
            "которые это приложение в Raven Colonial не отправляло.\n\n"
            "Отправить их сейчас?\n"
            "Если вы пользуетесь SrvSurvey или другим плагином, тоннаж может быть "
            "зачтён проекту дважды.",
            parent=self.root,
        ):
            return
        summary = self._send_deliveries_to_raven(unsent, self._current_cmdr_name(), force=True)
        self.log(f"Raven Colonial: дослано из журнала {summary.get('sent', 0)} доставок "
                 f"({fmt(int(summary.get('tons', 0)))} t)", "success")

    def _feed_construction_site(self, event: dict, live: bool = False):
        """Передать событие журнала трекеру стройплощадок.

        Вызывается из того же однопроходного разбора, что и доставки:
        отдельных чтений журнала не добавляет. В историческом разборе
        (`live=False`) UI не трогаем — там десятки тысяч событий, а
        площадка нужна только для текущей стоянки.
        """
        try:
            changed = self.construction.handle("", event)
        except Exception:
            return
        if changed and live:
            self.after(0, self._on_construction_site_changed)

    def _on_construction_site_changed(self):
        """Командир только что пристыковался к стройплощадке (или улетел)."""
        site = self.construction.site
        if site is None or not site.market_id:
            self._update_colony_site_label()
            return
        self._update_colony_site_label()
        if site.market_id in self._colony_announced_sites:
            return
        self._colony_announced_sites.add(site.market_id)

        self.log(f"Стройплощадка: {site.summary()}", "info")
        if not self.colony_autofill_var.get():
            self.log(
                "Автозаполнение формы создания проекта выключено — "
                "нажмите «Заполнить из журнала».", "info",
            )
            return
        if self._colony_form_dirty():
            # Пользователь уже что-то ввёл руками — не затираем его ввод.
            self.log(
                "Форма создания проекта изменена вручную — автозаполнение пропущено "
                "(кнопка «Заполнить из журнала» перезаполнит её).", "info",
            )
            return
        self._colony_autofill_from_site(site, auto=True)

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
            else:
                # Оставляем события в очереди: следующий тик повторит отправку
                # с тем же source_hash, а сервер безопасно устранит дубли.
                self._pending_watcher_deliveries = upload_deliveries + self._pending_watcher_deliveries
                if len(self._pending_watcher_deliveries) > self.WATCHER_PENDING_LIMIT:
                    self._pending_watcher_deliveries = self._pending_watcher_deliveries[-self.WATCHER_PENDING_LIMIT:]
                msg = f"[Watcher] Upload error: {result.get('error')}"
                self.root.after(0, lambda m=msg: self.log(m, "error"))
                self.overlay_manager.log(f"Error: {result.get('error')}", "error")

        # Отправка на Raven Colonial — ВСЕГДА, независимо от ответа сайта.
        #
        # Раунд 34: этот вызов стоял внутри `if result["ok"]`, а ветка ошибки
        # потеряла свой `else` — весь код повтора оказался в блоке успеха.
        # Получалось два сбоя сразу:
        #   * сайт не ответил — доставка не уходила никуда и молча терялась
        #     (именно «Raven Colonial не получает инфу о завезённом грузе»);
        #   * сайт ответил успешно — доставка возвращалась в очередь и на
        #     КАЖДОМ следующем тике (раз в 5 секунд) уезжала повторно и на
        #     сайт, и в Raven, завышая тоннаж проекта, плюс в лог писалось
        #     «[Watcher] Upload error: None».
        # Очередь Raven теперь своя (`_pending_raven_deliveries`) и с журналом
        # отправленного по `source_hash`: повтор невозможен даже после
        # перезапуска программы.
        if deliveries or self._pending_raven_deliveries:
            self._send_deliveries_to_raven(deliveries, cmdr_name)

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
