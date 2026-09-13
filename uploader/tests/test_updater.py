"""Тесты обновлений: версия, выбор релиза, скачивание, кнопка в интерфейсе.

Закрепляем то, что ломается незаметно:

* суффикс ветки в теге (`v2.4.2-arena-…`) не должен делать сборку «новее»;
* стабильный канал не предлагает prerelease из arena/**;
* релиз без файла или без версии обновлением не считается;
* скачивание пишет файл целиком (через .part) и не оставляет мусор при обрыве;
* кнопка «Обновить программу» не трогает UI из фонового потока, а автопроверка
  respects флаг в настройках.
"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import updater  # noqa: E402


# ---------------------------------------------------------------------------
#  Заглушки HTTP
# ---------------------------------------------------------------------------
class _Response:
    def __init__(self, payload=None, status=200, chunks=(), headers=None, ok=None):
        self._payload = payload
        self.status_code = status
        self.ok = (200 <= status < 300) if ok is None else ok
        self.text = "" if payload is None else str(payload)
        self.headers = headers or {}
        self._chunks = list(chunks)

    def json(self):
        if isinstance(self._payload, (dict, list)):
            return self._payload
        raise ValueError("не JSON")

    def iter_content(self, chunk_size=1):
        for chunk in self._chunks:
            yield chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Session:
    """Сессия, которая отдаёт заранее заготовленные ответы."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _release(tag, name="ColonialHelper.exe", size=1000, prerelease=False,
             draft=False, published="2026-09-01T00:00:00Z", asset=True):
    return {
        "tag_name": tag,
        "name": f"Colonial Helper {tag}",
        "body": "изменения",
        "prerelease": prerelease,
        "draft": draft,
        "html_url": f"https://github.com/NooboGreenD/ed-ring-colony/releases/tag/{tag}",
        "published_at": published,
        "assets": [{
            "name": name,
            "size": size,
            "browser_download_url": f"https://example.invalid/{name}",
        }] if asset else [],
    }


# ---------------------------------------------------------------------------
class VersionTests(unittest.TestCase):
    def test_version_tuple_ignores_branch_suffix(self):
        self.assertEqual(updater.version_tuple("2.4.10"), (2, 4, 10))
        self.assertEqual(updater.version_tuple("v2.4.2"), (2, 4, 2))
        # Суффикс ветки не делает сборку новее стабильной той же версии.
        self.assertEqual(updater.version_tuple("v2.4.2-arena-01a09bd7"), (2, 4, 2))
        self.assertEqual(updater.version_tuple(""), ())
        self.assertEqual(updater.version_tuple("мусор"), ())
        self.assertEqual(updater.version_tuple(None), ())

    def test_compare_versions(self):
        self.assertEqual(updater.compare_versions("2.4.2", "2.4.10"), -1)
        self.assertEqual(updater.compare_versions("2.4.10", "2.4.2"), 1)
        self.assertEqual(updater.compare_versions("v2.4.2", "2.4.2-arena-1"), 0)

    def test_current_version_matches_app_constant(self):
        """Версия в updater и в colonial_helper не должны разъезжаться."""
        from test_initial_upload_flow import install_gui_stubs

        install_gui_stubs()
        for name in ("colonial_helper",):
            sys.modules.pop(name, None)
        import colonial_helper

        self.assertEqual(updater.current_version(), colonial_helper.VERSION)
        self.assertTrue(updater.current_version().count(".") >= 2)

    def test_current_version_survives_missing_file(self):
        self.assertEqual(updater.current_version(Path("/нет/такого/файла.py")), "")


class ReleaseParsingTests(unittest.TestCase):
    def test_pick_asset_prefers_exe_and_larger_file(self):
        assets = [
            {"name": "source.zip", "size": 500},
            {"name": "ColonialHelper.exe", "size": 20_000_000},
            {"name": "ColonialHelper-old.exe", "size": 10_000_000},
        ]
        self.assertEqual(updater.pick_asset(assets)["name"], "ColonialHelper.exe")
        self.assertEqual(updater.pick_asset([{"name": "a.zip", "size": 1}])["name"], "a.zip")
        self.assertIsNone(updater.pick_asset([]))
        self.assertIsNone(updater.pick_asset(None))

    def test_parse_release_skips_useless_entries(self):
        self.assertIsNone(updater.parse_release({}))
        self.assertIsNone(updater.parse_release(_release("latest")))          # нет версии
        self.assertIsNone(updater.parse_release(_release("v2.4.2", asset=False)))
        parsed = updater.parse_release(_release("v2.4.2", prerelease=True))
        self.assertEqual(parsed["version"], (2, 4, 2))
        self.assertEqual(parsed["version_text"], "2.4.2")
        self.assertTrue(parsed["prerelease"])
        self.assertEqual(parsed["asset_name"], "ColonialHelper.exe")
        self.assertEqual(parsed["asset_url"], "https://example.invalid/ColonialHelper.exe")

    def test_choose_release_respects_channel(self):
        stable = updater.parse_release(_release("v2.4.2"))
        arena = updater.parse_release(_release("v2.5.0-arena-x", prerelease=True))
        draft = updater.parse_release(_release("v9.9.9", draft=True))
        releases = [stable, arena, draft]

        self.assertEqual(updater.choose_release(releases, "stable")["version_text"], "2.4.2")
        self.assertEqual(updater.choose_release(releases, "all")["version_text"], "2.5.0-arena-x")
        # Черновики не предлагаем никогда.
        self.assertEqual(
            updater.choose_release([draft], "all"), None)
        # Уже установленная версия и новее — обновления нет.
        self.assertIsNone(updater.choose_release(releases, "stable", current="2.4.2"))
        self.assertEqual(
            updater.choose_release(releases, "stable", current="2.4.1")["version_text"], "2.4.2")

    def test_choose_release_picks_newest_by_version_not_date(self):
        old_but_new = updater.parse_release(
            _release("v2.5.0", published="2026-01-01T00:00:00Z"))
        new_but_old = updater.parse_release(
            _release("v2.4.9", published="2026-09-01T00:00:00Z"))
        chosen = updater.choose_release([new_but_old, old_but_new], "stable")
        self.assertEqual(chosen["version_text"], "2.5.0")


class CheckForUpdateTests(unittest.TestCase):
    def test_update_available(self):
        session = _Session([_Response([_release("v2.5.0"), _release("v2.4.2")])])
        result = updater.check_for_update("2.4.2", session=session)
        self.assertTrue(result["ok"])
        self.assertTrue(result["update_available"])
        self.assertEqual(result["latest"], "2.5.0")
        self.assertEqual(result["release"]["tag"], "v2.5.0")
        # Запрос идёт в API репозитория с per_page.
        url, kwargs = session.calls[0]
        self.assertEqual(url, updater.RELEASES_URL)
        self.assertEqual(kwargs["params"], {"per_page": updater.RELEASES_PER_PAGE})
        self.assertIn("User-Agent", kwargs["headers"])

    def test_up_to_date(self):
        session = _Session([_Response([_release("v2.4.2")])])
        result = updater.check_for_update("2.4.2", session=session)
        self.assertTrue(result["ok"])
        self.assertFalse(result["update_available"])
        self.assertEqual(result["latest"], "2.4.2")
        self.assertIsNone(result["release"])

    def test_network_error_is_reported_not_raised(self):
        session = _Session([ConnectionError("нет сети")])
        result = updater.check_for_update("2.4.2", session=session)
        self.assertFalse(result["ok"])
        self.assertFalse(result["update_available"])
        self.assertIn("нет сети", result["error"])

    def test_http_error_and_bad_payload(self):
        result = updater.check_for_update("2.4.2", session=_Session([_Response(status=403)]))
        self.assertFalse(result["ok"])
        self.assertIn("403", result["error"])

        result = updater.check_for_update("2.4.2", session=_Session([_Response("не JSON")]))
        self.assertFalse(result["ok"])
        self.assertIn("некорректный", result["error"])

        result = updater.check_for_update(
            "2.4.2", session=_Session([_Response({"message": "не список"})]))
        self.assertFalse(result["ok"])

    def test_releases_without_assets_are_ignored(self):
        session = _Session([_Response([_release("v9.9.9", asset=False), _release("v2.5.0")])])
        result = updater.check_for_update("2.4.2", session=session)
        self.assertEqual(result["latest"], "2.5.0")


class DownloadTests(unittest.TestCase):
    def test_download_writes_file_and_reports_progress(self):
        payload = [b"a" * 100, b"b" * 100, b"c" * 50]
        session = _Session([_Response(
            chunks=payload, headers={"Content-Length": "250"})])
        seen = []
        with tempfile.TemporaryDirectory() as tmp:
            release = updater.parse_release(_release("v2.5.0", size=250))
            result = updater.download_asset(release, tmp, progress=lambda d, t: seen.append((d, t)),
                                            session=session)
            self.assertTrue(result["ok"], result)
            path = Path(result["path"])
            self.assertEqual(path.name, "ColonialHelper.exe")
            self.assertEqual(path.read_bytes(), b"".join(payload))
            self.assertEqual(result["size"], 250)
            self.assertFalse(list(Path(tmp).glob("*.part")), "временный файл должен исчезнуть")
        self.assertEqual(seen[-1], (250, 250))

    def test_download_failure_leaves_no_file(self):
        session = _Session([ConnectionError("обрыв")])
        with tempfile.TemporaryDirectory() as tmp:
            release = updater.parse_release(_release("v2.5.0"))
            result = updater.download_asset(release, tmp, session=session)
            self.assertFalse(result["ok"])
            self.assertIn("обрыв", result["error"])
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_http_error_on_download(self):
        session = _Session([_Response(status=404)])
        with tempfile.TemporaryDirectory() as tmp:
            result = updater.download_asset(
                updater.parse_release(_release("v2.5.0")), tmp, session=session)
            self.assertFalse(result["ok"])
            self.assertIn("404", result["error"])

    def test_release_without_asset(self):
        result = updater.download_asset({"asset_url": "", "asset_name": "x.exe"}, tempfile.gettempdir())
        self.assertFalse(result["ok"])
        self.assertIn("нет ссылки", result["error"])

    def test_download_folder_exists(self):
        folder = updater.download_folder()
        self.assertTrue(Path(folder).is_dir())


class ReleaseTagAndNotesTests(unittest.TestCase):
    def test_release_tag_per_branch(self):
        self.assertEqual(updater.release_tag("2.4.2", "main"), "v2.4.2")
        self.assertEqual(updater.release_tag("2.4.2", ""), "v2.4.2")
        self.assertEqual(
            updater.release_tag("2.4.2", "arena/01a09bd7-ed-ring-colony"),
            "v2.4.2-arena-01a09bd7-ed-ring-colony")
        # Слэш в теге недопустим, пробелы и кириллица вычищаются.
        self.assertNotIn("/", updater.release_tag("2.4.2", "feature/Новая фича"))
        self.assertTrue(updater.release_tag("2.4.2", "!!!").startswith("v2.4.2"))

    def test_latest_changelog_is_newest_round_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "CHANGES.md"
            path.write_text(
                "# Раунд 2 (версия 2.0.0): новое\n\nсвежие изменения\n\n"
                "# Раунд 1 (версия 1.0.0): старое\n\nстарые изменения\n",
                encoding="utf-8",
            )
            notes = updater.latest_changelog(path)
            self.assertIn("Раунд 2", notes)
            self.assertIn("свежие изменения", notes)
            self.assertNotIn("старые изменения", notes)

    def test_latest_changelog_truncates(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "CHANGES.md"
            path.write_text("# Раунд 1\n\n" + "\n".join(f"строка {i}" for i in range(200)),
                            encoding="utf-8")
            notes = updater.latest_changelog(path, max_lines=10)
            self.assertLessEqual(len(notes.splitlines()), 13)
            self.assertIn("Полная история", notes)

    def test_changelog_exists_in_repo(self):
        notes = updater.latest_changelog()
        self.assertTrue(notes, "в репозитории должен быть CHANGES.md")
        self.assertIn("Раунд", notes)

    def test_build_release_notes(self):
        notes = updater.build_release_notes("2.4.2", "arena/test", "abcdef1234567890")
        self.assertIn("**Colonial Helper 2.4.2**", notes)
        self.assertIn("`arena/test`", notes)
        self.assertIn("`abcdef123456`", notes)
        self.assertIn("ColonialHelper.exe", notes)

    def test_cli_prints_version_tag_and_notes(self):
        import contextlib
        import io

        def run(args):
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = updater._cli(args)
            return code, buffer.getvalue()

        code, out = run(["--version"])
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), updater.current_version())

        code, out = run(["--tag", "--branch", "main"])
        self.assertEqual((code, out.strip()), (0, f"v{updater.current_version()}"))

        code, out = run(["--notes", "--branch", "arena/x"])
        self.assertEqual(code, 0)
        self.assertIn("**Colonial Helper", out)

        code, out = run([])
        self.assertEqual(code, 1)
        self.assertIn("usage:", out)

    def test_cli_writes_notes_file_in_utf8(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "release-notes.md"
            code = updater._cli(["--notes-file", str(target), "--branch", "arena/test"])
            self.assertEqual(code, 0)
            text = target.read_text(encoding="utf-8")
            self.assertIn("**Colonial Helper", text)
            self.assertIn("`arena/test`", text)
            self.assertIn("Раунд", text)

    def test_cli_notes_file_survives_cyrillic_hostile_console(self):
        """Регрессия шага CI «Build release notes».

        На Windows-раннере stdout получает кодировку консоли (cp1252), и
        русский ченджлог в pipe падал с UnicodeEncodeError. Записывая файл
        из Python в UTF-8, мы от кодировки консоли не зависим — проверяем
        это отдельным процессом с враждебной кодировкой.
        """
        import os
        import subprocess

        script = Path(updater.__file__).resolve()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "notes.md"
            env = dict(os.environ, PYTHONIOENCODING="cp1252")
            completed = subprocess.run(
                [sys.executable, str(script), "--notes-file", str(target),
                 "--branch", "arena/test", "--commit", "abc123"],
                capture_output=True, env=env, timeout=60,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
            self.assertIn("Раунд", target.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
class UpdateUiTests(unittest.TestCase):
    """Кнопка «Обновить программу» в шапке."""

    def setUp(self):
        import tempfile

        from test_initial_upload_flow import install_gui_stubs, make_root

        install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch", "journal_parser",
                     "overlay", "ship_tracker", "route_tracker", "game_monitor",
                     "exobiology", "colonisation", "carrier", "raven_colonial_api",
                     "updater"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.root = make_root()

        import colonial_helper

        self.module = colonial_helper
        # В общей заглушке tb.Label(...) один и тот же MagicMock на все вызовы:
        # не различишь, что написано в конкретной подписи. Здесь каждый свой.
        self.created_labels = []

        def _label(*args, **kwargs):
            self.created_labels.append(kwargs)
            return mock.MagicMock(name="Label")

        label_patcher = mock.patch.object(colonial_helper.tb, "Label", side_effect=_label)
        label_patcher.start()
        self.addCleanup(label_patcher.stop)

        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def _sync_threads(self):
        class _SyncThread:
            def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
                self._target = target
                self._args = tuple(args or ())
                self._kwargs = dict(kwargs or {})

            def start(self):
                if self._target is not None:
                    self._target(*self._args, **self._kwargs)

            def join(self, timeout=None):
                return None

        return mock.patch.object(self.module.threading, "Thread", _SyncThread)

    def test_widgets_exist(self):
        self.assertTrue(hasattr(self.app, "update_button"))
        self.assertTrue(hasattr(self.app, "update_channel_combo"))
        self.assertTrue(self.app.update_auto_var.get())
        # Подпись с текущей версией создаётся вместе со строкой обновлений.
        texts = [str(kwargs.get("text", "")) for kwargs in self.created_labels]
        self.assertTrue(
            any(text.startswith("установлена v") for text in texts), texts[:6])
        # Канал по умолчанию — стабильный: prerelease из arena не предлагаем.
        self.assertEqual(self.app._update_channel_value(), "stable")
        self.assertEqual(len(self.app.UPDATE_CHANNEL_LABELS), 2)

    def test_settings_are_saved(self):
        self.app.update_channel_var.set(self.app.UPDATE_CHANNEL_LABELS["all"])
        self.app.update_auto_var.set(False)
        self.app._on_update_settings_changed()
        self.assertEqual(self.app.config["update_channel"], "all")
        self.assertFalse(self.app.config["update_check_enabled"])

    def test_check_uses_channel_from_ui(self):
        self.app.update_channel_var.set(self.app.UPDATE_CHANNEL_LABELS["all"])
        seen = {}
        self.module.updater.check_for_update = lambda version, channel="stable": (
            seen.update(version=version, channel=channel)
            or {"ok": True, "update_available": False, "latest": version, "release": None}
        )
        with self._sync_threads():
            self.app._on_check_update(manual=True)
        self.assertEqual(seen, {"version": self.module.VERSION, "channel": "all"})
        self.assertFalse(self.app._update_busy, "кнопка должна разблокироваться")

    def test_update_available_offers_download(self):
        release = updater.parse_release(_release("v9.9.9"))
        self.module.updater.check_for_update = lambda *a, **k: {
            "ok": True, "update_available": True, "latest": "9.9.9", "release": release,
        }
        downloaded = []
        self.module.updater.download_asset = lambda rel, folder, progress=None, session=None: (
            downloaded.append(rel["tag"])
            or {"ok": True, "path": str(Path(folder) / "ColonialHelper.exe"), "size": 10}
        )
        with mock.patch.object(self.module.messagebox, "askyesno", return_value=True), \
             mock.patch.object(self.module.updater, "download_folder",
                               return_value=Path(self.tmp.name)), \
             self._sync_threads():
            self.app._on_check_update(manual=True)
        self.assertEqual(downloaded, ["v9.9.9"])

    def test_user_can_refuse_download(self):
        release = updater.parse_release(_release("v9.9.9"))
        self.module.updater.check_for_update = lambda *a, **k: {
            "ok": True, "update_available": True, "latest": "9.9.9", "release": release,
        }
        calls = []
        self.module.updater.download_asset = lambda *a, **k: calls.append(1)
        with mock.patch.object(self.module.messagebox, "askyesno", return_value=False), \
             self._sync_threads():
            self.app._on_check_update(manual=True)
        self.assertEqual(calls, [])

    def test_auto_check_respects_setting(self):
        calls = []
        self.module.updater.check_for_update = lambda *a, **k: calls.append(1) or {
            "ok": True, "update_available": False, "latest": "2.4.2", "release": None}
        self.app.config["update_check_enabled"] = False
        with self._sync_threads():
            self.app._auto_check_update()
        self.assertEqual(calls, [], "при выключенной автопроверке запроса быть не должно")

        self.app.config["update_check_enabled"] = True
        with self._sync_threads():
            self.app._auto_check_update()
        self.assertEqual(len(calls), 1)

    def test_auto_check_does_not_open_dialog(self):
        release = updater.parse_release(_release("v9.9.9"))
        self.module.updater.check_for_update = lambda *a, **k: {
            "ok": True, "update_available": True, "latest": "9.9.9", "release": release,
        }
        with mock.patch.object(self.module.messagebox, "askyesno") as ask, \
             self._sync_threads():
            self.app._auto_check_update()
        ask.assert_not_called()

    def test_failed_check_is_not_fatal(self):
        self.module.updater.check_for_update = lambda *a, **k: {
            "ok": False, "error": "GitHub недоступен", "latest": "", "release": None,
        }
        with self._sync_threads():
            self.app._on_check_update(manual=True)
        self.assertFalse(self.app._update_busy)

    def test_download_error_is_logged(self):
        release = updater.parse_release(_release("v9.9.9"))
        self.module.updater.check_for_update = lambda *a, **k: {
            "ok": True, "update_available": True, "latest": "9.9.9", "release": release,
        }
        self.module.updater.download_asset = lambda *a, **k: {
            "ok": False, "error": "обрыв связи", "path": "", "size": 0}
        with mock.patch.object(self.module.messagebox, "askyesno", return_value=True), \
             mock.patch.object(self.module.updater, "download_folder",
                               return_value=Path(self.tmp.name)), \
             self._sync_threads():
            self.app._on_check_update(manual=True)
        self.assertFalse(self.app._update_busy)


if __name__ == "__main__":
    unittest.main(verbosity=2)
