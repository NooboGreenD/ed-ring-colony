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
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from ui_qt import (
    MUTED,
    PANEL,
    TEXT,
    action_button,
    heading,
    label,
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
