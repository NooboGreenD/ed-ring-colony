"""Колесо мыши не должно менять значения без клика.

Проблема, которую держат эти тесты: колесо доставляется виджету под курсором,
а `QComboBox`, `QSlider` и `QTabBar` меняют значение от колеса **без фокуса**.
Пилот листает страницу вниз, курсор на мгновение проходит над выпадающим
списком — и молча меняются язык, план площадки, экран оверлея или размер
шрифта. Выглядит как «программа сама переключила настройку».
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

try:
    from PySide6.QtCore import QPoint, QPointF, Qt
    from PySide6.QtGui import QWheelEvent
    from PySide6.QtWidgets import (
        QComboBox,
        QLabel,
        QLineEdit,
        QScrollArea,
        QSlider,
        QSpinBox,
        QTabWidget,
        QVBoxLayout,
        QWidget,
    )

    import ui_qt

    QT_ERROR = None
except (ImportError, OSError) as exc:  # pragma: no cover - depends on the machine
    QT_ERROR = str(exc)


def wheel(widget, notches=1):
    """Настоящее событие колеса в центр виджета (как от мыши)."""
    point = QPointF(widget.rect().center())
    global_point = widget.mapToGlobal(QPoint(int(point.x()), int(point.y())))
    event = QWheelEvent(
        point, QPointF(global_point), QPoint(0, 0), QPoint(0, -120 * notches),
        Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier,
        Qt.ScrollPhase.NoScrollPhase, False,
    )
    ui_qt.ensure_app().sendEvent(widget, event)
    return event


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class WheelGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = ui_qt.ensure_app()

    def setUp(self):
        self.page = QScrollArea()
        self.page.setWidgetResizable(True)
        content = QWidget()
        self.layout = QVBoxLayout(content)
        self.combo = QComboBox()
        self.combo.addItems([f"значение {index}" for index in range(40)])
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 100)
        self.slider.setValue(50)
        self.spin = QSpinBox()
        self.spin.setRange(0, 100)
        self.spin.setValue(10)
        self.tabs = QTabWidget()
        self.tabs.addTab(QWidget(), "первая")
        self.tabs.addTab(QWidget(), "вторая")
        # Поле ввода создаётся до показа: вставка виджета в уже показанную
        # раскладку заставляет Qt заново выбирать, кому отдать фокус.
        self.focus_holder = QLineEdit()
        self.layout.addWidget(self.focus_holder)
        for widget in (self.combo, self.slider, self.spin, self.tabs):
            self.layout.addWidget(widget)
        for index in range(80):
            self.layout.addWidget(QLabel(f"строка {index}"))
        self.page.setWidget(content)
        self.page.resize(420, 300)
        self.page.show()
        # Показ страницы отдаёт фокус первому фокусируемому виджету: забираем
        # его полем ввода, иначе «наведение» в тесте было бы уже «кликом».
        self.focus_holder.setFocus()
        self.app.processEvents()
        self.assertFalse(self.combo.hasFocus())

    def tearDown(self):
        self.focus_holder.clearFocus()
        self.page.close()
        self.app.processEvents()

    # ------------------------------------------------------------------ страница
    def test_page_still_scrolls_when_the_cursor_is_over_a_combo(self):
        bar = self.page.verticalScrollBar()
        bar.setValue(0)
        self.assertGreater(bar.maximum(), 0)

        wheel(self.combo)

        self.assertGreater(bar.value(), 0, "прокрутка страницы должна работать")

    # --------------------------------------------------- без клика ничего не меняется
    def test_combo_ignores_the_wheel_until_it_is_clicked(self):
        before = self.combo.currentIndex()
        self.assertFalse(self.combo.hasFocus())

        wheel(self.combo, notches=3)

        self.assertEqual(self.combo.currentIndex(), before)

    def test_slider_ignores_the_wheel_until_it_is_clicked(self):
        before = self.slider.value()
        self.assertFalse(self.slider.hasFocus())

        wheel(self.slider, notches=2)

        self.assertEqual(self.slider.value(), before)

    def test_spin_box_ignores_the_wheel_until_it_is_clicked(self):
        before = self.spin.value()

        wheel(self.spin, notches=2)

        self.assertEqual(self.spin.value(), before)

    def test_tabs_do_not_switch_on_hover(self):
        before = self.tabs.currentIndex()

        wheel(self.tabs.tabBar(), notches=2)

        self.assertEqual(self.tabs.currentIndex(), before)

    # ------------------------------------------------- после клика работает как раньше
    def test_combo_changes_after_an_explicit_click(self):
        self.combo.setFocus()
        self.app.processEvents()
        before = self.combo.currentIndex()

        wheel(self.combo)

        self.assertNotEqual(self.combo.currentIndex(), before)

    def test_slider_changes_after_an_explicit_click(self):
        self.slider.setFocus()
        self.app.processEvents()
        before = self.slider.value()

        wheel(self.slider)

        self.assertNotEqual(self.slider.value(), before)

    # ---------------------------------------------------------- устройство фильтра
    def test_guard_is_installed_once_on_the_application(self):
        first = ui_qt.install_wheel_guard()
        second = ui_qt.install_wheel_guard()

        self.assertIs(first, second)
        self.assertIs(getattr(self.app, "_edrc_wheel_guard"), first)

    def test_guard_counts_what_it_swallowed(self):
        guard = ui_qt.install_wheel_guard()
        before = guard.suppressed

        wheel(self.combo)
        wheel(self.slider)

        self.assertEqual(guard.suppressed, before + 2)

    def test_scroll_ancestor_is_the_page(self):
        self.assertIs(ui_qt.WheelGuard.scroll_ancestor(self.combo), self.page)
        self.assertIsNone(ui_qt.WheelGuard.scroll_ancestor(QWidget()))

    def test_plain_widgets_are_not_intercepted(self):
        """Обычные подписи и поля колесо не перехватывают — это лишний шум."""
        label = QLabel("просто подпись")
        self.layout.addWidget(label)
        self.app.processEvents()
        before = self.page.verticalScrollBar().value()

        wheel(label)

        self.assertEqual(self.page.verticalScrollBar().value(), before)


@unittest.skipIf(QT_ERROR is not None, f"Qt runtime unavailable: {QT_ERROR}")
class ComboInIsolatedWindowTests(unittest.TestCase):
    """Список без прокручиваемой страницы: колесо просто не меняет значение."""

    @classmethod
    def setUpClass(cls):
        cls.app = ui_qt.ensure_app()

    def test_combo_without_scroll_area_keeps_its_value(self):
        host = QWidget()
        layout = QVBoxLayout(host)
        combo = QComboBox()
        combo.addItems(["a", "b", "c"])
        layout.addWidget(combo)
        host.show()
        self.app.processEvents()
        combo.clearFocus()          # без клика фокуса у списка нет
        self.assertIsNone(ui_qt.WheelGuard.scroll_ancestor(combo))

        wheel(combo)

        self.assertEqual(combo.currentIndex(), 0)
        host.close()


if __name__ == "__main__":
    unittest.main()
