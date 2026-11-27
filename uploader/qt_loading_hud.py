"""Compact native loading manifest. Presentation only: no timers/network IO."""

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import (
    QAbstractItemView,
    QFrame,
    QHeaderView,
    QLabel,
    QScrollArea,
    QSizePolicy,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)
from hud_window import (
    COLOR_ACCENT,
    COLOR_CYAN,
    COLOR_LINE,
    COLOR_PANEL,
    COLOR_SURFACE,
    COLOR_TEXT,
    COLOR_TEXT_MUTED,
    hud_font,
)
from i18n import tr
from loading_patterns import loading_segments, loading_tables
from loading_goods import CATEGORIES, good_category, category_name
from system_map import commodity_label


def tonnes(value):
    return "?" if value is None else f"{value:,}".replace(",", " ")


class LoadingSquares(QWidget):
    """Twenty responsive filled squares; never a continuous progress bar."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.filled = 0
        self.unknown = False
        self.square_size = 10
        self.setFixedHeight(14)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)

    def set_progress(self, loaded, target, unknown=0):
        filled = loading_segments(loaded, target)
        state = (filled, bool(unknown))
        if state != (self.filled, self.unknown):
            self.filled, self.unknown = state
            self.update()
        self.setAccessibleName(tr("Прогресс погрузки"))
        self.setAccessibleDescription(
            f"{tonnes(loaded)} / {tonnes(target)} t" + (" · ?" if unknown else "")
        )
        self.setToolTip(self.accessibleDescription())

    def set_font_size(self, size):
        self.square_size = max(6, min(14, int(size)))
        self.setFixedHeight(self.square_size + 4)
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        gap = 3 if self.width() >= 100 else 1
        side = min(self.square_size, max(1, (self.width() - gap * 19) // 20))
        y = (self.height() - side) // 2
        for index in range(20):
            full = self.filled is not None and index < self.filled
            painter.setPen(
                QPen(QColor(COLOR_CYAN if self.unknown and not full else COLOR_LINE))
            )
            painter.setBrush(QColor(COLOR_ACCENT if full else COLOR_SURFACE))
            painter.drawRect(index * (side + gap), y, side - 1, side - 1)


class LoadingCarrierTable(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setStyleSheet(
            f"LoadingCarrierTable{{background:{COLOR_PANEL};border:1px solid {COLOR_LINE};border-radius:3px;}}"
        )
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(7, 6, 7, 6)
        layout.setSpacing(3)
        self.name_label = QLabel()
        self.name_label.setStyleSheet(f"color:{COLOR_ACCENT};background:transparent;")
        self.name_label.setWordWrap(True)
        self.name_label.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.name_label.setTextFormat(Qt.PlainText)
        self.squares = LoadingSquares()
        self.totals_label = QLabel()
        self.totals_label.setStyleSheet(f"color:{COLOR_TEXT};background:transparent;")
        self.totals_label.setWordWrap(True)
        self.totals_label.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.table = QTableWidget(0, 3)
        self.table.setHorizontalHeaderLabels(
            [tr("Товар"), tr("Загружено, т"), tr("Осталось, т")]
        )
        self.table.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        self.table.verticalHeader().hide()
        self.table.setFrameShape(QFrame.NoFrame)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionMode(QAbstractItemView.NoSelection)
        self.table.setFocusPolicy(Qt.NoFocus)
        self.table.setShowGrid(False)
        self.table.setWordWrap(False)
        self.table.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.table.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.Fixed)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Fixed)
        self.table.setStyleSheet(
            f"QTableWidget{{background:{COLOR_SURFACE};color:{COLOR_TEXT};border:0;}}"
            f"QTableWidget::item{{padding:1px 3px;border-bottom:1px solid {COLOR_LINE};}}"
            f"QHeaderView::section{{background:{COLOR_PANEL};color:{COLOR_TEXT_MUTED};border:0;padding:3px;}}"
        )
        self.empty_label = QLabel(tr("Нет оставшихся товаров"))
        self.empty_label.setWordWrap(True)
        self.empty_label.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.empty_label.setStyleSheet(
            f"color:{COLOR_TEXT_MUTED};background:transparent;"
        )
        for widget in (
            self.name_label,
            self.squares,
            self.totals_label,
            self.table,
            self.empty_label,
        ):
            layout.addWidget(widget)
        self._data = None
        self._row_height = 23

    def set_data(self, data):
        if data == self._data:
            return
        self._data = data
        self.name_label.setText(data["name"])
        self.name_label.setToolTip(
            f"{data['carrierId']} · {data.get('updatedAt') or '?'}"
        )
        prefix = "≥" if data["unknown"] and data["loaded"] is not None else ""
        self.totals_label.setText(
            f"{tr('Загружено')}: {prefix}{tonnes(data['loaded'])} / {tonnes(data['target'])} t"
            f"  ·  {tr('Осталось')}: {tonnes(data['remaining'])} t"
        )
        self.squares.set_progress(data["loaded"], data["target"], data["unknown"])
        rows = []
        previous = None
        for row in data["rows"]:
            category = good_category(row["commodity"])
            if data.get("grouped") and category != previous:
                rows.append({"group": category})
            rows.append(row)
            previous = category
        self.table.clearSpans()
        self.table.clearContents()
        self.table.setRowCount(len(rows))
        for index, row in enumerate(rows):
            if "group" in row:
                category = row["group"]
                cell = QTableWidgetItem(category_name(category))
                cell.setForeground(QColor(CATEGORIES[category]["color"]))
                cell.setBackground(QColor("#20242a"))
                self.table.setItem(index, 0, cell)
                self.table.setSpan(index, 0, 1, 3)
                continue
            translated = commodity_label(row["commodity"])
            label = translated if translated != row["commodity"] else row["name"]
            for column, text in enumerate(
                (label, tonnes(row["loaded"]), tonnes(row["remaining"]))
            ):
                cell = self.table.item(index, column)
                if cell is None:
                    cell = QTableWidgetItem()
                    self.table.setItem(index, column, cell)
                if cell.text() != text:
                    cell.setText(text)
                cell.setTextAlignment(
                    (Qt.AlignLeft if column == 0 else Qt.AlignRight) | Qt.AlignVCenter
                )
                cell.setForeground(
                    QColor(
                        CATEGORIES[good_category(row["commodity"])]["color"] if column == 0 else
                        COLOR_ACCENT if column == 2 and row["remaining"] else COLOR_TEXT
                    )
                )
                cell.setToolTip(
                    f"{label} · {category_name(good_category(row['commodity']))} · {tr('Требуется')}: {tonnes(row['required'])} t"
                )
        self.empty_label.setText(
            tr("Нет товаров по выбранным условиям") if data.get("filtered") else
            tr("Нет оставшихся товаров")
            if data["target"]
            else tr("Нет назначенных товаров")
        )
        self._resize_rows()

    def _resize_rows(self):
        self.table.verticalHeader().setDefaultSectionSize(self._row_height)
        self.table.setFixedHeight(
            self.table.horizontalHeader().height()
            + self.table.rowCount() * self._row_height
            + 2
        )

    def configure(self, family, size, show_carriers, show_progress, show_items):
        for label, delta in (
            (self.name_label, 0),
            (self.totals_label, -1),
            (self.empty_label, -1),
        ):
            label.setFont(
                hud_font(family, max(6, size + delta), bold=label is self.name_label)
            )
        self.table.setFont(hud_font(family, max(6, size - 1)))
        self.table.horizontalHeader().setFont(hud_font(family, max(6, size - 2)))
        self._row_height = self.table.fontMetrics().height() + 7
        # Header names and numeric values remain legible when resizing/font changes.
        for column in (1, 2):
            metrics = self.table.fontMetrics()
            header = self.table.horizontalHeaderItem(column).text()
            self.table.setColumnWidth(
                column,
                max(
                    metrics.horizontalAdvance("999 999"),
                    self.table.horizontalHeader()
                    .fontMetrics()
                    .horizontalAdvance(header),
                )
                + 10,
            )
        self.table.horizontalHeader().setFixedHeight(
            self.table.horizontalHeader().fontMetrics().height() + 8
        )
        self.squares.set_font_size(size)
        self.name_label.setVisible(show_carriers)
        self.totals_label.setVisible(show_carriers)
        self.squares.setVisible(show_progress)
        has_rows = self.table.rowCount() > 0
        self.table.setVisible(show_items and has_rows)
        self.empty_label.setVisible(show_items and not has_rows)
        self._resize_rows()


class LoadingManifest(QScrollArea):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWidgetResizable(True)
        self.setFrameShape(QFrame.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setStyleSheet("QScrollArea{background:transparent;border:0;}")
        content = QWidget()
        self.rows_layout = QVBoxLayout(content)
        self.rows_layout.setContentsMargins(0, 0, 3, 0)
        self.rows_layout.setSpacing(6)
        self.rows_layout.addStretch(1)
        self.setWidget(content)
        self.cards = {}
        self.setMinimumHeight(40)

    def render(
        self,
        data,
        *,
        show_completed=False,
        family="Consolas",
        size=10,
        show_carriers=True,
        show_progress=True,
        show_items=True,
        order="recipe",
        category="",
    ):
        models = loading_tables(data, show_completed, order=order, category=category)
        ids = {model["carrierId"] for model in models}
        for key in list(self.cards):
            if key not in ids:
                card = self.cards.pop(key)
                self.rows_layout.removeWidget(card)
                card.hide()
                card.deleteLater()
        for index, model in enumerate(models):
            key = model["carrierId"]
            card = self.cards.get(key)
            if card is None:
                card = self.cards[key] = LoadingCarrierTable()
                self.rows_layout.insertWidget(index, card)
            elif self.rows_layout.indexOf(card) != index:
                self.rows_layout.removeWidget(card)
                self.rows_layout.insertWidget(index, card)
            card.set_data(model)
            card.configure(family, size, show_carriers, show_progress, show_items)
        self.setVisible(bool(models) and (show_carriers or show_progress or show_items))
