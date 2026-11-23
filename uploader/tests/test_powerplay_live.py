"""Live PowerPlay: incremental IO, visibility lifecycle and shared HUD state.

Controller tests compile the actual methods without importing the Qt application;
Qt rendering/tray checks live in test_powerplay_overlay and test_window_lifecycle.
"""
import ast
import json
import hashlib
import threading
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import powerplay_data as pp
from factions_data import system_key
from i18n import tr

COMMANDER = {"event": "Powerplay", "timestamp": "2026-11-01T10:00:00Z",
             "Power": "Jerome Archer", "Merits": 100, "Rank": 2}
JUMP = {"event": "Location", "timestamp": "2026-11-01T10:01:00Z",
        "StarSystem": "Sol", "SystemAddress": 1, "PowerplayState": "Stronghold"}
MERITS = {"event": "PowerplayMerits", "timestamp": "2026-11-01T10:02:00Z",
          "Power": "Jerome Archer", "MeritsGained": 25, "TotalMerits": 125}
RANK = {"event": "PowerplayRank", "timestamp": "2026-11-01T10:03:00Z",
        "Power": "Jerome Archer", "Rank": 3}


def append(path, *events):
    with path.open('a', encoding='utf-8') as out:
        out.write(''.join(json.dumps(event) + '\n' for event in events))


class IncrementalReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.path = self.directory / 'Journal.2026-11-01T100000.01.log'
        append(self.path, COMMANDER, JUMP)
        self.reader = pp.PowerplayJournalReader()

    def test_bootstrap_then_only_append_no_repeated_scan(self):
        with mock.patch.object(pp, 'scan_journal_for_powerplay', wraps=pp.scan_journal_for_powerplay) as scan:
            self.assertEqual(self.reader.poll(self.directory), [COMMANDER, JUMP])
            self.assertEqual(self.reader.poll(self.directory), [])
            append(self.path, MERITS)
            self.assertEqual(self.reader.poll(self.directory), [MERITS])
            self.assertEqual(self.reader.poll(self.directory), [])
            scan.assert_called_once()

    def test_bootstrap_restores_current_merits_rank_and_latest_location(self):
        latest = dict(JUMP, StarSystem='Lave', timestamp='2026-11-01T10:04:00Z')
        latest.pop('PowerplayState')  # no PP info: must not present Sol as current
        append(self.path, MERITS, RANK, latest)
        self.assertEqual(self.reader.poll(self.directory), [COMMANDER, MERITS, RANK, latest])

    def test_bootstrap_session_precedes_commander_with_same_timestamp(self):
        self.path.write_text('')
        session = {'event': 'LoadGame', 'timestamp': COMMANDER['timestamp']}
        append(self.path, session, COMMANDER, JUMP)
        self.assertEqual(self.reader.poll(self.directory), [session, COMMANDER, JUMP])

    def test_session_boundary_never_recovers_previous_pilot(self):
        session = {'event': 'LoadGame', 'timestamp': '2026-11-02T10:00:00Z'}
        append(self.path, session)
        self.assertEqual(self.reader.poll(self.directory), [session])

    def test_bootstrap_includes_recent_leave_so_previous_pledge_is_not_revived(self):
        leave = {'event': 'PowerplayLeave', 'Power': 'Jerome Archer',
                 'timestamp': '2026-11-01T10:04:00Z'}
        append(self.path, MERITS, leave)
        tracker = pp.PowerplayTracker()
        for event in self.reader.poll(self.directory):
            tracker.handle(event)
        self.assertFalse(tracker.state()['power'])
        self.assertIsNone(tracker.state()['merits'])
        tracker.handle(COMMANDER)  # previous full pledge snapshot remains obsolete
        self.assertFalse(tracker.state()['power'])

    def test_partial_line_is_not_lost(self):
        self.reader.poll(self.directory)
        encoded = json.dumps(MERITS)
        with self.path.open('a') as out:
            out.write(encoded[:20])
        self.assertEqual(self.reader.poll(self.directory), [])
        with self.path.open('a') as out:
            out.write(encoded[20:] + '\n')
        self.assertEqual(self.reader.poll(self.directory), [MERITS])

    def test_rotation_truncation_and_irrelevant_lines(self):
        self.reader.poll(self.directory)
        append(self.path, MERITS)
        newer = self.directory / 'Journal.2026-11-02T100000.01.log'
        append(newer, {'event': 'Scan', 'BodyName': 'Sol'}, RANK)
        self.assertEqual(self.reader.poll(self.directory), [MERITS, RANK])
        newer.write_text(json.dumps(COMMANDER) + '\n')
        self.assertEqual(self.reader.poll(self.directory), [COMMANDER])

    def test_reads_bounded_chunks_and_resumes(self):
        self.reader.poll(self.directory)
        self.reader.CHUNK_BYTES = 200
        append(self.path, *([{'event': 'Scan'}] * 100), MERITS)
        events = []
        for _ in range(20):
            events.extend(self.reader.poll(self.directory))
        self.assertEqual(events, [MERITS])

    def test_irrelevant_rows_are_filtered_before_json_decoding(self):
        self.reader.poll(self.directory)
        append(self.path, *([{'event': 'Scan', 'BodyName': 'Body'}] * 1000))
        with mock.patch.object(pp.json, 'loads', wraps=json.loads) as loads:
            self.assertEqual(self.reader.poll(self.directory), [])
            loads.assert_not_called()

    def test_bootstrap_prefilters_large_scan_history(self):
        append(self.path, *([{'event': 'Scan', 'BodyName': 'Body'}] * 1000))
        with mock.patch.object(pp.json, 'loads', wraps=json.loads) as loads:
            self.reader.poll(self.directory)
            self.assertEqual(loads.call_count, 2)

    def test_directory_change_bootstraps_again(self):
        self.reader.poll(self.directory)
        other = self.directory / 'other'
        other.mkdir()
        append(other / self.path.name, MERITS)
        self.assertEqual(self.reader.poll(other), [MERITS])


class MeritRankTests(unittest.TestCase):
    def test_authoritative_totals_and_rank_update_without_full_snapshot(self):
        tracker = pp.PowerplayTracker()
        tracker.handle(COMMANDER)
        self.assertTrue(tracker.handle(MERITS))
        tracker.handle(MERITS)  # duplicated event must not add MeritsGained twice
        self.assertEqual(tracker.state()['merits'], 125)
        self.assertTrue(tracker.handle(RANK))
        self.assertEqual(tracker.state()['rank'], 3)
        tracker.handle(COMMANDER)  # stale full snapshot cannot roll merit/rank back
        self.assertEqual(tracker.state()['merits'], 125)
        self.assertEqual(tracker.state()['rank'], 3)

    def test_partial_live_update_does_not_block_bootstrap_of_other_fields(self):
        tracker = pp.PowerplayTracker()
        tracker.handle(MERITS)
        tracker.handle(COMMANDER)
        self.assertEqual(tracker.state()['merits'], 125)
        self.assertEqual(tracker.state()['rank'], 2)
        tracker.handle(dict(RANK, timestamp='2026-11-01T10:01:30Z'))
        self.assertEqual(tracker.state()['rank'], 3)
        self.assertEqual(tracker.state()['merits'], 125)

    def test_malformed_and_old_powerplay_events_do_not_change_totals(self):
        tracker = pp.PowerplayTracker()
        tracker.handle(COMMANDER)
        self.assertFalse(tracker.handle(dict(MERITS, TotalMerits=None)))
        self.assertFalse(tracker.handle(dict(MERITS, timestamp='2020-01-01T00:00:00Z')))
        self.assertEqual(tracker.state()['merits'], 100)


def controller_class():
    tree = ast.parse((HERE.parent / 'colonial_helper.py').read_text(encoding='utf-8'))
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'ColonialHelperApp')
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef)
               and (node.name.startswith('_powerplay_') or node.name in (
                   '_refresh_powerplay', '_update_powerplay', '_render_powerplay',
                   '_apply_powerplay_refresh'))]
    env = {'hashlib': hashlib, 'json': json, 'time': time, 'threading': mock.Mock(), 'tr': tr,
           'PowerplayJournalReader': pp.PowerplayJournalReader,
           'powerplay_site_state': pp.site_state, 'system_key': system_key}
    compiled = ast.ClassDef(name='Controller', bases=[], keywords=[], body=methods, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[compiled], type_ignores=[])), '<live-powerplay>', 'exec'), env)
    return env['Controller'], env


class VisibilityControllerTests(unittest.TestCase):
    def setUp(self):
        cls, self.env = controller_class()
        self.app = cls()
        app = self.app
        app.POWERPLAY_POLL_MS, app.POWERPLAY_SITE_TTL = 2000, 30
        app.powerplay = pp.PowerplayTracker()
        app._powerplay_reader = mock.Mock()
        app._powerplay_reader.poll.return_value = []
        app._powerplay_current_system, app._powerplay_current_address = '', 0
        app._powerplay_system_at = app._powerplay_latest_at = app._powerplay_session_at = ''
        app._powerplay_seen = {}
        app._powerplay_lock = threading.RLock()
        app._powerplay_note = ''
        app._powerplay_poll_job = None
        app._powerplay_view_active = False
        app._powerplay_view_epoch = 0
        app._powerplay_request_at, app._powerplay_request_key = 0, ''
        app._powerplay_inflight = False
        app._faction_tracker_system = lambda: ('Sol', 1)
        app.root = mock.Mock()
        app.root.isVisible.return_value = True
        app.root.isMinimized.return_value = False
        app.root.after.side_effect = lambda delay, callback: callback() if delay == 0 else 123
        app.powerplay_panel = mock.Mock()
        app.powerplay_panel.isVisible.return_value = True
        app.powerplay_panel.state.return_value = {}
        app.api = mock.Mock()
        app.api.get_system_powerplay.return_value = {'ok': True, 'powerplay': None}
        app.journal_path = Path('/unused-test-path')

    def worker(self, force=False):
        self.app._powerplay_refresh_worker(force, self.app._powerplay_view_epoch)

    def test_no_work_or_render_on_hidden_tab_or_minimized_main_window(self):
        for hidden, minimized in ((True, False), (False, True)):
            self.app.powerplay_panel.isVisible.return_value = not hidden
            self.app.root.isMinimized.return_value = minimized
            self.app._refresh_powerplay(force=True)
            self.app._render_powerplay()
        self.env['threading'].Thread.assert_not_called()
        self.app.powerplay_panel.set_state.assert_not_called()
        self.app.api.get_system_powerplay.assert_not_called()

    def test_one_poll_timer_is_cancelled_on_tab_exit(self):
        self.app._powerplay_visibility_changed()
        self.assertEqual(self.app._powerplay_poll_job, 123)
        self.app._powerplay_visibility_changed()
        self.assertEqual(self.env['threading'].Thread.call_count, 1)
        self.app.powerplay_panel.isVisible.return_value = False
        self.app._powerplay_visibility_changed()
        self.app.root.after_cancel.assert_called_once_with(123)
        self.assertIsNone(self.app._powerplay_poll_job)
        self.app._powerplay_poll()  # already-queued callback after hide
        self.assertIsNone(self.app._powerplay_poll_job)

    def test_local_poll_independent_of_site_ttl_and_manual_force(self):
        self.worker()
        self.worker()
        self.assertEqual(self.app._powerplay_reader.poll.call_count, 2)
        self.assertEqual(self.app.api.get_system_powerplay.call_count, 1)
        self.worker(force=True)
        self.assertEqual(self.app.api.get_system_powerplay.call_count, 2)

    def test_no_new_network_request_if_view_closed_while_local_read_was_running(self):
        old_reader = self.app._powerplay_reader
        self.app._powerplay_view_epoch = 2
        self.app._powerplay_reader = mock.Mock()
        self.app._powerplay_refresh_worker(False, 1, old_reader)
        old_reader.poll.assert_called_once()
        self.app._powerplay_reader.poll.assert_not_called()
        self.app.api.get_system_powerplay.assert_not_called()

    def test_changed_system_bypasses_site_ttl(self):
        self.worker()
        self.app._powerplay_reader.poll.return_value = [dict(JUMP, StarSystem='Lave', SystemAddress=2)]
        self.worker()
        self.app.api.get_system_powerplay.assert_called_with(2, 'Lave')

    def test_inflight_guard(self):
        self.app._powerplay_inflight = True
        self.app._refresh_powerplay()
        self.env['threading'].Thread.assert_not_called()

    def test_stale_response_after_hide_or_reopen_is_ignored(self):
        self.app._apply_powerplay_refresh({'epoch': -1, 'events': [COMMANDER]})
        self.assertFalse(self.app.powerplay.state()['known'])
        self.app.powerplay_panel.set_state.assert_not_called()
        self.assertFalse(self.app._powerplay_inflight)

    def test_event_burst_updates_model_without_queuing_hidden_widget_renders(self):
        self.app._update_powerplay(COMMANDER)
        self.app._update_powerplay(MERITS)
        self.app._update_powerplay(RANK)
        self.assertEqual(self.app._powerplay_state()['merits'], 125)
        self.assertEqual(self.app._powerplay_state()['rank'], 3)
        self.app.root.after.assert_not_called()
        self.app._render_powerplay()
        self.app.powerplay_panel.set_state.assert_called_once()

    def test_reader_overlap_does_not_duplicate_actions_or_rewind_system(self):
        self.app._update_powerplay(MERITS)
        self.app._update_powerplay(MERITS)
        self.assertEqual(len(self.app._powerplay_state()['actions']), 1)
        self.app._update_powerplay(dict(JUMP, StarSystem='Lave', timestamp='2026-11-02T10:00:00Z'))
        self.app._update_powerplay(JUMP)
        self.assertEqual(self.app._powerplay_current_system, 'Lave')

    def test_pilot_switch_rejects_prior_pilot_data(self):
        self.app._update_powerplay(COMMANDER)
        self.app._update_powerplay({'event': 'LoadGame', 'timestamp': '2026-11-02T10:00:00Z'})
        self.app._update_powerplay(MERITS)
        self.assertFalse(self.app.powerplay.state()['known'])

    def test_unchanged_state_does_not_rebuild_cards(self):
        self.app._update_powerplay(COMMANDER)
        self.app.powerplay_panel.state.return_value = self.app._powerplay_state()
        self.app._render_powerplay()
        self.app.powerplay_panel.set_state.assert_not_called()


class PowerplaySettingsTests(unittest.TestCase):
    def test_standard_settings_and_content_options_are_registered_and_persisted(self):
        from overlay_options import CONTENT_OPTIONS, CONTENT_DEFAULTS
        from overlay_layout import BLOCK_LABELS, DEFAULT_BLOCK_POSITIONS, capture_layout_snapshot, apply_layout_snapshot
        tree = ast.parse((HERE.parent/'overlay.py').read_text(encoding='utf-8'))
        manager = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'OverlayManager')
        blocks_node = next(n.value for n in manager.body if isinstance(n, ast.Assign)
                           and any(isinstance(t, ast.Name) and t.id == 'BLOCKS' for t in n.targets))
        blocks = ast.literal_eval(blocks_node)
        self.assertIn('powerplay', blocks)
        self.assertIn('powerplay', BLOCK_LABELS)
        self.assertIn('powerplay', DEFAULT_BLOCK_POSITIONS)
        self.assertEqual(set(CONTENT_OPTIONS['powerplay']), {'commander','system','actions','source'})
        defaults_node = next(n.value for n in tree.body if isinstance(n, ast.Assign)
                             and any(isinstance(t, ast.Name) and t.id == 'DEFAULT_SETTINGS' for t in n.targets))
        defaults = eval(compile(ast.Expression(body=defaults_node), '<defaults>', 'eval'),
                        {'SETTINGS_SCHEMA_VERSION': 7})
        defaults.update(CONTENT_DEFAULTS)
        self.assertFalse(defaults['show_powerplay'])
        funcs = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                 and n.name in ('save_overlay_settings', 'load_overlay_settings')]
        env = {'Path': Path, 'DEFAULT_SETTINGS': defaults, 'LEGACY_OVERLAY_KEYS': (),
               'DEFAULT_BLOCK_POSITIONS': DEFAULT_BLOCK_POSITIONS, 'BLOCK_OVERRIDE_SUFFIXES': (),
               'migrate_overlay_settings': lambda merged, stored: merged}
        exec(compile(ast.Module(body=funcs, type_ignores=[]), '<persist-settings>', 'exec'), env)
        settings = dict(defaults, powerplay_alpha=0.65, powerplay_font_size=15,
                        powerplay_hotkey='Ctrl+F9', powerplay_locked=True, powerplay_detached=True,
                        powerplay_anchor='top_right', powerplay_auto_rule='game_focused',
                        show_powerplay=True, overlay_powerplay_actions=False)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'config.json'
            env['save_overlay_settings'](path, settings)
            restored = env['load_overlay_settings'](path)
            for key, value in settings.items():
                if 'powerplay' in key:
                    self.assertEqual(restored[key], value, key)
        profile = capture_layout_snapshot(settings, {}, blocks)
        target = {}
        apply_layout_snapshot(target, profile, blocks)
        self.assertEqual(target['powerplay_alpha'], 0.65)
        self.assertEqual(target['powerplay_hotkey'], 'Ctrl+F9')
        self.assertTrue(target['show_powerplay'])

    def test_new_labels_have_translations_for_every_supported_language(self):
        from i18n_catalogs import _STRINGS
        from locale_config import SUPPORTED_LOCALES
        for key in ('Показать Colonial Helper', 'Свернуть в трей', 'Выход',
                    'POWERPLAY — держава и система', 'Получено заслуг: {count}'):
            for locale in SUPPORTED_LOCALES:
                if locale != 'ru':
                    self.assertTrue(_STRINGS[key][locale], (key, locale))


if __name__ == '__main__':
    unittest.main()
