"""The frozen launcher must carry the TLS certificates needed by Requests."""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import build_exe  # noqa: E402


class BuildExeTests(unittest.TestCase):
    def test_certifi_is_imported_and_its_ca_bundle_is_explicitly_collected(self):
        self.assertIn("certifi", build_exe.ALWAYS_INCLUDE)
        options = build_exe.collect_package_args()
        certifi_index = options.index("certifi")
        self.assertEqual(options[certifi_index - 1], "--collect-data")
        self.assertNotIn("--collect-submodules", options[certifi_index + 1:])

    def test_existing_theme_package_resources_are_still_collected(self):
        options = build_exe.collect_package_args()
        self.assertIn("--collect-data", options)
        self.assertIn("ttkbootstrap", options)
        self.assertIn("--collect-submodules", options)


if __name__ == "__main__":
    unittest.main()
