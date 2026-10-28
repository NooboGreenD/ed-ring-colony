"""Иконки HUD в стиле сайта: тонкий контур, скруглённые концы, один цвет.

Сайт рисует иконки SVG-компонентами `src/components/Icons.tsx`: сетка 24×24,
обводка 1.5 без заливки, `stroke-linecap="round"`. Оверлею нужны те же знаки,
но в Qt — поэтому здесь лежат те же геометрии в виде простых примитивов, а
`HudIcon` рисует их `QPainter`'ом в любой размер. Так иконка блока совпадает с
иконкой того же смысла на сайте, а не подбирается «похожим эмодзи».

Имена примитивов повторяют SVG: `line`, `circle`, `poly` (ломаная/многоугольник).
Точки — в системе координат 24×24, ровно как в `Icons.tsx`.
"""
from __future__ import annotations

from typing import Sequence, Tuple

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QWidget

#: Сетка иконок сайта: `viewBox="0 0 24 24"`, `strokeWidth={1.5}`.
VIEWBOX = 24.0
STROKE = 1.5
#: Ниже этой толщины линия на экране рвётся на пиксели — держим минимум.
MIN_STROKE_PX = 1.0

Primitive = Tuple
IconSpec = Sequence[Primitive]

#: Знаки, которые нужны оверлею. Геометрии взяты из `src/components/Icons.tsx`
#: один в один — иначе «иконка в стиле сайта» была бы похожей, а не той же.
ICONS: dict[str, IconSpec] = {
    # IconBuilding: идёт стройка.
    "building": (
        ("line", 2, 20, 22, 20),
        ("line", 5, 20, 5, 12),
        ("line", 5, 12, 12, 8),
        ("line", 12, 8, 19, 12),
        ("line", 19, 12, 19, 20),
        ("line", 9, 20, 9, 16),
        ("line", 9, 16, 15, 16),
        ("line", 15, 16, 15, 20),
    ),
    # IconDone: стройка завершена (круг + галочка вместо дуги — та же форма).
    "done": (
        ("circle", 12, 12, 10),
        ("poly", ((8, 12), (11, 15), (16, 9)), False),
    ),
    # IconWaiting: стройка не начата (или о ней ничего не известно).
    "idle": (
        ("circle", 12, 12, 10),
        ("poly", ((12, 6), (12, 12), (16, 14)), False),
    ),
    # IconCompass: первооткрыватель системы.
    "compass": (
        ("circle", 12, 12, 10),
        ("poly", ((16.24, 7.76), (14.12, 14.12), (7.76, 16.24), (9.88, 9.88)), True),
    ),
    # IconSearch: системы нет в базе проекта — «ещё не исследована».
    "search": (
        ("circle", 11, 11, 8),
        ("line", 21, 21, 16.65, 16.65),
    ),
    # --- снаряжение пилота: те же правила, что у остальных знаков ----------
    # Комбинезон: шлем и плечи.
    "suit": (
        ("circle", 12, 7, 3.2),
        ("poly", ((5.5, 20.5), (5.5, 16), (8, 13.2), (16, 13.2), (18.5, 16), (18.5, 20.5)), False),
        ("line", 5.5, 20.5, 18.5, 20.5),
    ),
    # Оружие: ствол, корпус и рукоять.
    "weapon": (
        ("poly", ((2.5, 13.5), (14, 13.5), (17, 10.5), (21.5, 10.5), (21.5, 13.5),
                  (16.5, 13.5), (15, 16.5), (10, 16.5), (8.5, 20.5), (5.5, 20.5),
                  (6.5, 16.5), (2.5, 16.5)), True),
        ("line", 12.5, 10.5, 12.5, 13.5),
    ),
    # Инструмент: сканер (корпус и волна).
    "tool": (
        ("poly", ((5.5, 6), (14.5, 6), (17.5, 9), (17.5, 20.5), (5.5, 20.5)), True),
        ("line", 8.5, 10.5, 14.5, 10.5),
        ("line", 8.5, 14, 14.5, 14),
    ),
    # Щит.
    "shield": (
        ("poly", ((12, 2.5), (20, 6), (20, 12), (12, 21.5), (4, 12), (4, 6)), True),
    ),
    # Батарея.
    "battery": (
        ("line", 9.5, 2.5, 14.5, 2.5),
        ("poly", ((6, 5), (18, 5), (18, 20), (6, 20)), True),
        ("poly", ((12, 8.5), (13.6, 12), (11.2, 12), (12.8, 15.5)), False),
    ),
    # Воздух: баллон с вентилем.
    "air": (
        ("poly", ((8, 7), (16, 7), (16, 21), (8, 21)), True),
        ("line", 12, 7, 12, 4),
        ("line", 9.5, 4, 14.5, 4),
        ("line", 8, 12, 16, 12),
    ),
    # Рюкзак.
    "pack": (
        ("poly", ((7, 8), (7, 5.5), (17, 5.5), (17, 8), (19, 10), (19, 20.5),
                  (5, 20.5), (5, 10)), True),
        ("line", 5, 14.5, 19, 14.5),
    ),
    # Разряды урона: кинетика — пуля, термика — нагрев, плазма — разряд,
    # взрывчатка — разлёт.
    "kinetic": (
        ("circle", 12, 12, 8.5),
        ("circle", 12, 12, 2.5),
        ("line", 12, 2, 12, 5.5),
        ("line", 12, 18.5, 12, 22),
        ("line", 2, 12, 5.5, 12),
        ("line", 18.5, 12, 22, 12),
    ),
    "thermal": (
        ("poly", ((12, 2.5), (15.5, 9.5), (19, 13.5), (16, 19.5), (12, 21.5),
                  (8, 19.5), (5, 13.5), (8.5, 9.5)), True),
        ("poly", ((12, 9), (14, 13), (12, 17), (10, 13)), True),
    ),
    "plasma": (
        ("poly", ((13, 2.5), (6, 13.5), (11, 13.5), (10, 21.5), (18, 10), (13, 10)), True),
    ),
    "explosive": (
        ("poly", ((12, 2.5), (14, 8), (19.5, 5.5), (17, 11), (21.5, 14.5),
                  (15.5, 15), (16, 21.5), (12, 17), (8, 21.5), (8.5, 15),
                  (2.5, 14.5), (7, 11), (4.5, 5.5), (10, 8)), True),
    ),
    # Ячейка модификации: ромб в рамке — «слот».
    "mod": (
        ("poly", ((3.5, 3.5), (20.5, 3.5), (20.5, 20.5), (3.5, 20.5)), True),
        ("poly", ((12, 7), (17, 12), (12, 17), (7, 12)), True),
    ),
    # Набор снаряжения: карточка.
    "loadout": (
        ("poly", ((3.5, 5), (20.5, 5), (20.5, 19), (3.5, 19)), True),
        ("line", 3.5, 9, 20.5, 9),
        ("line", 8, 5, 8, 9),
    ),
    # IconStar: система в базе есть, но первооткрыватель неизвестен.
    "star": (
        ("poly", ((12, 2), (15.09, 8.26), (22, 9.27), (17, 14.14), (18.18, 21.01),
                  (12, 17.77), (5.82, 21.01), (7, 14.14), (2, 9.27), (8.91, 8.26)), True),
    ),
}


def icon_names() -> Tuple[str, ...]:
    """Все доступные знаки — для проверок в тестах и подсказок в коде."""
    return tuple(ICONS)


def icon_path(name: str, size: float = VIEWBOX) -> QPainterPath:
    """Путь иконки в квадрате ``size``: геометрия 24×24 масштабируется целиком."""
    spec = ICONS.get(str(name))
    path = QPainterPath()
    if not spec:
        return path
    scale = float(size) / VIEWBOX
    for primitive in spec:
        kind = primitive[0]
        if kind == "line":
            _, x1, y1, x2, y2 = primitive
            path.moveTo(x1 * scale, y1 * scale)
            path.lineTo(x2 * scale, y2 * scale)
        elif kind == "circle":
            _, cx, cy, radius = primitive
            path.addEllipse(QPointF(cx * scale, cy * scale), radius * scale, radius * scale)
        elif kind == "poly":
            _, points, closed = primitive
            for index, (x, y) in enumerate(points):
                if index == 0:
                    path.moveTo(x * scale, y * scale)
                else:
                    path.lineTo(x * scale, y * scale)
            if closed:
                path.closeSubpath()
    return path


def draw_icon(painter: QPainter, name: str, rect: QRectF, color: str,
              stroke: float = STROKE) -> None:
    """Нарисовать иконку ``name`` в ``rect`` тем же контуром, что на сайте."""
    if rect.width() <= 0 or rect.height() <= 0:
        return
    size = min(rect.width(), rect.height())
    painter.save()
    try:
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        painter.translate(rect.center())
        painter.translate(-size / 2, -size / 2)
        pen = QPen(QColor(color))
        pen.setWidthF(max(MIN_STROKE_PX, float(stroke) * size / VIEWBOX))
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawPath(icon_path(name, size))
    finally:
        painter.restore()


class HudIcon(QWidget):
    """Маленькая иконка HUD: знак в стиле сайта, цвет и размер — свойства."""

    def __init__(self, parent: QWidget = None, *, name: str = "star",
                 size: int = 16, color: str = "#e8edf2") -> None:
        super().__init__(parent)
        self._name = str(name)
        self._color = str(color)
        self.setFixedSize(int(size), int(size))
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)

    # -- свойства ----------------------------------------------------------
    def icon_name(self) -> str:
        return self._name

    def set_icon(self, name: str) -> None:
        name = str(name)
        if name == self._name:
            return
        self._name = name
        self.update()

    def set_color(self, color: str) -> None:
        color = str(color)
        if color == self._color:
            return
        self._color = color
        self.update()

    def color(self) -> str:
        return self._color

    def set_size(self, size: int) -> None:
        size = max(8, int(size))
        if size == self.width() == self.height():
            return
        self.setFixedSize(size, size)
        self.update()

    def sizeHint(self):  # noqa: N802 - имя из Qt
        from PySide6.QtCore import QSize

        return QSize(self.width(), self.height())

    def paintEvent(self, event) -> None:  # noqa: N802 - имя из Qt
        painter = QPainter(self)
        draw_icon(painter, self._name, QRectF(self.rect()), self._color)
