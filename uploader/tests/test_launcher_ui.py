"""Contracts for the desktop launcher feed and its non-authenticated request."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import launcher_ui  # noqa: E402


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "news": [{"id": 42, "title": "Project news", "body": "Details", "published_at": "2026-10-25T12:00:00Z"}],
            "galnet": [{"id": 5, "nid": "galnet-1", "title": "Galnet", "body": "Story"}],
        }


class FakeSession:
    def __init__(self):
        self.call = None

    def get(self, url, **kwargs):
        self.call = (url, kwargs)
        return FakeResponse()


class LauncherUiTests(unittest.TestCase):
    def test_home_data_normalization_limits_records_and_stringifies_ids(self):
        rows = [{"id": number, "title": f"News {number}"} for number in range(5)]
        result = launcher_ui.normalize_home_data({"news": rows, "galnet": "bad"})
        self.assertEqual(len(result["news"]), 3)
        self.assertEqual(result["news"][0]["id"], "0")
        self.assertEqual(result["galnet"], [])

    def test_feed_request_uses_public_localized_endpoint_without_account_tokens(self):
        session = FakeSession()
        result = launcher_ui.fetch_home_data(session=session, site_url="https://example.test/")
        url, kwargs = session.call
        self.assertEqual(url, "https://example.test/api/home-data")
        self.assertEqual(kwargs["params"], {"locale": "ru"})
        self.assertNotIn("Authorization", kwargs["headers"])
        self.assertEqual(result["news"][0]["id"], "42")
        self.assertEqual(result["galnet"][0]["nid"], "galnet-1")

    def test_feed_request_uses_selected_language(self):
        session=FakeSession()
        launcher_ui.fetch_home_data(session=session,site_url="https://example.test",locale="de-DE")
        self.assertEqual(session.call[1]["params"],{"locale":"de"})

    def test_language_persistence_preserves_helper_settings(self):
        import launcher_settings
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/".colonial_helper.json"
            path.write_text(json.dumps({"token":"secret","update_channel":"beta"}),encoding="utf-8")
            self.assertEqual(launcher_settings.read_site_locale(path),"ru")
            launcher_settings.save_site_locale("ja",path)
            saved=json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["site_locale"],"ja")
            self.assertEqual(saved["token"],"secret")
            self.assertEqual(saved["update_channel"],"beta")
            if hasattr(path.stat(),"st_mode"):
                import stat
                self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
            self.assertEqual(launcher_settings.update_channel(path),"beta")

    def test_cms_html_is_rendered_as_readable_plain_text(self):
        self.assertEqual(launcher_ui.plain_text("<p>Hello &amp; <b>galaxy</b></p><br>again"),
                         "Hello & galaxy\nagain")

    def test_markdown_news_formatting_is_parsed_without_visible_markup(self):
        body = "# Update\n\n**Bold** and *italic*\n- first item\n2. second item"
        self.assertEqual(launcher_ui.plain_text(body),
                         "Update\nBold and italic\n• first item\n2. second item")
        kinds = [kind for kind, _segments in launcher_ui.article_blocks(body)]
        self.assertEqual(kinds, ["heading", "paragraph", "bullet", "ordered:2"])

    def test_html_headings_and_lists_remain_separate_blocks(self):
        body = "<h2>Update</h2><p>First paragraph</p><ul><li>one</li><li><b>two</b></li></ul>"
        self.assertEqual(launcher_ui.plain_text(body),
                         "Update\nFirst paragraph\n• one\n• two")
        kinds = [kind for kind, _segments in launcher_ui.article_blocks(body)]
        self.assertEqual(kinds, ["heading", "paragraph", "bullet", "bullet"])

    def test_links_and_inline_code_keep_readable_labels(self):
        blocks = launcher_ui.article_blocks("Read [the update](https://example.test/news) and `journal.log`.")
        self.assertEqual("".join(text for text, _tags in blocks[0][1]),
                         "Read the update and journal.log.")
        self.assertIn(("the update", ("link",)), blocks[0][1])

    def test_article_html_escapes_markup_and_keeps_structure(self):
        markup = launcher_ui.article_html(
            "<p>Hello &amp; <b>galaxy</b></p><script>alert(1)</script>"
            "<ul><li>one</li></ul>")
        self.assertIn("<b>galaxy</b>", markup)
        self.assertIn("&amp;", markup)
        self.assertIn("•", markup)
        self.assertNotIn("<script", markup)
        self.assertNotIn("alert(1)", markup)

    def test_long_article_bodies_are_truncated_for_the_card(self):
        markup = launcher_ui.article_html("word " * 400)
        self.assertIn("…", markup)
        self.assertLess(len(markup), 1400)

    def test_show_launcher_reports_a_broken_window_instead_of_launching(self):
        """Не построили окно — возвращаем None: bootstrapper запустит Helper сам."""
        import launcher_ui
        import ui_qt

        fake_launcher = mock.Mock()
        fake_launcher.choose_version.side_effect = RuntimeError("нет GUI")
        with mock.patch.object(launcher_ui, "_launcher_runtime", return_value=fake_launcher), \
             mock.patch.object(ui_qt, "ensure_app", side_effect=RuntimeError("нет Qt")):
            self.assertIsNone(launcher_ui.show_launcher(Path("/tmp/root"), None, None))

    def test_show_launcher_runs_the_qt_window_and_returns_its_choice(self):
        import launcher_ui
        import launcher_window
        import ui_qt

        instances = []

        class FakeWindow:
            launch_requested = True

            def __init__(self, install_root, version, channel, *, notice=""):
                self.args = (install_root, version, channel)
                self.notice = notice
                instances.append(self)

            def show(self):
                self.shown = True

        class FakeApp:
            def exec(self):
                return 0

        fake_launcher = mock.Mock()
        fake_launcher.choose_version.return_value = "9.9.9"
        with mock.patch.object(launcher_ui, "_launcher_runtime", return_value=fake_launcher), \
             mock.patch.object(launcher_window, "LauncherWindow", FakeWindow), \
             mock.patch.object(ui_qt, "ensure_app", return_value=FakeApp()):
            self.assertTrue(launcher_ui.show_launcher(Path("/tmp/root"), None, None))

        self.assertEqual(len(instances), 1)
        self.assertEqual(instances[0].args[1], "9.9.9")
        self.assertTrue(getattr(instances[0], "shown", False))
        self.assertEqual(instances[0].notice, "")

    def test_show_launcher_passes_the_reason_it_opened_again(self):
        import launcher_ui
        import launcher_window
        import ui_qt

        seen = []

        class FakeWindow:
            launch_requested = False

            def __init__(self, install_root, version, channel, *, notice=""):
                seen.append(notice)

            def show(self):
                pass

        class FakeApp:
            def exec(self):
                return 0

        fake_launcher = mock.Mock()
        fake_launcher.choose_version.return_value = "9.9.9"
        with mock.patch.object(launcher_ui, "_launcher_runtime", return_value=fake_launcher), \
             mock.patch.object(launcher_window, "LauncherWindow", FakeWindow), \
             mock.patch.object(ui_qt, "ensure_app", return_value=FakeApp()):
            self.assertFalse(launcher_ui.show_launcher(Path("/tmp/root"), None, None,
                                                      notice="closed"))
        self.assertEqual(seen, ["closed"])

    def test_article_links_use_existing_site_routes(self):
        self.assertEqual(launcher_ui._article_url("news", {"id": "42"}),
                         "https://edringcolony.ru/news/42")
        self.assertEqual(launcher_ui._article_url("galnet", {"nid": "story-1"}),
                         "https://edringcolony.ru/galnet/story-1")


if __name__ == "__main__":
    unittest.main()
