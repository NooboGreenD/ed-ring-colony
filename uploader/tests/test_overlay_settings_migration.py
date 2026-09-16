"""Миграция версии схемы HUD-настроек (2.8.4).

Зачем: 2.8.3 подняла высоту окна EXOBIO по умолчанию с 470 до 620 px, потому
что раздел «Поиск планет» обрезался. Но `load_overlay_settings` перекрывает
DEFAULT_SETTINGS сохранённым конфигом, а конфиг с `exobio_height: 470` есть у
каждого, кто хоть раз менял настройки. Без миграции исправление доставалось
только свежим установкам — то есть тем, у кого проблемы и не было.

Миграция поднимает дефолт только там, где пользователь его не менял: если
сохранённое значение всё ещё равно прежнему дефолту. Свой размер окна,
заданный вручную, остаётся нетронутым.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_overlay_management import _ensure_gui_stubs  # noqa: E402

_ensure_gui_stubs()

import overlay  # noqa: E402


def _config(data: dict) -> Path:
    path = Path(tempfile.mkdtemp()) / "overlay_settings.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


class SettingsMigrationTests(unittest.TestCase):

    def test_old_default_height_is_raised(self):
        """Конфиг от 2.8.2 со значением по умолчанию получает новую высоту."""
        settings = overlay.load_overlay_settings(_config({"exobio_height": 470}))

        self.assertEqual(settings["exobio_height"], overlay.DEFAULT_SETTINGS["exobio_height"])
        self.assertEqual(settings["exobio_height"], 620)
        self.assertEqual(settings["settings_schema"], overlay.SETTINGS_SCHEMA_VERSION)

    def test_user_resized_height_is_preserved(self):
        """Свой размер окна миграция не трогает — даже если он меньше нового дефолта."""
        settings = overlay.load_overlay_settings(_config({"exobio_height": 540}))

        self.assertEqual(settings["exobio_height"], 540)

    def test_already_migrated_config_is_untouched(self):
        """После миграции значение 470 считается сознательным выбором."""
        path = _config({"exobio_height": 470,
                        "settings_schema": overlay.SETTINGS_SCHEMA_VERSION})

        self.assertEqual(overlay.load_overlay_settings(path)["exobio_height"], 470)

    def test_migration_runs_only_once(self):
        """Цикл «загрузил — сохранил — загрузил» не поднимает высоту повторно."""
        path = _config({"exobio_height": 470})

        first = overlay.load_overlay_settings(path)
        overlay.save_overlay_settings(path, first)

        raw = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(raw["settings_schema"], overlay.SETTINGS_SCHEMA_VERSION)
        self.assertEqual(raw["exobio_height"], 620)

        # пользователь вернул высоту обратно уже на новой схеме
        second = overlay.load_overlay_settings(path)
        second["exobio_height"] = 470
        overlay.save_overlay_settings(path, second)

        self.assertEqual(overlay.load_overlay_settings(path)["exobio_height"], 470)

    def test_missing_key_falls_back_to_default(self):
        """Конфиг без ключа просто берёт текущий дефолт."""
        settings = overlay.load_overlay_settings(_config({"exobio_width": 360}))

        self.assertEqual(settings["exobio_height"], 620)

    def test_garbage_schema_version_is_treated_as_old(self):
        """Битая версия схемы не роняет загрузку и мигрирует как первая."""
        settings = overlay.load_overlay_settings(
            _config({"settings_schema": "мусор", "exobio_height": 470})
        )

        self.assertEqual(settings["exobio_height"], 620)
        self.assertEqual(settings["settings_schema"], overlay.SETTINGS_SCHEMA_VERSION)

    def test_future_schema_is_not_downgraded(self):
        """Конфиг от более новой версии не переписывается назад."""
        ahead = overlay.SETTINGS_SCHEMA_VERSION + 1
        path = _config({"settings_schema": ahead, "exobio_height": 470})

        settings = overlay.load_overlay_settings(path)

        self.assertEqual(settings["exobio_height"], 470)
        self.assertEqual(settings["settings_schema"], ahead)

    def test_credentials_survive_migration(self):
        """Миграция не вычищает из конфига ключи сторонних сервисов."""
        path = _config({"exobio_height": 470, "rcc_key": "SECRET"})

        self.assertEqual(overlay.load_overlay_settings(path)["rcc_key"], "SECRET")

    def test_absent_config_uses_current_schema(self):
        """Без конфига схема уже актуальная — миграция не нужна."""
        settings = overlay.load_overlay_settings(Path(tempfile.mkdtemp()) / "нет.json")

        self.assertEqual(settings["exobio_height"], 620)
        self.assertEqual(settings["settings_schema"], overlay.SETTINGS_SCHEMA_VERSION)

    def test_corrupt_config_still_loads(self):
        """Нечитаемый конфиг не роняет загрузку настроек."""
        path = Path(tempfile.mkdtemp()) / "overlay_settings.json"
        path.write_text("{ не json", encoding="utf-8")

        settings = overlay.load_overlay_settings(path)

        self.assertEqual(settings["exobio_height"], 620)

    def test_default_changes_table_is_consistent(self):
        """Таблица миграций ссылается только на существующие ключи и версии."""
        for version, changes in overlay.SETTINGS_DEFAULT_CHANGES.items():
            self.assertLessEqual(version, overlay.SETTINGS_SCHEMA_VERSION)
            self.assertGreater(version, 1)
            for key, old_default in changes.items():
                self.assertIn(key, overlay.DEFAULT_SETTINGS)
                self.assertNotEqual(
                    old_default, overlay.DEFAULT_SETTINGS[key],
                    f"{key}: прежнее значение равно текущему, миграция бессмысленна",
                )

    def test_schema_version_is_persisted_by_default(self):
        """Версия схемы лежит в DEFAULT_SETTINGS, иначе save её не запишет."""
        self.assertIn("settings_schema", overlay.DEFAULT_SETTINGS)
        self.assertEqual(
            overlay.DEFAULT_SETTINGS["settings_schema"], overlay.SETTINGS_SCHEMA_VERSION
        )


#: Конфиг пользователя 2.8.2: позиции и размеры — прежние значения по умолчанию.
LEGACY_LAYOUT = {
    "ship_x": 50, "ship_y": 440,
    "cargo_x": 50, "cargo_y": 1000,
    "session_x": 400, "session_y": 50,
    "events_x": 730, "events_y": 50,
    "exobio_x": 1060, "exobio_y": 50,
    "carrier_x": 1060, "carrier_y": 430,
    "exobio_width": 360, "exobio_height": 470,
    "carrier_width": 330, "carrier_height": 300,
    "cargo_width": 300, "cargo_height": 340,
}


def _rect(settings: dict, block: str):
    x = settings[f"{block}_x"]
    y = settings[f"{block}_y"]
    return (x, y, x + settings[f"{block}_width"], y + settings[f"{block}_height"])


class PositionMigrationTests(unittest.TestCase):
    """Схема 3: прежняя раскладка наезжала друг на друга и уходила за экран."""

    def test_untouched_blocks_move_to_the_new_grid(self):
        settings = overlay.load_overlay_settings(_config(dict(LEGACY_LAYOUT)))

        for block, (_old_x, _old_y) in overlay.SETTINGS_POSITION_CHANGES[3].items():
            with self.subTest(block=block):
                self.assertEqual(settings[f"{block}_x"],
                                 overlay.DEFAULT_SETTINGS[f"{block}_x"])
                self.assertEqual(settings[f"{block}_y"],
                                 overlay.DEFAULT_SETTINGS[f"{block}_y"])

    def test_migrated_layout_has_no_overlap_and_fits_screen(self):
        """Главный смысл миграции: блоки не лежат друг на друге и видны."""
        settings = overlay.load_overlay_settings(_config(dict(LEGACY_LAYOUT)))

        rects = {block: _rect(settings, block) for block in overlay.OverlayManager.BLOCKS}

        overlaps = []
        keys = sorted(rects)
        for i, a in enumerate(keys):
            for b in keys[i + 1:]:
                ax0, ay0, ax1, ay1 = rects[a]
                bx0, by0, bx1, by1 = rects[b]
                ox = min(ax1, bx1) - max(ax0, bx0)
                oy = min(ay1, by1) - max(ay0, by0)
                if ox > 0 and oy > 0:
                    overlaps.append(f"{a} x {b}: {ox}x{oy} px")

        self.assertEqual(overlaps, [], "\n".join(overlaps))

        offscreen = [b for b, (_x0, _y0, x1, y1) in rects.items()
                     if x1 > 1920 or y1 > 1080]
        self.assertEqual(offscreen, [], f"за пределами 1920x1080: {offscreen}")

    def test_legacy_layout_actually_was_broken(self):
        """Проверяем саму premise: до миграции раскладка действительно плохая."""
        rects = {
            "exobio": (1060, 50, 1060 + 360, 50 + 620),   # высота уже поднята схемой 2
            "carrier": (1060, 430, 1060 + 330, 430 + 300),
            "cargo": (50, 1000, 50 + 300, 1000 + 340),
        }

        ex = rects["exobio"]
        ca = rects["carrier"]
        self.assertGreater(min(ex[2], ca[2]) - max(ex[0], ca[0]), 0)
        self.assertGreater(min(ex[3], ca[3]) - max(ex[1], ca[1]), 0)
        self.assertGreater(rects["cargo"][3], 1080)

    def test_manually_moved_block_is_not_touched(self):
        """Блок, который пользователь поставил сам, остаётся на месте."""
        data = dict(LEGACY_LAYOUT)
        data["carrier_x"] = 1500
        data["carrier_y"] = 700

        settings = overlay.load_overlay_settings(_config(data))

        self.assertEqual((settings["carrier_x"], settings["carrier_y"]), (1500, 700))

    def test_partially_moved_block_is_not_touched(self):
        """Совпала только одна координата — значит блок двигали, не трогаем."""
        data = dict(LEGACY_LAYOUT)
        data["carrier_x"] = 1060   # прежний дефолт
        data["carrier_y"] = 45     # но по vertical пользователь его поднял

        settings = overlay.load_overlay_settings(_config(data))

        self.assertEqual((settings["carrier_x"], settings["carrier_y"]), (1060, 45))

    def test_position_migration_runs_once(self):
        """После записи схемы 3 повторная загрузка ничего не двигает."""
        path = _config(dict(LEGACY_LAYOUT))

        first = overlay.load_overlay_settings(path)
        overlay.save_overlay_settings(path, first)

        # пользователь вернул CARRIER на прежнее место уже на новой схеме
        second = overlay.load_overlay_settings(path)
        second["carrier_x"] = 1060
        second["carrier_y"] = 430
        overlay.save_overlay_settings(path, second)

        third = overlay.load_overlay_settings(path)
        self.assertEqual((third["carrier_x"], third["carrier_y"]), (1060, 430))

    def test_position_table_is_consistent(self):
        """Таблица позиций ссылается на существующие блоки и реально меняет их."""
        for version, changes in overlay.SETTINGS_POSITION_CHANGES.items():
            self.assertLessEqual(version, overlay.SETTINGS_SCHEMA_VERSION)
            self.assertGreater(version, 1)
            for block, (old_x, old_y) in changes.items():
                with self.subTest(block=block):
                    self.assertIn(block, overlay.DEFAULT_BLOCK_POSITIONS)
                    self.assertIn(f"{block}_x", overlay.DEFAULT_SETTINGS)
                    self.assertNotEqual(
                        (old_x, old_y),
                        (overlay.DEFAULT_SETTINGS[f"{block}_x"],
                         overlay.DEFAULT_SETTINGS[f"{block}_y"]),
                        f"{block}: прежняя позиция равна текущей, миграция бессмысленна",
                    )

    def test_every_block_has_geometry_in_settings(self):
        """У каждого блока в DEFAULT_SETTINGS есть x/y/width/height."""
        for block in overlay.DEFAULT_BLOCK_POSITIONS:
            for suffix in ("x", "y", "width", "height"):
                with self.subTest(key=f"{block}_{suffix}"):
                    self.assertIn(f"{block}_{suffix}", overlay.DEFAULT_SETTINGS)


class ShipCompactHeightMigrationTests(unittest.TestCase):
    """2.10.23: SHIP пересобран в текстовый HUD — прежние 420 px больше не нужны."""

    def test_old_default_ship_height_is_shrunk(self):
        settings = overlay.load_overlay_settings(
            _config({"ship_height": 420, "settings_schema": 3}))
        self.assertEqual(settings["ship_height"], overlay.DEFAULT_SETTINGS["ship_height"])
        self.assertEqual(settings["ship_height"],
                         overlay.DEFAULT_BLOCK_POSITIONS["ship"][3])
        self.assertLess(settings["ship_height"], 420,
                        "компактный HUD не должен занимать половину экрана")

    def test_manual_ship_height_is_preserved(self):
        settings = overlay.load_overlay_settings(
            _config({"ship_height": 520, "settings_schema": 3}))
        self.assertEqual(settings["ship_height"], 520)

    def test_modules_view_mode_is_default_and_persistable(self):
        """Новый ключ есть в дефолтах — иначе он не доедет до конфига."""
        self.assertEqual(overlay.DEFAULT_SETTINGS["ship_modules_view"], "important")
        path = _config({"ship_modules_view": "all"})
        settings = overlay.load_overlay_settings(path)
        overlay.save_overlay_settings(path, settings)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["ship_modules_view"], "all")


if __name__ == "__main__":
    unittest.main()
