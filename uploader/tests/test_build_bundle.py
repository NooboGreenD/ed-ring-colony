"""Сборка и публикация пакета из CI (`uploader/build_bundle.py`).

Тесты держат договорённости, нарушение которых ломает релиз целиком:
пакет собирается из кода программы (и только из него), подписывается ключом
из секретов, а на сервер уезжает не весь архив файлов, а то, чего у сервера
ещё нет. Сети нет — HTTP подменён заглушкой.
"""

import base64
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import build_bundle  # noqa: E402
import bundle  # noqa: E402


class _FakeHTTP:
    """Сервер публикации: первый запрос — «чего не хватает», второй — приём."""

    def __init__(self, known=(), fail_second=False):
        self.known = set(known)
        self.fail_second = fail_second
        self.calls = []

    def __call__(self, request, timeout=0):
        payload = json.loads(request.data.decode("utf-8"))
        self.calls.append(payload)
        manifest = payload.get("manifest") or {}
        if payload.get("launcher"):
            return _Reply({"ok": True, **payload["launcher"]})
        missing = [item["path"] for item in manifest.get("files", [])
                   if item["path"] not in self.known]
        if len(self.calls) == 1 and missing:
            raise build_bundle.urllib.error.HTTPError(
                "url", 409, "Conflict", {},
                io.BytesIO(json.dumps({"ok": False, "error": "не хватает файлов",
                                       "missing": missing}).encode("utf-8")))
        return _Reply({"ok": True, "version": manifest.get("version"),
                       "channel": manifest.get("channel"),
                       "stored_blobs": len(payload.get("files") or {}),
                       "signature_checked": True})


class _Reply:
    def __init__(self, data, status=200):
        self._data = json.dumps(data).encode("utf-8")
        self.status = status

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class BuildBundleTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        self.source = self.work / "uploader"
        self.source.mkdir(parents=True)
        for name, text in (
            ("colonial_helper.py", 'VERSION = "2.13.0"\ndef main():\n    return 0\n'),
            ("overlay.py", "BLOCKS = 7\n"),
            ("updater.py", 'VERSION = "2.13.0"\n'),
            ("launcher.py", 'LAUNCHER_VERSION = "1.4.0"\n'),
            ("build_exe.py", "# сборщик\n"),
            ("build_bundle.py", "# сборщик пакета\n"),
        ):
            (self.source / name).write_text(text, encoding="utf-8")
        (self.source / "requirements.txt").write_text("requests\n", encoding="utf-8")
        (self.source / "tests").mkdir()
        (self.source / "tests" / "test_x.py").write_text("# тест\n", encoding="utf-8")
        self.out = self.work / "out"
        self.secret = os.urandom(32)
        os.environ.pop(build_bundle.KEY_ENV, None)

    def tearDown(self):
        for name in (build_bundle.KEY_ENV, build_bundle.KEY_ID_ENV,
                     build_bundle.PUBLISH_URL_ENV, build_bundle.PUBLISH_TOKEN_ENV):
            os.environ.pop(name, None)
        shutil.rmtree(self.work, ignore_errors=True)

    def build(self, argv=()):
        return build_bundle.main(["--source", str(self.source), "--out", str(self.out), *argv])

    def manifest(self):
        return json.loads((self.out / bundle.MANIFEST_NAME).read_text(encoding="utf-8"))

    # -- состав пакета -----------------------------------------------------
    def test_package_contains_program_code_only(self):
        self.build()
        names = {item["path"] for item in self.manifest()["files"]}
        self.assertIn("colonial_helper.py", names)
        self.assertIn("overlay.py", names)
        # Сборочные скрипты и лаунчер живут в exe, а не в обновляемом пакете:
        # иначе обновление могло бы подменить сам механизм обновления.
        self.assertNotIn("build_exe.py", names)
        self.assertNotIn("build_bundle.py", names)
        self.assertNotIn("launcher.py", names)
        # Тесты и служебные файлы пилоту не нужны.
        self.assertFalse(any(name.startswith("tests/") for name in names))
        self.assertNotIn("requirements.txt", names)

    def test_archive_matches_the_manifest(self):
        self.build()
        manifest = self.manifest()
        archive = self.out / f"{manifest['version']}.zip"
        with zipfile.ZipFile(archive) as packed:
            # В архиве ровно файлы пакета плюс сам манифест: по нему клиент
            # сверяет каждый распакованный файл, а человек — видит, что внутри.
            self.assertEqual(sorted(packed.namelist()),
                             sorted([item["path"] for item in manifest["files"]]
                                    + [bundle.MANIFEST_NAME]))
            for item in manifest["files"]:
                self.assertEqual(bundle.sha256_bytes(packed.read(item["path"])), item["sha256"])
            self.assertEqual(json.loads(packed.read(bundle.MANIFEST_NAME)), manifest)

    def test_version_comes_from_the_program(self):
        self.build()
        self.assertEqual(self.manifest()["version"], "2.13.0")

    def test_channel_follows_the_branch(self):
        self.build(["--branch", "main"])
        self.assertEqual(self.manifest()["channel"], "stable")
        self.build(["--branch", "arena/experiment"])
        self.assertEqual(self.manifest()["channel"], "beta")
        self.build(["--branch", "arena/experiment", "--channel", "stable"])
        self.assertEqual(self.manifest()["channel"], "stable")

    def test_min_launcher_is_taken_from_the_launcher(self):
        """Пакет не должен требовать сборку новее той, что умеет его ставить."""
        self.build()
        self.assertEqual(build_bundle.launcher_version(self.source), "1.4.0")
        self.assertTrue(self.manifest()["min_launcher"])

    def test_notes_end_up_in_the_manifest(self):
        notes = self.work / "notes.md"
        notes.write_text("Раунд 67: обновление пакетом\n", encoding="utf-8")
        self.build(["--notes-file", str(notes)])
        self.assertIn("Раунд 67", self.manifest()["notes"])

    # -- подпись -----------------------------------------------------------
    def test_unsigned_by_default_but_signed_with_the_secret(self):
        self.build()
        self.assertNotIn("signature", self.manifest())

        os.environ[build_bundle.KEY_ENV] = base64.b64encode(self.secret).decode()
        os.environ[build_bundle.KEY_ID_ENV] = "ci"
        self.build()
        manifest = self.manifest()
        public = base64.b64encode(bundle.ed25519_public_key(self.secret)).decode()
        self.assertEqual(bundle.verify_manifest(manifest, {"ci": public}), "")

    def test_keygen_prints_a_usable_pair(self):
        """Ключи должны быть парой, а инструкция — называть оба места."""
        stream = io.StringIO()
        with mock.patch("sys.stdout", stream):
            build_bundle.keygen()
        text = stream.getvalue()
        secret = base64.b64decode(
            [l.split(":", 1)[1].strip() for l in text.splitlines() if "ПРИВАТНЫЙ" in l][0])
        public = base64.b64decode(
            [l.split(":", 1)[1].strip() for l in text.splitlines() if "ПУБЛИЧНЫЙ" in l][0])
        self.assertEqual(len(secret), 32)
        self.assertEqual(bundle.ed25519_public_key(secret), public)
        self.assertTrue(bundle.ed25519_verify(public, b"proba",
                                              bundle.ed25519_sign(secret, b"proba")))
        self.assertIn(build_bundle.KEY_ENV, text)
        self.assertIn("TRUSTED_KEYS", text)

    # -- встраивание в exe --------------------------------------------------
    def test_embed_writes_a_ready_to_run_copy(self):
        os.environ[build_bundle.KEY_ENV] = base64.b64encode(self.secret).decode()
        os.environ[build_bundle.KEY_ID_ENV] = "ci"
        embed = self.work / "embedded"
        self.build(["--embed", str(embed)])
        self.assertTrue((embed / bundle.MANIFEST_NAME).is_file())
        self.assertTrue((embed / "colonial_helper.py").is_file())
        public = base64.b64encode(bundle.ed25519_public_key(self.secret)).decode()
        embedded_manifest = json.loads((embed / bundle.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(bundle.verify_manifest(embedded_manifest, {"ci": public}), "")

    # -- публикация ----------------------------------------------------------
    def test_publish_sends_only_files_the_server_lacks(self):
        self.build()
        manifest = self.manifest()
        archive = self.out / f"{manifest['version']}.zip"
        known = [item["path"] for item in manifest["files"]][1:]
        http = _FakeHTTP(known=known)
        with mock.patch.object(build_bundle.urllib.request, "urlopen", http):
            build_bundle.publish(manifest, archive, "https://edringcolony.ru/api/admin/uploader/publish", "token")
        self.assertEqual(len(http.calls), 2, "должен быть запрос-разведка и запрос-публикация")
        self.assertEqual(http.calls[0]["files"], {}, "разведка не должна тащить файлы")
        sent = set(http.calls[1]["files"])
        self.assertEqual(sent, {manifest["files"][0]["path"]})
        self.assertIn("bundle_base64", http.calls[1])

    def test_publish_sends_everything_to_an_empty_server(self):
        self.build()
        manifest = self.manifest()
        http = _FakeHTTP(known=())
        with mock.patch.object(build_bundle.urllib.request, "urlopen", http):
            build_bundle.publish(manifest, self.out / f"{manifest['version']}.zip",
                                 "https://edringcolony.ru/api/admin/uploader/publish", "token")
        self.assertEqual(set(http.calls[1]["files"]),
                         {item["path"] for item in manifest["files"]})

    def test_publish_without_token_fails_loudly(self):
        self.build()
        manifest = self.manifest()
        with self.assertRaises(SystemExit):
            build_bundle.publish(manifest, self.out / f"{manifest['version']}.zip", "", "")

    def test_publish_existing_does_not_rebuild(self):
        """Иначе на сервер уехал бы пакет с другим временем и другой подписью."""
        os.environ[build_bundle.KEY_ENV] = base64.b64encode(self.secret).decode()
        self.build()
        before = self.manifest()
        http = _FakeHTTP(known=())
        with mock.patch.object(build_bundle.urllib.request, "urlopen", http):
            build_bundle.main(["--source", str(self.source), "--out", str(self.out),
                               "--publish-existing",
                               "--publish-url", "https://edringcolony.ru/api/admin/uploader/publish",
                               "--publish-token", "token"])
        self.assertEqual(http.calls[0]["manifest"]["signature"], before["signature"])
        self.assertEqual(self.manifest()["released_at"], before["released_at"])

    def test_launcher_metadata_publishes_hash_and_size(self):
        exe = self.work / "ColonialHelper.exe"
        exe.write_bytes(b"MZ" + b"\x00" * 1000)
        http = _FakeHTTP()
        with mock.patch.object(build_bundle.urllib.request, "urlopen", http):
            build_bundle.main(["--source", str(self.source),
                               "--publish-launcher", str(exe),
                               "--launcher-url", "https://github.com/x/y/releases/download/v1/ColonialHelper.exe",
                               "--publish-url", "https://edringcolony.ru/api/admin/uploader/publish",
                               "--publish-token", "token"])
        sent = http.calls[0]["launcher"]
        self.assertEqual(sent["version"], "1.4.0")
        self.assertEqual(sent["sha256"], bundle.sha256_file(exe))
        self.assertEqual(sent["size"], exe.stat().st_size)
        self.assertEqual(sent["platform"], "win64")


if __name__ == "__main__":
    unittest.main()
