"""First-install copy, shortcuts and detached launch contract."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import bundle  # noqa: E402
import installer  # noqa: E402


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "setup-payload.exe"
        self.source.write_bytes(b"standalone launcher executable")
        self.install_root = self.root / "installed"

    def tearDown(self):
        self.temp.cleanup()

    def test_install_copies_launcher_creates_shortcuts_and_starts_with_reset_environment(self):
        written = []
        launched = {}

        def shortcut_writer(link, target):
            written.append((Path(link), Path(target)))

        def spawn(args, **kwargs):
            launched.update(args=args, kwargs=kwargs)
            return "process"

        result = installer.install_launcher(
            self.source, install_root=self.install_root,
            start_menu_dir=self.root / "start-menu", desktop_dir=self.root / "desktop",
            desktop_shortcut=True, shortcut_writer=shortcut_writer,
            process_launcher=spawn,
        )
        target = self.install_root / installer.EXECUTABLE
        self.assertEqual(target.read_bytes(), self.source.read_bytes())
        self.assertEqual(len(written), 2)
        self.assertTrue(all(destination == target for _, destination in written))
        self.assertEqual(launched["args"], [str(target)])
        self.assertEqual(launched["kwargs"]["env"]["PYINSTALLER_RESET_ENVIRONMENT"], "1")
        self.assertEqual(launched["kwargs"]["env"][bundle.HOME_ENV], str(self.install_root))
        self.assertEqual(result["process"], "process")
        self.assertEqual(result["warnings"], [])

    def test_shortcut_failure_does_not_discard_the_installed_launcher(self):
        def fail(_link, _target):
            raise OSError("blocked")

        result = installer.install_launcher(
            self.source, install_root=self.install_root, create_links=True,
            launch=False, shortcut_writer=fail,
        )
        self.assertTrue(Path(result["executable"]).is_file())
        self.assertEqual(len(result["warnings"]), 1)

    def test_repair_preserves_user_files_and_requests_server_repair(self):
        settings = self.root / "user-settings.json"
        settings.write_text("keep me", encoding="utf-8")
        launched = {}

        def spawn(args, **kwargs):
            launched.update(args=args, kwargs=kwargs)
            return "repair-process"

        installer.install_launcher(
            self.source, install_root=self.install_root,
            create_links=False, repair=True, process_launcher=spawn,
        )
        self.assertEqual(launched["args"], [str(self.install_root / installer.EXECUTABLE), "--repair"])
        self.assertEqual(settings.read_text(encoding="utf-8"), "keep me")

    def test_reinstall_uses_setup_embedded_bundle(self):
        launched = {}

        def spawn(args, **kwargs):
            launched.update(args=args, kwargs=kwargs)
            return "reinstall-process"

        installer.install_launcher(
            self.source, install_root=self.install_root,
            create_links=False, reinstall=True, process_launcher=spawn,
        )
        self.assertEqual(launched["args"], [str(self.install_root / installer.EXECUTABLE), "--reinstall"])

    def test_shortcut_uses_cscript_without_powershell_and_cleans_temporary_script(self):
        observed = {}

        def run(command, **kwargs):
            observed["command"] = command
            observed["kwargs"] = kwargs
            observed["script"] = Path(command[3]).read_text(encoding="ascii")
            observed["script_path"] = Path(command[3])
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with (
            mock.patch.object(installer.sys, "platform", "win32"),
            mock.patch.object(installer.subprocess, "run", side_effect=run),
        ):
            installer.create_shortcut(self.root / "menu" / "Colonial Helper.lnk", self.source)

        self.assertEqual(observed["command"][0], "cscript.exe")
        self.assertNotIn("powershell.exe", observed["command"])
        self.assertIn("CreateShortcut(WScript.Arguments(0))", observed["script"])
        self.assertIn(str(self.source), observed["command"])
        self.assertFalse(observed["script_path"].exists())

    def test_shortcut_timeout_returns_short_actionable_warning(self):
        with (
            mock.patch.object(installer.sys, "platform", "win32"),
            mock.patch.object(installer.subprocess, "run", side_effect=installer.subprocess.TimeoutExpired("cscript.exe", 12)),
        ):
            with self.assertRaisesRegex(RuntimeError, "не создал ярлык") as raised:
                installer.create_shortcut(self.root / "Colonial Helper.lnk", self.source)
        self.assertNotIn("TimeoutExpired", str(raised.exception))

    def test_existing_install_detection_includes_interrupted_install(self):
        self.assertFalse(installer.has_existing_install(self.install_root))
        bundle.state_path(self.install_root).parent.mkdir(parents=True)
        bundle.state_path(self.install_root).write_text("{}", encoding="utf-8")
        self.assertTrue(installer.has_existing_install(self.install_root))

    def test_missing_payload_fails_before_creating_install(self):
        missing = self.root / "missing.exe"
        with self.assertRaises(FileNotFoundError):
            installer.install_launcher(missing, install_root=self.install_root, launch=False)
        self.assertFalse(self.install_root.exists())


if __name__ == "__main__":
    unittest.main()
