"""Headless Qt tests for the migrated Upload page."""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtWidgets import QCheckBox, QProgressBar, QPushButton

    import helper_pages
    from ui_qt import ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


class _Calls:
    """Records every callback the page fires."""

    def __init__(self):
        self.events = []

    def recorder(self, name):
        def callback(*args):
            self.events.append((name,) + args)

        return callback

    def names(self):
        return [event[0] for event in self.events]


def make_page(**overrides):
    calls = _Calls()
    actions = helper_pages.UploadPageActions(
        select_files=calls.recorder("select_files"),
        upload=calls.recorder("upload"),
        toggle_watcher=calls.recorder("toggle_watcher"),
        reset_import_cache=calls.recorder("reset_import_cache"),
        reset_server_journals=calls.recorder("reset_server_journals"),
        skip_imported=calls.recorder("skip_imported"),
        backfill_third_party=calls.recorder("backfill_third_party"),
    )
    values = dict(skip_imported=True, backfill_enabled=False, actions=actions)
    values.update(overrides)
    return helper_pages.UploadPage(**values), calls


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class UploadPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.page, self.calls = make_page()

    # ------------------------------------------------------------- structure
    def test_keeps_the_attribute_names_the_app_uses(self):
        for name in ("upload_btn", "watcher_btn", "files_label", "progress",
                     "progress_label", "skip_imported_var",
                     "backfill_third_party_var", "select_btn",
                     "reset_cache_btn", "reset_server_btn"):
            self.assertTrue(hasattr(self.page, name), name)

    def test_widget_types_are_native(self):
        self.assertIsInstance(self.page.upload_btn, QPushButton)
        self.assertIsInstance(self.page.watcher_btn, QPushButton)
        self.assertIsInstance(self.page.progress, QProgressBar)
        self.assertIsInstance(self.page.skip_imported_var, QCheckBox)
        self.assertIsInstance(self.page.backfill_third_party_var, QCheckBox)

    def test_initial_state(self):
        self.assertEqual(self.page.progress_value(), 0)
        self.assertEqual(self.page.files_text(), helper_pages.UploadPage.FILES_EMPTY_TEXT)
        self.assertFalse(self.page.upload_btn.isEnabled())
        self.assertFalse(self.page.watcher_running())
        self.assertTrue(self.page.skip_imported_var.isChecked())
        self.assertFalse(self.page.backfill_third_party_var.isChecked())

    def test_initial_values_come_from_the_arguments(self):
        page, _calls = make_page(skip_imported=False, backfill_enabled=True)
        self.assertFalse(page.skip_imported_var.isChecked())
        self.assertTrue(page.backfill_third_party_var.isChecked())

    # ---------------------------------------------------------------- buttons
    def test_buttons_fire_their_callbacks(self):
        self.page.set_upload_enabled(True)  # disabled until files are picked
        self.page.select_btn.click()
        self.page.upload_btn.click()
        self.page.watcher_btn.click()
        self.page.reset_cache_btn.click()
        self.page.reset_server_btn.click()
        self.assertEqual(self.calls.names(), [
            "select_files", "upload", "toggle_watcher",
            "reset_import_cache", "reset_server_journals",
        ])

    def test_missing_callbacks_do_not_crash(self):
        page = helper_pages.UploadPage(actions=helper_pages.UploadPageActions())
        for button in (page.select_btn, page.upload_btn, page.watcher_btn,
                       page.reset_cache_btn, page.reset_server_btn):
            button.click()
        page.skip_imported_var.setChecked(False)
        page.backfill_third_party_var.setChecked(True)

    # --------------------------------------------------------------- progress
    def test_progress_clamps_out_of_range_values(self):
        self.page.set_progress(-25)
        self.assertEqual(self.page.progress_value(), 0)
        self.page.set_progress(180)
        self.assertEqual(self.page.progress_value(), 100)
        self.page.set_progress("42.6")
        self.assertEqual(self.page.progress_value(), 43)

    def test_progress_accepts_garbage_without_raising(self):
        self.page.set_progress(50)
        self.page.set_progress(None)
        self.assertEqual(self.page.progress_value(), 0)
        self.page.set_progress("не число")
        self.assertEqual(self.page.progress_value(), 0)

    def test_progress_sets_its_caption(self):
        self.page.set_progress(30, "файлы 1/3")
        self.assertEqual(self.page.progress_value(), 30)
        self.assertEqual(self.page.progress_text(), "файлы 1/3")
        self.page.set_progress_text("готово")
        self.assertEqual(self.page.progress_text(), "готово")

    def test_files_label_text(self):
        self.page.set_files_text("Выбрано файлов: 12")
        self.assertEqual(self.page.files_text(), "Выбрано файлов: 12")
        self.assertIn("Выбрано файлов: 12", self.page.files_label.text())

    def test_upload_button_can_be_switched(self):
        self.page.set_upload_enabled(True)
        self.assertTrue(self.page.upload_btn.isEnabled())
        self.page.set_upload_enabled(False)
        self.assertFalse(self.page.upload_btn.isEnabled())

    # ---------------------------------------------------------------- watcher
    def test_watcher_button_switches_caption_and_back(self):
        self.page.set_watcher_running(True)
        self.assertEqual(self.page.watcher_btn.text(),
                         helper_pages.UploadPage.WATCHER_RUNNING_TEXT)
        self.assertTrue(self.page.watcher_running())
        self.page.set_watcher_running(False)
        self.assertEqual(self.page.watcher_btn.text(),
                         helper_pages.UploadPage.WATCHER_IDLE_TEXT)
        self.assertFalse(self.page.watcher_running())

    # -------------------------------------------------------------- checkboxes
    def test_toggles_report_their_new_value(self):
        self.page.skip_imported_var.setChecked(False)
        self.page.backfill_third_party_var.setChecked(True)
        self.assertEqual(self.calls.events,
                         [("skip_imported", False), ("backfill_third_party", True)])

    def test_programmatic_set_does_not_fire_the_callback(self):
        self.page.set_skip_imported(False)
        self.page.set_backfill_third_party(True)
        self.assertFalse(self.page.skip_imported_var.isChecked())
        self.assertTrue(self.page.backfill_third_party_var.isChecked())
        self.assertEqual(self.calls.events, [])

    def test_programmatic_set_keeps_signals_working(self):
        self.page.set_skip_imported(False)
        self.page.skip_imported_var.setChecked(True)
        self.assertEqual(self.calls.events, [("skip_imported", True)])

    # ---------------------------------------------------------------- drawing
    def test_page_renders_at_a_small_size(self):
        self.page.resize(760, 620)
        self.page.show()
        self.app.processEvents()
        image = self.page.grab().toImage()
        self.assertFalse(image.isNull())
        self.assertEqual((image.width(), image.height()), (760, 620))
        self.page.hide()

    def test_wide_window_does_not_clip_the_progress_bar(self):
        self.page.resize(1180, 700)
        self.page.show()
        self.app.processEvents()
        bar = self.page.progress
        self.assertGreaterEqual(bar.width(), 400)
        self.page.hide()


if __name__ == "__main__":
    unittest.main()
