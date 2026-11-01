"""Faction presence infographic — native Qt, no Tk facade.

The page shows the minor factions of the pilot's current system: influence,
allegiance, government and states. The data comes from the journal event that
carries it (``FSDJump``/``Location``/``CarrierJump``) or, when no such event was
read, from the project database (``GET /api/factions/system``). The line under
the system name says which of the two was used and when the state was observed.
"""
from __future__ import annotations

import webbrowser

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QProgressBar,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from factions_data import format_timestamp
from i18n import tr
from locale_config import localized_url, normalize_locale
from site_config import DEFAULT_SITE_URL
from ui_qt import (
    CYAN,
    LINE,
    PANEL_ALT,
    action_button,
    heading,
    label,
    row,
)

#: Pastel colours of the influence bars, in order of decreasing influence.
PALETTE = ("#e57b28", "#42b9d4", "#65c78a", "#8e7bf0", "#e27676", "#dfbd65")

#: Подпись пустого списка: ключ перевода, ``tr()`` зовётся при сборке карточки
#: (константа модуля не может зависеть от выбранного языка).
EMPTY_HINT = ("Данных о фракциях этой системы пока нет — ни в журнале игры, ни в "
              "базе проекта. Запустите Watcher и загрузите журнал: после прыжка "
              "система попадёт в базу, и вкладка подтянет её с сайта.")

#: Откуда взят снимок: подписи под названием системы.
SOURCE_SITE = "site"
SOURCE_JOURNAL = "journal"
SOURCE_JOURNAL_ARCHIVE = "journal-archive"


class FactionInfographic(QWidget):
    """Journal-backed list of the factions present in the current system.

    ``set_snapshot(system, controlling, factions)`` replaces the content; each
    faction card is built from plain Qt widgets, so no Tk facade or Canvas is
    involved.
    """

    def __init__(self, parent=None, locale: str = "ru", site_url=None, on_refresh=None) -> None:
        super().__init__(parent)
        self.setObjectName("FactionInfographic")
        self.locale = normalize_locale(locale)
        self.atlas_url = localized_url(
            f"{str(site_url or DEFAULT_SITE_URL).rstrip('/')}/atlas?tab=factions",
            self.locale)

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

        self.layout_.addWidget(label("FACTION PRESENCE  /  SYSTEM SNAPSHOT",
                                     size=9, bold=True, color=CYAN))
        self.on_refresh = on_refresh
        self.open_btn = action_button(tr("Открыть Atlas ↗"), self._open_atlas, height=32)
        self.refresh_btn = None
        header_widgets = [heading(tr("Фракции в текущей системе"), size=20)]
        if callable(on_refresh):
            self.refresh_btn = action_button(tr("Обновить"), self.refresh, height=32)
            header_widgets.append(self.refresh_btn)
        header_widgets += [self.open_btn, None]
        self.layout_.addWidget(row(*header_widgets))
        self.layout_.addWidget(label(
            tr("Минорные фракции, влияние и состояния текущей системы: из журнала "
               "игры и базы проекта."), role="muted", size=9, wrap=True,
            word_wrap_width=820))

        self.system_label = label(tr("Ожидание данных о системе…"), size=11, bold=True,
                                  color=CYAN)
        self.layout_.addWidget(self.system_label)
        self.control_label = label("", role="muted", size=9, wrap=True)
        self.layout_.addWidget(self.control_label)
        # Откуда взято состояние и когда его видели: журнал игры или сайт проекта.
        self.source_label = label("", role="muted", size=9, wrap=True)
        self.layout_.addWidget(self.source_label)
        # Пояснение, почему список пуст или неполон (нет системы, сайт молчит).
        self.status_label = label("", role="muted", size=9, wrap=True,
                                  word_wrap_width=760)
        self.layout_.addWidget(self.status_label)

        self.cards = QWidget()
        self.cards_layout = QVBoxLayout(self.cards)
        self.cards_layout.setContentsMargins(0, 6, 0, 0)
        self.cards_layout.setSpacing(8)
        self.layout_.addWidget(self.cards)
        self.layout_.addStretch(1)

        self.empty: QWidget | None = None
        self.set_snapshot("", "", [])

    # ------------------------------------------------------------------ public
    def _open_atlas(self) -> None:
        """Open the Atlas factions tab in the browser (site links are localized)."""
        webbrowser.open(self.atlas_url, new=2)

    def refresh(self) -> None:
        """Попросить свежие данные (кнопка «Обновить»); сеть живёт в Helper."""
        if callable(self.on_refresh):
            self.on_refresh()

    def set_snapshot(self, system, controlling, factions, *, source="",
                     observed_at="", note="") -> None:
        """Replace the whole view: system, controlling faction and the cards.

        ``source`` — откуда взято состояние (``site``, ``journal``,
        ``journal-archive``), ``observed_at`` — время наблюдения из журнала или
        базы, ``note`` — готовое пояснение для строки состояния.
        """
        system = str(system or "").strip()
        controlling = str(controlling or "").strip()
        rows = [row for row in (factions or []) if isinstance(row, dict)]

        self.system_label.setText(tr("СИСТЕМА  /  {system}", system=system) if system
                                  else tr("Ожидание данных о системе…"))
        self.control_label.setText(
            tr("Контролирующая фракция: {faction}", faction=controlling) if controlling else "")
        self.source_label.setText(self._source_text(source, observed_at))
        self.status_label.setText(str(note or "").strip())

        self._clear_cards()
        if not rows:
            self.empty = label(tr(EMPTY_HINT), role="muted", size=9, wrap=True,
                               word_wrap_width=760)
            self.cards_layout.addWidget(self.empty)
            return
        self.empty = None
        for index, faction in enumerate(rows):
            self.cards_layout.addWidget(self._card(index, faction, controlling))

    def cards_count(self) -> int:
        """How many faction cards are on screen (0 when the empty hint is shown)."""
        return 0 if self.empty is not None else self.cards_layout.count()

    def names(self) -> list:
        return [getattr(card, "_faction_name", "") for card in self._card_widgets()]

    # ------------------------------------------------------------------ pieces
    @staticmethod
    def _source_text(source, observed_at) -> str:
        """Строка «Источник: …» под названием системы (пустая, если нечего сказать)."""
        source = str(source or "").strip()
        if not source:
            return ""
        moment = format_timestamp(observed_at) or tr("время неизвестно")
        if source == SOURCE_SITE:
            return tr("Источник: сайт проекта · наблюдение {time}", time=moment)
        if source == SOURCE_JOURNAL:
            return tr("Источник: журнал игры · {time}", time=moment)
        if source == SOURCE_JOURNAL_ARCHIVE:
            return tr("Источник: журнал игры (архив) · {time}", time=moment)
        return ""

    def _card_widgets(self) -> list:
        widgets = []
        for index in range(self.cards_layout.count()):
            item = self.cards_layout.itemAt(index).widget()
            if isinstance(item, QFrame):
                widgets.append(item)
        return widgets

    def _clear_cards(self) -> None:
        while self.cards_layout.count():
            item = self.cards_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()

    def _card(self, index: int, faction: dict, controlling: str) -> QFrame:
        color = PALETTE[index % len(PALETTE)]
        card = QFrame()
        card.setObjectName("factionCard")
        card.setStyleSheet(
            f"QFrame#factionCard {{ background: {PANEL_ALT};"
            f" border: 1px solid {LINE}; border-radius: 8px; }}")

        name = str(faction.get("name") or "—")
        card._faction_name = name
        marker = tr("  ·  КОНТРОЛИРУЕТ СИСТЕМУ") if name == controlling else ""

        layout = QVBoxLayout(card)
        layout.setContentsMargins(12, 9, 12, 10)
        layout.setSpacing(4)

        title_row = QHBoxLayout()
        title_row.setContentsMargins(0, 0, 0, 0)
        title_row.setSpacing(8)
        title_row.addWidget(label(name + marker, size=10, bold=True, color=color), 1)
        title_row.addWidget(action_button(tr("Открыть в Atlas ↗"), self._open_atlas,
                                          height=28))
        layout.addLayout(title_row)

        try:
            influence = max(0.0, min(1.0, float(faction.get("influence", 0) or 0)))
        except (TypeError, ValueError):
            influence = 0.0
        details = [tr("Влияние {percent}%", percent=f"{influence * 100:.1f}")]
        for key in ("allegiance", "government", "state"):
            value = faction.get(key)
            if value:
                details.append(str(value))
        if faction.get("is_player"):
            details.append(tr("фракция игроков"))
        states = faction.get("active_states") or []
        if states:
            details.append(tr("Активно: {states}",
                              states=", ".join(str(state) for state in states[:3])))
        layout.addWidget(label("  ·  ".join(details), role="muted", size=9, wrap=True))

        bar = QProgressBar()
        bar.setRange(0, 1000)
        bar.setValue(int(round(influence * 1000)))
        bar.setTextVisible(False)
        bar.setFixedHeight(8)
        bar.setStyleSheet(
            f"QProgressBar {{ background: #202428; border: none; border-radius: 4px; }}"
            f"QProgressBar::chunk {{ background: {color}; border-radius: 4px; }}")
        layout.addWidget(bar)

        return card
