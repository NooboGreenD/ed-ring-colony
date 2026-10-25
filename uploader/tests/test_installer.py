"""First-install copy, shortcuts and detached launch contract."""
import sys
import tempfile
import unittest
from pathlib import Path

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

    def test_missing_payload_fails_before_creating_install(self):
        missing = self.root / "missing.exe"
        with self.assertRaises(FileNotFoundError):
            installer.install_launcher(missing, install_root=self.install_root, launch=False)
        self.assertFalse(self.install_root.exists())


if __name__ == "__main__":
    unittest.main()
