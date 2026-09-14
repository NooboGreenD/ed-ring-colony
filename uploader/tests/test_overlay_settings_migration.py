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


if __name__ == "__main__":
    unittest.main()
