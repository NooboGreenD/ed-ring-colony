"""Тесты стройплощадок колонизации и автозаполнения проекта Raven Colonial.

Закрепляем то, что нельзя проверить глазами и что уже ломалось:

* стройплощадка определяется по имени станции и её сервисам, а не «на глаз»;
* потребность по товарам берётся из `RequiredAmount`/`ProvidedAmount`, и в
  Raven Colonial уходит **остаток** (`commodities`), а исходный объём — в
  `maxNeed`;
* обязательные поля `PUT /api/project` (marketId, systemAddress, buildName)
  заполняются из журнала, а не остаются пустыми;
* посадка на площадку заполняет форму сама, но не затирает ручной ввод;
* после создания открывается страница проекта `#build={buildId}`.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from colonisation import (  # noqa: E402
    ConstructionSite,
    ConstructionSiteTracker,
    SiteResource,
    build_project_draft,
    default_project_name,
    format_commodities,
    is_construction_site,
    is_primary_port_station,
)

DEPOT = {
    "timestamp": "2025-04-08T23:47:39Z",
    "event": "ColonisationConstructionDepot",
    "MarketID": 3951663874,
    "ConstructionProgress": 0.25,
    "ConstructionComplete": False,
    "ConstructionFailed": False,
    "ResourcesRequired": [
        {"Name": "$steel_name;", "Name_Localised": "Steel",
         "RequiredAmount": 6680, "ProvidedAmount": 720, "Payment": 5057},
        {"Name": "$aluminium_name;", "Name_Localised": "Aluminium",
         "RequiredAmount": 480, "ProvidedAmount": 480, "Payment": 3239},
        {"Name": "$liquidoxygen_name;", "Name_Localised": "Liquid oxygen",
         "RequiredAmount": 1865, "ProvidedAmount": 0, "Payment": 2260},
    ],
}

DOCKED = {
    "timestamp": "2025-04-08T23:40:00Z",
    "event": "Docked",
    "StationName": "Planetary Construction Site: Hestia Depot",
    "StationType": "SurfaceStation",
    "MarketID": 3951663874,
    "StarSystem": "Kuma",
    "SystemAddress": 123456789,
    "StarPos": [10.5, -20.25, 30.125],
    "Body": "Kuma 3 a",
    "BodyID": 12,
    "StationFaction": {"Name": "Kuma Vision Corp"},
    "StationServices": ["dock", "colonisationcontribution", "missions"],
}


class ConstructionSiteDetectionTests(unittest.TestCase):
    def test_construction_site_names(self):
        services = ["colonisationcontribution"]
        self.assertTrue(is_construction_site("Planetary Construction Site: Hestia Depot", services))
        self.assertTrue(is_construction_site("Orbital Construction Site: Zeus", services))
        self.assertTrue(is_construction_site("System Colonisation Ship", services))
        # Токен локализации без _Localised — тоже стройплощадка.
        self.assertTrue(is_construction_site("$EXT_PANEL_ColonisationShip; Zeus", services))

    def test_ordinary_stations_are_not_construction_sites(self):
        self.assertFalse(is_construction_site("Jameson Memorial", ["dock", "colonisationcontribution"]))
        self.assertFalse(is_construction_site("", None))
        self.assertFalse(is_construction_site(None, None))

    def test_service_is_required_when_known(self):
        """По одному имени станции площадку от наземного порта не отличить."""
        self.assertFalse(
            is_construction_site("Planetary Construction Site: Hestia", ["dock", "missions"])
        )
        # Сервисов нет (Location) — верим имени станции.
        self.assertTrue(is_construction_site("Planetary Construction Site: Hestia", None))

    def test_primary_port_detection(self):
        self.assertTrue(is_primary_port_station("System Colonisation Ship"))
        self.assertTrue(is_primary_port_station("$EXT_PANEL_ColonisationShip"))
        self.assertFalse(is_primary_port_station("Planetary Construction Site: Hestia"))

    def test_default_project_name(self):
        self.assertEqual(default_project_name("System Colonisation Ship"), "Primary port")
        self.assertEqual(default_project_name("$EXT_PANEL_ColonisationShip; Zeus"), "Zeus")
        self.assertEqual(
            default_project_name("Planetary Construction Site: Hestia Depot"), "Hestia Depot")
        self.assertEqual(default_project_name("Orbital Construction Site: Apollo"), "Apollo")
        self.assertEqual(default_project_name(""), "")


class SiteResourceTests(unittest.TestCase):
    def test_from_journal_normalises_names(self):
        resource = SiteResource.from_journal(DEPOT["ResourcesRequired"][0])
        # Raven Colonial принимает только языконезависимое имя в нижнем регистре.
        self.assertEqual(resource.name, "steel")
        self.assertEqual(resource.display, "Steel")
        self.assertEqual(resource.required, 6680)
        self.assertEqual(resource.provided, 720)
        self.assertEqual(resource.remaining, 5960)

    def test_remaining_never_negative(self):
        resource = SiteResource(name="steel", required=100, provided=250)
        self.assertEqual(resource.remaining, 0)

    def test_bad_items_are_skipped(self):
        self.assertIsNone(SiteResource.from_journal(None))
        self.assertIsNone(SiteResource.from_journal({"RequiredAmount": 5}))


class ConstructionSiteTests(unittest.TestCase):
    def _site(self) -> ConstructionSite:
        site = ConstructionSite(market_id=DEPOT["MarketID"], system_name="Kuma",
                                station_name="Planetary Construction Site: Hestia Depot")
        site.update_from_depot(DEPOT)
        return site

    def test_totals_and_remaining(self):
        site = self._site()
        self.assertEqual(site.total_required, 6680 + 480 + 1865)
        self.assertEqual(site.total_provided, 720 + 480)
        # Aluminium закрыт полностью — в остаток не попадает.
        self.assertEqual(site.remaining_by_commodity(),
                         {"liquidoxygen": 1865, "steel": 5960})
        self.assertEqual(site.progress_percent, 25)
        self.assertFalse(site.is_primary_port)

    def test_update_reports_changes(self):
        site = ConstructionSite(market_id=1)
        self.assertTrue(site.update_from_depot(DEPOT))
        # Тот же snapshot второй раз — изменений нет (журнал пишет его постоянно).
        self.assertFalse(site.update_from_depot(DEPOT))
        updated = dict(DEPOT, ConstructionProgress=0.9)
        self.assertTrue(site.update_from_depot(updated))
        self.assertEqual(site.progress_percent, 90)

    def test_summary_mentions_missing_resources(self):
        site = ConstructionSite(market_id=1, system_name="Kuma", station_name="Planetary Construction Site: X")
        self.assertIn("ресурсы ещё не получены", site.summary())
        site.update_from_depot(DEPOT)
        self.assertIn("прогресс 25%", site.summary())
        self.assertIn("остаток", site.summary())


class ConstructionSiteTrackerTests(unittest.TestCase):
    def setUp(self):
        self.tracker = ConstructionSiteTracker()

    def test_dock_and_depot_build_full_site(self):
        self.tracker.handle("", {"timestamp": "t0", "event": "Commander", "Name": "CMDR Test"})
        changed = self.tracker.handle("", DOCKED)
        self.assertTrue(changed)
        site = self.tracker.site
        self.assertEqual(site.market_id, 3951663874)
        self.assertEqual(site.system_name, "Kuma")
        self.assertEqual(site.system_address, 123456789)
        self.assertEqual(site.star_pos, [10.5, -20.25, 30.125])
        self.assertEqual(site.body_name, "Kuma 3 a")
        self.assertEqual(site.body_num, 12)
        self.assertEqual(site.faction_name, "Kuma Vision Corp")
        self.assertTrue(site.docked)
        self.assertEqual(site.suggested_name, "Hestia Depot")
        self.assertEqual(self.tracker.commander, "CMDR Test")
        # До события депота ресурсов нет.
        self.assertFalse(site.has_depot)

        self.tracker.handle("", DEPOT)
        self.assertTrue(site.has_depot)
        self.assertEqual(site.total_required, 9025)
        self.assertEqual(site.depot_event, DEPOT)

    def test_depot_without_dock_restores_site(self):
        """Приложение могло стартовать, когда командир уже стоит у площадки."""
        self.tracker.handle("", {
            "timestamp": "t0", "event": "Location", "StarSystem": "Kuma",
            "SystemAddress": 42, "StarPos": [1.0, 2.0, 3.0],
        })
        self.tracker.handle("", DEPOT)
        site = self.tracker.site
        self.assertEqual(site.market_id, 3951663874)
        self.assertEqual(site.system_name, "Kuma")
        self.assertEqual(site.system_address, 42)
        self.assertEqual(site.star_pos, [1.0, 2.0, 3.0])

    def test_ordinary_station_releases_site(self):
        self.tracker.handle("", DOCKED)
        self.assertIsNotNone(self.tracker.current)
        changed = self.tracker.handle("", {
            "timestamp": "t2", "event": "Docked", "StationName": "Jameson Memorial",
            "StationServices": ["dock", "missions"], "MarketID": 128000000,
        })
        self.assertTrue(changed)
        self.assertIsNone(self.tracker.current)
        # Последняя площадка остаётся доступна — форма всё ещё может её показать.
        self.assertIsNotNone(self.tracker.last)

    def test_undock_clears_current_but_keeps_site(self):
        self.tracker.handle("", DOCKED)
        self.tracker.handle("", {"timestamp": "t2", "event": "Undocked", "MarketID": 3951663874})
        self.assertIsNone(self.tracker.current)
        self.assertEqual(self.tracker.last.market_id, 3951663874)

    def test_several_sites_are_remembered(self):
        self.tracker.handle("", DOCKED)
        other = dict(DOCKED, StationName="Orbital Construction Site: Zeus", MarketID=999)
        self.tracker.handle("", other)
        self.assertEqual(len(self.tracker.known_sites()), 2)
        self.assertEqual(self.tracker.site.market_id, 999)

    def test_tracker_never_raises_on_garbage(self):
        self.assertFalse(self.tracker.handle("", None))
        self.assertFalse(self.tracker.handle("", {"event": "Whatever"}))
        self.assertFalse(self.tracker.handle("", {"event": "ColonisationConstructionDepot",
                                                  "MarketID": "not-a-number"}))


class ProjectDraftTests(unittest.TestCase):
    def _site(self) -> ConstructionSite:
        tracker = ConstructionSiteTracker()
        tracker.handle("", dict(DOCKED, StationName="System Colonisation Ship"))
        tracker.handle("", DEPOT)
        return tracker.site

    def test_required_fields_come_from_journal(self):
        draft = build_project_draft(self._site(), build_type="zeus", architect_name="CMDR Test")
        self.assertEqual(draft["marketId"], 3951663874)
        self.assertEqual(draft["systemAddress"], 123456789)
        self.assertEqual(draft["systemName"], "Kuma")
        self.assertEqual(draft["buildName"], "Primary port")
        self.assertEqual(draft["buildType"], "zeus")
        self.assertEqual(draft["starPos"], [10.5, -20.25, 30.125])
        self.assertEqual(draft["bodyNum"], 12)
        self.assertEqual(draft["bodyName"], "Kuma 3 a")
        self.assertEqual(draft["architectName"], "CMDR Test")
        self.assertTrue(draft["isPrimaryPort"])

    def test_commodities_are_outstanding_need(self):
        """Raven хранит в `commodities` остаток, а исходный объём — в `maxNeed`."""
        draft = build_project_draft(self._site())
        self.assertEqual(draft["commodities"], {"liquidoxygen": 1865, "steel": 5960})
        self.assertEqual(draft["maxNeed"], 9025)

    def test_depot_event_is_attached(self):
        draft = build_project_draft(self._site())
        self.assertEqual(draft["colonisationConstructionDepot"], DEPOT)
        self.assertNotIn("colonisationConstructionDepot",
                         build_project_draft(self._site(), include_depot=False))

    def test_empty_optional_fields_are_not_sent(self):
        draft = build_project_draft(self._site(), notes="", discord_link="", system_site_id="")
        for key in ("notes", "discordLink", "systemSiteId", "factionName"):
            self.assertNotIn(key, draft)

    def test_commanders_and_site_id(self):
        draft = build_project_draft(
            self._site(), commanders={"CMDR Test": []}, system_site_id="site-1",
            notes="второй порт", discord_link="https://discord.gg/x",
        )
        self.assertEqual(draft["commanders"], {"CMDR Test": []})
        self.assertEqual(draft["systemSiteId"], "site-1")
        self.assertEqual(draft["notes"], "второй порт")
        self.assertEqual(draft["discordLink"], "https://discord.gg/x")

    def test_explicit_values_win_over_journal(self):
        draft = build_project_draft(self._site(), build_name="Моя стройка", is_primary_port=False)
        self.assertEqual(draft["buildName"], "Моя стройка")
        self.assertFalse(draft["isPrimaryPort"])

    def test_without_site_still_builds_manual_draft(self):
        draft = build_project_draft(None, build_name="Alpha")
        self.assertEqual(draft, {"buildName": "Alpha"})

    def test_format_commodities(self):
        self.assertEqual(format_commodities({"steel": 10, "aluminium": 5}),
                         "aluminium:5, steel:10")
        self.assertEqual(format_commodities({}), "")


class ColonyTabIntegrationTests(unittest.TestCase):
    """Форма создания проекта на вкладке «Колонизатор» (без настоящего Tk)."""

    def setUp(self):
        from test_initial_upload_flow import install_gui_stubs, make_root
        import tempfile

        self.stub = install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch", "journal_parser",
                     "overlay", "ship_tracker", "route_tracker", "game_monitor",
                     "exobiology", "colonisation", "raven_colonial_api"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.root = make_root()

        import colonial_helper  # noqa: E402

        self.module = colonial_helper
        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)
        self.app.raven_api.api_key = "rcc-key"
        # Тесты не должны ходить в сеть: все запросы Raven Colonial подменяем.
        self.app.raven_api.get_system_sites = lambda system: {"ok": False, "error": "test"}
        self.app.raven_api.get_system_architect = lambda system: {"ok": False, "error": "test"}
        self.app.raven_api.get_cmdr_active = lambda cmdr: {"ok": True, "data": []}
        self.app.raven_api.get_primary = lambda cmdr: {"ok": True, "data": ""}
        self.app.raven_api.get_project = lambda address, market_id: None

    def tearDown(self):
        self.tmp.cleanup()

    def _run_threads_inline(self):
        """Запускать фоновые потоки сразу: тест не должен ждать сеть/планировщик."""
        class _SyncThread:
            def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
                self._target = target
                self._args = tuple(args or ())
                self._kwargs = dict(kwargs or {})

            def start(self):
                if self._target is not None:
                    self._target(*self._args, **self._kwargs)

            def join(self, timeout=None):
                return None

        return mock.patch.object(self.module.threading, "Thread", _SyncThread)

    def _dock_at_site(self):
        self.app.construction.handle("", DOCKED)
        self.app.construction.handle("", DEPOT)

    def test_form_is_filled_from_journal_site(self):
        self._dock_at_site()
        self.app._colony_autofill_from_site(self.app.construction.site, auto=True)

        fields = self.app.colony_fields
        self.assertEqual(fields["systemName"].get(), "Kuma")
        self.assertEqual(fields["marketId"].get(), "3951663874")
        self.assertEqual(fields["systemAddress"].get(), "123456789")
        self.assertEqual(fields["buildName"].get(), "Hestia Depot")
        self.assertEqual(fields["bodyName"].get(), "Kuma 3 a")
        self.assertEqual(fields["bodyNum"].get(), "12")
        self.assertEqual(fields["maxNeed"].get(), "9025")
        self.assertIn("steel:5960", self.app.colony_commodities_var.get())
        self.assertIn("liquidoxygen:1865", self.app.colony_commodities_var.get())
        # Aluminium закрыт полностью — в остатке его нет.
        self.assertNotIn("aluminium", self.app.colony_commodities_var.get())
        self.assertEqual(self.app.colony_starpos_var.get(), "10.5000, -20.2500, 30.1250")
        self.assertFalse(self.app.colony_primary_port_var.get())

    def test_manual_edits_are_not_overwritten_by_autofill(self):
        self.app.colony_fields["buildName"].set("Ручное название")
        self._dock_at_site()
        self.app._colony_form_baseline = {}   # форма «до» была другой
        self.assertTrue(self.app._colony_form_dirty())
        self.app._on_construction_site_changed()
        self.assertEqual(self.app.colony_fields["buildName"].get(), "Ручное название")

    def test_autofill_runs_once_per_site(self):
        self._dock_at_site()
        self.app._on_construction_site_changed()
        self.assertEqual(self.app.colony_fields["buildName"].get(), "Hestia Depot")
        # Повторное событие той же площадки форму не перетирает.
        self.app.colony_fields["buildName"].set("Переименовал")
        self.app._on_construction_site_changed()
        self.assertEqual(self.app.colony_fields["buildName"].get(), "Переименовал")

    def test_create_payload_has_required_fields_and_opens_page(self):
        self._dock_at_site()
        self.app._colony_autofill_from_site(self.app.construction.site, auto=True)
        self.app.colony_fields["buildType"].set("hestia")
        self.app.colony_cmdr_var.set("CMDR Test")

        captured = {}
        opened = []
        self.app.raven_api.create_project = lambda project: captured.update(project=project) or {
            "ok": True, "data": {"buildId": "build-42"}}
        self.app.raven_api.link_cmdr = lambda *a, **k: {"ok": True}
        self.app._colony_open_url = lambda url, what="": opened.append(url)
        self.app._on_colony_refresh = lambda: None

        with self._run_threads_inline():
            self.app._on_colony_create()

        project = captured["project"]
        self.assertEqual(project["marketId"], 3951663874)
        self.assertEqual(project["systemAddress"], 123456789)
        self.assertEqual(project["buildName"], "Hestia Depot")
        self.assertEqual(project["buildType"], "hestia")
        self.assertEqual(project["commodities"], {"liquidoxygen": 1865, "steel": 5960})
        self.assertEqual(project["maxNeed"], 9025)
        self.assertEqual(project["commanders"], {"CMDR Test": []})
        self.assertEqual(opened, ["https://ravencolonial.com/#build=build-42"])

    def test_depot_snapshot_is_dropped_when_market_id_was_edited(self):
        """Чужой snapshot депота не должен уезжать в Raven."""
        self._dock_at_site()
        self.app._colony_autofill_from_site(self.app.construction.site, auto=True)
        self.app.colony_fields["marketId"].set("999999")   # командир поправил руками

        captured = {}
        self.app.raven_api.create_project = lambda project: captured.update(project=project) or {
            "ok": True, "data": {"buildId": "b-1"}}
        self.app.raven_api.link_cmdr = lambda *a, **k: {"ok": True}
        self.app._colony_open_url = lambda url, what="": None
        self.app._on_colony_refresh = lambda: None
        with self._run_threads_inline():
            self.app._on_colony_create()

        self.assertNotIn("colonisationConstructionDepot", captured["project"])
        self.assertEqual(captured["project"]["marketId"], 999999)

    def test_create_is_blocked_without_required_fields(self):
        self.app.raven_api.create_project = mock.MagicMock()
        with self._run_threads_inline():
            self.app._on_colony_create()
        self.app.raven_api.create_project.assert_not_called()

    def test_autofill_can_be_switched_off(self):
        self.app.colony_autofill_var.set(False)
        self._dock_at_site()
        self.app._on_construction_site_changed()
        self.assertEqual(self.app.colony_fields["systemName"].get(), "")

    def test_journal_feed_reaches_tracker_from_parser_hook(self):
        """Хук разбора журнала доводит события до трекера стройплощадок."""
        self.app._feed_construction_site(DEPOT, live=False)
        self.assertEqual(self.app.construction.site.market_id, DEPOT["MarketID"])

    def test_raven_deliveries_use_lowercase_commodities(self):
        """Raven Colonial принимает только `steel`, не `Steel`."""
        self.app.raven_api.get_project = lambda address, market_id: {"buildId": "b-1"}
        sent = {}
        self.app.raven_api.contribute = lambda build_id, cmdr, commodities: sent.update(
            build_id=build_id, cmdr=cmdr, commodities=commodities) or {"ok": True}

        self.app._send_deliveries_to_raven([{
            "system_name": "Kuma", "commodity": "Steel", "amount": 100,
            "market_id": 3951663874, "system_address": 123456789,
        }], "CMDR Test")

        self.assertEqual(sent["commodities"], {"steel": 100})

    def test_carrier_sales_are_not_credited_to_projects(self):
        """Продажа своему авианосцу идёт в /api/fc/.../cargo, не в /contribute."""
        self.app.raven_api.get_project = lambda address, market_id: {"buildId": "b-1"}
        self.app.raven_api.contribute = mock.MagicMock(return_value={"ok": True})

        self.app._send_deliveries_to_raven([{
            "system_name": "Kuma", "commodity": "Steel", "amount": 100,
            "market_id": 3700005632, "system_address": 123456789,
            "source": "carrier_delivery",
        }], "CMDR Test")

        self.app.raven_api.contribute.assert_not_called()

    def test_commodities_field_accepts_tokens_and_display_names(self):
        parse = self.app._parse_commodities
        self.assertEqual(parse("Steel:10, $aluminium_name;:5"), {"steel": 10, "aluminium": 5})


if __name__ == "__main__":
    unittest.main()
