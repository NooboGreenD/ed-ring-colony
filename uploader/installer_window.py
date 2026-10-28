"""Native Qt setup window for Colonial Helper.

The window is a thin skin over :func:`installer.install_launcher`: it collects
the user's choice (desktop shortcut, install / repair / reinstall), runs the
copy off the GUI thread and reports the outcome. No Tk emulation is involved.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Dict, Optional

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QCheckBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

import bundle
from installer import has_existing_install, install_launcher
from ui_qt import (
    GREEN,
    MUTED,
    PANEL_ALT,
    RED,
    YELLOW,
    FramelessWindow,
    Task,
    action_button,
    describe_error,
    heading,
    label,
)

ACCESS_DENIED_HINT = " Закройте Colonial Helper, затем повторите установку."


class SetupWindow(FramelessWindow):
    """First-run installer with repair and reinstall actions."""

    def __init__(self, source: Path, *, install_root: Optional[Path] = None,
                 installer: Optional[Callable[..., Dict[str, Any]]] = None,
                 parent: Optional[QWidget] = None) -> None:
        super().__init__("ED Ring Colony — Установка Colonial Helper", resizable=False, parent=parent)
        self.source = Path(source)
        self.install_root = Path(install_root or bundle.install_root())
        self.existing_install = has_existing_install(self.install_root)
        self._install = installer or install_launcher
        self.result: Optional[Dict[str, Any]] = None
        self.last_error = ""
        self._task: Optional[Task] = None
        self._build()
        width = 620 if self.existing_install else 580
        self.setFixedSize(width, 470 if self.existing_install else 420)

    # ------------------------------------------------------------------ build
    def _build(self) -> None:
        self.body_layout.setContentsMargins(20, 18, 20, 18)
        self.body_layout.setSpacing(0)
        panel = QWidget()
        panel.setObjectName("panel")
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(26, 0, 26, 18)
        layout.setSpacing(8)

        strip = QFrame()
        strip.setObjectName("accentOrange")
        strip.setFixedHeight(4)
        layout.addWidget(strip)
        layout.addSpacing(14)
        layout.addWidget(label("ED RING COLONY", role="accent", size=10, bold=True))
        layout.addWidget(heading("Colonial Helper", size=24))
        layout.addWidget(label("Лаунчер новостей проекта и инструментов командира",
                               role="muted", size=10))
        layout.addSpacing(10)

        if self.existing_install:
            intro = ("Найдена установленная программа. Восстановление скачает пакет "
                     "с сервера (при сбое — из Setup), переустановка использует версию из Setup.")
            status_text = "Настройки и пользовательские данные сохранятся при обоих действиях."
        else:
            intro = "Установка для текущего пользователя"
            status_text = "Лаунчер будет установлен и запущен после завершения."
        layout.addWidget(label(intro, size=10, bold=True, wrap=True))

        path_label = QLabel(str(self.install_root))
        path_label.setObjectName("installPath")
        self.path_label = path_label
        path_label.setWordWrap(True)
        path_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        path_label.setStyleSheet(
            f"background:{PANEL_ALT}; color:{MUTED}; padding:9px 11px; border-radius:4px;"
            " font-family:Consolas, monospace; font-size:9pt;")
        layout.addWidget(path_label)
        layout.addSpacing(4)

        self.desktop_check = QCheckBox("Создать ярлык на рабочем столе")
        self.desktop_check.setChecked(False)
        layout.addWidget(self.desktop_check)

        self.status = label(status_text, role="muted", size=8, wrap=True)
        layout.addWidget(self.status)
        layout.addStretch(1)
        layout.addWidget(self._actions())
        self.body_layout.addWidget(panel)

    def _actions(self) -> QWidget:
        actions = QWidget()
        layout = QHBoxLayout(actions)
        layout.setContentsMargins(0, 6, 0, 0)
        layout.setSpacing(6)
        if self.existing_install:
            self.repair_button: Optional[QPushButton] = action_button(
                "ВОССТАНОВИТЬ", lambda: self.install(repair=True), height=44)
            self.install_button = action_button(
                "ПЕРЕУСТАНОВИТЬ", lambda: self.install(reinstall=True),
                primary=True, height=44)
            layout.addWidget(self.repair_button, 1)
            layout.addWidget(self.install_button, 1)
        else:
            self.repair_button = None
            self.install_button = action_button(
                "УСТАНОВИТЬ И ЗАПУСТИТЬ", self.install, primary=True, height=44)
            layout.addWidget(self.install_button, 1)
        return actions

    # ---------------------------------------------------------------- actions
    def _buttons(self):
        return [button for button in (self.repair_button, self.install_button)
                if button is not None]

    def install(self, repair: bool = False, reinstall: bool = False) -> None:
        if self._task is not None:
            return
        for button in self._buttons():
            button.setEnabled(False)
        action = "ВОССТАНОВЛЕНИЕ…" if repair else ("ПЕРЕУСТАНОВКА…" if reinstall else "УСТАНОВКА…")
        self.install_button.setText(action)
        self.status.setText("Копируем лаунчер и создаём ярлыки…")
        self.status.setStyleSheet("color:#42b9d4;")

        def work() -> Dict[str, Any]:
            return self._install(
                self.source, install_root=self.install_root,
                desktop_shortcut=self.desktop_check.isChecked(), launch=True,
                repair=repair, reinstall=reinstall)

        task = Task(self)
        self._task = task
        task.start(work, on_done=self._installed, on_error=self._install_failed)

    def _release_buttons(self) -> None:
        self._task = None
        for button in self._buttons():
            button.setEnabled(True)

    def _installed(self, result: Dict[str, Any]) -> None:
        self._task = None
        self.result = result
        self.last_error = ""
        warnings = list(result.get("warnings") or [])
        if warnings:
            detail = "; ".join(str(item) for item in warnings)
            self.status.setText(
                f"Программа установлена и запускается, но ярлык не создан: {detail}")
            self.status.setStyleSheet(f"color:{YELLOW};")
            QTimer.singleShot(3500, self.close)
            return
        self.status.setText("Готово. Colonial Helper запускается…")
        self.status.setStyleSheet(f"color:{GREEN};")
        QTimer.singleShot(800, self.close)

    def _install_failed(self, error: Any) -> None:
        self._release_buttons()
        self.last_error = describe_error(error)
        self.install_button.setText(
            "ПЕРЕУСТАНОВИТЬ" if self.existing_install else "ПОВТОРИТЬ УСТАНОВКУ")
        detail = self.last_error
        if isinstance(error, PermissionError) or getattr(error, "winerror", None) in (5, 32):
            detail += ACCESS_DENIED_HINT
        self.status.setText(f"Не удалось установить лаунчер: {detail}")
        self.status.setStyleSheet(f"color:{RED};")
