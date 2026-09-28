"""Обновление кода по сети: дельта, проверка, установка, откат, ремонт.

Главное, что закрепляют тесты: обновление везёт только изменившиеся файлы,
не верит серверу на слово и никогда не оставляет установку в половинчатом
состоянии. Сети в тестах нет — HTTP подменён заглушкой, как и в
`test_updater.py`.
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

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import bundle  # noqa: E402
import bundle_updater  # noqa: E402

BASE = "https://example.test/api/uploader"


def make_keys():
    secret = os.urandom(32)
    return secret, {"test": base64.b64encode(bundle.ed25519_public_key(secret)).decode("ascii")}


def write_package(folder: Path, version: str, overlay: str = "BLOCKS = 7\n") -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "colonial_helper.py").write_text(
        f'VERSION = "{version}"\ndef main():\n    return 0\n', encoding="utf-8")
    (folder / "overlay.py").write_text(overlay, encoding="utf-8")
    (folder / "api_client.py").write_text("TIMEOUT = 15\n", encoding="utf-8")


class _Response:
    def __init__(self, data=b"", status=200, headers=None):
        self._data = data
        self.status_code = status
        self.ok = 200 <= status < 300
        self.headers = headers or {}
        self.text = data.decode("utf-8", "replace") if isinstance(data, bytes) else str(data)

    def json(self):
        return json.loads(self._data)

    def iter_content(self, chunk_size=1):
        for start in range(0, len(self._data), max(chunk_size, 1)):
            yield self._data[start:start + max(chunk_size, 1)]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Server:
    """Сервер обновлений: манифест, файлы по хешу, архив пакета."""

    def __init__(self, manifest=None, blobs=None, archive=b"", fail=()):
        self.manifest = manifest
        self.blobs = dict(blobs or {})
        self.archive = archive
        self.fail = set(fail)
        self.requests = []

    def get(self, url, **kwargs):
        self.requests.append(url)
        if url in self.fail:
            raise RuntimeError("сеть отвалилась")
        if url.endswith("/manifest"):
            if self.manifest is None:
                return _Response(b"not found", status=404)
            return _Response(json.dumps({"ok": True, "manifest": self.manifest}).encode())
        if "/blob/" in url:
            digest = url.rsplit("/", 1)[-1]
            if digest not in self.blobs:
                return _Response(b"", status=404)
            return _Response(self.blobs[digest])
        if "/bundle/" in url:
            return _Response(self.archive)
        if url.endswith("/launcher"):
            return _Response(json.dumps({
                "ok": True, "version": "2.0.0", "size": 23_000_000,
                "sha256": "a" * 64,
                "url": "https://example.test/download/ColonialHelper.exe"}).encode())
        return _Response(b"", status=404)


class BundleUpdateTests(unittest.TestCase):
    def setUp(self):
        self.secret, self.keys = make_keys()
        self.work = Path(tempfile.mkdtemp())
        self.root = self.work / "install"
        self.source = self.work / "src"
        write_package(self.source, "1.0.0")
        self.manifest_v1 = self.sign(bundle.build_manifest(self.source, version="1.0.0"))
        bundle_updater.install_from_directory(self.root, self.source, self.manifest_v1, self.keys)

        # Вторая версия: изменился только colonial_helper.py.
        write_package(self.source, "1.1.0")
        self.manifest_v2 = self.sign(bundle.build_manifest(self.source, version="1.1.0"))
        self.blobs = {item["sha256"]: (self.source / item["path"]).read_bytes()
                      for item in self.manifest_v2["files"]}

    def tearDown(self):
        shutil.rmtree(self.work, ignore_errors=True)

    def sign(self, manifest):
        return bundle.sign_manifest(manifest, self.secret, "test")

    def archive_for(self, manifest):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for item in manifest["files"]:
                archive.writestr(item["path"], (self.source / item["path"]).read_bytes())
        return buffer.getvalue()

    # -- план -----------------------------------------------------------
    def test_plan_downloads_only_changed_files(self):
        plan = bundle_updater.plan_update(self.root, self.manifest_v2)
        self.assertEqual(plan["download"], ["colonial_helper.py"])
        self.assertEqual(sorted(plan["reuse"]), ["api_client.py", "overlay.py"])
        self.assertGreater(plan["bytes"], 0)

    def test_first_install_downloads_everything(self):
        empty = self.work / "fresh"
        plan = bundle_updater.plan_update(empty, self.manifest_v2)
        self.assertEqual(len(plan["download"]), 3)
        self.assertEqual(plan["reuse"], [])

    # -- проверка обновления --------------------------------------------
    def test_check_reports_new_version(self):
        server = _Server(self.manifest_v2)
        result = bundle_updater.check_for_update("1.0.0", session=server, base=BASE,
                                                 keys=self.keys, launcher_version="1.0.0")
        self.assertTrue(result["ok"])
        self.assertTrue(result["update_available"])
        self.assertEqual(result["latest"], "1.1.0")

    def test_check_is_quiet_when_up_to_date(self):
        server = _Server(self.manifest_v2)
        result = bundle_updater.check_for_update("1.1.0", session=server, base=BASE, keys=self.keys)
        self.assertTrue(result["ok"])
        self.assertFalse(result["update_available"])

    def test_bad_signature_is_not_an_update(self):
        broken = json.loads(json.dumps(self.manifest_v2))
        broken["version"] = "9.9.9"  # подпись считалась по другому содержимому
        server = _Server(broken)
        result = bundle_updater.check_for_update("1.0.0", session=server, base=BASE, keys=self.keys)
        self.assertFalse(result["ok"])
        self.assertIn("подпись", str(result["error"]))
        self.assertIsNone(result["manifest"])

    def test_old_launcher_asks_for_a_new_exe(self):
        manifest = self.sign(bundle.build_manifest(self.source, version="1.1.0",
                                                   min_launcher="2.0.0"))
        server = _Server(manifest)
        result = bundle_updater.check_for_update("1.0.0", session=server, base=BASE,
                                                 keys=self.keys, launcher_version="1.0.0")
        self.assertTrue(result["ok"])
        self.assertTrue(result["needs_launcher"])
        self.assertFalse(result["update_available"])

    def test_network_failure_is_reported_not_raised(self):
        server = _Server(self.manifest_v2, fail={f"{BASE}/manifest"})
        result = bundle_updater.check_for_update("1.0.0", session=server, base=BASE, keys=self.keys)
        self.assertFalse(result["ok"])
        self.assertIn("недоступен", str(result["error"]))

    # -- установка -------------------------------------------------------
    def test_apply_downloads_only_the_changed_file(self):
        server = _Server(self.manifest_v2, self.blobs)
        result = bundle_updater.apply_update(self.root, self.manifest_v2, session=server,
                                             base=BASE, keys=self.keys)
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["reused"], 2)
        self.assertEqual(len([u for u in server.requests if "/blob/" in u]), 1)
        self.assertEqual(bundle.load_state(self.root)["current"], "1.1.0")
        self.assertEqual(bundle.verify_installed(self.root, "1.1.0", keys=self.keys), "")

    def test_previous_version_stays_for_rollback(self):
        server = _Server(self.manifest_v2, self.blobs)
        bundle_updater.apply_update(self.root, self.manifest_v2, session=server,
                                    base=BASE, keys=self.keys)
        state = bundle.load_state(self.root)
        self.assertEqual(state["previous"], "1.0.0")
        self.assertTrue(bundle.version_dir(self.root, "1.0.0").is_dir())

    def test_corrupted_download_does_not_switch_version(self):
        blobs = dict(self.blobs)
        changed = [f for f in self.manifest_v2["files"] if f["path"] == "colonial_helper.py"][0]
        blobs[changed["sha256"]] = "# не тот файл\n".encode("utf-8")
        server = _Server(self.manifest_v2, blobs)
        result = bundle_updater.apply_update(self.root, self.manifest_v2, session=server,
                                             base=BASE, keys=self.keys)
        self.assertFalse(result["ok"])
        self.assertEqual(bundle.load_state(self.root)["current"], "1.0.0")
        self.assertFalse(bundle.version_dir(self.root, "1.1.0").exists())

    def test_unsigned_manifest_is_never_installed(self):
        manifest = bundle.build_manifest(self.source, version="1.1.0")
        server = _Server(manifest, self.blobs)
        result = bundle_updater.apply_update(self.root, manifest, session=server,
                                             base=BASE, keys=self.keys)
        self.assertFalse(result["ok"])
        self.assertEqual(bundle.load_state(self.root)["current"], "1.0.0")

    def test_missing_blob_leaves_installation_untouched(self):
        server = _Server(self.manifest_v2, {})  # сервер потерял файлы
        result = bundle_updater.apply_update(self.root, self.manifest_v2, session=server,
                                             base=BASE, keys=self.keys)
        self.assertFalse(result["ok"])
        self.assertEqual(bundle.load_state(self.root)["current"], "1.0.0")

    # -- ремонт ----------------------------------------------------------
    def test_repair_replaces_damaged_files(self):
        damaged = bundle.version_dir(self.root, "1.0.0") / "overlay.py"
        damaged.write_text("мусор\n", encoding="utf-8")
        self.assertNotEqual(bundle.verify_installed(self.root, "1.0.0", keys=self.keys), "")

        server = _Server(self.manifest_v2, self.blobs, self.archive_for(self.manifest_v2))
        result = bundle_updater.repair(self.root, session=server, base=BASE, keys=self.keys)
        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(bundle.verify_installed(self.root, "1.1.0", keys=self.keys), "")

    def test_extract_zip_takes_only_manifest_members(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for item in self.manifest_v2["files"]:
                archive.writestr(item["path"], (self.source / item["path"]).read_bytes())
            archive.writestr("../evil.py", b"import os\n")
            archive.writestr("extra.py", b"print('hi')\n")
        files = bundle_updater.extract_zip(buffer.getvalue(), self.manifest_v2)
        self.assertEqual(sorted(files), ["api_client.py", "colonial_helper.py", "overlay.py"])

    def test_extract_zip_rejects_wrong_content(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            for item in self.manifest_v2["files"]:
                archive.writestr(item["path"], "подменили\n".encode("utf-8"))
        with self.assertRaises(bundle.BundleError):
            bundle_updater.extract_zip(buffer.getvalue(), self.manifest_v2)

    # -- базовая сборка ---------------------------------------------------
    def test_launcher_check_compares_versions(self):
        server = _Server()
        info = bundle_updater.check_launcher("1.0.0", session=server, base=BASE)
        self.assertTrue(info["ok"])
        self.assertTrue(info["update_available"])
        self.assertEqual(info["version"], "2.0.0")
        self.assertFalse(bundle_updater.check_launcher("2.0.0", session=server, base=BASE)["update_available"])

    def test_launcher_download_checks_hash(self):
        payload = b"MZ" + b"\x00" * 100
        digest = bundle.sha256_bytes(payload)

        class _Http:
            def get(self, url, **kwargs):
                return _Response(payload, headers={"Content-Length": str(len(payload))})

        good = bundle_updater.download_launcher(
            {"url": "https://example.test/x/ColonialHelper.exe", "sha256": digest},
            self.work / "downloads", session=_Http())
        self.assertTrue(good["ok"], good.get("error"))

        bad = bundle_updater.download_launcher(
            {"url": "https://example.test/x/ColonialHelper.exe", "sha256": "b" * 64},
            self.work / "downloads2", session=_Http())
        self.assertFalse(bad["ok"])
        self.assertIn("хеш", str(bad["error"]))

    # -- адрес канала ------------------------------------------------------
    def test_update_base_is_pinned_but_overridable(self):
        self.assertTrue(bundle_updater.update_base().endswith("/api/uploader"))
        os.environ[bundle_updater.BASE_ENV] = "https://my.server/api/uploader"
        try:
            self.assertEqual(bundle_updater.update_base(), "https://my.server/api/uploader")
            self.assertEqual(bundle_updater.update_base("https://arg/api"), "https://arg/api")
        finally:
            os.environ.pop(bundle_updater.BASE_ENV, None)

    def test_restart_command_points_at_the_running_program(self):
        command = bundle_updater.restart_command()
        self.assertTrue(command)
        self.assertEqual(command[0], sys.executable)

    def test_restart_program_reports_failure(self):
        def broken(*args, **kwargs):
            raise OSError("нельзя")

        self.assertFalse(bundle_updater.restart_program(spawn=broken))

        started = {}

        def spawn(command, **kwargs):
            started["command"] = command
            return object()

        self.assertTrue(bundle_updater.restart_program(spawn=spawn))
        self.assertEqual(started["command"], bundle_updater.restart_command())


if __name__ == "__main__":
    unittest.main()
