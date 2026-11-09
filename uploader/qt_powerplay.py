"""Вкладка PowerPlay: состояние командира и текущей системы — чистый Qt.

Данные готовит ``powerplay_data`` (журнал игры), а здесь только подписи и
цвета. Одна карточка про командира (держава, ранг, заслуги, голоса, срок
присяги, последняя выплата), одна про систему (кто её контролирует, в каком она
состоянии PowerPlay 2.0, шкала контроля, подкрепление и подрыв, державы в
системе) и список последних действий — чтобы «сколько ещё до следующего ранга»
и «что я тут делал» были видны в одном месте.
"""
from __future__ import annotations

import webbrowser
from typing import Any, Dict, List, Optional

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QProgressBar,
    QScrollArea,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

import powerplay_data
from factions_data import format_timestamp
from i18n import tr
from locale_config import localized_url, normalize_locale
from site_config import DEFAULT_SITE_URL
from ui_qt import (
    CYAN,
    LINE,
    MUTED,
    ORANGE,
    PANEL_ALT,
    RED,
    TEXT,
    action_button,
    heading,
    label,
    row,
)

#: Что состояние системы значит для державы — одной фразой, как в игре.
#: Ключи взяты из того же словаря состояний, что и в ``powerplay_data``.
STATE_HINTS = {
    "Stronghold": "Оплот державы: зона влияния 30 св. лет — самая большая из возможных.",
    "Fortified": "Укреплённая система: зона влияния 20 св. лет.",
    "Exploited": ("Уровень контроля в эксплуатируемых системах низок: для его "
                  "поддержания рядом должна находиться укреплённая система или база."),
    "Unoccupied": "Свободная система: под контроль держав она ещё не попала.",
    "Contested": "Спорная система: за контроль в ней борются несколько держав.",
}

#: Порядок легенды состояний — как шкала в игре: от свободной к базе державы.
STATE_LEGEND = (
    ("Unoccupied", "Не занята", "#6b7075"),
    ("Exploited", "Эксплуатируется", "#a3483f"),
    ("Fortified", "Укреплена", "#4a8a5a"),
    ("Stronghold", "База", "#7a5aa8"),
)

#: Что игра пишет про штрафы, если данные о них пришли (иначе строки нет).
PENALTY_KEYS = (
    ("penalty_system", "Штраф за силу системы: {value}"),
    ("penalty_defect", "Штраф за выход за линию фронта: {value}"),
)

#: Подпись пустого состояния: ключ перевода, ``tr()`` зовётся при сборке.
EMPTY_HINT = ("Данных PowerPlay пока нет: журнал игры ещё не писал о державе и "
              "системе. Войдите в игру — при старте появится держава, ранг и "
              "заслуги, при прыжке — состояние системы в PowerPlay.")

#: Действия командира → ключи подписей (``{…}`` подставляет :func:`action_text`).
ACTION_KEYS = {
    "PowerplayCollect": "собрано {count}",
    "PowerplayDeliver": "доставлено {count}",
    "PowerplayVote": "отдано голосов: {votes}",
    "PowerplaySalary": "выплата: {amount} кр",
    "PowerplayJoin": "присяга державе {power}",
    "PowerplayLeave": "уход из державы {power}",
    "PowerplayDefect": "переход: {from_power} → {to_power}",
    "PowerplayFastTrack": "ускоренная доставка: {amount} кр",
    "PowerplayVoucher": "ваучеры: {count} систем",
    "Powerplay": "состояние обновлено",
}


def _thousands(value: Any) -> str:
    """Число с пробелами между разрядами: «4 320» — так его читают в игре."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return str(value or "")
    return f"{number:,}".replace(",", " ")


def duration_text(seconds: Any) -> str:
    """Срок присяги: ``864000`` → «10 дн 0 ч» (пустая строка — срока нет)."""
    try:
        total = int(seconds)
    except (TypeError, ValueError):
        return ""
    if total < 0:
        return ""
    days, rest = divmod(total, 86400)
    hours, rest = divmod(rest, 3600)
    if days:
        return tr("{days} дн {hours} ч", days=days, hours=hours)
    return tr("{hours} ч {minutes} мин", hours=hours, minutes=rest // 60)


def power_label(info: Dict[str, Any]) -> str:
    """Подпись державы: «Aisling Duval · Империя» (стороны может не быть)."""
    label_ = str((info or {}).get("label") or (info or {}).get("name") or "").strip()
    allegiance = powerplay_data.allegiance_title((info or {}).get("allegiance"))
    if not label_:
        return ""
    return f"{label_} · {tr(allegiance)}" if allegiance else label_


def action_text(record: Dict[str, Any]) -> str:
    """Подпись одного действия командира на текущем языке."""
    kind = str((record or {}).get("kind") or "")
    key = ACTION_KEYS.get(kind)
    if not key:
        return ""
    values = {
        "count": _thousands(record.get("count")),
        "votes": _thousands(record.get("votes")),
        "amount": _thousands(record.get("amount")),
        "power": str(record.get("power") or ""),
        "from_power": str(record.get("from_power") or ""),
        "to_power": str(record.get("to_power") or ""),
    }
    item = str(record.get("item") or "").strip()
    if item and values["count"]:
        # «доставлено 15 × Power Converters» — что именно везли, видно сразу.
        return tr(key, **values) + f" × {item}"
    return tr(key, **values)



class BalanceBar(QWidget):
    """«Переменный успех»: ослабление слева, усиление справа, точка посередине.

    В игре это две встречные полосы: красная показывает, сколько система теряет
    от подрыва, синяя — сколько получает от подкрепления. Числа Helper берёт из
    журнала (``PowerplayStateReinforcement``/``PowerplayStateUndermining``) и не
    додумывает: если данных нет, полосы просто нет.
    """

    HEIGHT = 16

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setFixedHeight(self.HEIGHT)
        self.setMinimumWidth(120)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.reinforcement = 0
        self.undermining = 0

    def set_values(self, reinforcement: Any, undermining: Any) -> None:
        self.reinforcement = max(0, _as_int(reinforcement))
        self.undermining = max(0, _as_int(undermining))
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt API
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        total = self.reinforcement + self.undermining
        rect = QRectF(0, 2, self.width(), max(6, self.height() - 4))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor("#202428"))
        painter.drawRoundedRect(rect, 3, 3)
        if total <= 0:
            return
        middle = rect.center().x()
        # Подрыв — от центра влево, подкрепление — от центра вправо: так две
        # силы видно как противостояние, а не как одну общую полосу.
        share = self.undermining / float(total)
        half = rect.width() / 2.0
        painter.setBrush(QColor(RED))
        painter.drawRect(QRectF(middle - half * share, rect.top(), half * share, rect.height()))
        painter.setBrush(QColor(CYAN))
        painter.drawRect(QRectF(middle, rect.top(), half * (1.0 - share), rect.height()))
        painter.setPen(QPen(QColor(TEXT), 1))
        painter.drawLine(QPointF(middle, rect.top()), QPointF(middle, rect.bottom()))


class StateScale(QWidget):
    """Шкала состояний системы с отметкой текущего — легенда PowerPlay.

    Четыре состояния идут подряд от «не занята» до «база державы»: по шкале
    сразу видно, где система стоит и куда ей расти. Отметка — треугольник над
    нужным отрезком, как в игре.
    """

    HEIGHT = 30

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setFixedHeight(self.HEIGHT)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.state = ""

    def set_state(self, state: Any) -> None:
        self.state = str(state or "").strip()
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802 - Qt API
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        count = len(STATE_LEGEND)
        width = self.width() / float(count)
        top = 8
        height = max(8, int(self.height()) - top - 10)
        for index, (name, _title, color) in enumerate(STATE_LEGEND):
            rect = QRectF(width * index, top, width - 1, height)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QColor(color if name == self.state else _dim(color)))
            painter.drawRect(rect)
            if name == self.state:
                marker = QPolygonF([
                    QPointF(rect.center().x() - 5, top - 7),
                    QPointF(rect.center().x() + 5, top - 7),
                    QPointF(rect.center().x(), top - 1),
                ])
                painter.setBrush(QColor(TEXT))
                painter.drawPolygon(marker)
        painter.setPen(QPen(QColor(MUTED)))
        font = painter.font()
        font.setPointSize(7)
        painter.setFont(font)
        for index, (_name, title, _color) in enumerate(STATE_LEGEND):
            rect = QRectF(width * index, top + height, width, 10)
            painter.drawText(rect, int(Qt.AlignmentFlag.AlignLeft), tr(title))


def _dim(color: str) -> str:
    """Приглушить цвет: невыбранные состояния не должны спорить с текущим."""
    return QColor(color).darker(185).name()


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


class PowerplayPanel(QWidget):
    """Состояние PowerPlay: командир, его действия и текущая система."""

    def __init__(self, parent=None, locale: str = "ru", site_url=None,
                 on_refresh=None) -> None:
        super().__init__(parent)
        self.setObjectName("PowerplayPanel")
        self.locale = normalize_locale(locale)
        self.atlas_url = localized_url(
            f"{str(site_url or DEFAULT_SITE_URL).rstrip('/')}/atlas?tab=powerplay",
            self.locale)
        self.on_refresh = on_refresh
        self._state: Dict[str, Any] = {}

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

        self.layout_.addWidget(label("POWERPLAY  /  COMMANDER & SYSTEM",
                                     size=9, bold=True, color=CYAN))
        header_widgets = [heading(tr("PowerPlay"), size=20)]
        if callable(on_refresh):
            self.refresh_btn = action_button(tr("Обновить"), self.refresh, height=32)
            header_widgets.append(self.refresh_btn)
        else:
            self.refresh_btn = None
        header_widgets += [action_button(tr("Открыть Atlas ↗"), self._open_atlas,
                                         height=32), None]
        self.layout_.addWidget(row(*header_widgets))
        self.layout_.addWidget(label(
            tr("Состояние PowerPlay командира и текущей системы: из журнала игры."),
            role="muted", size=9, wrap=True, word_wrap_width=820))

        # Пояснение, почему данных о системе нет (сайт молчит, журнал без события).
        self.note_label = label("", role="muted", size=9, wrap=True,
                                word_wrap_width=760)
        self.layout_.addWidget(self.note_label)

        self.commander_header = label(tr("СТАТУС КОМАНДИРА"), size=9, bold=True,
                                      color=CYAN)
        self.layout_.addWidget(self.commander_header)
        self.commander_card = QFrame()
        self.commander_card.setObjectName("powerplayCommanderCard")
        self._style_card(self.commander_card, "powerplayCommanderCard")
        commander_layout = QVBoxLayout(self.commander_card)
        commander_layout.setContentsMargins(12, 9, 12, 10)
        commander_layout.setSpacing(4)
        self.power_label_widget = label("", size=11, bold=True)
        self.rank_label = label("", size=10)
        self.pledge_label = label("", role="muted", size=9, wrap=True)
        self.salary_label = label("", role="muted", size=9, wrap=True)
        for widget in (self.power_label_widget, self.rank_label,
                       self.pledge_label, self.salary_label):
            commander_layout.addWidget(widget)
        self.layout_.addWidget(self.commander_card)

        self.system_header = label(tr("СИСТЕМА"), size=9, bold=True, color=CYAN)
        self.layout_.addWidget(self.system_header)
        self.system_card = QFrame()
        self.system_card.setObjectName("powerplaySystemCard")
        self._style_card(self.system_card, "powerplaySystemCard")
        system_layout = QVBoxLayout(self.system_card)
        system_layout.setContentsMargins(12, 9, 12, 10)
        system_layout.setSpacing(4)
        self.system_label = label("", size=11, bold=True, color=CYAN)
        # Бейдж состояния: цветная плашка с состоянием PowerPlay 2.0 — то же,
        # что в игре в шапке «Информация о политике».
        self.state_badge = label("", size=10, bold=True)
        self.state_badge.setSizePolicy(QSizePolicy.Policy.Maximum,
                                       QSizePolicy.Policy.Fixed)
        self.state_label = label("", size=10, bold=True)
        self.state_hint = label("", role="muted", size=9, wrap=True)
        self.control_label = label("", role="muted", size=9, wrap=True)
        self.control_bar = QProgressBar()
        self.control_bar.setRange(0, 1000)
        self.control_bar.setTextVisible(False)
        self.control_bar.setFixedHeight(8)
        self.control_bar.setStyleSheet(
            "QProgressBar { background: #202428; border: none; border-radius: 4px; }"
            "QProgressBar::chunk { background: #65c78a; border-radius: 4px; }")

        # «Переменный успех»: две встречные полосы и контрольная точка.
        self.balance_header = label(tr("Переменный успех"), size=9, bold=True, color=CYAN)
        balance_row = QHBoxLayout()
        balance_row.setContentsMargins(0, 0, 0, 0)
        balance_row.setSpacing(8)
        self.undermine_label = label("", size=9, bold=True, color=RED)
        self.balance_bar = BalanceBar()
        self.reinforce_label = label("", size=9, bold=True, color=CYAN)
        balance_row.addWidget(self.undermine_label)
        balance_row.addWidget(self.balance_bar, 1)
        balance_row.addWidget(self.reinforce_label)
        self.point_label = label("", role="muted", size=9)

        self.scale_header = label(tr("Состояния систем"), size=9, bold=True, color=CYAN)
        self.state_scale = StateScale()
        self.penalty_label = label("", role="muted", size=9, wrap=True)
        self.multiplier_label = label("", role="muted", size=9, wrap=True)
        self.powers_label = label("", role="muted", size=9, wrap=True)
        self.source_label = label("", role="muted", size=9, wrap=True)
        for widget in (self.system_label, self.state_badge, self.state_label,
                       self.state_hint, self.control_label):
            system_layout.addWidget(widget)
        system_layout.addWidget(self.balance_header)
        system_layout.addLayout(balance_row)
        system_layout.addWidget(self.point_label)
        for widget in (self.control_bar, self.scale_header, self.state_scale,
                       self.penalty_label, self.multiplier_label,
                       self.powers_label, self.source_label):
            system_layout.addWidget(widget)
        self.layout_.addWidget(self.system_card)

        self.actions_header = label(tr("Последние действия"), size=9, bold=True,
                                    color=CYAN)
        self.layout_.addWidget(self.actions_header)
        self.actions_widget = QWidget()
        self.actions_layout = QVBoxLayout(self.actions_widget)
        self.actions_layout.setContentsMargins(0, 0, 0, 0)
        self.actions_layout.setSpacing(2)
        self.layout_.addWidget(self.actions_widget)

        self.empty: Optional[QWidget] = None
        self.layout_.addStretch(1)
        self.set_state({})

    # ------------------------------------------------------------------ public
    @staticmethod
    def _style_card(card: QFrame, name: str) -> None:
        card.setStyleSheet(
            f"QFrame#{name} {{ background: {PANEL_ALT};"
            f" border: 1px solid {LINE}; border-radius: 8px; }}")

    def _open_atlas(self) -> None:
        """Открыть вкладку PowerPlay на карте Atlas (ссылка на языке интерфейса)."""
        webbrowser.open(self.atlas_url, new=2)

    def refresh(self) -> None:
        """Попросить свежие данные: сеть и журнал читает Helper, не окно."""
        if callable(self.on_refresh):
            self.on_refresh()

    def state(self) -> Dict[str, Any]:
        return self._state

    def set_state(self, state: Optional[Dict[str, Any]]) -> None:
        """Показать состояние из ``powerplay_data.PowerplayTracker.state()``."""
        state = dict(state or {})
        self._state = state
        known = bool(state.get("known"))
        self.note_label.setText(str(state.get("note") or "").strip())
        power = state.get("power") or {}
        system = state.get("system") or {}

        # -- командир ---------------------------------------------------------
        if power:
            self.power_label_widget.setText(power_label(power))
            color = str(power.get("color") or TEXT)
        else:
            self.power_label_widget.setText(
                tr("Держава не выбрана — присягните державе в игре."))
            color = MUTED
        self.power_label_widget.setStyleSheet(f"color: {color};")

        self.rank_label.setText(self._rank_text(state))
        self.pledge_label.setText(self._pledge_text(state))
        self.salary_label.setText(self._salary_text(state))
        self.commander_card.setVisible(known)

        # -- система ----------------------------------------------------------
        self.system_card.setVisible(known and bool(system))
        if system:
            self._render_system(system)
        else:
            self._clear_system()

        # -- действия и пустое состояние --------------------------------------
        self._clear_actions()
        self._show_empty(None)
        if not known:
            self._show_empty(label(tr(EMPTY_HINT), role="muted", size=9, wrap=True,
                                   word_wrap_width=760))
            self.actions_header.setVisible(False)
            return
        self.actions_header.setVisible(bool(state.get("actions")))
        for record in state.get("actions") or []:
            text = action_text(record)
            if not text:
                continue
            moment = format_timestamp(record.get("at"))
            self.actions_layout.addWidget(label(
                f"{moment}  ·  {text}" if moment else text,
                role="muted", size=9, wrap=True))

    # ------------------------------------------------------------------ pieces
    def _render_system(self, system: Dict[str, Any]) -> None:
        """Карточка системы: состояние, «переменный успех», шкала и державы."""
        info = system.get("state_info") or {}
        name = str(info.get("name") or system.get("state") or "")
        # Цвет состояния берём из справочника, если наблюдение его не принесло:
        # иначе бейдж остался бы белым прямоугольником с белым текстом.
        color = str(info.get("color")
                    or (powerplay_data.SYSTEM_STATES.get(name) or {}).get("color")
                    or ORANGE)

        self.system_label.setText(tr("СИСТЕМА  /  {system}",
                                     system=str(system.get("system") or "")))
        self.state_label.setText(self._state_text(system))
        self.state_label.setStyleSheet(f"color: {color};")
        # Карточка могла быть спрятана пустым состоянием: показываем строки,
        # у которых есть текст (иначе после первого запуска без данных они
        # остались бы скрытыми навсегда).
        for widget in (self.system_label, self.state_label):
            widget.setVisible(bool(widget.text()))

        # Бейдж состояния — плашка в цвете состояния, с той же подписью.
        title = self._state_title(system)
        self.state_badge.setText(f"▼ {title}" if title else "")
        self.state_badge.setStyleSheet(
            f"color:{TEXT}; background:{color}; border-radius:6px; padding:2px 10px;")
        self.state_badge.setVisible(bool(title))
        hint = STATE_HINTS.get(name)
        self.state_hint.setText(tr(hint) if hint else "")
        self.state_hint.setVisible(bool(hint))

        self.control_label.setText(self._control_text(system))
        self.control_label.setVisible(bool(self.control_label.text()))

        # «Переменный успех»: подкрепление и подрыв, как их видел журнал.
        reinforcement = system.get("reinforcement")
        undermining = system.get("undermining")
        has_balance = reinforcement is not None or undermining is not None
        self.balance_header.setVisible(has_balance)
        self.balance_bar.setVisible(has_balance)
        self.undermine_label.setVisible(has_balance)
        self.reinforce_label.setVisible(has_balance)
        if has_balance:
            self.balance_bar.set_values(reinforcement, undermining)
            self.undermine_label.setText(
                tr("Ослабление {value}", value=_thousands(_as_int(undermining))))
            self.reinforce_label.setText(
                tr("Усиление {value}", value=_thousands(_as_int(reinforcement))))

        progress = system.get("control_progress")
        try:
            ratio = float(progress) if progress is not None else None
        except (TypeError, ValueError):
            ratio = None
        self.control_bar.setVisible(ratio is not None)
        if ratio is not None:
            # У оплота шкала может быть больше единицы: полоса — не больше 100 %.
            self.control_bar.setValue(int(round(max(0.0, min(1.0, ratio)) * 1000)))
        self.point_label.setText(self._point_text(system, ratio))
        self.point_label.setVisible(bool(self.point_label.text()))

        self.state_scale.set_state(name)
        self.scale_header.setVisible(bool(name))
        self.state_scale.setVisible(bool(name))
        self.penalty_label.setText(self._penalty_text(system))
        self.penalty_label.setVisible(bool(self.penalty_label.text()))
        self.multiplier_label.setText(self._multiplier_text(system))
        self.multiplier_label.setVisible(bool(self.multiplier_label.text()))
        self.powers_label.setText(self._powers_text(system))
        self.powers_label.setVisible(bool(self.powers_label.text()))
        self.source_label.setText(self._source_text(system))
        self.source_label.setVisible(bool(self.source_label.text()))

    def _clear_system(self) -> None:
        for widget in (self.system_label, self.state_badge, self.state_label,
                       self.state_hint, self.control_label, self.point_label,
                       self.penalty_label, self.multiplier_label,
                       self.powers_label, self.source_label):
            widget.setText("")
            widget.setVisible(False)
        for widget in (self.control_bar, self.balance_header, self.balance_bar,
                       self.undermine_label, self.reinforce_label,
                       self.scale_header, self.state_scale):
            widget.setVisible(False)
        self.state_scale.set_state("")

    @staticmethod
    def _state_title(system: Dict[str, Any]) -> str:
        info = system.get("state_info") or {}
        if info.get("title"):
            return tr(info["title"])
        return str(info.get("name") or system.get("state") or "")

    @staticmethod
    def _point_text(system: Dict[str, Any], ratio: Optional[float]) -> str:
        """Строка контрольной точки: сколько осталось до смены состояния.

        Игра показывает «Контрольная точка» числом активации — Helper знает
        только долю контроля, поэтому честно пишет процент и то, что за ним.
        """
        if ratio is None:
            return ""
        percent = max(0.0, ratio) * 100.0
        return tr("Контрольная точка: {percent} % контроля системы",
                  percent=f"{percent:.0f}")

    @staticmethod
    def _penalty_text(system: Dict[str, Any]) -> str:
        """Штрафы состояния: только если игра/сайт их прислали."""
        lines = []
        for key, template in PENALTY_KEYS:
            value = system.get(key)
            if value:
                lines.append(tr(template, value=str(value)))
        return "\n".join(lines)

    @staticmethod
    def _multiplier_text(system: Dict[str, Any]) -> str:
        """Множитель деятельности в этой системе (``activity_multiplier``)."""
        value = system.get("activity_multiplier")
        if value is None:
            return ""
        try:
            percent = float(value) * 100.0
        except (TypeError, ValueError):
            return ""
        return tr("Множитель деятельности в системе: +{percent} %",
                  percent=f"{percent:.0f}")

    @staticmethod
    def _rank_text(state: Dict[str, Any]) -> str:
        """Ранг и заслуги: то, что игра пишет в событии ``Powerplay``."""
        rank = state.get("rank")
        merits = state.get("merits")
        votes = state.get("votes")
        if rank is None and merits is None:
            return ""
        parts = []
        if rank is not None:
            parts.append(tr("Ранг {rank}", rank=_thousands(rank)))
        if merits is not None:
            parts.append(tr("заслуги {merits}", merits=_thousands(merits)))
        if votes is not None:
            parts.append(tr("голоса {votes}", votes=_thousands(votes)))
        return "  ·  ".join(parts)

    @staticmethod
    def _pledge_text(state: Dict[str, Any]) -> str:
        pledged = duration_text(state.get("time_pledged"))
        if not pledged:
            return ""
        return tr("Присяга: {time}", time=pledged)

    @staticmethod
    def _salary_text(state: Dict[str, Any]) -> str:
        salary = state.get("salary") or {}
        amount = salary.get("amount")
        if amount is None:
            return ""
        moment = format_timestamp(salary.get("at"))
        if moment:
            return tr("Последняя выплата: {amount} кр · {time}",
                      amount=_thousands(amount), time=moment)
        return tr("Последняя выплата: {amount} кр", amount=_thousands(amount))

    @staticmethod
    def _state_text(system: Dict[str, Any]) -> str:
        """Состояние системы в PowerPlay 2.0 и что оно даёт державе."""
        info = system.get("state_info") or {}
        title = tr(info["title"]) if info.get("title") else str(info.get("name") or "")
        if not title:
            return ""
        if info.get("range_ly"):
            return tr("Состояние: {state} · зона влияния {range} св. лет",
                      state=title, range=_thousands(info.get("range_ly")))
        if info.get("name") in ("Exploited", "Unoccupied", "Contested"):
            return tr("Состояние: {state} · своей зоны влияния не даёт", state=title)
        return tr("Состояние: {state}", state=title)

    @staticmethod
    def _control_text(system: Dict[str, Any]) -> str:
        """Кто владеет, шкала контроля и счётчики — по одному факту в строке."""
        lines: List[str] = []
        owner = system.get("power_info") or {}
        if owner:
            lines.append(tr("Держава: {power}", power=power_label(owner)))
        elif system.get("state"):
            # Владелец неизвестен: ``Powers`` — это претенденты, а не владелец.
            lines.append(tr("Держава не определена"))
        progress = system.get("control_progress")
        if progress is not None:
            try:
                percent = float(progress) * 100.0
                lines.append(tr("Контроль {percent} %", percent=f"{percent:.0f}"))
            except (TypeError, ValueError):
                pass
        counters = []
        for key, template in (("reinforcement", "подкрепление {value}"),
                              ("undermining", "подрыв {value}")):
            value = system.get(key)
            if value is not None:
                counters.append(tr(template, value=_thousands(value)))
        if counters:
            lines.append("  ·  ".join(counters))
        return "\n".join(lines)

    @staticmethod
    def _powers_text(system: Dict[str, Any]) -> str:
        names = [str(info.get("label") or info.get("name") or "")
                 for info in system.get("powers_info") or []]
        names = [name for name in names if name]
        if not names:
            return ""
        return tr("Державы в системе: {powers}", powers=", ".join(names))

    @staticmethod
    def _source_text(system: Dict[str, Any]) -> str:
        source = str(system.get("source") or "")
        moment = format_timestamp(system.get("observed_at")) or tr("время неизвестно")
        if source == "site":
            return tr("Источник: сайт проекта · наблюдение {time}", time=moment)
        if source == "journal-archive":
            return tr("Источник: журнал игры (архив) · {time}", time=moment)
        if source == "journal":
            return tr("Источник: журнал игры · {time}", time=moment)
        return ""

    def _clear_actions(self) -> None:
        while self.actions_layout.count():
            item = self.actions_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()

    def _show_empty(self, widget: Optional[QWidget]) -> None:
        """Показать или убрать подсказку «данных ещё нет»."""
        if self.empty is not None:
            self.empty.setParent(None)
            self.empty.deleteLater()
            self.empty = None
        if widget is not None:
            self.empty = widget
            self.layout_.insertWidget(self.layout_.count() - 1, widget)

    # ------------------------------------------------------------------ tests
    def action_lines(self) -> List[str]:
        """Подписи действий на экране — для проверок без скриншотов."""
        lines = []
        for index in range(self.actions_layout.count()):
            widget = self.actions_layout.itemAt(index).widget()
            if widget is not None:
                lines.append(widget.text())
        return lines
