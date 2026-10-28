"""Faction presence infographic — native Qt, no Tk facade.

The page shows the minor factions of the system from the last
``FSDJump``/``Location``/``CarrierJump`` event: influence, allegiance,
government, state and a link to the project site's Atlas.
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
EMPTY_HINT = ("Запустите Watcher и загрузите журнал из населённой системы, "
              "чтобы увидеть присутствующие фракции.")


class FactionInfographic(QWidget):
    """Journal-backed list of the factions present in the current system.

    ``set_snapshot(system, controlling, factions)`` replaces the content; each
    faction card is built from plain Qt widgets, so no Tk facade or Canvas is
    involved.
    """

    def __init__(self, parent=None, locale: str = "ru", site_url=None) -> None:
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

        self.layout_.addWidget(label("FACTION PRESENCE  /  JOURNAL SNAPSHOT",
                                     size=9, bold=True, color=CYAN))
        self.open_btn = action_button(tr("Открыть Atlas ↗"), self._open_atlas, height=32)
        self.layout_.addWidget(row(heading(tr("Фракции в текущей системе"), size=20),
                                   self.open_btn, None))
        self.layout_.addWidget(label(
            tr("Минорные фракции, влияние и состояния из последнего события "
               "FSDJump/Location в журнале."), role="muted", size=9, wrap=True,
            word_wrap_width=820))

        self.system_label = label(tr("Ожидание данных о системе…"), size=11, bold=True,
                                  color=CYAN)
        self.layout_.addWidget(self.system_label)
        self.control_label = label("", role="muted", size=9, wrap=True)
        self.layout_.addWidget(self.control_label)

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

    def set_snapshot(self, system, controlling, factions) -> None:
        """Replace the whole view: system, controlling faction and the cards."""
        system = str(system or "").strip()
        controlling = str(controlling or "").strip()
        rows = [row for row in (factions or []) if isinstance(row, dict)]

        self.system_label.setText(tr("СИСТЕМА  /  {system}", system=system) if system
                                  else tr("Ожидание данных о системе…"))
        self.control_label.setText(
            tr("Контролирующая фракция: {faction}", faction=controlling) if controlling else "")

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
