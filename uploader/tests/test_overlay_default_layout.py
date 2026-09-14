"""Инварианты раскладки блоков HUD по умолчанию (2.8.5).

Зачем: в 2.8.3 высоту окна EXOBIO подняли с 470 до 620 px, но только в
`DEFAULT_SETTINGS`. `DEFAULT_BLOCK_POSITIONS` осталась со старыми 470, а её
читают «Сбросить позиции», «Сбросить блок» и пресеты размера. В итоге:

* пресет «M — 100%» возвращал EXOBIO прежние 470 px, то есть ровно ту высоту,
  на которой раздел «Поиск планет» обрезался;
* «Сбросить позиции» откатывал окно обратно;
* EXOBIO на 620 px наезжал на CARRIER на 330x240 px.

Ни одного из этих тестов не было, поэтому расхождение уехало в релиз.
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_overlay_management import _ensure_gui_stubs  # noqa: E402

_ensure_gui_stubs()

import overlay  # noqa: E402


def _rects():
    """Прямоугольники блоков: ключ -> (x0, y0, x1, y1)."""
    return {
        key: (x, y, x + w, y + h)
        for key, (x, y, w, h) in overlay.DEFAULT_BLOCK_POSITIONS.items()
    }


class DefaultLayoutConsistencyTests(unittest.TestCase):

    def test_positions_match_default_settings(self):
        """Ширина/высота в таблице позиций совпадают с DEFAULT_SETTINGS.

        Иначе «Сбросить позиции» и пресет M дают блоку другой размер, чем
        свежая установка.
        """
        mismatches = []
        for key, (_x, _y, width, height) in overlay.DEFAULT_BLOCK_POSITIONS.items():
            settings_w = overlay.DEFAULT_SETTINGS.get(f"{key}_width")
            settings_h = overlay.DEFAULT_SETTINGS.get(f"{key}_height")
            if (settings_w, settings_h) != (width, height):
                mismatches.append(
                    f"{key}: positions={width}x{height} "
                    f"settings={settings_w}x{settings_h}"
                )

        self.assertEqual(mismatches, [], "\n".join(mismatches))

    def test_no_two_blocks_overlap(self):
        """Блоки по умолчанию не лежат друг на друге.

        Оверлеи полупрозрачные и кликабельные: наехавший блок закрывает
        соседний, а при редактировании это выглядит как пропажа данных.
        """
        rects = _rects()
        keys = sorted(rects)
        overlaps = []
        for i, a in enumerate(keys):
            for b in keys[i + 1:]:
                ax0, ay0, ax1, ay1 = rects[a]
                bx0, by0, bx1, by1 = rects[b]
                ox = min(ax1, bx1) - max(ax0, bx0)
                oy = min(ay1, by1) - max(ay0, by0)
                if ox > 0 and oy > 0:
                    overlaps.append(f"{a} x {b}: {ox}x{oy} px")

        self.assertEqual(overlaps, [], "\n".join(overlaps))

    def test_exobio_default_height_fits_the_content(self):
        """Высота EXOBIO не меньше той, на которой раздел «Поиск планет» виден.

        470 px — высота, при которой раздел обрезался (см. Раунд 25).
        """
        self.assertGreaterEqual(overlay.DEFAULT_BLOCK_POSITIONS["exobio"][3], 600)
        self.assertGreaterEqual(overlay.DEFAULT_SETTINGS["exobio_height"], 600)

    def test_layout_fits_a_1080p_screen(self):
        """Раскладка влезает в 1920x1080 — базовое разрешение игрока."""
        rects = _rects()

        self.assertLessEqual(max(r[2] for r in rects.values()), 1920)
        self.assertLessEqual(max(r[3] for r in rects.values()), 1080)

    def test_every_block_has_a_default_position(self):
        """У каждого блока HUD есть позиция по умолчанию."""
        missing = [key for key in overlay.OverlayManager.BLOCKS
                   if key not in overlay.DEFAULT_BLOCK_POSITIONS]

        self.assertEqual(missing, [])

    def test_all_sizes_are_positive(self):
        for key, (x, y, w, h) in overlay.DEFAULT_BLOCK_POSITIONS.items():
            with self.subTest(block=key):
                self.assertGreater(w, 0)
                self.assertGreater(h, 0)
                self.assertGreaterEqual(x, 0)
                self.assertGreaterEqual(y, 0)


class SizePresetConsistencyTests(unittest.TestCase):

    def test_m_preset_returns_default_size(self):
        """Пресет «M — 100%» возвращает ровно размер по умолчанию."""
        for key, (_x, _y, width, height) in overlay.DEFAULT_BLOCK_POSITIONS.items():
            with self.subTest(block=key):
                self.assertEqual(overlay.preset_size(key, "M"), (width, height))

    def test_presets_scale_monotonically(self):
        """Больший пресет — больший размер, без совпадений соседних ступеней."""
        order = [name for name, _factor in overlay.SIZE_PRESETS]
        for key in overlay.DEFAULT_BLOCK_POSITIONS:
            sizes = [overlay.preset_size(key, name) for name in order]
            with self.subTest(block=key):
                self.assertTrue(all(sizes))
                heights = [h for _w, h in sizes]
                self.assertEqual(heights, sorted(heights))
                self.assertEqual(len(set(sizes)), len(sizes))

    def test_exobio_m_preset_is_not_the_clipped_height(self):
        """Пресет M для EXOBIO не возвращает обрезавшие окно 470 px."""
        self.assertNotEqual(overlay.preset_size("exobio", "M"), (360, 470))
        self.assertEqual(overlay.preset_size("exobio", "M")[1],
                         overlay.DEFAULT_SETTINGS["exobio_height"])

    def test_unknown_preset_and_block_return_none(self):
        self.assertIsNone(overlay.preset_size("exobio", "нет"))
        self.assertIsNone(overlay.preset_size("нет", "M"))


if __name__ == "__main__":
    unittest.main()
