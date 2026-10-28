"""Native Qt pages for the Colonial Helper main window.

Pages are migrated here one at a time; a page that lives here is built from real
PySide6 widgets and owns its behaviour. Pages that are still on the
compatibility layer are hosted by :class:`helper_shell.HelperShell` unchanged,
so both kinds coexist in one window during the migration.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QColor, QFont, QTextCharFormat, QTextCursor
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QRadioButton,
    QScrollArea,
    QSizePolicy,
    QSlider,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from i18n import tr
from ui_qt import (
    CYAN,
    GREEN,
    LINE,
    MUTED,
    ORANGE,
    PANEL,
    PANEL_ALT,
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

        layout.addWidget(heading(tr("Информационное окно"), size=12))
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
        self.clear_button = action_button(tr("Очистить лог"), self.clear)
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
        self.counter.setText(tr("записей: {count}", count=count) if count else "")

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
    raven_status: str = ""
    edsm_key: str = ""
    edsm_name: str = ""
    edsm_status: str = ""
    eddn_enabled: bool = False
    inara_key: str = ""
    inara_name: str = ""
    inara_status: str = ""
    capi_status: str = ""


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
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
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
        self._title(tr(self.SECTION_TITLES["api"]))
        self.server_label = label(tr("Сервер: {url}", url=self.state.site_url),
                                  role="accent", size=9)
        self.layout_.addWidget(self.server_label)
        self._row(
            self._button(tr("Открыть API-токены на сайте"), self.actions.open_tokens),
            self._button(tr("Другой сервер..."), self.actions.change_server),
        )
        self.site_error_label = label(self.state.site_error, size=9, color="#e27676", wrap=True)
        self.site_error_label.setVisible(bool(self.state.site_error))
        self.layout_.addWidget(self.site_error_label)

        self._hint(tr("API-токен сайта"))
        self._hint(tr("Поле для API-токена ED Ring Colony из профиля сайта. "
                      "Используется для загрузки журналов."))
        self.token_entry = self._field(self.state.token, password=True)
        self.token_entry.setPlaceholderText(tr("Токен ED Ring Colony"))
        self.layout_.addWidget(self.token_entry)
        self.toggle_token_btn = self._button(tr("Показать"), self.toggle_token_visibility)
        self._row(
            self._button(tr("Проверить токен"), self.actions.validate_token),
            self._button(tr("Вставить из буфера"), self.actions.paste_token),
            self.toggle_token_btn,
        )
        self.auth_result = StatusLabel("", TEXT)
        self.layout_.addWidget(self.auth_result)

    def _build_capi(self) -> None:
        self._divider()
        self._title(tr(self.SECTION_TITLES["capi"]))
        self._hint(tr(
            "Подключение и данные CAPI принадлежат вашему аккаунту на сайте. "
            "Сначала привяжите Frontier в личном кабинете сайта; Colonial Helper "
            "не хранит Frontier-токены и запрашивает синхронизацию только через "
            "ваш токен проекта. Сайт сам получает, разбирает и сохраняет данные."))
        self.capi_link_btn = self._button(tr("Открыть Frontier CAPI на сайте"),
                                          self.actions.capi_link, primary=True)
        self.capi_fetch_btn = self._button(tr("Обновить досье"), self.actions.capi_fetch)
        self._row(self.capi_link_btn, self.capi_fetch_btn)
        self.capi_status = StatusLabel(
            self.state.capi_status or tr("Проверка привязки сайта…"), MUTED)
        self.layout_.addWidget(self.capi_status)

    def _build_journals(self) -> None:
        self._divider()
        self._title(tr(self.SECTION_TITLES["journals"]))
        holder = QWidget()
        holder_layout = QHBoxLayout(holder)
        holder_layout.setContentsMargins(0, 0, 0, 0)
        holder_layout.setSpacing(8)
        self.path_entry = self._field(self.state.journal_path)
        holder_layout.addWidget(self.path_entry, 1)
        holder_layout.addWidget(self._button(tr("Обзор..."), self.actions.browse_journal))
        self.layout_.addWidget(holder)
        self._hint(tr("По умолчанию: Saved Games\\Frontier Developments\\Elite Dangerous"))

    def _build_raven(self) -> None:
        self._divider()
        self._title(tr(self.SECTION_TITLES["raven"]))
        self._hint(tr("API-ключ Raven Colonial"))
        self._hint(tr("Вставьте сюда ключ из профиля ravencolonial.com. Нажмите "
                      "«Проверить ключ» и сохраните настройки."))
        self.raven_key_entry = self._field(self.state.raven_key, password=True)
        self.layout_.addWidget(self.raven_key_entry)
        self._row(self._button(tr("Проверить ключ"), self._raven_check))
        self.raven_status_label = StatusLabel(
            self.state.raven_status or tr("Raven Colonial: не подключено"), MUTED)
        self.layout_.addWidget(self.raven_status_label)

    def _raven_check(self) -> None:
        if callable(self.actions.check_raven):
            self.actions.check_raven()

    def _build_edsm(self) -> None:
        self._divider()
        self._title(tr(self.SECTION_TITLES["edsm"]))
        self._hint(tr("Необязательно: отправка событий FSDJump, Location, Docked и Scan в EDSM."))
        self._hint("EDSM API key")
        self.edsm_key_entry = self._field(self.state.edsm_key, password=True)
        self.layout_.addWidget(self.edsm_key_entry)
        self._hint(tr("Имя командира в EDSM (точное имя CMDR, зарегистрированное в EDSM)"))
        self.edsm_name_entry = self._field(self.state.edsm_name)
        self.layout_.addWidget(self.edsm_name_entry)
        self._row(self._button(tr("Сохранить EDSM настройки"), self.actions.save_edsm))
        self.edsm_status_label = StatusLabel(
            self.state.edsm_status or tr("EDSM: не настроен"), MUTED)
        self.layout_.addWidget(self.edsm_status_label)

    def _build_eddn(self) -> None:
        self._divider()
        self._title(tr(self.SECTION_TITLES["eddn"]))
        self._hint(tr(
            "Исследовательские события журнала (Location, FSDJump, CarrierJump, "
            "Scan, SAASignalsFound, Docked) уходят в открытую ленту EDDN, из которой "
            "берёт данные Spansh. Публикация необратима и видна всем. Колонизация, "
            "вклады и грузы сюда не попадают."))
        self.eddn_enabled_var = QCheckBox(tr("Публиковать исследовательские события в EDDN"))
        self.eddn_enabled_var.setChecked(bool(self.state.eddn_enabled))
        self.eddn_enabled_var.toggled.connect(self._on_eddn_toggled)
        self.layout_.addWidget(self.eddn_enabled_var)

    def _on_eddn_toggled(self, checked: bool) -> None:
        if callable(self.actions.eddn_toggle):
            self.actions.eddn_toggle(bool(checked))

    def _build_inara(self) -> None:
        self._divider()
        self._title(tr(self.SECTION_TITLES["inara"]))
        self._hint(tr("Необязательно: отправка навигации, стыковок, сканирования и "
                      "грузовых событий в Inara."))
        self._hint("Inara API key")
        self.inara_key_entry = self._field(self.state.inara_key, password=True)
        self.layout_.addWidget(self.inara_key_entry)
        self._hint(tr("Имя командира в Inara"))
        self.inara_name_entry = self._field(self.state.inara_name)
        self.layout_.addWidget(self.inara_name_entry)
        self._row(self._button(tr("Сохранить Inara настройки"), self.actions.save_inara))
        self.inara_status_label = StatusLabel(
            self.state.inara_status or tr("Inara: не настроена"), MUTED)
        self.layout_.addWidget(self.inara_status_label)

    # ------------------------------------------------------------------ public
    def toggle_token_visibility(self) -> None:
        """Switch the token field between hidden and readable."""
        if self.token_entry.echoMode() == QLineEdit.EchoMode.Password:
            self.token_entry.setEchoMode(QLineEdit.EchoMode.Normal)
            self.toggle_token_btn.setText(tr("Скрыть"))
        else:
            self.token_entry.setEchoMode(QLineEdit.EchoMode.Password)
            self.toggle_token_btn.setText(tr("Показать"))

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

    #: Строки-источники: показываются в текущем языке через ``tr()``.
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
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.content = QWidget()
        self.layout_ = QVBoxLayout(self.content)
        self.layout_.setContentsMargins(16, 14, 16, 16)
        self.layout_.setSpacing(8)
        self.scroll.setWidget(self.content)
        outer.addWidget(self.scroll)

        self.layout_.addWidget(heading(tr("Загрузка журналов"), size=14))
        self.layout_.addWidget(label(tr(
            "Файлы журнала Elite Dangerous читаются локально и отправляются "
            "только на ваш сервер проекта."), role="muted", size=9, wrap=True))

        # -- Кнопки действий ------------------------------------------------
        self.select_btn = action_button(tr("Выбрать файлы .log"), self._select_files,
                                        height=34)
        self.upload_btn = action_button(tr("Загрузить"), self._upload,
                                        variant="primary", height=34)
        self.upload_btn.setEnabled(False)
        self._watcher_running = False
        self.watcher_btn = action_button(tr(self.WATCHER_IDLE_TEXT), self._toggle_watcher,
                                         height=34)
        self.layout_.addWidget(row(self.select_btn, self.upload_btn,
                                   self.watcher_btn, None))

        self.files_label = label(tr(self.FILES_EMPTY_TEXT), role="muted", size=9, wrap=True)
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
        self.layout_.addWidget(label(tr("Первичная загрузка (вся история журналов)"),
                                     size=11, bold=True))

        self.skip_imported_var = QCheckBox(tr(
            "Пропускать файлы, загруженные ранее (быстрый повторный импорт)"))
        self.skip_imported_var.setChecked(bool(skip_imported))
        self.skip_imported_var.toggled.connect(self._on_skip_imported_toggled)
        self.layout_.addWidget(self.skip_imported_var)

        self.backfill_third_party_var = QCheckBox(tr(
            "Отправлять историю в EDSM / Inara / Raven Colonial (очень медленно)"))
        self.backfill_third_party_var.setChecked(bool(backfill_enabled))
        self.backfill_third_party_var.toggled.connect(self._on_backfill_toggled)
        self.layout_.addWidget(self.backfill_third_party_var)

        self.layout_.addWidget(label(tr(
            "По умолчанию история отправляется только на ED Ring Colony: внешние "
            "сервисы получают лишь live-события watcher'а. Отправка тысяч "
            "исторических событий в EDSM/Inara/Raven — это часы ожидания и риск "
            "блокировки по rate limit."), role="muted", size=9, wrap=True))

        self.reset_cache_btn = action_button(tr("Сбросить кэш импорта"),
                                             self._reset_import_cache, height=32)
        self.reset_server_btn = action_button(tr("Очистить логи на сервере"),
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
        self._watcher_running = bool(running)
        if running:
            self.watcher_btn.setText(tr(self.WATCHER_RUNNING_TEXT))
            self.watcher_btn.setProperty("variant", "danger")
        else:
            self.watcher_btn.setText(tr(self.WATCHER_IDLE_TEXT))
            self.watcher_btn.setProperty("variant", "default")
        style = self.watcher_btn.style()
        style.unpolish(self.watcher_btn)
        style.polish(self.watcher_btn)

    def watcher_running(self) -> bool:
        """Состояние берётся из флага: подпись кнопки переводится."""
        return bool(getattr(self, "_watcher_running", False))

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
#  Страница «Маршрут»
# ===========================================================================
#: Заголовки колонок и стартовая ширина в пикселях.
ROUTE_COLUMNS = (("#", 46), ("Система", 300), ("Статус", 130), ("Посещена", 170))
#: Заголовки таблиц, которые не переводятся: номер строки, звёздочка основного
#: проекта и техническое имя поля.
KEEP_COLUMN_TITLES = frozenset({"#", "★", "buildId"})

#: Подписи, одинаковые на всех языках: проценты размера блока HUD. Переводить
#: их нечего — «XS — 75%» и по-немецки «XS — 75%», поэтому в каталоге их нет.
UNTRANSLATED_TEXTS = frozenset({"XS — 75%", "S — 85%", "M — 100%",
                               "L — 125%", "XL — 150%"})


def column_title(title: str) -> str:
    """Подпись заголовка колонки на текущем языке.

    Переводится только то, что видит командир: «#», «★» и «buildId» — это
    номер строки, значок и имя поля API, их перевод сделал бы таблицу
    непонятной.
    """
    text = str(title)
    return text if text in KEEP_COLUMN_TITLES else tr(text)


#: Цвет строки по состоянию системы маршрута.
ROUTE_STATUS_COLORS = {"visited": GREEN, "current": ORANGE, "pending": MUTED}


@dataclass
class RoutePageActions:
    """Callbacks the Route page triggers; every one is optional."""

    import_route: _Optional[Callable] = None
    export_csv: _Optional[Callable] = None
    import_atlas: _Optional[Callable] = None
    clear: _Optional[Callable] = None


class RoutePage(QWidget):
    """Route tracking: import buttons, a read-only table and a counter.

    The table replaces the Tk ``Treeview``: rows are written whole with
    :meth:`set_rows`, so the caller no longer deletes items one by one and no
    longer configures tags for colours.
    """

    def __init__(self, actions: _Optional[RoutePageActions] = None,
                 parent: _Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.actions = actions or RoutePageActions()
        self.setObjectName("routePage")

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 14, 16, 16)
        layout.setSpacing(8)

        layout.addWidget(heading(tr("Отслеживание маршрута"), size=14))
        layout.addWidget(label(tr(
            "Импортируйте маршрут из NavRoute.json или CSV. Системы отмечаются "
            "автоматически при разборе журналов."), role="muted", size=9, wrap=True))

        self.import_btn = action_button(tr("Импорт маршрута"), self._import_route, height=34)
        self.export_btn = action_button(tr("Экспорт CSV"), self._export_csv, height=34)
        self.atlas_btn = action_button(tr("Забрать из Atlas"), self._import_atlas,
                                       variant="primary", height=34)
        self.clear_btn = action_button(tr("Очистить"), self._clear, height=34)
        layout.addWidget(row(self.import_btn, self.export_btn, self.atlas_btn,
                             self.clear_btn, None))

        self.table = QTableWidget(0, len(ROUTE_COLUMNS))
        self.table.setObjectName("routeTable")
        for index, (title, _width) in enumerate(ROUTE_COLUMNS):
            header_item = QTableWidgetItem(column_title(title))
            header_item.setTextAlignment(
                Qt.AlignmentFlag.AlignVCenter |
                (Qt.AlignmentFlag.AlignLeft if index == 1
                 else Qt.AlignmentFlag.AlignHCenter))
            self.table.setHorizontalHeaderItem(index, header_item)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setShowGrid(False)
        self.table.setAlternatingRowColors(False)
        self.table.setWordWrap(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        header.setStretchLastSection(False)
        for index, (_title, width) in enumerate(ROUTE_COLUMNS):
            self.table.setColumnWidth(index, width)
        # Список систем растягивается на всю свободную ширину: иначе на широком
        # окне справа остаётся пустое поле, а имена систем обрезаны.
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.setStyleSheet(
            f"QTableWidget {{ background: {PANEL}; color: {TEXT};"
            f" border: 1px solid #3b4044; border-radius: 6px;"
            f" gridline-color: #3b4044; }}"
            f"QTableWidget::item {{ padding: 4px 6px; }}"
            f"QTableWidget::item:selected {{ background: #33414a; color: {TEXT}; }}"
            f"QHeaderView::section {{ background: {PANEL_ALT}; color: {MUTED};"
            f" border: none; border-bottom: 1px solid #3b4044; padding: 6px;"
            f" font-weight: 600; }}")
        self.table.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        layout.addWidget(self.table, 1)

        self.counter = label(tr("Маршрут не загружен"), role="muted", size=9, wrap=True)
        layout.addWidget(self.counter)

    # ------------------------------------------------------------------ pieces
    def _call(self, name: str) -> None:
        callback = getattr(self.actions, name, None)
        if callable(callback):
            callback()

    def _import_route(self) -> None:
        self._call("import_route")

    def _export_csv(self) -> None:
        self._call("export_csv")

    def _import_atlas(self) -> None:
        self._call("import_atlas")

    def _clear(self) -> None:
        self._call("clear")

    # ------------------------------------------------------------------ public
    def set_rows(self, rows: Sequence[Sequence]) -> None:
        """Replace the table contents.

        Each row is ``(index, system, status_text, visited_text, status_key)``;
        the last element picks the text colour (see ``ROUTE_STATUS_COLORS``).
        """
        rows = list(rows or ())
        self.table.setRowCount(len(rows))
        for row_index, values in enumerate(rows):
            index, system, status_text, visited_text = list(values)[:4]
            status_key = values[4] if len(values) > 4 else ""
            cells = (str(index), str(system), str(status_text), str(visited_text))
            for column, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if column == 0:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                elif column in (2, 3):
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                color = ROUTE_STATUS_COLORS.get(str(status_key))
                if color:
                    item.setForeground(QBrush(QColor(color)))
                self.table.setItem(row_index, column, item)

    def row_values(self, row: int) -> Tuple[str, ...]:
        """Texts of one row, as the Tk tests used to read them."""
        values = []
        for column in range(self.table.columnCount()):
            item = self.table.item(row, column)
            values.append(item.text() if item is not None else "")
        return tuple(values)

    def row_count(self) -> int:
        return self.table.rowCount()

    def set_counter(self, text: str) -> None:
        self.counter.setText(str(text))

    def counter_text(self) -> str:
        return self.counter.text()


# ===========================================================================
#  Страница «Колонизатор»
# ===========================================================================
#: Колонки таблицы проектов: ключ, заголовок, ширина.
COLONY_COLUMNS = (
    ("primary", "★", 34),
    ("system", "Система", 140),
    ("build", "Стройка", 150),
    ("type", "Тип", 110),
    ("progress", "Прогресс", 130),
    ("buildId", "buildId", 190),
)
#: Поля формы создания проекта: ключ, подпись, тип (``combo`` — выпадающий).
COLONY_FORM_FIELDS = (
    ("systemName", "Система", "text"),
    ("marketId", "Market ID *", "text"),
    ("systemAddress", "System address *", "text"),
    ("buildName", "Название *", "text"),
    ("buildType", "Тип постройки *", "combo"),
    ("maxNeed", "maxNeed (всего)", "text"),
    ("bodyName", "Тело", "body"),
    ("bodyNum", "BodyID тела (авто)", "text"),
    ("architectName", "Архитектор", "text"),
    ("discordLink", "Discord-ссылка", "text"),
)


class RefreshingCombo(QComboBox):
    """Editable combo that refills its list right before the popup opens.

    Replaces the Tk ``postcommand``: the list of bodies is rebuilt from the
    journal each time the user opens the dropdown, so a newly scanned planet
    appears without reopening the page.
    """

    def __init__(self, on_open: _Optional[Callable] = None,
                 parent: _Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setEditable(True)
        self._on_open = on_open

    def showPopup(self) -> None:  # noqa: N802 - Qt API
        if callable(self._on_open):
            self._on_open()
        super().showPopup()


@dataclass
class ColonyPageActions:
    """Callbacks the Coloniser page triggers; every one is optional."""

    refresh: _Optional[Callable] = None
    select: _Optional[Callable] = None
    open_project: _Optional[Callable] = None
    set_primary: _Optional[Callable] = None
    clear_primary: _Optional[Callable] = None
    complete: _Optional[Callable] = None
    copy_id: _Optional[Callable] = None
    bind_site: _Optional[Callable] = None
    unbind_site: _Optional[Callable] = None
    fill_current: _Optional[Callable] = None
    reconcile: _Optional[Callable] = None
    options_changed: _Optional[Callable] = None
    plan_selected: _Optional[Callable] = None
    body_choices: _Optional[Callable] = None
    body_selected: _Optional[Callable] = None
    create: _Optional[Callable] = None
    clear_form: _Optional[Callable] = None
    check_system: _Optional[Callable] = None


class ColonyPage(QWidget):
    """Raven Colonial projects: table, actions and the «create project» form.

    Widget names follow the ones the rest of the program already uses
    (``fields``, ``table``, ``status_label`` …). Form values are read with
    :meth:`value` and written with :meth:`set_value`, so the caller does not
    care whether a field is a text entry or a dropdown.
    """

    def __init__(self, *, cmdr: str = "", autofill: bool = True,
                 open_page_after_create: bool = True,
                 actions: _Optional[ColonyPageActions] = None,
                 parent: _Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.actions = actions or ColonyPageActions()
        self.setObjectName("colonyPage")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.content = QWidget()
        self.layout_ = QVBoxLayout(self.content)
        self.layout_.setContentsMargins(16, 14, 16, 16)
        self.layout_.setSpacing(8)
        self.scroll.setWidget(self.content)
        outer.addWidget(self.scroll)

        self.layout_.addWidget(heading(tr("Колонизатор — проекты Raven Colonial"), size=14))
        self.layout_.addWidget(label(tr(
            "Просмотр своих проектов, назначение основного, завершение стройки и "
            "создание нового проекта. Запись (создание/изменение/завершение) "
            "требует ключа RCC — его выдают на сайте Raven Colonial."),
            role="muted", size=9, wrap=True))

        self._build_top(cmdr)
        self._build_table()
        self._build_actions()
        self._build_create_form(autofill, open_page_after_create)
        self.layout_.addStretch(1)

    # ------------------------------------------------------------------ pieces
    def _call(self, name: str, *args) -> None:
        callback = getattr(self.actions, name, None)
        if callable(callback):
            callback(*args)

    def _divider(self) -> None:
        line = QFrame()
        line.setObjectName("separator")
        line.setFixedHeight(1)
        wrapper = QWidget()
        wrapper_layout = QVBoxLayout(wrapper)
        wrapper_layout.setContentsMargins(0, 12, 0, 12)
        wrapper_layout.addWidget(line)
        self.layout_.addWidget(wrapper)

    def _build_top(self, cmdr: str) -> None:
        self.cmdr_entry = QLineEdit(str(cmdr or ""))
        self.cmdr_entry.setPlaceholderText(tr("Имя командира"))
        self.cmdr_entry.setMinimumHeight(30)
        self.cmdr_entry.setMaximumWidth(280)
        self.refresh_btn = action_button(tr("Обновить список"), self._refresh, height=32)
        self.key_label = label("", role="muted", size=9)
        holder = QWidget()
        holder_layout = QHBoxLayout(holder)
        holder_layout.setContentsMargins(0, 0, 0, 0)
        holder_layout.setSpacing(8)
        holder_layout.addWidget(label(tr("Командир:"), size=9))
        holder_layout.addWidget(self.cmdr_entry)
        holder_layout.addWidget(self.refresh_btn)
        holder_layout.addWidget(self.key_label)
        holder_layout.addStretch(1)
        self.layout_.addWidget(holder)

    def _build_table(self) -> None:
        self.table = QTableWidget(0, len(COLONY_COLUMNS))
        self.table.setObjectName("colonyTable")
        for index, (_key, title, _width) in enumerate(COLONY_COLUMNS):
            item = QTableWidgetItem(column_title(title))
            item.setTextAlignment(
                Qt.AlignmentFlag.AlignVCenter |
                (Qt.AlignmentFlag.AlignCenter if index in (0, 4)
                 else Qt.AlignmentFlag.AlignLeft))
            self.table.setHorizontalHeaderItem(index, item)
            self.table.setColumnWidth(index, _width)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setShowGrid(False)
        self.table.setWordWrap(False)
        header = self.table.horizontalHeader()
        header.setMinimumSectionSize(50)
        header.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.Stretch)
        self.table.setStyleSheet(
            f"QTableWidget {{ background: {PANEL}; color: {TEXT};"
            f" border: 1px solid #3b4044; border-radius: 6px; }}"
            f"QTableWidget::item {{ padding: 4px 6px; }}"
            f"QTableWidget::item:selected {{ background: #33414a; color: {TEXT}; }}"
            f"QHeaderView::section {{ background: {PANEL_ALT}; color: {MUTED};"
            f" border: none; border-bottom: 1px solid #3b4044; padding: 6px;"
            f" font-weight: 600; }}")
        self.table.setMinimumHeight(150)
        self.table.setMaximumHeight(260)
        self.table.itemSelectionChanged.connect(self._selected)
        self.table.cellDoubleClicked.connect(lambda _row, _col: self._call("open_project"))
        self.layout_.addWidget(self.table)

    def _build_actions(self) -> None:
        self.action_buttons: List[QPushButton] = []
        items = (
            (tr("★ Сделать основным"), "set_primary"),
            (tr("Снять основной"), "clear_primary"),
            (tr("Завершить проект"), "complete"),
            (tr("Копировать buildId"), "copy_id"),
            (tr("Открыть в Raven Colonial"), "open_project"),
            (tr("Привязать площадку к проекту"), "bind_site"),
            (tr("Снять привязку площадки"), "unbind_site"),
        )
        holder = QWidget()
        grid = QGridLayout(holder)
        grid.setContentsMargins(0, 6, 0, 0)
        grid.setSpacing(8)
        for index, (text, action) in enumerate(items):
            button = action_button(text, self._action_callback(action),
                                   variant="danger" if action == "complete" else None,
                                   height=30)
            button.setEnabled(False)
            grid.addWidget(button, index // 3, index % 3)
            self.action_buttons.append(button)
        grid.setColumnStretch(2, 1)
        self.layout_.addWidget(holder)

        self.status_label = StatusLabel("", MUTED)
        font = self.status_label.font()
        font.setStyleHint(QFont.StyleHint.Monospace)
        font.setPointSize(9)
        self.status_label.setFont(font)
        self.layout_.addWidget(self.status_label)

    def _action_callback(self, action: str):
        return lambda: self._call(action)

    def _refresh(self) -> None:
        self._call("refresh")

    def _selected(self) -> None:
        self._call("select")

    def _build_create_form(self, autofill: bool, open_page_after_create: bool) -> None:
        self._divider()
        self.layout_.addWidget(label(tr("Создать проект"), size=11, bold=True))

        self.fill_btn = action_button(tr("Заполнить из журнала"), self._fill_current,
                                      variant="primary", height=32)
        self.reconcile_btn = action_button(tr("Сверить стройплощадку с Raven"),
                                           self._reconcile, height=32)
        self.autofill_check = QCheckBox(tr(
            "Заполнять автоматически при посадке на стройплощадку"))
        self.autofill_check.setChecked(bool(autofill))
        self.autofill_check.toggled.connect(lambda _checked: self._call("options_changed"))
        self.open_page_check = QCheckBox(tr("Открывать страницу проекта после создания"))
        self.open_page_check.setChecked(bool(open_page_after_create))
        self.open_page_check.toggled.connect(lambda _checked: self._call("options_changed"))
        self.layout_.addWidget(row(self.fill_btn, self.reconcile_btn, None))
        self.layout_.addWidget(self.autofill_check)
        self.layout_.addWidget(self.open_page_check)

        self.site_label = label(tr(
            "Стройплощадка не найдена — пристыкуйтесь к Construction Ship / площадке."),
            role="muted", size=9, wrap=True)
        self.layout_.addWidget(self.site_label)

        form_holder = QWidget()
        form = QGridLayout(form_holder)
        form.setContentsMargins(0, 4, 0, 0)
        form.setHorizontalSpacing(10)
        form.setVerticalSpacing(6)
        self.fields: Dict[str, QWidget] = {}
        self.entries: Dict[str, QWidget] = self.fields
        for index, (key, title, kind) in enumerate(COLONY_FORM_FIELDS):
            row_index, column = divmod(index, 2)
            form.addWidget(label(tr(title), size=9, wrap=True), row_index, column * 2)
            if kind == "combo":
                widget = QComboBox()
                widget.setMinimumWidth(150)
                widget.setEditable(False)
            elif kind == "body":
                widget = RefreshingCombo(self._refresh_body_choices)
                widget.setMinimumWidth(150)
            else:
                widget = QLineEdit()
                widget.setMinimumWidth(150)
                widget.setMinimumHeight(28)
            self.fields[key] = widget
            form.addWidget(widget, row_index, column * 2 + 1)
            if key == "bodyName":
                self.body_combo = widget
                widget.activated.connect(lambda _index: self._call("body_selected"))
                if widget.lineEdit() is not None:
                    widget.lineEdit().editingFinished.connect(
                        lambda: self._call("body_selected"))
            if key == "bodyNum":
                widget.setReadOnly(True)
        form.setColumnStretch(1, 1)
        form.setColumnStretch(3, 1)
        self.layout_.addWidget(form_holder)

        plan_holder = QWidget()
        plan_layout = QGridLayout(plan_holder)
        plan_layout.setContentsMargins(0, 0, 0, 0)
        plan_layout.setHorizontalSpacing(10)
        plan_layout.setVerticalSpacing(6)
        plan_layout.addWidget(label(tr("План площадки"), size=9), 0, 0)
        self.plan_combo = QComboBox()
        self.plan_combo.setMinimumWidth(150)
        self.plan_combo.addItem(self.plan_none_label())
        self.plan_combo.currentIndexChanged.connect(
            lambda _index: self._call("plan_selected"))
        plan_layout.addWidget(self.plan_combo, 0, 1)
        self.primary_port_check = QCheckBox(tr("Основной порт системы"))
        plan_layout.addWidget(self.primary_port_check, 0, 2, 1, 2)
        plan_layout.setColumnStretch(3, 1)
        self.layout_.addWidget(plan_holder)

        notes_row = QWidget()
        notes = QGridLayout(notes_row)
        notes.setContentsMargins(0, 0, 0, 0)
        notes.setHorizontalSpacing(10)
        notes.setVerticalSpacing(6)
        notes.addWidget(label(tr("Заметки"), size=9), 0, 0)
        self.fields["notes"] = notes_entry = QLineEdit()
        notes_entry.setMinimumHeight(28)
        notes.addWidget(notes_entry, 0, 1, 1, 3)
        notes.addWidget(label("StarPos", size=9), 1, 0)
        self.starpos_entry = QLineEdit()
        self.starpos_entry.setReadOnly(True)
        self.starpos_entry.setMinimumHeight(28)
        notes.addWidget(self.starpos_entry, 1, 1, 1, 3)
        commodities_hint = label(tr("Товары (остаток потребности), "
                                    "формат: aluminium:1200, steel:900"),
                                 size=9, wrap=True)
        commodities_hint.setMaximumWidth(200)
        notes.addWidget(commodities_hint, 2, 0)
        self.commodities_entry = QLineEdit()
        self.commodities_entry.setMinimumHeight(28)
        notes.addWidget(self.commodities_entry, 2, 1, 1, 3)
        notes.setColumnStretch(1, 1)
        notes.setColumnStretch(3, 1)
        self.layout_.addWidget(notes_row)

        self.create_btn = action_button(tr("Создать проект"), self._create,
                                         variant="primary", height=34)
        self.clear_form_btn = action_button(tr("Очистить форму"), self._clear_form, height=34)
        self.check_system_btn = action_button(tr("Проверить площадку в системе"),
                                              self._check_system, height=34)
        self.layout_.addWidget(row(self.create_btn, self.clear_form_btn,
                                   self.check_system_btn, None))

    # ----------------------------------------------------------- form plumbing
    #: Первый пункт списка планов площадки: «создать новый».
    #: Это ключ перевода, а не текст для показа: подпись берётся из
    #: :meth:`plan_none_label`, потому что сравнивать подпись с текстом на
    #: языке интерфейса значило бы сломать выбор плана при смене языка.
    PLAN_NONE_LABEL = "Нет (создать новый план)"

    @classmethod
    def plan_none_label(cls) -> str:
        """Подпись пункта «создать новый план» на текущем языке."""
        return tr(cls.PLAN_NONE_LABEL)

    def _fill_current(self) -> None:
        self._call("fill_current")

    def _reconcile(self) -> None:
        self._call("reconcile")

    def _create(self) -> None:
        self._call("create")

    def _clear_form(self) -> None:
        self._call("clear_form")

    def _check_system(self) -> None:
        self._call("check_system")

    def _refresh_body_choices(self) -> None:
        self._call("body_choices")

    def value(self, key: str) -> str:
        """Current text of a form field, whichever widget it is."""
        widget = self.fields.get(key)
        if widget is None:
            return ""
        if isinstance(widget, QComboBox):
            return widget.currentText()
        return widget.text()

    def set_value(self, key: str, value) -> None:
        widget = self.fields.get(key)
        if widget is None:
            return
        text = "" if value is None else str(value)
        if isinstance(widget, QComboBox):
            position = widget.findText(text)
            if position < 0:
                widget.addItem(text)
                position = widget.count() - 1
            widget.setCurrentIndex(position)
        else:
            widget.setText(text)

    def clear_fields(self) -> None:
        for widget in self.fields.values():
            if isinstance(widget, QComboBox):
                widget.setCurrentIndex(-1)
            else:
                widget.clear()

    def set_combo_values(self, key: str, values: Sequence[str]) -> None:
        widget = self.fields.get(key)
        if not isinstance(widget, QComboBox):
            return
        current = widget.currentText()
        widget.blockSignals(True)
        widget.clear()
        widget.addItems([str(value) for value in values])
        widget.blockSignals(False)
        if current:
            position = widget.findText(current)
            if position >= 0:
                widget.setCurrentIndex(position)

    # ------------------------------------------------------------- public bits
    def cmdr_text(self) -> str:
        return self.cmdr_entry.text()

    def set_cmdr(self, name: str) -> None:
        self.cmdr_entry.setText(str(name or ""))

    def set_status(self, text: str) -> None:
        self.status_label.set_status(text, MUTED)

    def status_text(self) -> str:
        return self.status_label.text()

    def set_key_status(self, text: str, color: _Optional[str] = None) -> None:
        self.key_label.setText(str(text))
        self.key_label.setStyleSheet(f"color:{color};" if color else "")

    def key_text(self) -> str:
        return self.key_label.text()

    def set_site_text(self, text: str, color: _Optional[str] = None) -> None:
        self.site_label.setText(str(text))
        self.site_label.setStyleSheet(f"color:{color};" if color else "")

    def site_text(self) -> str:
        return self.site_label.text()

    def set_actions_enabled(self, enabled: bool) -> None:
        for button in self.action_buttons:
            button.setEnabled(bool(enabled))

    def set_create_enabled(self, enabled: bool) -> None:
        self.create_btn.setEnabled(bool(enabled))

    def set_rows(self, rows: Sequence[Sequence]) -> None:
        """Replace the project list; each row follows ``COLONY_COLUMNS`` order."""
        rows = list(rows or ())
        self.table.setRowCount(len(rows))
        for row_index, values in enumerate(rows):
            for column, value in enumerate(list(values)[:len(COLONY_COLUMNS)]):
                item = QTableWidgetItem("" if value is None else str(value))
                item.setTextAlignment(
                    Qt.AlignmentFlag.AlignVCenter |
                    (Qt.AlignmentFlag.AlignCenter if column in (0, 4)
                     else Qt.AlignmentFlag.AlignLeft))
                # Только выбор: двойной клик открывает проект, а не правит ячейку.
                item.setFlags(Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled)
                self.table.setItem(row_index, column, item)

    def clear_rows(self) -> None:
        self.table.setRowCount(0)

    def row_count(self) -> int:
        return self.table.rowCount()

    def row_values(self, row: int) -> Tuple[str, ...]:
        values = []
        for column in range(self.table.columnCount()):
            item = self.table.item(row, column)
            values.append(item.text() if item is not None else "")
        return tuple(values)

    def selected_values(self) -> _Optional[Tuple[str, ...]]:
        """Texts of the selected project row, or ``None`` when nothing is chosen."""
        rows = sorted({index.row() for index in self.table.selectedIndexes()})
        if not rows:
            return None
        return self.row_values(rows[0])

    def select_row(self, row: int) -> None:
        self.table.selectRow(int(row))

    def plan_labels(self) -> List[str]:
        return [self.plan_combo.itemText(index)
                for index in range(self.plan_combo.count())]

    def set_plan_labels(self, labels: Sequence[str]) -> None:
        """Refill the site-plan dropdown, keeping the current choice if it survives.

        Первый пункт — «создать новый план»; его подпись приходит ключом на
        русском и переводится здесь, чтобы вызывающий код не зависел от языка.
        """
        current = self.plan_combo.currentIndex()
        texts = [self.plan_none_label() if str(value) == self.PLAN_NONE_LABEL
                 else str(value) for value in labels]
        self.plan_combo.blockSignals(True)
        self.plan_combo.clear()
        self.plan_combo.addItems(texts or [self.plan_none_label()])
        self.plan_combo.blockSignals(False)
        self.plan_combo.setCurrentIndex(current if 0 <= current < self.plan_combo.count() else 0)

    def plan_index(self) -> int:
        return self.plan_combo.currentIndex()

    def plan_text(self) -> str:
        return self.plan_combo.currentText()

    def set_plan_text(self, text: str) -> None:
        if str(text) == self.PLAN_NONE_LABEL:
            self.plan_combo.setCurrentIndex(0)
            return
        position = self.plan_combo.findText(str(text))
        if position < 0:
            self.plan_combo.addItem(str(text))
            position = self.plan_combo.count() - 1
        self.plan_combo.setCurrentIndex(position)

    def plan_none_selected(self) -> bool:
        """Выбран ли пункт «создать новый план» (сравнение по индексу, не по тексту)."""
        return self.plan_combo.currentIndex() <= 0

    def set_plan_none(self) -> None:
        """Вернуть список планов к пункту «создать новый план»."""
        if self.plan_combo.count() == 0:
            self.plan_combo.addItem(self.plan_none_label())
        self.plan_combo.setCurrentIndex(0)


# ===========================================================================
#  Страница «Оверлей»
# ===========================================================================
#: Колонки таблицы блоков HUD.
OVERLAY_BLOCK_FIELDS = ("visible", "locked", "screen", "alpha", "font_size",
                        "size", "auto_rule", "hotkey")
#: Ключ значения «блок живёт поверх игры» в колонке «Экран». Это именно ключ, а
#: не подпись: сравнивать текст на языке интерфейса нельзя, поэтому подпись
#: берётся из :func:`screen_with_game_label`, а разбор идёт по цифрам.
OVERLAY_SCREEN_WITH_GAME = "с игрой"


def screen_with_game_label() -> str:
    """Подпись «с игрой» на текущем языке."""
    return tr(OVERLAY_SCREEN_WITH_GAME)


def screen_label(index) -> str:
    """Подпись экрана монитора: «экран N»."""
    return tr("экран {index}", index=index)


@dataclass
class OverlayBlockRow:
    """Одна строка таблицы блоков HUD."""

    key: str
    label: str = ""
    visible: bool = True
    locked: bool = False
    screen: str = OVERLAY_SCREEN_WITH_GAME
    alpha: str = "общая"
    font_size: str = "общий"
    size: str = ""
    auto_rule: str = ""
    hotkey: str = "—"


@dataclass
class OverlayPageState:
    """Everything the page needs for its first paint."""

    alpha: float = 0.90
    font_family: str = "Consolas"
    font_size: int = 10
    font_choices: Sequence[str] = ()
    #: Первое значение — ключ «наследовать общий размер»; подпись берётся при
    #: сборке таблицы, иначе перевод зависел бы от порядка импорта модулей.
    font_size_choices: Sequence[str] = ("общий", "8", "9", "10", "11", "12", "14", "16", "18")
    alpha_choices: Sequence[str] = ()
    hotkey_choices: Sequence[str] = ()
    lock_hotkey_choices: Sequence[str] = ()
    size_labels: Sequence[str] = ()
    rule_labels: Sequence[str] = ()
    rows: Sequence[OverlayBlockRow] = ()
    anchors: Sequence[Tuple[str, str, str, Sequence[str]]] = ()
    screen_choices: Sequence[str] = (OVERLAY_SCREEN_WITH_GAME,)
    screens_text: str = ""
    all_size: str = ""
    lock_hotkey: str = "Ctrl+F12"
    auto_rules: bool = False
    attach_game: bool = True
    idle_choices: Sequence[str] = ()
    idle: str = ""
    ship_blocks: Sequence[Tuple[str, str, bool]] = ()
    ship_modules: str = "important"
    content: Sequence[Tuple[str, str, Sequence[Tuple[str, str, bool]]]] = ()
    carrier_filters: Sequence[Tuple[str, str]] = ()
    carrier_filter: str = ""
    carrier_search: str = ""
    profiles: Sequence[str] = ()
    profile: str = ""
    margin: int = 24
    hide_without_game: bool = True
    info_text: str = ""
    hotkey_hint: str = ""


@dataclass
class OverlayPageActions:
    """Callbacks the Overlay page triggers; every one is optional."""

    toggle: _Optional[Callable] = None
    reset_positions: _Optional[Callable] = None
    alpha_changed: _Optional[Callable] = None
    font_changed: _Optional[Callable] = None
    font_size_changed: _Optional[Callable] = None
    all_size_changed: _Optional[Callable] = None
    block_visible: _Optional[Callable] = None
    block_lock: _Optional[Callable] = None
    block_screen: _Optional[Callable] = None
    block_alpha: _Optional[Callable] = None
    block_font: _Optional[Callable] = None
    block_size: _Optional[Callable] = None
    block_rule: _Optional[Callable] = None
    block_hotkey: _Optional[Callable] = None
    block_reset: _Optional[Callable] = None
    screens_provider: _Optional[Callable] = None
    lock_all: _Optional[Callable] = None
    lock_hotkey_changed: _Optional[Callable] = None
    auto_rules_changed: _Optional[Callable] = None
    attach_game_changed: _Optional[Callable] = None
    idle_changed: _Optional[Callable] = None
    ship_block_changed: _Optional[Callable] = None
    ship_modules_changed: _Optional[Callable] = None
    content_changed: _Optional[Callable] = None
    carrier_filter_changed: _Optional[Callable] = None
    carrier_search_changed: _Optional[Callable] = None
    profile_apply: _Optional[Callable] = None
    profile_save: _Optional[Callable] = None
    profile_delete: _Optional[Callable] = None
    anchor_changed: _Optional[Callable] = None
    apply_anchors: _Optional[Callable] = None
    hide_without_game_changed: _Optional[Callable] = None
    margin_changed: _Optional[Callable] = None


class OverlayPage(QWidget):
    """HUD overlay settings: style, per-block table, behaviour and layout.

    The page owns every control; the application keeps the overlay manager and
    reads values through small typed accessors (`alpha_value()`, `block_value()`
    …) instead of Tk variables.
    """

    #: Ключи перевода для кнопки включения оверлея: подпись берётся из
    #: :meth:`toggle_on_text` / :meth:`toggle_off_text` при отрисовке.
    TOGGLE_ON_TEXT = "▶ Включить оверлей"
    TOGGLE_OFF_TEXT = "⏹ Выключить оверлей"

    @classmethod
    def toggle_on_text(cls) -> str:
        return tr(cls.TOGGLE_ON_TEXT)

    @classmethod
    def toggle_off_text(cls) -> str:
        return tr(cls.TOGGLE_OFF_TEXT)

    def __init__(self, state: OverlayPageState,
                 actions: _Optional[OverlayPageActions] = None,
                 parent: _Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.state = state
        self.actions = actions or OverlayPageActions()
        self.setObjectName("overlayPage")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.content = QWidget()
        self.layout_ = QVBoxLayout(self.content)
        self.layout_.setContentsMargins(16, 14, 16, 16)
        self.layout_.setSpacing(8)
        self.scroll.setWidget(self.content)
        outer.addWidget(self.scroll)

        self._build_header()
        self._build_style()
        self._build_blocks()
        self._build_behaviour()
        self._build_ship()
        self._build_content()
        self._build_layout()
        self._build_hotkeys()
        self.layout_.addStretch(1)

    # ------------------------------------------------------------------ pieces
    def _call(self, name: str, *args) -> None:
        callback = getattr(self.actions, name, None)
        if callable(callback):
            callback(*args)

    def _divider(self, top: int = 14, bottom: int = 14) -> None:
        line = QFrame()
        line.setObjectName("separator")
        line.setFixedHeight(1)
        wrapper = QWidget()
        wrapper_layout = QVBoxLayout(wrapper)
        wrapper_layout.setContentsMargins(0, top, 0, bottom)
        wrapper_layout.addWidget(line)
        self.layout_.addWidget(wrapper)

    def _section(self, text: str) -> QLabel:
        widget = label(text, size=11, bold=True)
        self.layout_.addWidget(widget)
        return widget

    def _hint(self, text: str) -> QLabel:
        widget = label(text, role="muted", size=9, wrap=True)
        self.layout_.addWidget(widget)
        return widget

    @staticmethod
    def _combo(items: Sequence[str], current: str = "",
               width: _Optional[int] = None) -> QComboBox:
        combo = QComboBox()
        # Список не должен задавать ширину колонки по самому длинному пункту:
        # иначе таблица блоков уезжает за край окна.
        combo.setSizeAdjustPolicy(
            QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
        combo.setMinimumContentsLength(8)
        combo.addItems([str(item) for item in items])
        if width:
            combo.setMinimumWidth(width)
        OverlayPage.set_combo_text(combo, current)
        return combo

    @staticmethod
    def set_combo_text(combo: QComboBox, text: str) -> None:
        """Select ``text``; adds it when the list does not contain it yet."""
        text = "" if text is None else str(text)
        position = combo.findText(text)
        blocked = combo.blockSignals(True)
        if position < 0 and text:
            combo.addItem(text)
            position = combo.count() - 1
        combo.setCurrentIndex(position if position >= 0 else 0)
        combo.blockSignals(blocked)

    # -------------------------------------------------------------- sections
    def _build_header(self) -> None:
        self.layout_.addWidget(heading(tr("Настройки оверлея HUD"), size=14))
        self._hint(tr(
            "Оверлей работает поверх Elite Dangerous в режиме Borderless Windowed.\n"
            "Закреплённый блок не мешает мыши — клики уходят в игру. Чтобы подвинуть "
            "блоки или поменять размер, открепите их (Ctrl+F12 или галочки «Закреп.»). "
            "F12 — показать/скрыть."))
        self.toggle_btn = action_button(self.toggle_on_text(), self._toggle, height=34)
        self.reset_btn = action_button(tr("Сбросить позиции"), self._reset_positions,
                                       variant="danger", height=34)
        self.layout_.addWidget(row(self.toggle_btn, self.reset_btn, None))

    def _build_style(self) -> None:
        self.alpha_slider = QSlider(Qt.Orientation.Horizontal)
        self.alpha_slider.setRange(10, 100)
        self.alpha_slider.setMinimumWidth(240)
        self.alpha_slider.setValue(int(round(float(self.state.alpha) * 100)))
        self.alpha_label = label(f"{self.state.alpha:.0%}", size=9)
        self.alpha_slider.valueChanged.connect(self._on_alpha_slider)
        self.layout_.addWidget(row(label(tr("Прозрачность:"), size=9),
                                   self.alpha_slider, self.alpha_label, None))

        self.font_combo = self._combo(self.state.font_choices, self.state.font_family)
        self.font_combo.currentTextChanged.connect(lambda _text: self._call("font_changed"))
        self.layout_.addWidget(row(label(tr("Шрифт:"), size=9), self.font_combo, None))

        self.font_size_slider = QSlider(Qt.Orientation.Horizontal)
        self.font_size_slider.setRange(8, 18)
        self.font_size_slider.setMinimumWidth(240)
        self.font_size_slider.setValue(int(self.state.font_size))
        self.size_label = label(str(self.state.font_size), size=9)
        self.font_size_slider.valueChanged.connect(self._on_font_size_slider)
        self.layout_.addWidget(row(label(tr("Размер шрифта:"), size=9),
                                   self.font_size_slider, self.size_label, None))

    def _on_alpha_slider(self, value: int) -> None:
        self.set_alpha(value / 100.0)
        self._call("alpha_changed", float(value) / 100.0)

    def _on_font_size_slider(self, value: int) -> None:
        self.set_font_size(value)
        self._call("font_size_changed", int(value))

    def _build_blocks(self) -> None:
        self._divider(top=12, bottom=8)
        self._section(tr("Блоки HUD: вид и поведение"))
        self._hint(tr(
            "Каждый блок настраивается отдельно: показывать ли его, закреплён ли он, "
            "на каком экране живёт, своя прозрачность и свой размер шрифта, размер окна "
            "и правило «показывать по ситуации». Закреплённый блок не двигается и "
            "пропускает клики мыши в игру; откреплённый можно тянуть и настраивать. "
            "«Экран»: «с игрой» — блок виден только поверх игры; «экран N» — блок "
            "отвязан от игры, виден всегда и стоит на выбранном мониторе. Всё "
            "применяется сразу — оверлей перезапускать не нужно."))

        self.block_table = QWidget()
        grid = QGridLayout(self.block_table)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(6)
        grid.setVerticalSpacing(4)
        headers = ("Блок", "Показ", "Закреп.", "Экран", "Прозр.", "Шрифт",
                   "Размер", "Показывать", "Клавиша", "")
        for column, text in enumerate(headers):
            header = label(tr(text) if text else text, size=8, bold=True, color=MUTED)
            grid.addWidget(header, 0, column)

        self.block_widgets: Dict[str, Dict[str, QWidget]] = {}
        for row_index, block in enumerate(self.state.rows, start=1):
            grid.addWidget(label(block.label or block.key, size=9), row_index, 0)
            widgets: Dict[str, QWidget] = {}

            check_style = "QCheckBox::indicator { width: 12px; height: 12px; }"
            widgets["visible"] = QCheckBox()
            widgets["visible"].setStyleSheet(check_style)
            widgets["visible"].setChecked(bool(block.visible))
            widgets["visible"].toggled.connect(
                lambda checked, key=block.key: self._call("block_visible", key, bool(checked)))
            grid.addWidget(widgets["visible"], row_index, 1)

            widgets["locked"] = QCheckBox()
            widgets["locked"].setStyleSheet(check_style)
            widgets["locked"].setChecked(bool(block.locked))
            widgets["locked"].toggled.connect(
                lambda checked, key=block.key: self._call("block_lock", key, bool(checked)))
            grid.addWidget(widgets["locked"], row_index, 2)

            widgets["screen"] = self._combo(self.state.screen_choices, block.screen, 84)
            widgets["screen"].currentTextChanged.connect(
                lambda text, key=block.key: self._call("block_screen", key, text))
            grid.addWidget(widgets["screen"], row_index, 3)

            widgets["alpha"] = self._combo(self.state.alpha_choices, block.alpha, 74)
            widgets["alpha"].currentTextChanged.connect(
                lambda text, key=block.key: self._call("block_alpha", key, text))
            grid.addWidget(widgets["alpha"], row_index, 4)

            widgets["font_size"] = self._combo(
                tuple(tr(value) for value in self.state.font_size_choices),
                block.font_size, 66)
            widgets["font_size"].currentTextChanged.connect(
                lambda text, key=block.key: self._call("block_font", key, text))
            grid.addWidget(widgets["font_size"], row_index, 5)

            widgets["size"] = self._combo(self.state.size_labels, block.size, 104)
            widgets["size"].currentTextChanged.connect(
                lambda text, key=block.key: self._call("block_size", key, text))
            grid.addWidget(widgets["size"], row_index, 6)

            widgets["auto_rule"] = self._combo(self.state.rule_labels, block.auto_rule)
            widgets["auto_rule"].currentTextChanged.connect(
                lambda text, key=block.key: self._call("block_rule", key, text))
            grid.addWidget(widgets["auto_rule"], row_index, 7)

            widgets["hotkey"] = self._combo(self.state.hotkey_choices, block.hotkey, 70)
            widgets["hotkey"].currentTextChanged.connect(
                lambda text, key=block.key: self._call("block_hotkey", key, text))
            grid.addWidget(widgets["hotkey"], row_index, 8)

            grid.addWidget(action_button(tr("сброс"), self._block_reset_callback(block.key),
                                         height=26), row_index, 9)
            self.block_widgets[block.key] = widgets
        grid.setColumnStretch(7, 1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(self.block_table)
        scroll.setMinimumHeight(min(260, 70 + 34 * max(1, len(self.state.rows))))
        self.layout_.addWidget(scroll)

        self.screens_label = label(self.state.screens_text, role="muted", size=8, wrap=True)
        self.layout_.addWidget(self.screens_label)

        self.all_size_combo = self._combo(self.state.size_labels, self.state.all_size, 110)
        self.all_size_combo.currentTextChanged.connect(lambda _t: self._call("all_size_changed"))
        self.all_size_btn = action_button(tr("Применить"), self._all_size_apply, height=30)
        self.layout_.addWidget(row(label(tr("Размер всех блоков:"), size=9),
                                   self.all_size_combo, self.all_size_btn, None))

    def _block_reset_callback(self, key: str):
        return lambda: self._call("block_reset", key)

    def _all_size_apply(self) -> None:
        self._call("all_size_changed")

    def _build_behaviour(self) -> None:
        self._divider()
        self._section(tr("Поведение оверлея"))
        self._hint(tr(
            "Закреплённый блок — только для глаз: мышь проходит сквозь него в игру, "
            "сразу после запуска и всегда. Откреплённый блок ловит мышь: его можно "
            "тянуть за шапку, менять размер за угол и открывать меню «···»."))
        self.lock_all_btn = action_button(tr("Закрепить все"),
                                          lambda: self._call("lock_all", True), height=30)
        self.unlock_all_btn = action_button(tr("Открепить все"),
                                            lambda: self._call("lock_all", False), height=30)
        self.lock_hotkey_combo = self._combo(self.state.lock_hotkey_choices,
                                             self.state.lock_hotkey, 110)
        self.lock_hotkey_combo.currentTextChanged.connect(
            lambda _text: self._call("lock_hotkey_changed"))
        self.layout_.addWidget(row(self.lock_all_btn, self.unlock_all_btn,
                                   label(tr("Клавиша:"), size=9), self.lock_hotkey_combo,
                                   label(tr("закрепить/открепить все, даже из игры"),
                                         role="muted", size=9), None))

        self.auto_rules_check = QCheckBox(
            tr("Показывать блоки по ситуации (правила заданы в таблице выше)"))
        self.auto_rules_check.setChecked(bool(self.state.auto_rules))
        self.auto_rules_check.toggled.connect(lambda _c: self._call("auto_rules_changed"))
        self.layout_.addWidget(self.auto_rules_check)

        self.attach_game_check = QCheckBox(tr(
            "Привязать оверлей к окну Elite Dangerous (только поверх игры; "
            "блоки с экраном «экран N» видны всегда)"))
        self.attach_game_check.setChecked(bool(self.state.attach_game))
        self.attach_game_check.toggled.connect(lambda _c: self._call("attach_game_changed"))
        self.layout_.addWidget(self.attach_game_check)

        self.idle_combo = self._combo(self.state.idle_choices, self.state.idle, 110)
        self.idle_combo.currentTextChanged.connect(lambda _t: self._call("idle_changed"))
        self.layout_.addWidget(row(label(tr("Скрывать при простое:"), size=9),
                                   self.idle_combo,
                                   label(tr("простой = нет новых событий в журнале"),
                                         role="muted", size=9), None))

    def _build_ship(self) -> None:
        self._divider(top=12, bottom=8)
        self._section(tr("Блоки корабля (SHIP):"))
        self.ship_widgets: Dict[str, QCheckBox] = {}
        holder = QWidget()
        grid = QGridLayout(holder)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(24)
        grid.setVerticalSpacing(2)
        for index, (key, text, checked) in enumerate(self.state.ship_blocks):
            check = QCheckBox(text)
            check.setChecked(bool(checked))
            check.toggled.connect(
                lambda state, block=key: self._call("ship_block_changed", block, bool(state)))
            grid.addWidget(check, index // 3, index % 3)
            self.ship_widgets[key] = check
        self.layout_.addWidget(holder)

        self._section(tr("Список модулей в SHIP:"))
        self.ship_modules_buttons: Dict[str, QRadioButton] = {}
        modes = (("important", tr("только важные (повреждённые, выключенные, ключевые)")),
                 ("all", tr("все модули")),
                 ("off", tr("только итог — без списка")))
        holder = QWidget()
        holder_layout = QVBoxLayout(holder)
        holder_layout.setContentsMargins(0, 0, 0, 0)
        holder_layout.setSpacing(2)
        for mode, text in modes:
            button = QRadioButton(text)
            button.setChecked(mode == (self.state.ship_modules or "important"))
            button.toggled.connect(
                lambda checked, name=mode: checked and self._call("ship_modules_changed", name))
            holder_layout.addWidget(button)
            self.ship_modules_buttons[mode] = button
        self.layout_.addWidget(holder)

    def _build_content(self) -> None:
        self._divider()
        self._section(tr("Отображаемые данные по оверлеям"))
        self.content_tabs = QTabWidget()
        self.content_widgets: Dict[str, QCheckBox] = {}
        for block_key, block_title, sections in self.state.content:
            tab = QWidget()
            tab_layout = QVBoxLayout(tab)
            tab_layout.setContentsMargins(10, 10, 10, 10)
            tab_layout.setSpacing(4)
            for setting, text, checked in sections:
                check = QCheckBox(text)
                check.setChecked(bool(checked))
                check.toggled.connect(
                    lambda state, name=setting: self._call("content_changed", name, bool(state)))
                tab_layout.addWidget(check)
                self.content_widgets[setting] = check
            if block_key == "ship":
                tab_layout.addWidget(label(tr(
                    "Показатели и режим списка модулей настраиваются выше."),
                    role="muted", size=9, wrap=True))
            if block_key == "carrier":
                labels = [text for _mode, text in self.state.carrier_filters]
                self.carrier_filter_combo = self._combo(labels, self.state.carrier_filter, 240)
                self.carrier_filter_combo.currentTextChanged.connect(
                    lambda _text: self._call("carrier_filter_changed"))
                tab_layout.addWidget(self.carrier_filter_combo)
                tab_layout.addWidget(label(tr("Название товара (применить Enter или кнопкой):"),
                                           size=9))
                self.carrier_search_entry = QLineEdit(self.state.carrier_search)
                self.carrier_search_entry.setMinimumHeight(28)
                self.carrier_search_entry.returnPressed.connect(
                    lambda: self._call("carrier_search_changed"))
                tab_layout.addWidget(self.carrier_search_entry)
                self.carrier_search_btn = action_button(
                    tr("Применить поиск"), lambda: self._call("carrier_search_changed"),
                    height=28)
                tab_layout.addWidget(self.carrier_search_btn)
                tab_layout.addWidget(label(tr(
                    "Фильтр меняет список, но не общие итоги. Без потребности стройки "
                    "режимы материалов и недостачи пусты."), role="muted", size=9, wrap=True))
            self.content_tabs.addTab(tab, block_title)
        self.layout_.addWidget(self.content_tabs)

    def _build_layout(self) -> None:
        self._divider()
        self._section(tr("Раскладка и привязка"))
        self._hint(tr(
            "Блоки прилипают к краям и углам области. Область — весь экран, либо экран с "
            "окном игры, если включена привязка к игре; у блока, отвязанного от игры, — его "
            "собственный экран. Профиль сохраняет всю раскладку (позиции, размеры, "
            "видимость, прозрачность, закрепление, экран) — например «Хаул», "
            "«Экобиология», «Бой»."))

        self.profile_combo = QComboBox()
        self.profile_combo.setEditable(True)
        self.profile_combo.setMinimumWidth(200)
        self.profile_combo.addItems([str(name) for name in self.state.profiles])
        if self.state.profile:
            self.set_combo_text(self.profile_combo, self.state.profile)
        self.profile_apply_btn = action_button(tr("Применить"),
                                               lambda: self._call("profile_apply"), height=30)
        self.profile_save_btn = action_button(tr("Сохранить"),
                                              lambda: self._call("profile_save"), height=30)
        self.profile_delete_btn = action_button(tr("Удалить"),
                                                lambda: self._call("profile_delete"),
                                                variant="danger", height=30)
        self.layout_.addWidget(row(label(tr("Профиль:"), size=9), self.profile_combo,
                                   self.profile_apply_btn, self.profile_save_btn,
                                   self.profile_delete_btn, None))

        self.margin_slider = QSlider(Qt.Orientation.Horizontal)
        self.margin_slider.setRange(0, 120)
        self.margin_slider.setMinimumWidth(240)
        self.margin_slider.setValue(int(self.state.margin))
        self.margin_label = label(f"{int(self.state.margin)} px", size=9)
        self.margin_slider.valueChanged.connect(self._on_margin_slider)
        self.layout_.addWidget(row(label(tr("Отступ от края:"), size=9),
                                   self.margin_slider, self.margin_label, None))

        self._section(tr("Привязка блоков:"))
        self.anchor_widgets: Dict[str, QComboBox] = {}
        holder = QWidget()
        grid = QGridLayout(holder)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(2)
        for index, (key, block_label, current, choices) in enumerate(self.state.anchors):
            grid.addWidget(label(block_label, size=9), index, 0)
            combo = QComboBox()
            combo.addItems([str(item) for item in choices])
            self.set_combo_text(combo, current)
            combo.currentTextChanged.connect(
                lambda text, block=key: self._call("anchor_changed", block, text))
            grid.addWidget(combo, index, 1)
            self.anchor_widgets[key] = combo
        grid.setColumnStretch(1, 1)
        self.layout_.addWidget(holder)

        self.apply_anchors_btn = action_button(tr("Пересчитать по якорям"),
                                               lambda: self._call("apply_anchors"), height=30)
        self.layout_.addWidget(row(self.apply_anchors_btn, self.reset_btn_2(), None))

        self.hide_without_game_check = QCheckBox(tr("Скрывать оверлей, когда игра не запущена"))
        self.hide_without_game_check.setChecked(bool(self.state.hide_without_game))
        self.hide_without_game_check.toggled.connect(
            lambda _c: self._call("hide_without_game_changed"))
        self.layout_.addWidget(self.hide_without_game_check)

        self.info_label = label(self.state.info_text, role="muted", size=9, wrap=True)
        self.layout_.addWidget(self.info_label)

    def reset_btn_2(self) -> QPushButton:
        """Second «сбросить позиции» button; the first one is in the header."""
        return action_button(tr("Сбросить позиции"), self._reset_positions, height=30)

    def _build_hotkeys(self) -> None:
        self._divider()
        self._section(tr("Горячие клавиши"))
        self.hotkey_hint_label = label(self.state.hotkey_hint, role="muted", size=9, wrap=True)
        self.layout_.addWidget(self.hotkey_hint_label)
        self.layout_.addWidget(label(tr(
            "Управление оверлеями:\n"
            "  • UL в шапке — блок откреплён: тяните за заголовок или «::», размер — за угол\n"
            "  • LK в шапке — блок закреплён: не двигается, клики мыши уходят в игру\n"
            "  • Закрепить/открепить все — клавиша из «Поведения оверлея» (Ctrl+F12)\n"
            "  • ··· в шапке — меню: закрепить, отвязать от игры, экран, якорь, размер,\n"
            "    прозрачность, шрифт\n"
            "  • Голубая полоса сверху — блок отвязан от игры и виден всегда\n"
            "  • Клавиши из таблицы выше — показать/скрыть конкретный блок\n"
            "  • F12 — показать/скрыть все блоки, Ctrl+O — включить/выключить оверлей"),
            role="muted", size=9, wrap=True))

    # ------------------------------------------------------------------ actions
    def _toggle(self) -> None:
        self._call("toggle")

    def _reset_positions(self) -> None:
        self._call("reset_positions")

    def _on_margin_slider(self, value: int) -> None:
        self.set_margin(value)
        self._call("margin_changed", int(value))

    # ------------------------------------------------------------------- public
    def alpha_value(self) -> float:
        return self.alpha_slider.value() / 100.0

    def set_alpha(self, value: float) -> None:
        blocked = self.alpha_slider.blockSignals(True)
        self.alpha_slider.setValue(int(round(max(0.1, min(1.0, float(value))) * 100)))
        self.alpha_slider.blockSignals(blocked)
        self.alpha_label.setText(f"{self.alpha_value():.0%}")

    def font_family(self) -> str:
        return self.font_combo.currentText()

    def set_font_family(self, name: str) -> None:
        self.set_combo_text(self.font_combo, name)

    def font_size(self) -> int:
        return int(self.font_size_slider.value())

    def set_font_size(self, value: int) -> None:
        blocked = self.font_size_slider.blockSignals(True)
        self.font_size_slider.setValue(int(value))
        self.font_size_slider.blockSignals(blocked)
        self.size_label.setText(str(int(value)))

    def block_value(self, key: str, field: str):
        """Value of one cell: ``True``/``False`` for checkboxes, text otherwise."""
        widget = self.block_widgets[key][field]
        if isinstance(widget, QCheckBox):
            return widget.isChecked()
        return widget.currentText()

    def set_block_value(self, key: str, field: str, value) -> None:
        widget = self.block_widgets[key][field]
        if isinstance(widget, QCheckBox):
            blocked = widget.blockSignals(True)
            widget.setChecked(bool(value))
            widget.blockSignals(blocked)
        else:
            self.set_combo_text(widget, value)

    def set_screen_choices(self, choices: Sequence[str]) -> None:
        for widgets in self.block_widgets.values():
            combo = widgets["screen"]
            current = combo.currentText()
            blocked = combo.blockSignals(True)
            combo.clear()
            combo.addItems([str(item) for item in choices])
            combo.blockSignals(blocked)
            self.set_combo_text(combo, current)

    def sync_combo_choices(self, field: str, choices: Sequence[str]) -> None:
        """Refresh the list of a per-block column, keeping the current values."""
        for widgets in self.block_widgets.values():
            combo = widgets[field]
            current = combo.currentText()
            blocked = combo.blockSignals(True)
            combo.clear()
            combo.addItems([str(item) for item in choices])
            combo.blockSignals(blocked)
            self.set_combo_text(combo, current)

    def ship_block(self, key: str) -> bool:
        return self.ship_widgets[key].isChecked()

    def ship_modules_view(self) -> str:
        for mode, button in self.ship_modules_buttons.items():
            if button.isChecked():
                return mode
        return "important"

    def set_ship_modules_view(self, mode: str) -> None:
        button = self.ship_modules_buttons.get(str(mode))
        if button is not None:
            blocked = button.blockSignals(True)
            button.setChecked(True)
            button.blockSignals(blocked)

    def content_value(self, setting: str) -> bool:
        return self.content_widgets[setting].isChecked()

    def auto_rules(self) -> bool:
        return self.auto_rules_check.isChecked()

    def set_auto_rules(self, enabled: bool) -> None:
        blocked = self.auto_rules_check.blockSignals(True)
        self.auto_rules_check.setChecked(bool(enabled))
        self.auto_rules_check.blockSignals(blocked)

    def attach_game(self) -> bool:
        return self.attach_game_check.isChecked()

    def set_attach_game(self, enabled: bool) -> None:
        blocked = self.attach_game_check.blockSignals(True)
        self.attach_game_check.setChecked(bool(enabled))
        self.attach_game_check.blockSignals(blocked)

    def hide_without_game(self) -> bool:
        return self.hide_without_game_check.isChecked()

    def idle_text(self) -> str:
        return self.idle_combo.currentText()

    def set_idle_text(self, text: str) -> None:
        self.set_combo_text(self.idle_combo, text)

    def lock_hotkey_text(self) -> str:
        return self.lock_hotkey_combo.currentText()

    def set_lock_hotkey_text(self, text: str) -> None:
        self.set_combo_text(self.lock_hotkey_combo, text)

    def all_size_text(self) -> str:
        return self.all_size_combo.currentText()

    def set_all_size_text(self, text: str) -> None:
        self.set_combo_text(self.all_size_combo, text)

    def profile_text(self) -> str:
        return self.profile_combo.currentText()

    def set_profile_text(self, text: str) -> None:
        self.set_combo_text(self.profile_combo, text)

    def set_profiles(self, names: Sequence[str], selected: str = "") -> None:
        blocked = self.profile_combo.blockSignals(True)
        self.profile_combo.clear()
        self.profile_combo.addItems([str(name) for name in names])
        self.profile_combo.blockSignals(blocked)
        self.set_combo_text(self.profile_combo, selected or self.profile_combo.currentText())

    def profiles(self) -> List[str]:
        return [self.profile_combo.itemText(index)
                for index in range(self.profile_combo.count())]

    def margin_value(self) -> int:
        return int(self.margin_slider.value())

    def set_margin(self, value: int) -> None:
        blocked = self.margin_slider.blockSignals(True)
        self.margin_slider.setValue(int(value))
        self.margin_slider.blockSignals(blocked)
        self.margin_label.setText(f"{int(value)} px")

    def anchor_text(self, key: str) -> str:
        return self.anchor_widgets[key].currentText()

    def set_anchor_text(self, key: str, text: str) -> None:
        self.set_combo_text(self.anchor_widgets[key], text)

    def carrier_filter_text(self) -> str:
        return self.carrier_filter_combo.currentText()

    def set_carrier_filter_text(self, text: str) -> None:
        self.set_combo_text(self.carrier_filter_combo, text)

    def carrier_search_text(self) -> str:
        return self.carrier_search_entry.text()

    def set_carrier_search_text(self, text: str) -> None:
        self.carrier_search_entry.setText(str(text or ""))

    def set_toggle_running(self, running: bool) -> None:
        self.toggle_btn.setText(self.toggle_off_text() if running
                                else self.toggle_on_text())
        self.toggle_btn.setProperty("variant", "danger" if running else "default")
        style = self.toggle_btn.style()
        style.unpolish(self.toggle_btn)
        style.polish(self.toggle_btn)

    def set_screens_text(self, text: str) -> None:
        self.screens_label.setText(str(text))

    def set_info_text(self, text: str) -> None:
        self.info_label.setText(str(text))

    def set_hotkey_hint_text(self, text: str) -> None:
        self.hotkey_hint_label.setText(str(text))


# ===========================================================================
#  Страница «Инфографика пилота»
# ===========================================================================
from PySide6.QtGui import QPainter, QPainterPath, QPen

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
            tr("Живые данные из журнала, трекера корабля, маршрута и текущей сессии. "
               "Сетевых запросов инфографика не делает."), role="muted", size=9, wrap=True))

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
        title = label(tr("ИНФОГРАФИКА ПИЛОТА"), role="mono", size=15, bold=True, color=ORANGE)
        holder_layout.addWidget(title)
        holder_layout.addStretch(1)
        self.updated_label = label("", role="mono", size=9, color=MUTED)
        self.updated_label.setObjectName("pilotUpdated")
        holder_layout.addWidget(self.updated_label)
        self.refresh_button = action_button(tr("Обновить"), self._refresh_clicked, height=30)
        holder_layout.addWidget(self.refresh_button)
        self.compact_check = QCheckBox(tr("Компактный режим"))
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
            ("kpi_tons", tr("ТОННЫ ЗА СЕССИЮ"), GREEN),
            ("kpi_deliveries", tr("ДОСТАВКИ"), CYAN),
            ("kpi_cargo", tr("ГРУЗ"), ORANGE),
            ("kpi_systems", tr("СИСТЕМЫ"), CYAN),
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
        title = label(tr(self.ROW_LABELS.get(key, key)), role="mono", size=9, color=MUTED)
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
        holder_layout.addWidget(label(tr(title), role="mono", size=9, color=MUTED))
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
        card, card_layout = self._tile(tr("ДИНАМИКА СЕССИИ"))
        self.spark = SparklineWidget(color=GREEN, height=64,
                                     empty_text=tr("журнал пока пуст"))
        card_layout.addWidget(self.spark)
        for key in self.ROW_KEYS["session"]:
            card_layout.addWidget(self._row_widget(key))
        card_layout.addStretch(1)
        return card

    def _tile_ship(self) -> QWidget:
        card, card_layout = self._tile(tr("КОРАБЛЬ"))
        card_layout.addWidget(self._row_widget("ship"))
        for key, title in self.BAR_KEYS["ship"]:
            card_layout.addWidget(self._bar_widget(key, title))
        card_layout.addWidget(self._row_widget("modules"))
        card_layout.addStretch(1)
        return card

    def _tile_route(self) -> QWidget:
        card, card_layout = self._tile(tr("МАРШРУТ"))
        card_layout.addWidget(self._row_widget("route_status"))
        for key, title in self.BAR_KEYS["route"]:
            card_layout.addWidget(self._bar_widget(key, title))
        for key in ("route_current", "route_next", "route_remaining", "last_delivery"):
            card_layout.addWidget(self._row_widget(key))
        card_layout.addStretch(1)
        return card

    def _tile_systems(self) -> QWidget:
        card, card_layout = self._tile(tr("ТОП СИСТЕМ ПО ТОННАМ"))
        self.systems_chart = BarsChart(color=CYAN, height=110)
        card_layout.addWidget(self.systems_chart)
        card_layout.addStretch(1)
        return card

    def _tile_status(self) -> QWidget:
        card, card_layout = self._tile(tr("СТАТУС И ПОДКЛЮЧЕНИЯ"))
        for key in self.ROW_KEYS["status"]:
            card_layout.addWidget(self._row_widget(key))
        card_layout.addStretch(1)
        return card

    def _tile_journal(self) -> QWidget:
        card, card_layout = self._tile(tr("ЖУРНАЛЫ И ЭКОНОМИКА"))
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


# ===========================================================================
#  Страница «Экзобиология»
# ===========================================================================
EXOBIO_COLUMNS = (
    ("body", "Тело", 130),
    ("class", "Класс", 120),
    ("atmosphere", "Атмосфера", 150),
    ("landable", "Посадка", 70),
    ("signals", "Биосигналы", 85),
    ("mapped", "Карта DSS", 80),
    ("matched", "Подходит под фильтр", 170),
)


@dataclass
class ExobioPageState:
    """Everything the Exobiology page needs for its first paint."""

    #: Ключ перевода «система не определена»: подпись берётся при сборке
    #: страницы, чтобы перевод не зависел от порядка импорта модулей.
    system: str = "не определена"
    summary: str = ""
    status: str = ""
    genus_choices: Sequence[str] = ()
    selected_genera: Sequence[str] = ()
    show_planets: bool = True
    planet_choices: Sequence[Tuple[str, str]] = ()
    selected_planets: Sequence[str] = ()
    rows: Sequence[Any] = ()
    status_color: str = ""


@dataclass
class ExobioPageActions:
    """Callbacks the Exobiology page triggers; every one is optional."""

    rescan: _Optional[Callable] = None
    scan_all: _Optional[Callable] = None
    filters_changed: _Optional[Callable] = None


class ExobioPage(QWidget):
    """Bodies of the current system, genus and planet-search filters.

    The page owns the controls; the application reads the filter state through
    ``genera()``/``planet_ids()``/``show_planets()`` and writes the table with
    one call to ``set_rows()``.
    """

    def __init__(self, state: ExobioPageState,
                 actions: _Optional[ExobioPageActions] = None,
                 parent: _Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.state = state
        self.actions = actions or ExobioPageActions()
        self.genus_widgets: Dict[str, QCheckBox] = {}
        self.planet_widgets: Dict[str, QCheckBox] = {}
        self._updating = False
        self.setObjectName("exobioPage")

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.content = QWidget()
        self.layout_ = QVBoxLayout(self.content)
        self.layout_.setContentsMargins(18, 16, 18, 16)
        self.layout_.setSpacing(6)
        self.scroll.setWidget(self.content)
        outer.addWidget(self.scroll)

        self._build_header()
        self._build_bodies()
        self._build_genera()
        self._build_planets()
        self.layout_.addStretch(1)
        if state.rows:
            self.set_rows(state.rows)

    # ------------------------------------------------------------------ build
    def _divider(self, top: int = 12, bottom: int = 12) -> None:
        line = QFrame()
        line.setFrameShape(QFrame.Shape.HLine)
        line.setStyleSheet(f"color: {LINE};")
        self.layout_.addSpacing(top)
        self.layout_.addWidget(line)
        self.layout_.addSpacing(bottom)

    def _section(self, text: str) -> None:
        self.layout_.addWidget(heading(text, size=12))

    def _hint(self, text: str) -> None:
        hint = label(text, role="muted", size=9, wrap=True)
        hint.setMaximumWidth(820)
        self.layout_.addWidget(hint)

    def _call(self, name: str, *args) -> None:
        callback = getattr(self.actions, name, None)
        if callable(callback):
            callback(*args)

    def _build_header(self) -> None:
        self.layout_.addWidget(heading(tr("Поиск органики и фильтры оверлея"), size=14))
        self._hint(tr(
            "Тела текущей системы, биосигналы, образцы и фильтры для оверлея EXOBIO. "
            "Если система уже была отсканирована ранее, сканы подтягиваются автоматически "
            "из истории журналов и кэша. Все изменения фильтров применяются сразу."))

        box = panel(QFrame(), "panel")
        box_layout = QVBoxLayout(box)
        box_layout.setContentsMargins(12, 10, 12, 10)
        box_layout.setSpacing(4)

        self.system_label = label(
            tr("Текущая система: {system}",
               system=tr(self.state.system) if self.state.system else tr("не определена")),
            size=11, bold=True, color=CYAN)
        self.rescan_btn = action_button(tr("Сверить с журналами"),
                                        lambda: self._call("rescan"), height=30)
        self.scan_all_btn = action_button(tr("Сканировать все журналы"),
                                          lambda: self._call("scan_all"), height=30)
        box_layout.addWidget(row(self.system_label, None, self.scan_all_btn,
                                 self.rescan_btn, None))

        self.summary_label = label(
            self.state.summary or tr(
                "Тел отсканировано: {bodies} · С биосигналами: {with_signals} · "
                "Всего биосигналов: {signals}", bodies=0, with_signals=0, signals=0),
            role="muted", size=9)
        box_layout.addWidget(self.summary_label)

        self.status_label = label(self.state.status, size=9,
                                  color=self.state.status_color or ORANGE, wrap=True)
        box_layout.addWidget(self.status_label)
        self.layout_.addWidget(box)

    def _build_bodies(self) -> None:
        self._section(tr("Тела текущей системы"))
        self._hint(tr(
            "Отсканированные тела текущей системы: тип, атмосфера, посадка, число "
            "биосигналов и совпадение с выбранными фильтрами поиска."))

        self.table = QTableWidget(0, len(EXOBIO_COLUMNS))
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setAlternatingRowColors(False)
        self.table.setMinimumHeight(170)
        for column, (_key, title, width) in enumerate(EXOBIO_COLUMNS):
            item = QTableWidgetItem(column_title(title))
            item.setTextAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter)
            self.table.setHorizontalHeaderItem(column, item)
            self.table.setColumnWidth(column, width)
        header = self.table.horizontalHeader()
        header.setStretchLastSection(True)
        header.setSectionResizeMode(len(EXOBIO_COLUMNS) - 1, QHeaderView.ResizeMode.Stretch)
        self.table.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.layout_.addWidget(self.table)

    def _build_genera(self) -> None:
        self._divider()
        self._section(tr("Роды в прогнозе"))
        self._hint(tr(
            "Отмеченные роды остаются в списке «Вероятные роды», остальные скрываются. "
            "Если не отмечено ничего — фильтр выключен и показываются все роды."))

        holder = QWidget()
        grid = QGridLayout(holder)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(18)
        grid.setVerticalSpacing(2)
        selected = {str(name) for name in self.state.selected_genera}
        for index, genus in enumerate(self.state.genus_choices):
            check = QCheckBox(str(genus))
            check.setChecked(str(genus) in selected)
            check.setMinimumWidth(180)
            check.toggled.connect(lambda _state: self._on_filters_changed())
            grid.addWidget(check, index // 3, index % 3)
            self.genus_widgets[str(genus)] = check
        grid.setColumnStretch(2, 1)
        self.layout_.addWidget(holder)

        self.all_genera_btn = action_button(tr("Отметить все"),
                                           lambda: self.set_all_genera(True), height=30)
        self.none_genera_btn = action_button(tr("Снять все"),
                                            lambda: self.set_all_genera(False), height=30)
        self.layout_.addWidget(row(self.all_genera_btn, self.none_genera_btn,
                                   label(tr("«Снять все» = показать все роды"),
                                         role="muted", size=9), None))

    def _build_planets(self) -> None:
        self._divider()
        self._section(tr("Поиск планет в системе"))
        self._hint(tr(
            "Отмеченные наборы критериев применяются к отсканированным телам текущей "
            "системы. Подходящие планеты попадают в раздел «Поиск планет» оверлея — "
            "с типом, атмосферой, возможностью посадки и причиной, по которой планета "
            "нашлась. Данные берутся из вашего журнала и кэша."))

        self.show_planets_check = QCheckBox(tr("Показывать раздел «Поиск планет» в оверлее"))
        self.show_planets_check.setChecked(bool(self.state.show_planets))
        self.show_planets_check.toggled.connect(lambda _state: self._on_filters_changed())
        self.layout_.addWidget(self.show_planets_check)

        selected = {str(item) for item in self.state.selected_planets}
        for preset_id, preset_label in self.state.planet_choices:
            check = QCheckBox(tr(str(preset_label)))
            check.setChecked(str(preset_id) in selected)
            check.toggled.connect(lambda _state: self._on_filters_changed())
            self.layout_.addWidget(check)
            self.planet_widgets[str(preset_id)] = check

        self.clear_planets_btn = action_button(tr("Снять все"), self.clear_planets, height=30)
        self.layout_.addWidget(row(
            self.clear_planets_btn,
            label(tr("без отмеченных наборов раздел пишет, что критерии не выбраны"),
                  role="muted", size=9), None))

    # ----------------------------------------------------------------- events
    def _on_filters_changed(self) -> None:
        if self._updating:
            return
        self._call("filters_changed")

    # --------------------------------------------------------------- accessors
    def set_system_text(self, system: str) -> None:
        self.system_label.setText(
            tr("Текущая система: {system}", system=system or tr("не определена")))

    def set_summary_text(self, text: str) -> None:
        self.summary_label.setText(str(text))

    def set_status_text(self, text: str, color: str = "") -> None:
        self.status_label.setText(str(text))
        self.status_label.setStyleSheet(
            f"color: {color or ORANGE}; background: transparent;")

    def set_rows(self, rows: Sequence[Any]) -> None:
        """Replace the body table; a row is a mapping or a 7-tuple in column order."""
        self.table.setRowCount(0)
        self.table.setRowCount(len(rows))
        for index, row_data in enumerate(rows):
            values = [row_data.get(key, "") for key, _title, _width in EXOBIO_COLUMNS] \
                if isinstance(row_data, dict) else list(row_data)
            for column, value in enumerate(values):
                item = QTableWidgetItem(str(value))
                item.setFlags(Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEnabled)
                if column == len(EXOBIO_COLUMNS) - 1 and str(value) not in ("", "—"):
                    item.setForeground(QBrush(QColor(ORANGE)))
                elif column == 4 and str(value) not in ("", "—"):
                    item.setForeground(QBrush(QColor(CYAN)))
                self.table.setItem(index, column, item)

    def row_values(self) -> List[Tuple[str, ...]]:
        rows = []
        for index in range(self.table.rowCount()):
            rows.append(tuple(self.table.item(index, column).text()
                              if self.table.item(index, column) else ""
                              for column in range(self.table.columnCount())))
        return rows

    def genera(self) -> List[str]:
        return [name for name, check in self.genus_widgets.items() if check.isChecked()]

    def genus_checked(self, name: str) -> bool:
        check = self.genus_widgets.get(str(name))
        return bool(check and check.isChecked())

    def set_genera(self, names: Iterable[str]) -> None:
        selected = {str(name) for name in names}
        self._updating = True
        try:
            for name, check in self.genus_widgets.items():
                check.setChecked(name in selected)
        finally:
            self._updating = False

    def set_all_genera(self, value: bool) -> None:
        self._updating = True
        try:
            for check in self.genus_widgets.values():
                check.setChecked(bool(value))
        finally:
            self._updating = False
        self._call("filters_changed")

    def planet_ids(self) -> List[str]:
        return [key for key, check in self.planet_widgets.items() if check.isChecked()]

    def planet_checked(self, preset_id: str) -> bool:
        check = self.planet_widgets.get(str(preset_id))
        return bool(check and check.isChecked())

    def set_planet_ids(self, ids: Iterable[str]) -> None:
        selected = {str(item) for item in ids}
        self._updating = True
        try:
            for key, check in self.planet_widgets.items():
                check.setChecked(key in selected)
        finally:
            self._updating = False

    def clear_planets(self) -> None:
        self._updating = True
        try:
            for check in self.planet_widgets.values():
                check.setChecked(False)
        finally:
            self._updating = False
        self._call("filters_changed")

    def show_planets(self) -> bool:
        return self.show_planets_check.isChecked()

    def set_show_planets(self, value: bool) -> None:
        self._updating = True
        try:
            self.show_planets_check.setChecked(bool(value))
        finally:
            self._updating = False
