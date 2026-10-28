"""SHIP-оверлей печатает модель HUD без пересборки окна.

Экран живёт по своим правилам: одна строка = один `Label` из пула, текст и цвет
берутся из `ship_hud.hud_rows()`. Отсюда три инварианта, которые здесь проверяются:

* то, что напечатано, совпадает с моделью (расхождение «тесты зелёные, экран врёт»
  невозможно по построению);
* одинаковые данные не приводят к перекраске и перепакировке виджетов — это и есть
  отсутствующая защита от мерцания при обновлении раз в секунду;
* настройки блока (режим списка модулей, размер шрифта) применяются сразу, без
  пересоздания окна и без ожидания нового события журнала.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_overlay_management import _ensure_gui_stubs  # noqa: E402

_ensure_gui_stubs()

from overlay import ShipOverlay, ship_hud  # noqa: E402
from test_overlay_management import _ManagerTestCase  # noqa: E402
from test_ship_tracker_status import LOADOUT  # noqa: E402
import ship_tracker as st  # noqa: E402


def _text(widget):
    """Текст подписи: у Qt он хранится в самом виджете."""
    return "" if widget is None else str(widget.text())


def state_of(*events):
    tracker = st.ShipTracker()
    tracker.parse_event(dict(LOADOUT))
    for event in events:
        tracker.parse_event(event)
    return tracker.get_state_dict()


class _OverlayTestCase(unittest.TestCase):
    """База: настоящее окно SHIP на Qt — каждая строка это своя подпись."""

    def make_overlay(self, settings=None):
        base = {"font_family": "Consolas", "font_size": 10, "ship_width": 360,
                "ship_height": 330}
        base.update(settings or {})
        self.settings = base
        self.overlay = ShipOverlay(None, base)
        self.addCleanup(self.overlay.destroy)
        return self.overlay

    def row_texts(self):
        return [_text(label) for label in self.overlay._row_labels]

    def visible_rows(self, hud=None):
        hud = hud or self.overlay.get_hud()
        return [row["text"] for row in ship_hud.hud_rows(hud)]


class ShipOverlayRenderTests(_OverlayTestCase):

    def test_rows_are_exactly_the_model(self):
        overlay = self.make_overlay()
        overlay.update_ship(state_of())
        self.assertEqual(_text(overlay.ship_name_label), overlay.get_hud()["title"])
        self.assertEqual(self.row_texts()[:len(self.visible_rows())], self.visible_rows())

    def test_title_lists_the_ship(self):
        overlay = self.make_overlay()
        overlay.update_ship(state_of())
        self.assertIn("typex_1", _text(overlay.ship_name_label))
        self.assertIn("Lifer", _text(overlay.ship_name_label))

    def test_hull_damage_changes_the_painted_line(self):
        overlay = self.make_overlay()
        overlay.update_ship(state_of())
        before = self.row_texts()[0]
        overlay.update_ship(state_of({"timestamp": "2026-09-17T12:22:00Z", "event": "HullDamage",
                                      "Health": 0.62, "PlayerPilot": True}))
        after = self.row_texts()[0]
        self.assertNotEqual(before, after)
        self.assertIn("62%", after)
        self.assertIn("попадание", after)

    def test_chips_are_repainted_in_their_own_row(self):
        overlay = self.make_overlay()
        overlay.update_ship(state_of({"timestamp": "2026-09-17T12:22:00Z", "Flags": 0x100008,
                                       "Pips": [4, 1, 3]}))
        self.assertEqual([_text(widget) for widget in overlay._chip_widgets],
                         [chip["text"] for chip in overlay.get_hud()["chips"]],
                         "чипы рисуются ровно в том составе, что посчитала модель")

    def test_empty_state_renders_without_data(self):
        overlay = self.make_overlay()
        overlay.update_ship({})
        hud = overlay.get_hud()
        self.assertTrue(hud.get("empty"))
        self.assertEqual(self.row_texts()[:len(self.visible_rows(hud))], self.visible_rows(hud))


class ShipOverlayNoFlickerTests(_OverlayTestCase):

    def test_identical_data_does_not_repaint(self):
        overlay = self.make_overlay()
        data = state_of()
        overlay.update_ship(data)
        rows = list(overlay._row_labels)
        self.assertTrue(rows, "строки должны быть созданы")
        paints = overlay._paints
        texts = [_text(label) for label in rows]
        overlay.update_ship(data)
        self.assertEqual(overlay._paints, paints, "одинаковые данные — без перерисовки")
        self.assertEqual([_text(label) for label in rows], texts)

    def test_row_widgets_are_reused_and_surplus_hidden(self):
        overlay = self.make_overlay()
        overlay.update_ship(state_of(), force=False)
        wide = list(overlay._row_labels)
        overlay.settings["ship_modules_view"] = "off"
        overlay.update_ship(state_of(), force=True)
        hud = overlay.get_hud()
        kept = len(ship_hud.hud_rows(hud))
        self.assertLess(kept, len(wide), "режим «без списка» обязан укоротить блок")
        self.assertEqual(overlay._row_labels, wide, "виджеты переиспользуются, новых нет")
        for label in wide[kept:]:
            self.assertTrue(label.isHidden(), "лишние строки скрыты, но не удалены")
        self.assertEqual(len(overlay._row_labels), len(wide), "новый пул не создаётся")

    def test_font_size_change_repaints_rows(self):
        overlay = self.make_overlay()
        overlay.update_ship(state_of())
        first = overlay._row_labels[0]
        before = first.font().pixelSize()
        overlay.apply_font("Consolas", 13)
        self.assertNotEqual(first.font().pixelSize(), before,
                            "шрифт строки должен быть переустановлен")
        self.assertEqual(first.font().pixelSize(), 13 + 4, "кегль Qt = размер HUD + 4")
        self.assertEqual(overlay._fs, 13)

    def test_apply_font_is_idempotent(self):
        overlay = self.make_overlay()
        overlay.update_ship(state_of())
        overlay.apply_font("Consolas", 10)      # тот же размер — ничего не делаем
        self.assertEqual(overlay._chips_signature, "")


class ShipModulesViewManagerTests(_ManagerTestCase):
    """Новая настройка режима списка модулей: без пересоздания окна, сразу видно."""

    def test_mode_is_saved_without_recreating_the_window(self):
        import overlay

        self.manager.enabled = True
        self.manager.ship_overlay = mock.MagicMock()
        self.manager._last_ship_data = state_of()
        with mock.patch.object(overlay, "ShipOverlay") as ship_class:
            self.manager.set_ship_modules_view("all")
            ship_class.assert_not_called()
        self.assertEqual(self.manager.settings["ship_modules_view"], "all")
        self.manager.ship_overlay.update_ship.assert_called_once()
        self.assertTrue(self.manager.ship_overlay.update_ship.call_args.kwargs.get("force"))

    def test_mode_is_persisted_to_config(self):
        import json

        self.manager.enabled = True
        self.manager.ship_overlay = mock.MagicMock()
        self.manager._last_ship_data = state_of()
        self.manager.set_ship_modules_view("off")
        saved = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(saved.get("ship_modules_view"), "off",
                         "режим списка модулей обязан доживать до следующего запуска")

    def test_unknown_mode_falls_back_to_important(self):
        self.manager.enabled = True
        self.manager.ship_overlay = mock.MagicMock()
        self.manager.set_ship_modules_view("все")
        self.assertEqual(self.manager.settings["ship_modules_view"], "important")

    def test_refresh_without_data_is_harmless(self):
        self.manager.enabled = True
        self.manager.ship_overlay = mock.MagicMock()
        self.manager._last_ship_data = None
        self.manager.refresh_ship()
        self.manager.ship_overlay.update_ship.assert_not_called()

    def test_apply_update_remembers_the_last_state(self):
        data = {"ship": state_of()}
        self.manager.enabled = True
        self.manager.ship_overlay = mock.MagicMock()
        self.manager._apply_update(data)
        self.assertEqual(self.manager._last_ship_data, data["ship"])


if __name__ == "__main__":
    unittest.main()
