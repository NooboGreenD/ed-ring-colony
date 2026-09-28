"""Лаунчер: что он запускает и как ведёт себя, когда всё сломалось.

Лаунчер — единственная часть программы, которую нельзя починить обновлением
(он внутри exe). Поэтому тесты проверяют не «счастливый путь», а именно
аварийные ветки: испорченный пакет, версия-самоубийца, пустая установка.
Правило, которое они держат: **программа обязана запуститься всегда.**
"""

import base64
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import bundle  # noqa: E402
import bundle_updater  # noqa: E402
import launcher  # noqa: E402

ENTRY = "fake_app.py"


def make_keys():
    secret = os.urandom(32)
    return secret, {"test": base64.b64encode(bundle.ed25519_public_key(secret)).decode("ascii")}


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.secret, self.keys = make_keys()
        self.work = Path(tempfile.mkdtemp())
        self.root = self.work / "install"
        self.embedded = self.work / "embedded"
        os.environ[bundle.KEYS_ENV] = f"test:{self.keys['test']}"
        self.write_embedded("1.0.0")

    def tearDown(self):
        os.environ.pop(bundle.KEYS_ENV, None)
        for name in ("fake_app",):
            sys.modules.pop(name, None)
        for path in (str(bundle.version_dir(self.root, v)) for v in ("1.0.0", "1.1.0")):
            while path in sys.path:
                sys.path.remove(path)
        shutil.rmtree(self.work, ignore_errors=True)

    # -- вспомогательное --------------------------------------------------
    def write_embedded(self, version: str, marker: str = "ok"):
        shutil.rmtree(self.embedded, ignore_errors=True)
        self.embedded.mkdir(parents=True, exist_ok=True)
        (self.embedded / ENTRY).write_text(
            f'VERSION = "{version}"\nMARKER = "{marker}"\n'
            "def main():\n    return 0\n", encoding="utf-8")
        manifest = bundle.build_manifest(self.embedded, version=version, entry=ENTRY,
                                         files=[ENTRY])
        manifest = bundle.sign_manifest(manifest, self.secret, "test")
        (self.embedded / bundle.MANIFEST_NAME).write_text(
            json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        return manifest

    def choose(self):
        folder, manifest = self.embedded, json.loads(
            (self.embedded / bundle.MANIFEST_NAME).read_text(encoding="utf-8"))
        return launcher.choose_version(self.root, folder, manifest)

    # -- первый запуск ----------------------------------------------------
    def test_first_run_installs_the_embedded_package(self):
        version = self.choose()
        self.assertEqual(version, "1.0.0")
        self.assertEqual(bundle.verify_installed(self.root, "1.0.0", keys=self.keys), "")
        # Встроенная копия не «на испытательном сроке»: она приехала с exe.
        self.assertIsNone(bundle.load_state(self.root)["pending"])

    def test_newer_embedded_package_replaces_installed(self):
        self.choose()
        self.write_embedded("1.2.0")
        self.assertEqual(self.choose(), "1.2.0")
        self.assertEqual(bundle.load_state(self.root)["current"], "1.2.0")

    def test_older_embedded_package_does_not_downgrade(self):
        """Скачанное обновление новее того, что лежит в exe, — его и запускаем."""
        self.choose()
        bundle.version_dir(self.root, "1.5.0").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(bundle.version_dir(self.root, "1.0.0") / ENTRY,
                        bundle.version_dir(self.root, "1.5.0") / ENTRY)
        manifest = bundle.sign_manifest(
            bundle.build_manifest(bundle.version_dir(self.root, "1.5.0"), version="1.5.0",
                                  entry=ENTRY, files=[ENTRY]), self.secret, "test")
        (bundle.version_dir(self.root, "1.5.0") / bundle.MANIFEST_NAME).write_text(
            json.dumps(manifest), encoding="utf-8")
        bundle.activate(self.root, "1.5.0")
        bundle.mark_healthy(self.root, "1.5.0")
        self.assertEqual(self.choose(), "1.5.0")

    # -- аварийные ветки ---------------------------------------------------
    def test_damaged_current_version_falls_back(self):
        self.choose()
        (bundle.version_dir(self.root, "1.0.0") / ENTRY).write_text("сломано\n", encoding="utf-8")
        version = self.choose()
        # Повреждённую версию не запускаем: переставляем её из exe.
        self.assertEqual(version, "1.0.0")
        self.assertEqual(bundle.verify_installed(self.root, "1.0.0", keys=self.keys), "")

    def test_version_that_never_reports_healthy_is_rolled_back(self):
        self.choose()  # 1.0.0 установлена и здорова
        # Пришло обновление 1.1.0 и оно падает на старте.
        target = bundle.version_dir(self.root, "1.1.0")
        target.mkdir(parents=True, exist_ok=True)
        (target / ENTRY).write_text('VERSION = "1.1.0"\ndef main():\n    return 0\n',
                                    encoding="utf-8")
        manifest = bundle.sign_manifest(
            bundle.build_manifest(target, version="1.1.0", entry=ENTRY, files=[ENTRY]),
            self.secret, "test")
        (target / bundle.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
        bundle.activate(self.root, "1.1.0")

        self.assertEqual(self.choose(), "1.1.0")   # попытка 1
        self.assertEqual(self.choose(), "1.1.0")   # попытка 2
        self.assertEqual(self.choose(), "1.0.0")   # обе молчали — откат
        self.assertEqual(bundle.load_state(self.root)["current"], "1.0.0")

    def test_empty_installation_without_embedded_package_is_survivable(self):
        """Нет ни установки, ни встроенной копии — лаунчер не падает."""
        self.assertEqual(launcher.choose_version(self.root, None, None), "")

    # -- запуск кода -------------------------------------------------------
    def test_activate_path_puts_version_first_and_drops_cached_modules(self):
        self.choose()
        sys.modules["bundle_updater"] = bundle_updater
        folder = launcher.activate_path(self.root, "1.0.0")
        self.assertEqual(sys.path[0], str(folder))
        self.assertNotIn("bundle_updater", sys.modules)
        importlib.import_module("bundle_updater")  # вернуть на место для других тестов

    def test_run_module_calls_main_of_the_installed_version(self):
        self.choose()
        launcher.activate_path(self.root, "1.0.0")
        self.assertEqual(launcher.run_module("fake_app"), 0)
        self.assertEqual(sys.modules["fake_app"].VERSION, "1.0.0")

    def test_entry_module_name_comes_from_manifest(self):
        self.assertEqual(launcher.entry_module({"entry": "colonial_helper.py"}), "colonial_helper")
        self.assertEqual(launcher.entry_module({}), "colonial_helper")
        self.assertEqual(launcher.entry_module({"entry": ENTRY}), "fake_app")

    def test_main_runs_the_installed_code(self):
        manifest = json.loads((self.embedded / bundle.MANIFEST_NAME).read_text(encoding="utf-8"))
        with mock.patch.object(launcher, "frozen_dir", return_value=self.work), \
             mock.patch.dict(os.environ, {bundle.HOME_ENV: str(self.root)}):
            shutil.rmtree(self.work / launcher.EMBEDDED_DIR, ignore_errors=True)
            shutil.copytree(self.embedded, self.work / launcher.EMBEDDED_DIR)
            code = launcher.main([])
            # Переменные читает уже запущенный код программы, поэтому
            # проверяем их внутри того же окружения.
            self.assertEqual(os.environ[launcher.ENV_LAUNCHER], launcher.LAUNCHER_VERSION)
            self.assertEqual(os.environ[launcher.ENV_VERSION], manifest["version"])
        self.assertEqual(code, 0)

    def test_bundle_info_reports_state(self):
        self.choose()
        stream = StringIO()
        with mock.patch.object(launcher, "frozen_dir", return_value=self.work), \
             mock.patch.dict(os.environ, {bundle.HOME_ENV: str(self.root)}), \
             mock.patch("sys.stdout", stream):
            launcher.main(["--bundle-info"])
        data = json.loads(stream.getvalue())
        self.assertEqual(data["current"], "1.0.0")
        self.assertEqual(data["launcher"], launcher.LAUNCHER_VERSION)

    def test_launcher_version_flag(self):
        stream = StringIO()
        with mock.patch("sys.stdout", stream):
            launcher.main(["--launcher-version"])
        self.assertEqual(stream.getvalue().strip(), launcher.LAUNCHER_VERSION)

    def test_log_is_written_next_to_the_installation(self):
        launcher.log(self.root, "проверка журнала")
        self.assertIn("проверка журнала",
                      launcher.log_path(self.root).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
