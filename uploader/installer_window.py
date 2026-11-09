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
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

import i18n
import launcher_settings
from i18n import tr
from installer import (has_existing_install, install_launcher, install_root_default,
                       validate_install_dir)
from ui_qt import (
    GREEN,
    MUTED,
    PANEL_ALT,
    RED,
    YELLOW,
    FramelessWindow,
    Task,
    action_button,
    ask_directory,
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
        # Язык берём из общего файла настроек: его выбирает лаунчер, и Setup
        # должен говорить на том же языке, что и остальные окна.
        i18n.set_locale(launcher_settings.read_site_locale())
        super().__init__(tr("ED Ring Colony — Установка Colonial Helper"),
                         resizable=False, parent=parent)
        self.source = Path(source)
        self.install_root = Path(install_root or install_root_default())
        self.existing_install = has_existing_install(self.install_root)
        self._install = installer or install_launcher
        self.result: Optional[Dict[str, Any]] = None
        self.last_error = ""
        self._task: Optional[Task] = None
        self._build()
        self._refresh_mode()
        self.setFixedSize(620, 520)

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
        layout.addWidget(label(tr("Лаунчер новостей проекта и инструментов командира"),
                               role="muted", size=10))
        layout.addSpacing(10)

        self.intro_label = label("", size=10, bold=True, wrap=True)
        layout.addWidget(self.intro_label)

        layout.addWidget(label(tr("Папка установки"), role="muted", size=8))
        folder_row = QWidget()
        folder_layout = QHBoxLayout(folder_row)
        folder_layout.setContentsMargins(0, 0, 0, 0)
        folder_layout.setSpacing(6)
        self.path_label = QLineEdit(str(self.install_root))
        self.path_label.setObjectName("installPath")
        self.path_label.setReadOnly(True)
        self.path_label.setStyleSheet(
            f"background:{PANEL_ALT}; color:{MUTED}; padding:9px 11px; border-radius:4px;"
            " font-family:Consolas, monospace; font-size:9pt;")
        self.browse_button = action_button(tr("ИЗМЕНИТЬ…"), self.choose_folder, height=34)
        folder_layout.addWidget(self.path_label, 1)
        folder_layout.addWidget(self.browse_button)
        layout.addWidget(folder_row)
        layout.addWidget(label(
            tr("Можно поставить в любую свою папку — обновления, журналы и настройки "
               "переедут вместе с программой."), role="muted", size=8, wrap=True))
        layout.addSpacing(4)

        self.desktop_check = QCheckBox(tr("Создать ярлык на рабочем столе"))
        self.desktop_check.setChecked(False)
        layout.addWidget(self.desktop_check)

        self.status = label("", role="muted", size=8, wrap=True)
        layout.addWidget(self.status)
        layout.addStretch(1)
        layout.addWidget(self._actions())
        self.body_layout.addWidget(panel)

    def _actions(self) -> QWidget:
        actions = QWidget()
        layout = QHBoxLayout(actions)
        layout.setContentsMargins(0, 6, 0, 0)
        layout.setSpacing(6)
        self.actions_layout = layout
        # Кнопка «Восстановить» нужна только при найденной установке; создаём её
        # по требованию, чтобы в первом запуске окно не показывало лишнего.
        self.repair_button: Optional[QPushButton] = None
        self.remove_button = action_button(tr("УДАЛИТЬ"), self.remove, height=44)
        self.remove_button.setToolTip(
            tr("Полное удаление программы с выбором: ярлыки, журналы, настройки"))
        self.install_button = action_button(
            tr("УСТАНОВИТЬ И ЗАПУСТИТЬ"), self._install_clicked, primary=True, height=44)
        layout.addWidget(self.remove_button, 1)
        layout.addWidget(self.install_button, 1)
        return actions

    def _refresh_mode(self) -> None:
        """Подстроить окно под выбранную папку: первый запуск или обновление."""
        self.existing_install = has_existing_install(self.install_root)
        self.path_label.setText(str(self.install_root))
        if self.existing_install:
            if self.repair_button is None:
                self.repair_button = action_button(
                    tr("ВОССТАНОВИТЬ"), lambda: self.install(repair=True), height=44)
                self.actions_layout.insertWidget(0, self.repair_button, 1)
            self.repair_button.setVisible(True)
            self.remove_button.setVisible(True)
            self.install_button.setText(tr("ПЕРЕУСТАНОВИТЬ"))
            self.intro_label.setText(tr(
                "Найдена установленная программа. Восстановление скачает пакет "
                "с сервера (при сбое — из Setup), переустановка использует версию из Setup."))
            self.status.setText(tr(
                "Настройки и пользовательские данные сохранятся при обоих действиях."))
            return
        if self.repair_button is not None:
            self.repair_button.setParent(None)
            self.repair_button = None
        self.remove_button.setVisible(False)
        self.install_button.setText(tr("УСТАНОВИТЬ И ЗАПУСТИТЬ"))
        self.intro_label.setText(tr("Установка для текущего пользователя"))
        self.status.setText(tr("Лаунчер будет установлен и запущен после завершения."))

    # ------------------------------------------------------------- folder
    def choose_folder(self) -> None:
        """Выбрать папку установки: любая своя папка, но не системная."""
        chosen = ask_directory(
            initialdir=str(self.install_root),
            title=tr("Куда установить Colonial Helper"), parent=self)
        if not chosen:
            return
        reason = validate_install_dir(chosen)
        if reason:
            self.status.setText(reason)
            self.status.setStyleSheet(f"color:{RED};")
            return
        self.install_root = Path(chosen).expanduser()
        self._refresh_mode()
        self.status.setStyleSheet("")
        self.status.setText(tr("Папка установки: {path}", path=str(self.install_root)))

    def _install_clicked(self) -> None:
        # В найденной установке кнопка означает «переустановить из Setup».
        self.install(reinstall=self.existing_install)

    def remove(self) -> None:
        """Открыть окно удаления и, если программа удалена, закрыть Setup."""
        from uninstall_window import UninstallWindow

        window = UninstallWindow(self.install_root, parent=self)
        window.show()
        self._uninstall_window = window
        window.destroyed.connect(self._after_uninstall)
        window.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)

    def _after_uninstall(self, *_args) -> None:
        if not has_existing_install(self.install_root):
            self.close()
            return
        self._refresh_mode()
        self.status.setText(tr("Удаление отменено — программа на месте."))

    # ---------------------------------------------------------------- actions
    def _buttons(self):
        return [button for button in (self.repair_button, self.install_button,
                                      self.remove_button)
                if button is not None]

    def install(self, repair: bool = False, reinstall: bool = False) -> None:
        if self._task is not None:
            return
        for button in self._buttons():
            button.setEnabled(False)
        action = tr("ВОССТАНОВЛЕНИЕ…") if repair else (
            tr("ПЕРЕУСТАНОВКА…") if reinstall else tr("УСТАНОВКА…"))
        self.install_button.setText(action)
        self.status.setText(tr("Копируем лаунчер и создаём ярлыки…"))
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
            self.status.setText(tr(
                "Программа установлена и запускается, но ярлык не создан: {detail}",
                detail=detail))
            self.status.setStyleSheet(f"color:{YELLOW};")
            QTimer.singleShot(3500, self.close)
            return
        self.status.setText(tr("Готово. Colonial Helper запускается…"))
        self.status.setStyleSheet(f"color:{GREEN};")
        QTimer.singleShot(800, self.close)

    def _install_failed(self, error: Any) -> None:
        self._release_buttons()
        self.last_error = describe_error(error)
        self.install_button.setText(
            tr("ПЕРЕУСТАНОВИТЬ") if self.existing_install else tr("ПОВТОРИТЬ УСТАНОВКУ"))
        detail = self.last_error
        if isinstance(error, PermissionError) or getattr(error, "winerror", None) in (5, 32):
            detail += tr(ACCESS_DENIED_HINT)
        self.status.setText(tr("Не удалось установить лаунчер: {detail}", detail=detail))
        self.status.setStyleSheet(f"color:{RED};")
