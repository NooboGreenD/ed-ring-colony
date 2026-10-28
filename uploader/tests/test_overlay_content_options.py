"""Persisted HUD content, non-destructive filtering, journal-only route facts."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from overlay_options import CONTENT_OPTIONS, CONTENT_DEFAULTS, filter_carrier_rows, route_summary
from route_tracker import RouteTracker
from overlay import (
    CargoOverlay,
    CarrierOverlay,
    ExobiologyOverlay,
    OverlayManager,
    RouteOverlay,
    SessionEventsOverlay,
    SessionOverlay,
    ShipOverlay,
    StatusOverlay,
    load_overlay_settings,
    save_overlay_settings,
)


class RouteSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tracker = RouteTracker()
        self.tracker.load_from_navroute({'Route': [
            {'StarSystem': 'A', 'StarPos': [0, 0, 0], 'StarClass': 'K'},
            {'StarSystem': 'B', 'StarPos': [3, 4, 0], 'StarClass': 'M'},
            {'StarSystem': 'C', 'StarPos': [3, 4, 12], 'StarClass': 'N'},
        ]})

    def test_first_leg_and_sum_not_direct_distance(self):
        data = route_summary(self.tracker.systems, 'a')
        self.assertEqual((data['next'], data['destination']), ('B', 'C'))
        self.assertEqual((data['jump_distance'], data['remaining_distance']), (5, 17))
        self.assertEqual(data['jumps_left'], 2)
        self.assertEqual(data['star_class'], 'M')
        self.assertTrue(data['scoopable'])

    def test_jump_uses_real_location_not_first_pending(self):
        self.tracker.mark_visited('A')
        self.tracker.mark_visited('B')
        data = route_summary(self.tracker.systems, 'B')
        self.assertEqual((data['next'], data['jump_distance'], data['jumps_left']), ('C', 12, 1))
        self.assertFalse(data['scoopable'])

    def test_csv_and_off_route_do_not_invent_distances(self):
        data = route_summary(self.tracker.systems, 'Elsewhere')
        self.assertEqual(data['next'], 'A')
        self.assertIsNone(data['jump_distance'])
        self.assertIsNone(data['remaining_distance'])
        self.tracker.load_from_csv('system\nA\nB\n')
        data = route_summary(self.tracker.systems, 'A')
        self.assertIsNone(data['star_class'])
        self.assertIsNone(data['scoopable'])
        self.assertIsNone(data['jump_distance'])

    def test_invalid_and_partial_coordinates(self):
        for point in ([1, 2], [1, float('nan'), 0], [None, 0, 0], 'bad'):
            self.tracker.systems[-1]['star_pos'] = point
            data = route_summary(self.tracker.systems, 'A')
            self.assertEqual(data['jump_distance'], 5)
            self.assertIsNone(data['remaining_distance'])

    def test_empty_and_completed_route(self):
        self.assertIsNone(route_summary([], 'A')['remaining_distance'])
        data = route_summary(self.tracker.systems, 'C')
        self.assertEqual((data['jumps_left'], data['remaining_distance'], data['next']), (0, 0, '—'))
        self.assertIsNone(data['jump_distance'])

    def test_reload_preserves_visited_and_refreshes_star_class(self):
        self.tracker.mark_visited('B')
        self.tracker.load_from_navroute({'Route': [{'StarSystem': 'B', 'StarClass': 'G'}]})
        self.assertEqual(self.tracker.systems[0]['star_class'], 'G')
        self.assertEqual(self.tracker.visited_count, 1)

    def test_route_hash_includes_metadata_changes(self):
        manager = object.__new__(OverlayManager)
        first = manager._hash_data({'route_summary': {'star_class': 'K'}})
        self.assertNotEqual(first, manager._hash_data({'route_summary': {'star_class': 'M'}}))

    def test_compact_route_renders_and_clears(self):
        overlay = RouteOverlay(None, {'font_family': 'Consolas', 'font_size': 10})
        try:
            data = route_summary(self.tracker.systems, 'A')
            overlay.update_route('A', 'B', 0, 3, summary=data)
            self.assertIn('5.0', overlay.distance_label.text())
            self.assertIn('17.0', overlay.remaining_label.text())
            overlay.update_route('C', '—', 3, 3,
                                 summary=route_summary(self.tracker.systems, 'C'))
            self.assertIn('завершён', overlay.next_label.text())
            overlay.update_route('C', '—', 0, 0, summary=route_summary([], 'C'))
            self.assertEqual(overlay.next_label.text(), 'Маршрут не задан')
            self.assertEqual(overlay.destination_label.text(), 'Цель: —')
        finally:
            overlay.destroy()


class CarrierFilterTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            {'key': 'steel', 'name': 'Сталь', 'amount': 3, 'need': 9, 'remaining': 6},
            {'key': 'gold', 'name': 'Gold', 'amount': 0, 'need': 5, 'remaining': 5},
            {'key': 'water', 'name': 'Water', 'amount': 8, 'need': 5, 'remaining': 0},
            {'key': 'tritium', 'name': 'Tritium', 'amount': 20, 'need': 0, 'remaining': 0},
        ]

    def test_modes_are_render_only_keep_order_and_input(self):
        original = copy.deepcopy(self.rows)
        for mode, expected in [('all', ['steel', 'gold', 'water', 'tritium']),
                               ('aboard', ['steel', 'water', 'tritium']),
                               ('project', ['steel', 'gold', 'water']), ('missing', ['steel', 'gold'])]:
            self.assertEqual([r['key'] for r in filter_carrier_rows(self.rows, mode)], expected)
        self.assertEqual(self.rows, original)

    def test_search_localized_name_symbol_and_mode(self):
        self.assertEqual(filter_carrier_rows(self.rows, 'missing', ' стАЛЬ '), self.rows[:1])
        self.assertEqual(filter_carrier_rows(self.rows, 'missing', 'STEEL'), self.rows[:1])
        self.assertEqual(filter_carrier_rows(self.rows, 'missing', 'water'), [])
        self.assertEqual(filter_carrier_rows(self.rows, 'all', 'absent'), [])
        self.assertEqual(filter_carrier_rows([], 'project'), [])

    def test_unknown_mode_and_no_construction(self):
        self.assertEqual(filter_carrier_rows(self.rows, 'old-value'), self.rows)
        self.assertEqual(filter_carrier_rows(self.rows[-1:], 'project'), [])
        self.assertEqual(filter_carrier_rows(self.rows[-1:], 'missing'), [])


class ContentSettingsTests(unittest.TestCase):
    def test_all_eight_blocks_have_persisted_preferences(self):
        self.assertEqual(set(CONTENT_OPTIONS), set(OverlayManager.BLOCKS))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'config.json'
            path.write_text(json.dumps({'unrelated': 'keep'}))
            settings = load_overlay_settings(path)
            settings.update({key: False for key in CONTENT_DEFAULTS})
            settings.update(carrier_filter='missing', carrier_search='Steel')
            save_overlay_settings(path, settings)
            restored = load_overlay_settings(path)
            for key in CONTENT_DEFAULTS:
                self.assertFalse(restored[key], key)
            self.assertEqual(restored['carrier_filter'], 'missing')
            self.assertEqual(restored['carrier_search'], 'Steel')
            self.assertEqual(restored['unrelated'], 'keep')

    def test_each_section_hides_and_restores_same_widgets(self):
        """Выключенный раздел скрывается, включённый — возвращается на место."""
        blocks = {"route": RouteOverlay, "status": StatusOverlay, "ship": ShipOverlay,
                  "cargo": CargoOverlay, "carrier": CarrierOverlay,
                  "session": SessionOverlay, "exobio": ExobiologyOverlay}
        self.assertEqual(set(blocks), set(CONTENT_OPTIONS) - {"events"})
        for block, overlay_class in blocks.items():
            with self.subTest(block=block):
                overlay = overlay_class(None, {"font_family": "Consolas", "font_size": 10})
                try:
                    for section, (_, attributes) in CONTENT_OPTIONS[block].items():
                        widgets = [getattr(overlay, name) for name in attributes]
                        key = f"overlay_{block}_{section}"
                        overlay.settings[key] = False
                        overlay.apply_data_options()
                        for widget in widgets:
                            self.assertTrue(widget.isHidden(), (block, section))
                        overlay.settings[key] = True
                        overlay.apply_data_options()
                        for widget in widgets:
                            self.assertFalse(widget.isHidden(), (block, section))
                finally:
                    overlay.destroy()

    def test_hidden_sections_keep_their_place_in_layout(self):
        """Скрытый раздел возвращается на своё место, а не в конец окна."""
        overlay = ExobiologyOverlay(None, {"font_family": "Consolas", "font_size": 10})
        try:
            positions = [overlay.body.indexOf(overlay.planets_header),
                         overlay.body.indexOf(overlay.bodies_header)]
            for section in ("planets", "bodies"):
                overlay.settings[f"overlay_exobio_{section}"] = False
            overlay.apply_data_options()
            self.assertTrue(overlay.planets_header.isHidden())
            self.assertTrue(overlay.bodies_header.isHidden())

            for section in ("planets", "bodies"):
                overlay.settings[f"overlay_exobio_{section}"] = True
            overlay.apply_data_options()
            self.assertEqual([overlay.body.indexOf(overlay.planets_header),
                              overlay.body.indexOf(overlay.bodies_header)], positions)
            self.assertLess(positions[0], positions[1],
                            "«Поиск планет» обязан остаться выше списка тел")
        finally:
            overlay.destroy()

    def test_dynamic_exobio_state_wins_over_old_cache(self):
        """Живое состояние Экзобиологии перебивает устаревшую настройку.

        Подсказка «что делать дальше» появляется только когда её есть что
        показать (`_action_shown`): включение галочки на вкладке «Оверлей»
        не должно вытаскивать на экран пустую строку.
        """
        overlay = ExobiologyOverlay(None, {"font_family": "Consolas", "font_size": 10})
        try:
            overlay._action_shown = True
            overlay.settings["overlay_exobio_action"] = False
            overlay.apply_data_options()
            self.assertTrue(overlay.next_action_label.isHidden(),
                            "галочка «Подсказка» выключена — строку прячем")

            overlay._action_shown = False
            overlay.settings["overlay_exobio_action"] = True
            overlay.apply_data_options()
            self.assertTrue(overlay.next_action_label.isHidden(),
                            "данных для подсказки нет — строка остаётся скрытой")
        finally:
            overlay.destroy()

    def test_manager_updates_existing_window_without_recreation(self):
        manager = object.__new__(OverlayManager)
        manager.settings, manager.save_settings = {}, mock.Mock()
        manager.carrier_overlay = mock.Mock()
        manager.carrier_overlay._last_carrier_data = {'commodities': []}
        manager.set_content_option('carrier', 'items', False)
        manager.carrier_overlay.apply_data_options.assert_called_once()
        manager.set_carrier_filter(mode='missing', query=' Steel ')
        manager.carrier_overlay.update_carrier.assert_called_once_with({'commodities': []})
        self.assertEqual(manager.settings['carrier_search'], 'Steel')
        self.assertFalse(manager.settings['overlay_carrier_items'])

    def test_events_can_be_hidden_and_revealed_without_losing_history(self):
        overlay = SessionEventsOverlay(None, {"font_family": "Consolas", "font_size": 10})
        try:
            overlay.settings.update({"overlay_events_timestamps": False,
                                     "overlay_events_info": False})
            overlay.add_event("hidden", "info")
            self.assertEqual(overlay.text.toPlainText(), "")

            overlay.add_event("visible", "success")
            self.assertEqual(overlay.text.toPlainText(), "visible\n",
                             "без времени и только разрешённые уровни")

            overlay.settings["overlay_events_info"] = True
            overlay.render_events()
            self.assertEqual(overlay.text.toPlainText(), "hidden\nvisible\n",
                             "история не теряется при смене фильтра")

            for index in range(110):
                overlay.add_event(str(index))
            self.assertEqual(len(overlay._events), 100, "журнал не растёт без предела")
        finally:
            overlay.destroy()
