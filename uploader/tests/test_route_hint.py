"""Подсказка ROUTE: стройка в следующей системе и её первооткрыватель.

Правила, за которые держат эти тесты:

* система не в базе проекта — это «ещё не исследована», а не пустая строка и
  не «нет данных»: командиру важно различать «никто не открывал» и «сайт молчит»;
* подсказка всегда относится к конкретной системе: если маршрут сменился,
  старый ответ на экране не остаётся;
* сеть на сайте — не повод падать: ошибка показывается, а блок живёт.
"""
import os
import sys
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import route_hint  # noqa: E402
from route_tracker import RouteTracker  # noqa: E402


def payload(**overrides):
    data = {
        "ok": True,
        "system": "Test Alpha",
        "construction": {
            "known": True, "status": "building", "progress": 42.6,
            "sitesActive": 1, "sitesComplete": 0, "remaining": 18240.4,
            "needs": [{"label": "Сталь", "remaining": 9000.6},
                      {"label": "Титан", "remaining": 100}],
            "updatedAt": "2026-10-20T10:00:00.000Z",
        },
        "discovery": {
            "known": True, "discoverer": "CMDR Orin Vex",
            "bodies": 12, "mapped": 4, "footfall": 1,
        },
    }
    data.update(overrides)
    return data


class NormalizeTests(unittest.TestCase):

    def test_building_with_progress_and_discoverer(self):
        hint = route_hint.normalize_hint(payload())
        self.assertEqual(hint["status"], route_hint.BUILDING)
        self.assertEqual(hint["progress"], 43, "процент округляется до целого")
        self.assertEqual(hint["remaining"], 18240)
        self.assertEqual(hint["discoverer"], "CMDR Orin Vex")
        self.assertTrue(hint["known"])
        self.assertEqual(hint["bodies"], 12)
        self.assertEqual([need["label"] for need in hint["needs"]], ["Сталь", "Титан"])

    def test_empty_payload_is_not_explored(self):
        hint = route_hint.normalize_hint(None, "Test Alpha")
        self.assertEqual(hint["system"], "Test Alpha")
        self.assertFalse(hint["known"])
        self.assertEqual(hint["discoverer"], "")
        self.assertEqual(hint["status"], route_hint.UNKNOWN)
        self.assertIsNone(hint["progress"])
        self.assertEqual(hint["error"], "")

    def test_error_payload_keeps_the_error_and_says_nothing_else(self):
        hint = route_hint.normalize_hint({"ok": False, "error": "HTTP 503"}, "Test Alpha")
        self.assertEqual(hint["error"], "HTTP 503")
        self.assertEqual(hint["status"], route_hint.UNKNOWN)
        self.assertFalse(hint["known"])

    def test_progress_without_status_is_still_building(self):
        hint = route_hint.normalize_hint({"ok": True, "system": "X",
                                          "construction": {"progress": 12}})
        self.assertEqual(hint["status"], route_hint.BUILDING)
        self.assertEqual(hint["progress"], 12)
        hundred = route_hint.normalize_hint({"ok": True, "system": "X",
                                             "construction": {"progress": 100}})
        self.assertEqual(hundred["status"], route_hint.DONE)

    def test_known_false_beats_a_status(self):
        """`known=false` — проект о стройке не знает, что бы ни лежало в статусе."""
        hint = route_hint.normalize_hint({"ok": True, "system": "X",
                                          "construction": {"known": False,
                                                           "status": "building",
                                                           "progress": 40}})
        self.assertEqual(hint["status"], route_hint.UNKNOWN)
        self.assertIsNone(hint["progress"])

    def test_percent_is_clamped_and_garbage_ignored(self):
        self.assertEqual(route_hint.normalize_hint(
            {"construction": {"progress": 140}}).get("progress"), 100)
        self.assertEqual(route_hint.normalize_hint(
            {"construction": {"progress": -5}}).get("progress"), 0)
        self.assertIsNone(route_hint.normalize_hint(
            {"construction": {"progress": "нет"}}).get("progress"))

    def test_needs_are_capped_and_clean(self):
        needs = [{"label": "Товар %d" % index, "remaining": index} for index in range(9)]
        needs.append({"label": "", "remaining": 10})
        hint = route_hint.normalize_hint({"construction": {"needs": needs}})
        self.assertEqual(len(hint["needs"]), route_hint.MAX_NEEDS)

    def test_loading_marks_only_the_same_system(self):
        hint = route_hint.normalize_hint(payload())
        same = route_hint.mark_loading(hint, "Test Alpha")
        self.assertTrue(same["loading"])
        self.assertEqual(same["discoverer"], "CMDR Orin Vex", "данные той же системы сохраняются")
        other = route_hint.mark_loading(hint, "Test Beta")
        self.assertEqual(other["system"], "Test Beta")
        self.assertEqual(other["discoverer"], "", "чужие данные в новую систему не переезжают")
        self.assertEqual(other["status"], route_hint.UNKNOWN)

    def test_signature_changes_with_the_state(self):
        first = route_hint.hint_signature(route_hint.normalize_hint(payload()))
        same = route_hint.hint_signature(route_hint.normalize_hint(payload()))
        self.assertEqual(first, same)
        changed = payload()
        changed["construction"] = dict(changed["construction"], progress=77)
        self.assertNotEqual(first, route_hint.hint_signature(route_hint.normalize_hint(changed)))


class TrackerHintTests(unittest.TestCase):
    """Трекер маршрута: когда спрашивать сайт и кому отдавать ответ."""

    def setUp(self):
        import tempfile

        # Фоновые потоки могут дописывать кэш в момент уборки каталога:
        # для теста это не ошибка.
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = self._tmp.name
        self.tracker = RouteTracker()
        self.tracker.load_from_navroute({"Route": [
            {"StarSystem": "A", "StarPos": [0, 0, 0], "StarClass": "K"},
            {"StarSystem": "B", "StarPos": [3, 4, 0], "StarClass": "M"},
            {"StarSystem": "C", "StarPos": [3, 4, 12], "StarClass": "N"},
        ]})

    def wait(self, predicate, timeout=2.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return False

    def test_hint_is_asked_for_the_next_system(self):
        asked = []
        self.tracker.refresh_system_hint(lambda name: asked.append(name) or payload(system=name))
        self.assertTrue(self.wait(lambda: not self.tracker.get_system_hint()["loading"]))
        self.assertEqual(asked, ["A"])
        self.assertEqual(self.tracker.get_system_hint()["system"], "A")

    def test_hint_is_not_asked_twice_within_ttl(self):
        asked = []
        fetch = lambda name: asked.append(name) or payload(system=name)  # noqa: E731
        for _ in range(3):
            self.tracker.refresh_system_hint(fetch)
            self.wait(lambda: not self.tracker.get_system_hint()["loading"])
        self.assertEqual(asked, ["A"], "ответ свежий — сайт второй раз не дёргаем")

    def test_new_system_is_asked_even_within_ttl(self):
        asked = []
        fetch = lambda name: asked.append(name) or payload(system=name)  # noqa: E731
        self.tracker.refresh_system_hint(fetch)
        self.wait(lambda: not self.tracker.get_system_hint()["loading"])
        self.tracker.mark_visited("A")
        self.tracker.refresh_system_hint(fetch)
        self.assertTrue(self.wait(lambda: self.tracker.get_system_hint()["system"] == "B"))
        self.assertEqual(asked, ["A", "B"])

    def test_failed_fetch_is_a_state_not_a_crash(self):
        def broken(_name):
            raise RuntimeError("нет сети")

        self.tracker.refresh_system_hint(broken)
        self.assertTrue(self.wait(lambda: not self.tracker.get_system_hint()["loading"]))
        hint = self.tracker.get_system_hint()
        self.assertIn("нет сети", hint["error"])
        self.assertFalse(hint["known"])

    def test_empty_route_has_no_hint(self):
        empty = RouteTracker()
        empty.refresh_system_hint(lambda name: payload(system=name))
        self.assertEqual(empty.get_system_hint()["system"], "")
        self.assertFalse(empty.get_system_hint()["known"])

    def test_clear_resets_the_hint(self):
        self.tracker.refresh_system_hint(lambda name: payload(system=name))
        self.assertTrue(self.wait(lambda: not self.tracker.get_system_hint()["loading"]))
        self.tracker.clear()
        self.assertEqual(self.tracker.get_system_hint()["system"], "")
        self.assertFalse(self.tracker.hint_matches("A"))

    def test_hint_matches_is_exact(self):
        self.tracker.refresh_system_hint(lambda name: payload(system=name))
        self.assertTrue(self.wait(lambda: not self.tracker.get_system_hint()["loading"]))
        self.assertTrue(self.tracker.hint_matches("A"))
        self.assertFalse(self.tracker.hint_matches("B"))
        self.assertFalse(self.tracker.hint_matches(""))

    def test_known_system_is_shown_immediately_from_cache(self):
        """Система уже встречалась — данные видны сразу, сеть идёт фоном.

        Именно поэтому в блоке не висит «спрашиваем…»: подсказка берётся из
        прогретого кэша и печатается до ответа сайта.
        """
        asked = []
        self.tracker.prefetch_system_hints(
            lambda name: asked.append(name) or payload(system=name), ahead=2)
        self.assertTrue(self.wait(lambda: len(asked) >= 2))

        release = threading.Event()
        self.addCleanup(release.set)

        def slow(name):
            release.wait(1.0)
            return payload(system=name)

        # Кэш «B» состарился (как после нескольких минут полёта) — значение
        # всё равно печатается сразу, а сеть обновляет его фоном.
        with self.tracker._hint_lock:
            self.tracker._hint_cache["b"]["at"] -= self.tracker.HINT_TTL + 60

        self.tracker.mark_visited("A")
        self.tracker.refresh_system_hint(slow)
        hint = self.tracker.get_system_hint()
        self.assertEqual(hint["system"], "B")
        self.assertEqual(hint["discoverer"], "CMDR Orin Vex", "данные видны сразу")
        self.assertTrue(hint["loading"], "и одновременно идёт фоновое обновление")

    def test_cache_survives_restart(self):
        """Подсказка с диска поднимается в новом трекере без сети."""
        path = Path(self.tmpdir) / "hints.json"
        fetch = lambda name: payload(system=name)  # noqa: E731
        first = RouteTracker(hint_cache_path=path)
        first.load_from_navroute({"Route": [{"StarSystem": "A", "StarPos": [0, 0, 0]}]})
        first.refresh_system_hint(fetch)
        self.assertTrue(self.wait_first(first))

        calls = []
        second = RouteTracker(hint_cache_path=path)
        second.load_from_navroute({"Route": [{"StarSystem": "A", "StarPos": [0, 0, 0]}]})
        second.refresh_system_hint(lambda name: calls.append(name) or payload(system=name))
        hint = second.get_system_hint()
        self.assertEqual(hint["system"], "A")
        self.assertEqual(hint["discoverer"], "CMDR Orin Vex",
                         "данные с диска видны сразу, без ожидания сети")

    def test_failed_fetch_backs_off_instead_of_hammering(self):
        """После ошибки сайт не дёргаем каждый тик — ждём паузу."""
        calls = []

        def broken(name):
            calls.append(name)
            raise RuntimeError("нет сети")

        self.tracker.refresh_system_hint(broken)
        self.assertTrue(self.wait(lambda: self.tracker.get_system_hint()["error"]))
        for _ in range(5):
            self.tracker.refresh_system_hint(broken)
        self.assertEqual(calls, ["A"], "в паузе между попытками запросов нет")

    def test_failure_keeps_the_previous_known_data(self):
        """Сеть отвалилась, но прошлые данные о системе лучше пустоты."""
        self.tracker.refresh_system_hint(lambda name: payload(system=name))
        self.assertTrue(self.wait(lambda: not self.tracker.get_system_hint()["loading"]))
        self.tracker.refresh_system_hint(lambda name: {"ok": False, "error": "HTTP 503"},
                                         force=True)
        self.assertTrue(self.wait(lambda: not self.tracker.get_system_hint()["loading"]))
        hint = self.tracker.get_system_hint()
        self.assertEqual(hint["discoverer"], "CMDR Orin Vex")
        self.assertEqual(hint["status"], route_hint.BUILDING)

    def test_partial_answer_is_reasked_sooner(self):
        """«Стройка неизвестна» от неполного ответа — перепрашиваем раньше TTL."""
        self.tracker.refresh_system_hint(
            lambda name: dict(payload(system=name), partial=True))
        self.assertTrue(self.wait(lambda: not self.tracker.get_system_hint()["loading"]))
        self.assertEqual(self.tracker.HINT_PARTIAL_TTL, 60)
        calls = []

        # Внутри окна partial-TTL повтор не нужен, за его пределами — нужен.
        self.tracker.refresh_system_hint(lambda name: calls.append(name) or payload())
        self.assertEqual(calls, [])
        with self.tracker._hint_lock:
            self.tracker._hint_cache["a"]["at"] -= self.tracker.HINT_PARTIAL_TTL + 5
        self.tracker.refresh_system_hint(lambda name: calls.append(name) or payload())
        self.assertEqual(calls, ["A"])

    def test_prefetch_warms_the_next_systems(self):
        """Пока летим до первой — подсказки для следующих уже готовы."""
        asked = []

        def fetch(name):
            asked.append(name)
            return payload(system=name)

        self.tracker.prefetch_system_hints(fetch, ahead=3)
        self.assertTrue(self.wait(lambda: len(asked) >= 3))
        self.assertEqual(asked, ["A", "B", "C"], "по порядку маршрута, по одному")

        before = list(asked)
        self.tracker.mark_visited("A")
        self.tracker.refresh_system_hint(fetch)
        self.assertEqual(self.tracker.get_system_hint()["system"], "B")
        self.assertEqual(asked, before, "B уже прогрета — сеть не нужна")

    def wait_first(self, tracker, timeout=2.0):
        return self.wait(lambda: not tracker.get_system_hint()["loading"], timeout)

    def test_concurrent_refresh_does_not_double_ask(self):
        asked = []
        release = threading.Event()

        def slow(name):
            asked.append(name)
            release.wait(1.0)
            return payload(system=name)

        self.tracker.refresh_system_hint(slow)
        self.tracker.refresh_system_hint(slow)
        release.set()
        self.assertTrue(self.wait(lambda: not self.tracker.get_system_hint()["loading"]))
        self.assertEqual(asked, ["A"], "пока запрос в полёте, второй не начинается")


if __name__ == "__main__":
    unittest.main()
