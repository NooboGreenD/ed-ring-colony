"""Native Qt start screen for Colonial Helper.

The bootstrapper still owns signed bundles, version selection and rollback; the
window only decides *what the user wants* (launch, update, change language) and
never blocks the GUI thread while doing it.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

import bundle
import bundle_updater
import launcher_content as content
import launcher_settings
from locale_config import DEFAULT_LOCALE, SUPPORTED_LOCALES, localized_url
from site_config import DEFAULT_SITE_URL
from ui_qt import (
    CYAN,
    GREEN,
    MUTED,
    ORANGE,
    RED,
    FramelessWindow,
    Task,
    action_button,
    describe_error,
    center_on_screen,
    heading,
    label,
    open_url,
    run_async,
    separator,
)


def launcher_version() -> str:
    """Version of the frozen launcher without importing a second copy."""
    module = sys.modules.get("__main__")
    if not hasattr(module, "LAUNCHER_VERSION"):
        module = sys.modules.get("launcher")
    return str(getattr(module, "LAUNCHER_VERSION", "1.2.0"))


class LauncherWindow(FramelessWindow):
    """News dashboard and control panel shown before Colonial Helper starts."""

    def __init__(self, install_root: Path, version: str, channel: str, *,
                 settings_path: Optional[Path] = None,
                 fetcher: Optional[Callable[..., Dict[str, List[Dict[str, str]]]]] = None,
                 autostart: bool = True,
                 parent: Optional[QWidget] = None) -> None:
        super().__init__("ED Ring Colony — Colonial Helper", parent=parent)
        self.install_root = Path(install_root)
        self.version = str(version or "—")
        self.channel = str(channel or "stable")
        self.settings_path = launcher_settings.settings_path(settings_path)
        self.site_locale = launcher_settings.read_site_locale(self.settings_path)
        self._fetch = fetcher or self._fetch_from_site
        self.launch_requested = False
        self.feed_data: Dict[str, List[Dict[str, str]]] = {"news": [], "galnet": []}
        self.feed_loaded = False
        self.feed_error = False
        self.current_tab = "news"
        self.update_manifest: Optional[Dict[str, Any]] = None
        self.last_error = ""
        self._busy = False
        self._news_busy = False

        self.setMinimumSize(900, 610)
        self.resize(1120, 730)
        self._build()
        self._render_feed()
        center_on_screen(self)
        if autostart:
            QTimer.singleShot(250, self.refresh_news)
            QTimer.singleShot(450, self.check_updates)

    # ------------------------------------------------------------------ build
    def _build(self) -> None:
        self.body_layout.setContentsMargins(22, 18, 22, 18)
        self.body_layout.setSpacing(14)
        self.body_layout.addWidget(self._header())
        middle = QWidget()
        middle_layout = QHBoxLayout(middle)
        middle_layout.setContentsMargins(0, 0, 0, 0)
        middle_layout.setSpacing(14)
        middle_layout.addWidget(self._sidebar(), 0)
        middle_layout.addWidget(self._feed_panel(), 1)
        self.body_layout.addWidget(middle, 1)
        self.body_layout.addWidget(self._footer())

    def _header(self) -> QWidget:
        header = QWidget()
        header.setObjectName("panelAlt")
        header.setFixedHeight(88)
        layout = QHBoxLayout(header)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(16)
        strip = QFrame()
        strip.setObjectName("accentOrange")
        strip.setFixedWidth(5)
        layout.addWidget(strip)
        identity = QWidget()
        identity_layout = QVBoxLayout(identity)
        identity_layout.setContentsMargins(0, 12, 0, 12)
        identity_layout.setSpacing(1)
        identity_layout.addWidget(label("ED RING COLONY", role="accent", size=9, bold=True))
        identity_layout.addWidget(heading("COLONIAL HELPER", size=20))
        layout.addWidget(identity)
        layout.addStretch(1)
        layout.addWidget(label("DESKTOP COMMAND", role="mono", size=9, bold=True))
        return header

    def _sidebar(self) -> QWidget:
        side = QWidget()
        side.setObjectName("panel")
        side.setFixedWidth(268)
        layout = QVBoxLayout(side)
        layout.setContentsMargins(16, 18, 16, 16)
        layout.setSpacing(8)

        layout.addWidget(label("УПРАВЛЕНИЕ", role="muted", size=9, bold=True))
        self.launch_button = action_button(
            "▶   Запустить Colonial Helper", self.launch, primary=True, height=42)
        layout.addWidget(self.launch_button)
        layout.addSpacing(6)

        layout.addWidget(label("УСТАНОВЛЕННАЯ ВЕРСИЯ", role="muted", size=8, bold=True))
        self.version_label = label(f"v{self.version}", role="mono", size=13, bold=True)
        layout.addWidget(self.version_label)
        self.channel_label = label(f"Канал обновлений: {self.channel}", role="muted", size=9)
        layout.addWidget(self.channel_label)
        layout.addSpacing(4)

        layout.addWidget(label("ЯЗЫК САЙТА И HELPER", role="muted", size=8, bold=True))
        self.locale_combo = QComboBox()
        for code, name in SUPPORTED_LOCALES.items():
            self.locale_combo.addItem(f"{code} — {name}", code)
        self.locale_combo.setCurrentIndex(
            max(0, self.locale_combo.findData(self.site_locale)))
        self.locale_combo.currentIndexChanged.connect(self._on_locale_changed)
        layout.addWidget(self.locale_combo)

        layout.addWidget(separator())
        self.update_status = label("Проверяем обновления…", role="muted", size=9, wrap=True)
        layout.addWidget(self.update_status)
        self.check_button = action_button("Проверить обновления", self.check_updates, height=36)
        layout.addWidget(self.check_button)
        self.install_button = action_button(
            "Установить обновление", self.install_update, primary=True, height=38)
        self.install_button.setEnabled(False)
        layout.addWidget(self.install_button)
        self.update_detail = label(
            "Обновления подписаны и проверяются перед установкой.",
            role="muted", size=8, wrap=True)
        layout.addWidget(self.update_detail)

        layout.addWidget(separator())
        self.site_button = action_button(
            "Открыть сайт проекта ↗",
            lambda: open_url(localized_url(DEFAULT_SITE_URL, self.site_locale)),
            height=36)
        layout.addWidget(self.site_button)
        layout.addWidget(label(
            "Новости загружаются с сайта проекта.\nДля запуска Helper сеть не нужна.",
            role="muted", size=8, wrap=True))
        layout.addStretch(1)
        return side

    def _feed_panel(self) -> QWidget:
        panel = QWidget()
        panel.setObjectName("panel")
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        head = QWidget()
        head_layout = QHBoxLayout(head)
        head_layout.setContentsMargins(20, 16, 16, 8)
        head_layout.setSpacing(10)
        titles = QWidget()
        titles_layout = QVBoxLayout(titles)
        titles_layout.setContentsMargins(0, 0, 0, 0)
        titles_layout.setSpacing(3)
        titles_layout.addWidget(label("СВОДКА ГАЛАКТИКИ", role="accent", size=9, bold=True))
        self.feed_status = label("Подключение к ED Ring Colony…", role="muted", size=8, wrap=True)
        titles_layout.addWidget(self.feed_status)
        head_layout.addWidget(titles, 1)
        self.refresh_button = action_button(
            "↻  Обновить ленту", self.refresh_news, height=32)
        head_layout.addWidget(self.refresh_button, 0, Qt.AlignmentFlag.AlignTop)
        layout.addWidget(head)

        tabs = QWidget()
        tabs_layout = QHBoxLayout(tabs)
        tabs_layout.setContentsMargins(20, 0, 20, 0)
        tabs_layout.setSpacing(0)
        self.tab_buttons: Dict[str, QPushButton] = {}
        for key, title in (("news", "НОВОСТИ ПРОЕКТА"), ("galnet", "GALNET")):
            button = action_button(title, lambda _checked=False, key=key: self._select_tab(key),
                                   variant="tab", height=36)
            button.setCheckable(True)
            button.setAutoExclusive(True)
            tabs_layout.addWidget(button)
            self.tab_buttons[key] = button
        tabs_layout.addStretch(1)
        layout.addWidget(tabs)

        self.feed_area = QScrollArea()
        self.feed_area.setWidgetResizable(True)
        self.feed_area.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.feed_container = QWidget()
        self.feed_container.setObjectName("panel")
        self.feed_layout = QVBoxLayout(self.feed_container)
        self.feed_layout.setContentsMargins(20, 6, 20, 18)
        self.feed_layout.setSpacing(10)
        self.feed_layout.addStretch(1)
        self.feed_area.setWidget(self.feed_container)
        layout.addWidget(self.feed_area, 1)
        self.tab_buttons["news"].setChecked(True)
        return panel

    def _footer(self) -> QWidget:
        footer = QWidget()
        layout = QHBoxLayout(footer)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(label("ED RING COLONY   /   СООБЩЕСТВО ИССЛЕДОВАТЕЛЕЙ ГАЛАКТИКИ",
                               role="mono", size=8, color=MUTED))
        layout.addStretch(1)
        self.connection_indicator = label(
            "●  ОФЛАЙН-ЗАПУСК ДОСТУПЕН", role="mono", size=8, bold=True, color=GREEN)
        layout.addWidget(self.connection_indicator)
        return footer

    # ------------------------------------------------------------------- feed
    def _fetch_from_site(self, locale: Optional[str] = None) -> Dict[str, List[Dict[str, str]]]:
        return content.fetch_home_data(
            locale=locale or self.site_locale,
            user_agent=f"ColonialHelperLauncher/{launcher_version()}")

    def _clear_feed(self) -> None:
        while self.feed_layout.count():
            item = self.feed_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                # Detach right away: deleteLater() alone keeps the old card in
                # the widget tree until the event loop returns.
                widget.setParent(None)
                widget.deleteLater()

    def _render_feed(self) -> None:
        self._clear_feed()
        articles = self.feed_data.get(self.current_tab, [])
        self.feed_layout.addWidget(label(
            self._placeholder_text(len(articles)), role="muted", size=11, wrap=True),
            0, Qt.AlignmentFlag.AlignTop)
        for article in articles:
            self.feed_layout.addWidget(self._article_card(self.current_tab, article), 0)
        self.feed_layout.addStretch(1)

    def _placeholder_text(self, count: int) -> str:
        if count:
            return ""
        if not self.feed_loaded:
            return "Загружаем новости проекта…" if self.current_tab == "news" else "Загружаем Galnet…"
        if self.feed_error:
            return "Лента сейчас недоступна. Проверьте соединение или откройте сайт проекта."
        return "Новых публикаций пока нет."

    def _article_card(self, kind: str, article: Dict[str, str]) -> QWidget:
        card = QFrame()
        card.setObjectName("card")
        card.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Maximum)
        layout = QHBoxLayout(card)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        accent = QFrame()
        accent.setObjectName("accentCyan" if kind == "galnet" else "accentOrange")
        accent.setFixedWidth(4)
        layout.addWidget(accent)

        body = QWidget()
        body_layout = QVBoxLayout(body)
        body_layout.setContentsMargins(16, 12, 16, 12)
        body_layout.setSpacing(4)
        accent_color = CYAN if kind == "galnet" else ORANGE
        body_layout.addWidget(label(content.format_date(article.get("published_at", "")),
                                    role="mono", size=8, bold=True, color=accent_color))
        title = label(article.get("title") or "Без заголовка", size=12, bold=True, wrap=True)
        title.setObjectName("articleTitle")
        body_layout.addWidget(title)
        markup = content.article_html(article.get("body", ""))
        if markup:
            text = QLabel(markup)
            text.setObjectName("articleBody")
            text.setTextFormat(Qt.TextFormat.RichText)
            text.setWordWrap(True)
            text.setStyleSheet(f"color:{MUTED};")
            text.setTextInteractionFlags(
                Qt.TextInteractionFlag.TextSelectableByMouse)
            body_layout.addWidget(text)
        read_more = action_button(
            "Читать на сайте ↗",
            lambda item=article, kind=kind: open_url(content.article_url(kind, item)),
            flat=True)
        read_more.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        body_layout.addWidget(read_more)
        layout.addWidget(body, 1)
        return card

    def _select_tab(self, key: str) -> None:
        if key not in self.tab_buttons:
            return
        self.current_tab = key
        self.tab_buttons[key].setChecked(True)
        self._render_feed()

    def refresh_news(self) -> None:
        if self._news_busy:
            return
        self._news_busy = True
        self.feed_status.setText("Загружаем новости проекта и Galnet…")
        self.feed_status.setStyleSheet(f"color:{MUTED};")
        locale = self.site_locale
        run_async(self, lambda: self._fetch(locale=locale),
                  self._news_loaded, self._news_failed)

    def _news_loaded(self, data: Dict[str, List[Dict[str, str]]]) -> None:
        self._news_busy = False
        self.feed_loaded = True
        self.feed_error = False
        self.last_error = ""
        self.feed_data = data or {"news": [], "galnet": []}
        news = len(self.feed_data.get("news", []))
        galnet = len(self.feed_data.get("galnet", []))
        if news + galnet:
            self.feed_status.setText(f"{news} новостей проекта  ·  {galnet} сообщений Galnet")
        else:
            self.feed_status.setText("Лента пока пуста — загляните на сайт проекта.")
        self.feed_status.setStyleSheet(f"color:{MUTED};")
        self.connection_indicator.setText("●  САЙТ ПОДКЛЮЧЁН")
        self.connection_indicator.setStyleSheet(f"color:{GREEN};")
        self._render_feed()

    def _news_failed(self, error: Any) -> None:
        self._news_busy = False
        self.feed_loaded = True
        self.feed_error = True
        self.last_error = describe_error(error)
        self.feed_data = {"news": [], "galnet": []}
        self.feed_status.setText("Не удалось загрузить ленту. Можно запустить Helper офлайн.")
        self.feed_status.setStyleSheet(f"color:{RED};")
        self.connection_indicator.setText("●  НОВОСТИ НЕДОСТУПНЫ")
        self.connection_indicator.setStyleSheet(f"color:{RED};")
        self._render_feed()

    # --------------------------------------------------------------- language
    def _on_locale_changed(self, _index: int = -1) -> None:
        code = str(self.locale_combo.currentData() or DEFAULT_LOCALE)
        self.site_locale = launcher_settings.save_site_locale(code, self.settings_path)
        self.feed_loaded = False
        self.refresh_news()

    # ---------------------------------------------------------------- updates
    def check_updates(self) -> None:
        if self._busy:
            return
        self._busy = True
        self.check_button.setEnabled(False)
        self.install_button.setEnabled(False)
        self.install_button.setText("Установить обновление")
        self.update_status.setText("Проверяем подписанный манифест…")
        self.update_status.setStyleSheet(f"color:{MUTED};")

        def work() -> Dict[str, Any]:
            state = bundle.load_state(self.install_root)
            current = str(state.get("current") or self.version)
            result = bundle_updater.check_for_update(
                current, channel=self.channel, launcher_version=launcher_version())
            plan = (bundle_updater.plan_update(self.install_root, result["manifest"])
                    if result.get("update_available") else None)
            return {"result": result, "plan": plan}

        run_async(self, work, self._update_checked, self._update_check_failed)

    def _update_check_failed(self, error: Any) -> None:
        self._busy = False
        self.check_button.setEnabled(True)
        self.last_error = describe_error(error)
        self.update_status.setText("Проверка обновлений не удалась.")
        self.update_status.setStyleSheet(f"color:{RED};")
        self.update_detail.setText(self.last_error[:240])

    def _update_checked(self, payload: Dict[str, Any]) -> None:
        self._busy = False
        self.check_button.setEnabled(True)
        result = (payload or {}).get("result") or {}
        plan = (payload or {}).get("plan")
        if not result.get("ok"):
            self.update_status.setText("Обновления сейчас недоступны.")
            self.update_status.setStyleSheet(f"color:{RED};")
            self.update_detail.setText(
                str(result.get("error") or "Нет связи с сервером обновлений.")[:240])
            return
        latest = str(result.get("latest") or self.version)
        if result.get("needs_launcher"):
            self.update_status.setText(f"Для v{latest} нужен новый лаунчер.")
            self.update_status.setStyleSheet(f"color:{ORANGE};")
            self.update_detail.setText(
                "Скачайте актуальный установщик с сайта проекта. Текущая версия Helper сохранена.")
            return
        if result.get("update_available"):
            self.update_manifest = result.get("manifest")
            size = int((plan or {}).get("bytes", 0))
            count = len((plan or {}).get("download", []))
            direction = "Откат канала" if result.get("rollback") else "Доступно обновление"
            self.update_status.setText(f"{direction}: v{latest}")
            self.update_status.setStyleSheet(f"color:{ORANGE};")
            self.update_detail.setText(
                f"К загрузке: {count} файлов · {size / 1024:.0f} КБ. "
                "Пакет будет проверен подписью и хешами.")
            self.install_button.setEnabled(True)
            self.install_button.setText(f"Установить v{latest}")
            return
        self.update_manifest = None
        self.update_status.setText(f"Установлена актуальная версия v{self.version}.")
        self.update_status.setStyleSheet(f"color:{GREEN};")
        self.update_detail.setText("Проверка выполнена по текущему каналу обновлений.")

    def install_update(self) -> None:
        manifest = self.update_manifest
        if not manifest or self._busy:
            return
        self._busy = True
        self.check_button.setEnabled(False)
        self.install_button.setEnabled(False)
        self.install_button.setText("Установка…")
        version = str(manifest.get("version") or "")
        self.update_status.setText(f"Устанавливаем v{version}…")
        self.update_status.setStyleSheet(f"color:{CYAN};")
        task = Task(self)

        def progress(done: int, total: int) -> None:
            task.progress.emit(int(done), int(total))

        task.progress.connect(
            lambda done, total: self.update_status.setText(
                f"Загружаем v{version}… {int(100 * done / max(1, total))}%"))
        task.start(
            lambda: bundle_updater.apply_update(self.install_root, manifest, progress=progress),
            on_done=self._update_installed,
            on_error=lambda error: self._update_installed(
                {"ok": False, "error": describe_error(error), "version": version}))

    def _update_installed(self, result: Dict[str, Any]) -> None:
        self._busy = False
        self.check_button.setEnabled(True)
        if not (result or {}).get("ok"):
            self.install_button.setEnabled(False)
            self.install_button.setText("Установить обновление")
            self.update_status.setText("Не удалось установить обновление.")
            self.update_status.setStyleSheet(f"color:{RED};")
            self.update_detail.setText(str((result or {}).get("error") or "Ошибка установки.")[:240])
            return
        self.version = str(result.get("version") or self.version)
        self.version_label.setText(f"v{self.version}")
        self.update_manifest = None
        self.install_button.setEnabled(False)
        self.install_button.setText("Установлено")
        self.update_status.setText(f"Версия v{self.version} установлена.")
        self.update_status.setStyleSheet(f"color:{GREEN};")
        self.update_detail.setText(
            "Запустите Colonial Helper. Если новая версия не откроется, "
            "лаунчер автоматически откатится.")

    # ----------------------------------------------------------------- window
    def launch(self) -> None:
        self.launch_requested = True
        self.close()
