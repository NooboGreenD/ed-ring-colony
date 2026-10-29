"""Профиль пилота в лаунчере: значок в верхней панели и окно привязки.

В правом верхнем углу лаунчера видно то же имя и аватар, что на сайте. Если
компьютер ещё не привязан, там стоит кнопка привязки: пилот открывает профиль
на сайте, получает код на десять минут и вводит его здесь. Пароль в лаунчере
не спрашивается и не хранится.

Окно привязки заодно даёт кнопки обмена раскладкой оверлея: «Скачать с сайта»
и «Отправить на сайт». Автоматически настройки подтягиваются сразу после
привязки и при запуске — но только если на сайте лежит что-то новее того, что
этот компьютер уже видел.
"""
from __future__ import annotations

import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QPainter, QPainterPath, QPixmap
from PySide6.QtWidgets import QHBoxLayout, QLabel, QLineEdit, QVBoxLayout, QWidget

import launcher_account
from i18n import tr
from locale_config import localized_url
from ui_qt import (
    CYAN,
    GREEN,
    MUTED,
    ORANGE,
    FramelessWindow,
    action_button,
    label,
    open_url,
    run_async,
    separator,
)

AVATAR_SIZE = 38

#: Профиль на сайте: оттуда берётся код привязки и там же отзываются устройства.
PROFILE_PATH = "/account?tab=profile"


def _round_pixmap(source: QPixmap, size: int) -> QPixmap:
    """Круглый аватар: обычная квадратная картинка смотрится в шапке чужой."""
    scaled = source.scaled(
        size, size,
        Qt.AspectRatioMode.KeepAspectRatioByExpanding,
        Qt.TransformationMode.SmoothTransformation,
    )
    target = QPixmap(size, size)
    target.fill(Qt.GlobalColor.transparent)
    painter = QPainter(target)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
    path = QPainterPath()
    path.addEllipse(0, 0, size, size)
    painter.setClipPath(path)
    painter.drawPixmap(0, 0, scaled)
    painter.end()
    return target


def _fetch_avatar(url: str, timeout: float = 10.0) -> bytes:
    request = urllib.request.Request(url, headers={"Accept": "image/*"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(4 * 1024 * 1024)


class ProfileBadge(QWidget):
    """Имя, аватар и кнопка привязки в правом верхнем углу лаунчера."""

    def __init__(self, on_click: Callable[[], None],
                 settings_path: Optional[Path] = None,
                 parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.settings_path = settings_path
        self.account: Dict[str, Any] = launcher_account.read_account(settings_path)
        self._avatar_bytes = b""

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)
        self.avatar = QLabel()
        self.avatar.setFixedSize(AVATAR_SIZE, AVATAR_SIZE)
        self.avatar.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.avatar)

        texts = QWidget()
        texts_layout = QVBoxLayout(texts)
        texts_layout.setContentsMargins(0, 0, 0, 0)
        texts_layout.setSpacing(1)
        self.name_label = label("", size=10, bold=True, color="#f3f4f6")
        self.state_label = label("", size=8, color=MUTED)
        texts_layout.addWidget(self.name_label)
        texts_layout.addWidget(self.state_label)
        layout.addWidget(texts)

        self.action = action_button(tr("Привязать"), on_click, height=30)
        layout.addWidget(self.action)
        self.refresh()
        self.reset_avatar()

    # ------------------------------------------------------------- состояние
    def reload(self) -> None:
        self.account = launcher_account.read_account(self.settings_path)
        self.refresh()

    def refresh(self) -> None:
        linked = bool(self.account.get("token"))
        title = launcher_account.profile_title(self.account)
        if linked:
            self.name_label.setText(title or tr("Профиль пилота"))
            self.state_label.setText(self._state_text())
            self.action.setText(tr("Синхронизация"))
        else:
            self.name_label.setText(tr("Лаунчер не привязан"))
            self.state_label.setText(tr("Код привязки — в профиле на сайте"))
            self.action.setText(tr("Привязать"))
        self.avatar.setToolTip(self.avatar_tooltip())

    def _state_text(self) -> str:
        stamp = launcher_account.synced_at(self.settings_path)
        if stamp:
            return tr("Раскладка синхронизирована · {when}", when=stamp[:16].replace("T", " "))
        return tr("Привязан к сайту · раскладка ещё не переносилась")

    def avatar_tooltip(self) -> str:
        if not self.account.get("token"):
            return tr("Привяжите лаунчер, чтобы переносить раскладку между устройствами")
        return tr("Устройство: {device}", device=launcher_account.device_label(self.account))

    def reset_avatar(self) -> None:
        """Буквы вместо картинки: они есть всегда, даже без сети."""
        title = launcher_account.profile_title(self.account)
        self.avatar.setPixmap(QPixmap())
        self.avatar.setText(launcher_account.initials(title) if title else "?")
        self.avatar.setStyleSheet(
            f"background:{'#243138' if title else '#2a2d30'}; color:{CYAN};"
            f"border-radius:{AVATAR_SIZE // 2}px; font-weight:700;"
        )

    def load_avatar(self) -> None:
        """Подтянуть картинку с сайта в фоне; без неё остаются буквы."""
        url = launcher_account.avatar_url(self.account, launcher_account.site_url(self.settings_path))
        if not url:
            return
        run_async(self, lambda: _fetch_avatar(url),
                  self._avatar_loaded, lambda _error: None)

    def _avatar_loaded(self, raw: bytes) -> None:
        source = QPixmap()
        if not raw or not source.loadFromData(raw) or source.isNull():
            return
        self._avatar_bytes = raw
        self.avatar.setText("")
        self.avatar.setPixmap(_round_pixmap(source, AVATAR_SIZE))
        self.avatar.setStyleSheet("background: transparent;")


class AccountDialog(FramelessWindow):
    """Окно привязки и обмена раскладкой.

    Значок в шапке открывает именно его: здесь же объясняется, что именно
    переносится и чего на сайте не будет (токены EDSM/Inara остаются дома).
    """

    def __init__(self, settings_path: Optional[Path] = None,
                 on_changed: Optional[Callable[[], None]] = None,
                 parent: Optional[QWidget] = None) -> None:
        super().__init__(tr("Профиль лаунчера"), resizable=False, parent=parent)
        self.settings_path = settings_path
        self.on_changed = on_changed
        self._busy = False
        self.setWindowModality(Qt.WindowModality.ApplicationModal)
        self.setMinimumWidth(480)
        self.body_layout.setContentsMargins(22, 16, 22, 20)
        self.body_layout.setSpacing(10)
        self._build()
        self._render()

    # ------------------------------------------------------------------ вид
    def _build(self) -> None:
        self.title_label = label("", size=13, bold=True, color="#f3f4f6")
        self.body_layout.addWidget(self.title_label)
        self.hint_label = label("", role="muted", size=9, wrap=True)
        self.body_layout.addWidget(self.hint_label)

        self.code_row = QWidget()
        code_layout = QHBoxLayout(self.code_row)
        code_layout.setContentsMargins(0, 4, 0, 0)
        code_layout.setSpacing(8)
        self.code_input = QLineEdit()
        self.code_input.setPlaceholderText("ABCD-2345")
        self.code_input.setMaxLength(9)
        self.code_input.setStyleSheet(
            "background:#16191b; border:1px solid #3a3f43; border-radius:6px;"
            "padding:8px 10px; color:#f3f4f6; letter-spacing:3px; font-size:14px;"
        )
        self.code_input.textEdited.connect(self._normalize_code)
        self.code_input.returnPressed.connect(self._link)
        code_layout.addWidget(self.code_input, 1)
        self.link_button = action_button(tr("Привязать"), self._link, primary=True, height=36)
        code_layout.addWidget(self.link_button)
        self.body_layout.addWidget(self.code_row)

        self.manage_row = QWidget()
        manage_layout = QHBoxLayout(self.manage_row)
        manage_layout.setContentsMargins(0, 4, 0, 0)
        manage_layout.setSpacing(8)
        self.pull_button = action_button(tr("Скачать с сайта"), self._pull, height=34)
        self.push_button = action_button(tr("Отправить на сайт"), self._push, height=34)
        self.unlink_button = action_button(tr("Отвязать компьютер"), self._unlink, height=34)
        for button in (self.pull_button, self.push_button, self.unlink_button):
            manage_layout.addWidget(button)
        manage_layout.addStretch(1)
        self.body_layout.addWidget(self.manage_row)

        self.body_layout.addWidget(separator())
        self.status_label = label("", size=9, wrap=True, color=MUTED)
        self.body_layout.addWidget(self.status_label)
        self.site_button = action_button(
            tr("Открыть профиль на сайте ↗"),
            lambda: open_url(localized_url(
                f"{launcher_account.site_url(self.settings_path)}{PROFILE_PATH}",
                self._locale())),
            flat=True)
        self.body_layout.addWidget(self.site_button)

    @staticmethod
    def _locale() -> str:
        try:
            import launcher_settings

            return launcher_settings.read_site_locale()
        except Exception:
            return "ru"

    # ------------------------------------------------------------- состояние
    def _render(self, status: str = "", kind: str = "muted") -> None:
        account = launcher_account.read_account(self.settings_path)
        linked = bool(account.get("token"))
        title = launcher_account.profile_title(account)
        colors = {"muted": MUTED, "ok": GREEN, "warn": ORANGE, "error": "#e27676"}
        if linked:
            self.title_label.setText(title or tr("Профиль пилота"))
            self.hint_label.setText(tr(
                "Компьютер «{device}» привязан к учётной записи. "
                "Между устройствами переносятся профили раскладки оверлея и позиции блоков; "
                "токены EDSM, Inara и Raven остаются на своём компьютере.",
                device=launcher_account.device_label(account)))
        else:
            self.title_label.setText(tr("Привязка лаунчера"))
            self.hint_label.setText(tr(
                "Откройте профиль на сайте, нажмите «Подключить лаунчер» и введите код "
                "из восьми символов. Код живёт десять минут, пароль в лаунчере не нужен."))
        self.code_row.setVisible(not linked)
        self.manage_row.setVisible(linked)
        self.status_label.setText(status or self._idle_status(account))
        self.status_label.setStyleSheet(f"color:{colors.get(kind, MUTED)}; background: transparent;")
        for button in (self.link_button, self.pull_button, self.push_button, self.unlink_button):
            button.setEnabled(not self._busy)
        self.code_input.setEnabled(not self._busy)

    def _idle_status(self, account: Dict[str, Any]) -> str:
        if not account.get("token"):
            return tr("Сайт: {url}", url=launcher_account.site_url(self.settings_path))
        stamp = launcher_account.synced_at(self.settings_path)
        if stamp:
            return tr("Последний обмен: {when}", when=stamp[:16].replace("T", " "))
        return tr("Раскладка ещё не переносилась.")

    # ---------------------------------------------------------------- действия
    def _normalize_code(self, text: str) -> None:
        cleaned = "".join(char for char in str(text).upper() if char.isalnum())
        formatted = f"{cleaned[:4]}-{cleaned[4:8]}" if len(cleaned) > 4 else cleaned
        if formatted != text:
            position = len(formatted)
            self.code_input.setText(formatted)
            self.code_input.setCursorPosition(position)

    def _link(self) -> None:
        if self._busy:
            return
        code = "".join(char for char in self.code_input.text() if char.isalnum())
        if len(code) != 8:
            self._render(tr("Код состоит из восьми символов — проверьте ввод."), "warn")
            return
        self._busy = True
        self._render(tr("Проверяем код на сайте…"), "muted")
        run_async(
            self,
            lambda: launcher_account.link_with_code(code, self.settings_path),
            self._linked,
            self._link_failed,
        )

    def _linked(self, account: Dict[str, Any]) -> None:
        self._busy = False
        self.code_input.clear()
        self._render(tr("Готово: компьютер привязан. Забираем раскладку с сайта…"), "ok")
        self._notify()
        run_async(
            self,
            lambda: launcher_account.auto_pull(self.settings_path, force=True),
            self._pulled_after_link,
            lambda error: self._render(
                tr("Привязка есть, но раскладку забрать не удалось: {error}",
                   error=str(error)), "warn"),
        )

    def _pulled_after_link(self, changed: Optional[int]) -> None:
        if changed:
            self._render(tr("Раскладка перенесена с сайта: {count} настроек.", count=changed), "ok")
        else:
            self._render(tr("На сайте пока нет сохранённой раскладки."), "muted")
        self._notify()

    def _link_failed(self, error: Any) -> None:
        self._busy = False
        self._render(str(error), "error")

    def _pull(self) -> None:
        if self._busy:
            return
        self._busy = True
        self._render(tr("Скачиваем раскладку с сайта…"), "muted")
        run_async(
            self,
            lambda: launcher_account.pull_into_file(self.settings_path),
            self._pulled,
            self._failed,
        )

    def _pulled(self, result: Any) -> None:
        self._busy = False
        changed = int(result[0] if isinstance(result, (tuple, list)) else result or 0)
        self._render(tr("Раскладка обновлена с сайта: {count} настроек.", count=changed), "ok")
        self._notify()

    def _push(self) -> None:
        if self._busy:
            return
        self._busy = True
        self._render(tr("Отправляем раскладку на сайт…"), "muted")
        run_async(
            self,
            lambda: launcher_account.push_from_file(self.settings_path),
            self._pushed,
            self._failed,
        )

    def _pushed(self, updated_at: Any) -> None:
        self._busy = False
        stamp = str(updated_at or "")[:16].replace("T", " ")
        self._render(tr("Раскладка отправлена на сайт ({when}).", when=stamp or "—"), "ok")
        self._notify()

    def _unlink(self) -> None:
        if self._busy:
            return
        from ui_qt import ask_yes_no

        if not ask_yes_no(
            tr("Отвязать компьютер"),
            tr("Лаунчер перестанет переносить раскладку, пока вы снова не введёте код. "
               "Раскладка на сайте останется."),
            parent=self,
        ):
            return
        self._busy = True
        run_async(
            self,
            lambda: launcher_account.unlink(self.settings_path),
            self._unlinked,
            self._failed,
        )

    def _unlinked(self, _result: Any) -> None:
        self._busy = False
        self._render(tr("Компьютер отвязан."), "ok")
        self._notify()

    def _failed(self, error: Any) -> None:
        self._busy = False
        # Текст SyncError уже написан для пилота; прочие исключения читаемы не
        # всегда, поэтому показываем их как есть, но без трейсбека.
        self._render(str(error) or tr("Не удалось выполнить действие."), "error")

    def _notify(self) -> None:
        if self.on_changed is not None:
            try:
                self.on_changed()
            except Exception:
                pass

    # ------------------------------------------------------------------ окно
    def showEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().showEvent(event)
        # Значок в шапке обновляем после того, как окно уже на экране: первый
        # запрос к сайту может занять секунду, и ждать его до показа незачем.
        if launcher_account.is_linked(self.settings_path):
            QTimer.singleShot(50, self._refresh_in_background)

    def _refresh_in_background(self) -> None:
        run_async(self, lambda: launcher_account.refresh_profile(self.settings_path),
                  lambda _account: (self._render(), self._notify()), lambda _error: None)


def open_account_dialog(settings_path: Optional[Path], on_changed: Optional[Callable[[], None]] = None,
                        parent: Optional[QWidget] = None) -> AccountDialog:
    """Открыть окно привязки и вернуть его — окно нужно вызывающему для тестов."""
    dialog = AccountDialog(settings_path, on_changed=on_changed, parent=parent)
    dialog.show()
    return dialog


def site_profile_url(settings_path: Optional[Path] = None, locale: str = "ru") -> str:
    return localized_url(f"{launcher_account.site_url(settings_path)}{PROFILE_PATH}", locale)


__all__ = ["AVATAR_SIZE", "AccountDialog", "ProfileBadge", "open_account_dialog",
           "site_profile_url"]
