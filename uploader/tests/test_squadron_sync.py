"""Эскадрилья пилота из журнала: сбор состояния и отправка на сайт.

Проверяется:

* разбор ``SquadronStartup`` (``CurrentRank``) и ``SquadronPromotion``
  (``NewRank``), отбраковка ``-1``/мусора и событий без ``SquadronID``;
* состояние — одно на пилота: более старое событие истории (пере-импорт
  прошлых сессий) не откатывает свежее, но может уточнить недостающее;
* outbox на диске переживает перезапуск Helper'а;
* повтор уже принятого состояния не шлётся, ``RETRY_SECONDS`` держит паузу
  после сбоя, удачная отправка снимает паузу;
* тело запроса — ровно те поля, которые ждёт ``POST /api/cmdr/squadron``
  (``game_squadron_id``/``_name``/``_rank``/``event_at``), а ключ API-токена
  берёт на себя ``api_client.upload_squadron``;
* Helper без API-токена не отправляет вовсе (``is_connected = False``).

Отдельно закрепляется, что вызов отправки стоит в цикле watcher'а после
фракций и что ``_flush_bgs_sync`` не ходит на сайт без токена.
"""

import json
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import squadron_sync  # noqa: E402
from squadron_sync import (  # noqa: E402
    MAX_GAME_RANK,
    SQUADRON_EVENTS,
    SquadronInfoCollector,
    normalize_game_rank,
    squadron_state_from_event,
)

HELPER_SOURCE = (HERE.parent / "colonial_helper.py").read_text(encoding="utf-8")


def startup(squadron_id, name, rank, timestamp="2026-11-10T18:00:00Z"):
    return {
        "timestamp": timestamp, "event": "SquadronStartup",
        "SquadronID": squadron_id, "SquadronName": name, "CurrentRank": rank,
    }


def promotion(squadron_id, name, new_rank, old_rank=0, timestamp="2026-11-11T18:00:00Z"):
    return {
        "timestamp": timestamp, "event": "SquadronPromotion",
        "SquadronID": squadron_id, "SquadronName": name,
        "OldRank": old_rank, "NewRank": new_rank, "CurrentRank": old_rank,
    }


class FakeApi:
    def __init__(self, ok=True, response=None):
        self.ok = ok
        self.is_connected = True
        self.response = response or {}
        self.calls = []

    def upload_squadron(self, squadron, cmdr=None):
        self.calls.append({"squadron": dict(squadron), "cmdr": cmdr})
        if not self.ok:
            return {"ok": False, "error": "HTTP 503"}
        return {"ok": True, **self.response}


class ParseTests(unittest.TestCase):
    def test_events_list(self):
        self.assertEqual(SQUADRON_EVENTS, ("SquadronStartup", "SquadronPromotion"))

    def test_startup(self):
        state = squadron_state_from_event(startup(75645, "ENDURANCE EXPLORATION", 4))
        self.assertEqual(state["squadron_id"], 75645)
        self.assertEqual(state["squadron_name"], "ENDURANCE EXPLORATION")
        self.assertEqual(state["rank"], 4)
        self.assertEqual(state["timestamp"], "2026-11-10T18:00:00Z")

    def test_promotion_uses_new_rank(self):
        state = squadron_state_from_event(promotion(75645, "ENDURANCE EXPLORATION", 5, old_rank=3))
        self.assertEqual(state["rank"], 5)

    def test_other_events_ignored(self):
        for event in ("LoadGame", "FSDJump", "SquadronStartupOld"):
            self.assertIsNone(squadron_state_from_event({"event": event, "SquadronID": 1}))

    def test_missing_or_bad_id_ignored(self):
        self.assertIsNone(squadron_state_from_event({"event": "SquadronStartup", "SquadronName": "X"}))
        self.assertIsNone(squadron_state_from_event({"event": "SquadronStartup", "SquadronID": "мусор"}))
        self.assertIsNone(squadron_state_from_event({"event": "SquadronStartup", "SquadronID": 0}))
        self.assertIsNone(squadron_state_from_event({"event": "SquadronStartup", "SquadronID": -5}))

    def test_name_is_trimmed_and_bounded(self):
        state = squadron_state_from_event(startup(1, "  Wing  ", 0))
        self.assertEqual(state["squadron_name"], "Wing")
        long_name = squadron_state_from_event(startup(1, "X" * 500, 0))
        self.assertEqual(len(long_name["squadron_name"]), 120)

    def test_rank_bounds(self):
        self.assertIsNone(normalize_game_rank(-1), "«ранга ещё нет» — не ранг")
        self.assertIsNone(normalize_game_rank(MAX_GAME_RANK + 1))
        self.assertIsNone(normalize_game_rank("staff"))
        self.assertIsNone(normalize_game_rank(None))
        self.assertEqual(normalize_game_rank(0), 0, "0 — законный низший ранг")
        self.assertEqual(normalize_game_rank(str(MAX_GAME_RANK)), MAX_GAME_RANK)

    def test_bad_rank_in_event_becomes_none(self):
        state = squadron_state_from_event(startup(7, "Wing", -1))
        self.assertIsNone(state["rank"])


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / ".squadron_outbox.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_state_is_last_known(self):
        collector = SquadronInfoCollector(self.path)
        self.assertTrue(collector.feed(startup(1, "OLD", 1)))
        self.assertTrue(collector.feed(startup(2, "NEW", 3, timestamp="2026-11-12T00:00:00Z")))
        self.assertEqual(collector.state["squadron_id"], 2)
        self.assertEqual(collector.state["rank"], 3)

    def test_older_history_does_not_roll_back(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(2, "NEW", 3, timestamp="2026-11-12T00:00:00Z"))
        self.assertFalse(collector.feed(startup(2, "NEW", 1, timestamp="2026-01-01T00:00:00Z")))
        self.assertEqual(collector.state["rank"], 3)

    def test_same_state_is_not_news(self):
        collector = SquadronInfoCollector(self.path)
        self.assertTrue(collector.feed(startup(1, "Wing", 2)))
        self.assertFalse(collector.feed(startup(1, "Wing", 2, timestamp="2026-11-11T00:00:00Z")))

    def test_missing_rank_keeps_previous(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, "Wing", 4))
        # У промоушена без NewRank ранг не теряется — остаётся прежний.
        collector.feed({"timestamp": "2026-11-12T00:00:00Z", "event": "SquadronPromotion", "SquadronID": 1})
        self.assertEqual(collector.state["rank"], 4)
        self.assertEqual(collector.state["squadron_name"], "Wing")

    def test_outbox_survives_restart(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(75645, "ENDURANCE EXPLORATION", 4))
        reopened = SquadronInfoCollector(self.path)
        self.assertEqual(reopened.state["squadron_id"], 75645)
        self.assertEqual(reopened.state["rank"], 4)
        # Файл записан атомарно: временного «.tmp» не остаётся.
        self.assertFalse(list(Path(self.tmp.name).glob("*.tmp")))

    def test_corrupted_outbox_does_not_crash(self):
        self.path.write_text("{ это не json", encoding="utf-8")
        collector = SquadronInfoCollector(self.path)
        self.assertIsNone(collector.state)
        self.assertTrue(collector.feed(startup(1, "Wing", 0)))

    def test_nothing_to_send_without_state(self):
        collector = SquadronInfoCollector(self.path)
        api = FakeApi()
        self.assertIsNone(collector.pending_payload())
        self.assertEqual(collector.flush(api), {"ok": True, "sent": False})
        self.assertEqual(api.calls, [])

    def test_tag_goes_to_site_when_journal_has_it(self):
        # `SquadronTag` в событиях необязателен, но если игра его дала — сайт
        # по нему не создаст дубль эскадрильи с другим написанием имени.
        collector = SquadronInfoCollector(self.path)
        event = startup(75645, 'ENDURANCE EXPLORATION', 4)
        event['SquadronTag'] = 'enex'
        collector.feed(event)
        api = FakeApi()
        collector.flush(api)
        self.assertEqual(api.calls[0]['squadron']['game_squadron_tag'], 'enex')

    def test_payload_has_no_tag_when_journal_does_not(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(75645, 'ENDURANCE EXPLORATION', 4))
        api = FakeApi()
        collector.flush(api)
        self.assertNotIn('game_squadron_tag', api.calls[0]['squadron'],
                         'пустой тег не отправляем: сервер сам соберёт его из названия')

    def test_created_squadron_is_reported(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, 'NEW WING', 0))
        api = FakeApi(response={'created': True, 'squadronName': 'NEW WING', 'joined': True})
        result = collector.flush(api)
        self.assertTrue(result['created'], 'сайт завёл эскадрилью по журналу')
        api2 = FakeApi(response={'squadronName': 'NEW WING'})
        collector.feed(startup(1, 'NEW WING', 1))
        self.assertFalse(collector.flush(api2)['created'])

    def test_payload_matches_route_contract(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(75645, "ENDURANCE EXPLORATION", 4))
        api = FakeApi()
        result = collector.flush(api, "Nova")
        self.assertTrue(result["ok"])
        self.assertTrue(result["sent"])
        self.assertEqual(len(api.calls), 1)
        self.assertEqual(api.calls[0]["cmdr"], "Nova")
        self.assertEqual(api.calls[0]["squadron"], {
            "game_squadron_id": 75645,
            "game_squadron_name": "ENDURANCE EXPLORATION",
            "game_squadron_rank": 4,
            "event_at": "2026-11-10T18:00:00Z",
        })

    def test_sent_state_is_not_repeated(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, "Wing", 1))
        api = FakeApi()
        collector.flush(api)
        self.assertIsNone(collector.pending_payload())
        self.assertEqual(collector.flush(api), {"ok": True, "sent": False})
        self.assertEqual(len(api.calls), 1)
        # Отправленное тоже переживает перезапуск — иначе Helper слал бы то же
        # самое при каждом старте.
        reopened = SquadronInfoCollector(self.path)
        self.assertIsNone(reopened.pending_payload())

    def test_promotion_is_sent(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, "Wing", 1))
        api = FakeApi()
        collector.flush(api)
        collector.feed(promotion(1, "Wing", 2))
        self.assertIsNotNone(collector.pending_payload())
        collector.flush(api)
        self.assertEqual([call["squadron"]["game_squadron_rank"] for call in api.calls], [1, 2])

    def test_failure_keeps_state_and_waits(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, "Wing", 1))
        api = FakeApi(ok=False)
        result = collector.flush(api)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "HTTP 503")
        self.assertIsNotNone(collector.state, "неудача не теряет состояние")
        self.assertIsNone(collector.pending_payload(), "пауза после сбоя")
        # Через RETRY_SECONDS повтор снова разрешён.
        collector._failed_at = time.monotonic() - squadron_sync.SquadronInfoCollector.RETRY_SECONDS - 1
        self.assertIsNotNone(collector.pending_payload())

    def test_exception_is_a_failure_not_a_crash(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, "Wing", 1))

        class Exploding:
            is_connected = True

            def upload_squadron(self, body, cmdr=None):
                raise OSError("сеть отвалилась")

        result = collector.flush(Exploding())
        self.assertFalse(result["ok"])
        self.assertIn("сеть отвалилась", result["error"])
        self.assertIsNotNone(collector.state)

    def test_no_connection_means_no_request(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, "Wing", 1))
        api = FakeApi()
        api.is_connected = False
        result = collector.flush(api)
        self.assertFalse(result["ok"])
        self.assertEqual(api.calls, [])
        self.assertIsNotNone(collector.state)

    def test_result_reports_server_side(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, "Wing", 1))
        api = FakeApi(response={"squadronName": "ENDURANCE EXPLORATION", "joined": True, "rankName": "Пилот"})
        result = collector.flush(api)
        self.assertEqual(result["squadron"], "ENDURANCE EXPLORATION")
        self.assertTrue(result["joined"])
        self.assertEqual(result["rank"], "Пилот")

    def test_reset_forgets_sent(self):
        collector = SquadronInfoCollector(self.path)
        collector.feed(startup(1, "Wing", 1))
        api = FakeApi()
        collector.flush(api)
        self.assertIsNone(collector.pending_payload())
        collector.reset()
        self.assertIsNotNone(collector.pending_payload(), "после смены аккаунта состояние шлётся заново")
        # Состояние при этом живо.
        self.assertEqual(collector.state["squadron_id"], 1)


class HelperLogTests(unittest.TestCase):
    """Строка журнала Helper'а различает «эскадрилья уже была» и «создана»."""

    def test_log_says_created(self):
        self.assertIn('на сайте создана', HELPER_SOURCE)
        self.assertIn('result.get("created")', HELPER_SOURCE)


class HelperWiringTests(unittest.TestCase):
    """Отправка встроена в цикл Helper'а и не мешает остальной работе."""

    def test_flush_called_in_watcher_loop(self):
        self.assertRegex(HELPER_SOURCE, r"self\._flush_squadron_sync\(\)")
        # После фракций и до подхвата NavRoute — то есть в том же проходе,
        # которым разбирается живой журнал.
        tail = HELPER_SOURCE[HELPER_SOURCE.index("self._flush_squadron_sync()"):]
        self.assertIn("self._auto_load_navroute()", tail[:600])

    def test_flush_is_guarded_by_connection(self):
        body = HELPER_SOURCE[HELPER_SOURCE.index("def _flush_squadron_sync"):]
        body = body[: body.index("def ", 10)]
        self.assertIn("if not self.api.is_connected", body)

    def test_bgs_flush_is_guarded_by_connection(self):
        body = HELPER_SOURCE[HELPER_SOURCE.index("def _flush_bgs_sync"):]
        body = body[: body.index("def ", 10)]
        self.assertIn("if not self.api.is_connected", body,
                      "без API-токена фракции не должны ходить на сайт")
        self.assertLess(body.index("if not self.api.is_connected"), body.index("collector.flush"))

    def test_map_events_include_squadron_for_restore(self):
        match = re.search(r"RESTORE_MAP_EVENTS\s*=\s*RESTORE_STATE_EVENTS\s*\|\s*frozenset\((.*?)\}\)", HELPER_SOURCE, re.S)
        self.assertIsNotNone(match)
        self.assertIn("SquadronStartup", match.group(1))
        self.assertIn("SquadronPromotion", match.group(1))

    def test_api_client_has_upload_squadron(self):
        client = (HERE.parent / "api_client.py").read_text(encoding="utf-8")
        self.assertIn("def upload_squadron", client)
        self.assertIn("/api/cmdr/squadron", client)


if __name__ == "__main__":
    unittest.main()
