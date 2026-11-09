"""Колесо мыши не должно менять значения без клика.

Проблема, которую держат эти тесты: колесо доставляется виджету под курсором,
и часть настроек меняет значение от колеса сама. Пилот листает страницу
вниз — и молча меняются язык, план площадки, экран оверлея или размер шрифта.
Выглядит как «программа сама переключила настройку».

Правила два:

* выпадающие списки (`QComboBox`) колесо не листают **никогда** — ни без фокуса,
  ни после клика, ни в открытом попапе: выбор делается только нажатием;
* ползунки, счётчики и вкладки меняются от колеса только в фокусе.
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

    # ------------------------------------------- список колесом не листается вовсе
    def test_combo_ignores_the_wheel_even_after_a_click(self):
        """Клик даёт списку фокус — но выбор всё равно только нажатием по строке.

        Раньше правило было «до клика не менять»: кликнув по списку, пилот
        получал фокус, и следующее движение колеса переключало значение. С
        экрана это выглядело как «само прокрутилось».
        """
        self.combo.setFocus()
        self.app.processEvents()
        self.assertTrue(self.combo.hasFocus())
        before = self.combo.currentIndex()

        wheel(self.combo, notches=3)

        self.assertEqual(self.combo.currentIndex(), before)

    def test_page_scrolls_even_when_the_combo_is_focused(self):
        self.combo.setFocus()
        self.app.processEvents()
        bar = self.page.verticalScrollBar()
        bar.setValue(0)

        wheel(self.combo)

        self.assertGreater(bar.value(), 0, "страница листается и с фокусом на списке")

    def test_wheel_over_the_open_list_does_not_change_the_choice(self):
        """Колесо над открытым меню листает пункты, но не выбор и не страницу."""
        from PySide6.QtWidgets import QComboBox as _Combo

        combo = _Combo()
        combo.addItems([f"пункт {index}" for index in range(40)])
        self.layout.insertWidget(0, combo)
        self.app.processEvents()
        combo.setCurrentIndex(5)
        combo.showPopup()
        self.app.processEvents()
        self.addCleanup(combo.hidePopup)
        view = combo.view()
        self.assertTrue(view.isVisible())
        items_bar = view.verticalScrollBar()

        before = combo.currentIndex()
        page_value = self.page.verticalScrollBar().value()

        wheel(view.viewport(), notches=3)

        self.assertEqual(combo.currentIndex(), before, "выбор — только нажатием")
        self.assertGreater(items_bar.value(), 0, "само меню листается")
        self.assertEqual(self.page.verticalScrollBar().value(), page_value,
                         "страница под открытым меню не должна уезжать")

    def test_wheel_on_the_popup_scrollbar_does_not_change_the_choice(self):
        from PySide6.QtWidgets import QComboBox as _Combo

        combo = _Combo()
        combo.addItems([f"пункт {index}" for index in range(40)])
        self.layout.insertWidget(0, combo)
        self.app.processEvents()
        combo.setCurrentIndex(3)
        combo.showPopup()
        self.app.processEvents()
        self.addCleanup(combo.hidePopup)
        before = combo.currentIndex()

        wheel(combo.view().verticalScrollBar(), notches=3)

        self.assertEqual(combo.currentIndex(), before)

    def test_editable_combo_ignores_the_wheel_over_its_field(self):
        """У редактируемого списка колесо над полем ввода — тот же список."""
        from PySide6.QtWidgets import QComboBox as _Combo

        combo = _Combo()
        combo.setEditable(True)
        combo.addItems([f"пункт {index}" for index in range(40)])
        self.layout.insertWidget(0, combo)
        self.app.processEvents()
        combo.setFocus()
        self.app.processEvents()
        field = combo.lineEdit()
        before = combo.currentIndex()

        wheel(field, notches=3)

        self.assertEqual(combo.currentIndex(), before)

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

    def test_combo_subclass_is_covered(self):
        """Свои списки страниц (`RefreshingCombo` и подобные) — те же правила."""
        from PySide6.QtWidgets import QComboBox as _Combo

        class OwnCombo(_Combo):
            pass

        combo = OwnCombo()
        combo.addItems(["a", "b", "c"])
        self.layout.insertWidget(0, combo)
        self.app.processEvents()
        combo.setFocus()
        self.app.processEvents()
        before = combo.currentIndex()

        wheel(combo, notches=2)

        self.assertEqual(combo.currentIndex(), before)

    def test_guard_counts_what_it_swallowed(self):
        guard = ui_qt.install_wheel_guard()
        before = guard.suppressed

        wheel(self.combo)
        wheel(self.slider)

        self.assertEqual(guard.suppressed, before + 2)

    def test_scroll_ancestor_is_the_page(self):
        self.assertIs(ui_qt.WheelGuard.scroll_ancestor(self.combo), self.page)
        self.assertIsNone(ui_qt.WheelGuard.scroll_ancestor(QWidget()))

    def test_inside_popup_is_told_apart_from_the_combo(self):
        combo = self.combo
        self.assertFalse(ui_qt.inside_combo_popup(combo, combo))
        self.assertFalse(ui_qt.inside_combo_popup(None, combo))

    def test_combo_is_found_around_its_popup_and_field(self):
        self.assertIs(ui_qt.enclosing_combo(self.combo), self.combo)
        editable = QComboBox()
        editable.setEditable(True)
        self.assertIs(ui_qt.enclosing_combo(editable.lineEdit()), editable)
        self.assertIsNone(ui_qt.enclosing_combo(QWidget()))

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
