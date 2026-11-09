"""Тесты первичного источника проектов — сайта проекта.

Что проверяем:

* карточка сайта приводится к форме проекта Raven (`buildId`, `commodities`,
  `sumNeed`/`sumTotal`) — иначе каждый вызов пришлось бы ветвить;
* слияние «сайт + Raven» не создаёт дублей: площадка опознаётся по `marketId`,
  затем по `buildId`, затем по ключу;
* Raven дополняет карточку сайта (`buildId`), но не затирает остаток;
* остаток потребности считается и из точных ресурсов депота, если сайт не
  прислал готовый словарь.
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from site_projects import (  # noqa: E402
    merge_projects,
    need_from_project,
    normalize_card,
    normalize_raven,
    progress_text,
    project_label,
    projects_payload,
    raven_available,
    raven_project_payload,
)


def site_card(**overrides):
    card = {
        "key": "28682976:128016640",
        "buildId": None,
        "systemName": "Ravenless 1",
        "systemAddress": 28682976,
        "marketId": 128016640,
        "buildName": "Первый порт",
        "buildType": "no_truss",
        "bodyName": "Ravenless 1 2",
        "status": "active",
        "progress": 42.5,
        "commodities": {"steel": 900, "aluminium": 0},
        "sumNeed": 900,
        "maxNeed": 5000,
        "primary": False,
        "sources": ["site"],
        "stale": False,
        "rcState": "unavailable",
        "updatedAt": "2026-11-09T10:00:00Z",
    }
    card.update(overrides)
    return card


def raven_project(**overrides):
    project = {
        "buildId": "build-1",
        "marketId": 128016640,
        "systemName": "Ravenless 1",
        "buildName": "Первый порт",
        "buildType": "no_truss",
        "commodities": {"steel": 700},
        "sumNeed": 700,
        "sumTotal": 5000,
        "progress": 55,
    }
    project.update(overrides)
    return project


class NormalizeTests(unittest.TestCase):
    def test_card_becomes_raven_shaped_project(self):
        project = normalize_card(site_card())
        self.assertEqual(project["buildId"], "")
        self.assertEqual(project["commodities"], {"steel": 900})
        self.assertEqual(project["sumNeed"], 900)
        self.assertEqual(project["sumTotal"], 5000)
        self.assertTrue(project["fromSite"])

    def test_card_without_commodities_counts_the_depot(self):
        project = normalize_card(site_card(
            commodities={},
            resources=[
                {"Name": "Steel", "RequiredAmount": 1000, "ProvidedAmount": 300},
                {"Name": "Aluminium", "RequiredAmount": 500, "ProvidedAmount": 500},
            ],
        ))
        self.assertEqual(project["commodities"], {"steel": 700})
        self.assertEqual(project["sumNeed"], 700)

    def test_raven_project_gets_a_key_and_totals(self):
        project = normalize_raven(raven_project())
        self.assertEqual(project["key"], "rc:build-1")
        self.assertEqual(project["sumTotal"], 5000)
        self.assertEqual(project["status"], "active")

    def test_raven_project_without_build_id_is_ignored(self):
        self.assertEqual(normalize_raven({"buildName": "без id"}), {})

    def test_garbage_is_dropped(self):
        self.assertEqual(normalize_card(None), {})
        self.assertEqual(normalize_card("text"), {})
        self.assertEqual(normalize_card({"commodities": {"steel": "много"}})["commodities"], {})


class MergeTests(unittest.TestCase):
    def test_same_site_from_both_sources_is_one_project(self):
        merged = merge_projects([site_card()], [raven_project()])
        self.assertEqual(len(merged), 1, "площадка одна — проект один")
        project = merged[0]
        # Сайт первичен: у него buildId не было, Raven его дополняет.
        self.assertEqual(project["buildId"], "build-1")
        # Остаток остаётся сайтовым (там депот из журнала), а не из Raven.
        self.assertEqual(project["commodities"], {"steel": 900})
        self.assertEqual(project["sources"], ["site", "raven"])
        self.assertEqual(project["rcState"], "ok")

    def test_match_by_build_id_when_market_is_unknown(self):
        site = site_card(marketId=None, buildId="build-1", key="m:0")
        merged = merge_projects([site], [raven_project()])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["marketId"], 128016640)

    def test_raven_only_project_survives(self):
        merged = merge_projects([], [raven_project()])
        self.assertEqual(len(merged), 1)
        self.assertFalse(merged[0]["fromSite"])

    def test_site_only_project_survives_when_raven_is_down(self):
        """Главный сценарий: Raven 503, проект всё равно виден."""
        merged = merge_projects([site_card(rcState="unavailable")], [])
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["rcState"], "unavailable")
        self.assertEqual(merged[0]["buildId"], "")

    def test_site_numbers_are_not_overwritten_by_empty_raven(self):
        merged = merge_projects(
            [site_card()],
            [raven_project(commodities={}, sumNeed=0, sumTotal=0)],
        )
        self.assertEqual(merged[0]["commodities"], {"steel": 900})
        self.assertEqual(merged[0]["sumNeed"], 900)

    def test_active_projects_come_first(self):
        merged = merge_projects(
            [site_card(buildName="Готовый", status="complete")],
            [raven_project(buildId="b2", marketId=2, buildName="Строится")],
        )
        self.assertEqual([item["buildName"] for item in merged], ["Строится", "Готовый"])

    def test_different_sites_are_not_merged(self):
        merged = merge_projects(
            [site_card()],
            [raven_project(buildId="other", marketId=999)],
        )
        self.assertEqual(len(merged), 2)


class NeedTests(unittest.TestCase):
    def test_need_keeps_only_positive_amounts(self):
        project = normalize_card(site_card())
        self.assertEqual(need_from_project(project), {"steel": 900})
        self.assertEqual(need_from_project({}), {})

    def test_label_and_progress(self):
        project = normalize_card(site_card())
        self.assertEqual(project_label(project), "Первый порт · Ravenless 1")
        self.assertEqual(progress_text(project), "900 / 5000 (18%)")
        self.assertEqual(progress_text({}), "—")

    def test_raven_payload_round_trip(self):
        project = normalize_card(site_card(buildType="no_truss", bodyNum=2))
        payload = raven_project_payload(project, cmdr="Jameson")
        self.assertEqual(payload["marketId"], 128016640)
        self.assertEqual(payload["systemAddress"], 28682976)
        self.assertEqual(payload["buildName"], "Первый порт")
        self.assertEqual(payload["buildType"], "no_truss")
        self.assertEqual(payload["bodyNum"], 2)
        self.assertEqual(payload["commodities"], {"steel": 900})
        self.assertEqual(payload["maxNeed"], 5000)
        self.assertEqual(payload["commanders"], {"Jameson": []})
        # Пустых значений в теле быть не должно: Raven делает merge.
        self.assertNotIn("buildId", payload)

    def test_raven_payload_without_build_name_is_still_valid(self):
        project = normalize_card(site_card(buildName=""))
        payload = raven_project_payload(project)
        self.assertNotIn("buildName", payload)

    def test_payload_shapes(self):
        self.assertEqual(projects_payload({"projects": [1, 2]}), [1, 2])
        self.assertEqual(projects_payload([1]), [1])
        self.assertEqual(projects_payload(None), [])
        self.assertEqual(projects_payload({"error": "x"}), [])

    def test_raven_availability(self):
        self.assertTrue(raven_available({"ok": True}))
        self.assertFalse(raven_available({"ok": False, "status": 503}))
        self.assertFalse(raven_available({"ok": False,
                                          "error": "Raven Colonial не ответил (503)"}))
        self.assertIsNone(raven_available({"ok": False, "status": 401}))
        self.assertIsNone(raven_available(None))


if __name__ == "__main__":
    unittest.main()
