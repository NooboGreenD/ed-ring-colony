"""Operation-count regressions, not timing-sensitive CPU assertions."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from exobiology import ExobiologyTracker, ExobiologyCache


class HistoryPersistenceTests(unittest.TestCase):
    def test_exporting_300_systems_serializes_cache_once_not_301_times(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = ExobiologyCache(Path(folder) / 'cache.json')
            tracker = ExobiologyTracker()
            for number in range(300):
                system = f'System {number}'
                tracker.bodies[f'{system}|Body'] = {'mapped': True, 'bio_signals': 2}
            with mock.patch.object(cache, 'save', wraps=cache.save) as save:
                self.assertEqual(tracker.save_to_cache(cache), 300)
                self.assertEqual(save.call_count, 1)
            restored = ExobiologyCache(cache.path)
            self.assertEqual(len(restored.all_systems()), 300)

    def test_scan_and_restart_commit_bodies_and_file_markers_together(self):
        import json
        from exobiology import scan_all_journals_for_exobio
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = ExobiologyCache(root / 'cache.json')
            tracker = ExobiologyTracker()
            for number in range(30):
                (root / f'Journal.{number:03d}.log').write_text('\n'.join(json.dumps(event) for event in [
                    {'event': 'Location', 'StarSystem': f'System {number}'},
                    {'event': 'Scan', 'BodyName': 'Body', 'PlanetClass': 'Rocky body'},
                ]), encoding='utf-8')
            commit = lambda files: tracker.save_to_cache(cache, indexed_files=files)
            with mock.patch.object(cache, 'save', wraps=cache.save) as save:
                self.assertEqual(scan_all_journals_for_exobio(root, tracker.handle, cache=cache, commit=commit), 60)
                self.assertEqual(save.call_count, 1)
            restored = ExobiologyCache(cache.path)
            self.assertEqual(len(restored.all_systems()), 30)
            self.assertEqual(len(restored._indexed_files), 30)
            with mock.patch('builtins.open', wraps=open) as opened:
                # metadata loaded above; the unchanged journals need no reads
                self.assertEqual(scan_all_journals_for_exobio(root, cache=restored), 0)
                self.assertEqual(opened.call_count, 0)
            import os
            changed = root / 'Journal.000.log'
            previous_mtime = changed.stat().st_mtime
            with changed.open('a') as handle:
                handle.write('\n{"event":"FSSDiscoveryScan","BodyCount":4}\n')
            os.utime(changed, (previous_mtime + 1, previous_mtime + 1))
            count = scan_all_journals_for_exobio(root, tracker.handle, cache=restored,
                commit=lambda files: tracker.save_to_cache(restored, indexed_files=files))
            self.assertEqual(count, 3)
            self.assertEqual(restored.get_system('System 0')['known_body_count'], 4)

    def test_snapshot_is_linear_and_does_not_rescan_every_body_per_system(self):
        with tempfile.TemporaryDirectory() as folder:
            tracker = ExobiologyTracker()
            tracker.bodies = {'A|One': {'mapped': True}, 'B|Two': {'bio_signals': 2}}
            tracker.known_body_counts = {'A': 3, 'B': 4, 'CountOnly': 9}
            tracker.organics = {'A|One': {'Sample': {'samples': 1}}}
            cache = ExobiologyCache(Path(folder) / 'cache.json')
            with mock.patch.object(tracker, 'export_system_data', side_effect=AssertionError('quadratic export')):
                self.assertEqual(tracker.save_to_cache(cache), 3)
            self.assertEqual(cache.get_system('CountOnly')['known_body_count'], 9)
            self.assertEqual(cache.get_system('A')['organics']['One']['Sample']['samples'], 1)

    def test_concurrent_writes_keep_all_systems_and_valid_json(self):
        import concurrent.futures
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = ExobiologyCache(root / 'cache.json')
            def save(number):
                return cache.store_system(f'System {number}', {'Body': {'bio_signals': number}})
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
                self.assertTrue(all(workers.map(save, range(40))))
            self.assertEqual(len(ExobiologyCache(cache.path).all_systems()), 40)
            self.assertEqual(list(root.glob('*.tmp')), [])

    def test_failed_replace_preserves_previous_cache_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = ExobiologyCache(root / 'cache.json')
            cache.store_system('Before', {'Body': {}})
            previous = cache.path.read_bytes()
            tracker = ExobiologyTracker()
            tracker.bodies = {'After|Body': {'mapped': True}}
            with mock.patch.object(Path, 'replace', side_effect=PermissionError('Windows sharing violation')):
                with self.assertRaises(OSError):
                    tracker.save_to_cache(cache, indexed_files={'Journal.1.log': 42})
            self.assertEqual(cache.path.read_bytes(), previous)
            self.assertEqual(list(root.glob('*.tmp')), [])
            disk = ExobiologyCache(cache.path)
            self.assertFalse(disk.is_file_indexed('Journal.1.log', 42))
            self.assertTrue(cache.save())  # same-process retry retains staged data

    def test_simultaneous_history_scan_does_not_start_another_pass(self):
        import threading
        from exobiology import scan_all_journals_for_exobio
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'Journal.1.log').write_text('{"event":"Location","StarSystem":"A"}\n')
            cache = ExobiologyCache(root / 'cache.json')
            entered, release = threading.Event(), threading.Event()
            calls = []
            def hook(event):
                calls.append(event)
                entered.set()
                self.assertTrue(release.wait(3))
            worker = threading.Thread(target=lambda: scan_all_journals_for_exobio(root, hook, cache=cache))
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                self.assertEqual(scan_all_journals_for_exobio(root, hook, cache=cache), 0)
            finally:
                release.set()
                worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(len(calls), 1)

    def test_cancelled_file_is_not_marked_fully_indexed(self):
        from exobiology import scan_all_journals_for_exobio
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'Journal.1.log'
            path.write_text('{"event":"Location","StarSystem":"A"}\n' * 600)
            cache = ExobiologyCache(root / 'cache.json')
            seen = []
            count = scan_all_journals_for_exobio(root, seen.append, cache=cache,
                should_stop=lambda: len(seen) >= 256)
            self.assertEqual(count, 256)
            self.assertFalse(cache.is_file_indexed(path.name, path.stat().st_mtime))
