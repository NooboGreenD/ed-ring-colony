"""Loading sessions: pure identity isolation, compact rows and optional native Qt."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from loading_patterns import LoadingPatternState, loading_lines


def payload():
    return {
        "ok": True,
        "pattern": {"pattern": {"name": "Two carriers"}},
        "checkedAt": "2026-11-23T12:00:00Z",
        "progress": {
            "loaded": 5,
            "total": 10,
            "unknown": 3,
            "unassigned": 0,
            "carriers": [
                {
                    "carrierId": "123",
                    "name": "Alpha",
                    "known": True,
                    "loaded": 5,
                    "target": 7,
                    "items": [
                        {
                            "commodity": "steel",
                            "required": 5,
                            "loaded": 5,
                            "remaining": 0,
                        },
                        {
                            "commodity": "titanium",
                            "required": 2,
                            "loaded": 0,
                            "remaining": 2,
                        },
                    ],
                },
                {
                    "carrierId": "456",
                    "name": "Beta",
                    "known": False,
                    "loaded": None,
                    "target": 3,
                    "items": [
                        {
                            "commodity": "steel",
                            "required": 3,
                            "loaded": None,
                            "remaining": None,
                        }
                    ],
                },
            ],
        },
    }


class LoadingStateTests(unittest.TestCase):
    def setUp(self):
        self.state = LoadingPatternState()
        self.identity = ("https://example.test/api", "test-token", True)
        self.state.clear(self.identity, "pattern-a")

    def test_accepts_active_session_only_and_copies_values(self):
        data = payload()
        self.assertFalse(self.state.accept(("other", "", False), "pattern-a", data))
        self.assertFalse(self.state.accept(self.identity, "pattern-b", data))
        self.assertTrue(self.state.accept(self.identity, "pattern-a", data))
        data["progress"]["loaded"] = 999
        snapshot = self.state.snapshot(self.identity, "pattern-a")
        self.assertEqual(snapshot["progress"]["loaded"], 5)
        snapshot["progress"]["loaded"] = 888
        self.assertEqual(
            self.state.snapshot(self.identity, "pattern-a")["progress"]["loaded"], 5
        )

    def test_identity_change_and_pattern_change_clear_private_stock(self):
        self.state.accept(self.identity, "pattern-a", payload())
        for identity in [
            ("other-site", "test-token", True),
            ("https://example.test/api", "new-token", True),
            ("https://example.test/api", "test-token", False),
        ]:
            self.assertEqual(self.state.snapshot(identity, "pattern-a"), {})
        self.state.prepare(self.identity, "pattern-b")
        self.assertEqual(self.state.payload, {})
        self.assertFalse(self.state.accept(self.identity, "pattern-a", payload()))

    def test_network_or_access_failure_removes_previous_progress(self):
        self.state.accept(self.identity, "pattern-a", payload())
        self.assertFalse(
            self.state.accept(
                self.identity, "pattern-a", {"ok": False, "error": "Unavailable"}
            )
        )
        self.assertEqual(
            self.state.snapshot(self.identity, "pattern-a"), {"note": "Unavailable"}
        )
        self.state.clear()
        self.assertEqual(self.state.payload, {})

    def test_pending_rows_unknown_never_shown_as_zero_and_focus(self):
        data = payload()
        summaries, rows = loading_lines(data)
        self.assertEqual(len(summaries), 2)
        self.assertEqual(len(rows), 2)
        self.assertTrue(any("-? t" in row for row in rows))
        self.assertEqual(len(loading_lines(data, True)[1]), 3)
        data["carrier_id"] = "456"
        summaries, rows = loading_lines(data)
        self.assertEqual(len(summaries), 1)
        self.assertIn("Beta", summaries[0])
        self.assertEqual(len(rows), 1)


class LoadingApiTests(unittest.TestCase):
    def test_bearer_auth_locale_timeout_and_no_redirects(self):
        from api_client import ApiClient
        from unittest.mock import Mock

        api = ApiClient(
            token="test-token", site_url="https://example.test", locale="en"
        )
        response = Mock(ok=True, status_code=200)
        response.json.return_value = {"ok": True, "patterns": []}
        session = Mock()
        session.get.return_value = response
        with patch("api_client._session_for_thread", return_value=session):
            self.assertTrue(api.fetch_loading_patterns(scope="public")["ok"])
            args, kwargs = session.get.call_args
            self.assertEqual(
                args[0], "https://example.test/api/architect/loading-patterns"
            )
            self.assertEqual(kwargs["headers"]["Authorization"], "Bearer test-token")
            self.assertEqual(kwargs["headers"]["Accept-Language"], "en")
            self.assertFalse(kwargs["allow_redirects"])
            self.assertEqual(kwargs["timeout"], 20)
            self.assertFalse(api.fetch_loading_pattern("../private")["ok"])
            self.assertEqual(session.get.call_count, 1)
            api.token = ""
            self.assertFalse(api.fetch_loading_patterns()["ok"])
            self.assertEqual(session.get.call_count, 1)

    def test_transport_failure_is_not_a_successful_empty_inventory(self):
        from api_client import ApiClient
        from unittest.mock import Mock

        api = ApiClient(token="test-token")
        session = Mock()
        session.get.side_effect = RuntimeError("offline")
        with patch("api_client._session_for_thread", return_value=session):
            result = api.fetch_loading_pattern("11111111-2222-4333-8444-555555555555")
            self.assertFalse(result["ok"])
            self.assertNotIn("progress", result)


try:
    from qt_loading_patterns import LoadingPatternsPage
    from overlay import (
        LoadingOverlay,
        OverlayManager,
        DEFAULT_SETTINGS,
        load_overlay_settings,
        save_overlay_settings,
    )
    from overlay_layout import BLOCK_LABELS, DEFAULT_BLOCK_POSITIONS
    from overlay_options import CONTENT_OPTIONS
    from hud_window import OVERLAY_META
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:
    QT_ERROR = str(exc)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class LoadingQtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def test_managed_overlay_registration_and_live_content_font_settings(self):
        for collection in (
            OverlayManager.BLOCKS,
            BLOCK_LABELS,
            DEFAULT_BLOCK_POSITIONS,
            CONTENT_OPTIONS,
            OVERLAY_META,
        ):
            self.assertIn("loading", collection)
        self.assertFalse(DEFAULT_SETTINGS["show_loading"])
        self.assertFalse(DEFAULT_SETTINGS["overlay_loading_completed"])
        settings = dict(DEFAULT_SETTINGS)
        overlay = LoadingOverlay(None, settings)
        self.addCleanup(overlay.destroy)
        overlay.update_loading(payload())
        self.assertIn("Two carriers", overlay.summary_label.text())
        self.assertEqual(overlay.manifest.cards["456"].table.item(0, 2).text(), "?")
        for section, name in [
            ("summary", "summary_label"),
            ("filter", "filter_combo"),
            ("source", "source_label"),
        ]:
            settings["overlay_loading_" + section] = False
            overlay.apply_data_options()
            self.assertTrue(getattr(overlay, name).isHidden())
            settings["overlay_loading_" + section] = True
            overlay.apply_data_options()
            self.assertFalse(getattr(overlay, name).isHidden())
        overlay.apply_font("Arial", 16)
        self.assertEqual(overlay.manifest.cards["123"].table.font().family(), "Arial")
        self.assertEqual(overlay.manifest.cards["123"].table.font().pixelSize(), 19)
        updated = payload()
        updated["pattern"]["catalogueUpdated"] = True
        overlay.update_loading(updated)
        from i18n import tr

        self.assertIn(
            tr("Каталог обновлён: проверьте распределение на сайте."),
            overlay.source_label.text(),
        )
        overlay.update_loading({})
        self.assertEqual(overlay.manifest.cards, {})

    def test_settings_roundtrip(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            settings = dict(
                DEFAULT_SETTINGS,
                show_loading=True,
                loading_alpha=0.6,
                loading_font_size=14,
                loading_hotkey="Ctrl+F10",
                loading_locked=True,
                loading_detached=True,
                loading_anchor="top_right",
                loading_auto_rule="game_focused",
                overlay_loading_items=False,
            )
            save_overlay_settings(path, settings)
            restored = load_overlay_settings(path)
            for key in settings:
                if "loading" in key:
                    self.assertEqual(restored[key], settings[key], key)

    def test_application_tab_updates_shared_hud_state_and_stale_callbacks_are_ignored(
        self,
    ):
        class API:
            api_base = "https://example.test/api"
            token = "test-token"
            is_connected = True

        config = {}
        page = LoadingPatternsPage(API(), config, lambda: None, lambda: False)
        self.addCleanup(page.deleteLater)
        page.timer.stop()
        page.active_id = "pattern-a"
        page.state.clear(page.identity(), "pattern-a")
        page.apply_result(page._seq, None, payload(), "pattern-a")
        self.assertEqual(page.overlay_state()["progress"]["loaded"], 5)
        self.assertIn("Two carriers", page.status.text())
        page.clear()
        page.apply_result(page._seq - 1, None, payload(), "pattern-a")
        self.assertEqual(page.overlay_state(), {"carrier_id": ""})
        self.assertNotIn("loading_pattern_id", config)
        page.api.token = "other-token"
        self.assertEqual(page.overlay_state(), {})


if __name__ == "__main__":
    unittest.main()
