"""Окно удаления Colonial Helper: галочки «что удалить» и один шаг подтверждения.

Логика лежит в :mod:`uninstall` — это окно только собирает выбор и показывает
итог. Так удаление проверяется тестами без экрана, а окно остаётся тонким.
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
import i18n
import launcher_settings
from i18n import tr
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

from uninstall import build_plan, directory_size, execute, looks_like_install


def _human_size(value: int) -> str:
    """Размер в единицах, понятных без таблицы: 0 Б, 12,4 МБ, 1,2 ГБ."""
    size = max(0, int(value or 0))
    units = (tr("Б"), tr("КБ"), tr("МБ"), tr("ГБ"))
    index = 0
    scaled = float(size)
    while scaled >= 1024 and index < len(units) - 1:
        scaled /= 1024
        index += 1
    digits = 0 if index == 0 or scaled >= 100 else 1
    return f"{scaled:.{digits}f}".replace(".", ",") + f" {units[index]}"


class UninstallWindow(FramelessWindow):
    """Удаление программы с выбором: ярлыки, журналы, настройки."""

    def __init__(self, install_root: Optional[Path] = None, *,
                 uninstaller: Optional[Callable[..., Dict[str, Any]]] = None,
                 planner: Optional[Callable[..., Any]] = None,
                 parent: Optional[QWidget] = None) -> None:
        i18n.set_locale(launcher_settings.read_site_locale())
        super().__init__(tr("Удаление Colonial Helper"), resizable=False, parent=parent)
        self.install_root = Path(install_root or bundle.install_root()).expanduser()
        self._uninstall = uninstaller or execute
        self._plan = planner or build_plan
        self.result: Optional[Dict[str, Any]] = None
        self.last_error = ""
        self._task: Optional[Task] = None
        self._build()
        self.setFixedSize(620, 470)

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
        layout.addWidget(heading(tr("Удаление программы"), size=22))
        layout.addWidget(label(tr("Colonial Helper будет удалён с этого компьютера."),
                               role="muted", size=10))
        layout.addSpacing(10)

        path_label = QLabel(str(self.install_root))
        path_label.setObjectName("installPath")
        path_label.setWordWrap(True)
        path_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        path_label.setStyleSheet(
            f"background:{PANEL_ALT}; color:{MUTED}; padding:9px 11px; border-radius:4px;"
            " font-family:Consolas, monospace; font-size:9pt;")
        layout.addWidget(path_label)

        installed = looks_like_install(self.install_root)
        self.shortcuts_check = QCheckBox(tr("Ярлыки и запись в списке установленных программ"))
        self.shortcuts_check.setChecked(True)
        self.logs_check = QCheckBox(tr("Журналы, кэш и загруженные версии программы"))
        self.logs_check.setChecked(True)
        self.settings_check = QCheckBox(tr("Настройки, вход на сайт и привязка устройства"))
        self.settings_check.setChecked(False)
        for box in (self.shortcuts_check, self.logs_check, self.settings_check):
            box.setEnabled(installed)
            layout.addWidget(box)

        self.settings_hint = label(
            tr("Без настроек вход и привязка устройства исчезнут — при следующей "
               "установке понадобится войти заново."), role="muted", size=8, wrap=True)
        layout.addWidget(self.settings_hint)

        self.size_label = label("", role="muted", size=8, wrap=True)
        layout.addWidget(self.size_label)
        self.status = label(
            tr("Удаление нельзя отменить.") if installed
            else tr("В этой папке нет установленной программы."),
            role="muted", size=8, wrap=True)
        layout.addWidget(self.status)
        layout.addStretch(1)
        layout.addWidget(self._actions(installed))
        self._refresh_size()
        self.settings_check.toggled.connect(self._refresh_size)
        self.body_layout.addWidget(panel)

    def _actions(self, installed: bool) -> QWidget:
        actions = QWidget()
        layout = QHBoxLayout(actions)
        layout.setContentsMargins(0, 6, 0, 0)
        layout.setSpacing(6)
        self.cancel_button = action_button(tr("ОТМЕНА"), self.close, height=44)
        self.remove_button = action_button(
            tr("УДАЛИТЬ"), self.remove, primary=True, height=44)
        self.remove_button.setEnabled(installed)
        layout.addWidget(self.cancel_button, 1)
        layout.addWidget(self.remove_button, 1)
        return actions

    def _refresh_size(self) -> None:
        size = directory_size(self.install_root)
        if self.settings_check.isChecked():
            size += 4096
        if size:
            self.size_label.setText(tr("Будет освобождено: {size}", size=_human_size(size)))
        else:
            self.size_label.setText("")

    # ---------------------------------------------------------------- actions
    def plan(self):
        return self._plan(
            self.install_root,
            keep_settings=not self.settings_check.isChecked(),
            remove_shortcuts=self.shortcuts_check.isChecked(),
            remove_registry=self.shortcuts_check.isChecked(),
        )

    def remove(self) -> None:
        if self._task is not None:
            return
        plan = self.plan()
        if not plan.ok:
            self.status.setText("; ".join(plan.problems))
            self.status.setStyleSheet(f"color:{RED};")
            return
        self.remove_button.setEnabled(False)
        self.cancel_button.setEnabled(False)
        self.remove_button.setText(tr("УДАЛЯЕМ…"))
        self.status.setText(tr("Удаляем файлы программы…"))
        self.status.setStyleSheet("color:#42b9d4;")

        uninstall = self._uninstall

        def work() -> Dict[str, Any]:
            return uninstall(plan)

        task = Task(self)
        self._task = task
        task.start(work, on_done=self._removed, on_error=self._failed)

    def _removed(self, result: Dict[str, Any]) -> None:
        self._task = None
        self.result = result
        self.last_error = ""
        failed = list(result.get("failed") or [])
        warnings = [item for item in (result.get("warnings") or []) if item]
        if failed or warnings:
            detail = "; ".join(warnings + failed)
            self.last_error = detail
            self.status.setText(tr("Удалено не всё: {detail}", detail=detail))
            self.status.setStyleSheet(f"color:{YELLOW};")
            self.remove_button.setText(tr("ПОВТОРИТЬ"))
            self.remove_button.setEnabled(True)
            self.cancel_button.setEnabled(True)
            return
        if result.get("deferred"):
            self.status.setText(
                tr("Программа удалена. Часть файлов занята запущенным процессом — "
                   "они исчезнут в течение нескольких секунд."))
        else:
            self.status.setText(tr("Готово: Colonial Helper удалён с компьютера."))
        self.status.setStyleSheet(f"color:{GREEN};")
        QTimer.singleShot(1200, self.close)

    def _failed(self, error: Any) -> None:
        self._task = None
        self.last_error = describe_error(error)
        self.remove_button.setText(tr("ПОВТОРИТЬ"))
        self.remove_button.setEnabled(True)
        self.cancel_button.setEnabled(True)
        self.status.setText(tr("Не удалось удалить: {detail}", detail=self.last_error))
        self.status.setStyleSheet(f"color:{RED};")
