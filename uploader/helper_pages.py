"""Native Qt pages for the Colonial Helper main window.

Pages are migrated here one at a time; a page that lives here is built from real
PySide6 widgets and owns its behaviour. Pages that are still on the
compatibility layer are hosted by :class:`helper_shell.HelperShell` unchanged,
so both kinds coexist in one window during the migration.
"""
from __future__ import annotations

from typing import Optional

from PySide6.QtGui import QColor, QFont, QTextCharFormat, QTextCursor
from PySide6.QtWidgets import (
    QHBoxLayout,
    QPlainTextEdit,
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
