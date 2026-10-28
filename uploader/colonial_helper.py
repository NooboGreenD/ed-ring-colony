#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Colonial Helper — standalone uploader for ED Ring Colony.
Qt desktop app with live journal monitoring and an in-game HUD overlay.
"""
from __future__ import annotations

import errno
import os
import sys
import json
import tempfile
import time
import threading
from datetime import datetime
from pathlib import Path
import traceback
from typing import Dict, Optional, List
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
import webbrowser

# Интерфейс — нативный Qt: окно, оболочка и страницы собраны из виджетов
# PySide6, а диалоги вызываются через `ui_qt`.
from ui_qt import (
    ask_directory,
    ask_open_file,
    ask_open_files,
    ask_save_file,
    ask_string,
    ask_yes_no,
    show_error,
    show_info,
    show_warning,
)
from helper_window import HelperWindow

# -- pyperclip --
try:
    import pyperclip
except ImportError:
    pyperclip = None

from api_client import ApiClient
from community_goals import CommunityGoalReportCollector, community_goal_reports_from_event
from site_config import normalize_site_url, saved_connection
import i18n
from i18n import tr
from locale_config import normalize_locale, localized_url
from journal_parser import (
    parse_events,
    iter_journal_events,
    site_deliveries_from_text,
    ConstructionSnapshotCollector,
    PARSER_VERSION,
)
from route_tracker import RouteTracker
from overlay_options import CONTENT_OPTIONS, CARRIER_FILTERS, option_key, route_summary
from helper_shell import PageHost, build_shell
from overlay import (
    OverlayManager, ANCHOR_KEYS, ANCHOR_LABELS, BLOCK_LABELS,
    SIZE_PRESETS, SIZE_PRESET_LABELS, AUTO_RULES, AUTO_RULE_LABELS, IDLE_TIMEOUTS,
)
from exobiology import (
    ExobiologyTracker, ExobiologyCache, PLANET_SEARCH_PRESETS, GENUS_VALUE_CR,
)
from carrier import CarrierTracker
from colonisation import (
    ConstructionSiteTracker,
    build_project_draft,
    format_commodities,
)
from system_map import MapRavenCache, SystemMapBuilder
from edsm_api import EDSMAPI
from eddn_api import EddnClient
from inara_api import InaraAPI
from ship_tracker import ShipTracker
from event_dispatch import (ThirdPartyDispatcher, canonical_commodity,
                          normalize_commodity)
from raven_colonial_api import RavenColonialAPI, project_url
from colony_build_types import (BUILD_TYPES, BUILD_TYPE_CODES, build_type_label,
                                normalize_build_type)
# Пакетное обновление кода: программа запускается лаунчером (ColonialHelper.exe),
# а её модули лежат отдельным пакетом и обновляются пофайлово с нашего сервера.
# При запуске из исходников этих модулей может не быть — это нормально.
try:
    import bundle
    import bundle_updater
except Exception:  # pragma: no cover - запуск из исходников без пакета
    bundle = None
    bundle_updater = None

# -- Константы --
APP_NAME = "Colonial Helper"
#: Русские строки файла, которые не являются подписями интерфейса: значения
#: полей журнала, токены разбора ответов сервера и имя источника данных.
#: ``Вы`` — имя первооткрывателя (``FirstFootfallBy``), ``включена``/``отключена``
#: — куски диагностической строки в журнал, ``сверху``/``линейный`` — принимаемые
#: написания режимов карты, ``БД проекта`` — имя источника для журнала.
NON_UI_LITERALS = frozenset({
    # значения полей журнала и принимаемые написания настроек
    "Вы", "включена", "отключена", "сверху", "линейный", "БД проекта",
    # токены разбора ответов сервера (см. tests/test_i18n.ERROR_MARKER_LITERALS)
    "занят", "не удалось", "невер", "недоступ", "ошиб", "сбой",
    # причины и заметки, которые уходят только в журнал программы, а не в окно
    "привязка площадки", "Raven Colonial не ответил (", "нет генератора",
    "нет данных", "трюм пуст по CarrierStats", "по рынку носителя",
    "проекта пока нет", "пока нет", "проект не найден (market_id=",
    "в событии нет MarketID", "не определён SystemAddress",
    "пустое имя товара", "в событии нет тоннажа", "неизвестная ошибка",
    "ошибка", "пустой ответ", ", найден: ", " — после ",
    " попыток снято с досылки", "сервер не принял доставку, будет повтор (",
    "отправка невозможна (", "Сверка стройплощадки ", ": проект «",
    "  Raven Colonial: осталось завезти ", " — потребность закрыта",
    "  По журналу: вы завезли ", " доставок", ", последняя ",
    "  Отправлено этим приложением в Raven Colonial: ", " доставок)",
    "  Авианосец ", ": на борту ", "Обнаружен журнал другого CMDR '",
    "' (ожидался '", "'). Доставки из ", " пропущены.", "t на маршрут)",
    # консоль и файл аварийного журнала: окно ещё не существует
    "Лог очищен", "ОШИБКА: не найден модуль 'requests'",
    "Решение: pip install requests", "КРИТИЧЕСКАЯ ОШИБКА при запуске:\n",
    "\n\nПодробности сохранены в:\n",
})

VERSION = "2.18.29"
DEFAULT_JOURNAL_PATH = Path.home() / "Saved Games" / "Frontier Developments" / "Elite Dangerous"

# Что нам сообщил лаунчер: свою версию и версию запущенного пакета кода.
# Пусто — значит, программа запущена не из сборки (исходники, отладка), и
# обновлять код пакетом нечего: обновляется git-клон, а не установка.
LAUNCHER_VERSION = os.environ.get("COLONIAL_HELPER_LAUNCHER", "")
ACTIVE_BUNDLE_VERSION = os.environ.get("COLONIAL_HELPER_ACTIVE_VERSION", "")
_JOURNAL_OFFSETS_LOCK = threading.RLock()


def _atomic_write_journal_offsets(path: Path, payload: dict, *, replace=None, sleep=None):
    """Write offsets via a unique same-directory file; retry transient Windows locks.

    A fixed ``.tmp`` name can be shared by separate Helper processes. One process
    may then rename or truncate another process's open temporary file. ``mkstemp``
    gives each writer a private file while keeping the final replace on one volume.
    """
    replace = replace or os.replace
    sleep = sleep or time.sleep
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f"{path.name}.{os.getpid()}.", suffix=".tmp", dir=str(path.parent)
    )
    temp_path = Path(temp_name)
    try:
        handle = os.fdopen(fd, "w", encoding="utf-8")
        fd = -1  # fdopen now owns the descriptor
        with handle:
            json.dump(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())

        for attempt in range(6):
            try:
                replace(temp_path, path)
                return
            except OSError as exc:
                winerror = getattr(exc, "winerror", None)
                retryable = (winerror in (5, 32)
                             or exc.errno in (errno.EACCES, errno.EBUSY, errno.EPERM))
                if not retryable or attempt == 5:
                    raise
                sleep(min(0.05 * (2 ** attempt), 0.4))
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        except OSError:
            pass


def bundle_mode() -> bool:
    """Можно ли обновлять код пакетом (программа запущена лаунчером)."""
    return bool(bundle and bundle_updater and LAUNCHER_VERSION and ACTIVE_BUNDLE_VERSION)

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


def _screen_with_game_label() -> str:
    """Подпись «с игрой» (ключ перевода — из ``helper_pages``)."""
    from helper_pages import screen_with_game_label

    return screen_with_game_label()


def _screen_label(index) -> str:
    """Подпись экрана монитора: «экран N» на текущем языке."""
    from helper_pages import screen_label

    return screen_label(index)


class ColonialHelperApp:
    def __init__(self, root: HelperWindow):
        self.root = root
        self.root.title(f"{APP_NAME} v{VERSION}")
        self.root.geometry("1180x790")
        self.root.minsize(980, 630)

        try:
            self.root.iconbitmap("colonial_helper.ico")
        except Exception:
            pass

        # Данные
        self.api = ApiClient()
        self.route = RouteTracker()
        self.ship = ShipTracker()
        self._latest_loadout_event = None
        self._ship_state_last_synced = None
        self._ship_state_sync_inflight = False
        self._ship_state_loadout_pending = False
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
        self._faction_state_lock = threading.RLock()
        self._faction_system = ""
        self._faction_updated_at = ""
        self._faction_controlling = ""
        self._faction_presence: list = []
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
        # Legacy scene state retained for journal/model compatibility only;
        # no system-map visualization is built or exposed in the Qt UI.
        self._map3d_view = None               # tk_orrery.TkOrreryView
        self._map3d_key = None                # по каким данным собран пакет сцены
        self._map3d_job = None                # таймер движения тел по орбитам
        self._map_hover_key = ""              # объект под курсором (для карточки)
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
        # Учёт авианосцев на сайте проекта: когда последний раз читали
        # /api/carriers/mine (0 — перечитать на ближайшем тике watcher'а).
        self._carrier_server_at = 0.0
        self._carrier_server_warning_at = 0.0
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
        self._backfill_community_goal_reports: list = []
        # Коллектор snapshots стройки живёт вместе с приложением, а не вместе
        # с тиком watcher'а: набор уже отправленных состояний обязан переживать
        # тик, иначе журнал (он пишет `ColonisationConstructionDepot` каждые
        # несколько секунд, пока игрок у площадки) заливал сайт одинаковыми
        # снимками с новой меткой времени — по одной строке на тик.
        self._construction_collector = ConstructionSnapshotCollector()
        self._community_goal_collector = CommunityGoalReportCollector()
        self._navroute_mtime = 0.0

        # Конфиг
        self.config = {}
        self.config_path = Path.home() / ".colonial_helper.json"
        # Отдельное хранилище credentials переживает обновление приложения и
        # не может быть затёрто настройками HUD/overlay.
        self.credentials_path = Path.home() / ".colonial_helper_credentials.json"
        # Frontier CAPI is bound and fetched by the website. Colonial Helper
        # keeps no separate Frontier credentials; it uses only its revocable
        # project API token to request a server-side sync.
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
        # EDDN: публикация исследовательских событий (данные для Spansh). Выключено
        # по умолчанию: публикация открытая и необратимая — см. eddn_api.py.
        self.eddn_api = EddnClient(
            enabled=bool(self.config.get("eddn_enabled", False)),
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
            eddn_api=self.eddn_api,
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

        # Координатор колеса нужен только прежней карте системы; нативные
        # Qt-страницы прокручиваются сами, поэтому он больше не создаётся.
        self._smooth_scroll = None

        # UI
        self._build_header()
        self._build_notebook()
        self._build_status_bar()

        # Горячие клавиши
        self.root.bind("<F12>", lambda e: self._on_toggle_overlay_visibility())
        self.root.bind("<Control-F12>", lambda e: self._on_toggle_overlay_lock())
        self.root.bind("<Control-o>", lambda e: self._on_toggle_overlay())
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        # Авто-проверка токена
        if self.api.token:
            self.after(500, self._auto_validate)

        # Показать сохранённую авторизацию Frontier (досье пилота)
        self.after(600, self._capi_refresh_status)

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
        # Отметка «версия рабочая» для лаунчера. Восемь секунд — это заведомо
        # позже окна, вкладок и первого тика watcher'а: если программа падает
        # на старте, до отметки дело не дойдёт и лаунчер откатится сам.
        self.after(8000, self._mark_bundle_healthy)

    # ============================================================
    #  Стили
    # ============================================================
    # ============================================================
    #  Шапка
    # ============================================================
    #: Каналы автономного сервера проекта. Оба указателя живут на
    #: edringcolony.ru; GitHub в обновлениях не участвует.
    UPDATE_CHANNEL_LABELS = {
        "stable": "Стабильные релизы (сервер проекта)",
        "all": "Все сборки: стабильные и бета",
    }

    def _build_header(self):
        """Native Qt shell: header, sidebar navigation, page stack and status."""
        self.root.title(f"COLONIAL HELPER  /  v{VERSION}")
        self.shell = build_shell(self.root, on_change=self._on_notebook_tab_changed,
                                 version=VERSION)

    def _build_notebook(self):
        # Вместо девяти сжимающихся горизонтальных вкладок — постоянная
        # боковая навигация и рабочая область в стиле стартового лаунчера.
        # Все прежние страницы остаются теми же Tk-фреймами: меняется только
        # способ перехода между ними.
        self.notebook = self.shell
        page_host = self.notebook.content_area

        self.tab_auth = PageHost(page_host)
        self.notebook.add(self.tab_auth, text=tr("Подключение"))
        self._build_tab_auth()

        self.tab_pilot = PageHost(page_host)
        self.notebook.add(self.tab_pilot, text=tr("Пилот"))
        self._build_tab_pilot()

        self.tab_upload = PageHost(page_host)
        self.notebook.add(self.tab_upload, text=tr("Загрузка логов"))
        self._build_tab_upload()

        self.tab_route = PageHost(page_host)
        self.notebook.add(self.tab_route, text=tr("Маршрут"))
        self._build_tab_route()

        self.tab_colony = PageHost(page_host)
        self.notebook.add(self.tab_colony, text=tr("Колонизатор"))
        self._build_tab_colony()

        self.tab_factions = PageHost(page_host)
        self.notebook.add(self.tab_factions, text=tr("Фракции"))
        self._build_tab_factions()
        # Backward-compatible field for old internal map callbacks; no map page
        # is registered in navigation or rendered in the Qt interface.
        self.tab_map = None

        self.tab_overlay = PageHost(page_host)
        self.notebook.add(self.tab_overlay, text=tr("Оверлей"))
        self._build_tab_overlay()

        self.tab_exobio = PageHost(page_host)
        self.notebook.add(self.tab_exobio, text=tr("Экзобиология"))
        self._build_tab_exobio()

        self.tab_log = PageHost(page_host)
        self.notebook.add(self.tab_log, text=tr("Лог"))
        self._build_tab_log()

        # Инициализируем активную страницу уже после создания всех функций и
        # виджетов: обработчик изменения вкладки обращается к карте/оверлею.
        self.notebook.select(self.tab_auth)

    # ============================================================
    #  Вкладка: Подключение
    # ============================================================
    @staticmethod
    def _show_page(page) -> None:
        """Показать страницу, только если её действительно принял каркас.

        В stub-тестах Tk-фасад подменён и `addWidget` ничего не делает: у
        страницы не появляется родителя. Вызванный в этом случае `show()`
        превращал её в отдельное окно платформы, и сотни таких окон за один
        прогон вешали Qt. В настоящем окне у страницы всегда есть родитель.
        """
        if page.parent() is not None:
            page.show()

    def _build_tab_auth(self):
        """Вкладка «Подключение» на чистом Qt (см. helper_pages.AuthPage)."""
        from helper_pages import AuthPage, AuthPageActions, AuthPageState

        state = AuthPageState(
            site_url=self.api.site_url,
            token=self.api.token or "",
            journal_path=str(self.journal_path),
            site_error=getattr(self, "_site_config_error", "") or "",
            raven_key=getattr(self.raven_api, "api_key", "") or "",
            edsm_key=self.edsm_api.api_key or "",
            edsm_name=self.edsm_api.commander_name or "",
            edsm_status=tr("EDSM: включён") if self.edsm_api.enabled else tr("EDSM: не настроен"),
            eddn_enabled=bool(self.eddn_api.enabled),
            inara_key=self.inara_api.api_key or "",
            inara_name=self.inara_api.commander_name or "",
            inara_status=tr("Inara: включена") if self.inara_api.enabled else tr("Inara: не настроена"),
        )
        actions = AuthPageActions(
            open_tokens=self._open_site_account,
            change_server=self._change_site_url,
            validate_token=self._on_validate_token,
            paste_token=self._on_paste_token,
            capi_link=self._on_capi_link,
            capi_fetch=self._on_capi_fetch,
            browse_journal=self._on_browse_journal_path,
            save_edsm=self._save_edsm_settings,
            save_inara=self._save_inara_settings,
            check_raven=self._on_check_raven,
            eddn_toggle=self._on_eddn_toggle,
        )
        self.auth_page = AuthPage(state, actions)
        self.tab_auth._get_tk_layout("pack").addWidget(self.auth_page)
        self._show_page(self.auth_page)

        # Имена, которыми пользуется остальной код и тесты: это те же виджеты.
        self.token_entry = self.auth_page.token_entry
        self.toggle_token_btn = self.auth_page.toggle_token_btn
        self.auth_result = self.auth_page.auth_result
        self.capi_link_btn = self.auth_page.capi_link_btn
        self.capi_fetch_btn = self.auth_page.capi_fetch_btn
        self.capi_status = self.auth_page.capi_status
        self.path_entry = self.auth_page.path_entry
        self.raven_key_entry = self.auth_page.raven_key_entry
        self.raven_status_label = self.auth_page.raven_status_label
        self.edsm_key_entry = self.auth_page.edsm_key_entry
        self.edsm_name_entry = self.auth_page.edsm_name_entry
        self.edsm_status_label = self.auth_page.edsm_status_label
        self.eddn_enabled_var = self.auth_page.eddn_enabled_var
        self.inara_key_entry = self.auth_page.inara_key_entry
        self.inara_name_entry = self.auth_page.inara_name_entry
        self.inara_status_label = self.auth_page.inara_status_label
        self._capi_refresh_status()

    def _on_eddn_toggle(self, checked: bool):
        """Сохранить выбор «публиковать в EDDN» из нативного чекбокса."""
        self.eddn_api.set_enabled(bool(checked))
        self.config["eddn_enabled"] = bool(checked)
        self.save_config()
        self.log(f"EDDN: публикация {'включена' if checked else 'выключена'}", "info")

    def _save_inara_settings(self):
        self.inara_api.set_credentials(self.inara_key_entry.text(), self.inara_name_entry.text())
        self.config["inara_api_key"] = self.inara_api.api_key
        self.config["inara_commander_name"] = self.inara_api.commander_name
        self.save_config()
        self.inara_status_label.set_status(
            tr("Inara: включена") if self.inara_api.enabled else tr("Inara: не настроена"),
            COLOR_MUTED)

    def _save_eddn_setting(self):
        self._on_eddn_toggle(bool(self.eddn_enabled_var.isChecked()))

    def _save_edsm_settings(self):
        self.edsm_api.set_credentials(self.edsm_key_entry.text(), self.edsm_name_entry.text())
        self.config["edsm_api_key"] = self.edsm_api.api_key
        self.config["edsm_commander_name"] = self.edsm_api.commander_name
        self.save_config()
        self.edsm_status_label.set_status(
            tr("EDSM: включён") if self.edsm_api.enabled else tr("EDSM: не настроен"),
            COLOR_MUTED)

    # ============================================================
    #  Инфографика пилота: крупные плитки, спарклайны, компактный режим
    # ============================================================
    # Сколько точек держим в спарклайнах (при шаге 2 с — около 6 минут).
    PILOT_SERIES_LIMIT = 180
    PILOT_SAMPLE_SECONDS = 2.0
    PILOT_REFRESH_INTERVAL_MS = 2500

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
        """Инфографика пилота на чистом Qt (helper_pages.PilotPage)."""
        from helper_pages import PilotPage

        self._pilot_init_state()
        self.pilot_page = None
        try:
            page = PilotPage(
                compact=self._pilot_compact,
                columns_provider=self._pilot_column_count,
                on_compact_changed=self._on_pilot_compact_changed_from_page,
                on_refresh=self._refresh_pilot_infographic,
                on_columns_changed=self._on_pilot_columns_changed,
            )
            self.tab_pilot._get_tk_layout("pack").addWidget(page)
            self._show_page(page)
            self.pilot_page = page
        except Exception as exc:
            self.log(f"Не удалось открыть инфографику пилота: {exc}", "error")
        if self.pilot_page is None:
            self._pilot_columns = 0
            return
        # Прежние имена: по ним обновление и тесты находят плитки и полосы.
        self._pilot_tiles = self.pilot_page.values
        self._pilot_tiles.update(self.pilot_page.subs)
        self._pilot_bars = self.pilot_page.bars
        self._pilot_canvases = {}
        self._pilot_updated_label = self.pilot_page.updated_label
        self._pilot_compact_var = self.pilot_page.compact_check
        self._pilot_columns = self.pilot_page.column_count()

    # -- раскладка ---------------------------------------------------------
    def _on_pilot_compact_changed_from_page(self, checked: bool):
        """Компактный режим переключили в нативной странице."""
        if getattr(self, "pilot_page", None) is None:
            return
        self._pilot_compact = bool(checked)
        self.config["pilot_compact"] = self._pilot_compact
        self.save_config()
        self.pilot_page._rebuild_tiles(self._pilot_column_count())
        self._pilot_columns = self.pilot_page.column_count()
        self._refresh_pilot_infographic()

    def _on_pilot_compact_changed(self):
        """Совместимость: тот же обработчик для прежнего чекбокса."""
        self._on_pilot_compact_changed_from_page(bool(self._pilot_compact_var.isChecked()))

    def _on_pilot_columns_changed(self):
        """Страница перестроила плитки при изменении ширины окна."""
        if getattr(self, "pilot_page", None) is None:
            return
        self._pilot_columns = self.pilot_page.column_count()
        self._refresh_pilot_infographic()

    def _on_pilot_resize(self, _event=None):
        self._on_pilot_columns_changed()

    def _rebuild_pilot_layout_if_needed(self):
        if getattr(self, "pilot_page", None) is None:
            return
        if self.pilot_page.column_count() != self._pilot_column_count():
            self.pilot_page._rebuild_tiles(self._pilot_column_count())
            self._refresh_pilot_infographic()
        self._pilot_columns = self.pilot_page.column_count()

    def _rebuild_pilot_layout(self):
        """Пересобрать плитки под текущую ширину окна."""
        if getattr(self, "pilot_page", None) is None:
            return
        self.pilot_page._rebuild_tiles(self._pilot_column_count())
        self._pilot_columns = self.pilot_page.column_count()

    def _pilot_window_width(self) -> int:
        try:
            width = int(self.root.winfo_width())
        except Exception:
            width = 0
        # До первого отображения окно сообщает ширину 1 px, хотя геометрия уже
        # задана как 1180 px. Не строим заранее заведомо неверную раскладку.
        return width if width >= 400 else 1180

    def _pilot_column_count(self) -> int:
        from helper_pages import pilot_columns

        return pilot_columns(self._pilot_window_width(), self._pilot_compact)

    # -- обновление --------------------------------------------------------
    def _pilot_is_visible(self) -> bool:
        """Инфографика обновляется только пока её страница показана."""
        try:
            return self.notebook.select() == str(self.tab_pilot)
        except Exception:
            return False

    def _pilot_cancel_refresh(self):
        job = getattr(self, "_pilot_refresh_job", None)
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass
            self._pilot_refresh_job = None

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
            ship_name = state.get("ship_type") or tr("Корабль не определён")
            services = " / ".join(
                name for name, enabled in (
                    ("ED", self.api.is_connected), ("Raven", self.raven_api.is_connected),
                    ("EDSM", self.edsm_api.enabled), ("Inara", self.inara_api.enabled),
                ) if enabled
            ) or tr("нет подключений")
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
            self._pilot_set("kpi_tons_sub", tr(
                "на маршрут {route} t · на стройки {site} t",
                route=f"{self._session_route_cargo_tons:.0f}",
                site=f"{self._session_construction_cargo_tons:.0f}"))
            self._pilot_set("kpi_deliveries", str(self._session_deliveries))
            self._pilot_set("kpi_deliveries_sub",
                            tr("событий в сессии: {count}", count=event_count))
            self._pilot_set("kpi_cargo", f"{cargo:.0f} / {capacity:.0f} t")
            self._pilot_set("kpi_cargo_sub",
                            tr("трюм заполнен на {percent}%", percent=f"{cargo_percent:.0f}"))
            self._pilot_set("kpi_systems", str(len(self._session_systems_visited)))
            self._pilot_set("kpi_systems_sub",
                            tr("маршрут: {visited}/{total}", visited=visited,
                               total=route_total) if route_total
                            else tr("маршрут не загружен"))

            # --- динамика ---
            self._pilot_set("session_rate",
                            tr("{rate} t/час", rate=f"{self._pilot_rate():.0f}"))
            self._pilot_set("session_construction", f"{self._session_construction_cargo_tons:.0f} t")
            self._pilot_set("session_route", f"{self._session_route_deliveries} / {self._session_route_cargo_tons:.0f} t")

            # --- корабль ---
            self._pilot_set("ship", ship_name)
            self._pilot_set("modules", tr("{healthy}/{total} исправны",
                                          healthy=total_modules - damaged,
                                          total=total_modules))
            for key, value in {
                "hull_bar": self._pilot_percent(state.get("hull_percent")),
                "shield_bar": self._pilot_percent(state.get("shield_percent")),
                "fuel_bar": self._pilot_percent(state.get("fuel_percent")),
                "power_bar": self._pilot_percent(state.get("power_percent")),
            }.items():
                if getattr(self, "pilot_page", None) is not None:
                    self.pilot_page.set_bar(key, value)

            # --- маршрут ---
            self._pilot_set("route_status",
                            tr("{visited}/{total} систем", visited=visited,
                               total=route_total) if route_total
                            else tr("не загружен"))
            if getattr(self, "pilot_page", None) is not None:
                self.pilot_page.set_bar("route_progress", route_percent)
            overlay_data = self._get_overlay_data()
            self._pilot_set("route_current", str(overlay_data.get("current", "—")))
            self._pilot_set("route_next", str(overlay_data.get("next", "—")))
            self._pilot_set("route_remaining", str(max(0, route_total - visited)))
            self._pilot_set("last_delivery", self._last_delivery_system or "—")

            # --- статус и подключения ---
            self._pilot_set("commander",
                            self._current_cmdr_name() or tr("CMDR не определён"))
            self._pilot_set("system", current)
            game_text = (tr("запущена (в фокусе)") if game_state.focused
                         else (tr("запущена") if game_state.running else tr("не запущена")))
            if game_state.error:
                game_text = tr("нет данных ({error})", error=game_state.error)
            self._pilot_set("game", game_text)
            self._pilot_set("watcher",
                            tr("АКТИВЕН") if self.watcher_active else tr("остановлен"))
            self._pilot_set("services", services)
            if exobio:
                genera = ", ".join(row["genus"] for row in (exobio.get("predictions") or [])[:3])
                exobio_text = tr("{body}: {signals} сигналов",
                                 body=exobio.get("body"),
                                 signals=exobio.get("bio_signals", 0))
                if genera:
                    exobio_text += f" · {genera}"
            else:
                exobio_text = tr("тело не отсканировано")
            self._pilot_set("exobio", exobio_text)

            # --- журналы и экономика ---
            self._pilot_set("balance", f"{int(state.get('balance', 0) or 0):,} cr".replace(",", " "))
            self._pilot_set("rebuy", f"{int(state.get('rebuy', 0) or 0):,} cr".replace(",", " "))
            self._pilot_set("legal", state.get("legal_state") or tr("неизвестно"))
            self._pilot_set("journal_state", self._pilot_journal_state())
            self._pilot_set("event_summary",
                            tr("{count} событий", count=event_count) if event_count
                            else tr("ожидание событий"))
            self._pilot_set("last_event", (self._last_session_event or "—")[:48])

            # --- графики ---
            if getattr(self, "pilot_page", None) is None:
                return
            self.pilot_page.set_spark(self._pilot_series["tons"])
            rows = sorted(getattr(self, "_session_tons_by_system", {}).items(),
                          key=lambda item: item[1], reverse=True)
            self.pilot_page.set_systems(rows)
            self.pilot_page.set_updated(datetime.now().strftime("%H:%M:%S"))
        except Exception:
            # Инфографика не должна мешать watcher/UI при неполном состоянии
            # трекера во время самого первого чтения Journal.
            pass
        # Обновление идёт ровно одной цепочкой: кнопка «Обновить» и смена
        # раскладки не должны плодить параллельные таймеры.
        if (self._pilot_refresh_job is None and self._pilot_is_visible()
                and self.root.winfo_exists()):
            self._pilot_refresh_job = self.root.after(
                self.PILOT_REFRESH_INTERVAL_MS, self._pilot_tick)

    def _pilot_tick(self):
        """Обновлять плитки только на видимой странице и не чаще 0,4 Гц."""
        self._pilot_refresh_job = None
        if self._pilot_is_visible():
            self._refresh_pilot_infographic()

    def _pilot_set(self, key: str, text: str):
        """Записать значение в плитку нативной страницы."""
        page = getattr(self, "pilot_page", None)
        if page is not None:
            try:
                page.set_value(key, text)
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
            return tr("папка журналов не выбрана")
        return tr("{count} файлов · {state}", count=count,
                  state=tr("слежение") if self.watcher_active else tr("ожидание"))

    # ============================================================
    #  Вкладка: Загрузка логов
    # ============================================================
    def _build_tab_upload(self):
        """Вкладка «Загрузка логов» на чистом Qt (helper_pages.UploadPage)."""
        from helper_pages import UploadPage, UploadPageActions

        actions = UploadPageActions(
            select_files=self._on_select_files,
            upload=self._on_upload,
            toggle_watcher=self._on_toggle_watcher,
            reset_import_cache=self._reset_import_cache,
            reset_server_journals=self._reset_server_journals,
            skip_imported=self._on_skip_imported_changed,
            backfill_third_party=self._on_backfill_third_party_changed,
        )
        self.upload_page = UploadPage(
            skip_imported=bool(self.skip_imported_files),
            backfill_enabled=bool(self.dispatcher.backfill_enabled),
            actions=actions,
        )
        self.tab_upload._get_tk_layout("pack").addWidget(self.upload_page)
        self._show_page(self.upload_page)

        # Имена, которыми пользуется остальной код и тесты: это те же виджеты.
        self.select_files_btn = self.upload_page.select_btn
        self.upload_btn = self.upload_page.upload_btn
        self.watcher_btn = self.upload_page.watcher_btn
        self.files_label = self.upload_page.files_label
        self.progress = self.upload_page.progress
        self.progress_label = self.upload_page.progress_label
        self.skip_imported_var = self.upload_page.skip_imported_var
        self.backfill_third_party_var = self.upload_page.backfill_third_party_var
        self.reset_cache_btn = self.upload_page.reset_cache_btn
        self.reset_server_btn = self.upload_page.reset_server_btn

        self.selected_files: list[Path] = []

    def _on_skip_imported_changed(self, checked=None):
        if checked is None:
            checked = self.skip_imported_var.isChecked()
        self.skip_imported_files = bool(checked)
        self.config["skip_imported_files"] = self.skip_imported_files
        self.save_config()

    def _on_backfill_third_party_changed(self, checked=None):
        if checked is None:
            checked = self.backfill_third_party_var.isChecked()
        enabled = bool(checked)
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
        """Вкладка «Маршрут» на чистом Qt (helper_pages.RoutePage)."""
        from helper_pages import RoutePage, RoutePageActions

        actions = RoutePageActions(
            import_route=self._on_import_route,
            export_csv=self._on_export_route,
            import_atlas=self._on_import_atlas_route,
            clear=self._on_clear_route,
        )
        self.route_page = RoutePage(actions)
        self.tab_route._get_tk_layout("pack").addWidget(self.route_page)
        self._show_page(self.route_page)

        # Имена, которыми пользуется остальной код и тесты: это те же виджеты.
        self.route_tree = self.route_page.table
        self.route_counter = self.route_page.counter

    # ============================================================
    #  Вкладка: Колонизатор (Raven Colonial)
    # ============================================================
    # ============================================================
    #  Вкладка: Колонизатор
    # ============================================================
    def _build_tab_colony(self):
        """Вкладка «Колонизатор» на чистом Qt (helper_pages.ColonyPage)."""
        from helper_pages import ColonyPage, ColonyPageActions

        actions = ColonyPageActions(
            refresh=self._on_colony_refresh,
            select=self._on_colony_select,
            open_project=self._on_colony_open_project,
            set_primary=self._on_colony_set_primary,
            clear_primary=self._on_colony_clear_primary,
            complete=self._on_colony_complete,
            copy_id=self._on_colony_copy_id,
            bind_site=self._on_colony_bind_site,
            unbind_site=self._on_colony_unbind_site,
            fill_current=self._on_colony_fill_current,
            reconcile=self._on_colony_reconcile,
            options_changed=self._on_colony_options_changed,
            plan_selected=self._on_colony_plan_selected,
            body_choices=self._colony_refresh_body_choices,
            body_selected=self._colony_sync_body_num,
            create=self._on_colony_create,
            clear_form=self._on_colony_clear_form,
            check_system=self._on_colony_check_system,
        )
        self.colony_page = ColonyPage(
            cmdr=self._current_cmdr_name(),
            autofill=bool(self.config.get("colony_autofill", True)),
            open_page_after_create=bool(self.config.get("colony_open_page_after_create", True)),
            actions=actions,
        )
        self.colony_page.set_combo_values(
            "buildType", [build_type_label(code) for code, _ru, _en in BUILD_TYPES])
        self.tab_colony._get_tk_layout("pack").addWidget(self.colony_page)
        self._show_page(self.colony_page)

        # Имена, которыми пользуется остальной код и тесты: это те же виджеты.
        self.colony_cmdr_entry = self.colony_page.cmdr_entry
        self.colony_tree = self.colony_page.table
        self.colony_action_buttons = self.colony_page.action_buttons
        self.colony_status = self.colony_page.status_label
        self.colony_key_label = self.colony_page.key_label
        self.colony_site_label = self.colony_page.site_label
        self.colony_fields = self.colony_page.fields
        self.colony_entries = self.colony_page.fields
        self.colony_body_entry = self.colony_page.body_combo
        self.colony_site_plan_combo = self.colony_page.plan_combo
        self.colony_primary_port_check = self.colony_page.primary_port_check
        self.colony_starpos_entry = self.colony_page.starpos_entry
        self.colony_commodities_entry = self.colony_page.commodities_entry
        self.colony_create_btn = self.colony_page.create_btn
        self.colony_autofill_check = self.colony_page.autofill_check
        self.colony_open_page_check = self.colony_page.open_page_check
        self._colony_site_plans: list = []

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
            self.colony_page.set_key_status(tr("RCC ключ задан"), COLOR_GREEN)
        else:
            self.colony_page.set_key_status(tr("RCC ключ не задан — только просмотр"),
                                            COLOR_ORANGE)

    def _selected_colony_project(self) -> Optional[dict]:
        if getattr(self, "colony_page", None) is None:
            return None
        values = self.colony_page.selected_values()
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
        self.colony_page.set_actions_enabled(bool(project and project["buildId"]))
        if project:
            self.colony_page.set_status(f"{project['systemName']}: {project['buildName']} "
                     f"({project['buildType']}) — {project['progress']}"
            )

    def _set_colony_busy(self, busy: bool, text: str = ""):
        """Блокируем кнопки на время запроса, чтобы не спамить Raven."""
        page = getattr(self, "colony_page", None)
        if page is None:
            return
        page.set_actions_enabled(not busy)
        page.set_create_enabled(not busy)
        if text:
            page.set_status(text)
        if not busy:
            self._on_colony_select()

    # ---------- Колонизатор: запросы (в фоне) ----------
    def _on_colony_refresh(self):
        cmdr = self.colony_page.cmdr_text().strip()
        if not cmdr:
            self.log("Укажите имя командира для поиска проектов.", "warn")
            return
        self._set_colony_busy(True, tr("Загружаю проекты Raven Colonial…"))
        threading.Thread(target=self._colony_refresh_thread, args=(cmdr,), daemon=True).start()

    def _colony_refresh_thread(self, cmdr: str):
        result = self.raven_api.get_cmdr_active(cmdr)
        primary = self.raven_api.get_primary(cmdr) if result.get("ok") else {"ok": False}
        self.after(0, lambda: self._colony_refresh_done(result, primary))

    def _colony_refresh_done(self, result: dict, primary: dict):
        self._set_colony_busy(False)
        if not result.get("ok"):
            self.colony_page.set_status(
                tr("Не удалось загрузить проекты: {error}", error=result.get("error")))
            self.log(f"Raven Colonial: не удалось получить проекты — {result.get('error')}", "error")
            return

        data = result.get("data")
        projects = self._extract_colony_projects(data)
        primary_id = self._extract_primary_id(primary)
        self._fill_colony_tree(projects, primary_id)
        self.colony_page.set_status(tr("Проектов: {count}", count=len(projects)))
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
        rows = []
        for project in projects:
            build_id = str(project.get("buildId", "") or "")
            is_primary = bool(primary_id and build_id and build_id == primary_id)
            build_type = str(project.get("buildType", "") or "")
            rows.append((
                "★" if is_primary else "",
                str(project.get("systemName", "") or ""),
                str(project.get("buildName", "") or ""),
                build_type,
                self._project_progress(project),
                build_id,
            ))
        self.colony_page.set_rows(rows)
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

    def _colony_build_type_code(self) -> str:
        """Код Raven из поля «Тип постройки»: выбран из списка или введён кодом."""
        raw = (self.colony_page.value("buildType") or "").strip()
        if not raw:
            return ""
        if raw in BUILD_TYPE_CODES:
            return raw
        for code in BUILD_TYPE_CODES:
            if build_type_label(code) == raw:
                return code
        return normalize_build_type(raw) or ""

    def _colony_body_choices(self) -> dict:
        """Тела системы формы: {имя тела: BodyID}, из журнала и сканов.

        BodyID — номер тела в системе (как в журнале и у Raven): по нему Raven
        ставит проект на нужное тело. Порядок — звезда, планеты, луны.
        """
        system = (self.colony_page.value("systemName") or "").strip()
        try:
            snapshot = self.system_map.snapshot(system)
        except Exception:
            return {}
        choices = {}
        for body in getattr(snapshot, "bodies", []) or []:
            if body.name and body.name not in choices:
                choices[body.name] = body.body_id
        return choices

    def _colony_refresh_body_choices(self):
        """Список тел для выпадающего меню «Тело» (вызывается при раскрытии)."""
        if getattr(self, "colony_page", None) is None:
            return
        try:
            self.colony_page.set_combo_values("bodyName",
                                              list(self._colony_body_choices()))
        except Exception:
            pass

    def _colony_sync_body_num(self):
        """BodyID подставляем по выбранному телу; неизвестное тело не трогаем."""
        name = (self.colony_page.value("bodyName") or "").strip()
        if not name:
            return
        body_id = self._colony_body_choices().get(name)
        if body_id is not None:
            self.colony_page.set_value("bodyNum", str(int(body_id)))

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
        raw = str(self.colony_page.value("marketId") or "").strip()
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
        self.colony_page.set_status(
            tr("Площадка {site} → проект «{project}»", site=market_id, project=name))

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
        self.colony_page.set_status(tr("Привязка площадки {site} снята", site=market_id))
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
        cmdr = self.colony_page.cmdr_text().strip()
        if not cmdr:
            self.log("Укажите имя командира.", "warn")
            return
        self._set_colony_busy(True, tr("Назначаю основной проект…"))
        # Запоминаем сразу: блок CARRIER должен показать материалы этого
        # проекта, не дожидаясь ответа сервера и обновления списка.
        cached = (getattr(self, "_colony_projects_cache", {}) or {}).get(project["buildId"])
        self.colony_primary_project = dict(cached or project)
        threading.Thread(target=self._colony_simple_call_thread,
                         args=("set_primary", (cmdr, project["buildId"]),
                               tr("Основной проект: {name}", name=project["buildName"])),
                         daemon=True).start()

    def _on_colony_clear_primary(self):
        cmdr = self.colony_page.cmdr_text().strip()
        if not cmdr:
            self.log("Укажите имя командира.", "warn")
            return
        self._set_colony_busy(True, tr("Снимаю основной проект…"))
        self.colony_primary_project = {}
        threading.Thread(target=self._colony_simple_call_thread,
                         args=("clear_primary", (cmdr,), tr("Основной проект снят")),
                         daemon=True).start()

    def _on_colony_complete(self):
        project = self._selected_colony_project()
        if not project:
            return
        if not ask_yes_no(
            tr("Завершить проект"),
            tr("Отметить «{name}» ({system}) завершённым?\nЭто действие необратимо.",
               name=project["buildName"], system=project["systemName"]),
            parent=self.root,
        ):
            return
        self._set_colony_busy(True, tr("Завершаю проект…"))
        threading.Thread(target=self._colony_simple_call_thread,
                         args=("mark_complete", (project["buildId"],), tr("Проект завершён")),
                         daemon=True).start()

    def _colony_simple_call_thread(self, method_name: str, args: tuple, success_text: str):
        method = getattr(self.raven_api, method_name, None)
        result = (method(*args) if method
                  else {"ok": False,
                        "error": tr("нет метода {name}", name=method_name)})
        self.after(0, lambda: self._colony_action_done(result, success_text))

    def _colony_action_done(self, result: dict, success_text: str):
        cmdr = self.colony_page.cmdr_text().strip()
        if result.get("ok"):
            self.log(f"Raven Colonial: {success_text}", "success")
            self.colony_page.set_status(success_text)
            if cmdr:
                self._on_colony_refresh()
            else:
                self._set_colony_busy(False)
        else:
            self._set_colony_busy(False)
            error = result.get("error") or tr("неизвестная ошибка")
            self.colony_page.set_status(tr("Ошибка: {error}", error=error))
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
                              tr("Проект {name}", name=project["buildName"]))

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

    def _on_colony_options_changed(self):
        """Галочки формы создания сохраняем сразу, без кнопки «Применить»."""
        self.config["colony_autofill"] = bool(self.colony_autofill_check.isChecked())
        self.config["colony_open_page_after_create"] = bool(
            self.colony_open_page_check.isChecked())
        self.save_config()

    def _update_colony_site_label(self):
        """Подпись под кнопкой автозаполнения: что известно из журнала."""
        page = getattr(self, "colony_page", None)
        if page is None:
            return
        site = self.construction.site
        if site is None or not site.market_id:
            page.set_site_text(
                tr("Стройплощадка не найдена — пристыкуйтесь к Construction Ship / площадке."),
                COLOR_MUTED)
            return
        docked = tr("вы на площадке") if site.docked else tr("последняя посещённая площадка")
        color = COLOR_GREEN if site.has_depot else COLOR_ORANGE
        page.set_site_text(f"{site.summary()} · {docked}", color)

    # ---------- Колонизатор: автозаполнение из журнала ----------
    def _colony_form_snapshot(self) -> dict:
        """Снимок формы: по нему видно, правил ли пользователь поля руками."""
        page = getattr(self, "colony_page", None)
        if page is None:
            return {}
        snapshot = {key: page.value(key) for key in page.fields}
        snapshot["_commodities"] = page.commodities_entry.text()
        snapshot["_primary"] = bool(page.primary_port_check.isChecked())
        snapshot["_starpos"] = page.starpos_entry.text()
        snapshot["_plan"] = page.plan_text()
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
        self.colony_page.set_value("systemName", system)
        address = getattr(state, "system_address", 0) or 0
        if address:
            self.colony_page.set_value("systemAddress", str(address))
        market_id = str(self._last_depot_state.get("_market_id", "") or "")
        if market_id and market_id != "0":
            self.colony_page.set_value("marketId", market_id)
        if not self.colony_page.value("architectName"):
            self.colony_page.set_value("architectName", self._current_cmdr_name())
        self._colony_form_baseline = self._colony_form_snapshot()
        self.log(f"Подставлена текущая система: {system} (без данных стройплощадки)", "info")
        self._fetch_colony_site_context(system)

    def _colony_autofill_from_site(self, site, auto: bool = False):
        """Заполнить форму создания проекта данными стройплощадки из журнала."""
        if site is None or not site.market_id:
            self.log("Стройплощадка не найдена: в журнале нет ColonisationConstructionDepot.", "warn")
            return

        self.colony_page.set_value("systemName", site.system_name or "")
        self.colony_page.set_value("marketId", str(site.market_id))
        self.colony_page.set_value("systemAddress", str(site.system_address or ""))
        self.colony_starpos_entry.setText(
            ", ".join(f"{value:.4f}" for value in site.star_pos) if site.star_pos else ""
        )
        self.colony_page.set_value("bodyName", site.body_name or "")
        self.colony_page.set_value("bodyNum", "" if site.body_num is None else str(site.body_num))
        self.colony_page.set_value("maxNeed", str(site.total_required) if site.total_required else "")
        self.colony_primary_port_check.setChecked(bool(site.is_primary_port))

        # Название подставляем только если поле пустое или заполнено нами же
        # ранее: переименовывать проект за пользователем не нужно.
        current_name = self.colony_page.value("buildName").strip()
        if not current_name or current_name == getattr(self, "_colony_autofilled_name", ""):
            suggested = site.suggested_name
            self.colony_page.set_value("buildName", suggested)
            self._colony_autofilled_name = suggested

        if not self.colony_page.value("architectName").strip():
            architect = self.construction.commander or self._current_cmdr_name()
            if architect:
                self.colony_page.set_value("architectName", architect)

        remaining = site.remaining_by_commodity()
        if remaining:
            self.colony_commodities_entry.setText(format_commodities(remaining))
        elif not site.has_depot:
            self.log(
                "Ресурсы площадки ещё не получены: зайдите в Construction Services "
                "на площадке — тогда подставятся потребности по товарам.", "warn",
            )

        self._colony_draft_site = site
        self._colony_form_baseline = self._colony_form_snapshot()
        self._update_colony_site_label()
        prefix = tr("Автозаполнение") if auto else tr("Форма заполнена")
        self.log(f"{prefix}: {site.summary()}", "success" if site.has_depot else "info")
        self.colony_page.set_status(site.summary())
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
            if name and not self.colony_page.value("architectName").strip():
                self.colony_page.set_value("architectName", name)
                self._colony_form_baseline = self._colony_form_snapshot()
                self.log(f"Raven Colonial: архитектор системы {system} — {name}", "info")

        if not sites.get("ok"):
            return
        plans = self._extract_site_plans(sites.get("data"))
        self._colony_site_plans = plans
        labels = [self.colony_page.plan_none_label()] + [
            self._site_plan_label(plan) for plan in plans
        ]
        try:
            self.colony_page.set_plan_labels(labels)
        except Exception:
            pass
        if plans:
            self.log(
                f"Raven Colonial: в системе {system} запланировано площадок — {len(plans)}", "info")
            # Один план — выбираем его сами: тип и тело возьмутся из плана.
            if len(plans) == 1 and self.colony_page.plan_none_selected():
                self.colony_page.set_plan_text(labels[1])
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
            index = int(self.colony_page.plan_index())
        except Exception:
            index = 0
        if index <= 0 or index - 1 >= len(self._colony_site_plans):
            self._colony_selected_site_id = ""
            return
        plan = self._colony_site_plans[index - 1]
        self._colony_selected_site_id = plan["id"]
        if plan.get("buildType") and not self._colony_build_type_code():
            code = normalize_build_type(plan["buildType"])
            if code:
                self.colony_page.set_value("buildType", build_type_label(code))
            else:
                self.log(f"Тип «{plan['buildType']}» из плана Raven не входит в справочник — "
                         "выберите тип вручную.", "warn")
        if plan.get("bodyName") and not self.colony_page.value("bodyName").strip():
            self.colony_page.set_value("bodyName", plan["bodyName"])
        if plan.get("bodyNum") not in (None, "") and not self.colony_page.value("bodyNum").strip():
            self.colony_page.set_value("bodyNum", str(plan["bodyNum"]))
        if not self.colony_page.value("buildName").strip():
            self.colony_page.set_value("buildName", plan.get("name") or "")
        self._colony_form_baseline = self._colony_form_snapshot()
        self.log(f"Выбран план площадки: {self._site_plan_label(plan)}", "info")

    def _on_colony_clear_form(self):
        self.colony_page.clear_fields()
        self.colony_starpos_entry.setText("")
        self.colony_commodities_entry.setText("")
        self.colony_primary_port_check.setChecked(False)
        self.colony_page.set_plan_none()
        self._colony_selected_site_id = ""
        self._colony_draft_site = None
        self._colony_autofilled_name = ""
        self._colony_form_baseline = self._colony_form_snapshot()
        self.colony_page.set_status(tr("Форма очищена"))
        self._update_colony_site_label()

    def _on_colony_check_system(self):
        """Есть ли уже проект на этой площадке/в этой системе?

        Создание проекта, который уже существует, Raven отклоняет, а сообщение
        об этом приходит только после запроса. Дешевле проверить заранее.
        """
        system = self.colony_page.value("systemName").strip()
        address = self.colony_page.value("systemAddress").strip()
        market_id = self.colony_page.value("marketId").strip()
        if not (system or address or market_id):
            self.log("Заполните систему, Market ID или System address.", "warn")
            return
        self.colony_page.set_status(tr("Проверяю площадку в Raven Colonial…"))
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
            error = (result or {}).get("error") if isinstance(result, dict) else tr("нет ответа")
            self.colony_page.set_status(tr("Проверить не удалось: {error}", error=error))
            self.log(f"Raven Colonial: проверка площадки — {error}", "warn")
            return
        projects = self._extract_colony_projects(result.get("data"))
        if not projects:
            self.colony_page.set_status(
                tr("Проекта на этой площадке нет — можно создавать."))
            self.log("Raven Colonial: активного проекта на площадке нет", "success")
            return
        names = ", ".join(f"{p.get('buildName')} ({p.get('buildId')})" for p in projects[:3])
        self.colony_page.set_status(
            tr("Внимание: в системе уже есть проект — {names}", names=names))
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
        build_name = self.colony_page.value("buildName").strip()
        system = self.colony_page.value("systemName").strip()
        missing = [
            title for key, title in (("marketId", "Market ID"),
                                     ("systemAddress", "System address"),
                                     ("buildName", tr("Название *")))
            if not self.colony_page.value(key).strip()
        ]
        if missing:
            hint = ""
            if site is None and {"Market ID", "System address"} & set(missing):
                hint = tr("Пристыкуйтесь к стройплощадке и нажмите «Заполнить из журнала».")
            self.log(f"Raven Colonial требует заполнить: {', '.join(missing)}. {hint}", "warn")
            self.colony_page.set_status(tr(
                "Не заполнены обязательные поля: {fields}",
                fields=", ".join(tr(title) for title in missing)))
            return

        build_code = self._colony_build_type_code()
        if not build_code:
            self.log("Выберите тип постройки из списка: только такие коды открываются "
                     "на Raven Colonial.", "warn")
            self.colony_page.set_status(tr("Не выбран тип постройки"))
            return
        self._colony_sync_body_num()

        def as_int(key: str) -> Optional[int]:
            raw = self.colony_page.value(key).strip()
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
        if site is not None and str(site.market_id) != str(self.colony_page.value("marketId").strip()):
            site = None

        # Форма — источник истины: даже если площадка известна, командир мог
        # поправить любое поле руками. Из площадки берём только то, чего в
        # форме нет (событие депота, starPos).
        project = build_project_draft(
            site,
            build_name=build_name,
            build_type=build_code,
            architect_name=self.colony_page.value("architectName").strip(),
            discord_link=self.colony_page.value("discordLink").strip(),
            notes=self.colony_page.value("notes").strip(),
            is_primary_port=bool(self.colony_primary_port_check.isChecked()),
            commanders={cmdr: [] for cmdr in [self.colony_page.cmdr_text().strip()] if cmdr},
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
        if self.colony_page.value("bodyName").strip():
            project["bodyName"] = self.colony_page.value("bodyName").strip()
        commodities = self._parse_commodities(self.colony_commodities_entry.text())
        if commodities:
            project["commodities"] = commodities

        cmdr = self.colony_page.cmdr_text().strip()
        open_page = bool(self.colony_open_page_check.isChecked())
        self._set_colony_busy(True, tr("Создаю проект…"))
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
            system = self.colony_page.value("systemName")
            name = f"{system}: {self.colony_page.value('buildName')}".strip(": ")
            message = tr("Raven Colonial: проект создан — {name}", name=name)
            if build_id:
                message += f" (buildId {build_id})"
            self.log(message, "success")
            if result.get("link_error"):
                self.log(
                    f"Raven Colonial: проект создан, но не привязан к командиру — "
                    f"{result['link_error']}", "warn",
                )
            self.colony_page.set_status(
                tr("Проект создан, buildId: {build_id}", build_id=build_id or "—"))
            if build_id and open_page:
                self._colony_open_url(project_url(build_id), tr("Проект {name}", name=name))
            if cmdr:
                self._on_colony_refresh()
        else:
            error = result.get("error") or tr("неизвестная ошибка")
            self.colony_page.set_status(
                tr("Создать проект не удалось: {error}", error=error))
            self.log(f"Raven Colonial: проект не создан — {error}", "error")


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

    def _build_tab_factions(self):
        """Вкладка «Фракции» на чистом Qt (qt_factions.FactionInfographic)."""
        from qt_factions import FactionInfographic
        self.faction_infographic = FactionInfographic(
            locale=self.config.get("site_locale"), site_url=self.api.site_url)
        self.tab_factions._get_tk_layout("pack").addWidget(self.faction_infographic)
        self._show_page(self.faction_infographic)
        self._render_factions_infographic()

    def _update_faction_infographic(self,event:dict):
        if not isinstance(event,dict) or event.get("event") not in ("FSDJump","Location","CarrierJump"):
            return
        system=str(event.get("StarSystem") or "").strip()
        if not system:return
        timestamp=str(event.get("timestamp") or "")
        lock=getattr(self,"_faction_state_lock",None)
        if lock is None:self._faction_state_lock=lock=threading.RLock()
        with lock:
            previous_at=str(getattr(self,"_faction_updated_at",""))
            if timestamp and previous_at and timestamp < previous_at:return
            self._faction_system=system
            self._faction_updated_at=timestamp or previous_at
            control=event.get("SystemFaction")
            self._faction_controlling=str(control.get("Name") or "") if isinstance(control,dict) else ""
            items=[]
            for faction in event.get("Factions") or []:
                if not isinstance(faction,dict) or not str(faction.get("Name") or "").strip():continue
                try:influence=max(0.0,min(1.0,float(faction.get("Influence") or 0.0)))
                except (TypeError,ValueError):influence=0.0
                states=[]
                for state in faction.get("ActiveStates") or []:
                    if isinstance(state,dict) and state.get("State"):states.append(str(state["State"]))
                items.append({"name":str(faction["Name"]).strip(),"influence":influence,
                              "allegiance":str(faction.get("Allegiance") or ""),
                              "government":str(faction.get("Government") or ""),
                              "state":str(faction.get("FactionState") or ""),"active_states":states})
            self._faction_presence=sorted(items,key=lambda item:(-item["influence"],item["name"].casefold()))
        if hasattr(self,"faction_cards_frame"):
            self.after(0,self._render_factions_infographic)

    def _render_factions_infographic(self):
        widget=getattr(self,"faction_infographic",None)
        if widget is None:return
        with self._faction_state_lock:
            system=self._faction_system
            control=self._faction_controlling
            factions=list(self._faction_presence)
        widget.set_snapshot(system,control,factions)

    # Legacy renderer remains unreferenced; the system-map tab is removed.
    def _select_map_object(self, key: str):
        self._map_selected = str(key or "")
        self._draw_system_map(self._map_last_snapshot)
        self._map_sync_tree_selection()
        self._map_show_details(self._map_selected)

    def _copy_map_text(self, text: str, hint: str = ""):
        try:
            import pyperclip

            pyperclip.copy(text)
        except Exception:
            try:
                self.root.clipboard_clear()
                self.root.clipboard_append(text)
            except Exception:
                pass
        if hint is not None:
            self._map_set_hint(hint or tr("Скопировано"))

    def _fetch_external_scans_if_needed(self, system_name: str, force: bool = False):
        """Запросить сканы тел системы из БД проекта или EDSM в фоновом потоке."""
        system = str(system_name or "").strip()
        if not system:
            return

        now = time.time()
        if not hasattr(self, "_map_external_scans_fetched"):
            self._map_external_scans_fetched = {}
        last_fetch = self._map_external_scans_fetched.get(system, 0.0)
        if not force and (now - last_fetch) < 180.0:
            return
        self._map_external_scans_fetched[system] = now

        def worker():
            bodies = []
            source_name = "БД проекта"
            try:
                # 1. Запрос в БД проекта
                if getattr(self, "api_client", None) and hasattr(self.api_client, "get_system_scans"):
                    res = self.api_client.get_system_scans(system)
                    if res.get("ok") and res.get("bodies"):
                        bodies = res["bodies"]
                        source_name = "БД проекта"

                # 2. Если в БД нет данных, запрашиваем EDSM
                if not bodies and getattr(self, "edsm_api", None) and hasattr(self.edsm_api, "fetch_system_bodies"):
                    res = self.edsm_api.fetch_system_bodies(system)
                    if res.get("ok") and res.get("bodies"):
                        bodies = res["bodies"]
                        source_name = "EDSM"
                        # Кэшируем в БД проекта для других командиров
                        if getattr(self, "api_client", None) and hasattr(self.api_client, "upload_system_scans"):
                            self.api_client.upload_system_scans(system, bodies)
            except Exception as exc:
                self.log(f"Внешние сканы {system}: {exc}")
                return

            if bodies:
                self.root.after(0, lambda: self._on_external_scans_received(system, bodies, source_name))

        threading.Thread(target=worker, daemon=True, name=f"ExtScans-{system}").start()

    def _on_external_scans_received(self, system: str, bodies: list, source_name: str):
        if not bodies:
            return
        changed = self.system_map.load_external_bodies(bodies, source=source_name)
        if changed:
            self.log(f"Карта: получено {len(bodies)} тел из {source_name} (сканы других командиров)")
            self._map_schedule_redraw(0)

    def _queue_scan_for_upload(self, event: dict):
        if not isinstance(event, dict):
            return
        if not hasattr(self, "_scans_to_upload"):
            self._scans_to_upload = []
        body_data = {
            # Архитектору нужны не только название и посадочность: кольца,
            # радиус, атмосфера, вулканизм и сигналы определяют доступные
            # слоты и предупреждения по телу. Отправляем те же поля, которые
            # понимает POST /api/atlas/system-bodies.
            "system_name": event.get("StarSystem") or self.system_map.current_system,
            "body_name": event.get("BodyName"),
            "body_id": event.get("BodyID"),
            "body_type": "Star" if event.get("StarType") else "Planet",
            "sub_type": event.get("PlanetClass") or event.get("StarType"),
            "distance_ls": event.get("DistanceFromArrivalLS"),
            "semi_major_axis_ls": event.get("SemiMajorAxis"),
            "parents": event.get("Parents") or [],
            "radius_m": event.get("Radius"),
            "gravity": event.get("SurfaceGravity"),
            "earth_masses": event.get("MassEM"),
            "surface_pressure": event.get("SurfacePressure") or event.get("Pressure"),
            "surface_temp_k": event.get("SurfaceTemperature"),
            "atmosphere": event.get("Atmosphere") or event.get("AtmosphereType"),
            "atmosphere_type": event.get("AtmosphereType"),
            "atmosphere_composition": event.get("AtmosphereComposition") or [],
            "solid_composition": event.get("Composition") or {},
            "materials": event.get("Materials") or {},
            "volcanism": event.get("Volcanism"),
            "rings": event.get("Rings") or [],
            "signals": event.get("Signals") or [],
            "bio_genuses": event.get("Genuses") or [],
            "is_landable": bool(event.get("Landable")),
            "first_discovered_by": "Вы" if event.get("WasDiscovered") is False else None,
            "first_mapped_by": "Вы" if event.get("WasMapped") is False else None,
            "first_footfall_by": "Вы" if event.get("WasFootfall") is False else None,
        }
        self._scans_to_upload.append(body_data)
        if len(self._scans_to_upload) >= 5 or (time.time() - getattr(self, "_last_scan_upload_time", 0.0)) > 60.0:
            self._flush_scans_to_upload()

    def _flush_scans_to_upload(self):
        scans = getattr(self, "_scans_to_upload", [])
        if not scans or not getattr(self, "api_client", None) or not self.api_client.is_connected:
            return
        to_send = scans[:]
        self._scans_to_upload = []
        self._last_scan_upload_time = time.time()
        system = self.system_map.current_system

        def worker():
            try:
                result = self.api_client.upload_system_scans(
                    system, to_send, cmdr=self._current_cmdr_name() or None,
                )
                if not result.get("ok"):
                    # Не теряем сканы при кратком обрыве/401: они нужны
                    # Архитектору для расчёта слотов и сигналов. Следующий
                    # flush повторит тот же идемпотентный upsert.
                    self._scans_to_upload = to_send + getattr(self, "_scans_to_upload", [])
                    self.log(f"Сканы не отправлены, повторю позже: {result.get('error', 'ошибка')}", "warn")
            except Exception as exc:
                self._scans_to_upload = to_send + getattr(self, "_scans_to_upload", [])
                self.log(f"Сбой отправки сканов, повторю позже: {exc}", "warn")

        threading.Thread(target=worker, daemon=True, name="UploadScans").start()

    # ============================================================
    #  Frontier CAPI (досье пилота) — авторизация PKCE
    # ============================================================
    def _capi_set_status(self, text: str, ok: Optional[bool] = None):
        label = getattr(self, "capi_status", None)
        if not label:
            return
        color = COLOR_MUTED if ok is None else (COLOR_GREEN if ok else COLOR_RED)
        try:
            label.set_status(text, color)
        except AttributeError:
            try:
                label.config(text=text, foreground=color)
            except Exception:
                pass

    def _capi_open_site(self):
        """Открыть единственное место, где Frontier можно привязать/отвязать."""
        site = getattr(getattr(self, "api", None), "site_url", "") or ""
        if not site:
            self._capi_set_status(tr("Сначала подключите токен проекта"), ok=False)
            return
        url = localized_url(f"{site.rstrip('/')}/account/capi", self.config.get("site_locale"))
        try:
            webbrowser.open(url)
            self._capi_set_status(tr("Открыл страницу Frontier CAPI на сайте"), ok=None)
        except Exception as exc:
            self._capi_set_status(
                tr("Не удалось открыть браузер: {error}", error=exc), ok=False)

    def _on_capi_link(self):
        """Совместимый обработчик кнопки: привязка выполняется только на сайте."""
        self._capi_open_site()

    def _capi_refresh_status(self):
        """Показать статус привязки, полученный от сайта по токену проекта."""
        api = getattr(self, "api", None)
        if not api or not api.is_connected:
            self._capi_set_status(
                tr("Подключите токен проекта, затем привяжите Frontier на сайте"), ok=None)
            return
        self._capi_set_status(tr("Проверяю привязку Frontier на сайте…"), ok=None)

        def worker():
            try:
                result = api.get_capi_status()
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}

            def done():
                if not result.get("ok"):
                    self._capi_set_status(
                        tr("Не удалось проверить CAPI сайта: {error}",
                           error=result.get("error") or tr("Ошибка")),
                        ok=False,
                    )
                    return
                if not result.get("linked"):
                    self._capi_set_status(
                        tr("Frontier не привязан на сайте. "
                           "Нажмите «Открыть Frontier CAPI на сайте»."),
                        ok=None,
                    )
                elif not result.get("active"):
                    self._capi_set_status(
                        tr("Привязка Frontier сохранена, но требует внимания. "
                           "Откройте CAPI на сайте."),
                        ok=False,
                    )
                else:
                    cmdr = result.get("cmdrName") or ""
                    synced = result.get("lastSyncedAt") or ""
                    if cmdr and synced:
                        text = tr("Frontier привязан на сайте (CMDR {cmdr}); "
                                  "синхронизация: {synced}", cmdr=cmdr, synced=synced)
                    elif cmdr:
                        text = tr("Frontier привязан на сайте (CMDR {cmdr})", cmdr=cmdr)
                    elif synced:
                        text = tr("Frontier привязан на сайте; синхронизация: {synced}",
                                  synced=synced)
                    else:
                        text = tr("Frontier привязан на сайте")
                    self._capi_set_status(text, ok=True)

            self.root.after(0, done)

        threading.Thread(target=worker, daemon=True, name="CapiStatus").start()

    def _on_capi_fetch(self):
        """Запросить синхронизацию сайта; без его привязки CAPI недоступен."""
        self._capi_fetch_and_upload()

    def _capi_unlink(self):
        """Отключение CAPI также выполняется только на сайте."""
        self._capi_open_site()

    def _capi_fetch_and_upload(self):
        """Попросить сайт синхронизировать его Frontier-привязку.

        Helper отправляет только проектный API-токен. Токены Frontier,
        ответы Companion API и нормализация профиля остаются на сервере.
        """
        api = getattr(self, "api", None)
        if not api or not api.is_connected:
            self._capi_set_status(tr("Сначала подключите токен проекта"), ok=False)
            return
        self._capi_set_status(tr("Сайт синхронизирует данные Frontier…"), ok=None)

        def worker():
            try:
                result = api.sync_capi()
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}

            def done():
                if not result.get("ok"):
                    error = result.get("error") or tr("Синхронизация не удалась")
                    if result.get("needsSiteLink"):
                        error += ". " + tr(
                            "Frontier не привязан на сайте. "
                            "Нажмите «Открыть Frontier CAPI на сайте».")
                    elif result.get("needsReauth"):
                        error += ". " + tr(
                            "Привязка Frontier сохранена, но требует внимания. "
                            "Откройте CAPI на сайте.")
                    self._capi_set_status(error, ok=False)
                    self.log(f"Frontier CAPI: {error}", "warn")
                    return

                cmdr = result.get("cmdrName") or ""
                imported = result.get("eventsImported", 0)
                warnings = result.get("warnings") or []
                parts = [tr("Досье обновлено сайтом из Frontier (CMDR {cmdr})", cmdr=cmdr)
                         if cmdr else tr("Досье обновлено сайтом из Frontier")]
                if imported:
                    parts.append(tr("событий колонизации добавлено: {count}", count=imported))
                if warnings:
                    parts.append(tr("предупреждений: {count}", count=len(warnings)))
                self._capi_set_status("; ".join(parts), ok=True)
                self.log(tr("Досье Frontier синхронизировано сайтом"), "success")

            self.root.after(0, done)

        threading.Thread(target=worker, daemon=True, name="CapiSiteSync").start()

    def _maybe_sync_pilot_stats(self):
        stats = getattr(self, "_pilot_stats", {})
        if not stats or not getattr(self, "api_client", None) or not self.api_client.is_connected:
            return
        payload = dict(stats)

        def worker():
            try:
                self.api_client.upload_pilot_stats(payload)
            except Exception as exc:
                self.log(f"Сбой отправки статистики пилота: {exc}")

        threading.Thread(target=worker, daemon=True, name="SyncPilotStats").start()

    def _maybe_sync_ship_state(self, ev: dict, *, live: bool):
        """Upload only fresh journal state, outside the watcher thread's network path."""
        if not live or not getattr(self, "api_client", None) or not self.api_client.is_connected:
            return
        event = ev.get("event")
        if event == "Loadout":
            # Keep the unmodified journal snapshot, including Engineering and
            # ExperimentalEffect; ShipTracker intentionally stores only HUD data.
            self._latest_loadout_event = dict(ev)
            self._ship_state_loadout_pending = True
        if event not in ("Loadout", "Location", "FSDJump", "Docked", "CarrierJump", "Cargo", "Status", "RefuelAll", "RefuelPartial"):
            return
        if not self._latest_loadout_event or self._ship_state_sync_inflight:
            return
        state = getattr(getattr(self, "ship", None), "state", None)
        if state is None:
            return
        payload = {
            "current_system": state.current_system or ev.get("StarSystem") or "",
            "fuel_level": state.fuel_level,
            "cargo_count": state.cargo_count,
        }
        previous = self._ship_state_last_synced
        if event == "Status" and previous and not self._ship_state_loadout_pending:
            same_fuel = abs(float(payload["fuel_level"] or 0) - float(previous.get("fuel_level") or 0)) < 0.5
            if same_fuel and payload["cargo_count"] == previous.get("cargo_count") and payload["current_system"] == previous.get("current_system"):
                return
        if self._ship_state_loadout_pending:
            payload["loadout"] = self._latest_loadout_event
        self._ship_state_sync_inflight = True

        def worker(snapshot=payload):
            try:
                result = self.api_client.upload_ship_state(snapshot)
                if result.get("ok"):
                    self._ship_state_last_synced = {key: snapshot[key] for key in ("current_system", "fuel_level", "cargo_count")}
                    if snapshot.get("loadout") is self._latest_loadout_event:
                        self._ship_state_loadout_pending = False
                else:
                    self.log(f"Не удалось синхронизировать Loadout: {result.get('error', 'ошибка')}", "warn")
            except Exception as exc:
                self.log(f"Сбой синхронизации Loadout: {exc}", "warn")
            finally:
                self._ship_state_sync_inflight = False

        threading.Thread(target=worker, daemon=True, name="SyncShipState").start()

    def _update_pilot_stats_from_event(self, ev: dict):
        if not hasattr(self, "_pilot_stats"):
            self._pilot_stats = {}
        ev_name = ev.get("event")
        if ev_name == "LoadGame":
            if "Credits" in ev:
                self._pilot_stats["credits"] = ev["Credits"]
        elif ev_name == "Rank":
            if "Soldier" in ev:
                self._pilot_stats["mercenary_rank"] = ev["Soldier"]
            if "Exobiologist" in ev:
                self._pilot_stats["exobiologist_rank"] = ev["Exobiologist"]
        elif ev_name == "Statistics":
            bank = ev.get("Bank_Account") or {}
            exp = ev.get("Exploration") or {}
            exo = ev.get("Exobiology") or {}
            if "Current_Wealth" in bank:
                self._pilot_stats["credits"] = bank["Current_Wealth"]
            if "Planets_Scanned_To_Level_2" in exp:
                self._pilot_stats["first_discoveries_count"] = exp["Planets_Scanned_To_Level_2"]
            if "Planets_Scanned_To_Level_3" in exp:
                self._pilot_stats["first_mapped_count"] = exp["Planets_Scanned_To_Level_3"]
            if "First_Footfalls" in exp:
                self._pilot_stats["first_footfalls_count"] = exp["First_Footfalls"]
            if "Organic_Data_Count" in exo:
                self._pilot_stats["bio_samples_count"] = exo["Organic_Data_Count"]
            if "Organic_Species_Encountered" in exo:
                self._pilot_stats["bio_species_count"] = exo["Organic_Species_Encountered"]
            if "Organic_Data_Profits" in exo:
                self._pilot_stats["bio_value_cr"] = exo["Organic_Data_Profits"]
            # «Монеты наёмников» — валюта Operations (июнь 2026): баланс лежит
            # в Bank_Account.MercCoins_Current, игра ограничивает его 9999.
            # Раньше сюда читали Combat.Combat_Bond_Profits — это накопленные
            # КРЕДИТЫ за боевые облигации (сотни миллионов), и досье показывало
            # аномальные «943 153 188 монет».
            if "MercCoins_Current" in bank:
                self._pilot_stats["mercenary_coins"] = bank["MercCoins_Current"]
            elif "Mercenary_Coins" in bank:
                self._pilot_stats["mercenary_coins"] = bank["Mercenary_Coins"]
        self.config["pilot_stats"] = self._pilot_stats
        self._maybe_sync_pilot_stats()

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
            self._fetch_external_scans_if_needed(self.system_map.current_system)
        if name == "Scan" and live:
            self._queue_scan_for_upload(event)

    def _on_notebook_tab_changed(self, _event=None):
        """Переключили вкладку: активные страницы получают свежие данные."""
        try:
            selected_tab = self.notebook.select()
            if selected_tab == str(self.tab_pilot):
                if self._pilot_refresh_job is None:
                    self._refresh_pilot_infographic()
            else:
                self._pilot_cancel_refresh()
        except Exception:
            pass

        if self._map_visible():
            self._map_redraw_now()
            self._map_refresh_from_raven()
            self._map_arm_autorefresh()
            # Движение тел: таймер живёт только пока вкладка на экране. Флаг
            # движения не сбрасываем — вернувшись на вкладку, анимация идёт
            # дальше с того же места, как пауза на время ухода.
            scene = getattr(self, "_map3d_view", None)
            if scene is not None and scene.motion:
                self._map_motion_start()
        else:
            self._map_motion_stop()
        if hasattr(self, "notebook") and hasattr(self, "tab_overlay"):
            # Пока открыта вкладка «Оверлей», HUD не прячется из-за того, что
            # фокус у Helper, а не у игры: видно, что меняешь.
            try:
                editing = self.notebook.select() == str(self.tab_overlay)
                self.overlay_manager.set_ui_editing(editing)
                if editing:
                    self._sync_overlay_block_rows()
            except Exception:
                pass
        if hasattr(self, "notebook") and hasattr(self, "tab_exobio"):
            try:
                selected_tab = self.notebook.select()
                if selected_tab == str(self.tab_exobio):
                    self._update_tab_exobio()
                    if hasattr(self, "exobiology") and self.exobiology.current_system:
                        self._ensure_system_exobio(self.exobiology.current_system)
            except Exception:
                pass

    def _build_tab_overlay(self):
        """Вкладка «Оверлей» на чистом Qt (helper_pages.OverlayPage)."""
        from helper_pages import (OverlayBlockRow, OverlayPage, OverlayPageActions,
                                  OverlayPageState)

        settings = self.overlay_manager.settings
        screen_choices = self._overlay_screen_choices()
        rows = []
        for block_key in self.overlay_manager.BLOCKS:
            rule = str(settings.get(f"{block_key}_auto_rule", "always") or "always")
            rows.append(OverlayBlockRow(
                key=block_key,
                label=tr(BLOCK_LABELS.get(block_key, block_key)),
                visible=bool(settings.get(f"show_{block_key}", True)),
                locked=bool(settings.get(f"{block_key}_locked", False)),
                screen=self._block_screen_label(block_key),
                alpha=self._block_alpha_label(block_key),
                font_size=self._block_font_label(block_key),
                size=self._size_label(self._block_size_preset(block_key)),
                auto_rule=tr(AUTO_RULE_LABELS.get(rule, AUTO_RULE_LABELS["always"])),
                hotkey=str(settings.get(f"{block_key}_hotkey", "") or "—") or "—",
            ))

        content = []
        for block_key, sections in CONTENT_OPTIONS.items():
            items = []
            for section_key, (text, _attributes) in sections.items():
                setting = option_key(block_key, section_key)
                items.append((setting, tr(text), bool(settings.get(setting, True))))
            content.append((block_key, tr(BLOCK_LABELS.get(block_key, block_key)), items))

        anchor_values = [tr(ANCHOR_LABELS[key]) for key in ANCHOR_KEYS]
        anchors = []
        for block_key in self.overlay_manager.BLOCKS:
            current = settings.get(f"{block_key}_anchor", "custom")
            anchors.append((block_key, tr(BLOCK_LABELS.get(block_key, block_key)),
                            tr(ANCHOR_LABELS.get(current, ANCHOR_LABELS["custom"])),
                            anchor_values))

        carrier_labels = [(mode, tr(text)) for mode, text in CARRIER_FILTERS.items()]
        state = OverlayPageState(
            alpha=float(settings.get("alpha", 0.90)),
            font_family=str(settings.get("font_family", "Consolas")),
            font_size=int(settings.get("font_size", 10) or 10),
            font_choices=("Consolas", "Courier New", "Segoe UI", "Arial", "Lucida Console"),
            alpha_choices=tuple(tr(value) for value in self.OVERLAY_ALPHA_CHOICES),
            hotkey_choices=tuple(self.OVERLAY_HOTKEY_CHOICES),
            lock_hotkey_choices=tuple(self.OVERLAY_LOCK_HOTKEY_CHOICES),
            size_labels=[self._size_label(name) for name, _factor in SIZE_PRESETS],
            rule_labels=[tr(AUTO_RULE_LABELS[name]) for name in AUTO_RULES],
            rows=rows,
            anchors=anchors,
            screen_choices=screen_choices,
            screens_text=self._overlay_screens_text(),
            all_size=self._size_label("M"),
            lock_hotkey=str(settings.get("lock_toggle_hotkey", "Ctrl+F12") or "") or "—",
            auto_rules=bool(settings.get("auto_rules_enabled", False)),
            attach_game=bool(settings.get("attach_to_game", True)),
            idle_choices=[self._idle_label(seconds) for seconds in IDLE_TIMEOUTS],
            idle=self._idle_label(int(settings.get("idle_timeout", 0) or 0)),
            ship_blocks=[(key, tr(text),
                          bool(settings.get(f"show_{key}", True)))
                         for key, text in self.OVERLAY_SHIP_BLOCKS],
            ship_modules=str(settings.get("ship_modules_view", "important")),
            content=content,
            carrier_filters=carrier_labels,
            carrier_filter=tr(CARRIER_FILTERS.get(
                settings.get("carrier_filter", "all"), list(CARRIER_FILTERS.values())[0])),
            carrier_search=str(settings.get("carrier_search", "") or ""),
            profiles=self.overlay_manager.list_profiles(),
            profile=self.overlay_manager.active_profile,
            margin=int(settings.get("layout_margin", 24) or 24),
            hide_without_game=bool(settings.get("hide_when_game_off", True)),
        )
        actions = OverlayPageActions(
            toggle=self._on_toggle_overlay,
            reset_positions=self._on_reset_overlay_positions,
            alpha_changed=self._on_alpha_changed,
            font_changed=self._on_font_changed,
            font_size_changed=self._on_font_size_changed,
            all_size_changed=self._on_all_size_preset_changed,
            block_visible=self._on_block_visible_changed,
            block_lock=self._on_block_lock_changed,
            block_screen=self._on_block_screen_changed,
            block_alpha=self._on_block_alpha_changed,
            block_font=self._on_block_font_changed,
            block_size=self._on_block_size_changed,
            block_rule=self._on_block_rule_changed,
            block_hotkey=self._on_block_hotkey_changed,
            block_reset=self._on_block_reset,
            screens_provider=self._overlay_screen_choices,
            lock_all=self._on_lock_all,
            lock_hotkey_changed=self._on_lock_hotkey_changed,
            auto_rules_changed=self._on_auto_rules_changed,
            attach_game_changed=self._on_attach_game_changed,
            idle_changed=self._on_idle_changed,
            ship_block_changed=self._on_ship_block_changed,
            ship_modules_changed=self._on_ship_modules_view_changed,
            content_changed=self._on_overlay_content_changed,
            carrier_filter_changed=self._on_carrier_filter_changed,
            carrier_search_changed=self._on_carrier_search_changed,
            profile_apply=self._on_profile_apply,
            profile_save=self._on_profile_save,
            profile_delete=self._on_profile_delete,
            anchor_changed=self._on_anchor_changed,
            apply_anchors=self._on_apply_anchors,
            hide_without_game_changed=self._on_hide_without_game_changed,
            margin_changed=self._on_margin_changed,
        )
        self.overlay_page = OverlayPage(state, actions)
        self.tab_overlay._get_tk_layout("pack").addWidget(self.overlay_page)
        self._show_page(self.overlay_page)

        self.overlay_manager.on_settings_changed = self._on_overlay_settings_changed
        self._update_overlay_hotkey_hint()

    # ---------- Блоки: персональные настройки ----------
    OVERLAY_ALPHA_CHOICES = ("общая", "40%", "55%", "70%", "85%", "100%")
    #: Колонка «Шрифт»: «общий» — наследовать общий размер, остальное — кегль.
    OVERLAY_FONT_CHOICES = ("общий", "8", "9", "10", "11", "12", "14", "16", "18")
    OVERLAY_HOTKEY_CHOICES = ("—", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8",
                              "F9", "F10", "F11", "F12")
    OVERLAY_LOCK_HOTKEY_CHOICES = ("—", "Ctrl+F12", "Ctrl+F11", "Ctrl+F10", "Shift+F12",
                                   "Alt+F12", "Ctrl+Shift+F12", "Ctrl+Shift+L")
    #: Колонка «Экран»: ключ значения «блок живёт поверх игры». Подпись берётся
    #: из ``helper_pages.screen_with_game_label`` — ключ перевода должен быть
    #: один на оба модуля, иначе сравнение подписей разъедется.
    OVERLAY_SCREEN_WITH_GAME = "с игрой"
    #: Блоки корабля (SHIP) с подписями: галочки «показывать» на вкладке оверлея.
    OVERLAY_SHIP_BLOCKS = (
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
    )

    def _size_label(self, preset: str) -> str:
        """Подпись пресета размера на текущем языке."""
        return tr(SIZE_PRESET_LABELS.get(preset, SIZE_PRESET_LABELS["M"]))

    def _idle_label(self, seconds: int) -> str:
        """Подпись для выбора таймера простоя."""
        seconds = int(seconds or 0)
        if seconds <= 0:
            return tr("не скрывать")
        if seconds < 60:
            return tr("{seconds} с", seconds=seconds)
        return tr("{minutes} мин", minutes=seconds // 60)

    def _idle_seconds(self, label: str) -> int:
        """Обратно: подпись -> секунды (по той же таблице, что и подписи).

        Раньше разбирались слова «мин»/«с»: на другом языке разбор молча давал
        ноль и таймер простоя выключался.
        """
        text = (label or "").strip()
        for seconds in IDLE_TIMEOUTS:
            if self._idle_label(seconds) == text:
                return int(seconds)
        digits = "".join(ch for ch in text if ch.isdigit())
        return int(digits or 0) * (60 if ":" in text else 1) if digits else 0

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

    # -- подписи и разбор значений --
    def _overlay_screen_choices(self) -> list:
        """Значения колонки «Экран»: «с игрой» и номера подключённых экранов."""
        choices = [_screen_with_game_label()]
        try:
            monitors = self.overlay_manager.monitors()
        except Exception:
            monitors = []
        choices.extend(_screen_label(monitor.index) for monitor in monitors)
        return choices

    def _overlay_screens_text(self) -> str:
        """Подпись под таблицей: какие экраны есть и какой из них какой."""
        try:
            monitors = self.overlay_manager.monitors()
        except Exception:
            monitors = []
        if not monitors:
            return ""
        parts = []
        for monitor in monitors:
            width, height = monitor.size
            text = tr("экран {index} — {width}×{height}",
                      index=monitor.index, width=width, height=height)
            if monitor.primary:
                text += tr(" (основной)")
            parts.append(text)
        return tr("Экраны: {list}", list="; ".join(parts))

    def _block_screen_label(self, key: str) -> str:
        """Текущее значение колонки «Экран» для блока."""
        manager = self.overlay_manager
        if not manager.block_detached(key):
            return _screen_with_game_label()
        try:
            monitor = manager.block_monitor(key)
        except Exception:
            monitor = None
        return _screen_label(monitor.index if monitor is not None else 1)

    def _block_alpha_label(self, key: str) -> str:
        value = self.overlay_manager.settings.get(f"{key}_alpha")
        return tr("общая") if value is None else f"{int(round(float(value) * 100))}%"

    def _block_font_label(self, key: str) -> str:
        value = self.overlay_manager.settings.get(f"{key}_font_size")
        return tr("общий") if value in (None, "") else str(int(value))

    def _rule_key_by_label(self, label: str) -> str:
        for rule_key, text in AUTO_RULE_LABELS.items():
            if tr(text) == label:
                return rule_key
        return "always"

    def _preset_key_by_label(self, label: str) -> str:
        for name in SIZE_PRESET_LABELS:
            if self._size_label(name) == label:
                return name
        return "M"

    # -- обработчики строки блока --
    def _on_block_visible_changed(self, key: str, show=None):
        if show is None:
            show = self.overlay_page.block_value(key, "visible")
        self.overlay_manager.set_block_visible(key, bool(show))

    def _on_block_lock_changed(self, key: str, locked=None):
        if locked is None:
            locked = self.overlay_page.block_value(key, "locked")
        self.overlay_manager.set_block_locked(key, bool(locked))
        self.log(
            f"{BLOCK_LABELS.get(key, key)}: "
            + ("закреплён — клики уходят в игру" if locked
               else "откреплён — можно двигать и настраивать"),
            "info",
        )

    def _on_block_screen_changed(self, key: str, value=None):
        """Колонка «Экран»: вернуть блок к игре или отвязать и вынести на экран."""
        if value is None:
            value = self.overlay_page.block_value(key, "screen")
        value = str(value or "").strip()
        label = tr(BLOCK_LABELS.get(key, key))
        # «С игрой» — это значение без номера экрана; сравнивать подпись нельзя,
        # иначе на другом языке блок «отвязывался» вместо возврата к игре.
        if not "".join(ch for ch in value if ch.isdigit()):
            self.overlay_manager.set_block_detached(key, False, move_to_game=True)
            self.log(f"{label}: снова с игрой — виден только поверх игры", "info")
        else:
            digits = "".join(ch for ch in value if ch.isdigit())
            if not digits or not self.overlay_manager.move_block_to_monitor(key, int(digits)):
                self.log(f"{label}: экран {digits or '?'} не найден", "warn")
            else:
                self.log(f"{label}: отвязан от игры, {value}", "info")
        self._sync_overlay_block_rows()

    def _on_lock_all(self, locked: bool):
        self.overlay_manager.set_all_locked(locked)
        self._sync_overlay_block_rows()
        self.log("Все блоки закреплены: клики уходят в игру" if locked
                 else "Все блоки откреплены: их можно двигать и настраивать", "info")

    def _on_lock_hotkey_changed(self):
        value = str(self.overlay_page.lock_hotkey_text() or "").strip()
        combo = "" if value in ("", "—") else value
        self.overlay_manager.set_lock_hotkey(combo)
        self._update_overlay_hotkey_hint()
        if combo and not self.overlay_manager.hotkeys.available:
            self.log(
                f"Горячая клавиша {combo} сохранена, но системные горячие клавиши "
                f"доступны только в Windows.",
                "warn",
            )
        elif combo:
            self.log(f"Закрепить/открепить все блоки: {combo}", "success")

    def _on_toggle_overlay_lock(self):
        """Ctrl+F12 в окне Helper: закрепить/открепить все блоки.

        Если системные горячие клавиши работают, нажатие уже обработал
        `HotkeyManager` — второй раз не переключаем.
        """
        if self.overlay_manager.hotkeys.running:
            return
        locked = self.overlay_manager.toggle_all_locked()
        self._sync_overlay_block_rows()
        self.log("Все блоки закреплены: клики уходят в игру" if locked
                 else "Все блоки откреплены: их можно двигать и настраивать", "info")

    def _on_block_alpha_changed(self, key: str, label=None):
        if label is None:
            label = self.overlay_page.block_value(key, "alpha")
        if str(label) == tr("общая"):
            self.overlay_manager.set_block_alpha(key, None)
        else:
            digits = "".join(ch for ch in str(label) if ch.isdigit())
            self.overlay_manager.set_block_alpha(key, int(digits or 100) / 100.0)

    def _on_block_font_changed(self, key: str, label=None):
        if label is None:
            label = self.overlay_page.block_value(key, "font_size")
        if str(label) == tr("общий"):
            self.overlay_manager.set_block_font_size(key, None)
        else:
            digits = "".join(ch for ch in str(label) if ch.isdigit())
            if digits:
                self.overlay_manager.set_block_font_size(key, int(digits))

    def _on_block_size_changed(self, key: str, label=None):
        if label is None:
            label = self.overlay_page.block_value(key, "size")
        preset = self._preset_key_by_label(label)
        self.overlay_manager.apply_size_preset(preset, key)

    def _on_block_rule_changed(self, key: str, label=None):
        if label is None:
            label = self.overlay_page.block_value(key, "auto_rule")
        rule = self._rule_key_by_label(label)
        self.overlay_manager.set_auto_rule(key, rule)
        if not self.overlay_manager.settings.get("auto_rules_enabled", False):
            self.overlay_page.set_auto_rules(True)
            self.overlay_manager.set_auto_rules_enabled(True)

    def _on_block_hotkey_changed(self, key: str, value=None):
        if value is None:
            value = self.overlay_page.block_value(key, "hotkey")
        value = str(value or "").strip()
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
        preset = self._preset_key_by_label(self.overlay_page.all_size_text())
        if self.overlay_manager.apply_size_preset(preset):
            self._sync_overlay_block_rows()
            self.log(f"Размер всех блоков: {SIZE_PRESET_LABELS.get(preset, preset)}", "info")

    def _on_auto_rules_changed(self):
        self.overlay_manager.set_auto_rules_enabled(bool(self.overlay_page.auto_rules()))

    def _on_idle_changed(self):
        seconds = self._idle_seconds(self.overlay_page.idle_text())
        self.overlay_manager.set_idle_timeout(seconds)

    def _on_overlay_content_changed(self, setting: str, enabled: bool):
        """Галочка «отображаемые данные»: ключ — overlay_<блок>_<раздел>."""
        for block, sections in CONTENT_OPTIONS.items():
            for section in sections:
                if option_key(block, section) == setting:
                    self.overlay_manager.set_content_option(block, section, bool(enabled))
                    return

    def _on_carrier_filter_changed(self):
        label = self.overlay_page.carrier_filter_text()
        mode = next((key for key, text in CARRIER_FILTERS.items() if tr(text) == label), "all")
        self.overlay_manager.set_carrier_filter(mode=mode)

    def _on_carrier_search_changed(self):
        self.overlay_manager.set_carrier_filter(
            query=self.overlay_page.carrier_search_text())

    def _sync_overlay_block_rows(self):
        """Перечитать настройки в виджеты (после сброса, профиля, горячей клавиши)."""
        page = getattr(self, "overlay_page", None)
        if page is None:
            return
        settings = self.overlay_manager.settings
        for key in self.overlay_manager.BLOCKS:
            page.set_block_value(key, "visible", bool(settings.get(f"show_{key}", True)))
            page.set_block_value(key, "locked", bool(settings.get(f"{key}_locked", False)))
            page.set_block_value(key, "screen", self._block_screen_label(key))
            page.set_block_value(key, "alpha", self._block_alpha_label(key))
            page.set_block_value(key, "font_size", self._block_font_label(key))
            page.set_block_value(key, "size", self._size_label(self._block_size_preset(key)))
            rule = str(settings.get(f"{key}_auto_rule", "always") or "always")
            page.set_block_value(key, "auto_rule",
                                 tr(AUTO_RULE_LABELS.get(rule, AUTO_RULE_LABELS["always"])))
            page.set_block_value(key, "hotkey",
                                 str(settings.get(f"{key}_hotkey", "") or "—") or "—")
        page.set_idle_text(self._idle_label(int(settings.get("idle_timeout", 0) or 0)))
        page.set_lock_hotkey_text(
            str(settings.get("lock_toggle_hotkey", "Ctrl+F12") or "") or "—")
        page.set_screens_text(self._overlay_screens_text())
        page.set_auto_rules(bool(settings.get("auto_rules_enabled", False)))
        page.set_all_size_text(self._size_label("M"))

    def _on_overlay_settings_changed(self, key: str, name: str, _value):
        """Настройка изменилась из оверлея (например, по горячей клавише)."""
        self._sync_overlay_block_rows()

    def _update_overlay_hotkey_hint(self):
        """Строка подсказки: какие клавиши за чем закреплены."""
        if getattr(self, "overlay_page", None) is None:
            return
        lines = []
        for key in self.overlay_manager.BLOCKS:
            combo = str(self.overlay_manager.settings.get(f"{key}_hotkey", "") or "")
            if combo:
                lines.append(f"{combo} — {tr(BLOCK_LABELS.get(key, key))}")
        all_combo = str(self.overlay_manager.settings.get("toggle_all_hotkey", "F12") or "")
        if all_combo:
            lines.append(tr("{combo} — показать/скрыть все блоки", combo=all_combo))
        lock_combo = str(self.overlay_manager.settings.get("lock_toggle_hotkey", "Ctrl+F12") or "")
        if lock_combo:
            lines.append(tr("{combo} — закрепить/открепить все блоки", combo=lock_combo))
        hint = (tr("Назначено: {list}", list="; ".join(lines)) if lines
                else tr("Клавиши не назначены."))
        if not self.overlay_manager.hotkeys.available:
            hint += tr("  (системные горячие клавиши работают только в Windows)")
        self.overlay_page.set_hotkey_hint_text(hint)

    def _on_toggle_overlay(self):
        # NavRoute.json is produced by the game independently of Watcher.
        # Load it when the HUD is enabled as well, so ROUTE works on its own.
        if not self.overlay_manager.enabled:
            self._auto_load_navroute()
        self.overlay_manager.toggle(self._get_overlay_data)
        if self.overlay_manager.enabled:
            self.overlay_page.set_toggle_running(True)
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
            self.overlay_page.set_toggle_running(False)
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
        current = self.overlay_page.profile_text()
        if not selected and current not in names:
            selected = self.overlay_manager.active_profile
        self.overlay_page.set_profiles(names, selected or current)

    def _on_profile_save(self):
        name = (self.overlay_page.profile_text() or "").strip()
        if not name:
            name = ask_string(
                tr("Профиль раскладки"),
                tr("Имя профиля (например: Хаул, Эксобиология, Бой):"),
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
        name = (self.overlay_page.profile_text() or "").strip()
        if not name:
            self.log("Выберите профиль раскладки.", "warn")
            return
        if not self.overlay_manager.apply_layout(name):
            self.log(f"Профиль «{name}» не найден.", "error")
            return
        # Прозрачность/шрифт из профиля подтягиваем и в элементы вкладки.
        self.overlay_page.set_alpha(float(self.overlay_manager.settings.get("alpha", 0.9)))
        self.overlay_page.set_font_family(self.overlay_manager.settings.get("font_family", "Consolas"))
        self.overlay_page.set_font_size(int(self.overlay_manager.settings.get("font_size", 10)))
        self._refresh_profile_combo(name)
        self._sync_overlay_block_rows()
        self._update_overlay_hotkey_hint()
        self.log(f"Профиль раскладки «{name}» применён.", "success")

    def _on_profile_delete(self):
        name = (self.overlay_page.profile_text() or "").strip()
        if not name:
            return
        if not ask_yes_no(tr("Удалить профиль"),
                          tr("Удалить профиль «{name}»?", name=name), parent=self.root):
            return
        if self.overlay_manager.delete_profile(name):
            self._refresh_profile_combo("")
            self.log(f"Профиль раскладки «{name}» удалён.", "info")
        else:
            self.log(f"Профиль «{name}» не найден.", "warn")

    def _on_margin_changed(self, value: int):
        self.overlay_manager.set_layout_margin(int(value))
        self._update_layout_info()

    def _on_anchor_changed(self, block_key: str, label: str):
        anchor = "custom"
        for key, text in ANCHOR_LABELS.items():
            if tr(text) == label:
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
        enabled = bool(self.overlay_page.hide_without_game())
        self.overlay_manager.set_hide_when_game_off(enabled)
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
            source = (tr("экран с игрой") if (state.running and state.monitor)
                      else tr("основной экран"))
            self.overlay_page.set_info_text(tr(
                "Область раскладки: {source} {width}x{height} (сдвиг {x},{y}), отступ {margin} px",
                source=source, width=area[2], height=area[3], x=area[0], y=area[1],
                margin=self.overlay_manager.settings.get("layout_margin", 24)))
        except Exception:
            pass

    def _on_alpha_changed(self, value: float):
        self.overlay_manager.set_alpha(float(value))

    def _on_font_changed(self):
        self.overlay_manager.set_font(self.overlay_page.font_family(), self.overlay_page.font_size())

    def _on_font_size_changed(self, value: int):
        self.overlay_manager.set_font(self.overlay_page.font_family(), int(value))

    def _on_show_route_changed(self):
        self.overlay_manager.set_block_visible("route", self.overlay_page.block_value("route", "visible"))

    def _on_show_status_changed(self):
        self.overlay_manager.set_block_visible("status", self.overlay_page.block_value("status", "visible"))

    def _on_show_ship_changed(self):
        self.overlay_manager.set_block_visible("ship", self.overlay_page.block_value("ship", "visible"))

    def _on_show_cargo_changed(self):
        self.overlay_manager.set_block_visible("cargo", self.overlay_page.block_value("cargo", "visible"))

    def _on_show_session_changed(self):
        self.overlay_manager.set_block_visible("session", self.overlay_page.block_value("session", "visible"))

    def _on_show_events_changed(self):
        """EVENTS создаётся вместе с остальными окнами, поэтому просто
        показываем/прячем существующее окно."""
        self.overlay_manager.set_block_visible("events", self.overlay_page.block_value("events", "visible"))

    def _on_show_exobio_changed(self):
        """Блок экзобиологии показывает данные по текущему телу из журнала."""
        self.overlay_manager.set_block_visible("exobio", self.overlay_page.block_value("exobio", "visible"))

    def _on_attach_game_changed(self):
        enabled = self.overlay_page.attach_game()
        self.overlay_manager.set_attach_to_game(enabled)
        state = "включена" if enabled else "отключена"
        self.log(f"Привязка к окну игры {state}", "info")

    def _on_ship_block_changed(self, block: str, show: bool):
        self.overlay_manager.set_ship_block(block, show)

    def _on_ship_modules_view_changed(self):
        """Режим списка модулей меняется на лету: окно не пересоздаём."""
        mode = str(self.overlay_page.ship_modules_view() or "important")
        self.overlay_manager.set_ship_modules_view(mode)
        self.log(f"SHIP: список модулей — {mode}", "info")

    def _on_reset_overlay_positions(self):
        self.overlay_manager.reset_positions()
        self.overlay_manager.apply_block_style()
        self._refresh_profile_combo()
        self._sync_overlay_block_rows()
        self.log("Позиции оверлея сброшены на стандартные.", "info")

    def _get_overlay_data(self) -> dict:
        """Собрать данные для обновления оверлея."""
        game_state = self.overlay_manager.game_state()
        data = {
            "online": self.api.is_connected,
            "status_detail": (
                f"{self.api.display_name} | ED Ring: {'ON' if self.api.is_connected else 'OFF'} | "
                f"Raven: {'ON' if self.raven_api.is_connected else 'OFF'} | "
                f"EDSM: {'ON' if self.edsm_api.enabled else 'OFF'} | "
                f"Inara: {'ON' if self.inara_api.enabled else 'OFF'}"
            ),
            "watcher_active": self.watcher_active,
            "game_running": bool(game_state.running),
            "game_focused": bool(game_state.focused),
            "game_detail": game_state.process_name or "",
            "exobiology": self._exobiology_overlay_state(),
            "progress": self.upload_page.progress_text() or "",
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
        # Current location comes from the journal, not the first pending waypoint.
        summary = route_summary(self.route.systems, getattr(self.ship.state, 'current_system', ''))
        data.update({key: summary[key] for key in ('current', 'next', 'visited', 'total', 'remaining')})
        data['route_summary'] = summary
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
        """Вкладка «Экзобиология» на чистом Qt: тела системы и фильтры оверлея."""
        from helper_pages import ExobioPage, ExobioPageActions, ExobioPageState

        settings = self.overlay_manager.settings
        selected_genera = {str(genus) for genus in (settings.get("exobio_genera") or [])}
        selected_ids = {str(item) for item in (settings.get("exobio_planet_search") or [])}
        state = ExobioPageState(
            genus_choices=tuple(sorted(GENUS_VALUE_CR)),
            selected_genera=tuple(sorted(selected_genera)),
            show_planets=bool(settings.get("exobio_show_planet_search", True)),
            planet_choices=tuple(
                (str(preset.get("id")), str(preset.get("label") or preset.get("id")))
                for preset in PLANET_SEARCH_PRESETS),
            selected_planets=tuple(sorted(selected_ids)),
        )
        actions = ExobioPageActions(
            rescan=lambda: self._scan_journals_for_current_system(force=True),
            scan_all=self._scan_all_journals_for_exobio,
            filters_changed=self._on_exobio_filters_changed,
        )
        self.exobio_page = ExobioPage(state, actions)
        self.tab_exobio._get_tk_layout("pack").addWidget(self.exobio_page)
        self._show_page(self.exobio_page)
        self._update_tab_exobio()

    def _set_all_genera(self, value: bool):
        page = getattr(self, "exobio_page", None)
        if page is None:
            return
        page.set_all_genera(bool(value))

    def _clear_planet_filters(self):
        page = getattr(self, "exobio_page", None)
        if page is None:
            return
        page.clear_planets()

    def _on_exobio_filters_changed(self):
        """Сохранить фильтры и сразу перерисовать блок EXOBIO."""
        page = getattr(self, "exobio_page", None)
        if page is None:
            return
        genera = page.genera()
        planet_ids = page.planet_ids()
        show_planets = bool(page.show_planets())
        try:
            self.overlay_manager.set_exobio_filters(
                genera=genera, planet_search=planet_ids, show_planets=show_planets)
            self.overlay_manager.save_settings()
        except Exception as exc:  # настройки не должны ронять интерфейс
            self.log(f"Не удалось сохранить фильтры EXOBIO: {exc}", "error")
        self._update_tab_exobio()

    def _update_tab_exobio(self):
        """Обновить сводку и таблицу тел на вкладке «Экзобиология»."""
        page = getattr(self, "exobio_page", None)
        if page is None or not hasattr(self, "exobiology"):
            return
        tracker = self.exobiology
        system = str(tracker.current_system or "").strip() or tr("не определена")
        page.set_system_text(system)

        scanned = tracker.system_scanned_count()
        known = tracker.system_known_body_count()
        bio_bodies = tracker.system_bio_bodies_count()
        bio_total = tracker.system_bio_signals_total()

        body_text = tr("Тел отсканировано: {count}", count=scanned) + (
            tr(" из {known}", known=known) if known and known > scanned else "")
        page.set_summary_text(
            tr("{bodies}  ·  Тел с биосигналами: {with_signals}  ·  "
               "Всего биосигналов: {signals}",
               bodies=body_text, with_signals=bio_bodies, signals=bio_total))

        if not tracker.current_system:
            page.set_rows([])
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

        from exobiology import body_matches, preset_label
        rows = []
        for body in system_bodies:
            name = str(body.get("name") or "")
            disp_name = name
            if system and name.startswith(system):
                disp_name = name[len(system):].strip() or name

            signals = int(body.get("bio_signals") or 0)
            matched_rules = []
            for rule in criteria:
                if body_matches(body, rule):
                    matched_rules.append(preset_label(rule))

            matched_str = ", ".join(matched_rules[:2]) if matched_rules else "—"
            if len(matched_rules) > 2:
                matched_str += f" (+{len(matched_rules) - 2})"

            rows.append({
                "body": disp_name,
                "class": str(body.get("planet_class") or "—"),
                "atmosphere": str(body.get("atmosphere") or body.get("atmosphere_type")
                                  or tr("нет")),
                "landable": tr("Да") if body.get("landable") else tr("Нет"),
                "signals": str(signals) if signals else "—",
                "mapped": tr("Да") if body.get("mapped") else "—",
                "matched": matched_str,
            })
        page.set_rows(rows)

    def _set_exobio_status(self, text: str, color: str = ""):
        """Строка состояния вкладки «Экзобиология».

        Обновление приходит и из фоновых потоков сканирования, поэтому вне
        главного потока запись откладывается в очередь Qt через `root.after`.
        """
        page = getattr(self, "exobio_page", None)
        if page is None:
            return
        if (threading.current_thread() is not threading.main_thread()
                and getattr(self, "root", None) is not None):
            try:
                self.root.after(0, lambda: self._set_exobio_status(text, color))
                return
            except Exception:
                pass
        try:
            page.set_status_text(str(text), color)
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
        self._set_exobio_status(tr("Сканирование журналов..."), COLOR_ORANGE)

        def worker():
            from exobiology import scan_all_journals_for_exobio

            def on_progress(cur, total):
                if hasattr(self, "root") and self.root:
                    try:
                        self.root.after(0, lambda c=cur, t=total: self._set_exobio_status(
                            tr("Сканирование: файл {current} из {total}...",
                               current=c, total=t), COLOR_ORANGE))
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
                self._set_exobio_status(
                    tr("Сканирование завершено: учтено {count} новых событий",
                       count=count), COLOR_GREEN)
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

    # ============================================================
    #  Прежняя карта системы: только совместимость
    # ============================================================
    #: Вкладка «Карта системы» из навигации убрана — её место занимает
    #: инфографика фракций, а карта больше ничего не рисует. Прежние имена
    #: обработчиков остаются вызовами-пустышками: их зовут разбор журнала,
    #: переключение вкладок и тесты, и удаление меняло бы контракт поведения.
    #: Данные системы по-прежнему собирает `system_map` — они нужны фракциям.

    def _map_visible(self) -> bool:
        """Карты в интерфейсе нет, поэтому вкладка никогда не открыта."""
        return False

    def _map_schedule_redraw(self, delay_ms=None) -> None:
        self._map_redraw_job = None

    def _map_redraw_now(self) -> None:
        self._map_redraw_job = None

    def _map_motion_start(self, delay_ms=None) -> None:
        return None

    def _map_motion_stop(self) -> None:
        return None

    def _map_arm_autorefresh(self) -> None:
        self._map_autorefresh_job = None

    def _map_refresh_from_raven(self, force: bool = False) -> None:
        """Данные Raven для карты больше не нужны: их берут фракции."""
        self._map_raven_inflight = False

    def _map_set_hint(self, text: str) -> None:
        label = getattr(self, "map_hint", None)
        if label is None:
            return
        try:
            label.setText(str(text or ""))
        except Exception:
            pass

    def _map3d_scene(self):
        return None

    def _draw_system_map(self, snapshot=None) -> None:
        return None

    def _draw_system_map_3d(self) -> None:
        return None

    def _on_map_tree_context(self, _event=None) -> None:
        return None

    def _on_map_motion_toggle(self, _event=None) -> None:
        return None

    def _on_map_motion_speed(self, _event=None) -> None:
        return None

    def _on_map_level_change(self, _event=None) -> None:
        return None

    def _on_map_view_preset(self, _event=None) -> None:
        return None

    def _on_map_reset_3d(self, _event=None) -> None:
        return None

    def _on_map_reset_time(self, _event=None) -> None:
        return None

    def _on_map_key(self, _event=None) -> None:
        return None

    def _on_map_dolly(self, _event=None) -> None:
        return None

    def _on_map_open_3d(self, key: str = ""):
        """Прежний переход «открыть карту системы» теперь ведёт к фракциям."""
        snapshot = self._map_last_snapshot or self.system_map.snapshot()
        if not snapshot.system:
            self._map_set_hint(tr("Нет данных о текущей системе для карты"))
            return
        target = str(key or getattr(self, "_map_selected", "") or "")
        view_mode = getattr(self, "map_view_mode", None)
        if view_mode is not None:
            try:
                view_mode.set("3d")
            except Exception:
                pass
        self.config["map_view_mode"] = "3d"
        if target:
            self._map_selected = target
            self._map_center = target
        try:
            self.notebook.select(self.tab_factions)
        except Exception:
            pass
        note = f" (объект: {target})" if target else ""
        self.log(f"Инфографика фракций открыта для системы {snapshot.system}{note}", "info")

    #: Прежнее имя обработчика: его зовут привязки клавиш и тесты.
    _on_map_open_plotly = _on_map_open_3d

    def _map_viewer_options(self):
        """Стартовые параметры прежней карты из конфига.

        Ключи `map_plotly_*` и `map_viewer_*` остались от прежних карт (Plotly,
        карта в браузере) и читаются как запасные, чтобы настройки старых
        установок не потерялись.
        """
        config = getattr(self, "config", None)
        config = config if isinstance(config, dict) else {}
        try:
            zoom = max(0, min(3, int(config.get("map_viewer_zoom",
                                                config.get("map_plotly_zoom", 0)) or 0)))
        except (TypeError, ValueError):
            zoom = 0
        labels = bool(config.get("map_viewer_labels", config.get("map_plotly_labels", False)))
        view_mode = str(config.get("map_viewer_view", config.get("map_plotly_view", "3d")) or "3d")
        scale_mode = str(config.get("map_viewer_scale", "orrery") or "orrery")
        moons_var = getattr(self, "map_moons_var", None)
        show_moons = True if moons_var is None else bool(moons_var.get())
        selected = str(getattr(self, "_map_selected", "") or "")
        return {
            "zoom": zoom,
            "labels": labels,
            "view_mode": "2d" if view_mode.strip().lower() in ("2d", "top", "сверху") else "3d",
            "scale_mode": "linear" if scale_mode.strip().lower() in ("linear", "линейный") else "orrery",
            "show_moons": show_moons,
            "selected": selected,
        }

    def _copy_map_text(self, text: str, hint: str = ""):
        try:
            import pyperclip

            pyperclip.copy(text)
        except Exception:
            try:
                self.root.clipboard_clear()
                self.root.clipboard_append(text)
            except Exception:
                pass
        if hint is not None:
            self._map_set_hint(hint or tr("Скопировано"))

    def _build_tab_log(self):
        """Лог на чистом Qt: цветные уровни и кнопка очистки без Tk-виджетов."""
        self.log_page = None
        try:
            from helper_pages import LogPage

            host_layout = self.tab_log._get_tk_layout("pack")
            self.log_page = LogPage()
            host_layout.addWidget(self.log_page)
            self._show_page(self.log_page)
        except Exception as exc:
            self.log("Не удалось открыть вкладку лога: %s" % exc, "error")
        self.log("Colonial Helper готов к работе", "info")

    # ============================================================
    #  Статус-бар внизу
    # ============================================================
    def _build_status_bar(self):
        """The status line is part of the native shell."""
        self.shell.set_status(tr("Готов"))
        # Стартовое состояние видно сразу, не дожидаясь автопроверки: иначе до
        # первого ответа сети строка «Подключено / Не подключено» пустая и
        # непонятно, есть ли вообще токен.
        api = getattr(self, "api", None)
        if api is not None and getattr(api, "token", ""):
            if api.is_connected:
                self.set_connection_status(True, api.display_name)
            else:
                self.set_connection_status(
                    False, tr("токен сохранён, проверяю подключение…"))
        else:
            self.set_connection_status(False, tr("введите токен"))

    def set_status(self, text: str) -> None:
        """Единственная точка записи в статусную строку."""
        setter = getattr(getattr(self, "shell", None), "set_status", None)
        if callable(setter):
            setter(text)

    # ============================================================
    #  Обновление программы
    # ============================================================
    def _update_channel_value(self) -> str:
        """Канал обновлений выбирается в лаунчере; Helper его только читает."""
        channel = str(self.config.get("update_channel", "stable") or "stable")
        return channel if channel in self.UPDATE_CHANNEL_LABELS else "stable"

    def _auto_check_update(self):
        if not bool(self.config.get("update_check_enabled", True)):
            return
        self._on_check_update(manual=False)

    def _set_update_ui(self, busy: bool, hint: str = "", button_text: str = "",
                       progress=None):
        """Состояние операции обновления в статусной строке оболочки.

        ``progress=None`` — стадия без известной длительности (проверка,
        сверка хешей), число 0..100 — скачивание.
        """
        if not hint:
            return
        suffix = ""
        if progress is not None:
            try:
                suffix = f" · {int(max(0, min(100, float(progress))))}%"
            except (TypeError, ValueError):
                suffix = ""
        self.set_status(f"{hint}{suffix}")

    # ------------------------------------------------------------------
    #  Обновление кода пакетом (структурой), а не перекачиванием exe
    # ------------------------------------------------------------------
    def _bundle_root(self):
        """Каталог установки, с которым работает лаунчер."""
        if not bundle:
            return None
        override = os.environ.get("COLONIAL_HELPER_HOME", "").strip()
        return Path(override) if override else bundle.install_root()

    def _mark_bundle_healthy(self):
        """Сказать лаунчеру, что версия дожила до рабочего окна.

        Без этой отметки лаунчер считает версию «на испытательном сроке» и
        после двух запусков подряд без неё откатится на предыдущую. Это и есть
        защита от обновления, которое падает на старте.
        """
        if not bundle_mode():
            return
        try:
            bundle.mark_healthy(self._bundle_root(), ACTIVE_BUNDLE_VERSION)
        except Exception:
            pass

    def _on_check_update(self, manual: bool = False):
        """Есть ли обновление: сначала пакет кода, при неудаче — сборка целиком.

        Сетевой запрос — только в фоновом потоке: интерфейс не должен ждать
        ответа сервера, тем более при автопроверке на старте.
        """
        if self._update_busy:
            return
        self._update_busy = True
        channel = self._update_channel_value()
        self._set_update_ui(True, hint=tr("проверка обновлений…"),
                            button_text=tr("Проверяю…"))
        # Источник показываем прямо в логе: обновления всегда идут через
        # сервер проекта, и пилот это видит, а не вспоминает догадки.
        self.log(f"Проверяю обновления… (сервер проекта: "
                 f"{bundle_updater.update_base()})", "info")

        def worker():
            result = self._check_update_sources(channel)
            self.after(0, lambda r=result: self._on_update_checked(r, manual))

        threading.Thread(target=worker, daemon=True).start()

    def _check_update_sources(self, channel: str) -> dict:
        """Проверить только автономный канал нашего сервера.

        GitHub больше не является ни основным, ни резервным источником: иначе
        недоступность собственного канала незаметно возвращала старую
        зависимость и снова предлагала ручную замену exe.
        """
        if not bundle_mode():
            return {
                "ok": False,
                "kind": "bundle",
                "error": tr("пакетные обновления доступны в базовой сборке "
                            "ColonialHelper.exe"),
                "latest": VERSION,
            }
        result = bundle_updater.check_for_update(
            VERSION, channel=channel, launcher_version=LAUNCHER_VERSION)
        result["kind"] = "bundle"
        return result

    def _on_bundle_checked(self, result: dict, manual: bool):
        """Ответ канала пакетов: обновить код, обновить базовую сборку или ничего."""
        latest = str(result.get("latest") or VERSION)

        if not result.get("ok"):
            message = str(result.get("error") or tr("сервер не вернул манифест"))
            # Не обрезаем до пары слов: в сообщении о подписи ключевое —
            # каким ключом сервер подписал канал и чему верит эта сборка.
            self._set_update_ui(False, hint=tr("канал недоступен: {message}",
                                               message=message[:80]))
            if manual:
                self.log(f"Обновления не проверены: {message}", "warn")
            return

        if result.get("needs_launcher"):
            # Пакет собран под новый рантайм: обновить одни модули нельзя.
            need = str(result.get("min_launcher") or "")
            self._set_update_ui(False, hint=tr("нужна базовая сборка ≥ {version}",
                                               version=need))
            self.log(f"Версия {latest} требует новой базовой сборки "
                     f"(лаунчер {LAUNCHER_VERSION}, нужен {need}).", "warn")
            if manual:
                self._offer_launcher_update(latest)
            return

        if not result.get("update_available"):
            self._set_update_ui(False, hint=tr("актуальная версия v{version}",
                                               version=latest))
            self.log(f"Установлена актуальная версия {VERSION}", "success")
            return

        manifest = result.get("manifest") or {}
        try:
            plan = bundle_updater.plan_update(self._bundle_root(), manifest)
        except Exception:
            plan = {"download": [], "reuse": [], "bytes": 0}
        size_kb = int(plan.get("bytes") or 0) / 1024
        changed = len(plan.get("download") or [])
        rollback = bool(result.get("rollback"))
        self._set_update_ui(False, hint=tr(
            "{action} v{version} ({size} КБ)",
            action=tr("откат канала") if rollback else tr("доступна"),
            version=latest, size=f"{size_kb:.0f}"))
        self.log(f"{'Администратор откатил канал на' if rollback else 'Доступна версия'} "
                 f"{latest} (установлена {VERSION}): изменилось файлов — {changed}, "
                 f"скачать {size_kb:.0f} КБ. Программу перекачивать не нужно.", "warn")
        if not manual:
            self.log("Нажмите «Обновить программу», чтобы установить.", "info")
            return

        headline = (tr("Администратор вернул канал на {version}", version=latest)
                    if rollback
                    else tr("Доступна версия {version}", version=latest))
        if not ask_yes_no(
            tr("Обновление Colonial Helper"),
            tr("{headline} (у вас {current}).\n\n"
               "Обновятся только изменившиеся модули: {count} шт., {size} КБ.\n"
               "Программа перезапустится — токен и настройки сохранятся.\n\n"
               "Обновить сейчас?",
               headline=headline, current=VERSION, count=changed,
               size=f"{size_kb:.0f}"),
            parent=self.root,
        ):
            return
        self._start_bundle_update(manifest)

    def _start_bundle_update(self, manifest: dict):
        """Скачать изменившиеся файлы и переключить программу на новую версию."""
        self._update_busy = True
        self._update_last_percent = -10
        self._set_update_ui(True, hint=tr("обновление…"),
                            button_text=tr("Обновляю…"))

        def report(done: int, total: int):
            if not total:
                return
            percent = int(done * 100 / total)
            if percent - getattr(self, "_update_last_percent", -10) < 5:
                return
            self._update_last_percent = percent
            self.after(0, lambda p=percent: self._set_update_ui(
                True, hint=tr("обновление {percent}%", percent=p),
                button_text=tr("Обновляю…"), progress=p))

        def worker():
            result = bundle_updater.apply_update(
                self._bundle_root(), manifest, progress=report)
            self.after(0, lambda r=result: self._on_bundle_applied(r))

        threading.Thread(target=worker, daemon=True).start()

    def _on_bundle_applied(self, result: dict):
        self._update_busy = False
        self._update_last_percent = -10
        if not result.get("ok"):
            message = str(result.get("error") or tr("неизвестная ошибка"))
            self._set_update_ui(False, hint=tr("обновление не установлено"))
            self.log(f"Обновление не установлено: {message}", "error")
            if ask_yes_no(
                tr("Обновление Colonial Helper"),
                tr("Не удалось установить обновление:\n{error}\n\n"
                   "Скачать пакет целиком и восстановить установку?", error=message),
                parent=self.root,
            ):
                self._on_repair_install()
            return

        version = str(result.get("version") or "")
        downloaded_kb = int(result.get("downloaded") or 0) / 1024
        self._set_update_ui(False, hint=tr("установлена v{version} — нужен перезапуск",
                                           version=version))
        self.log(f"Версия {version} установлена ({downloaded_kb:.0f} КБ скачано, "
                 f"{result.get('reused')} файлов взято из текущей версии).", "success")
        if ask_yes_no(
            tr("Обновление установлено"),
            tr("Версия {version} установлена.\n\n"
               "Перезапустить программу сейчас?", version=version),
            parent=self.root,
        ):
            self._restart_after_update()
        else:
            self.log("Новая версия заработает после перезапуска программы.", "info")

    def _restart_after_update(self):
        """Запустить новый процесс и аккуратно закрыть текущий."""
        if not bundle_updater.restart_program():
            show_info(
                tr("Перезапуск"),
                tr("Не удалось перезапустить автоматически — закройте и откройте "
                   "программу вручную."),
                parent=self.root)
            return
        self.log("Перезапуск на новой версии…", "info")
        # Закрываемся штатно: оверлей, фоновые потоки и настройки — как при
        # обычном выходе, иначе новая копия столкнётся со старыми окнами.
        self.after(200, self._on_close)

    def _on_repair_install(self):
        """«Восстановить установку»: скачать пакет целиком и переложить файлы."""
        if not bundle_mode():
            show_info(
                tr("Восстановление"),
                tr("Программа запущена из исходников — восстанавливать нечего."),
                parent=self.root)
            return
        if self._update_busy:
            return
        self._update_busy = True
        channel = self._update_channel_value()
        self._set_update_ui(True, hint=tr("восстановление…"),
                            button_text=tr("Качаю пакет…"))
        self.log("Скачиваю пакет программы целиком…", "info")

        def report(done: int, total: int):
            if total:
                percent = int(done * 100 / total)
                self.after(0, lambda p=percent: self._set_update_ui(
                    True, hint=tr("восстановление {percent}%", percent=p),
                    button_text=tr("Качаю пакет…"), progress=p))

        def worker():
            result = bundle_updater.repair(
                self._bundle_root(), channel=channel, progress=report)
            self.after(0, lambda r=result: self._on_repair_done(r))

        threading.Thread(target=worker, daemon=True).start()

    def _on_repair_done(self, result: dict):
        self._update_busy = False
        if not result.get("ok"):
            self._set_update_ui(False, hint=tr("восстановить не удалось"))
            self.log(f"Восстановление не удалось: {result.get('error')}", "error")
            return
        version = str(result.get("version") or "")
        self._set_update_ui(False, hint=tr("восстановлена v{version}", version=version))
        self.log(f"Установка восстановлена: версия {version}.", "success")
        if ask_yes_no(tr("Восстановление"), tr("Перезапустить программу сейчас?"),
                      parent=self.root):
            self._restart_after_update()

    def _offer_launcher_update(self, latest: str):
        """Редкий случай: нужен новый exe (сменился рантайм программы)."""
        def worker():
            info = bundle_updater.check_launcher(LAUNCHER_VERSION)
            self.after(0, lambda i=info: self._on_launcher_checked(i, latest))

        threading.Thread(target=worker, daemon=True).start()

    def _on_launcher_checked(self, info: dict, latest: str):
        if not info.get("ok") or not info.get("url"):
            self._set_update_ui(False, hint=tr("базовая сборка не опубликована"))
            self.log("Новая базовая сборка ещё не опубликована на сервере. "
                     "Обратитесь к администратору.", "warn")
            return
        size_mb = int(info.get("size") or 0) / (1024 * 1024)
        if not ask_yes_no(
            tr("Нужна новая базовая сборка"),
            tr("Версия {version} требует обновлённой программы ({launcher}).\n\n"
               "Скачать {size} МБ? Это бывает редко — обычные обновления "
               "весят килобайты.",
               version=latest, launcher=info.get("version"),
               size=f"{size_mb:.1f}"),
            parent=self.root,
        ):
            return
        folder = Path.home() / "Downloads"
        self._update_busy = True
        self._set_update_ui(True, hint=tr("скачивание сборки…"),
                            button_text=tr("Скачиваю…"))

        def report(done: int, total: int):
            if total:
                percent = int(done * 100 / total)
                self.after(0, lambda p=percent: self._set_update_ui(
                    True, hint=tr("скачивание сборки {percent}%", percent=p),
                    button_text=tr("Скачиваю…"), progress=p))

        def worker():
            result = bundle_updater.download_launcher(info, folder, progress=report)
            self.after(0, lambda r=result: self._on_update_downloaded(
                r, {"version_text": info.get("version", ""),
                    "asset_name": "ColonialHelper.exe"}))

        threading.Thread(target=worker, daemon=True).start()

    def _on_update_checked(self, result: dict, manual: bool):
        """Все проверки теперь относятся только к серверному bundle-каналу."""
        self._update_busy = False
        self._on_bundle_checked(result, manual)

    def _on_update_downloaded(self, result: dict, release: dict):
        self._update_busy = False
        self._update_last_percent = -10
        if not result.get("ok"):
            message = str(result.get("error") or tr("неизвестная ошибка"))
            self._set_update_ui(False, hint=tr("скачивание не удалось"))
            self.log(f"Не удалось скачать обновление: {message}", "error")
            return
        path = str(result.get("path") or "")
        size_mb = int(result.get("size") or 0) / (1024 * 1024)
        self._set_update_ui(False, hint=tr("скачано: {file}", file=Path(path).name))
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
                color, text = COLOR_MUTED, tr("Игра: нет данных ({error})", error=state.error)
            elif state.running:
                color = COLOR_GREEN if state.focused else COLOR_ORANGE
                text = tr("Игра: в фокусе") if state.focused else tr("Игра: запущена (не в фокусе)")
            else:
                color, text = COLOR_RED, tr("Игра: не запущена")

            shell = getattr(self, "shell", None)
            if shell is not None and hasattr(shell, "set_game_state"):
                shell.set_game_state(text, color, "●" if state.running else "○")
            else:
                # Совместимость со старым окном: тех виджетов в Qt-оболочке
                # больше нет, поэтому ветка только для внешних сборок.
                self.game_dot.config(foreground=color)
                self.game_label.config(text=text, foreground=color)

            if state.running:
                details = [state.process_name or "Elite Dangerous"]
                if state.rect:
                    details.append(f"{state.width}x{state.height}")
                if state.title:
                    details.append(state.title)
                hint = "  |  ".join(details)
            else:
                hint = (tr("оверлей скрыт, пока игры нет")
                        if self.overlay_manager.settings.get("hide_when_game_off", True)
                        else "")
            setter = getattr(shell, "set_game_hint", None)
            if callable(setter):
                setter(hint)
            else:
                self.game_hint.config(text=hint)

            # Логируем только смену состояния, чтобы не засорять лог.
            if state.running != self._game_was_running:
                self._game_was_running = state.running
                if state.running:
                    self.log("Elite Dangerous запущена — оверлей активен", "success")
                else:
                    self.log("Elite Dangerous не запущена — оверлей скрыт", "info")
            if getattr(self, "overlay_page", None) is not None:
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
        timestamp = datetime.now().strftime("%H:%M:%S")
        line = f"[{timestamp}] {message}\n"

        page = getattr(self, "log_page", None)
        if page is not None:
            try:
                page.append(line.rstrip("\n"), level)
                page.update_count()
            except Exception:
                pass
        else:
            print(line.rstrip("\n"), file=sys.stderr)

        # Также в оверлей
        self.overlay_manager.log(message, level)

    # ============================================================
    #  Статус подключения
    # ============================================================
    def set_connection_status(self, online: bool, detail: str = ""):
        """Состояние связи с сайтом: строка оболочки + подпись на странице.

        Раньше здесь писались Tk-виджеты через `config(foreground=…)`, а в
        Qt-оболочке таких виджетов нет: вызов падал с `AttributeError`, и
        строка подключения не обновлялась ни при автопроверке, ни по кнопке
        «Проверить токен». Теперь запись идёт через оболочку (`set_connection`)
        и через подпись `auth_result` на странице «Подключение».
        """
        shell = getattr(self, "shell", None)
        setter = getattr(shell, "set_connection", None)
        if callable(setter):
            setter(online, detail or (tr("Готов к работе") if online
                                      else tr("Введите API токен")))

        auth = getattr(self, "auth_result", None)
        if auth is None:
            return
        if online:
            auth.set_status(tr("✓ Подключено как {name}", name=detail).rstrip(), COLOR_GREEN)
            return
        # «Не подключено» — это не всегда ошибка: пустое поле, сохранённый, но
        # ещё не проверенный токен. Красным помечаем только настоящие отказы.
        failed = any(marker in str(detail).lower() for marker in
                     ("ошиб", "невер", "недоступ", "сбой", "не удалось", "занят"))
        if failed:
            auth.set_status(f"✗ {detail}", COLOR_RED)
        else:
            auth.set_status(tr("○ Не подключено · {detail}", detail=detail) if detail
                            else tr("○ Не подключено — введите токен"), COLOR_ORANGE)

    # ============================================================
    #  Конфиг
    # ============================================================
    @property
    def api_client(self):
        """Совместимый псевдоним `self.api`.

        Досье из CAPI, выгрузка сканов и синхронизация статистики пилота
        писались под имя `api_client`, которого у приложения нет: клиент
        живёт в `self.api`. Проверки вида `getattr(self, "api_client", None)`
        это скрывали — выгрузка молча не работала, а поток досье падал с
        AttributeError, и статус навсегда застывал на «Загружаю досье…».
        """
        return getattr(self, "api", None)

    def load_config(self):
        if self.config_path.exists():
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    self.config = json.load(f)
                if not isinstance(self.config, dict):
                    self.config = {}
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
        credentials = {}
        try:
            with open(self.credentials_path, "r", encoding="utf-8") as f:
                credentials = json.load(f)
            if isinstance(credentials, dict):
                for key in (
                    "raven_colonial_key", "edsm_api_key",
                    "edsm_commander_name", "inara_api_key", "inara_commander_name",
                ):
                    if credentials.get(key):
                        self.config[key] = credentials[key]
        except (OSError, ValueError):
            pass

        try:
            site, token = saved_connection(self.config, credentials if isinstance(credentials, dict) else {})
            self.config["site_locale"] = normalize_locale(self.config.get("site_locale"))
            # Язык интерфейса — тот же, что выбран в лаунчере: он лежит в общем
            # файле настроек, и Helper обязан говорить на нём с первого окна.
            i18n.set_locale(self.config["site_locale"])
            self.api = ApiClient(token=token, site_url=site, locale=self.config["site_locale"])
            self.config["site_url"] = site
        except ValueError as exc:
            # Never silently send a saved token to a fallback host after a typo.
            self.config["site_locale"] = normalize_locale(self.config.get("site_locale"))
            i18n.set_locale(self.config["site_locale"])
            self.api = ApiClient(locale=self.config["site_locale"])
            self._site_config_error = tr(
                "Ошибка адреса сервера: {error}. Токен не загружен.", error=exc)

    def save_config(self):
        self.config["site_locale"] = normalize_locale(self.config.get("site_locale"))
        i18n.set_locale(self.config["site_locale"])
        locale_setter=getattr(getattr(self,"api",None),"set_locale",None)
        if callable(locale_setter):locale_setter(self.config["site_locale"])
        site = getattr(self, "_next_site_url", self.api.site_url)
        self.config["site_url"] = site
        self.config["token_site_url"] = site
        self.config["token"] = self.api.token if site == self.api.site_url else ""
        self.config["journal_path"] = str(self.journal_path)
        # Поле ввода могло быть изменено (вставлен/вписан новый ключ), но
        # пользователь мог не нажать "Проверить" перед закрытием приложения —
        # раньше в этом случае self.raven_api.api_key оставался старым (или
        # пустым), и введённый ключ молча терялся. Синхронизируем перед
        # каждым сохранением конфига, а не только после проверки ключа.
        if hasattr(self, "raven_key_entry"):
            try:
                entry_key = self.raven_key_entry.text().strip()
            except Exception:
                entry_key = ""
            if entry_key and entry_key != self.raven_api.api_key:
                self.raven_api.set_key(entry_key)
        self.config["raven_colonial_key"] = self.raven_api.api_key
        if hasattr(self, "edsm_key_entry"):
            self.edsm_api.set_credentials(self.edsm_key_entry.text(), self.edsm_name_entry.text())
        self.config["edsm_api_key"] = self.edsm_api.api_key
        self.config["edsm_commander_name"] = self.edsm_api.commander_name
        if hasattr(self, "inara_key_entry"):
            self.inara_api.set_credentials(self.inara_key_entry.text(),
                                           self.inara_name_entry.text())
        self.config["inara_api_key"] = self.inara_api.api_key
        self.config["inara_commander_name"] = self.inara_api.commander_name
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=2)
            os.chmod(self.config_path, 0o600)
        except Exception as e:
            self.log(f"Не удалось сохранить конфиг: {e}", "warn")
        # Дублируем только credentials в отдельном state-файле. Он не зависит
        # от формата общего config-файла и не затирается OverlayManager.
        credentials = {
            key: self.config.get(key, "")
            for key in (
                "site_url", "token", "raven_colonial_key", "edsm_api_key",
                "edsm_commander_name", "inara_api_key", "inara_commander_name",
            )
        }
        try:
            tmp = self.credentials_path.with_suffix(self.credentials_path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(credentials, f, indent=2, ensure_ascii=False)
            os.chmod(tmp, 0o600)
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
            and record.get("target") == self._upload_target()
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
                "target": self._upload_target(),
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
        # Состояния площадок тоже забываем: пользователь ждёт повторной
        # отправки, а не «ничего не произошло».
        self._construction_collector = ConstructionSnapshotCollector()
        self._community_goal_collector = CommunityGoalReportCollector()
        self.log(
            f"Кэш импорта сброшен ({count} записей) — файлы будут разобраны и загружены заново",
            "info",
        )

    def _reset_server_journals(self):
        """Очистить все журнальные данные на сервере (кнопка на вкладке загрузки).

        Нужна, когда в БД накопились мусорные части логов (оборванные импорты,
        старые схемы, неконсистентные повторы): «залить поверх» не поможет,
        потому что идемпотентные ключи deliveries не чистят мусор, а снимки
        строек и сканы тел остаются от старых прогонов. Сервер удаляет все
        журнальные данные этого пользователя и отвязывает авторство у общих
        colonisation_sites. Локальный кэш тоже сбрасывается: без этого Helper
        решит, что всё уже отправлено, и не пошлёт ничего заново.
        """
        if not self.api.is_connected:
            show_warning(
                tr("Нет подключения"),
                tr("Подключитесь к серверу (введите API-токен на вкладке "
                   "«Подключение»)"),
                parent=self.root,
            )
            return
        if not ask_yes_no(
            tr("Очистка журналов на сервере"),
            tr("Будут удалены ВСЕ ранее загруженные журналные данные этого профиля:\n"
               "  • поставки (тоннаж в досье)\n"
               "  • история импортов\n"
               "  • снимки строек и сводка пилота\n"
               "  • сканы тел, загруженные вами\n\n"
               "После очистки запустите «Загрузить журналы из папки» — логи будут "
               "пересчитаны и записаны заново.\n\n"
               "Продолжить?"),
            parent=self.root,
        ):
            return

        self.log("Очистка журнальных данных на сервере...", "info")

        def worker():
            result = self.api.reset_journal_data()
            self.root.after(0, lambda: self._on_server_journals_reset(result))

        threading.Thread(target=worker, daemon=True).start()

    def _on_server_journals_reset(self, result: dict):
        if not result.get("ok"):
            self.log(f"Очистка не удалась: {result.get('error', 'неизвестная ошибка')}", "error")
            show_error(
                tr("Ошибка очистки"),
                result.get("error", tr("Не удалось очистить журнальные данные")),
                parent=self.root,
            )
            return
        # Сбрасываем и локальный кэш, чтобы Helper действительно отправил
        # файлы заново, а не решил, что всё уже импортировано.
        self._reset_import_cache()
        r = result.get("reset") or {}
        self.log(
            "Журнальные данные на сервере очищены: "
            f"поставок — {r.get('deliveriesDeleted', 0)}, "
            f"импортов — {r.get('journalImportsDeleted', 0)}, "
            f"событий стройки — {r.get('legacyEventsDeleted', 0)}, "
            f"сканов тел — {r.get('systemScansDeleted', 0)}, "
            f"площадок отвязано — {r.get('sitesDetached', 0)}. "
            "Теперь можно загрузить логи заново.",
            "info",
        )
        show_info(
            tr("Очистка завершена"),
            tr("Сервер очистил журнальные данные профиля. Локальный кэш тоже "
               "сброшен. Нажмите «Загрузить журналы из папки», чтобы пересчитать "
               "логи с нуля."),
            parent=self.root,
        )

    def _on_close(self):
        self.overlay_manager.stop()
        try:
            self.dispatcher.stop(wait=False)
            try:
                if getattr(self, "_carrier_sync", None) is not None:
                    self._carrier_sync.save()
            except Exception:
                pass
            try:
                # Неотправленные наблюдения фракций переживают перезапуск.
                if getattr(self, "_bgs_sync", None) is not None:
                    self._bgs_sync.save()
            except Exception:
                pass
        except Exception:
            pass
        self.save_config()
        self.root.destroy()

    # ============================================================
    #  Обработчики: Подключение
    # ============================================================
    def _open_site_account(self):
        import webbrowser
        webbrowser.open(localized_url(f"{self.api.site_url}/account?tab=tokens", self.config.get("site_locale")), new=2)

    def _change_site_url(self):
        value = ask_string(tr("Сервер ED Ring Colony"), tr("HTTPS-адрес сайта (не Supabase):"),
                                       initialvalue=self.api.site_url, parent=self.root)
        if value is None:
            return
        try:
            site = normalize_site_url(value)
        except ValueError as exc:
            show_error(tr("Адрес сервера"), str(exc), parent=self.root)
            return
        if site == self.api.site_url:
            return
        if not ask_yes_no(
                tr("Смена сервера"),
                tr("Новый сервер: {site}\n\nТокен сайта будет удалён из настроек. "
                   "Приложение закроется: запустите его снова и введите токен нового "
                   "сервера. Ключи Raven/EDSM/Inara сохранятся. Продолжить?", site=site),
                parent=self.root):
            return
        # In-flight requests retain the old client/host. Never repoint a client
        # carrying the previous host's token while worker threads are running.
        self._next_site_url = site
        if self.watcher_active:
            self._stop_watcher()
        self._on_close()

    def _on_validate_token(self):
        """Проверка токена сайта — строго в фоновом потоке.

        Раньше `self.api.validate_token()` вызывался прямо здесь, в потоке Tk,
        и автопроверка при старте (`after(500, self._auto_validate)`) намертво
        подвешивала окно: HTTP-запрос ждёт до 15 с, а при недоступном сервере
        или неисправном TLS-сертификате к этому добавляются DNS и рукопожатие.
        Пользователь видел «жёсткое зависание сразу после запуска» — окно не
        перерисовывалось, кнопки не нажимались, Windows рисовал «Не отвечает».

        Теперь сеть уходит в поток, а UI обновляется только через `after(0, …)`.
        Повторный запуск проверки блокируется флагом: два параллельных
        `validate_token` меняли бы состояние клиента одновременно.
        """
        token = self.token_entry.text().strip()
        if not token:
            self.set_connection_status(False, tr("Токен не введён"))
            self.log("Введите API токен", "error")
            return

        if self.watcher_active and token != self.api.token:
            self.log("Перед сменой API-токена остановите Watcher, чтобы не смешать аккаунты.", "error")
            return

        if getattr(self, "_token_check_busy", False):
            return
        self._token_check_busy = True

        self.log(tr("Проверка токена..."), "info")
        self.set_status(tr("Проверка токена..."))
        auth = getattr(self, "auth_result", None)
        if auth is not None:
            auth.set_status(tr("Проверка токена…"), COLOR_ORANGE)

        def worker():
            try:
                result = self.api.validate_token(token)
            except Exception as exc:  # сеть/TLS не должны ронять поток
                result = {"ok": False, "error": tr("Ошибка проверки: {error}", error=exc)}
            self.root.after(0, lambda r=result: self._on_token_validated(r))

        threading.Thread(target=worker, daemon=True, name="validate-token").start()

    def _on_token_validated(self, result: dict):
        """Результат проверки токена — уже в потоке окна.

        Флаг `_token_check_busy` снимается в `finally`: если обработка
        результата падала, кнопка «Проверить токен» молча перестала бы
        работать до перезапуска программы.
        """
        try:
            self._apply_token_result(result or {})
        finally:
            self._token_check_busy = False

    def _apply_token_result(self, result: dict):
        self._token_check_busy = False
        if result.get("ok"):
            self.set_connection_status(True, self.api.display_name)
            self.log(f"Авторизован как {self.api.display_name}", "success")
            self.save_config()
            self._capi_refresh_status()
            if not self.watcher_active:
                self.root.after(300, self._auto_start_watcher)
        else:
            self.set_connection_status(False, result.get("error", tr("Ошибка")))
            self.log(f"Ошибка: {result.get('error')}", "error")
        self.set_status(tr("Готов"))

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
                self.token_entry.setText(text.strip())
                self.log("Токен вставлен из буфера обмена", "success")
            else:
                self.log("Буфер обмена пуст", "warn")
        except Exception as e:
            self.log(f"Ошибка вставки: {e}", "error")

    def _toggle_token_visibility(self):
        self.auth_page.toggle_token_visibility()

    def _on_check_raven(self):
        key = self.raven_key_entry.text().strip()
        if not key:
            self.raven_status_label.set_status(tr("Raven Colonial: ключ пустой"), COLOR_RED)
            self.log("Raven Colonial API ключ пустой", "warn")
            return
        self.raven_api.set_key(key)
        self.config["raven_colonial_key"] = key
        self.save_config()
        self._update_colony_key_label()
        self.raven_status_label.set_status(tr("Raven Colonial: проверка…"), COLOR_ORANGE)
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
        try:
            result = self.raven_api.get_cmdr_by_key(key) or {}
        except Exception as exc:     # сеть/TLS не должны оставлять «проверка…»
            result = {"ok": False, "status": 0, "error": str(exc)}
        if result.get("ok"):
            cmdr = self.raven_api.cmdr_display_name(result)
            self.root.after(0, lambda: self.raven_status_label.set_status(
                tr("Raven Colonial: подключено"), COLOR_GREEN))
            self.root.after(0, lambda: self.log(tr("Raven Colonial: ключ действителен"),
                                                "success"))
            if cmdr:
                self.root.after(0, lambda name=cmdr: self._apply_rcc_commander(name))
            # До появления ключа доставки копились в очереди досылки
            # (`_flush_raven_deliveries` без ключа ничего не отправляет).
            # Ключ есть — досылаем их сразу, а не ждём следующего тика.
            self.root.after(0, lambda: self._flush_raven_deliveries(
                cmdr or self._current_cmdr_name(), force=True))
            return

        status = int(result.get("status") or 0)
        error = str(result.get("error") or tr("неизвестная ошибка"))
        if status == 401:
            text = tr("Raven Colonial: ключ неверный")
            log_text = tr("Raven Colonial: ключ неверный (401)")
        elif status == 0:
            text = tr("Raven Colonial: сетевая ошибка")
            log_text = tr("Raven Colonial: ошибка {error}", error=error)
        else:
            text = tr("Raven Colonial: ошибка {error}", error=status)
            log_text = tr("Raven Colonial: ошибка {error}", error=error)
        level = "error"
        self.root.after(0, lambda t=text: self.raven_status_label.set_status(t, COLOR_RED))
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
        if getattr(self, "colony_page", None) is not None:
            self.colony_page.set_cmdr(name)
        if hasattr(self, "colony_key_label"):
            self.colony_page.set_key_status(
                tr("RCC ключ задан · {name}", name=name), COLOR_GREEN)
        self.log(f"Raven Colonial: командир по ключу RCC — {name}", "success")
        # Список проектов сразу не обновляем: пользователь может нажать
        # «Обновить список» сам, а лишний запрос на каждое сохранение не нужен.

    def _on_browse_journal_path(self):
        path = ask_directory(initialdir=str(self.journal_path))
        if path:
            self.journal_path = Path(path)
            self.path_entry.setText(str(self.journal_path))
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

        # Синхронизируем первопроходца из карты системы, если есть данные
        if tracker.current_system and tracker.current_body and hasattr(self, "system_map"):
            sm_body = self.system_map.find_body(tracker.current_system, tracker.current_body)
            if sm_body is not None:
                if sm_body.first_footfall_by:
                    is_me = (sm_body.first_footfall_by in ("Вы", "You"))
                    tracker.set_body_footfall(tracker.current_system, tracker.current_body,
                                              no_first_footfall=is_me,
                                              first_footfall_by=sm_body.first_footfall_by)
                elif sm_body.from_external and not sm_body.first_footfall_by:
                    tracker.set_body_footfall(tracker.current_system, tracker.current_body,
                                              no_first_footfall=True, first_footfall_by="")
                elif sm_body.first_discovered_by in ("Вы", "You"):
                    tracker.set_body_footfall(tracker.current_system, tracker.current_body,
                                              no_first_footfall=True, first_footfall_by="")

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
        files = ask_open_files(
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
            self.upload_page.set_files_text(
                tr("Выбрано файлов: {count}", count=len(self.selected_files)))
            self.upload_page.set_upload_enabled(True)
            self.log(f"Выбрано {len(self.selected_files)} файлов", "info")

    def _on_upload(self):
        if not self.selected_files:
            return
        if not self.api.is_connected:
            self.log("Сначала введите и проверьте API токен", "error")
            return

        self.upload_page.set_upload_enabled(False)
        self.upload_page.set_progress(0)
        self.upload_page.set_progress_text(tr("Обработка..."))
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
        (edringcolony.ru). Если там Zod-схема строгая
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
            # Сайт разделяет «весь перевозимый груз» и «завезено на
            # стройплощадки» (новый блок досье). Признак считается парсером
            # журнала, поэтому уезжает вместе с поставкой: серверу незачем
            # угадывать источник по набору полей.
            "source": d.get("source"),
            "is_construction": d.get("is_construction"),
            # Куда именно сдан груз (стройка / колонизационный корабль /
            # авианосец / миссия / рынок): по нему досье строит блок
            # «структура перевозок».
            "delivery_kind": d.get("delivery_kind"),
            "station_name": d.get("station_name"),
            "station_kind": d.get("station_kind"),
        }

    def _format_import_summary(self, files_count: int, event_counts: "Counter", deliveries: list, elapsed: float) -> str:
        """Собрать текст итоговой таблицы импорта (моноширинный текст)."""
        total_events = sum(event_counts.values())
        total_tons = sum(d.get("amount", 0) for d in deliveries)
        width = 44
        lines = []
        lines.append("═" * width)
        lines.append(" " + tr("ИТОГИ ИМПОРТА"))
        lines.append("─" * width)
        # Подписи берём из каталога, а выравнивание считаем по самой длинной:
        # иначе в переводе цифры разъезжаются с подписями.
        rows = [
            (tr("Файлов обработано:"), str(files_count)),
            (tr("Событий прочитано:"), str(total_events)),
            (tr("Найдено доставок:"), str(len(deliveries))),
            (tr("Общий вес доставок:"), f"{total_tons:.0f} t"),
            (tr("Время обработки:"), tr("{seconds} с", seconds=f"{elapsed:.1f}")),
        ]
        pad = max(len(label) for label, _value in rows) + 2
        lines.extend(f" {label}{' ' * (pad - len(label))}{value}"
                     for label, value in rows)
        kind_lines = self._format_delivery_kinds(deliveries, total_tons)
        if kind_lines:
            lines.extend(kind_lines)
        if event_counts:
            lines.append("─" * width)
            lines.append(" " + tr("События по типам:"))
            name_width = min(34, max((len(k) for k in event_counts), default=10) + 1)
            for name, count in sorted(event_counts.items(), key=lambda kv: (-kv[1], kv[0])):
                lines.append(f"   {name:<{name_width}} {count:>7}")
        lines.append("═" * width)
        return "\n".join(lines)

    #: Подписи видов сдачи груза в итоговой таблице импорта. Значения ключей —
    #: `delivery_kind` из парсера журнала (зеркало `src/lib/cargoScope.ts`);
    #: сами подписи — ключи перевода, их печатает :meth:`_format_delivery_kinds`.
    DELIVERY_KIND_LABELS = (
        ("construction_site", "Стройплощадки колонизации"),
        ("colonisation_ship", "Колонизационные корабли"),
        ("fleet_carrier", "Авианосцы"),
        ("mission_delivery", "Грузовые миссии"),
        ("market_sale", "Продажа на рынках"),
        ("powerplay_delivery", "Powerplay"),
        ("rescue_delivery", "Search and Rescue"),
    )

    @classmethod
    def _format_delivery_kinds(cls, deliveries: list, total_tons: float, width: int = 44) -> list:
        """Разбивка тоннажа по получателю груза для итоговой таблицы импорта.

        Командиру важно видеть не только «всего тонн», но и сколько из них
        реально ушло на площадки колонизационных проектов, а сколько —
        авианосцам, грузовым миссиям и обычным рынкам.
        """
        tons: Dict[str, float] = {}
        for delivery in deliveries or []:
            if not isinstance(delivery, dict):
                continue
            kind = str(delivery.get("delivery_kind") or "") or "unknown"
            try:
                amount = float(delivery.get("amount", 0) or 0)
            except (TypeError, ValueError):
                continue
            tons[kind] = tons.get(kind, 0.0) + amount

        if not tons:
            return []

        lines = ["─" * width, " " + tr("Куда ушёл груз:")]
        kind_labels = [(kind, tr(label)) for kind, label in cls.DELIVERY_KIND_LABELS]
        label_width = max((len(label) for _kind, label in kind_labels), default=20)
        label_width = min(34, max(20, label_width))
        for kind, label in kind_labels:
            value = tons.pop(kind, 0.0)
            if value <= 0:
                continue
            share = (value / total_tons * 100.0) if total_tons > 0 else 0.0
            lines.append(f"   {label:<{label_width}} {value:>9.0f} t  {share:>5.1f}%")
        for kind, value in sorted(tons.items(), key=lambda kv: -kv[1]):
            if value <= 0:
                continue
            share = (value / total_tons * 100.0) if total_tons > 0 else 0.0
            lines.append(f"   {kind:<28} {value:>9.0f} t  {share:>5.1f}%")
        return lines

    def log_block(self, text: str, level: str = "info"):
        """Вставить многострочный блок текста в лог одним куском, без
        временной метки на каждой строке (в отличие от log()) — используется
        для итоговой таблицы импорта."""
        timestamp = datetime.now().strftime("%H:%M:%S")
        block = f"[{timestamp}]\n{text}\n"

        page = getattr(self, "log_page", None)
        if page is not None:
            try:
                page.append_block(block.rstrip("\n"), level)
                page.update_count()
            except Exception:
                pass
        else:
            print(block.rstrip("\n"), file=sys.stderr)

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
                    self.upload_page.set_progress(value)
                if text is not None:
                    self.upload_page.set_progress_text(text)
            except Exception:
                pass

        self.root.after(0, apply)

    def _any_third_party_enabled(self) -> bool:
        return bool(self.edsm_api.enabled or self.inara_api.enabled or self.raven_api.is_connected)

    def _do_upload_thread(self):
        all_deliveries = []
        community_goal_reports = []
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
            self.root.after(0, lambda: self._update_progress(
                100, tr("Все выбранные файлы уже загружены"), force=True))
            self.root.after(0, lambda: self.upload_page.set_upload_enabled(True))
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
                    file_goal_reports = []

                    def community_goal_hook(_line, event):
                        file_goal_reports.extend(community_goal_reports_from_event(event))

                    (
                        cname, deliveries, self._last_cargo, self._last_depot_state,
                        self._last_contribution_state, self._seen_events, event_counts,
                    ) = parse_events(
                        iter_journal_events(text), current_system, self._last_cargo, self._last_depot_state,
                        self._last_contribution_state, self._seen_events, current_system_address,
                        hooks=hooks + [community_goal_hook],
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
                    community_goal_reports.extend(file_goal_reports)
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
                    tr("Разбор файлов: {done}/{total}",
                       done=processed_count, total=total),
                )

            self._flush_station_reports()

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

        if not all_deliveries and not construction_events and not community_goal_reports:
            self.root.after(0, lambda: self.log("Доставки, события строительства и CG не найдены", "warn"))
            self.root.after(0, lambda: self._mark_files_imported(accepted_files))
            self.root.after(0, lambda: self.upload_page.set_upload_enabled(True))
            self.root.after(0, lambda: self._update_progress(0, "", force=True))
            return

        # ---- Отправка snapshots стройплощадок (общий прогресс проекта) ----
        construction_ok = True
        if construction_events:
            self._update_progress(
                85, tr("Отправка снимков строек: {count}…",
                       count=len(construction_events)), force=True)

            def construction_progress(done, total_chunks):
                self._update_progress(
                    85 + 5.0 * done / max(1, total_chunks),
                    tr("Отправка снимков строек: {done}/{total} пачек",
                       done=done, total=total_chunks),
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

        community_goal_reports_ok = True
        if community_goal_reports:
            community_result = self.api.upload_community_goal_reports(community_goal_reports, cmdr_name)
            community_goal_reports_ok = bool(community_result.get("ok"))
            if community_goal_reports_ok:
                stored = int(community_result.get("stored", 0) or 0)
                catalog_updated = int(community_result.get("communityGoalCatalogUpdated", 0) or 0)
                self.root.after(0, lambda n=stored, c=catalog_updated: self.log(
                    f"Community Goals: личных снимков сохранено — {n}; записей каталога обновлено — {c}", "success"))
            else:
                error_text = community_result.get("error", "ошибка")
                self.root.after(0, lambda e=error_text: self.log(
                    f"Отчёты Community Goals не отправлены: {e}", "warn"))

        # ---- Отправка доставок ----
        if not all_deliveries:
            if not community_goal_reports:
                self.root.after(0, lambda: self.log("Доставки не найдены", "warn"))
            if construction_ok and community_goal_reports_ok:
                self.root.after(0, lambda: self._mark_files_imported(accepted_files))
            self.root.after(0, lambda: self._update_progress(100, tr("Готово"), force=True))
            self.root.after(0, lambda: self.upload_page.set_upload_enabled(True))
            return

        self.root.after(
            0,
            lambda: self.log(f"Всего доставок: {len(all_deliveries)}. Отправка...", "info"),
        )

        def delivery_progress(done, total_chunks):
            self._update_progress(
                90 + 10.0 * done / max(1, total_chunks),
                tr("Отправка доставок: {done}/{total} пачек",
                   done=done, total=total_chunks),
            )

        self._update_progress(
            90, tr("Отправка {count} записей…", count=len(all_deliveries)), force=True)
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
                0, lambda e=str(e): self._update_progress(
                    None, tr("Ошибка: {error}", error=e[:100]), force=True)
            )
            self.root.after(0, lambda: self.upload_page.set_upload_enabled(True))
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
                lambda ins=inserted, rt=route_tons: self.upload_page.set_progress_text(
                    tr("Загружено: {count} записей ({tons}t на маршрут)",
                       count=ins, tons=f"{rt:.0f}")
                ),
            )
            if construction_ok and community_goal_reports_ok:
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
                lambda e=error_text: self.upload_page.set_progress_text(
                    tr("Ошибка: {error}", error=str(e)[:100])),
            )
        self.root.after(0, lambda: self.upload_page.set_upload_enabled(True))

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
        self._backfill_community_goal_reports = []
        self.dispatcher.reset_stats()

        self.carrier.reset()

        self.upload_page.set_watcher_running(True)
        self.log("Watcher запущен. Мониторинг журналов...", "success")
        self.set_status(tr("Watcher: активен"))
        self.overlay_manager.log("Watcher запущен", "success")

        # Всё чтение журналов ушло в поток watcher'а (`_prepare_watcher_state`).
        # Раньше NavRoute, поиск текущей системы, восстановление площадки и
        # авианосца, Loadout и Status.json читались прямо здесь, в потоке Tk:
        # это десятки мегабайт разбора JSON при каждом старте, и окно висело
        # «не отвечает» ровно столько, сколько занимал разбор папки журналов.
        self.watcher_thread = threading.Thread(target=self._watcher_thread_main, daemon=True)
        self.watcher_thread.start()
        self._start_exobio_history_indexer()

    def _watcher_thread_main(self):
        """Поток watcher'а: сперва восстановление состояния, затем цикл."""
        try:
            self._prepare_watcher_state()
        except Exception as exc:
            self.root.after(0, lambda e=exc: self.log(f"Подготовка watcher'а: {e}", "warn"))
        self._watcher_loop()

    def _prepare_watcher_state(self):
        """Восстановить состояние по журналам — выполняется в фоне.

        Порядок сохранён прежний, потому что он важен: маршрут → текущая
        система → площадка и авианосец → Loadout → текущие JSON-файлы
        (Status.json может уточнить систему). Единственное отличие — поток:
        UI больше не ждёт разбора журналов.
        """
        self._auto_load_navroute()

        # Если приложение запущено, когда игрок уже находится в системе (нет
        # свежих FSDJump/Location/Docked), current_system остался бы пустым, и
        # parse_journal() отбрасывал бы все доставки до первого прыжка.
        detected_system, detected_addr = self._determine_cmdr_system()
        if detected_system:
            self.ship.state.current_system = detected_system
            if detected_addr:
                self.ship.state.system_address = detected_addr
            self.root.after(0, lambda n=detected_system: self.log(f"Текущая система CMDR: {n}", "info"))
        else:
            self.root.after(0, lambda: self.log(
                "Не удалось определить текущую систему CMDR из журналов — "
                "будет определена по первому FSDJump/Location/Docked событию.",
                "warn",
            ))

        # Площадка и авианосец: без этого программа, запущенная, когда командир
        # УЖЕ стоит у площадки или на борту FC, не знает их market_id.
        self._restore_station_state_from_journal()

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

    #: Сколько журналов и байт с конца просматриваем в поисках текущей системы.
    DETECT_SYSTEM_MAX_FILES = 8
    DETECT_SYSTEM_MAX_BYTES = 4 * 1024 * 1024

    def _determine_cmdr_system(self) -> tuple:
        """Найти последнюю известную систему CMDR по хвостам свежих журналов.

        Возвращает (star_system, system_address); любое значение может быть
        None/0, если найти не удалось.

        Раньше метод читал файлы целиком (`readlines()`) и обходил всю папку
        журналов. У игроков с многолетней историей это сотни мегабайт и
        десятки секунд — а вызывался он при каждом старте watcher'а. Теперь
        читается только хвост последних файлов: событие `Location`/`FSDJump`/
        `Docked` в свежем журнале всегда рядом с концом.
        """
        try:
            files = sorted(
                self.journal_path.glob("Journal.*.log"),
                key=lambda f: f.stat().st_mtime,
                reverse=True,
            )[: self.DETECT_SYSTEM_MAX_FILES]
        except Exception:
            return None, 0

        for path in files:
            try:
                size = path.stat().st_size
                with open(path, "rb") as fh:
                    if size > self.DETECT_SYSTEM_MAX_BYTES:
                        fh.seek(size - self.DETECT_SYSTEM_MAX_BYTES)
                        fh.readline()  # отбрасываем неполную строку
                    raw = fh.read()
            except OSError:
                continue
            for line in reversed(raw.decode("utf-8", errors="replace").splitlines()):
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
        state_events: list = []
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
            for event in events:
                map_events.append(event)
                if event.get("event") in self.RESTORE_STATE_EVENTS:
                    state_events.append(event)
            # Не прерываем сбор событий карты и экзобиологии: даже если пилот уже
            # пристыкован, сканы тел системы могли быть сделаны в предыдущих файлах.

        # Хронологический порядок важен: трекеры «отпускают» площадку по
        # Undocked и чужой авианосец по Docked к другой станции, а трекер
        # авианосца сверяет поимённый груз с тоннажем из CarrierStats. Файлы
        # читаются от новых к старым, поэтому раньше события вчерашнего
        # журнала применялись ПОСЛЕ сегодняшних: активным оставался носитель,
        # от которого командир давно улетел, а его груз — в блоке CARRIER.
        state_events.sort(key=lambda item: str(item.get("timestamp") or ""))
        for event in state_events:
            try:
                self._station_commerce_collector().feed(event, live=False)
            except Exception:
                pass
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
            notes.append(tr(
                "стройплощадка {market_id} ({system})",
                market_id=site.market_id,
                system=site.system_name or tr("система не известна")))
        market_id = int(self.carrier.state.market_id or 0)
        if market_id:
            notes.append(tr("авианосец {market_id}", market_id=market_id))
        if notes:
            self.log("Восстановлено из журнала: " + ", ".join(notes), "info")
            # Оба состояния теперь известны — сразу спрашиваем Raven Colonial,
            # сколько осталось завезти и что лежит на борту (включая груз,
            # который завезли другие командиры).
            self._refresh_site_project(force=True)
            self._refresh_carrier_cargo(market_id, force=True)
        return restored

    def _load_current_state_files(self):
        """Прочитать текущие JSON-файлы состояния (Status, ModulesInfo, Cargo).

        Файлы — это то же содержимое, что и события журнала, только «как сейчас».
        Поэтому здесь больше нет собственного парсера: `ShipTracker` вызывается с
        флагом устаревших данных. Прежняя копия разбора и была причиной того, что
        оверлей врал: `Status.json` читал `HullHealth`, которого в файле нет, а
        `ModulesInfo.json` принимал `Health` за честное значение и «чинил» им
        разбитые модули. Теперь оба читает один код.
        """
        loaded = []
        st = self.ship.state
        try:
            status_file = self.journal_path / "Status.json"
            if status_file.exists():
                with open(status_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.ship.parse_status_json(data)
                loaded.append("Status")
        except Exception as e:
            self.root.after(0, lambda e=e: self.log(f"Ошибка чтения Status.json: {e}", "warn"))
        try:
            modules_file = self.journal_path / "ModulesInfo.json"
            if modules_file.exists():
                with open(modules_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self.ship.parse_modules_info_json(data)
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
        self.upload_page.set_watcher_running(False)
        self.log("Watcher остановлен", "info")
        self.set_status(tr("Готов"))
        self.overlay_manager.log("Watcher остановлен", "info")

    def _upload_target(self) -> str:
        return f"{self.api.site_url}|{self.api.user_id or ''}"

    def _load_journal_offsets(self) -> dict:
        path = self.config_path.with_name(".colonial_helper_journal_offsets.json")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return (data.get("offsets", {}) if isinstance(data, dict)
                    and data.get("target") == self._upload_target()
                    and isinstance(data.get("offsets"), dict) else {})
        except (OSError, ValueError):
            return {}

    def _save_journal_offsets(self):
        path = self.config_path.with_name(".colonial_helper_journal_offsets.json")
        try:
            # Snapshot and serialize in one critical section so two watcher
            # threads in this process cannot overlap saves or mutate the dict
            # while it is being encoded.
            with _JOURNAL_OFFSETS_LOCK:
                payload = {
                    "target": self._upload_target(),
                    "offsets": dict(self.last_file_mtimes),
                }
                _atomic_write_journal_offsets(path, payload)
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
            detail = tr(
                "Первичная загрузка: {percent}% | файлы {done}/{total} | "
                "{done_mb}/{total_mb} MB | {file}",
                percent=f"{percent:.1f}", done=done_files, total=total_files,
                done_mb=f"{done_mb:.1f}", total_mb=f"{total_mb:.1f}",
                file=current_file)
        else:
            percent = 100.0
            detail = tr("Первичная загрузка: файлов для чтения нет | {done}/{total}",
                        done=done_files, total=total_files)
        self.upload_page.set_progress(percent, detail)

    def _finish_journal_reconciliation(self, message: str):
        """Оставить результат первичной сверки в UI, не стирая прогресс."""
        self.upload_page.set_progress(100, message)
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
        self._flush_station_reports()
        deliveries, construction = self._backfill_deliveries, self._backfill_construction
        community_goal_reports = self._backfill_community_goal_reports
        self._backfill_deliveries, self._backfill_construction = [], []
        self._backfill_community_goal_reports = []
        if not deliveries and not construction and not community_goal_reports:
            return
        cmdr_name = self._watcher_cmdr_name or ""

        def log(message: str, level: str = "info"):
            self.root.after(0, lambda m=message, l=level: self.log(m, l))

        log(f"Первичная загрузка: отправка на сайт — {len(deliveries)} доставок, "
            f"{len(construction)} snapshots стройки, "
            f"{len(community_goal_reports)} отчётов CG", "info")

        if construction and self.api.is_connected:
            def construction_progress(done, total_chunks):
                self._update_progress(
                    100.0, tr("Отправка снимков строек: {done}/{total} пачек",
                              done=done, total=total_chunks))

            result = self.api.upload_construction_events(
                construction, cmdr_name, progress_cb=construction_progress
            )
            if result.get("ok"):
                log(f"Первичная загрузка: snapshots стройки отправлены ({len(construction)})", "success")
            else:
                # Та же причина, что и в живом тике: подписи состояний уже
                # записаны, поэтому без возврата в накопитель пачка потеряется.
                self._construction_collector.requeue(construction)
                log(f"Первичная загрузка: snapshots стройки не отправлены — "
                    f"{result.get('error', 'ошибка')}", "warn")

        if community_goal_reports:
            if not self.api.is_connected:
                self._community_goal_collector.requeue(community_goal_reports)
            else:
                result = self.api.upload_community_goal_reports(community_goal_reports, cmdr_name)
                if result.get("ok"):
                    log(
                        "Первичная загрузка: Community Goals — личных снимков "
                        f"{result.get('stored', 0)}, записей каталога обновлено "
                        f"{result.get('communityGoalCatalogUpdated', 0)}",
                        "success",
                    )
                else:
                    self._community_goal_collector.requeue(community_goal_reports)
                    log(f"Первичная загрузка: отчёты CG не отправлены — {result.get('error', 'ошибка')}", "warn")

        if deliveries and self.api.is_connected:
            def delivery_progress(done, total_chunks):
                self._update_progress(
                    100.0, tr("Отправка доставок: {done}/{total} пачек",
                              done=done, total=total_chunks))

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
        with _JOURNAL_OFFSETS_LOCK:
            self.last_file_mtimes = {}
        first_reconciliation = not bool(offsets)
        # Сессия наблюдения начинается заново: текущее состояние площадок
        # уходит на сайт один раз (повтор всё равно схлопывается по
        # `source_hash`), а дальше отправляются только изменения.
        self._construction_collector = ConstructionSnapshotCollector()
        self._community_goal_collector = CommunityGoalReportCollector()
        for f in sorted(self.journal_path.glob("Journal.*.log"), key=lambda f: f.stat().st_mtime):
            try:
                # Первый запуск проверяет историю с начала файлов; после этого
                # сохраняются byte offsets, как в EDDiscovery.
                with _JOURNAL_OFFSETS_LOCK:
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
                0, n, b, 0, tr("Подготовка журналов...")
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
                    with _JOURNAL_OFFSETS_LOCK:
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
                self.root.after(0, lambda: self._finish_journal_reconciliation(
                    tr("Новых строк для загрузки не найдено")))
            elif not self.watcher_stop_event.is_set():
                self.root.after(0, lambda: self._finish_journal_reconciliation(
                    tr("Первичная загрузка журналов завершена")))

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
                        with _JOURNAL_OFFSETS_LOCK:
                            self.last_file_mtimes[fpath] = last_size + processed
                        self._save_journal_offsets()
            except Exception as e:
                self.root.after(0, lambda e=e: self.log(f"Watcher ошибка: {e}", "error"))

            # 2. Потом читаем JSON-файлы — НЕ перезаписываем health модулей
            self._load_current_state_files()
            try:
                commerce = self._station_commerce_collector()
                commerce.read_files(self.journal_path)
                result = commerce.flush(self.api)
                if not result.get("ok") and commerce.pending:
                    # Keep data queued; avoid flooding the log every five seconds.
                    now = time.monotonic()
                    if now - getattr(self, "_commerce_warning_at", 0) > 60:
                        self._commerce_warning_at = now
                        self.root.after(0, lambda message=result.get("error", ""): self.log(f"Station reports pending: {message}", "warn"))
            except Exception as exc:
                self.root.after(0, lambda message=str(exc): self.log(f"Station inventory: {message}", "error"))
            try:
                self._flush_carrier_sync()
            except Exception as exc:
                self.root.after(0, lambda message=str(exc): self.log(f"Авианосцы: {message}", "error"))
            try:
                self._flush_bgs_sync()
            except Exception as exc:
                self.root.after(0, lambda message=str(exc): self.log(f"Фракции: {message}", "error"))
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

    def _flush_station_reports(self, max_batches=25):
        """Send historical station visits even when the file has no deliveries."""
        try:
            collector = self._station_commerce_collector()
            for _ in range(max_batches):
                if not collector.pending or not self.api.is_connected:
                    break
                result = collector.flush(self.api)
                if not result.get("ok"):
                    self.root.after(0, lambda message=result.get("error", ""): self.log(f"Station reports pending: {message}", "warn"))
                    break
        except Exception as exc:
            self.root.after(0, lambda message=str(exc): self.log(f"Station reports: {message}", "warn"))

    def _station_commerce_collector(self):
        collector = getattr(self, "_station_commerce", None)
        if collector is None:
            from station_commerce import StationCommerceCollector
            collector = StationCommerceCollector(self.config_path.with_name(".station_commerce_outbox.json"))
            # Новый снимок рынка авианосца исправляет его груз в Raven Colonial.
            collector.on_inventory = self._on_station_inventory
            self._station_commerce = collector
        return collector

    def _carrier_sync_collector(self):
        """События авианосцев для сайта проекта (outbox на диске, см. carrier_sync.py)."""
        collector = getattr(self, "_carrier_sync", None)
        if collector is None:
            from carrier_sync import CarrierEventCollector
            collector = CarrierEventCollector(
                self.config_path.with_name(".carrier_events_outbox.json"),
                inventory_reader=self._read_ship_inventory,
            )
            self._carrier_sync = collector
        return collector

    def _bgs_sync_collector(self):
        """Состояние фракций посещённых систем для сайта проекта (см. bgs_sync.py)."""
        collector = getattr(self, "_bgs_sync", None)
        if collector is None:
            from bgs_sync import BgsSnapshotCollector
            collector = BgsSnapshotCollector(self.config_path.with_name(".bgs_snapshots_outbox.json"))
            self._bgs_sync = collector
        return collector

    def _flush_bgs_sync(self):
        """Отправить накопленные наблюдения фракций на сайт проекта (вкладка «Фракции» Atlas)."""
        if not self.api.is_connected:
            return
        collector = self._bgs_sync_collector()
        # Как у авианосцев: после сбоя — пауза, чтобы недоступный сайт не
        # подвешивал цикл чтения журнала таймаутами.
        if not collector.pending_count or time.monotonic() < float(getattr(self, "_bgs_flush_retry_at", 0.0)):
            return
        result = collector.flush(self.api, max_batches=2)
        now = time.monotonic()
        if result.get("ok"):
            self._bgs_applied_unlogged = int(getattr(self, "_bgs_applied_unlogged", 0)) + int(result.get("applied") or 0)
            names = getattr(self, "_bgs_logged_systems", [])
            for name in result.get("systems") or []:
                if name not in names:
                    names.append(name)
            self._bgs_logged_systems = names[-5:]
            if self._bgs_applied_unlogged and now - float(getattr(self, "_bgs_log_at", 0.0)) > 60:
                self._bgs_log_at = now
                applied, shown = self._bgs_applied_unlogged, ", ".join(self._bgs_logged_systems[-3:])
                self._bgs_applied_unlogged = 0
                self._bgs_logged_systems = []
                self.root.after(0, lambda: self.log(
                    f"Фракции: на сайте обновлено систем — {applied}{f' ({shown})' if shown else ''}", "info"))
        else:
            self._bgs_flush_retry_at = now + 60.0
            if now - float(getattr(self, "_bgs_warning_at", 0.0)) > 120:
                self._bgs_warning_at = now
                self.root.after(0, lambda message=result.get("error", ""): self.log(
                    f"Фракции: данные ждут отправки на сайт ({collector.pending_count}) — {message}", "warn"))

    def _read_ship_inventory(self):
        """Текущий трюм корабля из Cargo.json (для учёта банка эскадры)."""
        from carrier_sync import inventory_from_cargo
        try:
            path = self.journal_path / "Cargo.json"
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError, AttributeError):
            return None
        if not isinstance(data, dict) or str(data.get("Vessel") or "Ship") != "Ship":
            return None
        return inventory_from_cargo(data)

    def _on_station_inventory(self, kind: str, event: dict, report: dict):
        """Снимок рынка текущей стоянки. У авианосца — исправление груза в Raven.

        Правило SrvSurvey (эталонный клиент Raven Colonial): товар на продажу —
        его Stock и есть количество на борту, распроданная позиция — ноль.
        Сайт проекта получает тот же снимок отчётом о станции и сам уточняет
        по нему учёт носителя.
        """
        if kind != "market" or not isinstance(event, dict):
            return
        from carrier_sync import carrier_market_cargo, is_carrier_market
        market_id = report.get("market_id") or event.get("MarketID")
        station_type = str(event.get("StationType") or report.get("station_type") or "")
        if not (is_carrier_market(market_id) or "carrier" in station_type.lower()):
            return
        cargo = carrier_market_cargo(event.get("Items"))
        if cargo:
            self.dispatcher.submit_fc_cargo_correction(market_id, cargo=cargo, reason="по рынку носителя")
        # Отчёт о станции вот-вот уйдёт на сайт — перечитать учёт носителя.
        self._carrier_server_at = 0.0

    #: Как часто перечитывать учёт авианосцев с сайта проекта.
    CARRIER_SERVER_REFRESH_SECONDS = 90.0
    #: Свежие данные сайта — Raven Colonial для груза не опрашиваем.
    CARRIER_SERVER_FRESH_SECONDS = 600.0

    def _flush_carrier_sync(self):
        """Отправить накопленные события авианосцев и при необходимости перечитать учёт."""
        if not self.api.is_connected:
            return
        collector = self._carrier_sync_collector()
        # Отправка идёт в цикле watcher'а: после сбоя делаем паузу, чтобы
        # недоступный сайт не подвешивал чтение журнала таймаутами.
        if collector.pending_count and time.monotonic() >= float(getattr(self, "_carrier_flush_retry_at", 0.0)):
            result = collector.flush(self.api, max_batches=3)
            if result.get("ok") and result.get("sent"):
                self._carrier_server_at = 0.0
            elif not result.get("ok"):
                self._carrier_flush_retry_at = time.monotonic() + 60.0
                now = time.monotonic()
                if now - float(self._carrier_server_warning_at or 0.0) > 120:
                    self._carrier_server_warning_at = now
                    self.root.after(0, lambda message=result.get("error", ""): self.log(
                        f"Авианосцы: события ждут отправки на сайт ({collector.pending_count}) — {message}", "warn"))
        now = time.monotonic()
        if now - float(self._carrier_server_at or 0.0) >= self.CARRIER_SERVER_REFRESH_SECONDS:
            self._carrier_server_at = now
            threading.Thread(target=self._load_server_carriers, daemon=True).start()

    def _load_server_carriers(self):
        """Фоновый запрос учёта авианосцев с сайта проекта → блок CARRIER.

        Личный носитель, носители эскадрильи и тот, у которого пилот стоит
        сейчас (чужому сайт отдаёт статус и рынок без груза).
        """
        try:
            result = self.api.fetch_my_carriers()
        except Exception:
            return
        if not result.get("ok"):
            return
        views = [view for view in [result.get("own"), *(result.get("squadron") or [])] if isinstance(view, dict)]
        active_id = int(self.carrier.state.market_id or 0)
        if active_id and self.carrier.state.at_carrier and all(
                int(view.get("carrierId") or 0) != active_id for view in views):
            try:
                single = self.api.fetch_carrier(active_id)
            except Exception:
                single = {}
            if single.get("ok") and isinstance(single.get("carrier"), dict):
                views.append(single["carrier"])
        pending = self._carrier_sync_collector().pending_carrier_ids()
        changed = 0
        for view in views:
            try:
                carrier_id = int(view.get("carrierId") or 0)
                if self.carrier.merge_server(view, merge_cargo=carrier_id not in pending):
                    changed += 1
            except Exception:
                continue
        signature = tuple(sorted(
            (str(view.get("carrierId")), sum(int(item.get("quantity") or 0)
                                             for item in ((view.get("cargo") or {}).get("items") or [])))
            for view in views))
        if changed and signature != getattr(self, "_carrier_server_log_sig", None):
            self._carrier_server_log_sig = signature
            self.log(f"Авианосцы: учёт обновлён с сайта проекта ({changed} носит.)", "info")

    def _handle_tracked_event(self, ev: dict, live: bool = True):
        """Обработка одного события журнала: маршрут, корабль, оверлей.

        Вызывается из хука parse_events() — для live-тиков watcher'а и для
        исторического разбора. Оверлей сессии обновляем только в live-режиме:
        при первичной загрузке истории событий десятки тысяч, и каждый
        `overlay_manager.log_session_event()` — это отдельный `root.after()`,
        который забивает очередь Tkinter и сам по себе тормозит загрузку.
        """
        # Shared project station database; journal offsets do not acknowledge
        # network uploads. A separate durable outbox keeps failed reports.
        try:
            self._station_commerce_collector().feed(ev, live=live)
        except Exception as exc:
            self.log(f"Station report queue: {exc}", "error")
        # Учёт авианосцев на сайте проекта: и живые события, и история —
        # сервер идемпотентен и упорядочивает по времени события.
        try:
            self._carrier_sync_collector().feed(ev, live=live)
        except Exception as exc:
            self.log(f"Carrier sync queue: {exc}", "error")
        # Минорные фракции на сайте проекта: состояние посещённой населённой
        # системы (FSDJump / Location / CarrierJump) — и живые события, и
        # история; из нескольких посещений системы в очереди остаётся свежее.
        try:
            self._bgs_sync_collector().feed(ev, live=live)
            self._update_faction_infographic(ev)
        except Exception as exc:
            self.log(f"Faction sync queue: {exc}", "error")
        if live:
            self._log_session_event(ev)
        if ev.get("event") in ("FSDJump", "Location", "Docked", "CarrierJump"):
            sys_name = ev.get("StarSystem")
            if sys_name:
                self._session_systems_visited.add(sys_name)
                if live:
                    self._ensure_system_exobio(sys_name)
                if self.route.mark_visited(sys_name):
                    self.root.after(0, self._refresh_route_tree)
                    if live:
                        self.overlay_manager.log(f"Jump: {sys_name}", "info")
        if ev.get("event") in ("ApproachBody", "Touchdown"):
            bname = ev.get("Body") or ev.get("BodyName")
            sys_name = ev.get("StarSystem") or getattr(getattr(self, "exobiology", None), "current_system", "")
            if sys_name and bname and live:
                self._ensure_body_exobio(sys_name, bname)
        # Стройплощадка: из неё вкладка «Колонизатор» заполняет форму проекта.
        self._feed_construction_site(ev, live=live)
        # Карта системы: тела, станции, стройплощадки и где сейчас пилот.
        self._feed_system_map(ev, live=live)
        # Отслеживание корабля
        self.ship.parse_event(ev)
        self._maybe_sync_ship_state(ev, live=live)
        # Груз авианосца: те же события, что уходят в Raven (/api/fc/.../cargo),
        # только считаются локально для блока CARRIER в оверлее.
        self._feed_carrier(ev, live=live)
        ev_name = ev.get("event")
        if ev_name in ("LoadGame", "Rank", "Progress", "Statistics"):
            self._update_pilot_stats_from_event(ev)
        # Строка в лог — по тем же событиям, что двигают состояние в HUD
        # (`ship_tracker`): «ModuleDamage» игра не пишет, зато есть JetCone,
        # дроны и синтез — без них починка в логе не отображалась вовсе.
        if live and ev_name in (
            "HullDamage", "HeatDamage", "HeatWarning", "ShieldState", "JetConeDamage",
            "CockpitBreached", "AfmuRepairs", "Repair", "RepairAll", "RepairDrone",
            "RebootRepair", "Synthesis", "SystemsShutdown", "CommitCrime", "CrimeVictim",
            "Touchdown",
        ):
            st = self.ship.state
            damaged = [f"{m.slot}={m.health:.0%}" for m in st.damaged_modules]
            dmg_str = f" ({', '.join(damaged)})" if damaged else ""
            shields = {"up": "up", "down": "DOWN", "none": "нет генератора",
                       "unknown": "нет данных"}.get(st.shield_state, st.shield_state)
            self.overlay_manager.log(
                f"{ev_name}: hull {st.hull_health:.0%} ({st.hull_source or '—'}), "
                f"shields {shields}, damaged {len(st.damaged_modules)} mod.{dmg_str}",
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
                    label = (f"{project.get('buildName') or tr('проект')}"
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
                    label = (f"{site_project.get('buildName') or tr('стройплощадка')}"
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
        label = site.station_name or site.system_name or tr("стройплощадка")
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
        if str(event.get("event")) == "CarrierStats":
            usage = event.get("SpaceUsage") if isinstance(event.get("SpaceUsage"), dict) else {}
            if usage.get("Cargo") == 0 and event.get("CarrierID"):
                # Трюм подтверждённо пуст — Raven тоже должен это знать.
                self.dispatcher.submit_fc_cargo_correction(
                    event.get("CarrierID"), empty=True, reason="трюм пуст по CarrierStats")
        if str(event.get("event")) in ("Docked", "CarrierStats", "CarrierJump", "CarrierLocation"):
            # Пилот у носителя или открыл управление им — свежий учёт с сайта.
            self._carrier_server_at = 0.0
        market_id = int(self.carrier.state.market_id or 0)
        if not market_id:
            return
        # В лог — только заметные события. Писать строку на каждую продажу на
        # борту авианосца смысла нет: при разгрузке трюма их десятки.
        if str(event.get("event")) in (
            "CarrierStats", "Docked", "Location", "CarrierJump", "Undocked",
            "CarrierNameChanged", "CarrierDecommission", "CarrierCancelDecommission",
            "CarrierBuy",
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
        # Главный источник груза — сайт проекта. Raven Colonial опрашиваем,
        # только если сайт этот носитель не знает или давно не отвечал.
        known = self.carrier.states().get(market_id)
        if (known is not None and known.cargo_origin == "server" and known.server_at
                and time.time() - known.server_at < self.CARRIER_SERVER_FRESH_SECONDS):
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
        # `explicit` — Raven ответил именно картой груза, а не «чем-то, из
        # чего мы выбрали числа». Только такому ответу можно верить, когда он
        # пустой: это «на борту ничего нет», а не «Raven про этот носитель
        # ничего не знает». Иначе пустой ответ молча стирал бы честный
        # локальный учёт по журналу.
        explicit = False
        if isinstance(data, dict) and isinstance(data.get("cargo"), dict):
            cargo = data["cargo"]
            explicit = True
        elif isinstance(data, dict):
            cargo = {
                key: value for key, value in data.items()
                if isinstance(value, (int, float)) and not isinstance(value, bool)
            }
        else:
            cargo = data
        if not isinstance(cargo, dict):
            return
        if not cargo and not explicit:
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
        # Снимок адресован тому носителю, по которому его запрашивали: пока
        # фоновый запрос летел, пилот мог перестыковаться к соседнему, и без
        # адреса чужие тонны оседали в его блоке навсегда.
        if self.carrier.merge_remote(cargo, market_id=market_id, allow_empty=explicit):
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
                problems.append(tr(
                    "{name} ({tons} t) — товара нет в потребности проекта",
                    name=name, tons=tons))
                still_waiting[name] = tons
            elif before is not None and int(after) >= int(before):
                problems.append(tr(
                    "{name} ({tons} t) — потребность не уменьшилась ({before} -> {after})",
                    name=name, tons=tons, before=before, after=after))
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
        self.colony_page.set_status(tr("Сверяю стройплощадку с Raven Colonial…"))
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
            reason = error or tr("проекта пока нет в Raven Colonial")
            self.log(f"{head}: {reason}. По журналу вы завезли {journal['total']:,} t "
                     f"({journal['count']} дост.) — тонны не зачтутся, пока проект не создан."
                     .replace(",", " "), "warn")
            self.colony_page.set_status(tr("Проект на Raven Colonial не найден"))
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
        name = str(project.get("buildName") or site.station_name
                   or tr("площадка")).strip()

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
            source = ("Raven Colonial" if state.remote_seen
                      else tr("локальный учёт по журналу"))
            lines.append(f"  Авианосец {carrier_market}: на борту {fmt(on_board)} t "
                         f"({source})"
                         + (f" — {top({row['key']: row['amount'] for row in state.get_state_dict()['commodities'] if row['amount'] > 0})}"
                            if on_board else ""))
        self.log("\n".join(lines), "info")
        self.colony_page.set_status(tr(
            "Осталось завезти {left} t · по журналу вы завезли {total} t",
            left=fmt(left), total=fmt(journal["total"])))

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
        if not ask_yes_no(
            tr("Дослать доставки в Raven Colonial"),
            tr("По журналу на эту площадку завезено {tons} t ({count} доставок), "
               "которые это приложение в Raven Colonial не отправляло.\n\n"
               "Отправить их сейчас?\n"
               "Если вы пользуетесь SrvSurvey или другим плагином, тоннаж может быть "
               "зачтён проекту дважды.", tons=fmt(tons), count=len(unsent)),
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
        if not self.colony_autofill_check.isChecked():
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
        collector = self._construction_collector
        community_goal_collector = self._community_goal_collector
        tick_community_goal_reports = []

        def community_goal_hook(_line, ev):
            tick_community_goal_reports.extend(community_goal_reports_from_event(ev))

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
            hooks=[collector, community_goal_hook, tracking_hook, dispatch_hook, self.exobiology.handle],
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
        # parse_events() — тем же однопроходным разбором текста. Отчёты CG
        # добавляются в долговечный накопитель только после проверки CMDR.
        community_goal_collector.add_reports(tick_community_goal_reports)
        community_goal_reports = community_goal_collector.drain()

        self._record_session_deliveries(deliveries)
        # Snapshots стройки собираются тем же проходом, что и доставки, с
        # отсевом повторов (состояние ColonisationConstructionDepot меняется
        # заметно реже, чем пишется в журнал). `drain()` забирает только то,
        # что накопилось за этот тик: сам коллектор живёт всю сессию, чтобы
        # помнить уже отправленные состояния.
        construction_events = collector.drain()

        # Первичная сверка: НЕ отправляем на сайт после каждого файла (на
        # истории это сотни отдельных запросов), а накапливаем и отправляем
        # одним пакетом в конце — см. _flush_deferred_uploads().
        if self._defer_uploads:
            if deliveries:
                self._backfill_deliveries.extend(deliveries)
            if construction_events:
                self._backfill_construction.extend(construction_events)
            if community_goal_reports:
                self._backfill_community_goal_reports.extend(community_goal_reports)
            return processed_bytes

        if community_goal_reports:
            if not self.api.is_connected:
                community_goal_collector.requeue(community_goal_reports)
            else:
                result = self.api.upload_community_goal_reports(community_goal_reports, cmdr_name)
                if not result.get("ok"):
                    community_goal_collector.requeue(community_goal_reports)
                    self.root.after(0, lambda e=result.get("error", "ошибка"):
                        self.log(f"[Watcher] Отчёты CG не отправлены: {e}", "warn"))
                else:
                    stored = int(result.get("stored", 0) or 0)
                    catalog_updated = int(result.get("communityGoalCatalogUpdated", 0) or 0)
                    self.root.after(0, lambda n=stored, c=catalog_updated: self.log(
                        f"[Watcher] CG: личных снимков — {n}, записей каталога обновлено — {c}", "success"))

        if construction_events and self.api.is_connected:
            construction_result = self.api.upload_construction_events(construction_events, cmdr_name)
            if not construction_result.get("ok"):
                # Возвращаем пачку в накопитель: подпись состояния уже
                # запомнена, поэтому сама по себе она больше не придёт, а
                # следующий тик повторит отправку.
                collector.requeue(construction_events)
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
    def _on_import_atlas_route(self):
        if not getattr(self, "api_client", None) or not self.api_client.is_connected:
            self.log("Сначала подключите Colonial Helper к сайту через существующий токен проекта", "warn")
            return

        def worker():
            result = self.api_client.pull_atlas_route()
            def finish():
                if not result.get("ok"):
                    self.log(f"Не удалось получить маршрут из Atlas: {result.get('error', 'ошибка')}", "warn")
                    return
                points = result.get("route")
                if not points:
                    self.log("В Atlas нет ожидающего маршрута. Сначала постройте и передайте маршрут из вкладки Atlas → Маршрут корабля.", "info")
                    return
                try:
                    nav_route = {"Route": [
                        {"StarSystem": str(point["name"]), "StarPos": [point["x"], point["y"], point["z"]]}
                        for point in points
                    ]}
                    self.route.load_from_navroute(nav_route)
                    current = getattr(getattr(self, "ship", None), "state", None)
                    if current and current.current_system:
                        self.route.mark_visited(current.current_system)
                    self._refresh_route_tree()
                    self.log(f"Маршрут из Atlas загружен в Colonial Helper: {len(self.route.systems)} систем. Игровая навигация не изменялась.", "success")
                except Exception as exc:
                    self.log(f"Некорректный маршрут из Atlas: {exc}", "error")
            self.root.after(0, finish)

        threading.Thread(target=worker, daemon=True, name="PullAtlasRoute").start()

    def _on_import_route(self):
        filepath = ask_open_file(
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
        filepath = ask_save_file(
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
        page = getattr(self, "route_page", None)
        if page is None:
            return

        if not self.route.systems:
            page.set_rows([])
            page.set_counter(tr("Маршрут не загружен"))
            return

        rows = []
        for s in self.route.systems:
            status_label = {
                "visited": tr("✓ Посещена"),
                "current": tr("● Текущая"),
                "pending": tr("○ Ожидает"),
            }.get(s["status"], s["status"])

            visited_str = ""
            if s.get("visited_at"):
                try:
                    dt = datetime.fromisoformat(s["visited_at"])
                    visited_str = dt.strftime("%d.%m.%Y %H:%M")
                except Exception:
                    visited_str = str(s["visited_at"])

            rows.append((s["index"], s["name"], status_label, visited_str,
                         s["status"]))

        page.set_rows(rows)
        visited = self.route.visited_count
        total = len(self.route.systems)
        page.set_counter(tr("Всего: {total} | Посещено: {visited} | Осталось: {left}",
                            total=total, visited=visited, left=total - visited))

    # ============================================================
    #  Лог
    # ============================================================
    def _on_clear_log(self):
        page = getattr(self, "log_page", None)
        if page is not None:
            page.clear()
        else:
            print("Лог очищен", file=sys.stderr)
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

        root = HelperWindow(f"{APP_NAME} v{VERSION}")
        app = ColonialHelperApp(root)
        root.run()
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
            from ui_qt import show_error_dialog

            show_error_dialog(
                tr("Colonial Helper — Ошибка запуска"),
                f"{type(e).__name__}: {e}\n\n"
                f"Подробности сохранены в:\n{error_file}",
            )
        except Exception:
            pass
        sys.exit(1)


if __name__ == "__main__":
    main()
