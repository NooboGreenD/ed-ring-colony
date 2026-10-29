"""Headless Qt tests for the launcher profile badge and link dialog.

Виджеты прогоняются через offscreen-плагин: проверяется то, что пилот видит в
правом верхнем углу лаунчера и в окне привязки. Сеть подменяется — тесты не
ходят на сайт.
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtTest import QTest

    import launcher_account
    import launcher_profile
    import launcher_settings
    import settings_sync
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


def wait_until(app, predicate, timeout_ms=4000):
    elapsed = 0
    while elapsed < timeout_ms:
        app.processEvents()
        if predicate():
            return True
        QTest.qWait(10)
        elapsed += 10
    app.processEvents()
    return predicate()


LINK_CODE = "ABCD-2345"


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class ProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = Path(self.temp.name) / ".colonial_helper.json"

    def tearDown(self):
        self.temp.cleanup()

    def link(self, nick="Jameson"):
        payload = {
            "ok": True,
            "token": "tok-1",
            "deviceId": "dev-1",
            "profile": {"nick": nick, "avatarUrl": ""},
        }
        with mock.patch.object(launcher_account, "settings_sync") as _sync:
            _sync.SyncError = settings_sync.SyncError
            return launcher_account.link_with_code(
                LINK_CODE, self.settings,
                requester=lambda base, code, device: payload)


class BadgeTests(ProfileTests):
    def badge(self):
        return launcher_profile.ProfileBadge(lambda: None, self.settings)

    def test_unlinked_launcher_invites_binding(self):
        badge = self.badge()
        self.assertEqual(badge.name_label.text(), "Лаунчер не привязан")
        self.assertEqual(badge.action.text(), "Привязать")
        self.assertEqual(badge.state_label.text(), "Код привязки — в профиле на сайте")
        self.assertEqual(badge.avatar.text(), "?")

    def test_linked_launcher_shows_the_site_profile(self):
        self.link("Jameson")
        badge = self.badge()
        self.assertEqual(badge.name_label.text(), "Jameson")
        self.assertEqual(badge.avatar.text(), "JA")
        self.assertEqual(badge.action.text(), "Синхронизация")
        self.assertIn("Привязан к сайту", badge.state_label.text())

    def test_badge_follows_a_new_binding(self):
        badge = self.badge()
        self.link("Hudson")
        badge.reload()
        self.assertEqual(badge.name_label.text(), "Hudson")
        self.assertEqual(badge.action.text(), "Синхронизация")

    def test_synced_layout_shows_its_stamp(self):
        self.link("Jameson")
        launcher_account.push_from_file(
            self.settings, requester=lambda base, token, snapshot: "2026-10-29T11:00:00Z")
        badge = self.badge()
        self.assertIn("2026-10-29 11:00", badge.state_label.text())

    def test_tooltip_names_the_device(self):
        self.link("Jameson")
        badge = self.badge()
        self.assertIn("Устройство:", badge.avatar_tooltip())


class DialogTests(ProfileTests):
    def setUp(self):
        super().setUp()
        self.changed = 0

    def dialog(self):
        return launcher_profile.AccountDialog(
            self.settings, on_changed=self._changed)

    def _changed(self):
        self.changed += 1

    def test_unlinked_dialog_offers_a_code_field(self):
        dialog = self.dialog()
        self.assertTrue(dialog.code_row.isVisibleTo(dialog))
        self.assertFalse(dialog.manage_row.isVisibleTo(dialog))
        self.assertEqual(dialog.title_label.text(), "Привязка лаунчера")
        self.assertIn("восьми символов", dialog.hint_label.text())

    def test_linked_dialog_offers_sync_buttons(self):
        self.link("Jameson")
        dialog = self.dialog()
        self.assertFalse(dialog.code_row.isVisibleTo(dialog))
        self.assertTrue(dialog.manage_row.isVisibleTo(dialog))
        self.assertEqual(dialog.title_label.text(), "Jameson")
        self.assertIn("EDSM", dialog.hint_label.text())

    def test_code_is_formatted_while_typing(self):
        dialog = self.dialog()
        dialog._normalize_code("abcd2345")
        self.assertEqual(dialog.code_input.text(), "ABCD-2345")
        dialog._normalize_code("ab-cd 23 45")
        self.assertEqual(dialog.code_input.text(), "ABCD-2345")

    def test_short_code_is_reported_before_any_request(self):
        dialog = self.dialog()
        with mock.patch.object(launcher_account, "link_with_code") as link:
            dialog.code_input.setText("ABCD")
            dialog._link()
            link.assert_not_called()
        self.assertIn("восьми символов", dialog.status_label.text())

    def fake_link(self, code, path, **_kwargs):
        """Как настоящая привязка: токен действительно ложится в файл."""
        launcher_account._store_account(
            path, {"token": "tok-1", "profile": {"nick": "Jameson"}})
        return launcher_account.read_account(path)

    def test_binding_takes_the_layout_from_the_site(self):
        dialog = self.dialog()
        dialog.code_input.setText(LINK_CODE)
        with mock.patch.object(launcher_account, "link_with_code", side_effect=self.fake_link), \
                mock.patch.object(launcher_account, "auto_pull", return_value=4):
            dialog._link()
            self.assertTrue(wait_until(self.app, lambda: "4" in dialog.status_label.text()),
                            dialog.status_label.text())
        self.assertIn("Раскладка перенесена", dialog.status_label.text())
        self.assertGreaterEqual(self.changed, 1)
        self.assertFalse(dialog.code_row.isVisibleTo(dialog))

    def test_failed_binding_shows_the_site_message(self):
        dialog = self.dialog()
        dialog.code_input.setText(LINK_CODE)
        with mock.patch.object(
                launcher_account, "link_with_code",
                side_effect=settings_sync.SyncError("Код истёк. Получите новый в профиле.")):
            dialog._link()
            self.assertTrue(wait_until(
                self.app, lambda: "Код истёк" in dialog.status_label.text()),
                dialog.status_label.text())
        self.assertEqual(dialog.code_input.text(), LINK_CODE)

    def test_push_reports_the_stamp(self):
        self.link("Jameson")
        dialog = self.dialog()
        with mock.patch.object(launcher_account, "push_from_file",
                               return_value="2026-10-29T12:30:00Z"):
            dialog._push()
            self.assertTrue(wait_until(
                self.app, lambda: "2026-10-29 12:30" in dialog.status_label.text()),
                dialog.status_label.text())
        self.assertIn("отправлена на сайт", dialog.status_label.text())

    def test_pull_failure_is_shown_without_closing_the_dialog(self):
        self.link("Jameson")
        dialog = self.dialog()
        with mock.patch.object(launcher_account, "pull_into_file",
                               side_effect=settings_sync.SyncError("Нет связи с сайтом")):
            dialog._pull()
            self.assertTrue(wait_until(
                self.app, lambda: "Нет связи" in dialog.status_label.text()),
                dialog.status_label.text())
        self.assertTrue(dialog.isEnabled())

    def real_unlink(self, path, **_kwargs):
        return launcher_account._store_account(path, None) and True

    def test_unlink_asks_first_and_clears_the_binding(self):
        self.link("Jameson")
        dialog = self.dialog()
        with mock.patch("ui_qt.ask_yes_no", return_value=False), \
                mock.patch.object(launcher_account, "unlink") as unlink:
            dialog._unlink()
            unlink.assert_not_called()
        with mock.patch("ui_qt.ask_yes_no", return_value=True), \
                mock.patch.object(launcher_account, "unlink", side_effect=self.real_unlink):
            dialog._unlink()
            self.assertTrue(wait_until(
                self.app, lambda: "отвязан" in dialog.status_label.text()),
                dialog.status_label.text())
        self.assertTrue(dialog.code_row.isVisibleTo(dialog))

    def test_dialog_keeps_the_site_address_visible_before_binding(self):
        dialog = self.dialog()
        self.assertIn("edringcolony.ru", dialog.status_label.text())


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class LauncherHeaderTests(ProfileTests):
    def test_header_holds_the_profile_in_the_top_right_corner(self):
        import launcher_window

        window = launcher_window.LauncherWindow(
            install_root=Path(self.temp.name), version="1.2.0", channel="stable",
            settings_path=self.settings, autostart=False,
            fetcher=lambda locale=None: {"news": [], "galnet": []})
        window.show()
        self.app.processEvents()
        try:
            badge = window.profile_badge
            self.assertIsInstance(badge, launcher_profile.ProfileBadge)
            self.assertEqual(badge.name_label.text(), "Лаунчер не привязан")
            # Правая сторона шапки: значок стоит за серединой окна.
            self.assertGreater(badge.mapTo(window, badge.rect().center()).x(),
                               window.width() // 2)
        finally:
            window.close()
            self.app.processEvents()

    def test_linked_launcher_keeps_the_profile_visible_on_start(self):
        import launcher_window

        payload = {"ok": True, "token": "tok-9", "deviceId": "dev-9",
                   "profile": {"nick": "Jameson"}}
        with mock.patch.object(launcher_account.settings_sync, "claim_code",
                               return_value=payload):
            launcher_account.link_with_code("ABCD-2345", self.settings)
        window = launcher_window.LauncherWindow(
            install_root=Path(self.temp.name), version="1.2.0", channel="stable",
            settings_path=self.settings, autostart=False,
            fetcher=lambda locale=None: {"news": [], "galnet": []})
        try:
            self.assertEqual(window.profile_badge.name_label.text(), "Jameson")
            self.assertEqual(window.profile_badge.action.text(), "Синхронизация")
        finally:
            window.close()

    def test_start_sync_skips_an_unlinked_launcher(self):
        import launcher_window

        window = launcher_window.LauncherWindow(
            install_root=Path(self.temp.name), version="1.2.0", channel="stable",
            settings_path=self.settings, autostart=False,
            fetcher=lambda locale=None: {"news": [], "galnet": []})
        try:
            with mock.patch.object(launcher_account, "refresh_profile") as refresh:
                window.sync_account()
                self.app.processEvents()
                refresh.assert_not_called()
        finally:
            window.close()

    def test_start_sync_picks_up_a_newer_layout(self):
        import launcher_window

        payload = {"ok": True, "token": "tok-9", "profile": {"nick": "Jameson"}}
        with mock.patch.object(launcher_account.settings_sync, "claim_code",
                               return_value=payload):
            launcher_account.link_with_code("ABCD-2345", self.settings)
        window = launcher_window.LauncherWindow(
            install_root=Path(self.temp.name), version="1.2.0", channel="stable",
            settings_path=self.settings, autostart=False,
            fetcher=lambda locale=None: {"news": [], "galnet": []})
        layout = {"settings": {"version": 1, "active_profile": "Бой", "route_x": 42},
                  "updatedAt": "2026-10-29T13:00:00Z"}
        try:
            with mock.patch.object(launcher_account.settings_sync, "fetch_settings",
                                   return_value=layout), \
                    mock.patch.object(launcher_account.settings_sync, "fetch_profile",
                                      return_value={"ok": True, "profile": {"nick": "Jameson"}}):
                window.sync_account()
                self.assertTrue(wait_until(
                    self.app, lambda: json.loads(self.settings.read_text(encoding="utf-8"))
                    .get("route_x") == 42))
        finally:
            window.close()


if __name__ == "__main__":
    unittest.main()
