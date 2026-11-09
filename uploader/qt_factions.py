"""Faction presence infographic — native Qt, no Tk facade.

The page shows the minor factions of the pilot's current system: influence,
allegiance, government and states. The data comes from the journal event that
carries it (``FSDJump``/``Location``/``CarrierJump``) or, when no such event was
read, from the project database (``GET /api/factions/system``). The line under
the system name says which of the two was used and when the state was observed.
"""
from __future__ import annotations

import webbrowser
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QProgressBar,
    QScrollArea,
    QSizePolicy,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from factions_data import format_timestamp
from i18n import tr
from locale_config import localized_url, normalize_locale
from site_config import DEFAULT_SITE_URL
from ui_qt import (
    CYAN,
    GREEN,
    LINE,
    MUTED,
    ORANGE,
    PANEL_ALT,
    RED,
    TEXT,
    YELLOW,
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

#: Состояние фракции из журнала → подпись на языке интерфейса.
STATE_TITLES = {
    "Boom": "Бум",
    "Bust": "Спад",
    "CivilUnrest": "Гражданские беспорядки",
    "CivilWar": "Гражданская война",
    "War": "Война",
    "Famine": "Голод",
    "Investment": "Инвестиции",
    "Lockdown": "Изоляция",
    "Outbreak": "Эпидемия",
    "Expansion": "Экспансия",
    "Retreat": "Отступление",
    "Election": "Выборы",
    "PirateAttack": "Атака пиратов",
    "NaturalDisaster": "Природная катастрофа",
    "PublicHoliday": "Праздник",
    "HistoricEvent": "Знаковое событие",
    "InfrastructureFailure": "Отказ инфраструктуры",
    "TerroristAttack": "Теракт",
    "Drought": "Засуха",
    "Blight": "Болезнь урожая",
    "None": "Нет",
}

#: Что состояние значит для системы — одна фраза, как в игре.
STATE_DESCRIPTIONS = {
    "Boom": "Бум: спрос на товары высокий, цены и производство растут.",
    "Bust": "Спад: производство падает, заказы дешевеют, спрос низкий.",
    "CivilUnrest": "Беспорядки: миссии срываются, безопасность системы падает.",
    "Famine": "Голод: нехватка еды, растёт спрос на продовольствие.",
    "Investment": "Инвестиции: система вкладывает средства в развитие.",
    "Lockdown": "Изоляция: досмотр на станциях, часть услуг недоступна.",
    "Outbreak": "Эпидемия: станции закрыты на карантин, нужны медикаменты.",
    "War": "Война: идут боевые действия, растёт спрос на оружие.",
    "CivilWar": "Гражданская война: борьба фракций за контроль, нужны боеприпасы.",
}

#: Тон состояния: тот же язык цвета, что у влияния и модулей корабля.
STATE_TONES = {
    "Boom": GREEN, "Investment": GREEN, "Expansion": GREEN, "PublicHoliday": GREEN,
    "Bust": RED, "Famine": RED, "CivilUnrest": RED, "War": RED, "CivilWar": RED,
    "Outbreak": RED, "Lockdown": RED, "TerroristAttack": RED,
    "NaturalDisaster": RED, "InfrastructureFailure": RED, "Drought": RED,
    "Blight": RED, "PirateAttack": RED, "Retreat": YELLOW, "Election": CYAN,
    "HistoricEvent": CYAN, "None": MUTED,
}

#: Репутация командира у фракции: нижняя граница и подпись как в игре.
REPUTATION_STEPS: Tuple[Tuple[float, str], ...] = (
    (-1.00, "Враждебная"),
    (-0.60, "Неприветливая"),
    (-0.20, "Нейтральная"),
    (0.20, "Дружелюбная"),
    (0.50, "Приветливая"),
    (0.80, "Союзная"),
)
REPUTATION_TONES = {
    "Враждебная": RED, "Неприветливая": ORANGE, "Нейтральная": MUTED,
    "Дружелюбная": CYAN, "Приветливая": CYAN, "Союзная": GREEN,
}

#: Сколько наблюдений влияния помнить для графика тенденций.
TREND_POINTS = 40

#: Откуда взят снимок: подписи под названием системы.
SOURCE_SITE = "site"
SOURCE_JOURNAL = "journal"
SOURCE_JOURNAL_ARCHIVE = "journal-archive"



def state_title(name: Any) -> str:
    """Состояние фракции по-русски, как в игре (неизвестное — как пришло)."""
    text = str(name or "").strip()
    if not text:
        return ""
    key = STATE_TITLES.get(text)
    return tr(key) if key else text


def state_description(name: Any) -> str:
    """Пояснение состояния одной фразой (пусто, если сказать нечего)."""
    key = STATE_DESCRIPTIONS.get(str(name or "").strip())
    return tr(key) if key else ""


def state_tone(name: Any) -> str:
    return STATE_TONES.get(str(name or "").strip(), TEXT)


def reputation_label(value: Optional[float]) -> str:
    """``MyReputation`` → «Приветливая», «Нейтральная» и т. п.

    ``None`` — репутация неизвестна (сайт её не хранит): пустая строка честнее
    выдуманного «Нейтральная».
    """
    if value is None:
        return ""
    try:
        number = max(-1.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return ""
    title = REPUTATION_STEPS[0][1]
    for threshold, name in REPUTATION_STEPS:
        if number >= threshold:
            title = name
    return tr(title)


def influence_change(history: Sequence[Any]) -> float:
    """Насколько влияние изменилось между первым и последним наблюдением."""
    values = []
    for item in history or ():
        try:
            values.append(float(item[1] if isinstance(item, (list, tuple)) else item))
        except (TypeError, ValueError, IndexError):
            continue
    if len(values) < 2:
        return 0.0
    return values[-1] - values[0]


class TrendChart(QWidget):
    """Мини-график влияния: линия, точки и подписи минимума/максимума.

    Рядом с процентом влияния видно, куда оно шло: в игре такой график есть, а
    в списке фракций Helper его не было — по одному числу «42,2 %» направление
    не понять. Точки — наблюдения Helper (журнал игры и база проекта), поэтому
    подпись под графиком честно говорит, откуда они.
    """

    HEIGHT = 92
    PADDING = (6, 16, 6, 14)

    def __init__(self, color: str = CYAN, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.color = QColor(color)
        self.values: List[float] = []
        self.setMinimumHeight(self.HEIGHT)
        self.setFixedHeight(self.HEIGHT)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_values(self, values: Sequence[float]) -> None:
        self.values = [max(0.0, min(1.0, float(value))) for value in values]
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt API
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        left, top, right, bottom = self.PADDING
        width = max(1, self.width() - left - right)
        height = max(1, self.height() - top - bottom)
        font = QFont(self.font())
        font.setPointSize(7)
        painter.setFont(font)

        # Сетка: четыре вертикальные линии, как в игре за спиной графика.
        pen = QPen(QColor(LINE))
        pen.setWidth(1)
        painter.setPen(pen)
        for index in range(1, 5):
            x = left + width * index / 5.0
            painter.drawLine(QPointF(x, top), QPointF(x, top + height))

        if len(self.values) < 2:
            return
        low, high = min(self.values), max(self.values)
        span = high - low
        if span <= 1e-6:
            low, high = max(0.0, low - 0.01), min(1.0, high + 0.01)
            span = max(1e-6, high - low)

        def point(index: int, value: float) -> QPointF:
            x = left + width * index / max(1, len(self.values) - 1)
            y = top + height - height * (value - low) / span
            return QPointF(x, y)

        painter.setPen(QPen(self.color, 2))
        points = [point(index, value) for index, value in enumerate(self.values)]
        for index in range(1, len(points)):
            painter.drawLine(points[index - 1], points[index])

        painter.setBrush(self.color)
        painter.setPen(Qt.PenStyle.NoPen)
        radius = 2.6
        for position in points:
            painter.drawEllipse(position, radius, radius)

        # Подписи min/max слева: по ним видно масштаб, не читая процентов.
        painter.setPen(QPen(QColor(MUTED)))
        painter.drawText(QRectF(0, top - 6, left + width, 12),
                         int(Qt.AlignmentFlag.AlignLeft), f"{high * 100:.0f}%")
        painter.drawText(QRectF(0, top + height - 6, left + width, 12),
                         int(Qt.AlignmentFlag.AlignLeft), f"{low * 100:.0f}%")


class ReputationBar(QWidget):
    """Полоса репутации: от враждебной слева до союзной справа."""

    HEIGHT = 10

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setFixedHeight(self.HEIGHT)
        self.setMinimumWidth(120)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._value: Optional[float] = None

    def set_value(self, value: Optional[float]) -> None:
        self._value = None if value is None else max(-1.0, min(1.0, float(value)))
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt API
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        rect = QRectF(0, 1, self.width(), max(4, self.height() - 2))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor("#202428"))
        painter.drawRoundedRect(rect, 3, 3)
        if self._value is None:
            return
        position = (self._value + 1.0) / 2.0
        painter.setBrush(QColor(_reputation_color(self._value)))
        painter.drawRoundedRect(
            QRectF(0, rect.top(), max(3.0, rect.width() * position), rect.height()), 3, 3)


def _reputation_color(value: float) -> str:
    tone = REPUTATION_STEPS[0][1]
    for threshold, name in REPUTATION_STEPS:
        if value >= threshold:
            tone = name
    return REPUTATION_TONES.get(tone, MUTED)

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

        # Состояние самой системы: экономика, безопасность, население. В игре
        # это верхняя часть вкладки фракций — по ней понятно, в каких условиях
        # фракции живут, ещё до чтения карточек.
        self.system_card = QFrame()
        self.system_card.setObjectName("factionSystemCard")
        self._style_card(self.system_card)
        system_layout = QVBoxLayout(self.system_card)
        system_layout.setContentsMargins(12, 9, 12, 10)
        system_layout.setSpacing(4)
        self.system_info_label = label("", size=10, bold=True)
        self.system_hint_label = label("", role="muted", size=9, wrap=True)
        for widget in (self.system_info_label, self.system_hint_label):
            system_layout.addWidget(widget)
        self.layout_.addWidget(self.system_card)
        self.system_card.setVisible(False)

        self.cards = QWidget()
        self.cards_layout = QVBoxLayout(self.cards)
        self.cards_layout.setContentsMargins(0, 6, 0, 0)
        self.cards_layout.setSpacing(8)
        self.layout_.addWidget(self.cards)
        self.layout_.addStretch(1)

        #: Наблюдения влияния по фракциям — для графика тенденций. Ключ —
        #: система и имя фракции, чтобы при смене системы история не путалась.
        self._history: Dict[str, List[Tuple[str, float]]] = {}
        self._history_system = ""
        self._system_name = ""
        self._system_info: Dict[str, Any] = {}

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
                     observed_at="", note="", system_info=None) -> None:
        """Replace the whole view: system, controlling faction and the cards.

        ``source`` — откуда взято состояние (``site``, ``journal``,
        ``journal-archive``), ``observed_at`` — время наблюдения из журнала или
        базы, ``note`` — готовое пояснение для строки состояния,
        ``system_info`` — экономика, безопасность и население системы.
        """
        system = str(system or "").strip()
        controlling = str(controlling or "").strip()
        rows = [row for row in (factions or []) if isinstance(row, dict)]
        self._system_name = system
        if isinstance(system_info, dict):
            self._system_info = dict(system_info)
        elif not rows:
            self._system_info = {}

        self.system_label.setText(tr("СИСТЕМА  /  {system}", system=system) if system
                                  else tr("Ожидание данных о системе…"))
        self.control_label.setText(
            tr("Контролирующая фракция: {faction}", faction=controlling) if controlling else "")
        self.source_label.setText(self._source_text(source, observed_at))
        self.status_label.setText(str(note or "").strip())
        self._render_system_info(rows)
        self._record_history(system, rows, observed_at)

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

    @staticmethod
    def _style_card(card: QFrame) -> None:
        card.setStyleSheet(
            f"QFrame#factionCard, QFrame#factionSystemCard {{ background: {PANEL_ALT};"
            f" border: 1px solid {LINE}; border-radius: 8px; }}")

    # ------------------------------------------------------------- система
    def _render_system_info(self, rows: Sequence[dict]) -> None:
        """Строка «экономика · безопасность · население» над карточками.

        Экономика и безопасность — свойства системы, а не фракции: в игре они
        стоят в том же окне, потому что объясняют состояния фракций. Если
        журнал их ещё не присылал — блока нет, выдумывать нечего.
        """
        info = self._system_info or {}
        bits = []
        economy = str(info.get("economy") or "").strip()
        if economy:
            bits.append(tr("Экономика: {economy}", economy=economy))
        security = str(info.get("security") or "").strip()
        if security:
            bits.append(tr("Безопасность: {security}", security=security))
        population = info.get("population")
        if population:
            bits.append(tr("Население: {population}",
                           population=_population_text(population)))
        if not bits:
            self.system_card.setVisible(False)
            self.system_info_label.setText("")
            self.system_hint_label.setText("")
            return
        self.system_card.setVisible(True)
        self.system_info_label.setText("  ·  ".join(bits))
        hints = []
        economy_hint = _economy_hint(economy)
        if economy_hint:
            hints.append(economy_hint)
        security_hint = _security_hint(security)
        if security_hint:
            hints.append(security_hint)
        self.system_hint_label.setText(" ".join(hints))
        self.system_hint_label.setVisible(bool(hints))

    # ------------------------------------------------------------- история
    def _history_key(self, system: str, name: str) -> str:
        return f"{system.casefold()}|{name.casefold()}"

    def _record_history(self, system: str, rows: Sequence[dict], observed_at: str) -> None:
        """Запомнить наблюдение влияния — из них рисуется график тенденций.

        Одно и то же наблюдение (тот же момент времени) второй раз не пишем, а
        смена системы чистит историю: иначе линия «тенденций» соединяла бы
        разные системы.
        """
        if not system or not rows:
            return
        if self._history_system and self._history_system != system.casefold():
            self._history.clear()
        self._history_system = system.casefold()
        moment = str(observed_at or "").strip()
        for faction in rows:
            name = str(faction.get("name") or "").strip()
            if not name:
                continue
            try:
                influence = max(0.0, min(1.0, float(faction.get("influence") or 0.0)))
            except (TypeError, ValueError):
                continue
            points = self._history.setdefault(self._history_key(system, name), [])
            if points and points[-1][0] == moment and moment:
                points[-1] = (moment, influence)
            else:
                points.append((moment, influence))
            del points[:-TREND_POINTS]

    def history_for(self, name: str) -> List[Tuple[str, float]]:
        """Наблюдения влияния фракции — от старых к новым."""
        key = self._history_key(self._system_name, name)
        return list(self._history.get(key) or [])

    # ------------------------------------------------------------- карточка
    def _card(self, index: int, faction: dict, controlling: str) -> QFrame:
        color = PALETTE[index % len(PALETTE)]
        card = QFrame()
        card.setObjectName("factionCard")
        self._style_card(card)

        name = str(faction.get("name") or "—")
        card._faction_name = name
        marker = tr("  ·  КОНТРОЛИРУЕТ СИСТЕМУ") if name == controlling else ""

        layout = QVBoxLayout(card)
        layout.setContentsMargins(12, 9, 12, 10)
        layout.setSpacing(5)

        title_row = QHBoxLayout()
        title_row.setContentsMargins(0, 0, 0, 0)
        title_row.setSpacing(8)
        title_row.addWidget(label(name + marker, size=10, bold=True, color=color), 1)
        title_row.addWidget(action_button(tr("Открыть в Atlas ↗"), self._open_atlas,
                                          height=28))
        layout.addLayout(title_row)

        # -- репутация: две подписи и полоса, как в игре ----------------------
        reputation = faction.get("reputation")
        reputation_title = reputation_label(reputation)
        if reputation_title:
            rep_row = QHBoxLayout()
            rep_row.setContentsMargins(0, 0, 0, 0)
            rep_row.setSpacing(8)
            rep_row.addWidget(label(tr("Репутация у фракций"), role="muted", size=8))
            rep_row.addStretch(1)
            tone = REPUTATION_TONES.get(
                next((title for threshold, title in REPUTATION_STEPS
                      if float(reputation) >= threshold), "Нейтральная"), MUTED)
            rep_row.addWidget(label(reputation_title, size=9, bold=True, color=tone))
            layout.addLayout(rep_row)
            bar = ReputationBar()
            bar.set_value(float(reputation))
            layout.addWidget(bar)
            card._reputation_bar = bar

        # -- тенденции влияния ----------------------------------------------
        history = self.history_for(name)
        values = [value for _moment, value in history]
        trend_head = QHBoxLayout()
        trend_head.setContentsMargins(0, 2, 0, 0)
        trend_head.setSpacing(6)
        trend_head.addWidget(label(tr("Тенденции влияния"), size=9, bold=True))
        trend_head.addStretch(1)
        trend_head.addWidget(label(_trend_text(values), role="muted", size=8))
        layout.addLayout(trend_head)
        if len(values) >= 2 and (max(values) - min(values)) * 100.0 >= 0.1:
            chart = TrendChart(color)
            chart.set_values(values)
            layout.addWidget(chart)
            card._trend_chart = chart
            layout.addWidget(label(tr("точки — наблюдения Helper"), role="muted", size=7))

        # -- влияние, принадлежность, состояния ------------------------------
        try:
            influence = max(0.0, min(1.0, float(faction.get("influence", 0) or 0)))
        except (TypeError, ValueError):
            influence = 0.0
        details = [tr("Влияние {percent}%", percent=f"{influence * 100:.1f}")]
        for key in ("allegiance", "government"):
            value = faction.get(key)
            if value:
                details.append(str(value))
        current_state = str(faction.get("state") or "").strip()
        # «None» — это «нет состояния», а не название: подпись из каталога.
        details.append(state_title(current_state) if current_state else tr("Состояние: нет"))
        if faction.get("is_player"):
            details.append(tr("фракция игроков"))
        states = faction.get("active_states") or []
        if states:
            details.append(tr("Активно: {states}",
                              states=", ".join(state_title(state) for state in states[:3])))
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

        # -- состояния: ожидаемые и восстанавливающиеся ----------------------
        chips = self._state_chips(faction)
        if chips:
            chips_row = QHBoxLayout()
            chips_row.setContentsMargins(0, 2, 0, 0)
            chips_row.setSpacing(6)
            chips_row.addWidget(label(tr("Состояния:"), role="muted", size=8))
            for text, tone in chips:
                chips_row.addWidget(_chip(text, tone))
            chips_row.addStretch(1)
            layout.addLayout(chips_row)

        description = state_description(faction.get("state"))
        if description:
            layout.addWidget(label(description, role="muted", size=8, wrap=True))
        return card

    @staticmethod
    def _state_chips(faction: dict) -> List[Tuple[str, str]]:
        """Плитки состояний: сначала текущее, потом ожидаемые и восстановление."""
        chips: List[Tuple[str, str]] = []
        current = str(faction.get("state") or "").strip()
        if current and current != "None":
            chips.append((state_title(current), state_tone(current)))
        for state in faction.get("pending_states") or []:
            chips.append((tr("→ {state}", state=state_title(state)), YELLOW))
        for state in faction.get("recovering_states") or []:
            chips.append((tr("↻ {state}", state=state_title(state)), MUTED))
        return chips[:6]


def _chip(text: str, tone: str) -> QWidget:
    """Плитка состояния: цветная рамка и тот же тон текста, что у легенды."""
    widget = label(text, size=8, bold=True, color=tone)
    widget.setStyleSheet(
        f"color:{tone}; background:#1b1f22; border:1px solid {tone};"
        f" border-radius:6px; padding:1px 6px;")
    return widget


def _trend_text(values: Sequence[float]) -> str:
    """Стрелка и дельта влияния: «▲ +1,4 %», «▼ −0,3 %» или «без изменений»."""
    if len(values) < 2:
        return tr("одно наблюдение")
    delta = (values[-1] - values[0]) * 100.0
    if abs(delta) < 0.05:
        return tr("без изменений")
    arrow = "▲" if delta > 0 else "▼"
    return f"{arrow} {'+' if delta > 0 else '−'}{abs(delta):.1f} %"


def _population_text(value: Any) -> str:
    """Население системы: «22,7 млрд» вместо «22700000000»."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return str(value or "")
    if number >= 1_000_000_000:
        return tr("{value} млрд", value=f"{number / 1_000_000_000:.1f}".replace(".", ","))
    if number >= 1_000_000:
        return tr("{value} млн", value=f"{number / 1_000_000:.1f}".replace(".", ","))
    return f"{number:,}".replace(",", " ")


#: Короткие пояснения экономики: в игре они стоят под шкалой.
ECONOMY_HINTS = {
    "HighTech": "Высокие технологии: спрос на оборудование и медикаменты.",
    "Industrial": "Промышленность: нужны руды и металлы, продаются товары.",
    "Extraction": "Добыча: дешёвая руда, дорогие товары и топливо.",
    "Refinery": "Переработка: покупает руду, продаёт металлы и топливо.",
    "Agriculture": "Сельское хозяйство: покупает оборудование, продаёт еду.",
    "Military": "Военная экономика: спрос на оружие и боеприпасы.",
    "Tourism": "Туризм: спрос на предметы роскоши и пассажиров.",
    "Service": "Сфера услуг: ровный спрос на товары повседневного спроса.",
    "Colony": "Колония: всё в дефиците, выгодно везти почти любой товар.",
    "Terraforming": "Терраформирование: нужны продукты и медикаменты.",
}

SECURITY_HINTS = {
    "High": "Высокая безопасность: патрули на месте, пиратов мало.",
    "Medium": "Средняя безопасность: патрули есть, но не везде.",
    "Low": "Низкая безопасность: пираты и перехваты — обычное дело.",
    "Anarchy": "Анархия: закона нет, нападение возможно у любой станции.",
    "Lawless": "Беззаконие: система не подчиняется ни одной державе.",
}


def _economy_hint(economy: str) -> str:
    key = ECONOMY_HINTS.get(str(economy or "").strip())
    return tr(key) if key else ""


def _security_hint(security: str) -> str:
    key = SECURITY_HINTS.get(str(security or "").strip())
    return tr(key) if key else ""


class BgsSection(QWidget):
    """Раздел «BGS»: фракции системы и PowerPlay — двумя вкладками.

    Раньше раздел назывался «Фракции» и был одной страницей: BGS-состояние
    системы (влияние, состояния, войны) и PowerPlay 2.0 (кто владеет системой,
    оплот она или эксплуатируемая, сколько у командира заслуг) — разные слои
    одной и той же системы, и искать их в разных местах окна незачем.

    Вкладки держат готовые страницы: ``factions`` — прежняя инфографика
    (её поля и тесты остались прежними), ``powerplay`` — новая панель.
    """

    def __init__(self, *, locale: str = "ru", site_url=None, on_refresh=None,
                 on_powerplay_refresh=None, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("BgsSection")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self.tabs = QTabWidget()
        self.tabs.setObjectName("bgsTabs")
        layout.addWidget(self.tabs)

        self.factions = FactionInfographic(locale=locale, site_url=site_url,
                                           on_refresh=on_refresh)
        self.tabs.addTab(self.factions, tr("Фракции"))

        from qt_powerplay import PowerplayPanel

        self.powerplay = PowerplayPanel(locale=locale, site_url=site_url,
                                        on_refresh=on_powerplay_refresh)
        self.tabs.addTab(self.powerplay, tr("PowerPlay"))

    def show_factions(self) -> None:
        self.tabs.setCurrentWidget(self.factions)

    def show_powerplay(self) -> None:
        self.tabs.setCurrentWidget(self.powerplay)
