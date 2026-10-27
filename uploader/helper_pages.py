"""Native Qt pages for the Colonial Helper main window.

Pages are migrated here one at a time; a page that lives here is built from real
PySide6 widgets and owns its behaviour. Pages that are still on the
compatibility layer are hosted by :class:`helper_shell.HelperShell` unchanged,
so both kinds coexist in one window during the migration.
"""
from __future__ import annotations

from typing import Optional

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont, QTextCharFormat, QTextCursor
from PySide6.QtWidgets import (
    QCheckBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from ui_qt import (
    CYAN,
    GREEN,
    MUTED,
    ORANGE,
    PANEL,
    TEXT,
    action_button,
    heading,
    label,
    panel,
    row,
)

#: Pastel-on-dark colours for log levels, matching the rest of the program.
LEVEL_COLORS = {
    "info": "#42b9d4",
    "success": "#65c78a",
    "error": "#e27676",
    "warn": "#e57b28",
}


class LogPage(QWidget):
    """Read-only coloured log with a clear button.

    Replaces the Tk text widget with a real ``QPlainTextEdit``: appending keeps
    the view scrolled to the newest line and every level keeps its own colour.
    """

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("logPage")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(10)

        layout.addWidget(heading("Информационное окно", size=12))
        self.view = QPlainTextEdit()
        self.view.setObjectName("logView")
        self.view.setReadOnly(True)
        self.view.setUndoRedoEnabled(False)
        self.view.setMaximumBlockCount(0)
        font = QFont("Consolas")
        font.setStyleHint(QFont.StyleHint.Monospace)
        font.setPointSize(10)
        self.view.setFont(font)
        self.view.setStyleSheet(
            f"QPlainTextEdit {{ background: {PANEL}; color: {TEXT};"
            f" border: 1px solid #3b4044; border-radius: 6px; padding: 8px; }}")
        self.view.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        layout.addWidget(self.view, 1)

        actions = QWidget()
        actions.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        actions_layout = QHBoxLayout(actions)
        actions_layout.setContentsMargins(0, 0, 0, 0)
        actions_layout.setSpacing(8)
        self.clear_button = action_button("Очистить лог", self.clear)
        actions_layout.addWidget(self.clear_button)
        self.counter = label("", role="mono", size=8, color=MUTED)
        actions_layout.addWidget(self.counter)
        actions_layout.addStretch(1)
        layout.addWidget(actions)
        self._updating = False
        self.update_count()

    # ----------------------------------------------------------------- writing
    def _format(self, level: str) -> QTextCharFormat:
        fmt = QTextCharFormat()
        fmt.setForeground(QColor(LEVEL_COLORS.get(level, TEXT)))
        return fmt

    def append(self, text: str, level: str = "info") -> None:
        """Append one entry, coloured by level, and keep the newest line visible."""
        cursor = QTextCursor(self.view.document())
        cursor.movePosition(QTextCursor.MoveOperation.End)
        if self.view.document().characterCount() > 1:
            cursor.insertBlock()
        cursor.insertText(str(text), self._format(level))
        self.view.moveCursor(QTextCursor.MoveOperation.End)
        self.view.ensureCursorVisible()
        self.update_count()

    def append_block(self, text: str, level: str = "info") -> None:
        """Append a multi-line block (headline + details) in one colour."""
        self.append(text, level)

    def clear(self) -> None:
        self.view.clear()
        self.update_count()

    def log(self, message: str, level: str = "info") -> None:
        """Compatibility with code that used the old text widget's ``log``."""
        self.append(message, level)

    # ----------------------------------------------------------------- reading
    def text(self) -> str:
        return self.view.toPlainText()

    def entry_count(self) -> int:
        document = self.view.document()
        return max(0, document.blockCount() - (1 if not document.toPlainText() else 0))

    def update_count(self) -> None:
        count = self.entry_count()
        self.counter.setText(f"записей: {count}" if count else "")

    def is_read_only(self) -> bool:
        return self.view.isReadOnly()


# ===========================================================================
#  Страница «Подключение»
# ===========================================================================
from dataclasses import dataclass
from typing import Callable, Optional as _Optional


class StatusLabel(QLabel):
    """Label with an explicit coloured status setter."""

    def __init__(self, text: str = "", color: str = TEXT, parent=None) -> None:
        super().__init__(str(text), parent)
        self.setWordWrap(True)
        self.set_status(text, color)

    def set_status(self, text: str, color: _Optional[str] = None) -> None:
        self.setText(str(text))
        if color:
            self.setStyleSheet(f"color:{color};")


@dataclass
class AuthPageState:
    """Values shown when the Connection page is created."""

    site_url: str = ""
    token: str = ""
    journal_path: str = ""
    site_error: str = ""
    raven_key: str = ""
    raven_status: str = "Raven Colonial: не подключено"
    edsm_key: str = ""
    edsm_name: str = ""
    edsm_status: str = "EDSM: не настроен"
    eddn_enabled: bool = False
    inara_key: str = ""
    inara_name: str = ""
    inara_status: str = "Inara: не настроена"
    capi_status: str = "Проверка привязки сайта…"


@dataclass
class AuthPageActions:
    """Callbacks the page triggers; every one is optional."""

    open_tokens: _Optional[Callable] = None
    change_server: _Optional[Callable] = None
    validate_token: _Optional[Callable] = None
    paste_token: _Optional[Callable] = None
    capi_link: _Optional[Callable] = None
    capi_fetch: _Optional[Callable] = None
    browse_journal: _Optional[Callable] = None
    check_raven: _Optional[Callable] = None
    save_edsm: _Optional[Callable] = None
    save_inara: _Optional[Callable] = None
    eddn_toggle: _Optional[Callable] = None


class AuthPage(QWidget):
    """Connections: project token, Frontier CAPI, journals, EDSM, EDDN, Inara.

    The attribute names match the ones the rest of the program already uses
    (``token_entry``, ``capi_status``, ``raven_key_entry`` …), but every widget
    is a plain Qt widget: values are read with ``text()``/``isChecked()`` and
    written with ``setText()``/``set_status()``.
    """

    SECTION_TITLES = {
        "api": "Основной API ED Ring Colony",
        "capi": "Досье пилота (Frontier CAPI)",
        "journals": "Папка журналов Elite Dangerous",
        "raven": "Raven Colonial API",
        "edsm": "EDSM Journal API",
        "eddn": "EDDN → Spansh",
        "inara": "Inara API",
    }

    def __init__(self, state: AuthPageState, actions: AuthPageActions,
                 parent: _Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.state = state
        self.actions = actions
        self.setObjectName("authPage")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.content = QWidget()
        self.layout_ = QVBoxLayout(self.content)
        self.layout_.setContentsMargins(16, 14, 16, 16)
        self.layout_.setSpacing(8)
        self.scroll.setWidget(self.content)
        outer.addWidget(self.scroll)

        self._build_api()
        self._build_capi()
        self._build_journals()
        self._build_raven()
        self._build_edsm()
        self._build_eddn()
        self._build_inara()
        self.layout_.addStretch(1)

    # ------------------------------------------------------------------ pieces
    def _title(self, text: str) -> QLabel:
        widget = label(text, size=12, bold=True)
        self.layout_.addWidget(widget)
        return widget

    def _hint(self, text: str) -> QLabel:
        widget = label(text, role="muted", size=9, wrap=True)
        self.layout_.addWidget(widget)
        return widget

    def _divider(self) -> None:
        line = QFrame()
        line.setObjectName("separator")
        line.setFixedHeight(1)
        wrapper = QWidget()
        wrapper_layout = QVBoxLayout(wrapper)
        wrapper_layout.setContentsMargins(0, 12, 0, 12)
        wrapper_layout.addWidget(line)
        self.layout_.addWidget(wrapper)

    def _field(self, value: str, *, password: bool = False, mono: bool = True) -> QLineEdit:
        entry = QLineEdit(str(value or ""))
        if password:
            entry.setEchoMode(QLineEdit.EchoMode.Password)
        if mono:
            font = QFont("Consolas")
            font.setStyleHint(QFont.StyleHint.Monospace)
            font.setPointSize(10)
            entry.setFont(font)
        entry.setMinimumHeight(30)
        return entry

    def _row(self, *buttons: QPushButton) -> QWidget:
        holder = QWidget()
        holder_layout = QHBoxLayout(holder)
        holder_layout.setContentsMargins(0, 0, 0, 0)
        holder_layout.setSpacing(8)
        for button in buttons:
            holder_layout.addWidget(button)
        holder_layout.addStretch(1)
        self.layout_.addWidget(holder)
        return holder

    def _button(self, text: str, slot: _Optional[Callable], *, primary: bool = False) -> QPushButton:
        return action_button(text, slot, primary=primary, height=34)

    # ---------------------------------------------------------------- sections
    def _build_api(self) -> None:
        self._title(self.SECTION_TITLES["api"])
        self.server_label = label(f"Сервер: {self.state.site_url}", role="accent", size=9)
        self.layout_.addWidget(self.server_label)
        self._row(
            self._button("Открыть API-токены на сайте", self.actions.open_tokens),
            self._button("Другой сервер…", self.actions.change_server),
        )
        self.site_error_label = label(self.state.site_error, size=9, color="#e27676", wrap=True)
        self.site_error_label.setVisible(bool(self.state.site_error))
        self.layout_.addWidget(self.site_error_label)

        self._hint("API-токен сайта")
        self._hint("Поле для API-токена ED Ring Colony из профиля сайта. "
                   "Используется для загрузки журналов.")
        self.token_entry = self._field(self.state.token, password=True)
        self.token_entry.setPlaceholderText("Токен ED Ring Colony")
        self.layout_.addWidget(self.token_entry)
        self.toggle_token_btn = self._button("Показать", self.toggle_token_visibility)
        self._row(
            self._button("Проверить токен", self.actions.validate_token),
            self._button("Вставить из буфера", self.actions.paste_token),
            self.toggle_token_btn,
        )
        self.auth_result = StatusLabel("", TEXT)
        self.layout_.addWidget(self.auth_result)

    def _build_capi(self) -> None:
        self._divider()
        self._title(self.SECTION_TITLES["capi"])
        self._hint(
            "Подключение и данные CAPI принадлежат вашему аккаунту на сайте. "
            "Сначала привяжите Frontier в личном кабинете сайта; Colonial Helper "
            "не хранит Frontier-токены и запрашивает синхронизацию только через "
            "ваш токен проекта. Сайт сам получает, разбирает и сохраняет данные.")
        self.capi_link_btn = self._button("Открыть Frontier CAPI на сайте",
                                          self.actions.capi_link, primary=True)
        self.capi_fetch_btn = self._button("Обновить досье", self.actions.capi_fetch)
        self._row(self.capi_link_btn, self.capi_fetch_btn)
        self.capi_status = StatusLabel(self.state.capi_status, MUTED)
        self.layout_.addWidget(self.capi_status)

    def _build_journals(self) -> None:
        self._divider()
        self._title(self.SECTION_TITLES["journals"])
        holder = QWidget()
        holder_layout = QHBoxLayout(holder)
        holder_layout.setContentsMargins(0, 0, 0, 0)
        holder_layout.setSpacing(8)
        self.path_entry = self._field(self.state.journal_path)
        holder_layout.addWidget(self.path_entry, 1)
        holder_layout.addWidget(self._button("Обзор…", self.actions.browse_journal))
        self.layout_.addWidget(holder)
        self._hint("По умолчанию: Saved Games\\Frontier Developments\\Elite Dangerous")

    def _build_raven(self) -> None:
        self._divider()
        self._title(self.SECTION_TITLES["raven"])
        self._hint("API-ключ Raven Colonial")
        self._hint("Вставьте сюда ключ из профиля ravencolonial.com. Нажмите "
                   "«Проверить ключ» и сохраните настройки.")
        self.raven_key_entry = self._field(self.state.raven_key, password=True)
        self.layout_.addWidget(self.raven_key_entry)
        self._row(self._button("Проверить ключ", self._raven_check))
        self.raven_status_label = StatusLabel(self.state.raven_status, MUTED)
        self.layout_.addWidget(self.raven_status_label)

    def _raven_check(self) -> None:
        if callable(self.actions.check_raven):
            self.actions.check_raven()

    def _build_edsm(self) -> None:
        self._divider()
        self._title(self.SECTION_TITLES["edsm"])
        self._hint("Необязательно: отправка событий FSDJump, Location, Docked и Scan в EDSM.")
        self._hint("EDSM API key")
        self.edsm_key_entry = self._field(self.state.edsm_key, password=True)
        self.layout_.addWidget(self.edsm_key_entry)
        self._hint("Имя командира в EDSM (точное имя CMDR, зарегистрированное в EDSM)")
        self.edsm_name_entry = self._field(self.state.edsm_name)
        self.layout_.addWidget(self.edsm_name_entry)
        self._row(self._button("Сохранить EDSM настройки", self.actions.save_edsm))
        self.edsm_status_label = StatusLabel(self.state.edsm_status, MUTED)
        self.layout_.addWidget(self.edsm_status_label)

    def _build_eddn(self) -> None:
        self._divider()
        self._title(self.SECTION_TITLES["eddn"])
        self._hint(
            "Исследовательские события журнала (Location, FSDJump, CarrierJump, "
            "Scan, SAASignalsFound, Docked) уходят в открытую ленту EDDN, из которой "
            "берёт данные Spansh. Публикация необратима и видна всем. Колонизация, "
            "вклады и грузы сюда не попадают.")
        self.eddn_enabled_var = QCheckBox("Публиковать исследовательские события в EDDN")
        self.eddn_enabled_var.setChecked(bool(self.state.eddn_enabled))
        self.eddn_enabled_var.toggled.connect(self._on_eddn_toggled)
        self.layout_.addWidget(self.eddn_enabled_var)

    def _on_eddn_toggled(self, checked: bool) -> None:
        if callable(self.actions.eddn_toggle):
            self.actions.eddn_toggle(bool(checked))

    def _build_inara(self) -> None:
        self._divider()
        self._title(self.SECTION_TITLES["inara"])
        self._hint("Необязательно: отправка навигации, стыковок, сканирования и "
                   "грузовых событий в Inara.")
        self._hint("Inara API key")
        self.inara_key_entry = self._field(self.state.inara_key, password=True)
        self.layout_.addWidget(self.inara_key_entry)
        self._hint("Имя командира в Inara")
        self.inara_name_entry = self._field(self.state.inara_name)
        self.layout_.addWidget(self.inara_name_entry)
        self._row(self._button("Сохранить Inara настройки", self.actions.save_inara))
        self.inara_status_label = StatusLabel(self.state.inara_status, MUTED)
        self.layout_.addWidget(self.inara_status_label)

    # ------------------------------------------------------------------ public
    def toggle_token_visibility(self) -> None:
        """Switch the token field between hidden and readable."""
        if self.token_entry.echoMode() == QLineEdit.EchoMode.Password:
            self.token_entry.setEchoMode(QLineEdit.EchoMode.Normal)
            self.toggle_token_btn.setText("Скрыть")
        else:
            self.token_entry.setEchoMode(QLineEdit.EchoMode.Password)
            self.toggle_token_btn.setText("Показать")

    def token_is_hidden(self) -> bool:
        return self.token_entry.echoMode() == QLineEdit.EchoMode.Password

    def set_auth_result(self, text: str, color: _Optional[str] = None) -> None:
        self.auth_result.set_status(text, color)


# ===========================================================================
#  Страница «Загрузка журналов»
# ===========================================================================
@dataclass
class UploadPageActions:
    """Callbacks the Upload page triggers; every one is optional."""

    select_files: _Optional[Callable] = None
    upload: _Optional[Callable] = None
    toggle_watcher: _Optional[Callable] = None
    reset_import_cache: _Optional[Callable] = None
    reset_server_journals: _Optional[Callable] = None
    skip_imported: _Optional[Callable] = None
    backfill_third_party: _Optional[Callable] = None


class UploadPage(QWidget):
    """Journal upload: file selection, progress, watcher and import options.

    The attribute names match the ones the rest of the program uses
    (``upload_btn``, ``files_label``, ``progress`` …), but everything is a plain
    Qt widget: progress is ``set_progress()`` instead of ``configure(value=…)``
    and buttons are switched with ``set_upload_enabled()``.
    """

    WATCHER_IDLE_TEXT = "▶ Следить за игрой"
    WATCHER_RUNNING_TEXT = "⏹ Остановить"
    #: Подпись под прогрессом, пока файлы не выбраны.
    FILES_EMPTY_TEXT = "Файлы не выбраны"

    def __init__(self, *, skip_imported: bool = True, backfill_enabled: bool = False,
                 actions: _Optional[UploadPageActions] = None,
                 parent: _Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.actions = actions or UploadPageActions()
        self.setObjectName("uploadPage")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.content = QWidget()
        self.layout_ = QVBoxLayout(self.content)
        self.layout_.setContentsMargins(16, 14, 16, 16)
        self.layout_.setSpacing(8)
        self.scroll.setWidget(self.content)
        outer.addWidget(self.scroll)

        self.layout_.addWidget(heading("Загрузка журналов", size=14))
        self.layout_.addWidget(label(
            "Файлы журнала Elite Dangerous читаются локально и отправляются "
            "только на ваш сервер проекта.", role="muted", size=9, wrap=True))

        # -- Кнопки действий ------------------------------------------------
        self.select_btn = action_button("Выбрать файлы .log", self._select_files,
                                        height=34)
        self.upload_btn = action_button("Загрузить", self._upload,
                                        variant="primary", height=34)
        self.upload_btn.setEnabled(False)
        self.watcher_btn = action_button(self.WATCHER_IDLE_TEXT, self._toggle_watcher,
                                         height=34)
        self.layout_.addWidget(row(self.select_btn, self.upload_btn,
                                   self.watcher_btn, None))

        self.files_label = label(self.FILES_EMPTY_TEXT, role="muted", size=9, wrap=True)
        self.layout_.addWidget(self.files_label)

        self.progress = QProgressBar()
        self.progress.setObjectName("uploadProgress")
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(False)
        self.progress.setFixedHeight(10)
        self.progress.setStyleSheet(
            f"QProgressBar {{ background: #202428; border: none; border-radius: 5px; }}"
            f"QProgressBar::chunk {{ background: {ORANGE}; border-radius: 5px; }}")
        progress_holder = QWidget()
        progress_layout = QVBoxLayout(progress_holder)
        progress_layout.setContentsMargins(0, 8, 0, 4)
        progress_layout.addWidget(self.progress)
        self.layout_.addWidget(progress_holder)

        self.progress_label = label("", role="muted", size=9, wrap=True)
        self.layout_.addWidget(self.progress_label)

        # -- Первичная загрузка ---------------------------------------------
        self._divider()
        self.layout_.addWidget(label("Первичная загрузка (вся история журналов)",
                                     size=11, bold=True))

        self.skip_imported_var = QCheckBox(
            "Пропускать файлы, загруженные ранее (быстрый повторный импорт)")
        self.skip_imported_var.setChecked(bool(skip_imported))
        self.skip_imported_var.toggled.connect(self._on_skip_imported_toggled)
        self.layout_.addWidget(self.skip_imported_var)

        self.backfill_third_party_var = QCheckBox(
            "Отправлять историю в EDSM / Inara / Raven Colonial (очень медленно)")
        self.backfill_third_party_var.setChecked(bool(backfill_enabled))
        self.backfill_third_party_var.toggled.connect(self._on_backfill_toggled)
        self.layout_.addWidget(self.backfill_third_party_var)

        self.layout_.addWidget(label(
            "По умолчанию история отправляется только на ED Ring Colony: внешние "
            "сервисы получают лишь live-события watcher'а. Отправка тысяч "
            "исторических событий в EDSM/Inara/Raven — это часы ожидания и риск "
            "блокировки по rate limit.", role="muted", size=9, wrap=True))

        self.reset_cache_btn = action_button("Сбросить кэш импорта",
                                             self._reset_import_cache, height=32)
        self.reset_server_btn = action_button("Очистить логи на сервере",
                                              self._reset_server_journals,
                                              variant="danger", height=32)
        self.layout_.addWidget(row(self.reset_cache_btn, self.reset_server_btn, None))
        self.layout_.addStretch(1)

    # ------------------------------------------------------------------ pieces
    def _divider(self) -> None:
        line = QFrame()
        line.setObjectName("separator")
        line.setFixedHeight(1)
        wrapper = QWidget()
        wrapper_layout = QVBoxLayout(wrapper)
        wrapper_layout.setContentsMargins(0, 12, 0, 12)
        wrapper_layout.addWidget(line)
        self.layout_.addWidget(wrapper)

    def _call(self, name: str, *args) -> None:
        callback = getattr(self.actions, name, None)
        if callable(callback):
            callback(*args)

    def _select_files(self) -> None:
        self._call("select_files")

    def _upload(self) -> None:
        self._call("upload")

    def _toggle_watcher(self) -> None:
        self._call("toggle_watcher")

    def _reset_import_cache(self) -> None:
        self._call("reset_import_cache")

    def _reset_server_journals(self) -> None:
        self._call("reset_server_journals")

    def _on_skip_imported_toggled(self, checked: bool) -> None:
        self._call("skip_imported", bool(checked))

    def _on_backfill_toggled(self, checked: bool) -> None:
        self._call("backfill_third_party", bool(checked))

    # ------------------------------------------------------------------ public
    def set_files_text(self, text: str) -> None:
        self.files_label.setText(str(text))

    def files_text(self) -> str:
        return self.files_label.text()

    def set_upload_enabled(self, enabled: bool) -> None:
        self.upload_btn.setEnabled(bool(enabled))

    def set_progress(self, value: float, text: _Optional[str] = None) -> None:
        """Set the bar position (clamped to 0…100) and, optionally, its caption."""
        try:
            percent = float(value)
        except (TypeError, ValueError):
            percent = 0.0
        percent = max(0.0, min(100.0, percent))
        self.progress.setMaximum(100)
        self.progress.setValue(int(round(percent)))
        if text is not None:
            self.set_progress_text(text)

    def progress_value(self) -> int:
        return self.progress.value()

    def set_progress_text(self, text: str) -> None:
        self.progress_label.setText(str(text))

    def progress_text(self) -> str:
        return self.progress_label.text()

    def set_watcher_running(self, running: bool) -> None:
        """Switch the watcher button between «следить» and «остановить»."""
        if running:
            self.watcher_btn.setText(self.WATCHER_RUNNING_TEXT)
            self.watcher_btn.setProperty("variant", "danger")
        else:
            self.watcher_btn.setText(self.WATCHER_IDLE_TEXT)
            self.watcher_btn.setProperty("variant", "default")
        style = self.watcher_btn.style()
        style.unpolish(self.watcher_btn)
        style.polish(self.watcher_btn)

    def watcher_running(self) -> bool:
        return self.watcher_btn.text() == self.WATCHER_RUNNING_TEXT

    def set_skip_imported(self, enabled: bool) -> None:
        """Set the checkbox without re-triggering the save callback."""
        blocked = self.skip_imported_var.blockSignals(True)
        self.skip_imported_var.setChecked(bool(enabled))
        self.skip_imported_var.blockSignals(blocked)

    def set_backfill_third_party(self, enabled: bool) -> None:
        blocked = self.backfill_third_party_var.blockSignals(True)
        self.backfill_third_party_var.setChecked(bool(enabled))
        self.backfill_third_party_var.blockSignals(blocked)


# ===========================================================================
#  Страница «Инфографика пилота»
# ===========================================================================
from typing import Dict, Iterable, List, Sequence, Tuple

from PySide6.QtGui import QBrush, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QGridLayout

PILOT_KPI_KEYS = ("kpi_tons", "kpi_deliveries", "kpi_cargo", "kpi_systems")
PILOT_TILES = ("session", "ship", "route", "systems", "status", "journal")


def pilot_columns(width: int, compact: bool) -> int:
    """How many tile columns fit into ``width`` (compact mode is denser)."""
    width = int(width or 0)
    if compact:
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


def sparkline_points(values: Sequence[float], width: int, height: int,
                     padding: int = 4) -> List[Tuple[float, float]]:
    """Map a value series onto canvas coordinates (empty when not drawable)."""
    points = [float(value) for value in values]
    if len(points) < 2 or width < 10 or height < 10:
        return []
    low, high = min(points), max(points)
    if high - low < 1e-9:
        low, high = low - 1.0, high + 1.0
    usable = max(1, height - padding * 2)
    step_x = width / float(len(points) - 1)
    return [(index * step_x,
             padding + (1.0 - (value - low) / (high - low)) * usable)
            for index, value in enumerate(points)]


def bars_geometry(rows: Sequence[Tuple[str, float]], width: int, height: int,
                  limit: int = 8) -> List[Dict[str, object]]:
    """Geometry for the "top systems" chart: bar rectangle plus both captions."""
    items = [(str(name), float(value)) for name, value in rows[:limit]]
    if not items or width < 10 or height < 10:
        return []
    maximum = max(value for _name, value in items) or 1.0
    row_height = max(18, min(28, height // max(1, len(items))))
    # Полоса живёт между подписью слева и числом справа, иначе текст
    # наезжает на неё и обрезается краем виджета.
    label_width = min(150, int(width * 0.45))
    value_width = 56
    bar_left = label_width + 6
    bar_space = max(10, width - bar_left - value_width)
    output: List[Dict[str, object]] = []
    for index, (name, value) in enumerate(items):
        top = index * row_height + 2
        output.append({
            "name": name[:22],
            "value": value,
            "label_x": 0,
            "value_x": width,
            "rect": (bar_left, top, max(2, int(bar_space * (value / maximum))),
                     row_height - 8),
            "label_y": top + row_height - 6,
        })
    return output


class ElidedLabel(QLabel):
    """Label that shortens long text with an ellipsis instead of clipping it.

    ``text()`` still returns the full value, so callers and tests keep the
    complete string; only the painted text is shortened. Painting stays with
    QLabel itself, so colours and alignment from the stylesheet keep working.
    """

    def __init__(self, text: str = "", parent=None) -> None:
        super().__init__(parent)
        self._full = ""
        self.setText(text)
        # Ignored схлопывает метку в нулевую ширину; Preferred + эллипсис
        # даёт нормальный размер и аккуратное усечение длинных значений.
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)
        self.setMinimumWidth(40)

    def full_text(self) -> str:
        return self._full

    def text(self) -> str:  # noqa: D401 - Qt API contract
        return self._full

    def setText(self, text: str) -> None:  # noqa: N802 - Qt API
        self._full = str(text)
        self.setToolTip(self._full)
        self._apply()

    def _apply(self) -> None:
        width = max(0, self.width() - 2)
        if width <= 0:
            super().setText(self._full)
            return
        metrics = self.fontMetrics()
        painted = metrics.elidedText(self._full, Qt.TextElideMode.ElideRight, width)
        super().setText(painted)

    def set_full_text(self, text: str) -> None:
        """Set the complete value (the painted text may be shortened)."""
        self.setText(text)

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().resizeEvent(event)
        self._apply()

    # Запрашиваем место под полный текст: иначе раскладка «видит» уже
    # обрезанную строку, сжимает метку и обрезает её ещё сильнее.
    def sizeHint(self):  # noqa: N802 - Qt API
        hint = super().sizeHint()
        width = self.fontMetrics().horizontalAdvance(self._full) + 2
        return hint.expandedTo(hint.__class__(max(width, self.minimumWidth()), hint.height()))


class SparklineWidget(QWidget):
    """Filled line chart of the current session (no external chart library)."""

    def __init__(self, color: str = "#65c78a", *, height: int = 64,
                 empty_text: str = "накопление данных…", parent=None) -> None:
        super().__init__(parent)
        self.color = QColor(color)
        self.empty_text = empty_text
        self.values: List[float] = []
        self.setMinimumHeight(height)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_values(self, values: Iterable[float]) -> None:
        self.values = [float(value) for value in values]
        self.update()

    def paintEvent(self, _event) -> None:  # noqa: N802 - Qt API
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        width, height = self.width(), self.height()
        points = sparkline_points(self.values, width, height)
        if not points:
            painter.setPen(QPen(QColor(MUTED)))
            painter.drawText(6, height // 2 + 4, self.empty_text)
            return
        path = QPainterPath()
        path.moveTo(points[0][0], height)
        for x, y in points:
            path.lineTo(x, y)
        path.lineTo(points[-1][0], height)
        path.closeSubpath()
        fill = QColor(self.color)
        fill.setAlpha(70)
        painter.fillPath(path, QBrush(fill))
        line = QPainterPath()
        line.moveTo(*points[0])
        for point in points[1:]:
            line.lineTo(*point)
        painter.setPen(QPen(self.color, 2))
        painter.drawPath(line)
        painter.setPen(QPen(self.color))
        painter.drawText(4, 14, f"{self.values[-1]:.0f}")


class BarsChart(QWidget):
    """Horizontal bars: "top systems by tons"."""

    def __init__(self, color: str = "#42b9d4", *, height: int = 110,
                 empty_text: str = "данных пока нет", parent=None) -> None:
        super().__init__(parent)
        self.color = QColor(color)
        self.empty_text = empty_text
        self.rows: List[Tuple[str, float]] = []
        self.setMinimumHeight(height)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_rows(self, rows: Sequence[Tuple[str, float]]) -> None:
        self.rows = [(str(name), float(value)) for name, value in rows]
        self.update()

    def paintEvent(self, _event) -> None:  # noqa: N802 - Qt API
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        width, height = self.width(), self.height()
        geometry = bars_geometry(self.rows, width, height)
        if not geometry:
            painter.setPen(QPen(QColor(MUTED)))
            painter.drawText(6, max(14, height // 2), self.empty_text)
            return
        label_font = painter.font()
        label_font.setPointSize(8)
        painter.setFont(label_font)
        for item in geometry:
            x, y, bar_width, bar_height = item["rect"]
            painter.fillRect(x, y, bar_width, bar_height, self.color)
            painter.setPen(QPen(QColor(MUTED)))
            painter.drawText(int(item["label_x"]), int(item["label_y"]), str(item["name"]))
            painter.setPen(QPen(QColor(TEXT)))
            value_text = f"{item['value']:.0f} t"
            painter.drawText(int(item["value_x"]) - 52, int(item["label_y"]), value_text)


class PilotPage(QWidget):
    """Pilot infographic: KPI cards, detail tiles, sparkline and bar chart.

    Values are pushed in by the application (``set_value``/``set_bar``), so the
    page never reaches for trackers itself and stays trivially testable.
    """

    ROW_KEYS = {
        "session": ("session_rate", "session_construction", "session_route"),
        "ship": ("ship", "modules"),
        "route": ("route_status", "route_current", "route_next",
                  "route_remaining", "last_delivery"),
        "status": ("commander", "system", "game", "watcher", "services", "exobio"),
        "journal": ("balance", "rebuy", "legal", "journal_state",
                    "event_summary", "last_event"),
    }
    BAR_KEYS = {
        "ship": (("hull_bar", "Корпус"), ("shield_bar", "Щиты"),
                 ("fuel_bar", "Топливо"), ("power_bar", "Энергия")),
        "route": (("route_progress", "Прогресс"),),
    }
    ROW_LABELS = {
        "session_rate": "Темп", "session_construction": "На стройки",
        "session_route": "На маршруте", "ship": "Корабль", "modules": "Модули",
        "route_status": "Пройдено", "route_current": "Текущая",
        "route_next": "Следующая", "route_remaining": "Осталось",
        "last_delivery": "Последняя доставка", "commander": "CMDR",
        "system": "Система", "game": "Игра", "watcher": "Watcher",
        "services": "Сервисы", "exobio": "Экзобиология", "balance": "Баланс",
        "rebuy": "Страховка", "legal": "Правовой статус",
        "journal_state": "Журналы", "event_summary": "События",
        "last_event": "Последнее",
    }

    def __init__(self, *, compact: bool = False, columns_provider=None,
                 on_compact_changed=None, on_refresh=None,
                 on_columns_changed=None, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("pilotPage")
        self._compact = bool(compact)
        self._columns_provider = columns_provider
        self._on_compact_changed = on_compact_changed
        self._on_refresh = on_refresh
        self._on_columns_changed = on_columns_changed
        self._columns = 0
        self.values: Dict[str, QLabel] = {}
        self.subs: Dict[str, QLabel] = {}
        self.bars: Dict[str, QProgressBar] = {}

        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 10, 12, 12)
        layout.setSpacing(8)
        layout.addWidget(self._header())
        layout.addWidget(label(
            "Живые данные из журнала, трекера корабля, маршрута и текущей сессии. "
            "Сетевых запросов инфографика не делает.", role="muted", size=9, wrap=True))

        self.kpi_row = QWidget()
        self.kpi_layout = QHBoxLayout(self.kpi_row)
        self.kpi_layout.setContentsMargins(0, 0, 0, 0)
        self.kpi_layout.setSpacing(8)
        layout.addWidget(self.kpi_row)
        self._build_kpis()

        self.tiles_area = QWidget()
        self.tile_layout = QGridLayout(self.tiles_area)
        self.tile_layout.setContentsMargins(0, 0, 0, 0)
        self.tile_layout.setSpacing(8)
        layout.addWidget(self.tiles_area, 1)
        self._rebuild_tiles(self.columns())

    # ------------------------------------------------------------------ header
    def _header(self) -> QWidget:
        holder = QWidget()
        holder_layout = QHBoxLayout(holder)
        holder_layout.setContentsMargins(0, 0, 0, 0)
        holder_layout.setSpacing(10)
        title = label("ИНФОГРАФИКА ПИЛОТА", role="mono", size=15, bold=True, color=ORANGE)
        holder_layout.addWidget(title)
        holder_layout.addStretch(1)
        self.updated_label = label("", role="mono", size=9, color=MUTED)
        self.updated_label.setObjectName("pilotUpdated")
        holder_layout.addWidget(self.updated_label)
        self.refresh_button = action_button("Обновить", self._refresh_clicked, height=30)
        holder_layout.addWidget(self.refresh_button)
        self.compact_check = QCheckBox("Компактный режим")
        self.compact_check.setChecked(self._compact)
        self.compact_check.toggled.connect(self._compact_toggled)
        holder_layout.addWidget(self.compact_check)
        return holder

    def _refresh_clicked(self) -> None:
        if callable(self._on_refresh):
            self._on_refresh()

    def _compact_toggled(self, checked: bool) -> None:
        self._compact = bool(checked)
        if callable(self._on_compact_changed):
            self._on_compact_changed(bool(checked))

    # -------------------------------------------------------------------- KPIs
    def _build_kpis(self) -> None:
        specs = (
            ("kpi_tons", "ТОННЫ ЗА СЕССИЮ", GREEN),
            ("kpi_deliveries", "ДОСТАВКИ", CYAN),
            ("kpi_cargo", "ГРУЗ", ORANGE),
            ("kpi_systems", "СИСТЕМЫ", CYAN),
        )
        for index, (key, title, color) in enumerate(specs):
            card = panel(QFrame(), "card")
            card.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
            card_layout = QVBoxLayout(card)
            card_layout.setContentsMargins(12, 9, 12, 9)
            card_layout.setSpacing(2)
            card_layout.addWidget(label(title, role="mono", size=9, bold=True, color=MUTED))
            value = label("—", role="mono", size=28 if not self._compact else 20,
                          bold=True, color=color)
            value.setObjectName(key)
            card_layout.addWidget(value)
            sub = label("", role="mono", size=9, color=MUTED, wrap=True)
            sub.setObjectName(f"{key}_sub")
            card_layout.addWidget(sub)
            self.values[key] = value
            self.subs[f"{key}_sub"] = sub
            self.kpi_layout.addWidget(card, 1)

    # ------------------------------------------------------------------- tiles
    def columns(self) -> int:
        if callable(self._columns_provider):
            try:
                return int(self._columns_provider())
            except Exception:
                pass
        return pilot_columns(self.width() or 1180, self._compact)

    def _clear_tiles(self) -> None:
        while self.tile_layout.count():
            item = self.tile_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()
        self.bars.clear()

    def _tile(self, title: str) -> Tuple[QFrame, QVBoxLayout]:
        card = panel(QFrame(), "card")
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(12, 9, 12, 9)
        card_layout.setSpacing(3)
        card_layout.addWidget(label(title, role="mono",
                                    size=9 if self._compact else 10,
                                    bold=True, color=ORANGE))
        return card, card_layout

    def _row_widget(self, key: str, *, color: str = CYAN) -> QWidget:
        holder = panel(QWidget(), "panelClear")
        holder_layout = QHBoxLayout(holder)
        holder_layout.setContentsMargins(0, 0, 0, 0)
        holder_layout.setSpacing(8)
        title = label(self.ROW_LABELS.get(key, key), role="mono", size=9, color=MUTED)
        title.setSizePolicy(QSizePolicy.Policy.Minimum, QSizePolicy.Policy.Preferred)
        holder_layout.addWidget(title, 0)
        holder_layout.addStretch(1)
        value = ElidedLabel("—")
        value.setObjectName(key)
        font = value.font()
        font.setPointSize(10)
        font.setBold(True)
        font.setFamily("Consolas")
        value.setFont(font)
        value.setStyleSheet(f"color:{color};")
        value.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        value.setMaximumWidth(300)
        holder_layout.addWidget(value)
        self.values[key] = value
        return holder

    def _bar_widget(self, key: str, title: str) -> QWidget:
        holder = QWidget()
        holder_layout = QVBoxLayout(holder)
        holder_layout.setContentsMargins(0, 2, 0, 0)
        holder_layout.setSpacing(2)
        holder_layout.addWidget(label(title, role="mono", size=9, color=MUTED))
        bar = QProgressBar()
        bar.setRange(0, 100)
        bar.setValue(0)
        bar.setTextVisible(False)
        bar.setFixedHeight(8)
        bar.setStyleSheet(
            "QProgressBar { background: #202428; border: none; border-radius: 4px; }"
            "QProgressBar::chunk { background: #42b9d4; border-radius: 4px; }")
        holder_layout.addWidget(bar)
        self.bars[key] = bar
        return holder

    def _rebuild_tiles(self, columns: int) -> None:
        columns = max(1, int(columns))
        self._columns = columns
        self._clear_tiles()
        builders = {
            "session": self._tile_session,
            "ship": self._tile_ship,
            "route": self._tile_route,
            "systems": self._tile_systems,
            "status": self._tile_status,
            "journal": self._tile_journal,
        }
        for index, key in enumerate(PILOT_TILES):
            row, column = divmod(index, columns)
            card = builders[key]()
            self.tile_layout.addWidget(card, row, column)
            self.tile_layout.setRowStretch(row, 1)
        for column in range(columns):
            self.tile_layout.setColumnStretch(column, 1)

    def _tile_session(self) -> QWidget:
        card, card_layout = self._tile("ДИНАМИКА СЕССИИ")
        self.spark = SparklineWidget(color=GREEN, height=64,
                                     empty_text="журнал пока пуст")
        card_layout.addWidget(self.spark)
        for key in self.ROW_KEYS["session"]:
            card_layout.addWidget(self._row_widget(key))
        card_layout.addStretch(1)
        return card

    def _tile_ship(self) -> QWidget:
        card, card_layout = self._tile("КОРАБЛЬ")
        card_layout.addWidget(self._row_widget("ship"))
        for key, title in self.BAR_KEYS["ship"]:
            card_layout.addWidget(self._bar_widget(key, title))
        card_layout.addWidget(self._row_widget("modules"))
        card_layout.addStretch(1)
        return card

    def _tile_route(self) -> QWidget:
        card, card_layout = self._tile("МАРШРУТ")
        card_layout.addWidget(self._row_widget("route_status"))
        for key, title in self.BAR_KEYS["route"]:
            card_layout.addWidget(self._bar_widget(key, title))
        for key in ("route_current", "route_next", "route_remaining", "last_delivery"):
            card_layout.addWidget(self._row_widget(key))
        card_layout.addStretch(1)
        return card

    def _tile_systems(self) -> QWidget:
        card, card_layout = self._tile("ТОП СИСТЕМ ПО ТОННАМ")
        self.systems_chart = BarsChart(color=CYAN, height=110)
        card_layout.addWidget(self.systems_chart)
        card_layout.addStretch(1)
        return card

    def _tile_status(self) -> QWidget:
        card, card_layout = self._tile("СТАТУС И ПОДКЛЮЧЕНИЯ")
        for key in self.ROW_KEYS["status"]:
            card_layout.addWidget(self._row_widget(key))
        card_layout.addStretch(1)
        return card

    def _tile_journal(self) -> QWidget:
        card, card_layout = self._tile("ЖУРНАЛЫ И ЭКОНОМИКА")
        for key in self.ROW_KEYS["journal"]:
            color = MUTED if key == "last_event" else CYAN
            card_layout.addWidget(self._row_widget(key, color=color))
        card_layout.addStretch(1)
        return card

    # ------------------------------------------------------------------- data
    def set_value(self, key: str, text: str) -> None:
        widget = self.values.get(key) or self.subs.get(key)
        if widget is None:
            return
        # Метка усечёт по фактической ширине, полное значение останется в подсказке.
        widget.setText(str(text))

    def set_bar(self, key: str, value: float) -> None:
        bar = self.bars.get(key)
        if bar is not None:
            bar.setValue(int(max(0.0, min(100.0, float(value or 0)))))

    def set_spark(self, values: Iterable[float]) -> None:
        chart = getattr(self, "spark", None)
        if chart is not None:
            chart.set_values(values)

    def set_systems(self, rows: Sequence[Tuple[str, float]]) -> None:
        chart = getattr(self, "systems_chart", None)
        if chart is not None:
            chart.set_rows(rows)

    def set_updated(self, text: str) -> None:
        self.updated_label.setText(str(text))

    def column_count(self) -> int:
        return self._columns

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().resizeEvent(event)
        if self.columns() != self._columns:
            self._rebuild_tiles(self.columns())
            if callable(self._on_columns_changed):
                self._on_columns_changed()
