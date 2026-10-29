"""Привязка лаунчера к учётной записи и перенос раскладки — без сети и графики.

Сетевой слой здесь подменяется функциями-заглушками: проверяется то, что
пилот видит и что остаётся на диске — сохранённый токен, отсутствие пароля,
состав снимка раскладки и поведение автоматического подтягивания.
"""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import launcher_account  # noqa: E402
import launcher_settings  # noqa: E402
import settings_sync  # noqa: E402


PROFILE = {"userId": "u-1", "nick": "Jameson", "avatarUrl": "/api/account/avatar?v=2",
           "cmdrName": "JAMESON", "role": "pilot"}

LAYOUT = {
    "version": 1,
    "profiles": {"Бой": {"ship": {"x": 10, "y": 20, "width": 300, "height": 200,
                                  "anchor": "custom"}}},
    "active_profile": "Бой",
    "layout_margin": 24,
    "route_x": 50,
    "route_y": 60,
}


def claim_ok(base_url, code, device_name):
    assert base_url.startswith("http"), base_url
    assert code == "ABCD2345", code
    return {"ok": True, "token": "tok-123", "deviceId": "dev-1",
            "profile": dict(PROFILE), "linkedAt": "2026-10-29T10:00:00Z"}


def fetch_settings_ok(base_url, token):
    assert token == "tok-123"
    return {"settings": dict(LAYOUT), "updatedAt": "2026-10-29T10:05:00Z", "deviceName": "PC"}


class AccountCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = Path(self.temp.name) / ".colonial_helper.json"

    def tearDown(self):
        self.temp.cleanup()

    def linked(self):
        return launcher_account.link_with_code("abcd2345", self.settings, requester=claim_ok)

    @property
    def account_file(self):
        return launcher_account.account_path(self.settings)

    def write(self, payload):
        self.settings.write_text(json.dumps(payload), encoding="utf-8")

    def read(self):
        """Общий файл настроек Helper: раскладка и ключи подключений."""
        if not self.settings.exists():
            return {}
        return json.loads(self.settings.read_text(encoding="utf-8"))

    def read_account_file(self):
        """Файл привязки: устройство и время последнего обмена."""
        if not self.account_file.exists():
            return {}
        return json.loads(self.account_file.read_text(encoding="utf-8"))


class LinkTests(AccountCase):
    def test_code_is_stored_as_device_token_without_password(self):
        account = self.linked()
        self.assertEqual(account["token"], "tok-123")
        self.assertEqual(account["device_id"], "dev-1")
        self.assertEqual(launcher_account.profile_title(account), "Jameson")
        self.assertTrue(launcher_account.is_linked(self.settings))
        stored = self.read_account_file()
        self.assertEqual(stored["account"]["token"], "tok-123")
        self.assertNotIn("password", json.dumps(stored).lower())

    def test_account_file_is_private_and_separate(self):
        """Токен не в общем конфиге: Helper перезаписывает его целиком."""
        launcher_settings.save_site_locale("ja", self.settings)
        self.linked()
        mode = stat.S_IMODE(os.stat(self.account_file).st_mode)
        self.assertEqual(mode, 0o600)
        self.assertNotIn("tok-123", json.dumps(self.read()))
        self.assertEqual(launcher_settings.read_site_locale(self.settings), "ja")

    def test_profile_name_falls_back_to_commander_name(self):
        def claim(base_url, code, device_name):
            payload = claim_ok(base_url, code, device_name)
            payload["profile"] = {"cmdrName": "JAMESON", "nick": ""}
            return payload

        account = launcher_account.link_with_code("ABCD2345", self.settings, requester=claim)
        self.assertEqual(launcher_account.profile_title(account), "JAMESON")
        self.assertEqual(launcher_account.initials("JAMESON"), "JA")

    def test_site_error_is_reported_to_the_pilot(self):
        def claim(base_url, code, device_name):
            raise settings_sync.SyncError("Код истёк. Получите новый в профиле.")

        with self.assertRaises(settings_sync.SyncError) as raised:
            launcher_account.link_with_code("ABCD2345", self.settings, requester=claim)
        self.assertIn("Код истёк", str(raised.exception))
        self.assertFalse(launcher_account.is_linked(self.settings))

    def test_unlink_clears_token_and_keeps_layout_settings(self):
        self.linked()
        self.write(dict(self.read(), site_locale="de"))
        removed = []

        def drop(base_url, token):
            removed.append((base_url, token))

        self.assertTrue(launcher_account.unlink(self.settings, requester=drop))
        self.assertFalse(launcher_account.is_linked(self.settings))
        self.assertEqual(removed[0][1], "tok-123")
        self.assertNotIn("account", self.read_account_file())
        self.assertEqual(launcher_settings.read_site_locale(self.settings), "de")

    def test_unlink_works_without_network(self):
        self.linked()

        def drop(base_url, token):
            raise settings_sync.SyncError("Нет связи с сайтом")

        self.assertTrue(launcher_account.unlink(self.settings, requester=drop))
        self.assertFalse(launcher_account.is_linked(self.settings))

    def test_refresh_profile_updates_the_badge_data(self):
        self.linked()

        def fetch(base_url, token):
            return {"ok": True, "profile": {"nick": "Jameson Jr."},
                    "device": {"id": "dev-1", "name": "PC"}}

        account = launcher_account.refresh_profile(self.settings, requester=fetch)
        self.assertEqual(launcher_account.profile_title(account), "Jameson Jr.")

    def test_avatar_url_is_made_absolute(self):
        account = {
            "profile": {"avatarUrl": "/api/account/avatar?v=2"},
        }
        self.assertEqual(
            launcher_account.avatar_url(account, "https://edringcolony.ru"),
            "https://edringcolony.ru/api/account/avatar?v=2",
        )
        self.assertEqual(
            launcher_account.avatar_url({"profile": {"avatarUrl": "https://cdn/x.png"}},
                                        "https://edringcolony.ru"),
            "https://cdn/x.png",
        )
        self.assertEqual(launcher_account.avatar_url({"profile": {}}, "https://e"), "")


class SnapshotTests(AccountCase):
    def test_only_layout_keys_travel_to_the_site(self):
        source = {
            "profiles": {"Бой": {"ship": {"x": 1}}},
            "active_profile": "Бой",
            "route_x": 5,
            "ship_width": 300,
            "site_locale": "ru",
            "token": "secret-api-token",
            "edsm_api_key": "edsm",
            "inara_api_key": "inara",
            "raven_colonial_key": "raven",
            "site_url": "https://edringcolony.ru",
        }
        snapshot = settings_sync.collect_snapshot(source)
        dumped = json.dumps(snapshot)
        self.assertIn("profiles", snapshot)
        self.assertIn("route_x", snapshot)
        self.assertNotIn("secret-api-token", dumped)
        self.assertNotIn("edsm", dumped)
        self.assertNotIn("inara", dumped)
        self.assertNotIn("raven", dumped)
        self.assertNotIn("site_url", dumped)

    def test_snapshot_copy_does_not_share_profiles_with_settings(self):
        source = {"profiles": {"Бой": {"ship": {"x": 1}}}}
        snapshot = settings_sync.collect_snapshot(source)
        snapshot["profiles"]["Бой"]["ship"]["x"] = 999
        self.assertEqual(source["profiles"]["Бой"]["ship"]["x"], 1)

    def test_foreign_snapshot_version_is_refused(self):
        with self.assertRaises(settings_sync.SyncError):
            settings_sync.apply_snapshot({}, {"version": 99, "profiles": {}})

    def test_broken_snapshot_is_refused_whole(self):
        with self.assertRaises(settings_sync.SyncError):
            settings_sync.apply_snapshot({}, "not-a-dict")

    def test_apply_restores_positions_and_profiles(self):
        target = {}
        changed = settings_sync.apply_snapshot(target, dict(LAYOUT))
        self.assertGreater(changed, 0)
        self.assertEqual(target["active_profile"], "Бой")
        self.assertEqual(target["route_x"], 50)
        self.assertEqual(target["profiles"]["Бой"]["ship"]["x"], 10)


class SyncTests(AccountCase):
    def test_push_sends_layout_and_remembers_the_stamp(self):
        self.linked()
        self.write(dict(self.read(), route_x=77, profiles={"Мой": {}}, edsm_api_key="secret"))
        self.assertEqual(launcher_account.synced_at(self.settings), "")
        sent = {}

        def upload(base_url, token, snapshot):
            sent.update(snapshot)
            return "2026-10-29T11:00:00Z"

        stamp = launcher_account.push_from_file(self.settings, requester=upload)
        self.assertEqual(stamp, "2026-10-29T11:00:00Z")
        self.assertEqual(sent["route_x"], 77)
        self.assertNotIn("edsm_api_key", sent)
        self.assertEqual(launcher_account.synced_at(self.settings), "2026-10-29T11:00:00Z")

    def test_push_requires_link(self):
        with self.assertRaises(settings_sync.SyncError):
            launcher_account.push_from_file(self.settings, requester=lambda *a: "x")

    def test_pull_writes_layout_into_the_settings_file(self):
        self.linked()
        self.write(dict(self.read(), site_locale="ko", inara_api_key="keep-me"))
        changed, stamp = launcher_account.pull_into_file(self.settings, requester=fetch_settings_ok)
        self.assertGreater(changed, 0)
        self.assertEqual(stamp, "2026-10-29T10:05:00Z")
        stored = self.read()
        self.assertEqual(stored["active_profile"], "Бой")
        self.assertEqual(stored["site_locale"], "ko")
        self.assertEqual(stored["inara_api_key"], "keep-me")
        self.assertEqual(launcher_account.synced_at(self.settings), "2026-10-29T10:05:00Z")

    def test_pull_reports_empty_site_as_an_error(self):
        self.linked()

        def empty(base_url, token):
            return {"settings": {}, "updatedAt": ""}

        with self.assertRaises(settings_sync.SyncError):
            launcher_account.pull_into_file(self.settings, requester=empty)

    def test_auto_pull_skips_layout_already_seen(self):
        self.linked()
        launcher_account.pull_into_file(self.settings, requester=fetch_settings_ok)
        self.write(dict(self.read(), route_x=999, route_y=999))
        result = launcher_account.auto_pull(self.settings, requester=fetch_settings_ok)
        self.assertIsNone(result)
        self.assertEqual(self.read()["route_x"], 999)

    def test_auto_pull_takes_a_newer_layout_once(self):
        self.linked()
        first = launcher_account.auto_pull(self.settings, requester=fetch_settings_ok)
        self.assertGreater(first, 0)
        self.assertEqual(self.read()["active_profile"], "Бой")

    def test_auto_pull_of_unlinked_launcher_does_nothing(self):
        def boom(base_url, token):
            raise AssertionError("сеть не должна вызываться без привязки")

        self.assertIsNone(launcher_account.auto_pull(self.settings, requester=boom))

    def test_auto_pull_survives_a_dead_site(self):
        self.linked()

        def offline(base_url, token):
            raise settings_sync.SyncError("Нет связи с сайтом")

        self.assertIsNone(launcher_account.auto_pull(self.settings, requester=offline))
        self.assertTrue(launcher_account.is_linked(self.settings))

    def test_force_pull_overrides_the_seen_stamp(self):
        self.linked()
        launcher_account.pull_into_file(self.settings, requester=fetch_settings_ok)
        self.write(dict(self.read(), route_x=999))
        changed = launcher_account.auto_pull(self.settings, requester=fetch_settings_ok, force=True)
        self.assertGreater(changed, 0)
        self.assertEqual(self.read()["route_x"], 50)


class SiteUrlTests(AccountCase):
    def test_default_site_is_the_project_site(self):
        self.assertEqual(launcher_account.site_url(self.settings), "https://edringcolony.ru")

    def test_configured_site_is_reused(self):
        self.write({"site_url": "https://example.org"})
        self.assertEqual(launcher_account.site_url(self.settings), "https://example.org")

    def test_broken_site_falls_back_to_the_default(self):
        self.write({"site_url": "ftp://nope"})
        self.assertEqual(launcher_account.site_url(self.settings), "https://edringcolony.ru")


if __name__ == "__main__":
    unittest.main()
