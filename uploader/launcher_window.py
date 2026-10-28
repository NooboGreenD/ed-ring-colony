"""Native Qt start screen for Colonial Helper.

The bootstrapper still owns signed bundles, version selection and rollback; the
window only decides *what the user wants* (launch, update, change language) and
never blocks the GUI thread while doing it.

Every visible string goes through :func:`i18n.tr`, and the chosen language is
applied to the whole window at once: ``_retranslate()`` rewrites the labels,
the buttons, the feed and the status lines from the stored state, so switching
the language does not require a restart and cannot leave a half-translated
window behind.
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
import i18n
import launcher_content as content
import launcher_settings
from i18n import tr
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
        # Язык нужен до первой строки: заголовок окна тоже переводится.
        settings = launcher_settings.settings_path(settings_path)
        locale = launcher_settings.read_site_locale(settings)
        i18n.set_locale(locale)
        super().__init__(tr("ED Ring Colony — Colonial Helper"), parent=parent)
        self.install_root = Path(install_root)
        self.version = str(version or "—")
        self.channel = str(channel or "stable")
        self.settings_path = settings
        self.site_locale = locale
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
        # Состояние, из которого перерисовываются подписи: при смене языка
        # текст берётся отсюда, а не из старых виджетов.
        self._feed_state: Dict[str, Any] = {"kind": "idle", "news": 0, "galnet": 0}
        self._connection_state = "offline"
        self._update_state: Dict[str, Any] = {"kind": "idle"}

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

        self.control_label = label(tr("УПРАВЛЕНИЕ"), role="muted", size=9, bold=True)
        layout.addWidget(self.control_label)
        self.launch_button = action_button(
            tr("▶   Запустить Colonial Helper"), self.launch, primary=True, height=42)
        layout.addWidget(self.launch_button)
        layout.addSpacing(6)

        self.installed_label = label(tr("УСТАНОВЛЕННАЯ ВЕРСИЯ"), role="muted", size=8, bold=True)
        layout.addWidget(self.installed_label)
        self.version_label = label(f"v{self.version}", role="mono", size=13, bold=True)
        layout.addWidget(self.version_label)
        self.channel_label = label(
            tr("Канал обновлений: {channel}", channel=self.channel), role="muted", size=9)
        layout.addWidget(self.channel_label)
        layout.addSpacing(4)

        self.locale_label = label(tr("ЯЗЫК ИНТЕРФЕЙСА И САЙТА"),
                                  role="muted", size=8, bold=True)
        layout.addWidget(self.locale_label)
        self.locale_combo = QComboBox()
        for code, name in SUPPORTED_LOCALES.items():
            self.locale_combo.addItem(f"{code} — {name}", code)
        self.locale_combo.setCurrentIndex(
            max(0, self.locale_combo.findData(self.site_locale)))
        self.locale_combo.currentIndexChanged.connect(self._on_locale_changed)
        layout.addWidget(self.locale_combo)

        layout.addWidget(separator())
        self.update_status = label(tr("Проверяем обновления…"), role="muted", size=9, wrap=True)
        layout.addWidget(self.update_status)
        self.check_button = action_button(tr("Проверить обновления"), self.check_updates, height=36)
        layout.addWidget(self.check_button)
        self.install_button = action_button(
            tr("Установить обновление"), self.install_update, primary=True, height=38)
        self.install_button.setEnabled(False)
        layout.addWidget(self.install_button)
        self.update_detail = label(
            tr("Обновления подписаны и проверяются перед установкой."),
            role="muted", size=8, wrap=True)
        layout.addWidget(self.update_detail)

        layout.addWidget(separator())
        self.site_button = action_button(
            tr("Открыть сайт проекта ↗"),
            lambda: open_url(localized_url(DEFAULT_SITE_URL, self.site_locale)),
            height=36)
        layout.addWidget(self.site_button)
        self.sidebar_hint = label(
            tr("Новости загружаются с сайта проекта.\nДля запуска Helper сеть не нужна."),
            role="muted", size=8, wrap=True)
        layout.addWidget(self.sidebar_hint)
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
        self.feed_title = label(tr("СВОДКА ГАЛАКТИКИ"), role="accent", size=9, bold=True)
        titles_layout.addWidget(self.feed_title)
        self.feed_status = label(tr("Подключение к ED Ring Colony…"),
                                 role="muted", size=8, wrap=True)
        titles_layout.addWidget(self.feed_status)
        head_layout.addWidget(titles, 1)
        self.refresh_button = action_button(
            tr("↻  Обновить ленту"), self.refresh_news, height=32)
        head_layout.addWidget(self.refresh_button, 0, Qt.AlignmentFlag.AlignTop)
        layout.addWidget(head)

        tabs = QWidget()
        tabs_layout = QHBoxLayout(tabs)
        tabs_layout.setContentsMargins(20, 0, 20, 0)
        tabs_layout.setSpacing(0)
        self.tab_buttons: Dict[str, QPushButton] = {}
        for key in ("news", "galnet"):
            button = action_button(self._tab_title(key),
                                   lambda _checked=False, key=key: self._select_tab(key),
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
        self.footer_label = label(
            tr("ED RING COLONY   /   СООБЩЕСТВО ИССЛЕДОВАТЕЛЕЙ ГАЛАКТИКИ"),
            role="mono", size=8, color=MUTED)
        layout.addWidget(self.footer_label)
        layout.addStretch(1)
        self.connection_indicator = label(
            self._connection_text(), role="mono", size=8, bold=True, color=GREEN)
        layout.addWidget(self.connection_indicator)
        return footer

    # ------------------------------------------------------------- переводы
    @staticmethod
    def _tab_title(key: str) -> str:
        return tr("НОВОСТИ ПРОЕКТА") if key == "news" else "GALNET"

    def _connection_text(self) -> str:
        if self._connection_state == "online":
            return tr("●  САЙТ ПОДКЛЮЧЁН")
        if self._connection_state == "unavailable":
            return tr("●  НОВОСТИ НЕДОСТУПНЫ")
        return tr("●  ОФЛАЙН-ЗАПУСК ДОСТУПЕН")

    def _feed_status_text(self) -> str:
        kind = self._feed_state.get("kind")
        news = int(self._feed_state.get("news") or 0)
        galnet = int(self._feed_state.get("galnet") or 0)
        if kind == "loading":
            return tr("Загружаем новости проекта и Galnet…")
        if kind == "error":
            return tr("Не удалось загрузить ленту. Можно запустить Helper офлайн.")
        if kind == "loaded":
            if news + galnet:
                return tr("{news} новостей проекта  ·  {galnet} сообщений Galnet",
                          news=news, galnet=galnet)
            return tr("Лента пока пуста — загляните на сайт проекта.")
        return tr("Подключение к ED Ring Colony…")

    def _retranslate(self) -> None:
        """Перерисовать все подписи окна на текущем языке."""
        self.setWindowTitle(tr("ED Ring Colony — Colonial Helper"))
        self.control_label.setText(tr("УПРАВЛЕНИЕ"))
        self.launch_button.setText(tr("▶   Запустить Colonial Helper"))
        self.installed_label.setText(tr("УСТАНОВЛЕННАЯ ВЕРСИЯ"))
        self.channel_label.setText(tr("Канал обновлений: {channel}", channel=self.channel))
        self.locale_label.setText(tr("ЯЗЫК ИНТЕРФЕЙСА И САЙТА"))
        self.site_button.setText(tr("Открыть сайт проекта ↗"))
        self.sidebar_hint.setText(
            tr("Новости загружаются с сайта проекта.\nДля запуска Helper сеть не нужна."))
        self.feed_title.setText(tr("СВОДКА ГАЛАКТИКИ"))
        self.refresh_button.setText(tr("↻  Обновить ленту"))
        for key, button in self.tab_buttons.items():
            button.setText(self._tab_title(key))
        self.footer_label.setText(
            tr("ED RING COLONY   /   СООБЩЕСТВО ИССЛЕДОВАТЕЛЕЙ ГАЛАКТИКИ"))
        self.feed_status.setText(self._feed_status_text())
        self.connection_indicator.setText(self._connection_text())
        self._render_update_state()
        self._render_feed()

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
            return tr("Загружаем новости проекта…") if self.current_tab == "news" else tr("Загружаем Galnet…")
        if self.feed_error:
            return tr("Лента сейчас недоступна. Проверьте соединение или откройте сайт проекта.")
        return tr("Новых публикаций пока нет.")

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
        title = label(article.get("title") or tr("Без заголовка"), size=12, bold=True, wrap=True)
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
            tr("Читать на сайте ↗"),
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
        self._feed_state = {"kind": "loading", "news": 0, "galnet": 0}
        self.feed_status.setText(self._feed_status_text())
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
        self._feed_state = {"kind": "loaded", "news": news, "galnet": galnet}
        self._connection_state = "online"
        self.feed_status.setText(self._feed_status_text())
        self.feed_status.setStyleSheet(f"color:{MUTED};")
        self.connection_indicator.setText(self._connection_text())
        self.connection_indicator.setStyleSheet(f"color:{GREEN};")
        self._render_feed()

    def _news_failed(self, error: Any) -> None:
        self._news_busy = False
        self.feed_loaded = True
        self.feed_error = True
        self.last_error = describe_error(error)
        self.feed_data = {"news": [], "galnet": []}
        self._feed_state = {"kind": "error", "news": 0, "galnet": 0}
        self._connection_state = "unavailable"
        self.feed_status.setText(self._feed_status_text())
        self.feed_status.setStyleSheet(f"color:{RED};")
        self.connection_indicator.setText(self._connection_text())
        self.connection_indicator.setStyleSheet(f"color:{RED};")
        self._render_feed()

    # --------------------------------------------------------------- language
    def _on_locale_changed(self, _index: int = -1) -> None:
        code = str(self.locale_combo.currentData() or DEFAULT_LOCALE)
        self.site_locale = launcher_settings.save_site_locale(code, self.settings_path)
        i18n.set_locale(self.site_locale)
        self._retranslate()
        self.feed_loaded = False
        self._feed_state = {"kind": "idle", "news": 0, "galnet": 0}
        self.refresh_news()

    # ---------------------------------------------------------------- updates
    def _render_update_state(self) -> None:
        """Показать состояние обновлений так, как его видит пользователь."""
        state = self._update_state
        kind = state.get("kind")
        version = state.get("version") or self.version
        if kind == "checking":
            self.update_status.setText(tr("Проверяем подписанный манифест…"))
            self.update_status.setStyleSheet(f"color:{MUTED};")
            self.update_detail.setText(tr("Обновления подписаны и проверяются перед установкой."))
            return
        if kind == "failed":
            self.update_status.setText(tr("Проверка обновлений не удалась."))
            self.update_status.setStyleSheet(f"color:{RED};")
            self.update_detail.setText(str(state.get("detail") or self.last_error)[:240])
            return
        if kind == "unavailable":
            self.update_status.setText(tr("Обновления сейчас недоступны."))
            self.update_status.setStyleSheet(f"color:{RED};")
            self.update_detail.setText(
                str(state.get("detail") or tr("Нет связи с сервером обновлений."))[:240])
            return
        if kind == "needs_launcher":
            self.update_status.setText(tr("Для v{version} нужен новый лаунчер.", version=version))
            self.update_status.setStyleSheet(f"color:{ORANGE};")
            self.update_detail.setText(
                tr("Скачайте актуальный установщик с сайта проекта. "
                   "Текущая версия Helper сохранена."))
            return
        if kind == "available":
            template = ("Откат канала: v{version}" if state.get("rollback")
                        else "Доступно обновление: v{version}")
            self.update_status.setText(tr(template, version=version))
            self.update_status.setStyleSheet(f"color:{ORANGE};")
            self.update_detail.setText(tr(
                "К загрузке: {count} файлов · {size} КБ. "
                "Пакет будет проверен подписью и хешами.",
                count=int(state.get("count") or 0), size=int(state.get("size") or 0)))
            self.install_button.setEnabled(True)
            self.install_button.setText(tr("Установить v{version}", version=version))
            return
        if kind == "current":
            self.update_status.setText(
                tr("Установлена актуальная версия v{version}.", version=version))
            self.update_status.setStyleSheet(f"color:{GREEN};")
            self.update_detail.setText(tr("Проверка выполнена по текущему каналу обновлений."))
            return
        if kind == "installing":
            self.install_button.setText(tr("Установка…"))
            self.update_status.setText(tr("Устанавливаем v{version}…", version=version))
            self.update_status.setStyleSheet(f"color:{CYAN};")
            return
        if kind == "progress":
            self.update_status.setText(tr("Загружаем v{version}… {percent}%",
                                          version=version, percent=int(state.get("percent") or 0)))
            return
        if kind == "installed":
            self.install_button.setEnabled(False)
            self.install_button.setText(tr("Установлено"))
            self.update_status.setText(tr("Версия v{version} установлена.", version=version))
            self.update_status.setStyleSheet(f"color:{GREEN};")
            self.update_detail.setText(tr(
                "Запустите Colonial Helper. Если новая версия не откроется, "
                "лаунчер автоматически откатится."))
            return
        if kind == "install_failed":
            self.install_button.setEnabled(False)
            self.install_button.setText(tr("Установить обновление"))
            self.update_status.setText(tr("Не удалось установить обновление."))
            self.update_status.setStyleSheet(f"color:{RED};")
            self.update_detail.setText(
                str(state.get("detail") or tr("Ошибка установки."))[:240])
            return
        # idle / начальное состояние
        self.update_status.setText(tr("Проверяем обновления…"))
        self.update_status.setStyleSheet(f"color:{MUTED};")
        self.update_detail.setText(tr("Обновления подписаны и проверяются перед установкой."))

    def check_updates(self) -> None:
        if self._busy:
            return
        self._busy = True
        self.check_button.setEnabled(False)
        self.install_button.setEnabled(False)
        self.install_button.setText(tr("Установить обновление"))
        self._update_state = {"kind": "checking"}
        self._render_update_state()

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
        self._update_state = {"kind": "failed", "detail": self.last_error}
        self._render_update_state()

    def _update_checked(self, payload: Dict[str, Any]) -> None:
        self._busy = False
        self.check_button.setEnabled(True)
        result = (payload or {}).get("result") or {}
        plan = (payload or {}).get("plan")
        if not result.get("ok"):
            self._update_state = {
                "kind": "unavailable",
                "detail": str(result.get("error") or tr("Нет связи с сервером обновлений.")),
            }
            self._render_update_state()
            return
        latest = str(result.get("latest") or self.version)
        if result.get("needs_launcher"):
            self.update_manifest = None
            self._update_state = {"kind": "needs_launcher", "version": latest}
            self._render_update_state()
            return
        if result.get("update_available"):
            self.update_manifest = result.get("manifest")
            size = int((plan or {}).get("bytes", 0))
            count = len((plan or {}).get("download", []))
            self._update_state = {
                "kind": "available", "version": latest, "count": count,
                "size": int(size / 1024), "rollback": bool(result.get("rollback")),
            }
            self._render_update_state()
            return
        self.update_manifest = None
        self._update_state = {"kind": "current", "version": self.version}
        self._render_update_state()

    def install_update(self) -> None:
        manifest = self.update_manifest
        if not manifest or self._busy:
            return
        self._busy = True
        self.check_button.setEnabled(False)
        self.install_button.setEnabled(False)
        version = str(manifest.get("version") or "")
        self._update_state = {"kind": "installing", "version": version}
        self._render_update_state()
        task = Task(self)

        def progress(done: int, total: int) -> None:
            task.progress.emit(int(done), int(total))

        def on_progress(done: int, total: int) -> None:
            self._update_state = {
                "kind": "progress", "version": version,
                "percent": int(100 * done / max(1, total)),
            }
            self._render_update_state()

        task.progress.connect(on_progress)
        task.start(
            lambda: bundle_updater.apply_update(self.install_root, manifest, progress=progress),
            on_done=self._update_installed,
            on_error=lambda error: self._update_installed(
                {"ok": False, "error": describe_error(error), "version": version}))

    def _update_installed(self, result: Dict[str, Any]) -> None:
        self._busy = False
        self.check_button.setEnabled(True)
        if not (result or {}).get("ok"):
            self._update_state = {
                "kind": "install_failed",
                "detail": str((result or {}).get("error") or tr("Ошибка установки.")),
            }
            self._render_update_state()
            return
        self.version = str(result.get("version") or self.version)
        self.version_label.setText(f"v{self.version}")
        self.update_manifest = None
        self._update_state = {"kind": "installed", "version": self.version}
        self._render_update_state()

    # ----------------------------------------------------------------- window
    def launch(self) -> None:
        self.launch_requested = True
        self.close()
