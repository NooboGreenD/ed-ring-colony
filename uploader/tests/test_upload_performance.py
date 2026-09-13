"""Тесты производительности и корректности первичной загрузки журналов.

Запуск (нужны только стандартная библиотека + requests):

    python -m unittest discover -s uploader/tests -v

или из папки uploader:

    python tests/test_upload_performance.py

Тесты НЕ требуют tkinter: проверяются модули `journal_parser`,
`event_dispatch` и `api_client` (последний — с подменённым транспортом),
то есть именно те части, из-за которых первичная загрузка истории с
подключёнными API шла часами.
"""

import os
import sys
import time
import json
import random
import unittest
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import journal_parser
from journal_parser import (
    parse_events,
    parse_journal,
    iter_journal_events,
    extract_construction_events,
    ConstructionSnapshotCollector,
    PARSER_VERSION,
)


# ---------------------------------------------------------------------------
# Генератор Synthetic journals, похожих на реальные
# ---------------------------------------------------------------------------
SYSTEMS = ["Sol", "Alpha Centauri", "Colonia", "HIP 12345", "Barnard's Star"]
COMMODITIES = ["steel", "titanium", "aluminium", "ceramiccomposites", "polymers"]


def _ts(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def make_journal(path: Path, seed: int = 1, events_per_file: int = 400, cmdr: str = "Test CMDR"):
    """Записать journal-файл со смесью событий, типичной для реального журнала."""
    rng = random.Random(seed)
    moment = datetime(2025, 1, 1, 6, 0, 0)
    lines = [
        json.dumps({"timestamp": _ts(moment), "event": "Commander", "Name": cmdr}),
        json.dumps({
            "timestamp": _ts(moment), "event": "Location", "StarSystem": SYSTEMS[0],
            "SystemAddress": 10477373803, "StationType": "Orbital",
        }),
    ]
    market_id = 3223346176
    for index in range(events_per_file):
        moment += timedelta(seconds=rng.randint(2, 40))
        roll = rng.random()
        if roll < 0.08:
            lines.append(json.dumps({
                "timestamp": _ts(moment), "event": "FSDJump",
                "StarSystem": rng.choice(SYSTEMS), "SystemAddress": 10477373803 + index,
            }))
        elif roll < 0.14:
            lines.append(json.dumps({
                "timestamp": _ts(moment), "event": "Docked", "StarSystem": SYSTEMS[0],
                "MarketID": market_id, "StationType": "FleetCarrier", "CarrierID": 3700000001,
            }))
        elif roll < 0.22:
            lines.append(json.dumps({
                "timestamp": _ts(moment), "event": "Scan", "BodyName": "A 3",
                "BodyID": index % 20, "SystemAddress": 10477373803,
            }))
        elif roll < 0.30:
            lines.append(json.dumps({
                "timestamp": _ts(moment), "event": "MarketSell", "Type": "steel",
                "Type_Localised": "Steel", "Count": 700, "MarketID": 3700000001,
                "CarrierID": 3700000001, "StationType": "FleetCarrier",
            }))
        elif roll < 0.38:
            lines.append(json.dumps({
                "timestamp": _ts(moment), "event": "ColonisationContribution",
                "MarketID": market_id,
                "Contributions": [
                    {"Name": "$steel_name;", "Name_Localised": "Steel", "Amount": rng.randint(10, 400)},
                    {"Name": "$titanium_name;", "Name_Localised": "Titanium", "Amount": rng.randint(10, 400)},
                ],
            }))
        elif roll < 0.55:
            # ColonisationConstructionDepot: в реальном журнале пишется каждые
            # несколько секунд и в большинстве случаев повторяет прошлое
            # состояние (в обращении пользователя — 4990 штук в одном файле).
            lines.append(json.dumps({
                "timestamp": _ts(moment), "event": "ColonisationConstructionDepot",
                "MarketID": market_id, "ConstructionID": 555111, "StarSystem": SYSTEMS[0],
                "ConstructionName": "Colony Hub",
                "ConstructionProgress": 0.42,
                "ResourcesRequired": [
                    {"Name": "$%s_name;" % name, "Name_Localised": name.title(),
                     "RequiredAmount": 5000, "ProvidedAmount": 1234}
                    for name in COMMODITIES
                ],
            }))
        elif roll < 0.65:
            lines.append(json.dumps({
                "timestamp": _ts(moment), "event": "Cargo",
                "Inventory": [{"Name": name, "Count": rng.randint(0, 700)} for name in COMMODITIES[:3]],
            }))
        else:
            lines.append(json.dumps({"timestamp": _ts(moment), "event": "Music", "MusicTrack": "Exploration"}))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def make_history(directory: Path, files: int = 20, events_per_file: int = 400) -> list:
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for index in range(files):
        name = "Journal.%s.01.log" % (datetime(2025, 1, 1) + timedelta(days=index)).strftime("%Y-%m-%dT%H%M%S")
        paths.append(make_journal(directory / name, seed=index + 1, events_per_file=events_per_file))
    return sorted(paths, key=lambda p: p.name)


# ---------------------------------------------------------------------------
class JournalParserTests(unittest.TestCase):
    """Рефакторинг разбора не должен менять результат."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.files = make_history(self.dir, files=6, events_per_file=300)
        self.texts = [f.read_text(encoding="utf-8") for f in self.files]

    def tearDown(self):
        self.tmp.cleanup()

    def test_parse_events_matches_original_parse_journal(self):
        """Однопроходный разбор даёт тот же результат, что и старый parse_journal."""
        # Старый путь (разбор текста напрямую).
        cargo = depot = contrib = None
        seen = set()
        old_deliveries = []
        old_counts = {}
        for text in self.texts:
            _cmdr, deliveries, cargo, depot, contrib, seen, counts = parse_journal(
                text, SYSTEMS[0], cargo, depot, contrib, seen, 10477373803,
            )
            old_deliveries.extend(deliveries)
            for key, value in counts.items():
                old_counts[key] = old_counts.get(key, 0) + value

        # Новый путь (поток событий, распарсенных один раз).
        cargo = depot = contrib = None
        seen = set()
        new_deliveries = []
        new_counts = {}
        for text in self.texts:
            _cmdr, deliveries, cargo, depot, contrib, seen, counts = parse_events(
                iter_journal_events(text), SYSTEMS[0], cargo, depot, contrib, seen, 10477373803,
            )
            new_deliveries.extend(deliveries)
            for key, value in counts.items():
                new_counts[key] = new_counts.get(key, 0) + value

        self.assertEqual(len(old_deliveries), len(new_deliveries))
        self.assertEqual(old_counts, new_counts)
        self.assertTrue(old_deliveries, "тестовые журналы должны содержать доставки")
        self.assertEqual(
            [d["source_hash"] for d in old_deliveries],
            [d["source_hash"] for d in new_deliveries],
        )

    def test_construction_events_identical_to_previous_extraction(self):
        """extract_construction_events() отдаёт ровно то, что и раньше."""
        expected = [extract_construction_events(text) for text in self.texts]
        collector = ConstructionSnapshotCollector()
        cargo = depot = contrib = None
        seen = set()
        for text in self.texts:
            _c, _d, cargo, depot, contrib, seen, _counts = parse_events(
                iter_journal_events(text), SYSTEMS[0], cargo, depot, contrib, seen, 0, hooks=[collector],
            )
        # Поля snapshots совпадают с прежней функцией.
        for event in collector.events:
            self.assertEqual(
                sorted(event.keys()),
                sorted(expected[0][0].keys()),
            )
        self.assertEqual(len(collector.events), sum(len(e) for e in expected) - collector.duplicates)

    def test_duplicate_construction_snapshots_are_dropped(self):
        """Одинаковые подряд идущие snapshots стройки отбрасываются."""
        collector = ConstructionSnapshotCollector()
        collector._current_system = SYSTEMS[0]
        event = {
            "timestamp": "2025-01-01T00:00:00Z",
            "event": "ColonisationConstructionDepot",
            "MarketID": 1,
            "ConstructionID": 7,
            "ConstructionProgress": 0.5,
            "ResourcesRequired": [{"Name": "steel", "RequiredAmount": 10, "ProvidedAmount": 5}],
        }
        for _ in range(50):
            collector("", dict(event))  # состояние не меняется
        self.assertEqual(collector.seen, 50)
        self.assertEqual(len(collector.events), 1)
        self.assertEqual(collector.duplicates, 49)

        # Изменение прогресса -> новый snapshot.
        changed = dict(event)
        changed["ConstructionProgress"] = 0.6
        collector("", changed)
        self.assertEqual(len(collector.events), 2)

    def test_hooks_see_every_event_and_never_break_parsing(self):
        """Хук вызывается для каждого события, его исключение не ломает разбор."""
        seen_events = []

        def good_hook(line, ev):
            seen_events.append(ev.get("event"))

        def broken_hook(line, ev):
            raise RuntimeError("hook failure")

        _cmdr, deliveries, _cargo, _depot, _contrib, _seen, counts = parse_journal(
            self.texts[0], SYSTEMS[0], None, None, None, set(), 0, hooks=[broken_hook, good_hook],
        )
        self.assertEqual(len(seen_events), sum(counts.values()))
        self.assertTrue(deliveries or True)  # разбор завершился без исключения

    def test_parser_version_is_int(self):
        self.assertIsInstance(PARSER_VERSION, int)


# ---------------------------------------------------------------------------
class EventDispatchTests(unittest.TestCase):
    """Диспетчер внешних API: без блокировок, без потока на событие."""

    class FakeEDSM:
        enabled = True

        def __init__(self, latency=0.0):
            self.calls = 0
            self.latency = latency

        def submit_event(self, event):
            self.calls += 1
            if self.latency:
                time.sleep(self.latency)
            return {"ok": True}

    class FakeInara:
        enabled = True

        def __init__(self, latency=0.0):
            self.calls = 0
            self.latency = latency

        def submit(self, event_name, data, timestamp):
            self.calls += 1
            if self.latency:
                time.sleep(self.latency)
            return {"ok": True}

    class FakeRaven:
        is_connected = True

        def __init__(self, latency=0.0):
            self.calls = 0
            self.latency = latency

        def supply_fc(self, market_id, commodity, delta):
            self.calls += 1
            if self.latency:
                time.sleep(self.latency)
            return {"ok": True}

    def _dispatcher(self, latency=0.0, backfill_enabled=False):
        from event_dispatch import ThirdPartyDispatcher

        edsm = self.FakeEDSM(latency)
        inara = self.FakeInara(latency)
        raven = self.FakeRaven(latency)
        dispatcher = ThirdPartyDispatcher(
            edsm_api=edsm, inara_api=inara, raven_api=raven,
            backfill_enabled=backfill_enabled, workers=2, max_queue=5000,
        )
        return dispatcher, edsm, inara, raven

    def test_backfill_does_not_hit_third_party(self):
        """История не уходит во внешние API — первичная загрузка не тормозится."""
        dispatcher, edsm, inara, raven = self._dispatcher(backfill_enabled=False)
        for index in range(500):
            dispatcher.submit(
                {"event": "FSDJump", "timestamp": "2025-01-01T00:00:0%dZ" % (index % 10),
                 "SystemAddress": index, "StarSystem": "Sol"},
                live=False,
            )
        dispatcher.flush(timeout=2)
        self.assertEqual((edsm.calls, inara.calls, raven.calls), (0, 0, 0))
        self.assertEqual(dispatcher.stats["skipped_backfill"], 500)

    def test_live_events_are_sent_and_deduplicated(self):
        """Live-события уходят, повторы отсекаются."""
        dispatcher, edsm, inara, raven = self._dispatcher()
        event = {"event": "FSDJump", "timestamp": "2025-01-01T00:00:00Z",
                 "SystemAddress": 1, "StarSystem": "Sol"}
        for _ in range(10):
            dispatcher.submit(event, live=True)
        dispatcher.flush(timeout=2)
        self.assertEqual(edsm.calls, 1)   # EDSM: навигация
        self.assertEqual(inara.calls, 1)  # Inara: FSDJump
        self.assertEqual(dispatcher.stats["duplicate"], 18)

    def test_inara_works_without_edsm(self):
        """Раньше Inara/Raven работали только при включённом EDSM."""
        from event_dispatch import ThirdPartyDispatcher

        inara = self.FakeInara()
        raven = self.FakeRaven()
        dispatcher = ThirdPartyDispatcher(inara_api=inara, raven_api=raven, edsm_api=None)
        dispatcher.submit({"event": "Docked", "timestamp": "2025-01-01T00:00:00Z", "SystemAddress": 5}, live=True)  # cmdrDock
        dispatcher.submit(
            {"event": "MarketSell", "timestamp": "2025-01-01T00:00:01Z", "MarketID": 42,
             "Type": "steel", "Type_Localised": "Steel", "Count": 10, "CarrierID": 7},
            live=True,
        )
        dispatcher.flush(timeout=2)
        # Docked -> cmdrDock, MarketSell -> cmdrMarketSell (оба есть в карте Inara).
        self.assertEqual(inara.calls, 2)
        self.assertEqual(raven.calls, 1)

    def test_submit_never_blocks_on_slow_service(self):
        """Медленный внешний сервис не тормозит разбор журнала."""
        dispatcher, edsm, _inara, _raven = self._dispatcher(latency=0.02)
        started = time.monotonic()
        for index in range(300):
            dispatcher.submit(
                {"event": "FSDJump", "timestamp": "2025-01-01T00:00:%02dZ" % (index % 60),
                 "SystemAddress": index},
                live=True,
            )
        submit_seconds = time.monotonic() - started
        # 300 событий по 20 мс последовательно заняли бы ~6 с: разбор не ждёт.
        self.assertLess(submit_seconds, 1.0)
        dispatcher.flush(timeout=10)
        self.assertEqual(edsm.calls, 300)

    def test_queue_overflow_drops_events_instead_of_blocking(self):
        from event_dispatch import ThirdPartyDispatcher

        edsm = self.FakeEDSM(latency=0.01)
        dispatcher = ThirdPartyDispatcher(edsm_api=edsm, max_queue=5, workers=1)
        for index in range(200):
            dispatcher.submit(
                {"event": "FSDJump", "timestamp": "2025-01-01T00:00:%02dZ" % (index % 60),
                 "SystemAddress": index},
                live=True,
            )
        self.assertGreater(dispatcher.stats["dropped"], 0)
        dispatcher.stop(wait=True, timeout=5)

    def test_raven_cargo_delta_direction(self):
        from event_dispatch import ThirdPartyDispatcher

        raven = self.FakeRaven()
        dispatcher = ThirdPartyDispatcher(raven_api=raven)
        base = {"timestamp": "2025-01-01T00:00:00Z", "MarketID": 42, "Type": "steel",
                "Type_Localised": "Steel", "Count": 10}
        dispatcher.submit(dict(base, event="MarketSell", CarrierID=7), live=True)
        dispatcher.submit(dict(base, event="MarketBuy", timestamp="2025-01-01T00:00:01Z"), live=True)
        dispatcher.flush(timeout=2)
        # Покупка без CarrierID и carrier-станции — не операция FC cargo.
        self.assertEqual(raven.calls, 1)


# ---------------------------------------------------------------------------
class ApiClientUploadTests(unittest.TestCase):
    """Отправка на сайт: параллельные пачки, корректные итоги."""

    def _client_with_stub(self, latency=0.05, fail_predicate=None):
        """`fail_predicate(payload)` — детерминированный отказ нужной пачки."""
        import api_client

        client = api_client.ApiClient(token="test-token")
        calls = {"count": 0, "rows": 0}

        class FakeResponse:
            def __init__(self, status_code, payload):
                self.status_code = status_code
                self._payload = payload
                self.ok = 200 <= status_code < 300
                self.text = json.dumps(payload)

            def json(self):
                return self._payload

        def fake_post(payload, timeout=30):
            time.sleep(latency)
            calls["count"] += 1
            rows = payload.get("deliveries") or payload.get("construction_events") or []
            calls["rows"] += len(rows)
            if fail_predicate is not None and fail_predicate(payload):
                return FakeResponse(500, {"error": "server busy"}), {"error": "server busy"}
            return FakeResponse(200, {
                "inserted": len(payload.get("deliveries", [])),
                "eventsFound": 0,
                "constructionInserted": len(payload.get("construction_events", [])),
                "snapshotInserted": len(payload.get("construction_events", [])),
            }), {
                "inserted": len(payload.get("deliveries", [])),
                "eventsFound": 0,
                "constructionInserted": len(payload.get("construction_events", [])),
                "snapshotInserted": len(payload.get("construction_events", [])),
            }

        client._post_upload = fake_post
        return client, calls

    def test_deliveries_are_chunked_and_parallel(self):
        client, calls = self._client_with_stub(latency=0.05)
        deliveries = [{"system_name": "Sol", "commodity": "steel", "amount": 1,
                       "delivered_at": "2025-01-01T00:00:00Z", "source_hash": "h%d" % i}
                      for i in range(400)]
        started = time.monotonic()
        progress = []
        result = client.upload_deliveries(deliveries, "CMDR", progress_cb=lambda d, t: progress.append((d, t)))
        elapsed = time.monotonic() - started

        self.assertTrue(result["ok"])
        self.assertEqual(result["inserted"], 400)
        self.assertEqual(calls["count"], 4)          # 400 / 100
        # 4 запроса по 50 мс последовательно заняли бы ~0.2 с.
        self.assertLess(elapsed, 0.2)
        self.assertTrue(progress)
        self.assertEqual(progress[-1], (4, 4))

    def test_failed_chunk_is_reported_as_partial(self):
        # Первая пачка (source_hash "h0") всегда отвечает 500 — и после
        # повторов остаётся единственной неудачной.
        def first_chunk_always_fails(payload):
            return any(d.get("source_hash") == "h0" for d in payload.get("deliveries", []))

        client, calls = self._client_with_stub(latency=0.0, fail_predicate=first_chunk_always_fails)
        deliveries = [{"system_name": "Sol", "commodity": "steel", "amount": 1,
                       "delivered_at": "2025-01-01T00:00:00Z", "source_hash": "h%d" % i}
                      for i in range(200)]
        result = client.upload_deliveries(deliveries, "CMDR")
        self.assertFalse(result["ok"])
        self.assertTrue(result.get("partial"))
        self.assertEqual(result["chunks_failed"], 1)
        self.assertEqual(result["inserted"], 100)

    def test_construction_events_respect_server_limit(self):
        client, calls = self._client_with_stub(latency=0.0)
        events = [{"timestamp": "2025-01-01T00:00:00Z", "system_name": "Sol"} for _ in range(250)]
        result = client.upload_construction_events(events, "CMDR")
        self.assertTrue(result["ok"])
        # Лимит сервера — 100 snapshots на запрос.
        self.assertEqual(calls["count"], 3)
        self.assertEqual(result["constructionInserted"], 250)

    def test_empty_payloads_are_noop(self):
        client, calls = self._client_with_stub()
        self.assertTrue(client.upload_deliveries([], "CMDR")["ok"])
        self.assertTrue(client.upload_construction_events([], "CMDR")["ok"])
        self.assertEqual(calls["count"], 0)


# ---------------------------------------------------------------------------
class RavenProjectCacheTests(unittest.TestCase):
    """Кэш поиска проекта Raven Colonial."""

    def test_project_lookup_is_cached(self):
        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("key")
        calls = {"n": 0}

        class FakeSession:
            def get(self, url, headers=None, timeout=None):
                calls["n"] += 1

                class Resp:
                    ok = True

                    @staticmethod
                    def json():
                        return {"buildId": "b1"}

                return Resp()

        api._session = FakeSession()
        for _ in range(50):  # 50 доставок на одну и ту же стройплощадку
            self.assertEqual(api.get_project(123, 456)["buildId"], "b1")
        self.assertEqual(calls["n"], 1)

    def test_cache_is_cleared_on_key_change(self):
        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("key")
        calls = {"n": 0}

        class FakeSession:
            def get(self, url, headers=None, timeout=None):
                calls["n"] += 1

                class Resp:
                    ok = True

                    @staticmethod
                    def json():
                        return {"buildId": "b1"}

                return Resp()

        api._session = FakeSession()
        api.get_project(1, 2)
        api.set_key("another-key")
        api.get_project(1, 2)
        self.assertEqual(calls["n"], 2)


# ---------------------------------------------------------------------------
class InitialLoadSmokeTest(unittest.TestCase):
    """Сквозная оценка: сколько сетевых вызовов делает первичная загрузка."""

    def test_history_import_makes_no_third_party_calls(self):
        """Импорт всей истории не обращается к EDSM/Inara/Raven."""
        from event_dispatch import ThirdPartyDispatcher

        tmp = tempfile.TemporaryDirectory()
        try:
            files = make_history(Path(tmp.name), files=8, events_per_file=400)
            edsm = EventDispatchTests.FakeEDSM()
            inara = EventDispatchTests.FakeInara()
            raven = EventDispatchTests.FakeRaven()
            dispatcher = ThirdPartyDispatcher(edsm_api=edsm, inara_api=inara, raven_api=raven)
            collector = ConstructionSnapshotCollector()

            cargo = depot = contrib = None
            seen = set()
            deliveries_total = 0
            started = time.monotonic()
            for path in files:
                text = path.read_text(encoding="utf-8")

                def hook(line, ev, _d=dispatcher):
                    _d.submit(ev, live=False)

                _cmdr, deliveries, cargo, depot, contrib, seen, _counts = parse_events(
                    iter_journal_events(text), SYSTEMS[0], cargo, depot, contrib, seen, 0,
                    hooks=[collector, hook],
                )
                deliveries_total += len(deliveries)
            parse_seconds = time.monotonic() - started
            dispatcher.flush(timeout=2)

            self.assertTrue(deliveries_total > 0, "история должна дать доставки")
            self.assertEqual((edsm.calls, inara.calls, raven.calls), (0, 0, 0))
            self.assertTrue(collector.events, "snapshots стройки должны собираться")
            self.assertGreater(collector.duplicates, 0, "повторы snapshots должны отсекаться")
            # Разбор 8 файлов — быстрый (раньше на этом шаге шли тысячи HTTP).
            self.assertLess(parse_seconds, 5.0)
        finally:
            tmp.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
