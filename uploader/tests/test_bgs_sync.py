"""Минорные фракции: отбор состояния систем из журнала и отправка на сайт.

Проверяется:

* проекция событий (bgs_sync.project_bgs_event) совпадает с эталоном
  scripts/tests/fixtures/bgs-journal.expected.json — тем же, с которым тест
  сайта (scripts/tests/factions-lib.test.mjs) сверяет `projectBgsEvent` из
  src/lib/bgsJournal.ts. Так Helper и загрузчик журналов на сайте шлют одно и
  то же: личного (репутация, фракция эскадрильи) нет, SystemAddress — строкой
  без потери разрядов, старый формат `SystemFaction` строкой сохраняется;
* сборщик держит одну (самую свежую) запись на систему, не шлёт повторно то же
  состояние, переживает перезапуск (outbox на диске);
* отправка: удаляет из очереди только отправленное, неудачная пачка остаётся.
"""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import bgs_sync  # noqa: E402
from bgs_sync import BgsSnapshotCollector, project_bgs_event  # noqa: E402

FIXTURES = HERE.parent.parent / "scripts" / "tests" / "fixtures"


def journal_events():
    lines = (FIXTURES / "bgs-journal.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def jump(system, address, timestamp, influence=0.5, name="Faction A"):
    return {
        "timestamp": timestamp, "event": "FSDJump", "StarSystem": system, "SystemAddress": address,
        "StarPos": [1.0, 2.0, 3.0], "SystemAllegiance": "Independent",
        "SystemFaction": {"Name": name, "FactionState": "None"},
        "Factions": [{"Name": name, "Influence": influence, "FactionState": "None", "MyReputation": 50.0}],
    }


class FakeApi:
    def __init__(self, ok=True):
        self.ok = ok
        self.is_connected = True
        self.batches = []

    def sync_bgs_snapshots(self, events):
        self.batches.append([dict(event) for event in events])
        if not self.ok:
            return {"ok": False, "error": "HTTP 503"}
        return {"ok": True, "applied": len(events), "stale": 0, "created": 1,
                "systems": [event["StarSystem"] for event in events]}


class ProjectionTests(unittest.TestCase):
    def test_projection_matches_site_fixture(self):
        expected = json.loads((FIXTURES / "bgs-journal.expected.json").read_text(encoding="utf-8"))
        actual = [project_bgs_event(event) for event in journal_events()]
        self.assertEqual(actual, expected)

    def test_no_personal_or_localised_fields(self):
        projected = project_bgs_event(journal_events()[0])
        text = json.dumps(projected, ensure_ascii=False)
        for key in ("MyReputation", "SquadronFaction", "HomeSystem", "HappiestSystem", "_Localised", "Powers", "JumpDist", "Conflicts"):
            self.assertNotIn(key, text)

    def test_big_system_address_is_exact_string(self):
        projected = project_bgs_event(journal_events()[0])
        self.assertEqual(projected["SystemAddress"], "36028797018963971")

    def test_field_lists_match_site(self):
        source = (HERE.parent.parent / "src" / "lib" / "bgsJournal.ts").read_text(encoding="utf-8")
        for name in bgs_sync.BGS_SYSTEM_FIELDS + bgs_sync.BGS_FACTION_FIELDS:
            self.assertIn(f"'{name}'", source, f"{name} нет в src/lib/bgsJournal.ts")
        for name in bgs_sync.BGS_EVENTS:
            self.assertIn(f"'{name}'", source)


class CollectorTests(unittest.TestCase):
    def test_keeps_newest_per_system(self):
        collector = BgsSnapshotCollector()
        self.assertTrue(collector.feed(jump("Sol", 10477373803, "2026-10-17T10:00:00Z", 0.4)))
        self.assertTrue(collector.feed(jump("Sol", 10477373803, "2026-10-17T12:00:00Z", 0.6)))
        self.assertFalse(collector.feed(jump("Sol", 10477373803, "2026-10-17T11:00:00Z", 0.5)), "старое не вытесняет свежее")
        self.assertTrue(collector.feed(jump("Lave", 3932277478106, "2026-10-17T11:30:00Z")))
        self.assertEqual(collector.pending_count, 2)
        sol = collector.pending["10477373803"]
        self.assertEqual(sol["Factions"][0]["Influence"], 0.6)

    def test_ignores_unpopulated_and_other_events(self):
        collector = BgsSnapshotCollector()
        for event in journal_events()[3:]:
            self.assertFalse(collector.feed(event))
        self.assertFalse(collector.feed({"event": "FSDJump"}))
        self.assertFalse(collector.feed("garbage"))
        self.assertEqual(collector.pending_count, 0)

    def test_flush_sends_and_skips_identical_resend(self):
        collector = BgsSnapshotCollector()
        api = FakeApi()
        collector.feed(jump("Sol", 10477373803, "2026-10-17T10:00:00Z"), live=True)
        result = collector.flush(api)
        self.assertTrue(result["ok"])
        self.assertEqual(result["sent"], 1)
        self.assertEqual(result["applied"], 1)
        self.assertEqual(result["systems"], ["Sol"])
        self.assertEqual(collector.pending_count, 0)
        self.assertEqual(api.batches[0][0]["SystemAddress"], "10477373803")
        # Через пять минут то же состояние той же системы повторно не шлём…
        self.assertFalse(collector.feed(jump("Sol", 10477373803, "2026-10-17T10:05:00Z"), live=True))
        # …а изменившееся — шлём.
        self.assertTrue(collector.feed(jump("Sol", 10477373803, "2026-10-17T10:06:00Z", 0.7), live=True))
        # Через час и то же состояние уходит снова (отметка свежести).
        collector._sent["10477373803"] = (collector._sent["10477373803"][0], time.monotonic() - bgs_sync.RESEND_AFTER_SECONDS - 1)
        collector.pending.clear()
        self.assertTrue(collector.feed(jump("Sol", 10477373803, "2026-10-17T11:30:00Z", 0.7), live=True))

    def test_failed_flush_keeps_queue_and_outbox_survives_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            outbox = Path(tmp) / ".bgs_snapshots_outbox.json"
            collector = BgsSnapshotCollector(outbox)
            collector.feed(jump("Sol", 10477373803, "2026-10-17T10:00:00Z"))
            collector.feed(jump("Lave", 3932277478106, "2026-10-17T10:10:00Z"))
            result = collector.flush(FakeApi(ok=False))
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "HTTP 503")
            self.assertEqual(collector.pending_count, 2)
            collector.save()
            restored = BgsSnapshotCollector(outbox)
            self.assertEqual(restored.pending_count, 2)
            api = FakeApi()
            self.assertTrue(restored.flush(api)["ok"])
            self.assertEqual(restored.pending_count, 0)
            restored.save()
            self.assertEqual(json.loads(outbox.read_text(encoding="utf-8")), [])

    def test_flush_in_batches_and_not_connected(self):
        collector = BgsSnapshotCollector()
        for index in range(bgs_sync.BATCH_SIZE + 5):
            collector.feed(jump(f"System {index}", 1000 + index, "2026-10-17T10:00:00Z"))
        offline = FakeApi()
        offline.is_connected = False
        self.assertFalse(collector.flush(offline)["ok"])
        api = FakeApi()
        result = collector.flush(api, max_batches=1)
        self.assertEqual(result["sent"], bgs_sync.BATCH_SIZE)
        self.assertEqual(collector.pending_count, 5)
        collector.flush(api)
        self.assertEqual(collector.pending_count, 0)
        self.assertEqual([len(batch) for batch in api.batches], [bgs_sync.BATCH_SIZE, 5])


if __name__ == "__main__":
    unittest.main()
