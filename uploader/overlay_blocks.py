"""Блоки HUD оверлея на чистом Qt.

Каждый блок — это окно `HudWindow` (без рамки, поверх игры) и содержимое из
настоящих виджетов: подписи, полосы заполнения, списки и график. Логика
«что показать» осталась прежней (её считают `ship_hud`, `overlay_options`,
`exobiology` и `carrier`), изменился только способ печати.
"""
from __future__ import annotations

import math
import time
from collections import deque
from typing import Any, Dict, List, Optional, Sequence

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFontMetricsF,
    QPainter,
    QPainterPath,
    QPen,
    QPolygonF,
    QTextCharFormat,
    QTextCursor,
)
from PySide6.QtWidgets import (
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QScrollArea,
    QSizePolicy,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

import foot_map
import route_hint
import ship_hud
from exobiology import estimate_value, format_credits
from hud_icons import HudIcon
from hud_window import (
    COLOR_ACCENT,
    COLOR_BORDER,
    COLOR_CYAN,
    COLOR_GREEN_TEXT,
    COLOR_LINE,
    COLOR_PANEL,
    COLOR_PANEL_ALT,
    COLOR_RED,
    COLOR_RED_TEXT,
    COLOR_SURFACE,
    COLOR_TEXT,
    COLOR_TEXT_DIM,
    COLOR_TEXT_MUTED,
    COLOR_YELLOW,
    HudBar,
    HudChart,
    HudWindow,
    hud_font,
    hud_panel,
    hud_section,
    hud_separator,
    paint,
)
from i18n import current_locale, tr
from overlay_options import filter_carrier_rows, option_key


# ============================================================
#  Текстовые утилиты
# ============================================================
#: Моноширинные семейства, в которых таблица выравнивается по колонкам.
MONO_FONT_HINTS = ("consolas", "courier", "mono", "dejavu sans mono", "menlo",
                   "liberation mono", "fixedsys", "nsimsun")


def is_monospace_font(family: object) -> bool:
    text = str(family or "").lower()
    return any(hint in text for hint in MONO_FONT_HINTS)


def format_table(headers: Sequence[str], rows: Sequence[Sequence[object]],
                 aligns: Optional[Sequence[str]] = None,
                 max_width: Optional[int] = None) -> str:
    """Моноширинная таблица для оверлея: заголовок + строки по колонкам.

    Считаем ширину колонки по самой длинной ячейке; если строка длиннее
    `max_width`, лишнее отрезаем в последней колонке — перенос внутри такой
    таблицы сломал бы выравнивание всех строк ниже.
    """
    headers = [str(item) for item in headers]
    body = [[("" if cell is None else str(cell)) for cell in row] for row in rows]
    aligns = list(aligns or [])
    widths = [len(item) for item in headers]
    for row in body:
        for index, cell in enumerate(row[:len(widths)]):
            widths[index] = max(widths[index], len(cell))

    def line(cells: Sequence[str]) -> str:
        parts = []
        for index, cell in enumerate(cells[:len(widths)]):
            width = widths[index]
            if (aligns[index] if index < len(aligns) else "left") == "right":
                parts.append(cell.rjust(width))
            else:
                parts.append(cell.ljust(width))
        return "  ".join(parts).rstrip()

    lines = [line(headers)] + [line(row) for row in body]
    if max_width:
        cut = []
        for text in lines:
            cut.append(text if len(text) <= max_width
                       else text[: max(1, max_width - 1)] + "…")
        lines = cut
    return "\n".join(lines)


#: Русские строки файла, которые не являются подписями интерфейса.
#: ``Вы`` — значение поля журнала ``first_footfall_by``: имя пилота-первооткрывателя
#: приходит из игры по-русски, и с ним сравниваются, а не показывают его.
NOT_UI_LITERALS = frozenset({"Вы"})


def _section_text(index: str, text: str) -> str:
    """Заголовок раздела с буквой-номером: «B / ОБРАЗЦЫ»."""
    return f"{index} / {text}".strip() if index else text


def _species_tail(name: object) -> str:
    """«Tussock stigmasis» → «stigmasis»: род и так показан в своей колонке."""
    text = str(name or "").strip()
    parts = text.split(" ", 1)
    return parts[1] if len(parts) == 2 and parts[1] else text


class _RowsHost(QWidget):
    """Контейнер для списка строк, которые создаются по ходу отрисовки."""

    def __init__(self, parent: Optional[QWidget] = None, *, spacing: int = 1) -> None:
        super().__init__(parent)
        self.rows = QVBoxLayout(self)
        self.rows.setContentsMargins(0, 0, 0, 0)
        self.rows.setSpacing(int(spacing))
        # Строки прижаты вверх: пустое место под ними лучше, чем строки,
        # растянутые на всю высоту блока.
        self.rows.setAlignment(Qt.AlignTop)

    def add(self, widget: QWidget) -> None:
        # Строки не растягиваются на всю высоту контейнера: иначе при четырёх
        # товарах строки разъезжаются по пустому блоку.
        widget.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
        self.rows.addWidget(widget)

    def add_stretch(self) -> None:
        self.rows.addStretch(1)

    def clear_rows(self) -> None:
        while self.rows.count():
            item = self.rows.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()


# ============================================================
#  ROUTE
# ============================================================
class RouteOverlay(HudWindow):
    """Compact navigation summary; journal facts only, no guessed fuel range."""

    def __init__(self, master, settings: Dict[str, Any]):
        super().__init__(
            master, "ROUTE",
            settings.get("route_x", 50), settings.get("route_y", 50),
            settings.get("route_width", 380), settings.get("route_height", 210),
            settings, "route",
        )
        #: Последняя подсказка о следующей системе (стройка и первооткрыватель).
        self._hint: Dict[str, Any] = route_hint.empty_hint()

        # Слева — сам маршрут, справа — подсказка о следующей системе: стройка
        # и первооткрыватель. Колонка подсказки узкая и появляется только
        # тогда, когда ей есть что сказать.
        self.main_row = QHBoxLayout()
        self.main_row.setContentsMargins(0, 0, 0, 0)
        self.main_row.setSpacing(6)

        self.left_column = QWidget(self.content)
        left_layout = QVBoxLayout(self.left_column)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(4)
        self.main_row.addWidget(self.left_column, 1)

        for name, text, color, delta, bold in (
            ("current_label", tr("Сейчас: —"), COLOR_TEXT_MUTED, -1, False),
            ("next_label", "→ —", COLOR_CYAN, 0, True),
            ("star_label", tr("Звезда: —"), COLOR_TEXT_MUTED, -1, False),
            ("distance_label", tr("Прыжок: — св. л."), COLOR_TEXT, -1, False),
            ("remaining_label", tr("Осталось: —"), COLOR_TEXT, -1, False),
            ("destination_label", tr("Цель: —"), COLOR_ACCENT, -1, False),
        ):
            label = self.make_label(self.left_column, text, color=color, bold=bold,
                                    dp=delta, wrap=self._text_width())
            left_layout.addWidget(label)
            setattr(self, name, label)

        self.progress_frame = QWidget(self.left_column)
        progress_layout = QVBoxLayout(self.progress_frame)
        progress_layout.setContentsMargins(0, 2, 0, 0)
        progress_layout.setSpacing(2)
        self.progress_bar = HudBar(self.progress_frame, color=COLOR_ACCENT, height=4)
        self.progress_label = self.make_label(self.progress_frame, "",
                                              color=COLOR_TEXT_MUTED, dp=-3)
        progress_layout.addWidget(self.progress_bar)
        progress_layout.addWidget(self.progress_label)
        left_layout.addWidget(self.progress_frame)
        left_layout.addStretch(1)

        # Подсказка: значки — те же геометрии, что у иконок сайта (`hud_icons`),
        # поэтому строка читается боковым зрением и не спорит с остальным HUD.
        self.hint_frame = QFrame(self.content)
        self.hint_frame.setAttribute(Qt.WA_StyledBackground, True)
        self.hint_frame.setStyleSheet(f"background:{COLOR_PANEL_ALT};border:0;")
        # Ширина колонки считается по самому длинному слову подсказки: иначе
        # «Первооткрыватель» в русском клипается по буквам, а в английском
        # колонка стояла бы шире нужного.
        self._hint_width = self._hint_column_width()
        self.hint_frame.setFixedWidth(self._hint_width)
        hint_layout = QVBoxLayout(self.hint_frame)
        hint_layout.setContentsMargins(6, 4, 6, 4)
        hint_layout.setSpacing(4)

        self.hint_build_icon = HudIcon(self.hint_frame, name="idle", size=14,
                                       color=COLOR_TEXT_MUTED)
        self.hint_build_label = self.make_label(self.hint_frame, tr("Стройка: нет данных"),
                                                color=COLOR_TEXT_MUTED, dp=-1,
                                                wrap=self._hint_width - 12)
        hint_layout.addWidget(self.hint_build_icon)
        hint_layout.addWidget(self.hint_build_label)
        self.hint_build_bar = HudBar(self.hint_frame, color=COLOR_ACCENT, height=3)
        self.hint_build_bar.hide()
        hint_layout.addWidget(self.hint_build_bar)

        hint_layout.addWidget(hud_separator(self.hint_frame))

        self.hint_author_icon = HudIcon(self.hint_frame, name="search", size=14,
                                        color=COLOR_TEXT_MUTED)
        self.hint_author_label = self.make_label(self.hint_frame, tr("Система не исследована"),
                                                 color=COLOR_TEXT_MUTED, dp=-1,
                                                 wrap=self._hint_width - 12)
        hint_layout.addWidget(self.hint_author_icon)
        hint_layout.addWidget(self.hint_author_label)
        self.main_row.addWidget(self.hint_frame, 0, Qt.AlignTop)

        self.body.addLayout(self.main_row)
        self.body.addStretch(1)
        self.apply_data_options()

    # -- раскладка колонок ---------------------------------------------------
    #: Колонка подсказки справа: узкая намеренно — значок и одна-две короткие
    #: строки, а не второй абзац текста.
    HINT_COLUMN_MIN = 118
    HINT_COLUMN_MAX = 176

    def _hint_column_width(self) -> int:
        """Ширина по самому длинному слову подсказки в текущем языке."""
        from PySide6.QtGui import QFontMetrics

        font = hud_font(self._font_family, max(6, int(self._font_size) - 1))
        metrics = QFontMetrics(font)
        widest = 0
        for text in (tr("Стройка: нет данных"), tr("Стройка: сайт недоступен"),
                     tr("Стройка: завершена"), tr("Стройка: запланирована"),
                     tr("Стройка: {percent}%", percent=100),
                     tr("Система не исследована"), tr("Первооткрыватель неизвестен"),
                     tr("Система: спрашиваем…")):
            for word in str(text).replace("\n", " ").split(" "):
                widest = max(widest, metrics.horizontalAdvance(word))
        return max(self.HINT_COLUMN_MIN, min(self.HINT_COLUMN_MAX, widest + 16))

    def _settings_width(self) -> int:
        try:
            return max(200, int(self.settings.get("route_width", 380)))
        except (TypeError, ValueError):
            return 300

    def _text_width(self) -> int:
        """Сколько пикселей остаётся тексту маршрута слева."""
        width = self.width() if self.width() > 1 else self._settings_width()
        spare = getattr(self, "_hint_width", self.HINT_COLUMN_MIN) + 6
        if not self._hint_visible():
            spare = 0
        return max(120, int(width) - 26 - spare)

    def _hint_visible(self) -> bool:
        from overlay_options import CONTENT_DEFAULTS, option_key

        key = option_key("route", "hint")
        return bool(self.settings.get(key, CONTENT_DEFAULTS.get(key, True)))

    def _apply_text_wrap(self) -> None:
        """Подогнать перенос строк маршрута под ширину левой колонки."""
        width = self._text_width()
        for name in ("current_label", "next_label", "star_label", "distance_label",
                     "remaining_label", "destination_label"):
            label = getattr(self, name, None)
            if label is None:
                continue
            label.setMinimumWidth(min(width, 80))
            label.setMaximumWidth(width)

    def apply_data_options(self) -> None:
        """Скрыть выключенные разделы и пересчитать ширину текста маршрута."""
        super().apply_data_options()
        self._apply_text_wrap()

    def resizeEvent(self, event) -> None:  # noqa: N802 - имя из Qt
        super().resizeEvent(event)
        if getattr(self, "left_column", None) is not None:
            self._apply_text_wrap()

    # -- подсказка о следующей системе ---------------------------------------
    #: Значок и цвет по состоянию стройки: дом — строят, галочка — готово,
    #: часы — запланировано, часы серые — о стройке ничего не известно.
    BUILD_LOOKS = {
        route_hint.BUILDING: ("building", COLOR_ACCENT),
        route_hint.DONE: ("done", COLOR_GREEN_TEXT),
        route_hint.PLANNED: ("idle", COLOR_YELLOW),
        route_hint.UNKNOWN: ("idle", COLOR_TEXT_MUTED),
    }

    def _render_hint(self, hint: Optional[Dict[str, Any]]) -> None:
        """Нарисовать подсказку: стройка с процентом и первооткрыватель системы."""
        hint = hint or route_hint.empty_hint()
        status = str(hint.get("status") or route_hint.UNKNOWN)
        icon, color = self.BUILD_LOOKS.get(status, self.BUILD_LOOKS[route_hint.UNKNOWN])
        percent = hint.get("progress")
        known = bool(hint.get("known"))
        loading = bool(hint.get("loading"))
        error = str(hint.get("error") or "")

        if error:
            self.hint_build_icon.set_icon("idle")
            self.hint_build_icon.set_color(COLOR_RED_TEXT)
            self.hint_build_label.setText(tr("Стройка: сайт недоступен"))
            paint(self.hint_build_label, color=COLOR_RED_TEXT)
            self.hint_build_bar.hide()
        elif status == route_hint.BUILDING and percent is not None:
            self.hint_build_icon.set_icon(icon)
            self.hint_build_icon.set_color(color)
            self.hint_build_label.setText(tr("Стройка: {percent}%", percent=percent))
            paint(self.hint_build_label, color=color)
            self.hint_build_bar.set_color(COLOR_ACCENT)
            self.hint_build_bar.set_fraction(float(percent) / 100.0)
            self.hint_build_bar.show()
        elif status == route_hint.DONE:
            self.hint_build_icon.set_icon(icon)
            self.hint_build_icon.set_color(color)
            self.hint_build_label.setText(tr("Стройка: завершена"))
            paint(self.hint_build_label, color=color)
            self.hint_build_bar.set_color(COLOR_GREEN_TEXT)
            self.hint_build_bar.set_fraction(1.0)
            self.hint_build_bar.show()
        elif status == route_hint.PLANNED:
            self.hint_build_icon.set_icon(icon)
            self.hint_build_icon.set_color(color)
            self.hint_build_label.setText(tr("Стройка: запланирована"))
            paint(self.hint_build_label, color=color)
            self.hint_build_bar.hide()
        else:
            self.hint_build_icon.set_icon("idle")
            self.hint_build_icon.set_color(COLOR_TEXT_MUTED)
            self.hint_build_label.setText(tr("Стройка: нет данных") if not loading
                                          else tr("Стройка: спрашиваем…"))
            paint(self.hint_build_label, color=COLOR_TEXT_MUTED)
            self.hint_build_bar.hide()

        author = str(hint.get("discoverer") or "")
        if loading and not known:
            self.hint_author_icon.set_icon("search")
            self.hint_author_icon.set_color(COLOR_TEXT_MUTED)
            self.hint_author_label.setText(tr("Система: спрашиваем…"))
            paint(self.hint_author_label, color=COLOR_TEXT_MUTED)
        elif not known:
            # Системы нет в базе проекта — это и есть «ещё не исследована».
            self.hint_author_icon.set_icon("search")
            self.hint_author_icon.set_color(COLOR_YELLOW)
            self.hint_author_label.setText(tr("Система не исследована"))
            paint(self.hint_author_label, color=COLOR_YELLOW)
        elif author:
            self.hint_author_icon.set_icon("compass")
            self.hint_author_icon.set_color(COLOR_CYAN)
            self.hint_author_label.setText(tr("Открыл: {name}", name=author))
            paint(self.hint_author_label, color=COLOR_CYAN)
        else:
            self.hint_author_icon.set_icon("star")
            self.hint_author_icon.set_color(COLOR_TEXT_DIM)
            bodies = int(hint.get("bodies") or 0)
            self.hint_author_label.setText(
                tr("Первооткрыватель неизвестен\nтел\u00a0{count}", count=bodies)
                if bodies else tr("Первооткрыватель неизвестен"))
            paint(self.hint_author_label, color=COLOR_TEXT_DIM)

    def get_hint(self) -> Dict[str, Any]:
        """Последняя нарисованная подсказка — тестам и отладочной печати."""
        return dict(self._hint)

    def update_route(self, current, next_system, visited, total, remaining=None,
                     next_info=None, summary=None, hint=None) -> None:
        summary = summary or {}
        self.current_label.setText(tr("Сейчас: {system}", system=current))
        self.next_label.setText(
            (f"→ {next_system}" if summary.get("jumps_left", 1)
             else tr("Маршрут завершён"))
            if total else tr("Маршрут не задан"))
        star = summary.get("star_class") or "—"
        scoopable = summary.get("scoopable")
        fuel = (tr("заправка возможна") if scoopable is True
                else (tr("без заправки") if scoopable is False
                      else tr("заправка неизвестна")))
        self.star_label.setText(tr("Звезда: {star} · {fuel}", star=star, fuel=fuel))
        paint(self.star_label, color=COLOR_GREEN_TEXT if scoopable is True else COLOR_TEXT_MUTED)

        def ly(value):
            return "—" if value is None else f"{value:,.1f}"

        self.distance_label.setText(tr("Прыжок: {distance} св. л.",
                                       distance=ly(summary.get("jump_distance"))))
        left = summary.get("jumps_left", max(0, total - visited))
        self.remaining_label.setText(tr(
            "Осталось: {jumps} прыж. · {distance} св. л.",
            jumps=left, distance=ly(summary.get("remaining_distance"))))
        self.destination_label.setText(tr("Цель: {destination}",
                                          destination=summary.get("destination") or "—"))
        self.progress_label.setText(f"{visited} / {total}" if total else "")
        self.progress_bar.set_fraction(visited / total if total else 0)
        # Подсказка относится к конкретной системе: если сайт ответил про
        # предыдущую (маршрут только что сменился), показываем не её, а
        # честное «спрашиваем» — путать системы нельзя.
        shown = hint if isinstance(hint, dict) else {}
        if not total:
            shown = route_hint.empty_hint()
        elif shown.get("system") and str(shown["system"]) != str(next_system):
            shown = route_hint.mark_loading(shown, str(next_system))
        self._hint = shown
        self._render_hint(shown)
        self.apply_data_options()


# ============================================================
#  SESSION EVENTS
# ============================================================
class SessionEventsOverlay(HudWindow):
    """Поток событий сессии: журнал строк с цветом по уровню."""

    LEVEL_COLORS = {
        "info": COLOR_TEXT,
        "success": COLOR_GREEN_TEXT,
        "warn": COLOR_YELLOW,
        "error": COLOR_RED_TEXT,
    }

    def __init__(self, master, settings: Dict[str, Any]):
        super().__init__(
            master, "SESSION EVENTS",
            settings.get("events_x", 740), settings.get("events_y", 50),
            settings.get("events_width", 360), settings.get("events_height", 260),
            settings, "events",
        )
        self._events: deque = deque(maxlen=100)
        header = hud_section(self.content, "Chronological stream", size=self._font_size - 3)
        self.body.addWidget(header)
        self.text = QTextEdit(self.content)
        self.text.setReadOnly(True)
        self.text.setFrameShape(QFrame.NoFrame)
        self.text.setFont(hud_font(self._font_family, max(7, self._font_size - 1)))
        self.text.setStyleSheet(
            f"QTextEdit{{background:{COLOR_SURFACE};border:1px solid {COLOR_LINE};"
            f"color:{COLOR_TEXT};}}")
        self.body.addWidget(self.text, 1)

    def add_event(self, message: str, level: str = "info") -> None:
        self._events.append((time.strftime("%H:%M:%S"), str(message), level))
        self.render_events()

    def render_events(self) -> None:
        """Перерисовать журнал: строки вставляются курсором самого редактора."""
        self.text.clear()
        cursor = self.text.textCursor()
        cursor.movePosition(QTextCursor.Start)
        show_time = bool(self.settings.get(option_key("events", "timestamps"), True))
        for stamp, message, level in self._events:
            kind = level if level in self.LEVEL_COLORS else "info"
            if not self.settings.get(option_key("events", kind), True):
                continue
            prefix = f"{stamp}  " if show_time else ""
            fmt = QTextCharFormat()
            fmt.setForeground(QBrush(QColor(self.LEVEL_COLORS[kind])))
            cursor.insertText(prefix + message + "\n", fmt)
        self.text.setTextCursor(cursor)
        self.text.moveCursor(QTextCursor.End)


# ============================================================
#  STATUS
# ============================================================
class StatusOverlay(HudWindow):
    """Состояние связи с сервисами, игры и наблюдения за журналом."""

    def __init__(self, master, settings: Dict[str, Any]):
        super().__init__(
            master, "STATUS",
            settings.get("status_x", 50), settings.get("status_y", 220),
            settings.get("status_width", 280), settings.get("status_height", 220),
            settings, "status",
        )
        self.body.addWidget(hud_section(self.content, "System health",
                                       size=self._font_size - 2))
        self.status_frame, dot, self.status_text = self._indicator_row("■", "OFFLINE")
        self.status_dot = dot
        self.body.addWidget(self.status_frame)
        self.game_frame, dot, self.game_text = self._indicator_row(
            "□", tr("ИГРА / НЕТ ДАННЫХ"))
        self.game_dot = dot
        self.body.addWidget(self.game_frame)
        self.watcher_frame, dot, self.watcher_text = self._indicator_row("□", "WATCHER / OFF")
        self.watcher_dot = dot
        self.body.addWidget(self.watcher_frame)

        self.progress_text = self.make_label(self.content, "", color=COLOR_ACCENT, dp=-1,
                                             wrap=250)
        self.body.addWidget(self.progress_text)
        self.body.addWidget(hud_separator(self.content))
        self.detail_text = self.make_label(self.content, tr("Ошибок нет"),
                                           color=COLOR_TEXT_MUTED, dp=-2, wrap=250)
        self.body.addWidget(self.detail_text)
        self.body.addStretch(1)

    def _indicator_row(self, mark: str, text: str):
        frame = hud_panel(self.content, margins=(6, 4))
        layout = frame.layout_
        dot = QLabel(mark, frame)
        dot.setFont(hud_font(self._font_family, max(7, self._font_size - 3)))
        paint(dot, color=COLOR_RED)
        dot.setFixedWidth(14)
        label = self.make_label(frame, text, dp=0, bold=True)
        layout.addWidget(dot)
        layout.addWidget(label, 1)
        return frame, dot, label

    def set_status(self, online: bool, detail: str = "") -> None:
        if online:
            paint(self.status_dot, color=COLOR_GREEN_TEXT)
            self.status_text.setText(f"ONLINE  {detail}".rstrip())
            paint(self.status_text, color=COLOR_GREEN_TEXT)
        else:
            paint(self.status_dot, color=COLOR_RED_TEXT)
            self.status_text.setText("OFFLINE")
            paint(self.status_text, color=COLOR_RED_TEXT)

    def set_game(self, running: bool, focused: bool = False, detail: str = "") -> None:
        """Строка «Игра: запущена / в фокусе / не запущена»."""
        if running:
            color = COLOR_GREEN_TEXT if focused else COLOR_YELLOW
            text = tr("ИГРА / В ФОКУСЕ") if focused else tr("ИГРА / ЗАПУЩЕНА")
            dot = "■"
        else:
            color = COLOR_RED_TEXT
            text = tr("ИГРА / НЕ ЗАПУЩЕНА")
            dot = "□"
        if detail:
            text = f"{text} ({detail})"
        paint(self.game_dot, color=color)
        self.game_dot.setText(dot)
        self.game_text.setText(text)
        paint(self.game_text, color=color)

    def set_watcher(self, active: bool) -> None:
        color = COLOR_GREEN_TEXT if active else COLOR_TEXT_MUTED
        paint(self.watcher_dot, color=color)
        self.watcher_dot.setText("■" if active else "□")
        self.watcher_text.setText("WATCHER / ON" if active else "WATCHER / OFF")
        paint(self.watcher_text, color=color)

    def set_progress(self, text: str) -> None:
        self.progress_text.setText(text)

    def add_log(self, message: str, level: str = "info") -> None:
        # STATUS — компактный индикатор здоровья, а не второй журнал:
        # оставляем только то, на что нужно реагировать.
        if level not in ("warn", "error"):
            return
        color = COLOR_RED_TEXT if level == "error" else COLOR_YELLOW
        self.detail_text.setText(f"{level.upper()}: {message[-180:]}")
        paint(self.detail_text, color=color)


# ============================================================
#  SHIP
# ============================================================
class ShipOverlay(HudWindow):
    """Корабль: прочность корпуса и модулей, щиты, энергия, топливо, лента.

    Состав и текст каждой строки считает ``ship_hud``, а здесь только печать:
    строка = подпись из пула, перекрашивается по тону. Одна строка — одна
    подпись: при обновлении раз в секунду это не дёргает геометрию окна.
    """

    #: Тон HUD -> цвет текста.
    TONE_COLORS = {
        "ok": COLOR_GREEN_TEXT,
        "warn": COLOR_YELLOW,
        "bad": COLOR_RED_TEXT,
        "muted": COLOR_TEXT_MUTED,
        "text": COLOR_TEXT,
        "info": COLOR_CYAN,
    }
    #: Тон чипа -> (цвет текста, фон плашки).
    CHIP_COLORS = {
        "ok": (COLOR_GREEN_TEXT, "#123324"),
        "info": (COLOR_CYAN, "#10253d"),
        "warn": (COLOR_YELLOW, "#3a2c10"),
        "bad": (COLOR_RED_TEXT, "#3d1418"),
        "muted": (COLOR_TEXT_MUTED, "#21262d"),
    }

    def __init__(self, master, settings: Dict[str, Any]):
        # Высота подбиралась под список плашек; текстовые строки компактнее,
        # поэтому окно стартует ниже — и не режет список модулей.
        height = max(settings.get("ship_height", 330), 180)
        super().__init__(
            master, "SHIP",
            settings.get("ship_x", 50), settings.get("ship_y", 440),
            settings.get("ship_width", 360), height, settings, "ship",
        )
        self._ff = self._font_family
        self._fs = self._font_size
        self._wrap = max(150, int(settings.get("ship_width", 360)) - 26)
        self._last_data: Dict[str, Any] = {}
        self._last_signature = ""
        self._last_rows = 0
        #: Ключ последней отрисовки: подпись данных + геометрия + шрифт.
        #: Пока он тот же, строки не пересобираются (обновление раз в секунду).
        self._render_key: Optional[tuple] = None
        self._rows: List[Dict[str, Any]] = []
        #: Идёт подгонка под размер блока: `resizeEvent` не перерисовывает сам.
        self._fitting = False
        self._hud: Dict[str, Any] = {}
        self._paints = 0

        self._section_label = hud_section(self.content, "Vessel telemetry",
                                          size=self._fs - 2)
        self.body.addWidget(self._section_label)
        self.ship_name_label = self.make_label(
            self.content, tr("КОРАБЛЬ НЕ ОПРЕДЕЛЁН"), color=COLOR_ACCENT,
            background=COLOR_PANEL_ALT, dp=1, bold=True, wrap=self._wrap)
        # Заголовок тоже одна строка: длинное имя корабля укорачивается
        # многоточием, а не переносится и не съедает высоту строк.
        self.ship_name_label.setWordWrap(False)
        self.body.addWidget(self.ship_name_label)

        self.chips_frame = QWidget(self.content)
        self._chips_layout = QHBoxLayout(self.chips_frame)
        self._chips_layout.setContentsMargins(0, 0, 0, 0)
        self._chips_layout.setSpacing(3)
        self._chips_layout.addStretch(1)
        self.body.addWidget(self.chips_frame)
        self._chip_widgets: List[QLabel] = []
        self._chips_signature = ""

        self.rows_host = _RowsHost(self.content)
        self.body.addWidget(self.rows_host)
        self.body.addStretch(1)
        self._row_labels: List[QLabel] = []

    # -- строки HUD --------------------------------------------------------
    def _row_widget(self, index: int) -> QLabel:
        """i-я строка HUD: создать при необходимости, иначе переиспользовать."""
        while len(self._row_labels) <= index:
            label = self.make_label(self.rows_host, "", dp=0, wrap=self._wrap)
            # Одна строка HUD — одна строка текста. Перенос в QLabel выглядел
            # хуже обрезки: высота строки фиксирована раскладкой, поэтому вторая
            # половина строки (шкала, процент) просто не рисовалась.
            label.setWordWrap(False)
            label.setContentsMargins(5, 1, 5, 1)
            self.rows_host.add(label)
            self._row_labels.append(label)
        return self._row_labels[index]

    def _render_chips(self, chips: Sequence[Dict[str, str]]) -> None:
        signature = ",".join(f"{chip['text']}:{chip['tone']}" for chip in chips)
        if signature == self._chips_signature:
            # Те же чипы — не трогаем виджеты: пересборка ряда на каждом тике
            # и есть та вспышка, за которую ругали оверлей.
            return
        self._chips_signature = signature
        for widget in self._chip_widgets:
            self._chips_layout.removeWidget(widget)
            widget.setParent(None)
            widget.deleteLater()
        self._chip_widgets = []
        size = max(7, int(self._fs) - 2)
        for chip in chips:
            color, background = self.CHIP_COLORS.get(chip.get("tone", "muted"),
                                                     self.CHIP_COLORS["muted"])
            widget = QLabel(chip.get("text", ""), self.chips_frame)
            widget.setFont(hud_font(self._ff, size, bold=True))
            widget.setAttribute(Qt.WA_StyledBackground, True)
            widget.setStyleSheet(
                f"color:{color};background:{background};border:1px solid {COLOR_BORDER};"
                f"padding:0 4px;")
            self._chips_layout.insertWidget(self._chips_layout.count() - 1, widget)
            self._chip_widgets.append(widget)

    def update_ship(self, data: dict, force: bool = False) -> None:
        """Нарисовать состояние корабля по ``ShipTracker.get_state_dict()``.

        `force=True` — перерисовать даже при неизменной подписи данных: так
        выглядит смена настроек блока, при которых цифры те же, а экран обязан
        обновиться.
        """
        hud = ship_hud.build_ship_hud(data, settings=self.settings)
        self._hud = hud
        self._last_data = dict(data or {})
        self.ship_name_label.setText(self._fit_text(hud["title"], self._title_metrics()))
        self._render_chips(hud.get("chips") or [])

        key = (hud.get("signature"), self.width(), self.height(),
               int(self._fs), str(self._ff))
        if not force and key == self._render_key:
            return
        self._render_key = key
        self._last_signature = str(hud.get("signature", ""))
        self._paints += 1

        rows = self._render_rows(self._fit_rows_to_block(hud))
        self._rows = rows
        self._last_rows = len(rows)

    def _render_rows(self, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Разложить строки по подписям: текст, кегль, цвет, видимость."""
        width = self._row_text_width()
        for index, row in enumerate(rows):
            label = self._row_widget(index)
            delta = ship_hud.ROW_FONT_DELTA.get(row["kind"], 0)
            color = self.TONE_COLORS.get(row.get("tone", "text"), COLOR_TEXT)
            label.setFont(hud_font(self._ff, max(7, int(self._fs) + delta)))
            label.setText(self._fit_text(row["text"], label.fontMetrics(), width))
            background = COLOR_PANEL_ALT if index % 2 else COLOR_PANEL
            paint(label, color=color, background=background)
            label.setAttribute(Qt.WA_StyledBackground, True)
            label.show()
        for label in self._row_labels[len(rows):]:
            label.hide()
        return rows

    # -- подгонка строк под настоящий размер блока --------------------------
    #: Поля строки слева и справа: столько отнимает `setContentsMargins`.
    ROW_SIDE_MARGIN = 5
    def _metrics(self, delta: int = 0) -> QFontMetricsF:
        """Метрики шрифта строки: кегль тот же, что выставит `update_ship`."""
        return QFontMetricsF(hud_font(self._ff, max(7, int(self._fs) + int(delta))))

    def _title_metrics(self) -> QFontMetricsF:
        return QFontMetricsF(hud_font(self._ff, max(7, int(self._fs) + 1), bold=True))

    def _row_text_width(self) -> int:
        """Сколько пикселей реально отведено под текст строки."""
        width = self.rows_host.width()
        if width <= 1 or not self.isVisible():
            # Раскладка ещё не считалась или окно скрыто: берём ширину из
            # настроек блока — ровно её получит строка, когда окно покажется.
            width = max(150, int(self._wrap))
        return max(60, int(width) - 2 * self.ROW_SIDE_MARGIN - 1)

    def _fit_text(self, text: str, metrics: QFontMetricsF,
                  width: Optional[int] = None) -> str:
        """Обрезать строку по пикселям, а не по «среднему символу».

        Бюджет в символах считает `ship_hud.line_budget` — он не знает ни
        настоящего шрифта, ни ширины полей. Если глифы шире ожидаемого (крупный
        кегль, не Consolas, а системный шрифт), строка вылезала за край и Qt
        рисовал её обрезанной на середине шкалы.
        """
        text = str(text)
        width = self._row_text_width() if width is None else int(width)
        if not text or metrics.horizontalAdvance(text) <= width:
            return text
        return metrics.elidedText(text, Qt.TextElideMode.ElideRight, width)

    def _rows_height(self) -> int:
        """Сколько высоты заняли разложенные строки: их собственные sizeHint."""
        labels = [label for label in self._row_labels if not label.isHidden()]
        if not labels:
            return 0
        return (sum(max(label.sizeHint().height(), label.height()) for label in labels)
                + max(0, len(labels) - 1))                       # spacing = 1

    #: «Места сколько угодно» — пока окно не разложено, урезать список не за что.
    NO_LIMIT = 1 << 20

    def _rows_space(self) -> int:
        """Сколько пикселей высоты отведено под строки в этом окне."""
        content = self.content.height()
        top = self.rows_host.y()
        if not self.isVisible() or content <= 1 or top <= 0:
            # Настоящей раскладки ещё нет (окно скрыто, первый кадр): считаем,
            # что места хватает, и ничего не урезаем — иначе список модулей
            # пропадал бы ещё до первого показа блока.
            return self.NO_LIMIT
        return max(0, int(content) - int(top) - 7)                # нижнее поле body

    def _fit_rows_to_block(self, hud: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Строки HUD, ужатые по ширине и по высоте блока.

        Ширина: бюджет в символах уточняется по настоящим метрикам шрифта —
        строка обязана влезть целиком, шкала не должна рваться.
        Высота: если строк больше, чем помещается, список модулей укорачивается
        (лишние уходят в «ещё N»), а не сжимается: сжатые строки Qt режет по
        высоте, и вместо шкалы видна только её верхняя половина.
        """
        total = len((hud.get("modules") or {}).get("rows") or [])
        keep = total
        space = self._rows_space()
        rows = self._render_rows(self._fit_rows_width(hud))
        while keep > 0 and self._rows_height() > space:
            keep -= 1
            hud = ship_hud.limit_module_rows(hud, keep)
            rows = self._render_rows(self._fit_rows_width(hud))
        self._fit_block_height(space)
        self._hud = hud
        return rows

    def _fit_block_height(self, space: int) -> None:
        """Блоку мало высоты — поднять нижнюю границу, но не резать строки.

        Строки уже не переносятся и не ужимаются содержимым, но если окно ниже
        даже свёрнутого списка, Qt всё равно сожмёт подписи, и от глифов
        останется верхняя половина. Тогда окно подрастает до нужного размера:
        читаемое содержимое важнее точного размера блока.
        """
        needed = self._rows_height()
        if needed > space:
            current = int(self.height())
            required = max(self.MIN_HEIGHT, current - space + needed + 1)
            self._apply_min_height(required, grow_to=required)
        elif self.minimumHeight() > self.MIN_HEIGHT:
            self._apply_min_height(self.MIN_HEIGHT)

    def _apply_min_height(self, minimum: int, grow_to: int = 0) -> None:
        """Поставить нижнюю границу высоты, не вызывая лишней перерисовки."""
        if int(minimum) == self.minimumHeight():
            return
        self._fitting = True
        try:
            self.setMinimumHeight(int(minimum))
            if grow_to and int(self.height()) < int(grow_to):
                self.resize(int(self.width()), int(grow_to))
        finally:
            self._fitting = False

    #: Строка-проба для средней ширины глифа: цифры, шкала, знаки строк HUD.
    WIDTH_PROBE = "0123456789 ▓░%()/·MWt"

    def _char_width(self) -> float:
        """Средняя ширина глифа в пикселях — в ней и меряем бюджет строки.

        `ship_hud.CHAR_WIDTH_EM` — модель «0.62 em у моноширинного шрифта».
        Она верна для Consolas, но HUD рисуют и системным шрифтом, где глифы
        шире: строка вылезала за край, и Qt обрезал её на середине шкалы.
        """
        metrics = self._metrics(0)
        probe = self.WIDTH_PROBE
        return max(1.0, metrics.horizontalAdvance(probe) / len(probe))

    def _fit_rows_width(self, hud: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Строки HUD по бюджету, посчитанному по настоящему шрифту."""
        width = self._row_text_width()
        budget = max(12, int(width / self._char_width()))
        return ship_hud.hud_rows(hud, max_chars=budget)

    def get_rows(self) -> List[Dict[str, Any]]:
        """Строки последней отрисовки — ровно то, что на экране."""
        return [dict(row) for row in self._rows]

    def showEvent(self, event) -> None:  # noqa: N802 - имя из Qt
        """Блок показали — строки подгоняются под настоящую раскладку окна."""
        super().showEvent(event)
        if self._fitting:
            return
        if getattr(self, "_last_data", None) and getattr(self, "_row_labels", None) is not None:
            self.update_ship(self._last_data, force=True)

    def resizeEvent(self, event) -> None:  # noqa: N802 - имя из Qt
        """Блок потянули за угол — строки пересобираются под новый размер."""
        super().resizeEvent(event)
        if self._fitting:
            return
        # За время вызова из `HudWindow.__init__` полей ещё нет — молча выходим.
        if getattr(self, "_last_data", None) and getattr(self, "_row_labels", None) is not None:
            self.update_ship(self._last_data)

    def get_hud(self) -> Dict[str, Any]:
        """Последняя модель HUD — тестам и отладочной печати."""
        return dict(self._hud)

    def on_font_changed(self) -> None:
        """Шрифт блока: строки перекраиваются сами, база помечается заново."""
        self._fs = self._font_size
        self._ff = self._font_family
        self._chips_signature = ""      # чипы — под новый размер
        if self._last_data:
            self.update_ship(self._last_data, force=True)
        else:
            self.ship_name_label.setFont(
                hud_font(self._ff, self._fs + 1, bold=True))


# ============================================================
#  CARGO
# ============================================================
class CargoOverlay(HudWindow):
    """Трюм: вместимость, заполнение и поимённый список товаров."""

    def __init__(self, master, settings: Dict[str, Any]):
        super().__init__(
            master, "CARGO",
            settings.get("cargo_x", 50), settings.get("cargo_y", 980),
            settings.get("cargo_width", 300), settings.get("cargo_height", 340),
            settings, "cargo",
        )
        self.capacity_header = hud_section(self.content, "Capacity", size=self._font_size - 2)
        self.body.addWidget(self.capacity_header)
        self.capacity_frame = hud_panel(self.content, margins=(6, 4))
        layout = self.capacity_frame.layout_
        self.total_label = self.make_label(self.capacity_frame, "0 / 0 T",
                                           color=COLOR_ACCENT, dp=1, bold=True)
        self.fill_pct = self.make_label(self.capacity_frame, "0%",
                                        color=COLOR_TEXT_MUTED, dp=-1, bold=True,
                                        align_right=True)
        layout.addWidget(self.total_label)
        layout.addStretch(1)
        layout.addWidget(self.fill_pct)
        self.body.addWidget(self.capacity_frame)

        self.cargo_bar_bg = QWidget(self.content)
        bar_layout = QVBoxLayout(self.cargo_bar_bg)
        bar_layout.setContentsMargins(0, 2, 0, 4)
        bar_layout.setSpacing(0)
        self.cargo_bar = HudBar(self.cargo_bar_bg, color=COLOR_ACCENT, height=6)
        bar_layout.addWidget(self.cargo_bar)
        self.body.addWidget(self.cargo_bar_bg)

        self.items_header = hud_section(self.content, "Hold manifest", size=self._font_size - 2)
        self.body.addWidget(self.items_header)
        self.cargo_canvas = QScrollArea(self.content)
        self.cargo_canvas.setWidgetResizable(True)
        self.cargo_canvas.setFrameShape(QFrame.NoFrame)
        self.cargo_canvas.setStyleSheet(
            f"QScrollArea{{background:{COLOR_PANEL};border:1px solid {COLOR_LINE};}}")
        self.cargo_inner = _RowsHost(self.cargo_canvas, spacing=2)
        self.cargo_inner.setStyleSheet(f"background:{COLOR_PANEL};")
        self.cargo_canvas.setWidget(self.cargo_inner)
        self.cargo_scrollbar = self.cargo_canvas.verticalScrollBar()
        self.body.addWidget(self.cargo_canvas, 1)

        self.empty_label = self.make_label(self.cargo_inner, "[ Empty hold ]",
                                           color=COLOR_TEXT_MUTED, dp=0)
        self.empty_label.setAlignment(Qt.AlignCenter)
        self.cargo_inner.add(self.empty_label)
        # Пул строк: виджеты создаются один раз и дальше только меняют текст —
        # пересоздание списка на каждое обновление выглядело как мигание.
        self._cargo_pool: list = []
        self._cargo_order: list = []

    def update_cargo(self, data: dict) -> None:
        total = data.get("cargo_count", 0)
        capacity = data.get("cargo_capacity", 0)
        self.total_label.setText(f"{total} / {capacity} t")
        pct = int(total / capacity * 100) if capacity > 0 else 0
        self.fill_pct.setText(f"{pct}%")
        self.cargo_bar.set_fraction(pct / 100.0 if capacity > 0 else 0)
        self.cargo_bar.set_color(
            COLOR_GREEN_TEXT if pct < 80 else (COLOR_YELLOW if pct < 100 else COLOR_RED_TEXT))
        self._render_cargo_rows(data.get("inventory", []))

    # -- список трюма ------------------------------------------------------
    def _make_cargo_row(self) -> dict:
        row = QWidget(self.cargo_inner)
        layout = QHBoxLayout(row)
        layout.setContentsMargins(2, 0, 2, 0)
        layout.setSpacing(6)
        icon = self.make_label(row, "-", color=COLOR_ACCENT, dp=-2)
        icon.setFixedWidth(14)
        name = self.make_label(row, "", dp=-1)
        count = self.make_label(row, "", dp=-1, bold=True, align_right=True)
        count.setMinimumWidth(60)
        layout.addWidget(icon)
        layout.addWidget(name, 1)
        layout.addWidget(count)
        self.cargo_inner.add(row)
        return {"frame": row, "icon": icon, "name": name, "count": count}

    def _render_cargo_rows(self, inventory: list) -> None:
        """Обновить список трюма, переиспользуя виджеты."""
        inventory = list(inventory or [])
        if not inventory:
            for entry in self._cargo_pool:
                entry["frame"].hide()
            self._cargo_order = []
            self.empty_label.show()
            return

        self.empty_label.hide()
        while len(self._cargo_pool) < len(inventory):
            self._cargo_pool.append(self._make_cargo_row())

        order = [str(item.get("Name") or item.get("Name_Localised") or index)
                 for index, item in enumerate(inventory)]
        if order != self._cargo_order:
            for entry in self._cargo_pool:
                entry["frame"].hide()
            for index in range(len(inventory)):
                self._cargo_pool[index]["frame"].show()
            self._cargo_order = order

        for index, item in enumerate(inventory):
            entry = self._cargo_pool[index]
            name = item.get("Name_Localised") or item.get("Name", "Unknown")
            count = int(item.get("Count") or 0)
            stolen = int(item.get("Stolen") or 0)
            entry["icon"].setText("!" if stolen > 0 else "-")
            paint(entry["icon"], color=COLOR_RED_TEXT if stolen > 0 else COLOR_ACCENT)
            entry["name"].setText(f"{name[:22]}")
            count_text = f"{count:>4}"
            if stolen > 0:
                count_text += f" ({stolen} stl)"
            entry["count"].setText(count_text)
            paint(entry["count"], color=COLOR_ACCENT if stolen > 0 else COLOR_TEXT)


# ============================================================
#  CARRIER — груз на авианосце
# ============================================================
class CarrierOverlay(HudWindow):
    """Груз Fleet Carrier: сколько завезено и сколько осталось завезти.

    Слева — тоннаж из `CarrierStats` (достоверный), справа список товаров:
    сколько лежит на борту и сколько ещё не хватает до потребности
    стройплощадки колонизации. Данные собирает `carrier.CarrierTracker`.
    """

    #: Колонки списка товаров: (заголовок, ширина в символах, выравнивание).
    #: Спецификация общая для шапки и для строк — иначе заголовки разъезжаются
    #: с цифрами. Ширина задана в символах, а в пиксели её переводит шрифт
    #: блока (`_cell_width`), поэтому колонки не зависят от кегля.
    COLUMNS = (
        ("Товар", 0, "left"),
        ("на борту", 11, "right"),
        ("нужно", 7, "right"),
        ("ост.", 6, "right"),
    )
    #: Ключи ячеек строки в том же порядке, что и `COLUMNS`.
    CELL_KEYS = ("name", "board", "need", "tail")
    #: Номера колонок, которые печатаем жирным (числа важнее подписей).
    BOLD_COLUMNS = (1, 3)

    def __init__(self, master, settings: Dict[str, Any]):
        super().__init__(
            master, "CARRIER",
            settings.get("carrier_x", 1060), settings.get("carrier_y", 430),
            settings.get("carrier_width", 330), settings.get("carrier_height", 300),
            settings, "carrier",
        )
        self.body.addWidget(hud_section(self.content, "Carrier status",
                                       size=self._font_size - 2))
        self.carrier_header = hud_panel(self.content, margins=(6, 4))
        header_layout = self.carrier_header.layout_
        self.name_label = self.make_label(self.carrier_header, "FLEET CARRIER",
                                          color=COLOR_ACCENT, dp=1, bold=True)
        self.callsign_label = self.make_label(self.carrier_header, "",
                                              color=COLOR_TEXT_MUTED, dp=-1,
                                              align_right=True)
        header_layout.addWidget(self.name_label, 1)
        header_layout.addWidget(self.callsign_label)
        self.body.addWidget(self.carrier_header)

        self.total_label = self.make_label(self.content, "— / — t", dp=0)
        self.body.addWidget(self.total_label)

        self.cargo_bar_bg = QWidget(self.content)
        bar_layout = QVBoxLayout(self.cargo_bar_bg)
        bar_layout.setContentsMargins(0, 2, 0, 2)
        bar_layout.setSpacing(0)
        self.cargo_bar = HudBar(self.cargo_bar_bg, color=COLOR_ACCENT, height=6)
        bar_layout.addWidget(self.cargo_bar)
        self.body.addWidget(self.cargo_bar_bg)

        self.detail_label = self.make_label(self.content, "", color=COLOR_TEXT_MUTED,
                                            dp=-1, wrap=True)
        self.body.addWidget(self.detail_label)
        self.project_label = self.make_label(self.content, "", color=COLOR_CYAN,
                                             dp=-1, bold=True, wrap=True)
        self.body.addWidget(self.project_label)

        self.items_header = hud_section(self.content, "Cargo manifest",
                                        size=self._font_size - 2)
        self.body.addWidget(self.items_header)

        self._name_chars = self._name_width_chars()
        self.list_frame = QWidget(self.content)
        list_layout = QVBoxLayout(self.list_frame)
        list_layout.setContentsMargins(0, 0, 0, 0)
        list_layout.setSpacing(2)

        self.columns = QWidget(self.list_frame)
        columns_layout = QHBoxLayout(self.columns)
        columns_layout.setContentsMargins(0, 0, 0, 0)
        columns_layout.setSpacing(6)
        self._header_cells = []
        for index, (text, chars, align) in enumerate(self.COLUMNS):
            text = tr(text)
            label = self.make_label(self.columns, text, color=COLOR_TEXT_MUTED,
                                    dp=-1, bold=index in self.BOLD_COLUMNS,
                                    align_right=align == "right")
            width = self._cell_width(chars)
            if width:
                label.setFixedWidth(width)
            self._header_cells.append((label, chars))
            columns_layout.addWidget(label, 1 if not width else 0)
        list_layout.addWidget(self.columns)

        self.canvas = QScrollArea(self.list_frame)
        self.canvas.setWidgetResizable(True)
        self.canvas.setFrameShape(QFrame.NoFrame)
        # Строки уже подогнаны под ширину блока — горизонтальная прокрутка
        # здесь только съедала бы место у цифр.
        self.canvas.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.canvas.setMinimumHeight(60)
        self.canvas.setStyleSheet(
            f"QScrollArea{{background:{COLOR_PANEL};border:0;}}")
        self.inner = _RowsHost(self.canvas)
        self.inner.setStyleSheet(f"background:{COLOR_PANEL};")
        self.canvas.setWidget(self.inner)
        list_layout.addWidget(self.canvas, 1)
        self.body.addWidget(self.list_frame, 1)

        self.summary_label = self.make_label(self.content, "", color=COLOR_CYAN,
                                             dp=-1, bold=True, wrap=True)
        self.body.addWidget(self.summary_label)

        self._row_pool: list = []
        self._row_order: list = []
        self._empty_label: Optional[QLabel] = None
        self._scroll_job = None
        self._last_carrier_data: Dict[str, Any] = {}
        self.update_carrier({})

    def update_carrier(self, data: Optional[dict]) -> None:
        """Обновить блок. `data` — `CarrierState.get_state_dict(need)`."""
        data = dict(data or {})
        self._last_carrier_data = data

        stats_seen = bool(data.get("stats_seen"))
        name = str(data.get("name") or "").strip()
        self.name_label.setText(name or "Fleet Carrier")
        callsign = str(data.get("callsign") or "").strip()
        system = str(data.get("system_name") or "").strip()
        # Вид носителя виден сразу: личный Drake-Class, эскадренный
        # Javelin-Class или чужой.
        kind = str(data.get("kind") or "")
        if kind == "squadron":
            kind_mark = tr("эскадр.")
        elif kind == "other" and data.get("at_carrier") and not stats_seen:
            kind_mark = tr("чужой")
        else:
            kind_mark = ""
        head = " · ".join(part for part in (callsign or system, kind_mark) if part)
        self.callsign_label.setText(head)
        paint(self.callsign_label,
              color=COLOR_ACCENT if kind == "squadron" else COLOR_TEXT_MUTED)

        stored = int(data.get("stored") or 0)
        capacity = int(data.get("cargo_capacity") or 0)
        pct = int(data.get("fill_percent") or 0)

        if stats_seen and capacity > 0:
            # «≈» — тоннаж сдвинут нашими переводами после последнего
            # CarrierStats: цифра живая, но это уже оценка.
            mark = "≈" if data.get("stored_estimated") else ""
            self.total_label.setText(f"{mark}{stored} / {capacity} t")
            self.cargo_bar.set_fraction(pct / 100.0)
            self.cargo_bar.set_color(
                COLOR_GREEN_TEXT if pct < 80
                else (COLOR_YELLOW if pct < 100 else COLOR_RED_TEXT))
        else:
            # Без CarrierStats тоннаж неизвестен: показываем только учтённое
            # поимённо и честно пишем, откуда цифра.
            tracked = int(data.get("tracked_total") or 0)
            self.total_label.setText(
                tr("{tons} t (учтено по журналу)", tons=tracked) if tracked
                else tr("Тоннаж неизвестен"))
            self.cargo_bar.set_fraction(0)

        details = []
        if stats_seen:
            details.append(tr("свободно {tons} t", tons=int(data.get("free") or 0)))
            if int(data.get("reserved") or 0):
                details.append(tr("резерв {tons} t", tons=int(data.get("reserved") or 0)))
            if int(data.get("untracked") or 0):
                details.append(tr("прочее {tons} t", tons=int(data.get("untracked") or 0)))
        if bool(data.get("pending_decommission")):
            details.append(tr("списывается!"))
        if bool(data.get("at_carrier")):
            details.append(tr("вы на борту"))
        jump_system = str(data.get("jump_system") or "").strip()
        if jump_system:
            details.append(tr("прыжок → {system}", system=jump_system[:24]))
        elif data.get("location_estimated") and system:
            details.append(f"≈ {system[:24]}")
        services = [str(item) for item in (data.get("services") or []) if item]
        detail_text = "  ·  ".join(details)
        if services:
            shown = ", ".join(services[:4]) + (
                f" +{len(services) - 4}" if len(services) > 4 else "")
            detail_text = ((f"{detail_text}\n" if detail_text else "")
                           + tr("службы: {list}", list=shown))
        self.detail_label.setText(detail_text)

        rows = list(data.get("commodities") or [])
        mode = self.settings.get("carrier_filter", "all")
        query = self.settings.get("carrier_search", "")
        shown = filter_carrier_rows(rows, mode, query)
        filtered = mode != "all" or bool(query)
        self._render_rows(
            shown,
            tr("Нет товаров по фильтру") if filtered and rows else self._empty_text(data))

        need_label = str(data.get("need_label") or "").strip()
        need_source = str(data.get("need_source") or "").strip()
        need_total = int(data.get("need_total") or 0)
        if need_label and need_total > 0:
            kind_label = (tr("Проект (основной)") if need_source == "project"
                          else tr("Стройплощадка"))
            self.project_label.setText(tr(
                "{kind}: {name}\nнужно {tons} t",
                kind=kind_label, name=need_label, tons=need_total))
        elif need_label:
            self.project_label.setText(tr(
                "Проект: {name} · потребность закрыта", name=need_label))
        else:
            self.project_label.setText(
                tr("Проект не выбран — отметьте основной во вкладке «Колонизатор»"))

        tracked_total = int(data.get("tracked_total") or 0)
        delivered_total = int(data.get("delivered_total") or 0)
        if need_total > 0:
            left = sum(int(row.get("remaining") or 0) for row in rows)
            have = sum(int(row.get("amount") or 0) for row in rows)
            summary = tr("На борту {have} / {need} t · осталось {left} t",
                         have=have, need=need_total, left=left)
            color = COLOR_GREEN_TEXT if left == 0 else COLOR_CYAN
        elif stats_seen:
            summary = tr("На борту {tons} t · свободно {free} t",
                         tons=stored, free=int(data.get("free") or 0))
            color = COLOR_ACCENT
        else:
            summary = ""
            color = COLOR_CYAN

        cargo_source = str(data.get("cargo_source") or "")
        if not cargo_source:
            cargo_source = "remote" if data.get("remote_seen") else (
                "journal" if (tracked_total or delivered_total) else "")
        source = {
            "server": tr("груз: сайт проекта"),
            "remote": "груз: Raven Colonial",
            "journal": tr("груз: по журналу (только ваши перевозки)"),
            "estimate": tr("груз: оценка, сведена с CarrierStats"),
        }.get(cargo_source, "")
        if cargo_source == "server" and int(data.get("server_age") or 0) >= 15:
            source = tr("{source} ({minutes} мин назад)",
                        source=source, minutes=int(data.get("server_age") or 0))
        if delivered_total and need_total:
            source = tr("{source} · завезено вами {tons} t",
                        source=source, tons=delivered_total).strip(" ·")
        if source:
            summary = f"{summary}\n{source}" if summary else source

        others = [row for row in (data.get("other_carriers") or []) if row]
        if others:
            parts = [
                f"{str(row.get('name') or '')[:18]} {int(row.get('tracked_total') or 0)} t"
                for row in others[:3]
            ]
            summary = ((f"{summary}\n" if summary else "")
                       + tr("ещё носители: {list}", list=", ".join(parts)))

        prefix = (tr("Показано {shown} / {total} · итоги по всем товарам\n",
                     shown=len(shown), total=len(rows)) if filtered else "")
        self.summary_label.setText(prefix + summary)
        paint(self.summary_label, color=color)

    # -- список товаров ----------------------------------------------------
    def _cell_width(self, chars: int) -> int:
        """Ширина колонки в пикселях по реальному шрифту блока."""
        if not chars:
            return 0
        metrics = self.name_label.fontMetrics()
        return max(10, metrics.horizontalAdvance("0" * int(chars)) + 2)

    def _name_width_chars(self) -> int:
        """Сколько символов помещается в колонку «Товар» при текущей ширине."""
        try:
            width_px = int(self.settings.get("carrier_width", 330) or 330)
        except (TypeError, ValueError):
            width_px = 330
        char_px = float(self.name_label.fontMetrics().averageCharWidth()) or 7.0
        numeric = sum(self._cell_width(chars) for _text, chars, _anchor in self.COLUMNS[1:])
        available = int((width_px - 40 - numeric) / char_px)
        return max(8, min(40, available))

    def _make_row(self) -> dict:
        """Одна строка списка: те же ширины колонок, что и у шапки."""
        frame = QWidget(self.inner)
        frame.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)
        cells = {}
        for index, (_text, chars, align) in enumerate(self.COLUMNS):
            cell = self.make_label(frame, "", dp=-1,
                                   bold=index in self.BOLD_COLUMNS,
                                   align_right=align == "right")
            width = self._cell_width(chars)
            if width:
                cell.setFixedWidth(width)
            layout.addWidget(cell, 1 if not width else 0)
            cells[self.CELL_KEYS[index]] = cell
        self.inner.add(frame)
        return {"frame": frame, "cells": cells}

    #: Что писать вместо списка товаров, когда показывать нечего. Это ключ
    #: перевода: подпись берётся из :meth:`empty_default`, иначе текст остался
    #: бы русским при любом языке интерфейса.
    EMPTY_DEFAULT = ("[ Нет данных по товарам ]\nОткройте Carrier Management\n"
                     "или пристыкуйтесь к авианосцу")

    @classmethod
    def empty_default(cls) -> str:
        """Подпись «данных по товарам нет» на текущем языке."""
        return tr(cls.EMPTY_DEFAULT)

    @classmethod
    def _empty_text(cls, data: dict) -> str:
        """Почему список пуст — это разные ситуации, и врать нельзя."""
        data = data or {}
        if not data.get("stats_seen"):
            return cls.empty_default()
        stored = int(data.get("stored") or 0)
        if stored <= 0:
            return tr("[ Трюм пуст ]\nПо CarrierStats на борту 0 t")
        if str(data.get("reconciled") or "") == "dropped":
            return tr("[ Состав груза неизвестен ]\nНа борту {tons} t по CarrierStats,\n"
                      "поимённый учёт устарел", tons=stored)
        return cls.empty_default()

    def _render_rows(self, rows: list, empty_text: str = "") -> None:
        """Обновить список, переиспользуя виджеты (без мерцания текста)."""
        if self._empty_label is None:
            self._empty_label = self.make_label(
                self.inner, empty_text or self.empty_default(),
                color=COLOR_TEXT_MUTED, dp=-1)
            self.inner.add(self._empty_label)

        if not rows:
            if self._row_order:
                for entry in self._row_pool:
                    entry["frame"].hide()
                self._row_order = []
            self._empty_label.setText(empty_text or self.empty_default())
            self._empty_label.show()
            return

        self._empty_label.hide()
        while len(self._row_pool) < len(rows):
            self._row_pool.append(self._make_row())

        order = [str(row.get("key") or row.get("name") or index)
                 for index, row in enumerate(rows)]
        if order != self._row_order:
            for entry in self._row_pool:
                entry["frame"].hide()
            for index in range(len(rows)):
                self._row_pool[index]["frame"].show()
            self._row_order = order

        for index, row in enumerate(rows):
            cells = self._row_pool[index]["cells"]
            amount = int(row.get("amount") or 0)
            delivered = int(row.get("delivered") or 0)
            need = int(row.get("need") or 0)
            remaining = int(row.get("remaining") or 0)

            on_board = (f"{amount} ({delivered})"
                        if delivered and delivered < amount else f"{amount}")
            if need > 0:
                tail = f"-{remaining}" if remaining > 0 else "OK"
                tail_color = COLOR_RED_TEXT if remaining > 0 else COLOR_GREEN_TEXT
                board_color = COLOR_GREEN_TEXT if remaining == 0 else COLOR_ACCENT
            else:
                tail, tail_color, board_color = "", COLOR_TEXT_MUTED, COLOR_TEXT

            label = str(row.get("name") or row.get("key") or "")
            if len(label) > self._name_chars:
                label = label[: self._name_chars - 1] + "…"
            cells["name"].setText(label)
            paint(cells["name"], color=COLOR_TEXT)
            cells["board"].setText(on_board)
            paint(cells["board"], color=board_color)
            cells["need"].setText(str(need) if need else "—")
            paint(cells["need"], color=COLOR_TEXT_MUTED)
            cells["tail"].setText(tail)
            paint(cells["tail"], color=tail_color)


# ============================================================
#  EXOBIO
# ============================================================
# ============================================================
#  FOOTMAP — миникарта пешехода
# ============================================================
#: Языки с запятой в дробях: так же, как в игре на этих языках.
DECIMAL_COMMA_LOCALES = ("ru", "de", "it")


def foot_distance_text(meters: float) -> str:
    """Расстояние для HUD: «12 м», «1,2 км» — в записи текущего языка."""
    value, unit = foot_map.split_distance(meters)
    text = f"{value:g}"
    if current_locale() in DECIMAL_COMMA_LOCALES:
        text = text.replace(".", ",")
    return tr("{n} м", n=text) if unit == "m" else tr("{n} км", n=text)


def foot_coordinate(value: float, positive: str, negative: str) -> str:
    """Координата как на карте игры: ``12.3456°N``."""
    number = float(value or 0.0)
    return f"{abs(number):.4f}°{positive if number >= 0 else negative}"


#: Как назвать точку, у которой нет имени: вид точки на текущем языке.
POI_KIND_KEYS = {
    foot_map.POI_SHIP: "корабль",
    foot_map.POI_SRV: "ровер",
    foot_map.POI_SETTLEMENT: "поселение",
    foot_map.POI_STATION: "порт",
}


def foot_poi_title(poi: Dict[str, Any]) -> str:
    """Подпись точки: её имя, а если имени нет — вид точки."""
    name = str((poi or {}).get("name") or "").strip()
    if name:
        return name
    key = POI_KIND_KEYS.get(str((poi or {}).get("kind") or ""), "")
    return tr(key) if key else ""


class FootMapCanvas(QWidget):
    """Круглая миникарта: след, корабль, ровер, поселения и образцы.

    Круги образцов — не украшение: радиус круга равен клональной колонии рода,
    и внутри него следующий образец того же вида игра не засчитает.

    Карта развёрнута по курсу — впереди всегда верх экрана; север показывает
    буква на кольце. Масштаб подбирает `foot_map` по дальности корабля и
    длине следа, поэтому далёкая стоянка не выкидывает карту за край.
    """

    PADDING = 9
    #: Цвет точки по её виду.
    POI_COLORS = {
        foot_map.POI_SHIP: COLOR_ACCENT,
        foot_map.POI_SRV: COLOR_YELLOW,
        foot_map.POI_SETTLEMENT: COLOR_CYAN,
        foot_map.POI_STATION: COLOR_GREEN_TEXT,
    }
    #: Круг образца: зелёный — биология, цвет тот же у всех родов.
    SAMPLE_COLOR = COLOR_GREEN_TEXT
    #: Сколько подписей у точек рисуем: остальные — только метки.
    POI_LABELS = 3
    #: Отступ метки от кольца: значок должен читаться, а не срезаться краем.
    EDGE_INSET = 7.0
    #: Ближе этого к центру метку отодвигаем: под стрелкой её не видно.
    CENTER_GUARD = 11.0
    #: Меньше этого круг образца не рисуем: при масштабе в десятки километров
    #: кольцо в 100 м — доли пикселя, и радиус «пропадал» с карты. Настоящий
    #: радиус при этом написан строкой над картой.
    SAMPLE_MIN_RADIUS_PX = 4.0

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(140)
        self.setAttribute(Qt.WA_StyledBackground, True)
        self.setStyleSheet(f"background:{COLOR_SURFACE};border:1px solid {COLOR_LINE};")
        self._state: Dict[str, Any] = foot_map.empty_state()
        self._family = "Consolas"
        self._size = 8
        self._empty_text = ""

    def set_font_spec(self, family: Optional[str], size: int) -> None:
        self._family = str(family or "Consolas")
        self._size = max(6, int(size))
        self.update()

    def set_empty_text(self, text: str) -> None:
        self._empty_text = str(text or "")

    def set_state(self, state: Dict[str, Any]) -> None:
        self._state = dict(state or foot_map.empty_state())
        self.update()

    def state(self) -> Dict[str, Any]:
        return self._state

    # -- рисование ---------------------------------------------------------
    def paintEvent(self, event) -> None:  # noqa: N802 - имя из Qt
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        rect = self.rect().adjusted(0, 0, -1, -1)
        painter.fillRect(rect, QColor(COLOR_SURFACE))
        painter.setPen(QPen(QColor(COLOR_LINE), 1))
        painter.drawRect(rect)

        state = self._state or {}
        if not state.get("known"):
            painter.setPen(QPen(QColor(COLOR_TEXT_MUTED), 1))
            painter.setFont(hud_font(self._family, self._size))
            painter.drawText(rect.adjusted(10, 0, -10, 0),
                             Qt.AlignCenter | Qt.TextWordWrap, self._empty_text)
            return

        size = min(rect.width(), rect.height()) - 2 * self.PADDING
        if size <= 20:
            return
        radius = size / 2.0
        center = QPointF(rect.center().x() + 0.5, rect.center().y() + 0.5)
        scale = max(1.0, float(state.get("scale") or 100))
        px_per_m = radius / scale
        heading = float(state.get("heading") or 0.0)

        painter.save()
        painter.setClipRect(rect.adjusted(1, 1, -1, -1))
        # Диск радара чуть светлее фона: карта читается как отдельный прибор.
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(QColor(COLOR_PANEL)))
        painter.drawEllipse(center, radius, radius)
        painter.setBrush(Qt.NoBrush)
        self._draw_grid(painter, center, radius)
        # Круги образцов — под следом и метками: это фон, а не главное.
        self._draw_samples(painter, center, radius, px_per_m, heading, state)
        self._draw_trail(painter, center, radius, px_per_m, heading, state)
        self._draw_pois(painter, center, radius, px_per_m, heading, state)
        self._draw_north(painter, center, radius, heading)
        self._draw_readouts(painter, center, radius, scale, state)
        self._draw_pilot(painter, center)
        painter.restore()

    def _chip(self, painter: QPainter, right: float, baseline: float, text: str,
              align_right: bool = False) -> None:
        """Плашка с числом: подпись читается и поверх линий и меток."""
        if not text:
            return
        font = hud_font(self._family, self._size - 1)
        painter.setFont(font)
        width = QFontMetricsF(font).horizontalAdvance(text) + 10
        left = right - width if align_right else right
        box = QRectF(left, baseline - 13, width, 13)
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(QColor(COLOR_PANEL)))
        painter.drawRoundedRect(box, 3, 3)
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(QColor(COLOR_TEXT_MUTED), 1))
        painter.drawText(box, Qt.AlignCenter, text)

    def _draw_readouts(self, painter: QPainter, center: QPointF, radius: float,
                       scale: float, state: Dict[str, Any]) -> None:
        """Мелкие цифры по углам диска: курс, высота и масштаб кольца.

        Курс и высота — подписи состояния, масштаб — радиус внешнего кольца:
        без него карта не отвечает на вопрос «а это сколько метров?».
        """
        left = center.x() - radius + 5
        right = center.x() + radius - 5
        self._chip(painter, left, center.y() - radius + 17,
                   tr("курс {value}°", value=f"{float(state.get('heading') or 0):.0f}"))
        self._chip(painter, right, center.y() + radius - 4,
                   foot_distance_text(scale), align_right=True)
        altitude = state.get("altitude")
        if altitude is not None:
            self._chip(painter, left, center.y() + radius - 4,
                       tr("высота {value} м", value=f"{float(altitude):.0f}"))

    def _draw_grid(self, painter: QPainter, center: QPointF, radius: float) -> None:
        """Концентрические кольца и перекрестье по курсу."""
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(QColor(COLOR_LINE), 1))
        for fraction in (0.25, 0.5, 0.75, 1.0):
            ring = radius * fraction
            painter.drawEllipse(center, ring, ring)
        painter.setPen(QPen(QColor(COLOR_LINE), 1, Qt.DashLine))
        painter.drawLine(QPointF(center.x() - radius, center.y()),
                         QPointF(center.x() + radius, center.y()))
        painter.drawLine(QPointF(center.x(), center.y() - radius),
                         QPointF(center.x(), center.y() + radius))


    def _draw_trail(self, painter: QPainter, center: QPointF, radius: float,
                    px_per_m: float, heading: float, state: Dict[str, Any]) -> None:
        """След прогулки: тонкая линия от старых точек к текущей."""
        points = state.get("trail") or []
        if len(points) < 2:
            return
        path = QPainterPath()
        started = False
        for east, north in points:
            x, y = foot_map.to_screen(east, north, heading, px_per_m, center.x(), center.y())
            if started:
                path.lineTo(QPointF(x, y))
            else:
                path.moveTo(QPointF(x, y))
                started = True
        if started:
            # Последний отрезок — от запомненной точки до самого командира.
            path.lineTo(center)
        color = QColor(COLOR_CYAN)
        color.setAlpha(150)
        painter.setPen(QPen(color, 1.4))
        painter.setBrush(Qt.NoBrush)
        painter.drawPath(path)

    def _draw_samples(self, painter: QPainter, center: QPointF, radius: float,
                      px_per_m: float, heading: float,
                      state: Dict[str, Any]) -> None:
        """Круги образцов: где снят образец и докуда нельзя ставить следующий.

        Радиус круга — клональная колония рода (от 100 м у анемоны до 1000 м у
        Electricae). Пока командир внутри круга, следующий образец того же вида
        игра не засчитает, поэтому круг масштабный, а не декоративный.
        """
        samples = state.get("samples") or []
        if not samples:
            return
        disc = QPainterPath()
        disc.addEllipse(center, max(1.0, radius - 1), max(1.0, radius - 1))
        painter.save()
        painter.setClipPath(disc, Qt.IntersectClip)
        for row in samples:
            x, y = foot_map.to_screen(float(row.get("east") or 0.0),
                                      float(row.get("north") or 0.0),
                                      heading, px_per_m, center.x(), center.y())
            circle = max(self.SAMPLE_MIN_RADIUS_PX,
                         float(row.get("radius") or 0.0) * px_per_m)
            color = QColor(self.SAMPLE_COLOR)
            color.setAlpha(160)
            painter.setPen(QPen(color, 1.0, Qt.DashLine))
            if circle <= radius * 3:
                # Огромный круг залил бы весь диск: тогда остаётся только кольцо.
                fill = QColor(color)
                fill.setAlpha(16)
                painter.setBrush(QBrush(fill))
            else:
                painter.setBrush(Qt.NoBrush)
            painter.drawEllipse(QPointF(x, y), circle, circle)
            painter.setBrush(Qt.NoBrush)
            # Сам образец — точка в центре: кольцо легко принять за что-то иное.
            painter.setPen(Qt.NoPen)
            painter.setBrush(QBrush(color))
            painter.drawEllipse(QPointF(x, y), 1.8, 1.8)
            painter.setBrush(Qt.NoBrush)
        painter.restore()

    def _draw_pois(self, painter: QPainter, center: QPointF, radius: float,
                   px_per_m: float, heading: float,
                   state: Dict[str, Any]) -> None:
        """Корабль, ровер, поселения и порты: метка плюс подпись у ближайших.

        Точка никогда не пропадает с карты молча: если масштаб не вмещает её,
        метка ставится на само кольцо и обводится пунктиром — «дальше, за
        краем». Раньше такие точки просто не рисовались, и корабль в 4 км
        («корабль: 4,2 км» строкой ниже) на карте отсутствовал.
        """
        pois = state.get("pois") or []
        if not pois:
            return
        limit = max(4.0, min(radius - self.EDGE_INSET, radius - 1.0))
        # Корабль — поверх остальных меток: его ищут в первую очередь.
        draw_order = {foot_map.POI_SHIP: 2, foot_map.POI_SRV: 1}
        placed: List[tuple] = []
        for poi in sorted(pois, key=lambda row: draw_order.get(row.get("kind"), 0)):
            east = float(poi.get("east") or 0.0)
            north = float(poi.get("north") or 0.0)
            x, y = foot_map.to_screen(east, north, heading, px_per_m, center.x(), center.y())
            dx, dy, edge = foot_map.clamp_marker_offset(
                x - center.x(), y - center.y(), limit, self.CENTER_GUARD)
            x = center.x() + dx
            y = center.y() + dy
            color = QColor(self.POI_COLORS.get(poi.get("kind"), COLOR_TEXT))
            painter.setPen(QPen(color, 1.2))
            painter.setBrush(QBrush(color))
            kind = poi.get("kind")
            if kind == foot_map.POI_SHIP:
                self._draw_ship_marker(painter, x, y, color)
            elif kind == foot_map.POI_SRV:
                self._draw_srv_marker(painter, x, y, color)
            elif kind == foot_map.POI_STATION:
                self._draw_port_marker(painter, x, y, color)
            elif kind == foot_map.POI_SETTLEMENT:
                self._draw_settlement_marker(painter, x, y, color)
            else:
                painter.drawEllipse(QPointF(x, y), 2.4, 2.4)
            painter.setBrush(Qt.NoBrush)
            if edge:
                # Пунктирное кольцо: точка на самом деле дальше края карты.
                painter.setPen(QPen(color, 1.0, Qt.DotLine))
                painter.drawEllipse(QPointF(x, y), 6.0, 6.0)
                painter.setPen(QPen(color, 1.2))
            placed.append((poi, x, y))

        metrics = QFontMetricsF(hud_font(self._family, self._size - 1))
        labelled = 0
        # Плашки курса, высоты и масштаба рисуются поверх карты: подписи точек
        # в их полосы не заходят, иначе текст обрезается плашкой.
        band = 18.0
        taken: List[QRectF] = [
            QRectF(center.x() - radius, center.y() - radius, 2 * radius, band),
            QRectF(center.x() - radius, center.y() + radius - band, 2 * radius, band),
            # И сам командир в центре: подпись поверх стрелки читается хуже метки.
            QRectF(center.x() - 14, center.y() - 12, 28, 22),
        ]
        # Подписи — ближайшим точкам, как и раньше (order by distance).
        for poi, x, y in sorted(placed, key=lambda item: float(item[0].get("distance") or 0.0)):
            if labelled >= self.POI_LABELS:
                break
            color = QColor(self.POI_COLORS.get(poi.get("kind"), COLOR_TEXT))
            # У поселения и порта подпись — имя. У корабля и ровера имени нет,
            # поэтому пишем вид точки и расстояние: «ровер 45 м» понятнее
            # одинокой цифры у метки.
            caption = str(poi.get("name") or "").strip()
            if not caption:
                distance_text = foot_distance_text(float(poi.get("distance") or 0.0))
                caption = f"{foot_poi_title(poi)} {distance_text}".strip()
            if poi.get("pad"):
                # Номер площадки — первое, что ищут глазами при посадке в порту.
                caption = f"{caption} · {tr('площадка {pad}', pad=poi['pad'])}"
            limit_text = max(30.0, 2 * radius - 12)
            text = metrics.elidedText(caption, Qt.ElideRight, limit_text)
            width = metrics.horizontalAdvance(text) + 2
            left = x + 6 if x + 6 + width <= center.x() + radius else x - 6 - width
            painter.setPen(QPen(color, 1))
            painter.setFont(hud_font(self._family, self._size - 1))
            # Подписи не должны налезать друг на друга: сдвигаем по вертикали,
            # пока место не освободится, и только потом отступаемся.
            for shift in (0.0, -11.0, 11.0, -22.0, 22.0, -33.0):
                box = QRectF(left, y + shift - 9, width, 12)
                if not any(box.intersects(other) for other in taken):
                    painter.drawText(QPointF(left, y + shift + 4), text)
                    taken.append(box)
                    labelled += 1
                    break

    @staticmethod
    def _draw_srv_marker(painter: QPainter, x: float, y: float, color: QColor) -> None:
        """Ровер — ромб: заметен и в толпе меток, и у края круга образца."""
        diamond = QPolygonF([QPointF(x, y - 4.2), QPointF(x + 3.6, y),
                             QPointF(x, y + 4.2), QPointF(x - 3.6, y)])
        painter.setBrush(QBrush(color))
        painter.drawPolygon(diamond)
        painter.setBrush(Qt.NoBrush)

    @staticmethod
    def _draw_settlement_marker(painter: QPainter, x: float, y: float,
                                color: QColor) -> None:
        """Поселение — домик: стены и крыша, как на карте игры.

        Контуром, а не заливкой: поселений вокруг много, и залитые домики
        слились бы в пятно, закрыв собой ровер и корабль.
        """
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(color, 1.2))
        painter.drawRect(QRectF(x - 3.0, y - 1.4, 6.0, 5.0))
        painter.drawPolygon(QPolygonF([QPointF(x - 4.2, y - 1.4), QPointF(x, y - 5.0),
                                       QPointF(x + 4.2, y - 1.4)]))

    @staticmethod
    def _draw_port_marker(painter: QPainter, x: float, y: float, color: QColor) -> None:
        """Планетарный порт — площадка в рамке: квадрат с точкой в центре.

        Домик без крыши и точка внутри: порт от поселения отличает наличие
        посадочной площадки, поэтому она и нарисована.
        """
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(color, 1.2))
        painter.drawRect(QRectF(x - 3.6, y - 3.6, 7.2, 7.2))
        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(color))
        painter.drawEllipse(QPointF(x, y), 1.5, 1.5)
        painter.setBrush(Qt.NoBrush)

    @staticmethod
    def _draw_ship_marker(painter: QPainter, x: float, y: float, color: QColor) -> None:
        """Корабль — домик-треугольник: его ищут в первую очередь."""
        triangle = QPolygonF([QPointF(x, y - 4.5), QPointF(x + 4.0, y + 3.0),
                              QPointF(x - 4.0, y + 3.0)])
        painter.setBrush(QBrush(color))
        painter.drawPolygon(triangle)
        painter.setBrush(Qt.NoBrush)

    def _draw_north(self, painter: QPainter, center: QPointF, radius: float,
                    heading: float) -> None:
        """Буква «север» на кольце: карта повёрнута по курсу."""
        angle = math.radians(heading)
        x = center.x() - math.sin(angle) * (radius - 8)
        y = center.y() - math.cos(angle) * (radius - 8)
        painter.setPen(QPen(QColor(COLOR_TEXT_MUTED), 1))
        painter.setFont(hud_font(self._family, self._size - 1, bold=True))
        painter.drawText(QRectF(x - 8, y - 8, 16, 16), Qt.AlignCenter, tr("С"))

    def _draw_pilot(self, painter: QPainter, center: QPointF) -> None:
        """Командир в центре: стрелка вперёд, потому что карта по курсу."""
        arrow = QPolygonF([QPointF(center.x(), center.y() - 7.5),
                           QPointF(center.x() + 5.5, center.y() + 5.5),
                           QPointF(center.x(), center.y() + 2.5),
                           QPointF(center.x() - 5.5, center.y() + 5.5)])
        painter.setPen(QPen(QColor(COLOR_SURFACE), 1.4))
        painter.setBrush(QBrush(QColor(COLOR_ACCENT)))
        painter.drawPolygon(arrow)
        painter.setBrush(Qt.NoBrush)


class FootMapOverlay(HudWindow):
    """Миникарта пешехода: где командир, где корабль и что рядом.

    Позицию и точки интереса считает `foot_map`, а здесь только печать:
    тело, координаты, сама карта, расстояние до корабля и показатели
    скафандра.
    """

    def __init__(self, master, settings: Dict[str, Any]):
        height = max(settings.get("footmap_height", 400), 220)
        super().__init__(
            master, "FOOTMAP",
            settings.get("footmap_x", 770), settings.get("footmap_y", 650),
            settings.get("footmap_width", 340), height, settings, "footmap",
        )
        self._ff = self._font_family
        self._fs = self._font_size
        self._state: Dict[str, Any] = foot_map.empty_state()
        self._render_key: Optional[tuple] = None
        self._paints = 0

        self.body_label = self.make_label(self.content, tr("ПОВЕРХНОСТЬ НЕ ИЗВЕСТНА"),
                                          color=COLOR_ACCENT, dp=1, bold=True)
        self.body_label.setWordWrap(False)
        self.body.addWidget(self.body_label)

        self.coords_label = self.make_label(self.content, "", color=COLOR_TEXT_MUTED, dp=-2)
        self.body.addWidget(self.coords_label)

        # Где стоит командир: поселение или порт. Внутри поселения его точка на
        # карте — ровно под стрелкой в центре, поэтому по одной карте не видно,
        # что это поселение: строку даёт `foot_map` по расстоянию до точки.
        self.place_label = self.make_label(self.content, "", color=COLOR_ACCENT, dp=-2)
        self.body.addWidget(self.place_label)

        self.canvas = FootMapCanvas(self.content)
        self.canvas.set_empty_text(tr("Позиция с поверхности не получена. "
                                      "Выйдите из корабля на ногах."))
        self.canvas.set_font_spec(self._ff, max(6, int(self._fs) - 2))
        self.body.addWidget(self.canvas, 1)

        self.ship_label = self.make_label(self.content, "", color=COLOR_TEXT, dp=-2)
        self.body.addWidget(self.ship_label)

        # Ровер, поселения и порты: к ним возвращаются, поэтому они идут
        # строкой под картой, а не только метками на кольце.
        self.points_label = self.make_label(self.content, "", color=COLOR_TEXT_MUTED, dp=-2)
        self.body.addWidget(self.points_label)

        # Образцы: сколько собрано и можно ли брать следующий.
        self.sample_label = self.make_label(self.content, "", color=COLOR_TEXT_MUTED, dp=-2)
        self.body.addWidget(self.sample_label)

        self.vitals_label = self.make_label(self.content, "", color=COLOR_TEXT_MUTED, dp=-2)
        self.body.addWidget(self.vitals_label)

    # -- данные ------------------------------------------------------------
    @staticmethod
    def _vitals_text(state: Dict[str, Any]) -> str:
        """Показатели скафандра: кислород, здоровье, температура, гравитация."""
        parts = []
        oxygen = state.get("oxygen")
        if oxygen is not None:
            parts.append(tr("O₂ {value}%", value=f"{float(oxygen):.0f}"))
        health = state.get("health")
        if health is not None:
            parts.append(tr("HP {value}%", value=f"{float(health):.0f}"))
        temperature = state.get("temperature")
        if temperature is not None:
            parts.append(tr("{value} K", value=f"{float(temperature):.0f}"))
        gravity = state.get("gravity")
        if gravity is not None:
            parts.append(tr("{value} g", value=f"{float(gravity):.2f}".rstrip("0").rstrip(".")))
        return "  ·  ".join(parts)

    @staticmethod
    def _vitals_color(state: Dict[str, Any]) -> str:
        """Цвет строки показателей: красный ниже 25 %, жёлтый ниже 50 %."""
        levels = [float(state[key]) for key in ("oxygen", "health")
                  if state.get(key) is not None]
        if not levels:
            return COLOR_TEXT_MUTED
        low = min(levels)
        if low <= 25:
            return COLOR_RED_TEXT
        if low <= 50:
            return COLOR_YELLOW
        return COLOR_TEXT_MUTED

    #: Сколько ближних точек перечисляем под картой.
    MAX_POINT_ROWS = 3

    @staticmethod
    def _place_text(state: Dict[str, Any]) -> str:
        """Где стоит командир: «вы в поселении X» или «вы в порту X».

        Строка появляется только когда командир внутри (`foot_map.PLACE_NEAR_M`):
        иначе это была бы неправда, а ближние точки и так перечислены ниже.
        """
        place = state.get("place") or {}
        if not place:
            return ""
        name = str(place.get("name") or "").strip()
        if place.get("kind") == foot_map.POI_STATION:
            return tr("вы в порту {name}", name=name) if name else tr("вы в порту")
        return tr("вы в поселении {name}", name=name) if name else tr("вы в поселении")

    @classmethod
    def _points_text(cls, state: Dict[str, Any]) -> str:
        """Ближние важные точки строкой: ровер, поселения и порты.

        Корабль сюда не входит: у него своя строка с расстоянием.
        """
        place = state.get("place") or {}
        rows = sorted(
            (poi for poi in state.get("pois") or []
             if poi.get("kind") != foot_map.POI_SHIP),
            key=lambda poi: float(poi.get("distance") or 0.0))
        parts = []
        for poi in rows:
            if place and poi.get("kind") == place.get("kind") \
                    and poi.get("name") == place.get("name"):
                # Это то самое поселение, где стоит командир: о нём уже
                # сказано строкой выше, второй раз оно только занимает место.
                continue
            if len(parts) >= cls.MAX_POINT_ROWS:
                break
            title = foot_poi_title(poi)
            if not title:
                continue
            distance = foot_distance_text(float(poi.get("distance") or 0.0))
            parts.append(f"{title} {distance}")
        return "  ·  ".join(parts)

    @staticmethod
    def _sample_text(state: Dict[str, Any]) -> str:
        """Комплект образцов: сколько собрано и можно ли брать следующий."""
        summary = state.get("sample") or {}
        if not summary:
            return ""
        species = (str(summary.get("species") or "").strip()
                   or str(summary.get("genus") or "").strip() or tr("образец"))
        done = int(summary.get("count") or 0)
        total = int(summary.get("total") or foot_map.SAMPLES_PER_SPECIES)
        radius = foot_distance_text(float(summary.get("radius") or 0.0))
        if summary.get("complete"):
            return tr("{species} · комплект собран · радиус {radius}",
                      species=species, radius=radius)
        # Радиус колонии пишем всегда, а не только после сбора комплекта: по
        # нему видно, докуда нельзя ставить следующий образец, и он же —
        # радиус круга на карте.
        if summary.get("allowed"):
            base = tr("{species} · {done}/{total} · можно брать образец",
                      species=species, done=done, total=total)
        else:
            base = tr("{species} · {done}/{total} · до следующего {distance}",
                      species=species, done=done, total=total,
                      distance=foot_distance_text(float(summary.get("need_m") or 0.0)))
        return f"{base} · {tr('радиус {radius}', radius=radius)}"

    @staticmethod
    def _sample_color(state: Dict[str, Any]) -> str:
        """Зелёный — образец возьмётся, жёлтый — надо отойти дальше."""
        summary = state.get("sample") or {}
        if not summary:
            return COLOR_TEXT_MUTED
        return COLOR_GREEN_TEXT if (summary.get("allowed") or summary.get("complete")) \
            else COLOR_YELLOW

    def update_footmap(self, state: Optional[Dict[str, Any]], force: bool = False) -> None:
        """Нарисовать миникарту по состоянию `foot_map.FootMap.state()`."""
        state = dict(state or foot_map.empty_state())
        self._state = state
        known = bool(state.get("known"))
        body = str(state.get("body") or "").strip()
        self.body_label.setText(body.upper() if body else tr("ПОВЕРХНОСТЬ НЕ ИЗВЕСТНА"))

        if known:
            coords = [
                foot_coordinate(float(state.get("lat") or 0.0), "N", "S"),
                foot_coordinate(float(state.get("lon") or 0.0), "E", "W"),
            ]
            # Высота и курс уже написаны на диске: строка остаётся координатами.
            self.coords_label.setText("  ·  ".join(coords))
        else:
            self.coords_label.setText("")

        self.place_label.setText(self._place_text(state) if known else "")

        ship = state.get("ship") or None
        self.ship_label.setText(
            tr("корабль: {distance}", distance=foot_distance_text(ship["distance"]))
            if ship else "")
        self.points_label.setText(self._points_text(state) if known else "")
        sample_text = self._sample_text(state) if known else ""
        self.sample_label.setText(sample_text)
        paint(self.sample_label,
              color=self._sample_color(state) if sample_text else COLOR_TEXT_MUTED)
        self.vitals_label.setText(self._vitals_text(state) if known else "")
        paint(self.vitals_label, color=self._vitals_color(state) if known else COLOR_TEXT_MUTED)

        key = (known, body, self.coords_label.text(), self.place_label.text(),
               self.ship_label.text(), self.points_label.text(), sample_text,
               self.vitals_label.text(), self.width(), self.height(), int(self._fs))
        if not force and key == self._render_key:
            return
        self._render_key = key
        self._paints += 1
        self.canvas.set_state(state)

    def apply_data_options(self) -> None:
        """Скрыть выключенные разделы блока (карта, координаты, показатели)."""
        super().apply_data_options()
        self.canvas.set_font_spec(self._ff, max(6, int(self._fs) - 2))

    def on_font_changed(self) -> None:
        self.canvas.set_font_spec(self._ff, max(6, int(self._fs) - 2))

    def resizeEvent(self, event) -> None:  # noqa: N802 - имя из Qt
        super().resizeEvent(event)
        # Карта должна перерисоваться под новый размер кольца.
        self._render_key = None
        if self._state:
            self.canvas.set_state(self._state)


class ExobiologyOverlay(HudWindow):
    """Экзобиология: тело, образцы с обратным отсчётом, роды и тела системы.

    Данные — только из журнала игрока (Scan / SAAScanComplete / FSSBodySignals /
    ScanOrganic). Предсказание уровня **род**, упрощённая собственная модель
    (`exobiology.GENUS_RULES`).

    Блок сам обновляется раз в секунду, пока идёт отсчёт до следующего
    образца: общий цикл HUD перерисовывает окно только когда меняются данные
    журнала, а таймер обязан тикать и без них.
    """

    #: Сколько родов, тел системы и найденных планет показываем.
    MAX_PREDICTIONS = 5
    MAX_BODIES = 6
    MAX_PLANETS = 5
    #: Цвета плашек телеметрии: (текст, фон) по состоянию.
    CHIP_BIO_ON = (COLOR_GREEN_TEXT, "#123824")
    CHIP_BIO_OFF = (COLOR_TEXT_MUTED, "#1c2128")
    CHIP_LAND_ON = (COLOR_GREEN_TEXT, "#143823")
    CHIP_LAND_OFF = (COLOR_RED_TEXT, "#381414")
    CHIP_DSS_ON = (COLOR_CYAN, "#0e2a47")
    CHIP_DSS_OFF = (COLOR_TEXT_MUTED, "#1c2128")
    CHIP_BONUS = (COLOR_YELLOW, "#3d3008")
    CHIP_PLAIN = (COLOR_TEXT, "#21262d")

    def __init__(self, master, settings: Dict[str, Any]):
        super().__init__(
            master, "EXOBIO",
            settings.get("exobio_x", 1060), settings.get("exobio_y", 50),
            settings.get("exobio_width", 360), settings.get("exobio_height", 620),
            settings, "exobio",
        )
        self._wrap = max(160, int(settings.get("exobio_width", 360)) - 30)
        # Табличный режим (по умолчанию): разделы печатаются колонками.
        self._table_mode = str(settings.get("exobio_layout", "table")).lower() != "list"
        self._state: Dict[str, Any] = {}
        self._tick: Optional[QTimer] = None
        self._tick_id: Optional[str] = None
        # Применённая видимость разделов: сравниваем, чтобы не дёргать
        # пересборку раскладки на каждом тике.
        self._planets_shown = True
        self._telemetry_shown = True
        self._action_shown = True
        self._signals_shown = True

        # Заголовок тела
        self.body.addWidget(hud_section(self.content, "Target body",
                                        size=self._font_size - 2))
        self.body_label = self.make_label(
            self.content, tr("ТЕЛО / —"), color=COLOR_ACCENT,
            background=COLOR_PANEL_ALT,
            dp=0, bold=True, wrap=self._wrap)
        self.body_label.setContentsMargins(6, 4, 6, 4)
        self.body.addWidget(self.body_label)

        # Полоса значков телеметрии: био, посадка, DSS, бонус, гравитация, T.
        self.telemetry_frame = QWidget(self.content)
        telemetry = QHBoxLayout(self.telemetry_frame)
        telemetry.setContentsMargins(0, 2, 0, 1)
        telemetry.setSpacing(4)
        self.chip_bio = self._chip(telemetry, "", *self.CHIP_BIO_ON)
        self.chip_land = self._chip(telemetry, "", *self.CHIP_LAND_ON)
        self.chip_dss = self._chip(telemetry, "", *self.CHIP_DSS_ON)
        self.chip_footfall = self._chip(telemetry, "", *self.CHIP_BONUS)
        self.chip_grav = self._chip(telemetry, "", *self.CHIP_PLAIN, bold=False)
        self.chip_temp = self._chip(telemetry, "", *self.CHIP_PLAIN, bold=False)
        telemetry.addStretch(1)
        self.body.addWidget(self.telemetry_frame)

        self.params_label = self.make_label(self.content, "", color=COLOR_TEXT_MUTED,
                                            dp=-1, wrap=self._wrap)
        self.body.addWidget(self.params_label)
        self.signals_label = self.make_label(self.content, "", color=COLOR_YELLOW,
                                             dp=-1, wrap=self._wrap)
        self.body.addWidget(self.signals_label)
        self.body.addWidget(hud_separator(self.content))

        self.samples_header = self.make_label(
            self.content, _section_text("B", tr("ОБРАЗЦЫ")),
            color=COLOR_TEXT_MUTED, dp=-1, bold=True)
        self.body.addWidget(self.samples_header)
        self.organics_label = self.make_label(self.content, "—", dp=-1, wrap=self._wrap)
        self.body.addWidget(self.organics_label)

        self.next_action_label = self.make_label(
            self.content, "", color=COLOR_CYAN, background="#10253d", dp=-1,
            bold=True, wrap=self._wrap)
        self.next_action_label.setContentsMargins(6, 2, 6, 2)
        self.body.addWidget(self.next_action_label)
        self.body.addWidget(hud_separator(self.content))

        self.predict_header = self.make_label(
            self.content, _section_text("C", tr("ВЕРОЯТНЫЕ РОДЫ")),
                                              color=COLOR_TEXT_MUTED, dp=-1, bold=True)
        self.body.addWidget(self.predict_header)
        self.predict_label = self.make_label(self.content, tr("нет данных"),
                                             color=COLOR_GREEN_TEXT, dp=-1, wrap=self._wrap)
        self.body.addWidget(self.predict_label)

        # Раздел «Поиск планет» стоит ВЫШЕ списка тел системы: окно не
        # резиновое, и при переполнении обрезается низ.
        self.planet_separator = hud_separator(self.content)
        self.body.addWidget(self.planet_separator)
        self.planets_header = self.make_label(self.content, tr("Поиск планет:"),
                                              color=COLOR_TEXT_MUTED, dp=-1, bold=True)
        self.body.addWidget(self.planets_header)
        self.planets_label = self.make_label(self.content, "—", color=COLOR_GREEN_TEXT,
                                             dp=-1, wrap=self._wrap)
        self.body.addWidget(self.planets_label)

        self.bodies_separator = hud_separator(self.content)
        self.body.addWidget(self.bodies_separator)
        self.bodies_header = self.make_label(self.content, tr("Тела системы:"),
                                             color=COLOR_TEXT_MUTED, dp=-1, bold=True)
        self.body.addWidget(self.bodies_header)
        self.bodies_label = self.make_label(self.content, "—", color=COLOR_TEXT_MUTED,
                                            dp=-1, wrap=self._wrap)
        self.body.addWidget(self.bodies_label)

        self.footer_label = self.make_label(
            self.content, tr("ℹ Прогноз по родам · Оценка выплат ориентировочная"),
            color=COLOR_TEXT_MUTED, dp=-3, wrap=self._wrap)
        self.body.addWidget(self.footer_label)
        self.body.addStretch(1)

    def _chip(self, layout: QHBoxLayout, text: str, color: str, background: str,
              *, bold: bool = True) -> QLabel:
        label = QLabel(text, self.telemetry_frame)
        label.setFont(hud_font(self._font_family, max(7, self._font_size - 3), bold=bold))
        label.setAttribute(Qt.WA_StyledBackground, True)
        label.setStyleSheet(
            f"color:{color};background:{background};border:1px solid {COLOR_BORDER};"
            f"padding:0 4px;")
        layout.addWidget(label)
        return label

    @staticmethod
    def _paint_chip(label: QLabel, text: str, color: str, background: str) -> None:
        label.setText(text)
        label.setStyleSheet(
            f"color:{color};background:{background};border:1px solid {COLOR_BORDER};"
            f"padding:0 4px;")

    # -- контекстное меню блока -------------------------------------------
    def _add_custom_menu_entries(self, menu) -> None:
        menu.addSeparator()
        compact = bool(self.settings.get("exobio_compact", True))
        menu.addAction(
            ("[x] " if compact else "[ ] ") + tr("Компактный вид (значки и шкалы)"),
            self._toggle_compact_mode)
        menu.addAction(
            tr("⊞ Таблица (компактно)") if not self._table_mode
            else tr("≡ Лента (по-старому)"),
            self._toggle_layout_mode)

    def _toggle_layout_mode(self) -> None:
        """Таблица ↔ лента. Режим живёт в настройке, чтобы пережить перезапуск."""
        self._table_mode = not self._table_mode
        self.settings["exobio_layout"] = "table" if self._table_mode else "list"
        self._render()
        self._flash_indicator(COLOR_CYAN)

    def _toggle_compact_mode(self) -> None:
        new_val = not bool(self.settings.get("exobio_compact", True))
        self.settings["exobio_compact"] = new_val
        self._render()
        self._flash_indicator(COLOR_CYAN)

    def _table_width(self) -> int:
        """Сколько символов влезает в строку таблицы при текущем шрифте.

        Ширину символа спрашиваем у самого шрифта: прежняя оценка «доля
        кегля» зависела от того, в чём кегль — в пунктах или пикселях, — и
        таблица вылезала за край окна.
        """
        char = float(self.organics_label.fontMetrics().averageCharWidth())
        return max(32, int(self._wrap / max(4.0, char)))

    @staticmethod
    def _set_table_text(label: QLabel, text: str, color: Optional[str] = None) -> None:
        """Текст-таблица без переноса: перенос внутри таблицы ломает колонки."""
        label.setWordWrap(False)
        label.setText(text)
        if color:
            paint(label, color=color)

    def _table_or_flow(self, label: QLabel, headers: Sequence[str],
                       rows: Sequence[Sequence[object]], flow: str, *,
                       aligns: Optional[Sequence[str]] = None,
                       color: Optional[str] = None) -> None:
        """Таблица, если она влезает по ширине, иначе — обычный текст.

        Таблица нужна, чтобы цифры стояли колонками, но в узком блоке она
        обрезает последний столбец — а там самое важное (статус, причина).
        Поэтому ширину проверяем заранее и при нехватке места печатаем
        строки с переносом.
        """
        width = self._table_width()
        table = format_table(headers, rows, aligns=aligns, max_width=None)
        if max((len(line) for line in table.splitlines()), default=0) <= width:
            self._set_table_text(label, table, color)
            return
        self._set_flow_text(label, flow)
        if color:
            paint(label, color=color)

    @staticmethod
    def _set_flow_text(label: QLabel, text: str) -> None:
        """Обычный текст — с переносом по словам."""
        label.setWordWrap(True)
        label.setText(text)

    def _short_body(self, state: dict, name: object) -> str:
        """Имя тела без префикса системы — в блоке мало места."""
        text = str(name or "?")
        system = str(state.get("system") or "")
        if system and text.startswith(system):
            text = text[len(system):].strip() or text
        return text

    # -- обновление -------------------------------------------------------
    def update_exobiology(self, state: Optional[dict]) -> None:
        """Обновить содержимое. `state` — словарь от `ExobiologyTracker`."""
        self._state = dict(state or {})
        self._render()
        self._schedule_tick()

    def _schedule_tick(self) -> None:
        """Тикать раз в секунду, пока есть незавершённые образцы."""
        if self._tick is not None:
            self._tick.stop()
            self._tick = None
            self._tick_id = None
        if not self._has_pending_samples():
            return
        self._tick = QTimer(self)
        self._tick.setSingleShot(True)
        self._tick.timeout.connect(self._on_tick)
        self._tick.start(1000)
        self._tick_id = "tick"

    def _on_tick(self) -> None:
        self._tick = None
        self._tick_id = None
        try:
            self._render()
            self._schedule_tick()
        except Exception:
            # Оверлей не имеет права ронять приложение.
            pass

    def _has_pending_samples(self) -> bool:
        for row in self._state.get("organics") or []:
            if not row.get("complete") and int(row.get("samples") or 0) > 0:
                return True
        return False

    def destroy(self) -> None:
        if self._tick is not None:
            self._tick.stop()
            self._tick = None
            self._tick_id = None
        super().destroy()

    # -- отрисовка и визуальные элементы ----------------------------------
    @staticmethod
    def _format_prob_bar(percent: Optional[int], length: int = 8) -> str:
        """Визуальная шкала вероятности (LED pips meter)."""
        if percent is None:
            return ""
        try:
            pct = max(0, min(100, int(percent)))
        except (TypeError, ValueError):
            return ""
        filled = int(round((pct / 100.0) * length))
        return "■" * filled + "□" * max(0, length - filled)

    def _set_action_visible(self, visible: bool) -> None:
        if self._action_shown == visible:
            return
        self._action_shown = visible
        self.next_action_label.setVisible(visible)

    def _hide_telemetry_chips(self) -> None:
        if self._telemetry_shown:
            self._telemetry_shown = False
            self.telemetry_frame.setVisible(False)
        if not self._signals_shown:
            self._signals_shown = True
            self.signals_label.setVisible(True)

    def _show_telemetry_chips(self, signals: int, landable: bool, mapped: bool,
                              gravity: float, temp: float, atmo: str,
                              no_first_footfall: Optional[bool] = None,
                              first_footfall_by: str = "") -> None:
        if not self._telemetry_shown:
            self._telemetry_shown = True
            self.telemetry_frame.setVisible(True)
        if self._signals_shown:
            self._signals_shown = False
            self.signals_label.setVisible(False)

        if signals > 0:
            self._paint_chip(self.chip_bio, f"🌿 {signals} BIO", *self.CHIP_BIO_ON)
        else:
            self._paint_chip(self.chip_bio, "🌿 0 BIO", *self.CHIP_BIO_OFF)

        if landable:
            self._paint_chip(self.chip_land, tr("🛬 ПОСАДКА"), *self.CHIP_LAND_ON)
        else:
            self._paint_chip(self.chip_land, tr("⛔ НЕ СЕСТЬ"), *self.CHIP_LAND_OFF)

        if mapped:
            self._paint_chip(self.chip_dss, "📡 DSS ✓", *self.CHIP_DSS_ON)
        else:
            self._paint_chip(self.chip_dss, "📡 DSS ✗", *self.CHIP_DSS_OFF)

        # Бонус первопроходца ×5: плашка есть только когда это про нас.
        if no_first_footfall:
            self._paint_chip(self.chip_footfall, tr("👣 БОНУС ×5"), *self.CHIP_BONUS)
            self.chip_footfall.setVisible(True)
        elif first_footfall_by and first_footfall_by not in ("Вы", "You"):
            self._paint_chip(self.chip_footfall, tr("👣 ЕСТЬ"), *self.CHIP_BIO_OFF)
            self.chip_footfall.setVisible(True)
        else:
            self.chip_footfall.setVisible(False)

        self._paint_chip(self.chip_grav, f"⚖ {gravity / 10.0:.2f}g", *self.CHIP_PLAIN)
        self._paint_chip(self.chip_temp, f"🌡 {temp:.0f}K", *self.CHIP_PLAIN)

    def _render(self) -> None:
        self._render_content()
        self.apply_data_options()

    def _render_content(self) -> None:
        state = self._state
        if not state:
            self.body_label.setText(tr("Тело: —"))
            self.params_label.setText(tr("Отсканируйте тело (FSS или подход)"))
            self.signals_label.setText("")
            self.samples_header.setText(_section_text("B", tr("Образцы")))
            self.organics_label.setText("—")
            self.next_action_label.setText("")
            self._set_action_visible(False)
            self.predict_header.setText(_section_text("C", tr("Вероятные роды")))
            self.predict_label.setText(tr("нет данных"))
            self.bodies_header.setText(_section_text("E", tr("Тела системы")))
            self.bodies_label.setText("—")
            self._hide_telemetry_chips()
            self._render_planets({})
            return

        body_name = str(state.get("body") or "").strip()
        if not body_name:
            # Текущее тело неизвестно (игрок в космосе/на станции), но данные
            # системы могут быть: показываем разделы честно.
            system = str(state.get("system") or "").strip()
            prefix = f"{system} · " if system else ""
            self.body_label.setText(f"{prefix}{tr('Тело: —')}")

            bio_bodies = state.get("system_bodies") or []
            total_bio_signals = sum(int(body.get("bio_signals") or 0) for body in bio_bodies)
            scanned_count = int(state.get("system_scanned_bodies")
                                or state.get("system_known_bodies") or 0)

            if bio_bodies:
                self.params_label.setText(tr(
                    "данных о текущем теле нет — в системе {bodies} тел с "
                    "биосигналами ({signals} сигн.)\n"
                    "подлетите к планете (FSS или подход) или выберите в списке",
                    bodies=len(bio_bodies), signals=total_bio_signals))
                self.signals_label.setText(tr("Биосигналов в системе: {count}",
                                              count=total_bio_signals))
                self.next_action_label.setText(
                    tr("→ выберите планету для высадки и сбора образцов"))
                self._set_action_visible(True)
            elif scanned_count > 0:
                self.params_label.setText(tr(
                    "данных о текущем теле нет — отсканировано {bodies} тел "
                    "(FSS или подход)\nсканируйте другие планеты системы (FSS/DSS)",
                    bodies=scanned_count))
                self.signals_label.setText("")
                self.next_action_label.setText("")
                self._set_action_visible(False)
            else:
                self.params_label.setText(
                    tr("данных о текущем теле нет — отсканируйте тело (FSS или подход)"))
                self.signals_label.setText("")
                self.next_action_label.setText("")
                self._set_action_visible(False)

            self.samples_header.setText(_section_text("B", tr("Образцы")))
            self.organics_label.setText("—")
            self.predict_header.setText(_section_text("C", tr("Вероятные роды")))
            self.predict_label.setText(tr("нет данных"))
            self._hide_telemetry_chips()
            self._render_bodies(state)
            self._render_planets(state)
            return

        system = str(state.get("system") or "").strip()
        body = str(state.get("body") or "—")
        prefix = f"{system} · " if system and system not in body else ""
        planet_class = str(state.get("planet_class") or "?")
        self.body_label.setText(f"{prefix}{body}  ({planet_class})")

        gravity = float(state.get("gravity") or 0.0)
        mapped = bool(state.get("mapped"))
        landable = bool(state.get("landable"))
        signals = int(state.get("bio_signals") or 0)
        temp = float(state.get("temperature") or 0)
        atmo = str(state.get("atmosphere") or tr("нет атмосферы"))
        volc = str(state.get("volcanism") or "")
        no_first_footfall = bool(state.get("no_first_footfall"))
        first_footfall_by = str(state.get("first_footfall_by") or "")

        compact = bool(self.settings.get("exobio_compact", True))
        if compact:
            self._show_telemetry_chips(
                signals=signals, landable=landable, mapped=mapped, gravity=gravity,
                temp=temp, atmo=atmo, no_first_footfall=no_first_footfall,
                first_footfall_by=first_footfall_by)
            volc_text = f"  ·  🌋 {volc}" if volc and volc.lower() != "нет" else ""
            self.params_label.setText(f"🌫 {atmo}{volc_text}")
            self.signals_label.setText(
                tr("Биосигналов: {count}  |  {map}", count=signals,
                   map=tr("карта есть (DSS)") if mapped else tr("карты нет"))
                if signals else
                tr("Биосигналов нет  |  {map}",
                   map=tr("карта есть (DSS)") if mapped else tr("карты нет")))
        else:
            self._hide_telemetry_chips()
            self.params_label.setText(
                f"{atmo}\n"
                + f"T {temp:.0f} K   g {gravity / 10.0:.2f}"
                + "\n"
                + tr("Вулканизм: {volcanism}   {landing}",
                     volcanism=volc or tr("нет"),
                     landing=(tr("посадка возможна") if landable
                              else tr("посадка невозможна"))))
            self.signals_label.setText(
                tr("Биосигналов: {count}  |  {map}", count=signals,
                   map=tr("карта есть (DSS)") if mapped else tr("карты нет"))
                if signals else
                tr("Биосигналов нет  |  {map}",
                   map=tr("карта есть (DSS)") if mapped else tr("карты нет")))

        self._render_samples(state, mapped)
        self._render_predictions(state, mapped)
        self._render_bodies(state)
        self._render_planets(state)

    def _render_samples(self, state: dict, mapped: bool) -> None:
        organics = state.get("organics") or []
        total_value = int(state.get("value_cr") or 0)
        if not total_value:
            total_value = sum(int(row.get("value_cr") or 0) for row in organics)
        no_footfall = bool(state.get("no_first_footfall"))
        bonus_tag = tr(" (бонус ×5)") if no_footfall else ""
        header = (tr("Образцы{bonus}:", bonus=bonus_tag)
                  + (tr("  ≈ {value} кр", value=format_credits(total_value))
                     if total_value else ""))
        self.samples_header.setText(_section_text("B", header))

        if not organics:
            self.organics_label.setText(tr("образцы не взяты"))
            action = self._suggest_next_action(state, [])
            self.next_action_label.setText(action)
            self._set_action_visible(bool(action))
            return

        lines = []
        for row in organics:
            samples = int(row.get("samples") or 0)
            complete = bool(row.get("complete"))
            marks = "●" * min(samples, 3) + "○" * max(0, 3 - min(samples, 3))
            value = int(row.get("value_cr") or 0)
            name = str(row.get("species") or "?")
            if row.get("seen_before"):
                name += tr(" (уже встречалось)")
            status = ""
            if complete:
                status = tr("комплект готов ✓")
            elif samples:
                wait = int(row.get("wait_seconds") or 0)
                stage = str(row.get("stage") or "")
                status = (tr("ждите {seconds} с", seconds=wait)
                          if wait > 0
                          else tr("готов к образцу ({stage}) — смените точку",
                                  stage=stage or "Sample"))
            lines.append((name, f"{marks} {samples}/3",
                          format_credits(value) if value else "—", status, complete))
        flat = []
        for name, marks_value, price_value, status, ready in lines:
            price = "" if price_value in ("", "—") else f"  ≈ {price_value}"
            flat.append(f"{name}  {marks_value}{price}")
            if status:
                flat.append(f"   {'✔ ' if ready else ''}{status}")
        if self._table_mode and lines:
            col_price = tr("≈кр (×5)") if no_footfall else tr("≈кр")
            self._table_or_flow(
                self.organics_label,
                (tr("вид"), tr("образцы"), col_price, tr("статус")),
                [line[:4] for line in lines],
                "\n".join(flat),
                aligns=("left", "left", "right", "left"),
            )
        else:
            self._set_flow_text(self.organics_label, "\n".join(flat))
        action = self._suggest_next_action(state, organics)
        self.next_action_label.setText(action)
        self._set_action_visible(bool(action))

    @staticmethod
    def _suggest_next_action(state: dict, organics: list) -> str:
        """Одна строка-подсказка: что делать прямо сейчас."""
        if not organics:
            signals = int(state.get("bio_signals") or 0)
            if signals:
                return tr("→ найдите организм: биосигналов на теле {count}",
                          count=signals)
            if not state.get("landable", True):
                return tr("→ на это тело не сесть")
            return tr("→ отсканируйте тело, чтобы получить прогноз")
        waiting = [row for row in organics
                   if not row.get("complete") and int(row.get("wait_seconds") or 0) > 0]
        if waiting:
            wait = min(int(row.get("wait_seconds")) for row in waiting)
            return tr("→ {seconds} с до следующего образца", seconds=wait)
        open_rows = [row for row in organics if not row.get("complete")]
        if open_rows:
            return tr("→ возьмите образец с новой точки")
        return tr("→ все комплекты собраны — можно лететь дальше")

    def _render_predictions(self, state: dict, mapped: bool) -> None:
        if not state.get("landable", True):
            self.predict_header.setText(_section_text("C", tr("Вероятные роды")))
            self.predict_label.setText(
                tr("посадка невозможна — био-прогноз отключен"))
            return

        predictions = state.get("predictions") or []
        # Фильтр по родам задаётся на вкладке «Экзобиология».
        allowed = state.get("genera_filter") or []
        if allowed:
            predictions = [row for row in predictions
                           if str(row.get("genus") or "") in {str(g) for g in allowed}]

        no_footfall = bool(state.get("no_first_footfall"))
        self.predict_header.setText(_section_text(
            "C", tr("Вероятные роды") + (tr(" (бонус ×5)") if no_footfall else "")))

        if not predictions:
            self.predict_label.setText(
                tr("роды отфильтрованы (вкладка «Экзобиология»)") if allowed
                else tr("нет подходящих родов"))
            return
        entries = []
        for row in predictions[:self.MAX_PREDICTIONS]:
            genus = str(row.get("genus") or "?")
            percent = row.get("percent")
            value = (int(row.get("value_cr") or 0)
                     or estimate_value(genus, mapped=mapped, first_discovery=no_footfall))
            species = [str(item) for item in (row.get("species") or []) if item]
            short_species = ", ".join(_species_tail(name) for name in species[:2]) or ""
            if len(species) > 2:
                short_species += f" +{len(species) - 2}"
            if row.get("confirmed"):
                short_species = ("DSS ✓ " + short_species).strip()
            entries.append({
                "genus": genus,
                "percent": f"{percent}%" if percent is not None else "—",
                "bar": self._format_prob_bar(percent) if percent is not None else "",
                "value": format_credits(value) if value else "",
                "species": short_species,
                "notes": ", ".join(str(item) for item in (row.get("notes") or [])[:2]),
            })
        extra = len(predictions) - self.MAX_PREDICTIONS

        lines = []
        for item in entries:
            head = (f"{item['genus']}  {item['percent']}"
                    + (f"  {item['bar']}" if item["bar"] else ""))
            if item["value"]:
                bonus_tag = tr(" (бонус ×5)") if no_footfall else ""
                head += f"  ≈ {item['value']}{bonus_tag}"
            details = " · ".join(part for part in (
                (tr("виды: {list}", list=item["species"]) if item["species"] else ""),
                item["notes"]) if part)
            lines.append(head + (f"\n   {details}" if details else ""))
        if extra > 0:
            lines.append(tr("… и ещё {count}", count=extra))
        if self._table_mode:
            col_val = tr("≈кр (×5)") if no_footfall else tr("≈кр")
            rows = [(item["genus"], item["percent"], item["bar"] or "·",
                     item["value"] or "—",
                     " · ".join(part for part in (item["species"], item["notes"]) if part)
                     or "—")
                    for item in entries]
            self._table_or_flow(
                self.predict_label,
                (tr("род"), "%", tr("вероятность"), col_val,
                 tr("виды и причина")),
                rows, "\n".join(lines),
                aligns=("left", "right", "left", "right", "left"))
            return
        self._set_flow_text(self.predict_label, "\n".join(lines))

    def _set_planets_visible(self, visible: bool) -> None:
        """Показать/скрыть раздел, но только если видимость изменилась.

        Раскладка Qt сама ставит раздел на прежнее место, поэтому прежний
        `pack(before=…)` не нужен: достаточно скрыть или показать виджеты.
        """
        if self._planets_shown == visible:
            return
        self._planets_shown = visible
        for widget in (self.planet_separator, self.planets_header, self.planets_label):
            widget.setVisible(visible)

    def _render_planets(self, state: dict) -> None:
        """Раздел «Поиск планет»: что в этой системе подходит под фильтры."""
        criteria = state.get("planet_criteria") or []
        if not bool(self.settings.get("exobio_show_planet_search", True)):
            self._set_planets_visible(False)
            return
        self._set_planets_visible(True)

        if not criteria:
            self.planets_header.setText(_section_text("D", tr("Поиск планет")))
            self.planets_label.setText(
                tr("критерии не выбраны — вкладка «Экзобиология»"))
            paint(self.planets_label, color=COLOR_TEXT_MUTED)
            return

        rows = state.get("planets") or []
        self.planets_header.setText(
            _section_text("D", tr("Поиск планет · найдено {count}", count=len(rows))))
        if not rows:
            known = int(state.get("system_known_bodies")
                        or state.get("system_scanned_bodies") or 0)
            if known:
                text = tr("в этой системе подходящих планет нет\n"
                          "(журнал знает {count} тел системы)", count=known)
            else:
                text = tr("журнал ещё не знает сканов тел этой системы\n"
                          "(сканируйте планеты FSS/DSS при работающем Watcher)")
            self.planets_label.setText(text)
            paint(self.planets_label, color=COLOR_TEXT_MUTED)
            return

        limit = max(1, int(self.settings.get("exobio_planet_limit", self.MAX_PLANETS)
                           or self.MAX_PLANETS))
        table_rows = []
        matched_lines = []
        for row in rows[:limit]:
            name = self._short_body(state, row.get("body"))
            traits = []
            category = str(row.get("atmosphere_category") or "")
            if category in ("thin", "thick"):
                traits.append(tr("атмосфера"))
            elif category == "none":
                traits.append(tr("без атмосферы"))
            traits.append(tr("посадка") if row.get("landable") else tr("не сесть"))
            if int(row.get("bio_signals") or 0):
                traits.append(tr("сигналов {count}", count=row["bio_signals"]))
            distance = float(row.get("distance_ls") or 0.0)
            if distance > 0:
                traits.append(tr("{distance} св.с", distance=f"{distance:.0f}"))
            table_rows.append((name, str(row.get("planet_class") or "?"), ", ".join(traits)))
            # Почему планета попала в список — иначе фильтры непрозрачны.
            matched = [str(item) for item in (row.get("matched") or []) if item]
            if matched:
                matched_lines.append((name, ", ".join(matched[:2])))
        extra = len(rows) - limit
        lines = [f"{name}  ·  {planet_class}  ·  {traits}"
                 for name, planet_class, traits in table_rows]
        for name, why in matched_lines:
            lines.append(f"   ↳ {why}")
        if extra > 0:
            lines.append(tr("… и ещё {count}", count=extra))
        if self._table_mode and table_rows:
            self._table_or_flow(
                self.planets_label, (tr("тело"), tr("класс"), tr("признаки")),
                table_rows,
                "\n".join(lines), color=COLOR_GREEN_TEXT)
            return
        self._set_flow_text(self.planets_label, "\n".join(lines))
        paint(self.planets_label, color=COLOR_GREEN_TEXT)

    def _render_bodies(self, state: dict) -> None:
        bodies = state.get("system_bodies") or []
        self.bodies_header.setText(_section_text(
            "E", tr("Тела системы · биосигналы {count}", count=len(bodies))
            if bodies else tr("Тела системы")))
        if not bodies:
            self.bodies_label.setText(tr("в этой системе биосигналов не найдено"))
            return
        rows = []
        for row in bodies[:self.MAX_BODIES]:
            name = self._short_body(state, row.get("body"))
            marks = []
            if row.get("has_organics"):
                marks.append(tr("образцы"))
            marks.append(tr("карта есть") if row.get("mapped") else tr("карты нет"))
            if not row.get("landable"):
                marks.append(tr("не сесть"))
            rows.append((name, str(row.get("planet_class") or "?"),
                         str(row.get("bio_signals", 0)), ", ".join(marks)))
        extra = len(bodies) - self.MAX_BODIES
        lines = [tr("{body}  ·  сигналов {count}  ·  {marks}",
                    body=name, count=bio, marks=marks)
                 for name, _cls, bio, marks in rows]
        if extra > 0:
            lines.append(tr("… и ещё {count}", count=extra))
        if self._table_mode and rows:
            self._table_or_flow(
                self.bodies_label,
                (tr("тело"), tr("класс"), tr("био"), tr("признаки")), rows,
                "\n".join(lines), aligns=("left", "left", "right", "left"))
            return
        self._set_flow_text(self.bodies_label, "\n".join(lines))


# ============================================================
#  SESSION — статистика сессии с графиком
# ============================================================
class SessionOverlay(HudWindow):
    def __init__(self, master, settings: Dict[str, Any]):
        # Шесть счётчиков, график и строка маршрута в 300 px не помещаются:
        # график наезжал на подпись под ним. Окно стартует выше, а сохранённый
        # пользователем размер по-прежнему главнее.
        height = max(int(settings.get("session_height", 300) or 300), 340)
        super().__init__(
            master, "SESSION",
            settings.get("session_x", 400), settings.get("session_y", 50),
            settings.get("session_width", 320), height, settings, "session",
        )
        self.session_header = hud_section(self.content, "Session metrics",
                                          size=self._font_size - 2)
        self.body.addWidget(self.session_header)

        self.stats_grid = QWidget(self.content)
        self._stats_layout = QGridLayout(self.stats_grid)
        self._stats_layout.setContentsMargins(0, 0, 0, 0)
        self._stats_layout.setHorizontalSpacing(8)
        self._stats_layout.setVerticalSpacing(1)
        self.body.addWidget(self.stats_grid)

        self.systems_label = self._make_stat_row(0, "Systems:", "0", COLOR_CYAN)
        self.deliveries_label = self._make_stat_row(1, "Deliveries:", "0", COLOR_GREEN_TEXT)
        self.cargo_label = self._make_stat_row(2, "Cargo (t):", "0", COLOR_ACCENT)
        self.route_cargo_label = self._make_stat_row(3, "Route (t):", "0", COLOR_YELLOW)
        self.construction_cargo_label = self._make_stat_row(4, "Build (t):", "0", COLOR_CYAN)
        self.time_label = self._make_stat_row(5, "Time:", "00:00", COLOR_TEXT_MUTED)

        self.route_system_label = self.make_label(self.content, "", color=COLOR_YELLOW, dp=-1)
        self.body.addWidget(self.route_system_label)
        self.body.addWidget(hud_separator(self.content))

        self.history_header = hud_section(self.content, "Cargo history",
                                          size=self._font_size - 2)
        self.body.addWidget(self.history_header)
        self.chart_canvas = HudChart(self.content, height=90)
        self.chart_canvas.set_font_spec(self._font_family, self._font_size - 2)
        self.body.addWidget(self.chart_canvas)

        self.route_info = self.make_label(self.content, "", color=COLOR_TEXT_MUTED,
                                          dp=-2, wrap=280)
        self.body.addWidget(self.route_info)
        self.body.addStretch(1)

        self.cargo_history: deque = deque(maxlen=20)
        self.jump_history: deque = deque(maxlen=20)
        self.session_start = time.time()
        self.start_system = ""
        self.current_system = ""

    def _make_stat_row(self, row: int, label: str, value: str, value_color: str):
        name = self.make_label(self.stats_grid, label.rstrip(":"), color=COLOR_TEXT_MUTED, dp=0)
        value_label = self.make_label(self.stats_grid, value, color=value_color, dp=0,
                                      bold=True, align_right=True)
        self._stats_layout.addWidget(name, row, 0)
        self._stats_layout.addWidget(value_label, row, 1)
        return value_label

    def update_session(self, data: dict) -> None:
        self.systems_label.setText(str(data.get("systems_visited", 0)))
        self.deliveries_label.setText(str(data.get("deliveries_count", 0)))
        self.cargo_label.setText(f"{data.get('cargo_total_tons', 0):.1f}")
        self.route_cargo_label.setText(f"{data.get('route_cargo_tons', 0):.1f}")
        self.construction_cargo_label.setText(
            f"{data.get('construction_cargo_tons', 0):.1f}")

        elapsed = int(time.time() - self.session_start)
        hours = elapsed // 3600
        mins = (elapsed % 3600) // 60
        self.time_label.setText(f"{hours:02d}:{mins:02d}")

        last_system = data.get("last_delivery_system", "")
        self.route_system_label.setText(f"-> {last_system}" if last_system else "")

        current = data.get("current_system", "")
        if current and not self.start_system:
            self.start_system = current
        self.current_system = current

        if self.start_system and self.current_system:
            self.route_info.setText(f">> {self.start_system}  ->  {self.current_system}")
        else:
            self.route_info.setText("")

        self.cargo_history.append(data.get("cargo_count", 0))
        if current:
            self.jump_history.append(current)
        self._draw_chart()

    def _draw_chart(self) -> None:
        self.chart_canvas.set_history(list(self.cargo_history))

    def on_font_changed(self) -> None:
        self.chart_canvas.set_font_spec(self._font_family, self._font_size - 2)
