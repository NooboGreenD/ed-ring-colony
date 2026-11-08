"""Полное удаление: план, защита путей, исполнение и отложенный остаток."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import bundle  # noqa: E402
import uninstall  # noqa: E402


class FakeRegistry:
    """Минимальный `winreg`: запоминает значения, умеет падать по заказу."""

    HKEY_CURRENT_USER = "HKCU"
    REG_SZ = 1

    def __init__(self, fail=False, missing=False, stored=None):
        self.values = {}
        self.deleted = []
        self.fail = fail
        self.missing = missing
        self.stored = dict(stored or {})

    def CreateKey(self, _root, subkey):  # noqa: N802 - повторяем API winreg
        class _Key:
            def __enter__(inner):
                return "key"

            def __exit__(inner, *exc):
                return False

        self.subkey = subkey
        return _Key()

    def SetValueEx(self, _key, name, _reserved, _kind, value):  # noqa: N802
        if self.fail:
            raise OSError("registry is locked")
        self.values[name] = value

    def OpenKey(self, _root, subkey):  # noqa: N802 - так же, как в winreg
        if self.missing or not self.stored:
            raise FileNotFoundError(subkey)

        class _Key:
            def __enter__(inner):
                return "key"

            def __exit__(inner, *exc):
                return False

        return _Key()

    def QueryValueEx(self, _key, name):  # noqa: N802
        return self.stored[name], self.REG_SZ

    def DeleteKey(self, _root, subkey):  # noqa: N802
        if self.missing:
            raise FileNotFoundError(subkey)
        if self.fail:
            raise OSError("registry is locked")
        self.deleted.append(subkey)


class UninstallTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.root = self.base / "Games" / "Colonial Helper"
        (self.root / "app" / "1.2.0").mkdir(parents=True)
        (self.root / "app" / "1.2.0" / "helper.py").write_text("print('helper')", encoding="utf-8")
        (self.root / "logs").mkdir()
        (self.root / "logs" / "launcher.log").write_text("log line", encoding="utf-8")
        (self.root / "cache").mkdir()
        (self.root / "state.json").write_text("{}", encoding="utf-8")
        bundle.write_install_marker(self.root)
        self.running = self.base / "Setup.exe"
        self.running.write_bytes(b"setup")

    def tearDown(self):
        self.temp.cleanup()

    def plan(self, **kwargs):
        kwargs.setdefault("home", self.home)
        kwargs.setdefault("appdata", self.base / "appdata")
        kwargs.setdefault("desktop", self.base / "desktop")
        return uninstall.build_plan(self.root, **kwargs)


class ProtectedPathTests(UninstallTestCase):
    def test_drive_root_home_and_system_folders_are_refused(self):
        root = Path(self.root.anchor)
        self.assertIn("корень диска", uninstall.protected_reason(root, home=self.home))
        self.assertIn("домашняя папка", uninstall.protected_reason(self.home, home=self.home))
        for name in ("Windows", "System32", "Program Files", "ProgramData", "Users"):
            folder = Path(self.root.anchor) / name
            self.assertIn("системная папка",
                          uninstall.protected_reason(folder, home=self.home), name)

    def test_relative_path_is_refused(self):
        self.assertIn("полный путь", uninstall.protected_reason(Path("relative"), home=self.home))

    def test_own_folder_is_allowed(self):
        self.assertEqual(uninstall.protected_reason(self.root, home=self.home), "")

    def test_extra_protected_folder_is_refused(self):
        extra = self.base / "ProgramData"
        self.assertIn("системная папка",
                      uninstall.protected_reason(extra, home=self.home, extra=[extra]))


class PlanTests(UninstallTestCase):
    def test_plan_lists_install_entries_shortcuts_and_settings(self):
        menu = uninstall.start_menu_dir(self.base / "appdata") / "Colonial Helper.lnk"
        menu.parent.mkdir(parents=True)
        menu.write_text("lnk", encoding="utf-8")
        desktop = self.base / "desktop"
        desktop.mkdir()
        (desktop / "Colonial Helper.lnk").write_text("lnk", encoding="utf-8")
        for name in uninstall.USER_FILES:
            (self.home / name).write_text("{}", encoding="utf-8")
        (self.home / ".colonial_helper").mkdir()

        plan = self.plan()

        self.assertTrue(plan.ok, plan.problems)
        names = {path.name for path in plan.paths}
        self.assertEqual(names, {"app", "logs", "cache", "state.json", bundle.MARKER_NAME})
        # ярлыки лежат в группе «ED Ring Colony» — удаляем группу целиком
        self.assertIn(menu.parent, plan.shortcuts)
        self.assertIn(desktop / "Colonial Helper.lnk", plan.shortcuts)
        self.assertEqual({path.name for path in plan.user_files},
                         set(uninstall.USER_FILES) | set(uninstall.USER_DIRS))
        self.assertGreater(plan.bytes, 0)
        self.assertTrue(plan.summary()["registry"])

    def test_keep_settings_leaves_account_files_alone(self):
        (self.home / uninstall.USER_FILES[0]).write_text("{}", encoding="utf-8")
        (self.home / uninstall.USER_DIRS[0]).mkdir()

        plan = self.plan(keep_settings=True)

        self.assertEqual(plan.user_files, [])

    def test_folder_without_install_problems(self):
        empty = self.base / "Empty"
        empty.mkdir()

        plan = uninstall.build_plan(empty, home=self.home, appdata=self.base / "appdata",
                                    desktop=self.base / "desktop")

        self.assertFalse(plan.ok)
        self.assertIn("нет установленной программы", plan.problems[0])

    def test_shortcuts_can_be_kept(self):
        desktop = self.base / "desktop"
        desktop.mkdir()
        (desktop / "Colonial Helper.lnk").write_text("lnk", encoding="utf-8")

        plan = self.plan(remove_shortcuts=False)

        self.assertEqual(plan.shortcuts, [])

    def test_marker_alone_is_enough_to_recognise_install(self):
        folder = self.base / "Moved Helper"
        folder.mkdir()
        bundle.write_install_marker(folder)

        self.assertTrue(uninstall.looks_like_install(folder))


class ExecuteTests(UninstallTestCase):
    def test_execute_removes_everything_and_reports_freed_space(self):
        settings = self.home / uninstall.USER_FILES[0]
        settings.write_text("{}", encoding="utf-8")

        result = uninstall.execute(self.plan(), running_executable=self.running,
                                   registry_remove=lambda: [])

        self.assertTrue(result["ok"], result)
        self.assertFalse(self.root.exists())
        self.assertFalse(settings.exists())
        self.assertFalse(result["deferred"])
        self.assertEqual(result["failed"], [])
        self.assertGreater(result["freed"], 0)

    def test_execute_keeps_user_files_when_settings_kept(self):
        settings = self.home / uninstall.USER_FILES[0]
        settings.write_text("{}", encoding="utf-8")

        uninstall.execute(self.plan(keep_settings=True), running_executable=self.running,
                          registry_remove=lambda: [])

        self.assertTrue(settings.is_file())
        self.assertFalse(self.root.exists())

    def test_execute_from_inside_folder_defers_removal(self):
        spawn = mock.Mock()
        plan = self.plan()

        with mock.patch.object(uninstall.sys, "platform", "win32"):
            result = uninstall.execute(plan, running_executable=self.root / "ColonialHelper.exe",
                                       registry_remove=lambda: [], spawn=spawn)

        self.assertTrue(result["deferred"])
        self.assertTrue(self.root.exists())
        self.assertTrue(spawn.called)
        self.assertTrue(str(spawn.call_args[0][0][2]).endswith(".cmd"))

    def test_execute_reports_step_failures_without_stopping(self):
        def failing_remove(_path, ignore_errors=False):
            raise OSError("file is busy")

        result = uninstall.execute(self.plan(), running_executable=self.running,
                                   remove_tree=failing_remove,
                                   registry_remove=lambda: ["реестр не ответил"])

        self.assertFalse(result["ok"])
        self.assertEqual(result["warnings"], ["реестр не ответил"])
        self.assertTrue(result["failed"])

    def test_broken_plan_deletes_nothing(self):
        empty = self.base / "Empty"
        empty.mkdir()
        (empty / "keep.txt").write_text("keep", encoding="utf-8")
        plan = uninstall.build_plan(empty, home=self.home, appdata=self.base / "appdata",
                                    desktop=self.base / "desktop")

        result = uninstall.execute(plan, running_executable=self.running)

        self.assertFalse(result["ok"])
        self.assertEqual(result["removed"], [])
        self.assertTrue((empty / "keep.txt").is_file())


class DeferredScriptTests(UninstallTestCase):
    def test_script_waits_for_process_and_deletes_files_and_folders(self):
        folder = self.base / "Left"
        folder.mkdir()
        file = folder / "state.json"

        text = uninstall.deferred_delete_script([folder, file], wait_pid=4242)

        self.assertIn('tasklist /fi "PID eq 4242"', text)
        self.assertIn(f'rmdir /s /q "{folder}"', text)
        self.assertIn(f'del /f /q "{file}"', text)
        self.assertIn('del /f /q "%~f0"', text)
        self.assertTrue(text.endswith("\r\n"))

    def test_script_without_pid_waits_by_timer(self):
        text = uninstall.deferred_delete_script([self.root], pause_seconds=3)

        self.assertIn("ping -n 4 127.0.0.1", text)
        self.assertNotIn("tasklist", text)

    def test_schedule_writes_script_and_spawns_cmd(self):
        spawn = mock.Mock()

        with mock.patch.object(uninstall.sys, "platform", "win32"), \
                mock.patch.object(uninstall.subprocess, "DETACHED_PROCESS", 8, create=True), \
                mock.patch.object(uninstall.subprocess, "CREATE_NEW_PROCESS_GROUP", 512, create=True), \
                mock.patch.object(uninstall.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True):
            script = uninstall.schedule_deferred_delete(
                [self.root], wait_pid=7, spawn=spawn, directory=self.base / "script")

        self.assertTrue(script.is_file())
        self.assertIn("PID eq 7", script.read_text(encoding="utf-8"))
        self.assertEqual(spawn.call_args[0][0][:2], ["cmd.exe", "/c"])
        self.assertTrue(spawn.call_args[1]["creationflags"])

    def test_nothing_to_delete_does_not_spawn(self):
        spawn = mock.Mock()

        self.assertIsNone(uninstall.schedule_deferred_delete([], spawn=spawn))
        self.assertFalse(spawn.called)


class RegistryTests(UninstallTestCase):
    def test_register_writes_uninstall_commands(self):
        registry = FakeRegistry()

        warnings = uninstall.register_uninstall(self.root, version="2.27.0", api=registry)

        self.assertEqual(warnings, [])
        self.assertEqual(registry.values["DisplayVersion"], "2.27.0")
        self.assertEqual(registry.values["InstallLocation"], str(self.root))
        self.assertEqual(registry.values["UninstallString"],
                         f'"{self.root / "ColonialHelper.exe"}" --uninstall')
        self.assertEqual(registry.values["QuietUninstallString"],
                         f'"{self.root / "ColonialHelper.exe"}" --uninstall --silent')
        self.assertIn("EDRingColonyColonialHelper", registry.subkey)

    def test_register_and_unregister_failures_are_warnings(self):
        registry = FakeRegistry(fail=True)

        self.assertTrue(uninstall.register_uninstall(self.root, api=registry))
        self.assertTrue(uninstall.unregister_uninstall(api=registry))

    def test_unregister_missing_entry_is_not_an_error(self):
        self.assertEqual(uninstall.unregister_uninstall(api=FakeRegistry(missing=True)), [])
        self.assertEqual(uninstall.unregister_uninstall(api=FakeRegistry()), [])

    def test_registered_folder_is_remembered_for_the_next_setup_run(self):
        registry = FakeRegistry(stored={"InstallLocation": str(self.root)})

        self.assertEqual(uninstall.registered_install_root(api=registry), self.root)

    def test_registered_folder_is_ignored_when_it_is_gone(self):
        registry = FakeRegistry(stored={"InstallLocation": str(self.base / "gone")})

        self.assertIsNone(uninstall.registered_install_root(api=registry))

    def test_registered_folder_missing_entry_is_not_an_error(self):
        self.assertIsNone(uninstall.registered_install_root(api=FakeRegistry(missing=True)))
        with mock.patch.object(uninstall, "_winreg", return_value=None):
            self.assertIsNone(uninstall.registered_install_root())

    def test_without_winreg_nothing_happens(self):
        with mock.patch.object(uninstall, "_winreg", return_value=None):
            self.assertEqual(uninstall.register_uninstall(self.root), [])
            self.assertEqual(uninstall.unregister_uninstall(), [])


class CommandLineTests(UninstallTestCase):
    def test_silent_uninstall_uses_root_and_reports_json(self):
        printed = []

        def fake_execute(plan, **_kwargs):
            return {"ok": True, "deferred": False, "failed": [], "warnings": []}

        with mock.patch.object(uninstall, "execute", side_effect=fake_execute), \
                mock.patch("builtins.print", side_effect=lambda *a, **k: printed.append(a[0])):
            code = uninstall.main(["--uninstall", "--silent", "--root", str(self.root),
                                   "--keep-settings"])

        self.assertEqual(code, 0)
        self.assertEqual(json.loads(printed[0])["ok"], True)

    def test_silent_uninstall_refuses_protected_folder(self):
        errors = []

        with mock.patch("builtins.print", side_effect=lambda *a, **k: errors.append(a[0])):
            code = uninstall.main(["--silent", "--root", str(Path.home())])

        self.assertEqual(code, 2)
        self.assertIn("домашняя папка", errors[0])

    def test_silent_uninstall_returns_one_when_steps_fail(self):
        with mock.patch.object(uninstall, "execute",
                               return_value={"ok": False, "deferred": False,
                                             "failed": ["busy"], "warnings": []}), \
                mock.patch("builtins.print"):
            code = uninstall.main(["--silent", "--root", str(self.root)])

        self.assertEqual(code, 1)


class BundleIntegrationTests(UninstallTestCase):
    def test_install_marker_is_removed_with_the_program(self):
        self.assertTrue(bundle.install_marker_path(self.root).is_file())

        uninstall.execute(self.plan(), running_executable=self.running,
                          registry_remove=lambda: [])

        self.assertFalse(self.root.exists())

    def test_current_version_comes_from_state(self):
        bundle.save_state(self.root, {"current": "1.2.0"})

        self.assertEqual(uninstall.current_version(self.root), "1.2.0")
        self.assertEqual(uninstall.current_version(self.base / "missing"), "—")


if __name__ == "__main__":
    unittest.main()
