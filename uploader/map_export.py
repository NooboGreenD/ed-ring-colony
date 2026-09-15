"""Экспорт карты системы в PNG без сторонних зависимостей.

Зачем: скриншот окна ловит чужие рамки и тему, а крылу нужна сама схема —
тела, стройки с прогресс-барами и «вы здесь». Здесь та же раскладка
`system_map.layout()`, что рисует вкладка, но растрируется в память и
упаковывается в PNG средствами stdlib (zlib + struct): Pillow в требования
не едет, EXE не тяжелеет. Шрифт — битмап 8x10 из `map_font`.
"""

import struct
import time
import zlib
from typing import Optional, Tuple

from map_font import FONT_8X10, GLYPH_H, GLYPH_W, UNKNOWN_GLYPH
from system_map import (
    STATION_CARRIER,
    STATION_LABELS,
    PlacedItem,
    due_note,
    due_timestamp,
    layout,
    map_summary,
)

# Палитра вкладки (копия цветов colonial_helper.py, чтобы экспорт выглядел
# родным скриншотом, а не «похожей картинкой»).
COLOR_BG = (0x1e, 0x20, 0x22)
COLOR_PANEL = (0x2a, 0x2d, 0x30)
COLOR_LINE = (0x3a, 0x3d, 0x40)
COLOR_TEXT = (0xee, 0xee, 0xee)
COLOR_MUTED = (0x9c, 0xa3, 0xaf)
COLOR_ORANGE = (0xe6, 0x7e, 0x22)
COLOR_CYAN = (0x34, 0x98, 0xdb)
COLOR_GREEN = (0x2e, 0xcc, 0x71)
COLOR_RED = (0xe7, 0x4c, 0x3c)
COLOR_YELLOW = (0xf1, 0xc4, 0x0f)   # тот же жёлтый, что в палитре вкладки
COLOR_DARK = (0x11, 0x13, 0x15)


def _hex(color: str) -> Tuple[int, int, int]:
    text = str(color or "").strip().lstrip("#")
    if len(text) != 6:
        return COLOR_TEXT
    try:
        return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
    except ValueError:
        return COLOR_TEXT


class _Raster:
    """Пиксельный буфер RGB с минимумом примитивов: хватает на схему карты."""

    def __init__(self, width: int, height: int, color=COLOR_BG):
        self.width = max(80, int(width))
        self.height = max(80, int(height))
        self.pixels = bytearray(bytes(color) * (self.width * self.height))

    def set(self, x: float, y: float, color) -> None:
        ix, iy = int(round(x)), int(round(y))
        if 0 <= ix < self.width and 0 <= iy < self.height:
            offset = (iy * self.width + ix) * 3
            self.pixels[offset:offset + 3] = bytes(color)

    def line(self, x0: float, y0: float, x1: float, y1: float, color) -> None:
        """Брезенхэм: подписи и рамки без сглаживания, но ровно."""
        x, y = int(round(x0)), int(round(y0))
        tx, ty = int(round(x1)), int(round(y1))
        dx, dy = abs(tx - x), -abs(ty - y)
        sx = 1 if x < tx else -1
        sy = 1 if y < ty else -1
        err = dx + dy
        for _ in range(abs(dx) + abs(dy) + 1):
            self.set(x, y, color)
            if x == tx and y == ty:
                break
            double = 2 * err
            if double >= dy:
                err += dy
                x += sx
            if double <= dx:
                err += dx
                y += sy

    def circle(self, cx: float, cy: float, radius: float, color,
               fill: bool = False) -> None:
        r = max(1.0, float(radius))
        if fill:
            for iy in range(int(cy - r), int(cy - r + 2 * r) + 2):
                for ix in range(int(cx - r), int(cx - r + 2 * r) + 2):
                    if (ix - cx) ** 2 + (iy - cy) ** 2 <= r * r:
                        self.set(ix, iy, color)
            return
        steps = max(24, int(r * 8))
        import math
        previous = None
        for index in range(steps + 1):
            angle = 2 * math.pi * index / steps
            point = (cx + r * math.cos(angle), cy + r * math.sin(angle))
            if previous is not None:
                self.line(previous[0], previous[1], point[0], point[1], color)
            previous = point

    def dashed_circle(self, cx: float, cy: float, radius: float, color,
                      dash: int = 3, gap: int = 6) -> None:
        import math
        r = max(1.0, float(radius))
        circumference = 2 * math.pi * r
        if circumference <= 0:
            return
        steps = int(circumference / max(1, dash + gap))
        for index in range(max(1, steps)):
            start = (dash + gap) * index / circumference * 2 * math.pi
            end = start + dash / circumference * 2 * math.pi
            self.line(cx + r * math.cos(start), cy + r * math.sin(start),
                      cx + r * math.cos(end), cy + r * math.sin(end), color)

    def dashed_line(self, x0, y0, x1, y1, color, dash: int = 5, gap: int = 4) -> None:
        length = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        if length <= 0:
            return
        steps = int(length / (dash + gap)) + 1
        for step in range(steps):
            start = step * (dash + gap)
            if start >= length:
                break
            end = min(start + dash, length)
            self.line(x0 + (x1 - x0) * start / length, y0 + (y1 - y0) * start / length,
                      x0 + (x1 - x0) * end / length, y0 + (y1 - y0) * end / length,
                      color)

    def rect(self, x0: float, y0: float, x1: float, y1: float, color,
             fill: bool = False) -> None:
        left, right = sorted((int(round(x0)), int(round(x1))))
        top, bottom = sorted((int(round(y0)), int(round(y1))))
        if fill:
            for iy in range(top, bottom + 1):
                for ix in range(left, right + 1):
                    self.set(ix, iy, color)
            return
        self.line(left, top, right, top, color)
        self.line(left, bottom, right, bottom, color)
        self.line(left, top, left, bottom, color)
        self.line(right, top, right, bottom, color)

    def text(self, x: float, y: float, text: str, color, anchor: str = "la") -> None:
        """Битмап-текст; anchor как в PIL: l/m/r по горизонтали, a/m по вертикали."""
        glyph_w, glyph_h = GLYPH_W, GLYPH_H
        total = glyph_w * max(0, len(text))
        left = float(x)
        if anchor[0] == "m":
            left = float(x) - total / 2.0
        elif anchor[0] == "r":
            left = float(x) - total
        top = float(y)
        if anchor[1:] == "m":
            top = float(y) - glyph_h / 2.0
        for index, char in enumerate(text):
            rows = FONT_8X10.get(char, UNKNOWN_GLYPH if char != " " else None)
            if not rows:
                continue
            ox = left + index * glyph_w
            for ry, bits in enumerate(rows):
                if not bits:
                    continue
                for bx in range(glyph_w):
                    if bits & (0x80 >> bx):
                        self.set(ox + bx, top + ry, color)

    def png_bytes(self) -> bytes:
        """RGB8 без фильтров: простейший валидный PNG своими руками."""
        stride = self.width * 3
        raw = bytearray()
        for y in range(self.height):
            raw.append(0)
            raw.extend(self.pixels[y * stride:(y + 1) * stride])

        def chunk(tag: bytes, payload: bytes) -> bytes:
            return (struct.pack(">I", len(payload)) + tag + payload
                    + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

        header = struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n"
                + chunk(b"IHDR", header)
                + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
                + chunk(b"IEND", b""))


def _diamond(raster: _Raster, cx: float, cy: float, radius: float, color,
             outline, width: int = 2, dashed: bool = False) -> None:
    points = [(cx, cy - radius), (cx + radius, cy), (cx, cy + radius), (cx - radius, cy)]
    if not dashed:
        for iy in range(int(cy - radius), int(cy + radius) + 1):
            half = radius - abs(iy - cy)
            for ix in range(int(cx - half), int(cx + half) + 1):
                raster.set(ix, iy, color)
    for index in range(4):
        x0, y0 = points[index]
        x1, y1 = points[(index + 1) % 4]
        if dashed:
            raster.dashed_line(x0, y0, x1, y1, outline)
        else:
            raster.line(x0, y0, x1, y1, outline)


def export_map_png(snapshot, width: int = 1280, height: int = 820,
                   zoom: float = 1.0, show_moons: bool = True,
                   show_labels: bool = True, center_on: str = "") -> bytes:
    """Схема системы в PNG: те же объекты и прогресс-бары, что на вкладке."""
    raster = _Raster(width, height)
    items = layout(snapshot, width, height, zoom=zoom, show_moons=show_moons,
                   center_on=center_on)
    center_x, center_y = width / 2.0, height / 2.0
    pan_x, pan_y = next(((item.pan_x, item.pan_y) for item in items
                         if item.pan_x or item.pan_y), (0.0, 0.0))

    for item in items:
        if item.kind == "body" and item.orbit_radius > 0:
            cx = center_x + pan_x if item.orbit_cx is None else item.orbit_cx
            cy = center_y + pan_y if item.orbit_cy is None else item.orbit_cy
            raster.dashed_circle(cx, cy, item.orbit_radius, COLOR_LINE)

    for item in items:
        if item.kind != "star":
            continue
        radius = max(6.0, item.radius)
        raster.circle(item.x, item.y, radius * 1.9, (0x2b, 0x24, 0x10), fill=True)
        raster.circle(item.x, item.y, radius, item.color and _hex(item.color), fill=True)
        if show_labels and item.label:
            raster.text(item.x, item.y - radius * 1.9 - 18 + item.label_dy,
                        item.label, COLOR_TEXT, "ma")
            if item.caption:
                raster.text(item.x, item.y + radius * 1.9 + 8 + item.label_dy,
                            item.caption, COLOR_MUTED, "ma")

    for item in items:
        if item.kind != "body":
            continue
        radius = max(3.0, item.radius)
        raster.circle(item.x, item.y, radius, _hex(item.color), fill=True)
        if getattr(item.ref, "landable", False):
            raster.text(item.x, item.y, "L", COLOR_DARK, "mm")
        if not show_labels:
            continue
        is_moon = getattr(item.ref, "kind", "") == "moon"
        raster.text(item.x, item.y + radius + 8 + item.label_dy, item.label,
                    COLOR_MUTED if is_moon else COLOR_TEXT, "ma")
        if item.caption and not is_moon:
            raster.text(item.x, item.y + radius + 24 + item.label_dy,
                        item.caption, COLOR_MUTED, "ma")

    for item in items:
        if item.kind != "station":
            continue
        radius = max(5.0, item.radius)
        station = item.ref
        planned = bool(station.planned)
        color = COLOR_PANEL if planned else _hex(item.color)
        outline = _hex(item.color)
        if station.is_site:
            _diamond(raster, item.x, item.y, radius + 3, color, outline,
                     width=2, dashed=planned)
        elif getattr(station, "kind", "") == STATION_CARRIER:
            raster.rect(item.x - radius, item.y - radius,
                        item.x + radius, item.y + radius, outline, fill=True)
        else:
            raster.circle(item.x, item.y, radius, color, fill=True)
            raster.circle(item.x, item.y, radius, outline)
        if not show_labels:
            continue
        used = radius + 6.0
        dy = float(item.label_dy or 0.0)
        if item.progress is not None:
            progress = max(0, min(100, int(item.progress)))
            bar_w = float(item.bar_width)
            left, top = item.x - bar_w / 2.0, item.y + radius + 8.0 + dy
            bottom = top + 11.0
            bar_color = (COLOR_GREEN if progress >= 100
                         else (COLOR_ORANGE if progress >= 40 else COLOR_RED))
            raster.rect(left, top, left + bar_w, bottom, COLOR_DARK, fill=True)
            raster.rect(left, top, left + bar_w, bottom, COLOR_LINE)
            fill_w = int(round((bar_w - 2) * progress / 100.0))
            if fill_w > 0:
                raster.rect(left + 1, top + 1, left + 1 + fill_w, bottom - 1,
                            bar_color, fill=True)
            raster.text(left + bar_w + 6, (top + bottom) / 2.0, f"{progress}%",
                        bar_color, "lm")
            used += 18.0
        raster.text(item.x, item.y + used + 6 + dy, item.label,
                    COLOR_ORANGE if station.is_site else COLOR_TEXT, "ma")
        note = due_note(station.due_at)
        if note:
            # Просрочка краснеет, «скоро» жёлтеет — как строки в списке.
            urgent = (COLOR_RED if due_timestamp(station.due_at) < time.time()
                      else COLOR_YELLOW)
            raster.text(item.x, item.y + used + 20 + dy, note, urgent, "ma")

    for item in items:
        if item.kind != "player":
            continue
        radius = max(10.0, item.radius)
        raster.circle(item.x, item.y, radius, COLOR_GREEN)
        raster.circle(item.x, item.y, radius - 1, COLOR_GREEN)
        raster.circle(item.x, item.y, 3, COLOR_GREEN, fill=True)
        if show_labels:
            raster.text(item.x, item.y - radius - 12 + item.label_dy,
                        "Вы здесь", COLOR_GREEN, "ma")

    # Легенда и строка состояния — как на вкладке, чтобы картинка читалась сама.
    legend = ((STATION_LABELS.get("construction_site", "стройка"), COLOR_ORANGE),
              ("тело", (0x9f, 0xd8, 0xef)),
              ("станция", COLOR_TEXT),
              ("авианосец", COLOR_CYAN),
              ("вы", COLOR_GREEN))
    lx = 14.0
    for label, color in legend:
        raster.rect(lx, 12, lx + 10, 22, color, fill=True)
        raster.text(lx + 15, 17, label, COLOR_MUTED, "lm")
        lx += 26 + GLYPH_W * len(label)
    summary = map_summary(snapshot)
    raster.text(14, height - 18, summary[:160], COLOR_MUTED, "la")
    return raster.png_bytes()


def save_map_png(snapshot, path, **kwargs) -> bool:
    """Сохранить схему в файл; False — если диск отказал."""
    try:
        data = export_map_png(snapshot, **kwargs)
        with open(path, "wb") as handle:
            handle.write(data)
        return True
    except Exception:
        return False
