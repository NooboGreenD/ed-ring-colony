"""Actual Helper methods, synthetic journals, no Qt/network/personal files."""
import ast
import json
import errno
import os
from typing import Optional
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from journal_parser import iter_journal_events, parse_events, ConstructionSnapshotCollector
from i18n import tr


def helper_class():
    tree = ast.parse((Path(__file__).resolve().parents[1] / 'colonial_helper.py').read_text(encoding='utf-8'))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'ColonialHelperApp')
    names = {'_process_journal_changes', '_poll_journal_files', '_start_watcher', '_watcher_thread_main',
             '_watcher_finished', '_watcher_loop', '_load_journal_offsets', '_save_journal_offsets', '_upload_target', '_start_exobio_history_indexer', '_scan_all_journals_for_exobio'}
    body = [n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name in names]
    env = dict(Path=Path, json=json, threading=threading, time=time, tr=tr,
               parse_events=parse_events, iter_journal_events=iter_journal_events,
               community_goal_reports_from_event=lambda ev: [], _JOURNAL_OFFSETS_LOCK=threading.RLock(),
               COLOR_ORANGE='orange', COLOR_GREEN='green', ConstructionSnapshotCollector=ConstructionSnapshotCollector,
               CommunityGoalReportCollector=mock.Mock, tempfile=tempfile, errno=errno, os=os, Optional=Optional)
    # The new helpers are optional here so these regression tests can also run
    # against the pre-fix source and demonstrate the original failures.
    try:
        from journal_reader import complete_journal_prefix, journal_files
        env.update(complete_journal_prefix=complete_journal_prefix, journal_files=journal_files)
    except ImportError:
        pass
    atomic = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_atomic_write_journal_offsets')
    exec(compile(ast.fix_missing_locations(ast.Module(body=[atomic], type_ignores=[])), '<real-helper-atomic>', 'exec'), env)
    node = ast.ClassDef(name='App', bases=[], keywords=[], body=body, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<real-helper>', 'exec'), env)
    return env['App']


class JournalRestartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.App = helper_class()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.path = self.folder / 'Journal.2026-11-01T100000.01.log'
        app = self.app = self.App()
        app.journal_path = self.folder
        app.root = SimpleNamespace(after=lambda delay, callback: callback())
        app.log = mock.Mock()
        app.ship = SimpleNamespace(state=None)
        app.dispatcher = mock.Mock()
        app._handle_tracked_event = mock.Mock()
        app.exobiology = mock.Mock()
        app._construction_collector = ConstructionSnapshotCollector()
        app._community_goal_collector = mock.Mock()
        app._community_goal_collector.drain.return_value = []
        app._watcher_cmdr_name = 'Pilot'
        app._sync_inara_commander = mock.Mock()
        app._last_cargo, app._last_depot_state, app._last_contribution_state, app._seen_events = {}, {}, {}, set()
        app._record_session_deliveries = mock.Mock()
        app._defer_uploads = True
        app._backfill_deliveries, app._backfill_construction, app._backfill_community_goal_reports = [], [], []
        app.last_file_mtimes = {}
        app._save_journal_offsets = mock.Mock()
        app.watcher_stop_event = threading.Event()
        app.api = SimpleNamespace(is_connected=True, cmdr_name="Pilot", site_url="https://site.test", user_id="user-a")
        app.watcher_thread = None
        app.watcher_active = False

    def read(self, start=0, live=False):
        return self.app._process_journal_changes(self.path, start, self.path.stat().st_size, live=live)

    def test_complete_json_record_without_final_newline_is_processed_once(self):
        self.path.write_text('{"event":"Commander","Name":"Pilot"}\n{"event":"Location","StarSystem":"Sol"}', encoding='utf-8')
        self.assertEqual(self.read(), self.path.stat().st_size)
        self.assertEqual(self.app._handle_tracked_event.call_count, 2)

    def test_unchanged_partial_tail_is_not_read_on_every_tick_but_growth_is(self):
        self.path.write_bytes(b'{"event":"Location","StarSystem":"So')
        self.assertEqual(self.read(), 0)
        with mock.patch('builtins.open', wraps=open) as opened:
            self.assertEqual(self.read(), 0)
            self.assertEqual(opened.call_count, 0)
        with self.path.open('ab') as handle:
            handle.write(b'l"}\n')
        self.assertEqual(self.read(), self.path.stat().st_size)
        self.assertEqual(self.app._handle_tracked_event.call_count, 1)

    def test_stop_start_cannot_revive_an_old_watcher(self):
        old = self.app.watcher_thread = mock.Mock()
        old.is_alive.return_value = True
        self.app.watcher_stop_event.set()
        self.app._session_systems_visited = set()
        self.app._session_tons_by_system = {}
        self.app._colony_announced_sites = set()
        for name in ('construction', 'carrier', 'upload_page', 'overlay_manager', 'set_status', '_start_exobio_history_indexer'):
            setattr(self.app, name, mock.Mock())
        with mock.patch('threading.Thread'):
            self.app._start_watcher()
        self.assertTrue(self.app.watcher_stop_event.is_set())
        self.assertIs(self.app.watcher_thread, old)
        self.assertFalse(self.app.watcher_active)

    def test_thirty_already_processed_files_stay_idle_across_restart(self):
        for number in range(30):
            (self.folder / f'Journal.{number:03d}.log').write_text('{"event":"Location","StarSystem":"Sol"}')
        self.app._poll_journal_files()
        self.assertEqual(self.app._save_journal_offsets.call_count, 1)
        offsets = dict(self.app.last_file_mtimes)
        self.app._handle_tracked_event.reset_mock()
        self.app._save_journal_offsets.reset_mock()
        self.app._load_journal_offsets = lambda: offsets
        self.app._carrier_sync_collector = mock.Mock()
        self.app._carrier_sync_collector.return_value.begin_live.side_effect = self.app.watcher_stop_event.set
        self.app._watcher_loop()
        self.app._handle_tracked_event.assert_not_called()
        self.app._save_journal_offsets.assert_not_called()
        self.assertEqual(self.app.last_file_mtimes, offsets)

    def test_polling_partial_files_never_writes_zero_progress_checkpoints(self):
        self.path.write_bytes(b'{"event":"Location","StarSystem":"So')
        self.app._poll_journal_files()
        with mock.patch('builtins.open', wraps=open) as opened:
            for _ in range(20):
                self.app._poll_journal_files()
            self.assertEqual(opened.call_count, 0)
        self.app._save_journal_offsets.assert_not_called()
        self.assertEqual(self.app.last_file_mtimes, {})

    def test_transient_read_error_is_retryable_even_without_file_growth(self):
        self.path.write_bytes(b'{"event":"Location","StarSystem":"Sol"}\n')
        with mock.patch('builtins.open', side_effect=PermissionError('busy')):
            self.assertEqual(self.read(), 0)
        self.assertEqual(self.read(), self.path.stat().st_size)
        self.assertEqual(self.app._handle_tracked_event.call_count, 1)

    def test_partial_utf8_and_json_are_not_acknowledged(self):
        prefix = b'{"event":"Location","StarSystem":"Sol"}\n'
        tail = '{"event":"Music","MusicTrack":"П'.encode('utf-8')[:-1]
        self.path.write_bytes(prefix + tail)
        processed = self.read()
        self.assertEqual(processed, len(prefix))
        self.assertEqual(self.read(processed), 0)
        with self.path.open('ab') as handle:
            handle.write('П'.encode('utf-8')[-1:] + b'"}')
        self.assertEqual(self.read(processed), self.path.stat().st_size - processed)
        self.assertEqual(self.app._handle_tracked_event.call_count, 2)

    def test_same_size_tail_rewrite_with_new_mtime_is_retried(self):
        import os
        self.path.write_bytes(b'{"event":"Location" ')
        self.assertEqual(self.read(), 0)
        stamp = self.path.stat().st_mtime_ns
        self.path.write_bytes(b'{"event":"Location"}')
        os.utime(self.path, ns=(stamp + 1000000, stamp + 1000000))
        self.assertEqual(self.read(), self.path.stat().st_size)

    def test_late_old_worker_completion_cannot_stop_new_watcher(self):
        old = object()
        self.app.watcher_thread = object()
        self.app.watcher_active = True
        self.app._watcher_finished(old)
        self.assertTrue(self.app.watcher_active)
        self.assertFalse(self.app.watcher_stop_event.is_set())

    def test_worker_exception_releases_running_state(self):
        self.app.watcher_thread = threading.current_thread()
        self.app.watcher_active = True
        self.app._prepare_watcher_state = mock.Mock()
        self.app._watcher_loop = mock.Mock(side_effect=RuntimeError('synthetic read failure'))
        self.app.upload_page = mock.Mock()
        self.app.set_status = mock.Mock()
        self.app._watcher_thread_main()
        self.assertFalse(self.app.watcher_active)
        self.assertTrue(self.app.watcher_stop_event.is_set())
        self.app.upload_page.set_watcher_running.assert_called_once_with(False)

    def test_stop_during_preparation_does_not_enter_history_reconciliation(self):
        self.app.watcher_thread = threading.current_thread()
        self.app._prepare_watcher_state = self.app.watcher_stop_event.set
        self.app._watcher_loop = mock.Mock()
        self.app.upload_page = mock.Mock()
        self.app.set_status = mock.Mock()
        self.app._watcher_thread_main()
        self.app._watcher_loop.assert_not_called()

    def test_auto_and_manual_index_requests_share_one_background_worker(self):
        from exobiology import ExobiologyCache, ExobiologyTracker
        self.app.exobio_cache = ExobiologyCache(self.folder / 'exobio.json')
        self.app.exobiology = ExobiologyTracker()
        self.app._set_exobio_status = mock.Mock()
        self.app._update_tab_exobio = mock.Mock()
        self.app.overlay_manager = mock.Mock()
        self.path.write_text('{"event":"Location","StarSystem":"Sol"}\n')
        jobs = []
        def thread(**kwargs):
            jobs.append(kwargs['target'])
            return mock.Mock()
        with mock.patch('threading.Thread', side_effect=thread):
            self.app._start_exobio_history_indexer()
            self.app._start_exobio_history_indexer()
            self.app._scan_all_journals_for_exobio()
        self.assertEqual(len(jobs), 1)
        main = threading.current_thread()
        writers = []
        original_save = self.app.exobio_cache.save
        def save():
            writers.append(threading.current_thread())
            return original_save()
        with mock.patch.object(self.app.exobio_cache, 'save', side_effect=save):
            worker = threading.Thread(target=jobs[0])
            worker.start()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertFalse(self.app._exobio_full_scanning)
        self.assertEqual(writers, [worker])
        self.assertIsNot(writers[0], main)


    def test_real_checkpoint_round_trip_and_temp_cleanup_recovery(self):
        self.app.data_dir = self.folder
        self.app.temp_dir = self.folder / 'Temp'
        self.app.last_file_mtimes = {'journal.log': 42}
        self.App._save_journal_offsets(self.app)
        self.assertEqual(self.app._load_journal_offsets(), {'journal.log': 42})
        self.app.temp_dir.rmdir()  # a cleaner removed the empty temp directory
        self.app.last_file_mtimes['journal.log'] = 99
        self.App._save_journal_offsets(self.app)
        self.assertEqual(self.app._load_journal_offsets(), {'journal.log': 99})
        self.assertEqual(list(self.app.temp_dir.iterdir()), [])
        self.app.api.user_id = 'user-b'
        self.assertEqual(self.app._load_journal_offsets(), {})
        self.assertNotIn('user-a', self.app.log.call_args.args[0])

    def test_corrupt_checkpoint_diagnostic_does_not_print_its_contents(self):
        self.app.data_dir = self.folder
        (self.folder / '.colonial_helper_journal_offsets.json').write_text('{bad private content')
        self.assertEqual(self.app._load_journal_offsets(), {})
        message = self.app.log.call_args.args[0]
        self.assertIn('JSONDecodeError', message)
        self.assertNotIn('private content', message)



if __name__ == '__main__':
    unittest.main()
