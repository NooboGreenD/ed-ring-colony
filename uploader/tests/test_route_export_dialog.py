"""Окно «Экспорт CSV» — в оформлении приложения, а не системным диалогом.

Раньше это был голый ``QDialog``: на Windows он появлялся со светлым системным
заголовком посреди тёмного Helper. Теперь окно строится тем же
``ui_qt.FramelessWindow``, что и остальные окна программы, но ведёт себя как
диалог: ``exec()`` возвращает код результата, Esc и крестик — отказ.
"""
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QApplication

    import helper_pages
    import route_export
    from ui_qt import DIALOG_ACCEPTED, DIALOG_REJECTED, FramedDialog, ensure_app

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class RouteExportDialogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def setUp(self):
        self.dialog = helper_pages.RouteExportDialog(keys=None, systems=12)

    def tearDown(self):
        self.dialog.close()

    # ------------------------------------------------------------- оформление
    def test_dialog_is_the_frameless_window_of_the_app(self):
        self.assertIsInstance(self.dialog, FramedDialog)
        # Своя шапка вместо системного заголовка: именно из-за него окно
        # выбивалось из интерфейса.
        self.assertTrue(self.dialog.windowFlags() & Qt.WindowType.FramelessWindowHint)
        self.assertEqual(self.dialog.titlebar.title.text(), "Выгрузка маршрута в CSV")
        self.assertEqual(self.dialog.windowTitle(), "Выгрузка маршрута в CSV")

    def test_dialog_can_be_resized_by_its_edges(self):
        self.assertTrue(self.dialog._resizable)
        self.assertTrue(self.dialog.titlebar.maximize.isVisibleTo(self.dialog))
        self.assertGreaterEqual(self.dialog.minimumWidth(), 500)
        self.assertGreaterEqual(self.dialog.minimumHeight(), 300)

    def test_dialog_name_is_kept_for_tests_and_styles(self):
        self.assertEqual(self.dialog.objectName(), "routeExportDialog")

    def test_required_column_cannot_be_unticked(self):
        for key in route_export.REQUIRED_KEYS:
            self.assertFalse(self.dialog._boxes[key].isEnabled(), key)
            self.assertTrue(self.dialog._boxes[key].isChecked(), key)

    # -------------------------------------------------------------- поведение
    def test_summary_counts_columns_and_systems(self):
        self.assertIn("Столбцов: 4", self.dialog.summary.text())
        self.assertIn("12", self.dialog.summary.text())
        self.dialog._select_all()
        self.assertIn(f"Столбцов: {len(route_export.FIELDS)}", self.dialog.summary.text())

    def test_selecting_defaults_keeps_required_columns(self):
        self.dialog._select_all()
        self.dialog._select_defaults()
        self.assertEqual(self.dialog.selection(),
                         route_export.normalize_keys(list(route_export.DEFAULT_KEYS)))

    def test_export_button_accepts_with_the_chosen_columns(self):
        self.dialog._select_all()
        self.dialog.export_button.click()
        self.assertEqual(self.dialog.result(), DIALOG_ACCEPTED)
        self.assertEqual(self.dialog.chosen, route_export.all_keys())

    def test_cancel_button_rejects(self):
        self.dialog.cancel_button.click()
        self.assertEqual(self.dialog.result(), DIALOG_REJECTED)

    def test_escape_rejects(self):
        self.dialog.keyPressEvent(
            type("Event", (), {"key": lambda self: Qt.Key.Key_Escape})())
        self.assertEqual(self.dialog.result(), DIALOG_REJECTED)

    def test_closing_the_window_is_a_refusal(self):
        self.dialog.close()
        self.assertEqual(self.dialog.result(), DIALOG_REJECTED)

    def test_exec_waits_for_the_answer_and_returns_the_code(self):
        from PySide6.QtCore import QTimer

        QTimer.singleShot(0, self.dialog.export_button.click)
        self.assertEqual(self.dialog.exec(), DIALOG_ACCEPTED)
        self.assertTrue(self.dialog.isHidden())


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class RouteExportAskTests(unittest.TestCase):
    """``ask()`` остаётся точкой входа: без окон в тестах — прежние столбцы."""

    @classmethod
    def setUpClass(cls):
        cls.app = ensure_app()

    def test_headless_mode_returns_the_columns_untouched(self):
        import ui_qt

        ui_qt.DIALOGS_ENABLED = False
        self.assertEqual(helper_pages.RouteExportDialog.ask(["system", "bodies"]),
                         route_export.normalize_keys(["system", "bodies"]))

    def test_refusal_returns_none(self):
        import ui_qt
        from PySide6.QtCore import QTimer

        original = ui_qt.DIALOGS_ENABLED
        ui_qt.DIALOGS_ENABLED = True
        built = []

        class Closing(helper_pages.RouteExportDialog):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                built.append(self)
                QTimer.singleShot(0, self.reject)

        try:
            self.assertIsNone(Closing.ask(["system"]))
        finally:
            ui_qt.DIALOGS_ENABLED = original
        self.assertTrue(built)
        self.assertIsInstance(QApplication.instance(), QApplication)


if __name__ == "__main__":
    unittest.main()
