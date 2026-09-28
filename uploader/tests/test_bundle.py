"""Формат пакета кода: подпись, валидация, раскладка установки.

Пакет — это исполняемый код, который приезжает по сети. Поэтому тесты держат
не «удобные» свойства, а те, без которых механизм опасен или ненадёжен:

* подпись Ed25519 совпадает с RFC 8032 и не принимает подделку;
* канонизация манифеста не зависит от порядка ключей (иначе подпись «плавает»);
* путь файла в пакете не может вывести запись за пределы каталога версии;
* установка переключается атомарно, откатывается и умеет ловить порчу файлов.
"""

import base64
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import bundle  # noqa: E402


def make_keys():
    secret = os.urandom(32)
    public = base64.b64encode(bundle.ed25519_public_key(secret)).decode("ascii")
    return secret, {"test": public}


def make_package(folder: Path, version: str = "1.0.0", extra: str = "") -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "colonial_helper.py").write_text(
        f'VERSION = "{version}"\n{extra}\ndef main():\n    return 0\n', encoding="utf-8")
    (folder / "overlay.py").write_text("BLOCKS = 7\n", encoding="utf-8")
    (folder / "api_client.py").write_text("TIMEOUT = 15\n", encoding="utf-8")


class Ed25519Tests(unittest.TestCase):
    """Своя реализация подписи обязана совпадать с эталоном RFC 8032."""

    VECTORS = [
        ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
         "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
         "",
         "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a"
         "33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
        ("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
         "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
         "72",
         "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e"
         "15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    ]

    def test_rfc8032_vectors(self):
        for secret_hex, public_hex, message_hex, signature_hex in self.VECTORS:
            secret = bytes.fromhex(secret_hex)
            message = bytes.fromhex(message_hex)
            self.assertEqual(bundle.ed25519_public_key(secret), bytes.fromhex(public_hex))
            self.assertEqual(bundle.ed25519_sign(secret, message), bytes.fromhex(signature_hex))
            self.assertTrue(bundle.ed25519_verify(
                bytes.fromhex(public_hex), message, bytes.fromhex(signature_hex)))

    def test_broken_input_is_false_not_exception(self):
        """Проверка подписи зовётся на данных из сети — падать она не должна."""
        for public, message, signature in (
            (b"", b"x", b""),
            (b"\x00" * 32, b"x", b"\x01" * 64),
            (b"\xff" * 32, b"x", b"\x00" * 64),
            (b"\x00" * 31, b"x", b"\x00" * 63),
        ):
            self.assertFalse(bundle.ed25519_verify(public, message, signature))


class CanonicalFormTests(unittest.TestCase):
    def test_key_order_does_not_change_signature(self):
        secret, keys = make_keys()
        manifest = {"schema": 1, "channel": "stable", "version": "1.0.0",
                    "entry": "colonial_helper.py", "notes": "ченджлог по-русски",
                    "files": [{"path": "colonial_helper.py", "size": 1, "sha256": "a" * 64}]}
        signed = bundle.sign_manifest(manifest, secret, "test")
        shuffled = dict(reversed(list(signed.items())))
        self.assertEqual(bundle.canonical_bytes(signed), bundle.canonical_bytes(shuffled))
        self.assertEqual(bundle.verify_manifest(shuffled, keys), "")

    def test_signature_field_is_not_signed_over(self):
        canonical = bundle.canonical_bytes({"a": 1, "signature": {"value": "x"}})
        self.assertEqual(canonical, b'{"a":1}')


class ManifestValidationTests(unittest.TestCase):
    def setUp(self):
        self.secret, self.keys = make_keys()
        self.work = Path(tempfile.mkdtemp())
        self.source = self.work / "src"
        make_package(self.source)

    def tearDown(self):
        shutil.rmtree(self.work, ignore_errors=True)

    def build(self, **kwargs):
        manifest = bundle.build_manifest(self.source, version="1.0.0", **kwargs)
        return bundle.sign_manifest(manifest, self.secret, "test")

    def test_signed_manifest_is_accepted(self):
        self.assertEqual(bundle.verify_manifest(self.build(), self.keys), "")

    def test_tampered_file_hash_breaks_signature(self):
        manifest = self.build()
        manifest["files"][0]["sha256"] = "b" * 64
        self.assertIn("подпись", bundle.verify_manifest(manifest, self.keys))

    def test_unknown_key_is_rejected(self):
        manifest = self.build()
        manifest["signature"]["key_id"] = "someone-else"
        self.assertIn("неизвестным ключом", bundle.verify_manifest(manifest, self.keys))

    def test_unsigned_manifest_is_rejected(self):
        manifest = bundle.build_manifest(self.source, version="1.0.0")
        self.assertIn("не подписан", bundle.verify_manifest(manifest, self.keys))

    def test_without_trusted_keys_nothing_is_installable(self):
        """Пустой TRUSTED_KEYS — это «канал не настроен», а не «всё разрешено»."""
        manifest = self.build()
        saved = dict(bundle.TRUSTED_KEYS)
        env = os.environ.pop(bundle.KEYS_ENV, None)
        bundle.TRUSTED_KEYS.clear()
        try:
            self.assertIn("не настроен", bundle.verify_manifest(manifest))
        finally:
            bundle.TRUSTED_KEYS.update(saved)
            if env is not None:
                os.environ[bundle.KEYS_ENV] = env

    def test_environment_key_is_trusted(self):
        manifest = self.build()
        os.environ[bundle.KEYS_ENV] = f"test:{self.keys['test']}"
        try:
            self.assertEqual(bundle.verify_manifest(manifest), "")
        finally:
            os.environ.pop(bundle.KEYS_ENV, None)

    def test_schema_from_the_future_is_refused(self):
        manifest = self.build()
        manifest["schema"] = bundle.SCHEMA + 1
        self.assertIn("схема", bundle.verify_manifest(manifest, self.keys))

    def test_entry_must_be_in_the_file_list(self):
        manifest = bundle.build_manifest(self.source, version="1.0.0")
        manifest["entry"] = "overlay.py"
        self.assertEqual(bundle.check_manifest(manifest), "")
        manifest["entry"] = "missing.py"
        self.assertIn("отсутствует", bundle.check_manifest(manifest))


class MemberPathTests(unittest.TestCase):
    def test_dangerous_paths_are_rejected(self):
        for value in ("../evil.py", "/etc/passwd", "C:/windows/system.py",
                      "a\\b.py", ".hidden/mod.py", "sub/../../x.py", "",
                      "mod.exe", "mod.dll", "mod.bat", "mod", "a" * 250 + ".py"):
            with self.subTest(value=value):
                with self.assertRaises(bundle.BundleError):
                    bundle.safe_member_path(value)

    def test_normal_paths_pass(self):
        for value in ("colonial_helper.py", "data/prices.json", "docs/readme.md"):
            self.assertEqual(bundle.safe_member_path(value), value)


class InstallLayoutTests(unittest.TestCase):
    def setUp(self):
        self.secret, self.keys = make_keys()
        self.work = Path(tempfile.mkdtemp())
        self.root = self.work / "install"
        self.source = self.work / "src"
        make_package(self.source)
        manifest = bundle.build_manifest(self.source, version="1.0.0")
        self.manifest = bundle.sign_manifest(manifest, self.secret, "test")
        contents = {item["path"]: (self.source / item["path"]).read_bytes()
                    for item in self.manifest["files"]}
        bundle.write_bundle_files(bundle.version_dir(self.root, "1.0.0"), self.manifest, contents)
        bundle.activate(self.root, "1.0.0")

    def tearDown(self):
        shutil.rmtree(self.work, ignore_errors=True)

    def test_installed_version_verifies(self):
        self.assertEqual(bundle.verify_installed(self.root, "1.0.0", keys=self.keys), "")

    def test_modified_file_is_detected(self):
        target = bundle.version_dir(self.root, "1.0.0") / "overlay.py"
        target.write_text("BLOCKS = 7\nimport os  # подложили\n", encoding="utf-8")
        problem = bundle.verify_installed(self.root, "1.0.0", keys=self.keys)
        self.assertIn("overlay.py", problem)

    def test_activate_remembers_previous_and_sets_probation(self):
        bundle.activate(self.root, "1.0.1")
        state = bundle.load_state(self.root)
        self.assertEqual(state["current"], "1.0.1")
        self.assertEqual(state["previous"], "1.0.0")
        self.assertEqual(state["pending"], {"version": "1.0.1", "attempts": 0})

    def test_rollback_needs_two_silent_launches(self):
        """Один неудачный запуск — случайность, два подряд — откат."""
        bundle.activate(self.root, "1.0.1")
        bundle.note_launch(self.root, "1.0.1")
        self.assertFalse(bundle.needs_rollback(bundle.load_state(self.root)))
        bundle.note_launch(self.root, "1.0.1")
        self.assertTrue(bundle.needs_rollback(bundle.load_state(self.root)))

    def test_healthy_version_never_rolls_back(self):
        bundle.activate(self.root, "1.0.1")
        bundle.note_launch(self.root, "1.0.1")
        bundle.mark_healthy(self.root, "1.0.1")
        for _ in range(5):
            bundle.note_launch(self.root, "1.0.1")
        self.assertFalse(bundle.needs_rollback(bundle.load_state(self.root)))

    def test_rollback_returns_to_previous_only_if_it_exists(self):
        bundle.activate(self.root, "1.0.1")
        self.assertEqual(bundle.rollback(self.root), "1.0.0")
        self.assertEqual(bundle.load_state(self.root)["current"], "1.0.0")
        # Откатываться больше некуда: предыдущей версии нет.
        self.assertEqual(bundle.rollback(self.root), "")

    def test_broken_state_file_does_not_crash(self):
        bundle.state_path(self.root).write_text("{не json", encoding="utf-8")
        state = bundle.load_state(self.root)
        self.assertEqual(state["current"], "")

    def test_prune_keeps_current_and_previous(self):
        for version in ("1.0.1", "1.0.2", "1.0.3"):
            target = bundle.version_dir(self.root, version)
            target.mkdir(parents=True, exist_ok=True)
            (target / "colonial_helper.py").write_text("x = 1\n", encoding="utf-8")
            bundle.activate(self.root, version)
        bundle.prune_versions(self.root, keep=1)
        left = set(bundle.installed_versions(self.root))
        self.assertIn("1.0.3", left)
        self.assertIn("1.0.2", left)
        self.assertNotIn("1.0.0", left)

    def test_stage_promotion_is_atomic_enough(self):
        stage = bundle.stage_dir(self.root, "1.0.1")
        stage.mkdir(parents=True, exist_ok=True)
        (stage / "colonial_helper.py").write_text("VERSION='1.0.1'\n", encoding="utf-8")
        bundle.promote_stage(self.root, "1.0.1")
        self.assertFalse(stage.exists())
        self.assertTrue((bundle.version_dir(self.root, "1.0.1") / "colonial_helper.py").is_file())

    def test_install_root_respects_environment(self):
        os.environ[bundle.HOME_ENV] = str(self.work / "elsewhere")
        try:
            self.assertEqual(bundle.install_root(), self.work / "elsewhere")
        finally:
            os.environ.pop(bundle.HOME_ENV, None)


class LauncherCompatibilityTests(unittest.TestCase):
    def test_min_launcher_is_respected(self):
        manifest = {"min_launcher": "1.2.0"}
        self.assertFalse(bundle.launcher_supports(manifest, "1.1.9"))
        self.assertTrue(bundle.launcher_supports(manifest, "1.2.0"))
        self.assertTrue(bundle.launcher_supports(manifest, "2.0.0"))
        self.assertTrue(bundle.launcher_supports({}, "0.0.1"))

    def test_version_tuple_ignores_branch_suffix(self):
        self.assertEqual(bundle.version_tuple("v2.13.0-arena-abc"), (2, 13, 0))
        self.assertEqual(bundle.version_tuple("garbage"), ())


if __name__ == "__main__":
    unittest.main()
