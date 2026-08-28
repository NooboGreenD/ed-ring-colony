#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Colonial Helper — standalone uploader for ED Ring Colony.
GUI приложение на ttkbootstrap с live-watcher журналов Elite Dangerous.
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

# ttkbootstrap даёт современный dark theme
try:
    import ttkbootstrap as tb
    from ttkbootstrap.constants import *
    from ttkbootstrap.scrolled import ScrolledText
except ImportError:
    print("Установите зависимости: pip install -r requirements.txt")
    sys.exit(1)

from api_client import ApiClient
from journal_parser import parse_file, parse_journal
from route_tracker import RouteTracker

# ── Константы ──
APP_NAME = "Colonial Helper"
VERSION = "1.0.0"
DEFAULT_JOURNAL_PATH = Path.home() / "Saved Games" / "Frontier Developments" / "Elite Dangerous"

# Цвета в стиле сайта
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

        # Иконка (если есть)
        try:
            self.root.iconbitmap("colonial_helper.ico")
        except Exception:
            pass

        # Данные
        self.api = ApiClient()
        self.route = RouteTracker()
        self.watcher_active = False
        self.watcher_thread = None
        self.watcher_stop_event = threading.Event()
        self.journal_path = Path(DEFAULT_JOURNAL_PATH)
        self.last_file_mtimes = {}

        # Загружаем сохранённый токен
        self.config_path = Path.home() / ".colonial_helper.json"
        self.load_config()

        # ── Стили ──
        self.style = tb.Style(theme="darkly")
        self._setup_styles()

        # ── UI ──
        self._build_header()
        self._build_notebook()
        self._build_status_bar()

        # Авто-проверка токена при старте
        if self.api.token:
            self.after(500, self._auto_validate)

    # ═══════════════════════════════════════════════════════════════
    #  Стили
    # ═══════════════════════════════════════════════════════════════
    def _setup_styles(self):
        s = self.style
        # Кастомные цвета для виджетов
        s.configure("Orange.TButton", foreground=COLOR_ORANGE, bordercolor=COLOR_ORANGE)
        s.configure("Cyan.TButton", foreground=COLOR_CYAN, bordercolor=COLOR_CYAN)
        s.configure("Green.TButton", foreground=COLOR_GREEN, bordercolor=COLOR_GREEN)
        s.configure("Red.TButton", foreground=COLOR_RED, bordercolor=COLOR_RED)
        s.configure("Orange.TEntry", fieldbackground=COLOR_PANEL)
        s.configure("Muted.TLabel", foreground=COLOR_MUTED)

    # ═══════════════════════════════════════════════════════════════
    #  Шапка — статус-бар
    # ═══════════════════════════════════════════════════════════════
    def _build_header(self):
        frame = tb.Frame(self.root, padding=10)
        frame.pack(fill=X, pady=(0, 5))

        # Заголовок
        title = tb.Label(
            frame,
            text="◆ COLONIAL HELPER",
            font=("Consolas", 14, "bold"),
            foreground=COLOR_ORANGE,
        )
        title.pack(anchor=W)

        subtitle = tb.Label(
            frame,
            text="Standalone uploader for ED Ring Colony",
            font=("Segoe UI", 9),
            foreground=COLOR_MUTED,
        )
        subtitle.pack(anchor=W)

        # Статус-бар
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

    # ═══════════════════════════════════════════════════════════════
    #  Notebook (вкладки)
    # ═══════════════════════════════════════════════════════════════
    def _build_notebook(self):
        self.notebook = tb.Notebook(self.root, padding=10)
        self.notebook.pack(fill=BOTH, expand=True, padx=10, pady=5)

        # ── Вкладка: Подключение ──
        self.tab_auth = tb.Frame(self.notebook)
        self.notebook.add(self.tab_auth, text=" Подключение ")
        self._build_tab_auth()

        # ── Вкладка: Загрузка логов ──
        self.tab_upload = tb.Frame(self.notebook)
        self.notebook.add(self.tab_upload, text=" Загрузка логов ")
        self._build_tab_upload()

        # ── Вкладка: Маршрут ──
        self.tab_route = tb.Frame(self.notebook)
        self.notebook.add(self.tab_route, text=" Маршрут ")
        self._build_tab_route()

        # ── Вкладка: Лог ──
        self.tab_log = tb.Frame(self.notebook)
        self.notebook.add(self.tab_log, text=" Лог ")
        self._build_tab_log()

    # ═══════════════════════════════════════════════════════════════
    #  Вкладка: Подключение
    # ═══════════════════════════════════════════════════════════════
    def _build_tab_auth(self):
        frame = tb.Frame(self.tab_auth, padding=15)
        frame.pack(fill=BOTH, expand=True)

        tb.Label(frame, text="API Токен", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        tb.Label(
            frame,
            text="Вставьте API токен из профиля на сайте (вкладка 'API Токен'):",
            foreground=COLOR_MUTED,
        ).pack(anchor=W)

        self.token_entry = tb.Entry(frame, width=60, show="•", font=("Consolas", 11))
        self.token_entry.pack(fill=X, pady=(5, 10))
        if self.api.token:
            self.token_entry.insert(0, self.api.token)

        # Кнопки
        btn_frame = tb.Frame(frame)
        btn_frame.pack(anchor=W, pady=(0, 10))

        tb.Button(
            btn_frame,
            text="Проверить токен",
            command=self._on_validate_token,
            bootstyle="warning-outline",
            width=20,
        ).pack(side=LEFT, padx=(0, 10))

        self.toggle_token_btn = tb.Button(
            btn_frame,
            text="Показать",
            command=self._toggle_token_visibility,
            bootstyle="secondary-outline",
            width=12,
        )
        self.toggle_token_btn.pack(side=LEFT)

        # Результат авторизации
        self.auth_result = tb.Label(frame, text="", font=("Segoe UI", 11), wraplength=700)
        self.auth_result.pack(anchor=W, pady=(5, 0))

        # Разделитель
        tb.Separator(frame, orient=HORIZONTAL).pack(fill=X, pady=20)

        # Путь к журналам
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

    # ═══════════════════════════════════════════════════════════════
    #  Вкладка: Загрузка логов
    # ═══════════════════════════════════════════════════════════════
    def _build_tab_upload(self):
        frame = tb.Frame(self.tab_upload, padding=15)
        frame.pack(fill=BOTH, expand=True)

        tb.Label(frame, text="Загрузка журналов", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        # Кнопки
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

        # Инфо
        self.files_label = tb.Label(frame, text="Файлы не выбраны", foreground=COLOR_MUTED)
        self.files_label.pack(anchor=W, pady=(5, 0))

        # Прогресс
        self.progress = tb.Progressbar(frame, mode="determinate", bootstyle="warning")
        self.progress.pack(fill=X, pady=(15, 5))
        self.progress["value"] = 0

        self.progress_label = tb.Label(frame, text="", foreground=COLOR_MUTED)
        self.progress_label.pack(anchor=W)

        # Выбранные файлы
        self.selected_files: list[Path] = []

    # ═══════════════════════════════════════════════════════════════
    #  Вкладка: Маршрут
    # ═══════════════════════════════════════════════════════════════
    def _build_tab_route(self):
        frame = tb.Frame(self.tab_route, padding=15)
        frame.pack(fill=BOTH, expand=True)

        tb.Label(frame, text="Отслеживание маршрута", font=("Segoe UI", 12, "bold")).pack(anchor=W, pady=(0, 10))

        # Кнопки
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

        # Таблица
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

        # Счётчик
        self.route_counter = tb.Label(frame, text="Маршрут не загружен", foreground=COLOR_MUTED)
        self.route_counter.pack(anchor=W, pady=(8, 0))

    # ═══════════════════════════════════════════════════════════════
    #  Вкладка: Лог
    # ═══════════════════════════════════════════════════════════════
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

    # ═══════════════════════════════════════════════════════════════
    #  Статус-бар внизу
    # ═══════════════════════════════════════════════════════════════
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

    # ═══════════════════════════════════════════════════════════════
    #  Логирование
    # ═══════════════════════════════════════════════════════════════
    def log(self, message: str, level: str = "info"):
        """Добавить запись в лог."""
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
        # Цвет для последней строки
        end_idx = self.log_text.text.index(END)
        start_idx = f"{end_idx} linestart -1 lines"
        tag_name = f"log_{level}_{timestamp.replace(':','')}"
        self.log_text.text.tag_add(tag_name, start_idx, f"{start_idx} lineend")
        self.log_text.text.tag_config(tag_name, foreground=color)
        self.log_text.text.see(END)
        self.log_text.text.config(state=DISABLED)

    # ═══════════════════════════════════════════════════════════════
    #  Статус подключения
    # ═══════════════════════════════════════════════════════════════
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

    # ═══════════════════════════════════════════════════════════════
    #  Конфиг
    # ═══════════════════════════════════════════════════════════════
    def load_config(self):
        if self.config_path.exists():
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                self.api.token = cfg.get("token", "")
                self.journal_path = Path(cfg.get("journal_path", str(DEFAULT_JOURNAL_PATH)))
            except Exception:
                pass

    def save_config(self):
        cfg = {
            "token": self.api.token,
            "journal_path": str(self.journal_path),
        }
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
        except Exception as e:
            self.log(f"Не удалось сохранить конфиг: {e}", "warn")

    # ═══════════════════════════════════════════════════════════════
    #  Обработчики: Подключение
    # ═══════════════════════════════════════════════════════════════
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
        else:
            self.set_connection_status(False, result.get("error", "Ошибка"))
            self.log(f"Ошибка: {result.get('error')}", "error")

        self.bottom_status.config(text="Готов")

    def _auto_validate(self):
        """Авто-проверка токена при старте."""
        self._on_validate_token()

    def _toggle_token_visibility(self):
        current = self.token_entry.cget("show")
        if current == "•":
            self.token_entry.config(show="")
            self.toggle_token_btn.config(text="Скрыть")
        else:
            self.token_entry.config(show="•")
            self.toggle_token_btn.config(text="Показать")

    def _on_browse_journal_path(self):
        path = filedialog.askdirectory(initialdir=str(self.journal_path))
        if path:
            self.journal_path = Path(path)
            self.path_entry.delete(0, END)
            self.path_entry.insert(0, str(self.journal_path))
            self.save_config()

    # ═══════════════════════════════════════════════════════════════
    #  Обработчики: Загрузка
    # ═══════════════════════════════════════════════════════════════
    def _on_select_files(self):
        files = filedialog.askopenfilenames(
            initialdir=str(self.journal_path),
            filetypes=[("Journal logs", "*.log"), ("All files", "*.*")],
        )
        if files:
            self.selected_files = [Path(f) for f in files]
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

        all_deliveries = []
        cmdr_name = None
        total = len(self.selected_files)

        for i, filepath in enumerate(self.selected_files):
            self.log(f"Чтение {filepath.name}...", "info")
            try:
                cname, deliveries = parse_file(str(filepath))
                if cname and not cmdr_name:
                    cmdr_name = cname
                all_deliveries.extend(deliveries)
                self.log(f"{filepath.name}: найдено {len(deliveries)} доставок", "success")
                # Отметить системы в маршруте
                for d in deliveries:
                    if self.route.mark_visited(d["system_name"]):
                        self._refresh_route_tree()
            except Exception as e:
                self.log(f"Ошибка чтения {filepath.name}: {e}", "error")

            self.progress["value"] = (i + 1) / total * 50
            self.root.update_idletasks()

        if not all_deliveries:
            self.log("Доставки не найдены", "warn")
            self.upload_btn.config(state=NORMAL)
            self.progress["value"] = 0
            self.progress_label.config(text="")
            return

        self.log(f"Всего доставок: {len(all_deliveries)}. Отправка...", "info")
        self.progress_label.config(text=f"Отправка {len(all_deliveries)} записей...")
        self.root.update_idletasks()

        result = self.api.upload_deliveries(all_deliveries, cmdr_name)
        self.progress["value"] = 100

        if result["ok"]:
            self.log(f"Готово! Загружено: {result['inserted']} записей", "success")
            self.progress_label.config(text=f"Загружено: {result['inserted']} записей")
        else:
            self.log(f"Ошибка загрузки: {result.get('error')}", "error")
            self.progress_label.config(text="Ошибка загрузки")

        self.upload_btn.config(state=NORMAL)

    # ═══════════════════════════════════════════════════════════════
    #  Watcher (live monitoring)
    # ═══════════════════════════════════════════════════════════════
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
        self.watcher_btn.config(text="⏹ Остановить", bootstyle="danger-outline")
        self.log("Watcher запущен. Мониторинг журналов...", "success")
        self.bottom_status.config(text="Watcher: активен")

        self.watcher_thread = threading.Thread(target=self._watcher_loop, daemon=True)
        self.watcher_thread.start()

    def _stop_watcher(self):
        self.watcher_active = False
        self.watcher_stop_event.set()
        self.watcher_btn.config(text="▶ Следить за игрой", bootstyle="success-outline")
        self.log("Watcher остановлен", "info")
        self.bottom_status.config(text="Готов")

    def _watcher_loop(self):
        """Фоновый цикл: проверяет Journal.*.log на изменения."""
        self.last_file_mtimes = {}
        # Инициализация: запоминаем текущие размеры файлов
        for f in sorted(self.journal_path.glob("Journal.*.log")):
            try:
                self.last_file_mtimes[str(f)] = f.stat().st_size
            except Exception:
                pass

        while not self.watcher_stop_event.is_set():
            time.sleep(5)
            if self.watcher_stop_event.is_set():
                break

            try:
                files = sorted(self.journal_path.glob("Journal.*.log"))
                for f in files:
                    fpath = str(f)
                    try:
                        current_size = f.stat().st_size
                    except Exception:
                        continue
                    last_size = self.last_file_mtimes.get(fpath, 0)
                    if current_size > last_size:
                        # Файл вырос — читаем новые строки
                        self._process_journal_changes(f, last_size, current_size)
                        self.last_file_mtimes[fpath] = current_size
            except Exception as e:
                self.root.after(0, lambda e=e: self.log(f"Watcher ошибка: {e}", "error"))

    def _process_journal_changes(self, filepath: Path, old_size: int, new_size: int):
        """Обработать новые строки в журнале."""
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                f.seek(old_size)
                new_text = f.read(new_size - old_size)
        except Exception as e:
            self.root.after(0, lambda e=e: self.log(f"Ошибка чтения {filepath.name}: {e}", "error"))
            return

        if not new_text.strip():
            return

        cmdr_name, deliveries = parse_journal(new_text)
        if deliveries:
            # Отправляем
            result = self.api.upload_deliveries(deliveries, cmdr_name)
            if result["ok"]:
                msg = f"[Watcher] {filepath.name}: +{result['inserted']} доставок"
                self.root.after(0, lambda m=msg: self.log(m, "success"))
                # Отметить в маршруте
                for d in deliveries:
                    if self.route.mark_visited(d["system_name"]):
                        self.root.after(0, self._refresh_route_tree)
            else:
                msg = f"[Watcher] Ошибка загрузки: {result.get('error')}"
                self.root.after(0, lambda m=msg: self.log(m, "error"))
        else:
            # Проверяем FSDJump для маршрута
            for line in new_text.splitlines():
                line = line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    ev = json.loads(line)
                    if ev.get("event") in ("FSDJump", "Location", "Docked", "CarrierJump"):
                        sys_name = ev.get("StarSystem")
                        if sys_name and self.route.mark_visited(sys_name):
                            self.root.after(0, self._refresh_route_tree)
                except Exception:
                    pass

    # ═══════════════════════════════════════════════════════════════
    #  Обработчики: Маршрут
    # ═══════════════════════════════════════════════════════════════
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
                    # Простой список систем
                    self.route.systems = [
                        {"index": i + 1, "name": str(s), "status": "pending", "visited_at": None}
                        for i, s in enumerate(data)
                    ]
                else:
                    # Попробуем CSV внутри JSON
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
        """Обновить Treeview маршрута."""
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

        # Цвета строк
        self.route_tree.tag_configure("visited", foreground=COLOR_GREEN)
        self.route_tree.tag_configure("current", foreground=COLOR_ORANGE)
        self.route_tree.tag_configure("pending", foreground=COLOR_MUTED)

        visited = self.route.visited_count
        total = len(self.route.systems)
        self.route_counter.config(
            text=f"Всего: {total} | Посещено: {visited} | Осталось: {total - visited}"
        )

    # ═══════════════════════════════════════════════════════════════
    #  Обработчики: Лог
    # ═══════════════════════════════════════════════════════════════
    def _on_clear_log(self):
        self.log_text.text.config(state=NORMAL)
        self.log_text.text.delete("1.0", END)
        self.log_text.text.config(state=DISABLED)
        self.log("Лог очищен", "info")

    # ═══════════════════════════════════════════════════════════════
    #  Утилиты
    # ═══════════════════════════════════════════════════════════════
    def after(self, ms: int, callback):
        self.root.after(ms, callback)


def main():
    root = tb.Window(themename="darkly")
    app = ColonialHelperApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
