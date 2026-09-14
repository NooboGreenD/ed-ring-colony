"""Тесты карты системы (вкладка «Карта системы»).

Проверяем то, что вкладка рисует, и то, что легко сломать, правя арифметику
прогресса или геометрию:

* процент завезённого груза: журнал (`ColonisationConstructionDepot`), данные
  Raven Colonial (`sumTotal`/`sumNeed` — включая груз ДРУГИХ командиров) и
  планы площадок API v2;
* прогресс не откатывается назад, если Raven отстаёт от журнала, и проект без
  `sumNeed` не выглядит завезённым на 100%;
* тела: звезда/планета/луна, порядок в снимке (луна сразу за своей планетой);
* положение пилота («вы здесь») по Location/Docked/Undocked/Touchdown/прыжкам;
* раскладка `layout()`: детерминирована, всё в границах холста, зум и
  отключение лун работают, стройплощадки получают прогресс-бар;
* память сборщика ограничена (системы/тела/станции не растут бесконечно).
"""

import json
import math
import sys
import tempfile
from datetime import datetime, timezone
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from system_map import (  # noqa: E402
    better_kind,
    map_report,
    KIND_MOON,
    KIND_PLANET,
    KIND_STAR,
    MAX_BODIES_PER_SYSTEM,
    MAX_STATIONS_PER_SYSTEM,
    MapRavenCache,
    STATION_CARRIER,
    STATION_INSTALLATION,
    STATION_MEGASHIP,
    STATION_OTHER,
    STATION_OUTPOST,
    STATION_PORT,
    STATION_PRIMARY_PORT,
    STATION_SETTLEMENT,
    STATION_SITE,
    MapStation,
    SystemMapBuilder,
    classify_signal,
    classify_station,
    commodity_label,
    due_note,
    due_timestamp,
    layout,
    map_summary,
    merged_source,
)

SYSTEM = "HIP 22460"
ADDRESS = 123456789
SITE_MARKET = 3951663874
SITE_NAME = "Planetary Construction Site: A 1"
BODY_1 = f"{SYSTEM} A 1"
BODY_2 = f"{SYSTEM} A 2"
MOON_2A = f"{SYSTEM} A 2 a"
STAR = f"{SYSTEM} A"


# ---------------------------------------------------------------------------
# Заготовки событий
# ---------------------------------------------------------------------------
def location_event(**overrides):
    """Прибытие в систему и стыковка к стройплощадке A 1."""
    event = {
        "event": "Location",
        "timestamp": "2026-09-14T10:00:00Z",
        "StarSystem": SYSTEM,
        "SystemAddress": ADDRESS,
        "StarPos": [1.0, 2.0, 3.0],
        "Docked": True,
        "StationName": SITE_NAME,
        "StationType": "PlanetaryInstallation",
        "MarketID": SITE_MARKET,
        "Body": BODY_1,
        "BodyID": 3,
        "BodyType": "Planet",
        "StationServices": ["colonisationcontribution", "commodities"],
    }
    event.update(overrides)
    return event


def depot_event(resources, **overrides):
    """`ColonisationConstructionDepot`: потребность площадки и сколько завезли."""
    event = {
        "event": "ColonisationConstructionDepot",
        "timestamp": "2026-09-14T10:00:10Z",
        "MarketID": SITE_MARKET,
        "StarSystem": SYSTEM,
        "SystemAddress": ADDRESS,
        "ConstructionName": "A 1",
        "BodyNum": 3,
        "ResourcesRequired": resources,
    }
    event.update(overrides)
    return event


def resource(name, required, provided):
    token = name.lower().replace(" ", "")
    return {
        "Name": f"${token}_name;",
        "Name_Localised": name,
        "RequiredAmount": required,
        "ProvidedAmount": provided,
    }


def scan_event(name, body_id, **overrides):
    event = {
        "event": "Scan",
        "timestamp": "2026-09-14T10:00:03Z",
        "BodyName": name,
        "BodyID": body_id,
        "StarSystem": SYSTEM,
        "SystemAddress": ADDRESS,
    }
    event.update(overrides)
    return event


def scanned_system(builder=None):
    """Система со звездой, двумя планетами, луной и пристыкованным пилотом."""
    builder = builder or SystemMapBuilder()
    builder.handle(location_event())
    builder.handle({"event": "FSSDiscoveryScan", "StarSystem": SYSTEM,
                    "SystemAddress": ADDRESS, "BodyCount": 9, "NonBodyCount": 4})
    builder.handle(scan_event(STAR, 1, StarType="K", DistanceFromArrivalLS=0.0,
                              Radius=5.9e8))
    builder.handle(scan_event(BODY_1, 3, Parents=[{"Star": 1}],
                              PlanetClass="High metal content world",
                              DistanceFromArrivalLS=12.4, Radius=7.4e6, Landable=True))
    builder.handle(scan_event(BODY_2, 4, Parents=[{"Star": 1}],
                              PlanetClass="Class III gas giant",
                              DistanceFromArrivalLS=812.0, Radius=6.1e7))
    builder.handle(scan_event(MOON_2A, 5, Parents=[{"Planet": 4}],
                              PlanetClass="Icy body", DistanceFromArrivalLS=813.1,
                              Radius=1.2e6))
    builder.handle({"event": "SAAScanComplete", "BodyName": BODY_1, "BodyID": 3,
                    "StarSystem": SYSTEM, "ProbesUsed": 3, "EfficiencyTarget": 1})
    return builder


class ClassificationTests(unittest.TestCase):
    """Тип объекта: стройплощадка, порт, авианосец, поселение."""

    def test_construction_site_by_name_and_service(self):
        self.assertEqual(
            classify_station(SITE_NAME, "PlanetaryInstallation",
                             ["colonisationcontribution", "commodities"]),
            STATION_SITE)

    def test_primary_port_site(self):
        # Первый порт системы строит System Colonisation Ship.
        self.assertEqual(classify_station("System Colonisation Ship", "FleetCarrier", None),
                         STATION_PRIMARY_PORT)

    def test_site_name_without_contribution_service_is_plain_installation(self):
        # Имя похоже на площадку, но сервиса колонизации нет: верить имени нельзя.
        self.assertEqual(
            classify_station(SITE_NAME, "PlanetaryInstallation", ["commodities"]),
            STATION_INSTALLATION)

    def test_station_types(self):
        cases = {
            "FleetCarrier": STATION_CARRIER,
            "Orbis Starport": STATION_PORT,
            "Coriolis Starport": STATION_PORT,
            "Outpost": STATION_OUTPOST,
            "Scientific Outpost": STATION_OUTPOST,
            "Settlement": STATION_SETTLEMENT,
            "PlanetaryInstallation": STATION_INSTALLATION,
            "MegaShip": STATION_MEGASHIP,
            "": STATION_OTHER,
            "SomethingOdd": STATION_OTHER,
        }
        for station_type, expected in cases.items():
            self.assertEqual(classify_station("Jameson", station_type, None), expected,
                             f"StationType={station_type!r}")

    def test_signal_tokens(self):
        self.assertEqual(classify_signal("$SAA_SignalType_Station;"), STATION_PORT)
        self.assertEqual(classify_signal("$SAA_SignalType_Carrier;"), STATION_CARRIER)
        self.assertEqual(classify_signal("$SAA_SignalType_Settlement;"), STATION_SETTLEMENT)
        self.assertEqual(classify_signal("$SAA_SignalType_Installation;"),
                         STATION_INSTALLATION)

    def test_signal_unknown_or_empty(self):
        self.assertIsNone(classify_signal(""))
        self.assertIsNone(classify_signal("$SAA_SignalType_Anomie;"))

    def test_better_kind_does_not_downgrade(self):
        # Событие без StationType не должно стирать уже известный тип.
        self.assertEqual(better_kind(STATION_PORT, STATION_OTHER), STATION_PORT)
        self.assertEqual(better_kind(STATION_OTHER, STATION_PORT), STATION_PORT)
        # Уточнение в пользу стройплощадки работает.
        self.assertEqual(better_kind(STATION_PORT, STATION_SITE), STATION_SITE)
        self.assertEqual(better_kind(STATION_OTHER, STATION_OTHER), STATION_OTHER)

    def test_merged_source_is_stable(self):
        # Повторное слияние не должно переключать источник туда-сюда.
        self.assertEqual(merged_source("journal"), "both")
        self.assertEqual(merged_source("both"), "both")
        self.assertEqual(merged_source("raven"), "raven")
        self.assertEqual(merged_source(""), "raven")



class DepotProgressTests(unittest.TestCase):
    """Процент завезённого груза по данным журнала."""

    def test_percent_from_required_and_provided(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        site = builder.snapshot().sites[0]
        self.assertEqual((site.required_tons, site.provided_tons), (5000, 1000))
        self.assertEqual(site.percent_delivered, 20)
        self.assertEqual(site.remaining_tons, 4000)

    def test_percent_sums_all_commodities(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 6680, 1815),
                                    resource("Liquid oxygen", 1865, 120)]))
        site = builder.snapshot().sites[0]
        self.assertEqual(site.required_tons, 8545)
        self.assertEqual(site.provided_tons, 1935)
        self.assertEqual(site.percent_delivered, 23)
        self.assertEqual(site.remaining_tons, 6610)
        self.assertEqual(site.remaining_by_commodity,
                         {"steel": 4865, "liquidoxygen": 1745})

    def test_overdelivery_clamps_to_hundred(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 100, 500)]))
        site = builder.snapshot().sites[0]
        self.assertEqual(site.percent_delivered, 100)
        self.assertEqual(site.remaining_tons, 0)

    def test_progress_fallback_without_resources(self):
        # Бывает площадка без ResourcesRequired — тогда ConstructionProgress.
        builder = scanned_system()
        builder.handle(depot_event([], ConstructionProgress=0.35))
        site = builder.snapshot().sites[0]
        self.assertIsNone(site.required_tons or None)
        self.assertEqual(site.percent_delivered, 35)

    def test_complete_site_is_hundred_percent(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)],
                                   ConstructionComplete=True, ConstructionProgress=0.9))
        site = builder.snapshot().sites[0]
        self.assertTrue(site.complete)
        self.assertEqual(site.percent_delivered, 100)

    def test_caption_shows_percent_and_rest(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        site = builder.snapshot().sites[0]
        self.assertEqual(site.caption, "стройплощадка · 20% · осталось 4 000 t")
        self.assertEqual(site.title, "A 1")

    def test_site_without_name_uses_construction_id(self):
        builder = SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": SYSTEM, "SystemAddress": ADDRESS})
        event = depot_event([resource("Steel", 100, 10)], MarketID=777)
        event.pop("ConstructionName")
        event["ConstructionID"] = 7
        builder.handle(event)
        names = [station.name for station in builder.snapshot().stations]
        self.assertIn("Construction site 7", names)

    def test_site_attaches_to_body_by_number(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        snapshot = builder.snapshot()
        body = next(item for item in snapshot.bodies if item.name == BODY_1)
        self.assertTrue(body.stations, "площадка не привязана к телу")
        self.assertTrue(body.site.is_site)
        self.assertEqual(body.site.body_name, BODY_1)

    def test_depot_without_anything_is_ignored(self):
        builder = scanned_system()
        event = depot_event([])
        event.pop("ConstructionName")
        event.pop("MarketID")
        self.assertFalse(builder.handle(event))


class RavenProjectTests(unittest.TestCase):
    """`GET /api/system/{address}`: активные проекты системы."""

    def project(self, **overrides):
        data = {
            "buildId": "5f1c2b90-0d3a-4d5c-9f2a-1e6b7c8d9e0f",
            "buildName": "A 1",
            "buildType": "PlanetaryInstallation",
            "marketId": SITE_MARKET,
            "bodyNum": 3,
            "sumTotal": 5000,
            "sumNeed": 1000,
            "commodities": {"steel": 1000},
        }
        data.update(overrides)
        return data

    def test_other_commanders_cargo_counted(self):
        # Пилот завёз 1000 t (20%), а Raven знает про 4000 t — остальные
        # довезли другие командиры. На карте должно быть 80%.
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        self.assertTrue(builder.merge_projects(SYSTEM, [self.project()]))
        site = builder.snapshot().sites[0]
        self.assertEqual(site.percent_delivered, 80)
        self.assertEqual(site.remaining_tons, 1000)
        self.assertEqual(site.build_id, self.project()["buildId"])
        self.assertEqual(site.source, "both")

    def test_stale_raven_does_not_rewind_progress(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 4500)]))
        builder.merge_projects(SYSTEM, [self.project()])   # Raven отстаёт: 4000
        site = builder.snapshot().sites[0]
        self.assertEqual(site.percent_delivered, 90)
        self.assertEqual(site.provided_tons, 4500)

    def test_project_without_need_is_not_shown_as_delivered(self):
        builder = SystemMapBuilder()
        builder.handle(location_event(StationName="", StationServices=None, Docked=False,
                                      MarketID=0, StationType=""))
        project = self.project(marketId=222, buildName="C 3", commodities={"steel": 5000})
        project.pop("sumNeed")
        builder.merge_projects(SYSTEM, [project])
        site = builder.snapshot().sites[0]
        self.assertIsNone(site.percent_delivered)
        self.assertEqual(site.required_tons, 0)
        self.assertEqual(site.remaining_tons, 5000)
        self.assertEqual(site.caption, "стройплощадка · осталось 5 000 t")

    def test_merge_is_idempotent(self):
        builder = scanned_system()
        projects = [self.project()]
        self.assertTrue(builder.merge_projects(SYSTEM, projects))
        self.assertFalse(builder.merge_projects(SYSTEM, projects))
        self.assertFalse(builder.merge_projects(SYSTEM, projects))

    def test_project_creates_site_unknown_to_journal(self):
        # Площадка, где пилот ни разу не стыковался: только данные Raven.
        builder = SystemMapBuilder()
        builder.handle(location_event(StationName="", Docked=False, MarketID=0,
                                      StationServices=None, StationType=""))
        builder.merge_projects(SYSTEM, [self.project(marketId=444, buildName="D 4",
                                                     sumTotal=2000, sumNeed=500)])
        snapshot = builder.snapshot()
        self.assertEqual(len(snapshot.stations), 1)
        site = snapshot.sites[0]
        self.assertEqual(site.title, "D 4")
        self.assertEqual(site.percent_delivered, 75)
        self.assertEqual(site.source, "raven")
        self.assertFalse(site.planned)

    def test_project_matched_by_market_id_not_duplicated(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        builder.merge_projects(SYSTEM, [self.project(buildName="Совершенно другое имя")])
        snapshot = builder.snapshot()
        self.assertEqual(len(snapshot.stations), 1)
        self.assertEqual(snapshot.stations[0].market_id, SITE_MARKET)
        self.assertEqual(snapshot.stations[0].build_name, "Совершенно другое имя")

    def test_completed_project_marks_site_done(self):
        builder = scanned_system()
        builder.merge_projects(SYSTEM, [self.project(sumTotal=5000, sumNeed=0,
                                                     complete=True)])
        site = builder.snapshot().sites[0]
        self.assertTrue(site.complete)
        self.assertEqual(site.percent_delivered, 100)
        self.assertEqual(site.remaining_tons, 0)

    def test_primary_port_project_kind(self):
        builder = SystemMapBuilder()
        builder.handle(location_event(StationName="", Docked=False, MarketID=0,
                                      StationServices=None, StationType=""))
        builder.merge_projects(SYSTEM, [self.project(marketId=555,
                                                     buildName="System Colonisation Ship")])
        site = builder.snapshot().sites[0]
        self.assertEqual(site.kind, STATION_PRIMARY_PORT)
        self.assertEqual(site.title, "Primary port")

    def test_garbage_projects_ignored(self):
        builder = scanned_system()
        self.assertFalse(builder.merge_projects(SYSTEM, [None, {}, "строка", 42]))
        self.assertFalse(builder.merge_projects(SYSTEM, "не список"))
        # Пустое имя системы берёт текущую, а без неё — сливать некуда.
        fresh = SystemMapBuilder()
        self.assertFalse(fresh.merge_projects("", [self.project()]))


class SitePlanTests(unittest.TestCase):
    """`GET /api/v2/system/{system}/sites`: планы площадок."""

    def plan(self, **overrides):
        data = {
            "id": "s-2",
            "name": "B 2",
            "buildType": "Orbis Starport",
            "bodyNum": 4,
            "bodyName": BODY_2,
            "status": "planned",
        }
        data.update(overrides)
        return data

    def test_plan_creates_marker_without_progress(self):
        builder = scanned_system()
        self.assertTrue(builder.merge_site_plans(SYSTEM, [self.plan()]))
        snapshot = builder.snapshot()
        planned = [station for station in snapshot.stations if station.planned]
        self.assertEqual(len(planned), 1)
        site = planned[0]
        self.assertEqual(site.title, "B 2")
        self.assertEqual(site.kind, STATION_SITE)
        self.assertIsNone(site.percent_delivered)
        self.assertEqual(site.caption, "стройплощадка · план")
        self.assertEqual(site.body_name, BODY_2)

    def test_plan_attached_to_body(self):
        builder = scanned_system()
        builder.merge_site_plans(SYSTEM, [self.plan()])
        body = next(item for item in builder.snapshot().bodies if item.name == BODY_2)
        self.assertTrue(any(station.planned for station in body.stations))

    def test_demolish_plan_skipped(self):
        builder = scanned_system()
        builder.merge_site_plans(SYSTEM, [self.plan(status="demolish"),
                                          self.plan(name="X 9", status="demolished")])
        self.assertEqual([station.title for station in builder.snapshot().stations
                          if station.planned], [])
        self.assertNotIn("B 2", [station.title for station in builder.snapshot().stations])

    def test_real_construction_not_overridden_by_plan(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        # План на ту же площадку (то же тело) не должен стереть прогресс.
        builder.merge_site_plans(SYSTEM, [self.plan(name="A 1", bodyNum=3,
                                                    bodyName=BODY_1)])
        sites = builder.snapshot().sites
        self.assertEqual(len(sites), 1)
        self.assertFalse(sites[0].planned)
        self.assertEqual(sites[0].percent_delivered, 20)
        self.assertEqual(sites[0].remaining_tons, 4000)

    def test_plan_fills_missing_build_type(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        builder.merge_site_plans(SYSTEM, [self.plan(name="A 1", bodyNum=3,
                                                    bodyName=BODY_1,
                                                    buildType="Orbis Starport")])
        site = builder.snapshot().sites[0]
        self.assertFalse(site.planned)
        self.assertEqual(site.build_type, "Orbis Starport")

    def test_plan_without_name_uses_body(self):
        builder = scanned_system()
        plan = self.plan(name="", bodyNum=4, bodyName=BODY_2)
        builder.merge_site_plans(SYSTEM, [plan])
        titles = [station.title for station in builder.snapshot().stations]
        self.assertIn(BODY_2, titles)
        planned = [station for station in builder.snapshot().stations if station.planned]
        self.assertEqual([station.title for station in planned], [BODY_2])

    def test_merge_is_idempotent(self):
        builder = scanned_system()
        plans = [self.plan()]
        self.assertTrue(builder.merge_site_plans(SYSTEM, plans))
        self.assertFalse(builder.merge_site_plans(SYSTEM, plans))

    def test_garbage_plans_ignored(self):
        builder = scanned_system()
        self.assertFalse(builder.merge_site_plans(SYSTEM, [None, {}, 7]))
        self.assertFalse(builder.merge_site_plans(SYSTEM, [{"status": "planned"}]))


class BodyTests(unittest.TestCase):
    """Тела системы: звезда, планеты, луны, статус сканирования."""

    def test_kinds_and_flags(self):
        snapshot = scanned_system().snapshot()
        kinds = {body.name: body.kind for body in snapshot.bodies}
        self.assertEqual(kinds[STAR], KIND_STAR)
        self.assertEqual(kinds[BODY_1], KIND_PLANET)
        self.assertEqual(kinds[BODY_2], KIND_PLANET)
        self.assertEqual(kinds[MOON_2A], KIND_MOON)
        star = snapshot.star
        self.assertEqual(star.star_type, "K")
        body_1 = next(item for item in snapshot.bodies if item.name == BODY_1)
        self.assertTrue(body_1.landable)
        self.assertTrue(body_1.scanned)
        self.assertTrue(body_1.mapped, "SAAScanComplete не отметил карту тела")
        self.assertEqual(body_1.parent_name, STAR)

    def test_terraformable_detected(self):
        builder = SystemMapBuilder()
        builder.handle(location_event())
        builder.handle(scan_event(f"{SYSTEM} A 4", 9, Parents=[{"Star": 1}],
                                  PlanetClass="High metal content world (terraformable)",
                                  DistanceFromArrivalLS=30.0))
        body = next(item for item in builder.snapshot().bodies
                    if item.name == f"{SYSTEM} A 4")
        self.assertTrue(body.terraformable)

    def test_order_star_planets_then_own_moons(self):
        # Луна идёт сразу за своей планетой, даже если другая планета ближе.
        builder = SystemMapBuilder()
        builder.handle(location_event(Body="", BodyID=None))
        builder.handle(scan_event(STAR, 1, StarType="K"))
        builder.handle(scan_event(BODY_2, 4, Parents=[{"Star": 1}],
                                  PlanetClass="Class III gas giant",
                                  DistanceFromArrivalLS=812.0))
        builder.handle(scan_event(f"{SYSTEM} A 3", 6, Parents=[{"Star": 1}],
                                  PlanetClass="Rocky body",
                                  DistanceFromArrivalLS=812.5))
        builder.handle(scan_event(MOON_2A, 5, Parents=[{"Planet": 4}],
                                  PlanetClass="Icy body", DistanceFromArrivalLS=813.0))
        names = [body.name for body in builder.snapshot().bodies]
        self.assertEqual(names, [STAR, BODY_2, MOON_2A, f"{SYSTEM} A 3"])

    def test_moon_scanned_before_parent_resolved_later(self):
        builder = SystemMapBuilder()
        builder.handle(location_event())
        builder.handle(scan_event(MOON_2A, 5, Parents=[{"Planet": 4}],
                                  PlanetClass="Icy body", DistanceFromArrivalLS=813.0))
        builder.handle(scan_event(BODY_2, 4, Parents=[{"Star": 1}],
                                  PlanetClass="Class III gas giant",
                                  DistanceFromArrivalLS=812.0))
        snapshot = builder.snapshot()
        moon = next(item for item in snapshot.bodies if item.name == MOON_2A)
        self.assertEqual(moon.kind, KIND_MOON)
        self.assertEqual(moon.parent_name, BODY_2)

    def test_known_body_count_from_discovery_scan(self):
        snapshot = scanned_system().snapshot()
        self.assertEqual(snapshot.known_body_count, 9)
        self.assertEqual(len(snapshot.bodies), 4)
        self.assertIn("тел 4 из 9", map_summary(snapshot))

    def test_fss_signal_adds_named_station_only(self):
        builder = scanned_system()
        builder.handle({"event": "FSSSignalDiscovered", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS, "IsStation": True,
                        "SignalName": "$SAA_SignalType_Station;",
                        "SignalName_Localised": "Jameson Memorial"})
        builder.handle({"event": "FSSSignalDiscovered", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS, "IsStation": True,
                        "SignalName": "$SAA_SignalType_Station;",
                        "SignalName_Localised": "Station"})
        builder.handle({"event": "FSSSignalDiscovered", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS, "IsStation": False,
                        "SignalName": "$SAA_SignalType_Settlement;",
                        "SignalName_Localised": "Brood Mother Nest"})
        names = [station.name for station in builder.snapshot().stations]
        self.assertIn("Jameson Memorial", names)
        self.assertNotIn("Station", names)
        self.assertNotIn("Brood Mother Nest", names)

    def test_body_cap(self):
        builder = SystemMapBuilder()
        builder.handle(location_event())
        for index in range(MAX_BODIES_PER_SYSTEM + 40):
            builder.handle(scan_event(f"{SYSTEM} A {index}", index + 10,
                                      Parents=[{"Star": 1}], PlanetClass="Rocky body",
                                      DistanceFromArrivalLS=float(index + 1)))
        self.assertLessEqual(len(builder.snapshot(SYSTEM).bodies), MAX_BODIES_PER_SYSTEM)


class RavenBodyTests(unittest.TestCase):
    """Тела системы из Raven v2: карта не пуста до сканирования."""

    def bodies(self):
        return [
            {"bodyName": f"{SYSTEM} A", "bodyId": 1, "starType": "K",
             "distanceFromArrivalLS": 0.0, "radius": 5.9e8},
            {"bodyName": BODY_1, "bodyId": 3, "planetClass": "High metal content world",
             "distanceFromArrivalLS": 12.4, "radius": 7.4e6, "isLandable": True,
             "parents": [1]},
            {"bodyName": BODY_2, "bodyId": 4, "planetClass": "Class III gas giant",
             "distanceFromArrivalLS": 812.0, "parents": [1]},
            {"bodyName": MOON_2A, "bodyId": 5, "planetClass": "Icy body",
             "distanceFromArrivalLS": 813.1, "parents": [4]},
            {"bodyName": "", "bodyId": 99},
            None,
        ]

    def test_bodies_appear_before_scanning(self):
        builder = SystemMapBuilder()
        builder.handle(location_event(Docked=False, StationName="", MarketID=0,
                                      StationServices=None, StationType="",
                                      Body="", BodyID=None))
        self.assertTrue(builder.merge_bodies(SYSTEM, self.bodies()))
        snapshot = builder.snapshot()
        names = [body.name for body in snapshot.bodies]
        self.assertIn(BODY_1, names)
        self.assertIn(MOON_2A, names)
        body = next(item for item in snapshot.bodies if item.name == BODY_1)
        self.assertTrue(body.from_raven)
        self.assertFalse(body.scanned, "тело из Raven не должно выглядеть отсканированным")
        self.assertTrue(body.landable)
        self.assertEqual(body.kind, KIND_PLANET)
        moon = next(item for item in snapshot.bodies if item.name == MOON_2A)
        self.assertEqual(moon.kind, KIND_MOON)
        self.assertEqual(moon.parent_name, BODY_2)
        star = snapshot.star
        self.assertEqual(star.star_type, "K")

    def test_journal_wins_over_raven(self):
        builder = scanned_system()
        before = builder.snapshot()
        body_before = next(item for item in before.bodies if item.name == BODY_1)
        self.assertTrue(body_before.scanned)
        builder.merge_bodies(SYSTEM, [
            {"bodyName": BODY_1, "planetClass": "Совершенно другой класс",
             "distanceFromArrivalLS": 999.0, "isLandable": False}])
        body = next(item for item in builder.snapshot().bodies if item.name == BODY_1)
        self.assertEqual(body.body_class, "High metal content world")
        self.assertEqual(body.distance_ls, 12.4)
        self.assertTrue(body.landable)
        self.assertTrue(body.scanned)

    def test_merge_is_idempotent(self):
        builder = SystemMapBuilder()
        builder.handle(location_event())
        bodies = self.bodies()
        self.assertTrue(builder.merge_bodies(SYSTEM, bodies))
        self.assertFalse(builder.merge_bodies(SYSTEM, bodies))

    def test_terraformable_and_garbage(self):
        builder = SystemMapBuilder()
        builder.handle(location_event())
        builder.merge_bodies(SYSTEM, [
            {"bodyName": f"{SYSTEM} A 7", "planetClass": "Rocky body (terraformable)",
             "parents": [{"Star": 1}]}])
        body = next(item for item in builder.snapshot().bodies
                    if item.name == f"{SYSTEM} A 7")
        self.assertTrue(body.terraformable)
        self.assertFalse(builder.merge_bodies(SYSTEM, [None, {}, 5]))
        # Пустая система берёт текущую (как merge_projects), а без неё — некуда.
        fresh = SystemMapBuilder()
        self.assertFalse(fresh.merge_bodies("", self.bodies()))

    def test_body_cap_respected(self):
        builder = SystemMapBuilder()
        builder.handle(location_event())
        builder.merge_bodies(SYSTEM, [{"bodyName": f"{SYSTEM} A {i}", "bodyId": i,
                                       "planetClass": "Rocky body"}
                                      for i in range(MAX_BODIES_PER_SYSTEM + 50)])
        self.assertLessEqual(len(builder.snapshot().bodies), MAX_BODIES_PER_SYSTEM)


class MapReportTests(unittest.TestCase):
    """Сводка системы для буфера обмена."""

    def test_report_lists_sites_and_player(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 6680, 1815),
                                    resource("Liquid oxygen", 1865, 120)]))
        builder.handle({"event": "FSSSignalDiscovered", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS, "IsStation": True,
                        "SignalName": "$SAA_SignalType_Station;",
                        "SignalName_Localised": "Jameson Memorial"})
        builder.merge_site_plans(SYSTEM, [{"name": "B 2", "bodyNum": 4,
                                           "bodyName": BODY_2, "status": "planned"}])
        report = map_report(builder.snapshot(), "2.10.2")
        self.assertIn(SYSTEM, report.splitlines()[0])
        self.assertIn("Colonial Helper 2.10.2", report)
        self.assertIn("Тел: 4 из 9, отсканировано 4", report)
        self.assertIn("Стройки:", report)
        self.assertIn("A 1 — 23% (осталось 6 610 t): Сталь 4 865, "
                      "Жидкий кислород 1 745", report)
        self.assertIn("B 2 — план", report)
        self.assertIn("Построено: Jameson Memorial", report)
        self.assertIn(f"Пилот: на станции {SITE_NAME}", report)

    def test_report_without_system(self):
        self.assertEqual(map_report(SystemMapBuilder().snapshot()),
                         "Система неизвестна — включите Watcher или загрузите журналы")


class PlayerPositionTests(unittest.TestCase):
    """Где сейчас пилот — отметка «вы здесь»."""

    def test_docked_at_site(self):
        builder = scanned_system()
        player = builder.snapshot().player
        self.assertTrue(player.docked)
        self.assertEqual(player.station_name, SITE_NAME)
        self.assertEqual(player.market_id, SITE_MARKET)
        self.assertEqual(player.system, SYSTEM)
        self.assertEqual(player.system_address, ADDRESS)
        self.assertEqual(player.star_pos, [1.0, 2.0, 3.0])
        self.assertEqual(player.place, f"на станции {SITE_NAME}")

    def test_undocked_keeps_station_on_map(self):
        builder = scanned_system()
        builder.handle({"event": "Undocked", "StarSystem": SYSTEM,
                        "StationName": SITE_NAME, "MarketID": SITE_MARKET})
        snapshot = builder.snapshot()
        self.assertFalse(snapshot.player.docked)
        self.assertEqual(snapshot.player.station_name, "")
        self.assertTrue(snapshot.stations, "станция пропала с карты после отстыковки")

    def test_fsd_jump_switches_system_and_keeps_previous(self):
        builder = scanned_system()
        builder.handle({"event": "FSDJump", "StarSystem": "Sagittarius A*",
                        "SystemAddress": 2, "StarPos": [10.0, 20.0, 30.0],
                        "JumpDist": 12.3})
        snapshot = builder.snapshot()
        self.assertEqual(snapshot.system, "Sagittarius A*")
        self.assertEqual(snapshot.bodies, [])
        player = snapshot.player
        self.assertFalse(player.docked)
        self.assertTrue(player.in_supercruise)
        self.assertEqual(player.star_pos, [10.0, 20.0, 30.0])
        # Прежняя система ещё в памяти: возврат не пересобирает карту с нуля.
        self.assertEqual(len(builder.snapshot(SYSTEM).bodies), 4)

    def test_carrier_jump(self):
        builder = SystemMapBuilder()
        builder.handle({"event": "CarrierJump", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS, "Docked": True,
                        "StationName": "XW-77B", "StationType": "FleetCarrier",
                        "MarketID": 3700000000})
        player = builder.snapshot().player
        self.assertTrue(player.docked)
        self.assertEqual(player.station_name, "XW-77B")
        self.assertEqual(player.place, "на станции XW-77B")

    def test_touchdown_and_liftoff(self):
        builder = scanned_system()
        builder.handle({"event": "Undocked", "StarSystem": SYSTEM, "StationName": SITE_NAME})
        builder.handle({"event": "SupercruiseExit", "StarSystem": SYSTEM, "Body": BODY_1})
        builder.handle({"event": "Touchdown", "StarSystem": SYSTEM, "Body": BODY_1,
                        "NearestDestination": "Construction Site"})
        self.assertEqual(builder.snapshot().player.place, f"на поверхности {BODY_1}")
        builder.handle({"event": "Liftoff", "StarSystem": SYSTEM, "Body": BODY_1})
        self.assertFalse(builder.snapshot().player.on_surface)

    def test_supercruise_and_approach(self):
        builder = scanned_system()
        builder.handle({"event": "SupercruiseEntry", "StarSystem": SYSTEM})
        self.assertEqual(builder.snapshot().player.place, "в суперкруизе")
        builder.handle({"event": "ApproachBody", "StarSystem": SYSTEM, "Body": BODY_2})
        self.assertEqual(builder.snapshot().player.place, f"у тела {BODY_2}")
        builder.handle({"event": "LeaveBody", "StarSystem": SYSTEM})
        self.assertFalse(builder.snapshot().player.near_body)

    def test_ship_from_loadgame_and_loadout(self):
        builder = SystemMapBuilder()
        builder.handle({"event": "LoadGame", "Ship": "Type9", "ShipName": "HAUL-EWOK",
                        "ShipIdent": "NW-01", "Commander": "Wessex"})
        builder.handle(location_event())
        player = builder.snapshot().player
        self.assertEqual(player.ship_type, "Type9")
        self.assertEqual(player.ship_name, "HAUL-EWOK")
        builder.handle({"event": "Loadout", "Ship": "Python MkII", "ShipName": "HAUL-NEW"})
        player = builder.snapshot().player
        self.assertEqual(player.ship_type, "Python MkII")
        self.assertEqual(player.ship_name, "HAUL-NEW")

    def test_carrier_stats_adds_carrier(self):
        builder = scanned_system()
        builder.handle({"event": "CarrierStats", "Name": "XW-77B", "Callsign": "WB-12",
                        "FuelLevel": 0.7, "JumpRangeCurr": 35.0})
        carriers = [station for station in builder.snapshot().stations
                    if station.kind == STATION_CARRIER]
        self.assertEqual([carrier.name for carrier in carriers], ["XW-77B"])
        self.assertEqual(carriers[0].caption, "авианосец")


class LayoutTests(unittest.TestCase):
    """Раскладка по холсту: детерминизм, границы, зум, прогресс-бары."""

    def fixture(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        builder.handle({"event": "FSSSignalDiscovered", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS, "IsStation": True,
                        "SignalName": "$SAA_SignalType_Station;",
                        "SignalName_Localised": "Jameson Memorial"})
        builder.handle({"event": "CarrierStats", "Name": "XW-77B"})
        builder.merge_site_plans(SYSTEM, [{"name": "B 2", "bodyNum": 4, "bodyName": BODY_2,
                                           "status": "planned", "buildType": "Orbis"}])
        return builder.snapshot()

    def coordinates(self, snapshot, **kwargs):
        return [(item.kind, item.label, round(item.x, 6), round(item.y, 6))
                for item in layout(snapshot, 900, 560, **kwargs)]

    def test_deterministic(self):
        snapshot = self.fixture()
        self.assertEqual(self.coordinates(snapshot), self.coordinates(snapshot))

    def test_everything_inside_canvas(self):
        snapshot = self.fixture()
        for width, height in ((900, 560), (320, 240), (160, 120)):
            items = layout(snapshot, width, height)
            self.assertTrue(items)
            for item in items:
                self.assertGreaterEqual(item.x, 0.0, f"{item.label} x={item.x}")
                self.assertLessEqual(item.x, float(width), f"{item.label} x={item.x}")
                self.assertGreaterEqual(item.y, 0.0, f"{item.label} y={item.y}")
                self.assertLessEqual(item.y, float(height), f"{item.label} y={item.y}")

    def test_star_in_center_and_orbits_grow_with_distance(self):
        snapshot = self.fixture()
        items = layout(snapshot, 900, 560)
        star = next(item for item in items if item.kind == "star")
        self.assertEqual((star.x, star.y), (450.0, 280.0))
        orbits = {item.label: item.orbit_radius for item in items if item.kind == "body"}
        self.assertLess(orbits[BODY_1], orbits[BODY_2],
                        "дальняя планета оказалась на ближнем кольце")

    def test_moon_next_to_parent_and_hidden_on_demand(self):
        snapshot = self.fixture()
        items = layout(snapshot, 900, 560)
        moon = next(item for item in items if item.label == MOON_2A)
        parent = next(item for item in items if item.label == BODY_2)
        self.assertLess(abs(moon.x - parent.x), 40.0)
        self.assertLess(abs(moon.y - parent.y), 40.0)
        without = layout(snapshot, 900, 560, show_moons=False)
        self.assertNotIn(MOON_2A, [item.label for item in without])
        self.assertEqual(len(without), len(items) - 1)

    def test_site_gets_progress_bar(self):
        snapshot = self.fixture()
        items = layout(snapshot, 900, 560)
        by_label = {item.label: item for item in items if item.kind == "station"}
        self.assertEqual(by_label["A 1"].progress, 20)
        self.assertTrue(by_label["A 1"].bar_width > 0)
        self.assertIsNone(by_label["B 2"].progress, "у плана нечего завозить")
        self.assertIsNone(by_label["Jameson Memorial"].progress)
        self.assertIn("20%", by_label["A 1"].caption)

    def test_station_follows_its_body(self):
        snapshot = self.fixture()
        items = layout(snapshot, 900, 560)
        by_label = {item.label: item for item in items}
        site = by_label["A 1"]
        body = by_label[BODY_1]
        self.assertLess(abs(site.x - body.x), 45.0)
        self.assertLess(abs(site.y - body.y), 45.0)

    def test_bodyless_station_on_outer_ring(self):
        snapshot = self.fixture()
        items = layout(snapshot, 900, 560)
        by_label = {item.label: item for item in items}
        carrier = by_label["XW-77B"]
        center = (450.0, 280.0)
        distance = ((carrier.x - center[0]) ** 2 + (carrier.y - center[1]) ** 2) ** 0.5
        self.assertGreater(distance, 150.0, "авианосец без тела потерялся у центра")

    def test_player_marker_on_docked_station(self):
        snapshot = self.fixture()
        items = layout(snapshot, 900, 560)
        players = [item for item in items if item.kind == "player"]
        self.assertEqual(len(players), 1)
        marker = players[0]
        site = next(item for item in items if item.label == "A 1")
        self.assertEqual(marker.label, "Вы здесь")
        self.assertEqual(marker.caption, f"на станции {SITE_NAME}")
        self.assertLess(abs(marker.x - site.x), 1.0)
        self.assertLess(abs(marker.y - site.y), 1.0)

    def test_player_marker_without_dock(self):
        builder = SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": SYSTEM, "SystemAddress": ADDRESS})
        items = layout(builder.snapshot(), 900, 560)
        marker = next(item for item in items if item.kind == "player")
        self.assertEqual(marker.caption, "в суперкруизе")

    def test_labels_do_not_overlap(self):
        """В плотной системе подписи расталкиваются, а не сливаются в кашу."""
        from system_map import _icon_box, label_box

        snapshot = self.fixture()
        items = layout(snapshot, 900, 560)
        boxes = [label_box(item) for item in items if item.label or item.caption]
        icons = [_icon_box(item) for item in items]
        self.assertGreater(len(boxes), 6)

        def overlap(first, second):
            return (first[0] < second[2] and second[0] < first[2]
                    and first[1] < second[3] and second[1] < first[3])

        for index, first in enumerate(boxes):
            for second in boxes[index + 1:]:
                self.assertFalse(overlap(first, second),
                                 f"подписи наезжают: {first} / {second}")
        for box in boxes:
            for icon in icons:
                # Своя подпись начинается ниже своего значка — это не наезд.
                if abs(box[1] - (icon[3] - 2.0)) < 3.0 and box[0] < icon[2] < box[2]:
                    continue
                self.assertFalse(overlap(box, icon),
                                 f"подпись лежит на значке: {box} / {icon}")

    def test_label_shift_is_deterministic(self):
        snapshot = self.fixture()
        first = [item.label_dy for item in layout(snapshot, 900, 560)]
        second = [item.label_dy for item in layout(snapshot, 900, 560)]
        self.assertEqual(first, second)

    def test_zoom_changes_scale(self):
        snapshot = self.fixture()
        normal = layout(snapshot, 900, 560)
        zoomed = layout(snapshot, 900, 560, zoom=2.0)
        far_normal = max(item.orbit_radius for item in normal)
        far_zoomed = max(item.orbit_radius for item in zoomed)
        self.assertGreater(far_zoomed, far_normal)

    def test_selected_marks_item(self):
        snapshot = self.fixture()
        items = layout(snapshot, 900, 560, selected="A 1")
        selected = [item for item in items if item.selected]
        self.assertEqual([item.label for item in selected], ["A 1"])

    def test_empty_snapshot_does_not_crash(self):
        items = layout(SystemMapBuilder().snapshot(), 900, 560)
        self.assertTrue(items)
        self.assertEqual(items[0].kind, "star")


class MemoryLimitTests(unittest.TestCase):
    """Память сборщика ограничена: маршрут из десятков систем не течёт."""

    def test_old_systems_evicted(self):
        builder = SystemMapBuilder(max_systems=2)
        for index, name in enumerate(("Alpha", "Beta", "Gamma")):
            builder.handle({"event": "FSDJump", "StarSystem": name,
                            "SystemAddress": index + 1})
            builder.handle(scan_event(f"{name} A", 1, StarSystem=name, StarType="M"))
        self.assertEqual(builder.current_system, "Gamma")
        self.assertEqual(len(builder.snapshot("Gamma").bodies), 1)
        self.assertEqual(builder.snapshot("Alpha").bodies, [])
        self.assertEqual(len(builder._order), 2)

    def test_station_cap(self):
        builder = SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": SYSTEM, "SystemAddress": ADDRESS})
        for index in range(MAX_STATIONS_PER_SYSTEM + 25):
            builder.handle({"event": "FSSSignalDiscovered", "StarSystem": SYSTEM,
                            "SystemAddress": ADDRESS, "IsStation": True,
                            "SignalName": "$SAA_SignalType_Settlement;",
                            "SignalName_Localised": f"Поселение {index}"})
        self.assertLessEqual(len(builder.snapshot().stations), MAX_STATIONS_PER_SYSTEM)

    def test_reset_clears_everything(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        builder.reset()
        snapshot = builder.snapshot()
        self.assertEqual(snapshot.system, "")
        self.assertEqual(snapshot.bodies, [])
        self.assertEqual(snapshot.stations, [])
        self.assertEqual(map_summary(snapshot),
                         "Система неизвестна — включите Watcher или загрузите журналы")


class SummaryTests(unittest.TestCase):
    """Строка состояния вкладки."""

    def test_summary_lists_sites_and_position(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 5000, 1000)]))
        builder.handle({"event": "FSSSignalDiscovered", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS, "IsStation": True,
                        "SignalName": "$SAA_SignalType_Station;",
                        "SignalName_Localised": "Jameson Memorial"})
        summary = map_summary(builder.snapshot())
        self.assertIn(SYSTEM, summary)
        self.assertIn("тел 4 из 9", summary)
        self.assertIn("строек: 1 (A 1 20%)", summary)
        self.assertIn("построенных объектов: 1", summary)
        self.assertIn(f"вы на станции {SITE_NAME}", summary)

    def test_summary_without_scans(self):
        builder = SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": SYSTEM, "SystemAddress": ADDRESS})
        summary = map_summary(builder.snapshot())
        self.assertIn("тела не отсканированы", summary)
        self.assertIn("вы в суперкруизе", summary)

    def test_summary_with_plans(self):
        builder = scanned_system()
        builder.merge_site_plans(SYSTEM, [{"name": "B 2", "bodyNum": 4, "bodyName": BODY_2,
                                           "status": "planned"}])
        summary = map_summary(builder.snapshot())
        self.assertIn("строек: 2", summary)
        self.assertIn("B 2", summary)


class RobustnessTests(unittest.TestCase):
    """Журнал бывает кривым: карта не должна падать."""

    def test_non_dict_and_unknown_events(self):
        builder = SystemMapBuilder()
        self.assertFalse(builder.handle(None))
        self.assertFalse(builder.handle("строка"))
        self.assertFalse(builder.handle({"event": "Music"}))
        self.assertFalse(builder.handle({"timestamp": "2026-09-14T10:00:00Z"}))

    def test_malformed_values(self):
        builder = SystemMapBuilder()
        self.assertTrue(builder.handle({"event": "Location", "StarSystem": SYSTEM,
                                        "SystemAddress": "не число", "Docked": "yes",
                                        "MarketID": None, "StationName": None}))
        self.assertTrue(builder.handle({"event": "Scan", "BodyName": f"{SYSTEM} A",
                                        "StarSystem": SYSTEM, "BodyID": "1",
                                        "Parents": "не список",
                                        "DistanceFromArrivalLS": None, "Radius": []}))
        self.assertTrue(builder.handle({"event": "ColonisationConstructionDepot",
                                        "StarSystem": SYSTEM, "MarketID": 1,
                                        "ConstructionName": "A 1",
                                        "ResourcesRequired": [None, "мусор", {}]}))
        snapshot = builder.snapshot()
        self.assertEqual(snapshot.system, SYSTEM)
        self.assertTrue(snapshot.stations)

    def test_event_without_system_uses_current(self):
        builder = scanned_system()
        builder.handle({"event": "SAAScanComplete", "BodyName": BODY_2, "BodyID": 4})
        body = next(item for item in builder.snapshot().bodies if item.name == BODY_2)
        self.assertTrue(body.mapped)

    def test_station_alias_merged_by_market_id(self):
        # Сигнал FSS дал имя, стыковка — MarketID: на карте должен быть один значок.
        builder = SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": SYSTEM, "SystemAddress": ADDRESS})
        builder.handle({"event": "FSSSignalDiscovered", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS, "IsStation": True,
                        "SignalName": "$SAA_SignalType_Station;",
                        "SignalName_Localised": "Jameson Memorial"})
        builder.handle({"event": "Docked", "StarSystem": SYSTEM,
                        "StationName": "Jameson Memorial", "StationType": "Orbis Starport",
                        "MarketID": 128665509})
        stations = builder.snapshot().stations
        self.assertEqual(len(stations), 1)
        self.assertEqual(stations[0].market_id, 128665509)
        self.assertEqual(stations[0].kind, STATION_PORT)

    def test_undocked_does_not_downgrade_known_kind(self):
        # `Undocked` приходит без StationType: станция должна остаться портом.
        builder = SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": SYSTEM, "SystemAddress": ADDRESS})
        builder.handle({"event": "Docked", "StarSystem": SYSTEM,
                        "StationName": "Jameson Terminal", "StationType": "Orbis Starport",
                        "MarketID": 128665509})
        builder.handle({"event": "Undocked", "StarSystem": SYSTEM,
                        "StationName": "Jameson Terminal", "MarketID": 128665509})
        stations = builder.snapshot().stations
        self.assertEqual(len(stations), 1)
        self.assertEqual(stations[0].kind, STATION_PORT,
                         "после отстыковки тип станции ухудшился")
        self.assertEqual(stations[0].caption, "станция")

    def test_snapshot_of_other_system(self):
        builder = scanned_system()
        builder.handle({"event": "FSDJump", "StarSystem": "Другая", "SystemAddress": 5})
        other = builder.snapshot(SYSTEM)
        self.assertEqual(other.system, SYSTEM)
        self.assertEqual(len(other.bodies), 4)
        self.assertEqual(other.system_address, 0, "адрес чужой системы выдавать нельзя")

    def test_every_map_event_has_handler(self):
        from system_map import MAP_EVENTS
        builder = SystemMapBuilder()
        missing = [name for name in sorted(MAP_EVENTS)
                   if getattr(builder, f"_on_{name.lower()}", None) is None]
        self.assertEqual(missing, [], f"события без обработчика: {missing}")

    def test_station_dataclass_defaults(self):
        station = MapStation(name="Тест")
        self.assertIsNone(station.percent_delivered)
        self.assertEqual(station.remaining_tons, 0)
        self.assertFalse(station.is_site)
        self.assertEqual(station.title, "Тест")
        self.assertEqual(station.caption, "объект")


if __name__ == "__main__":
    unittest.main()


def raven_v2_bodies():
    """Кусок НАСТОЯЩЕГО ответа `GET /api/v2/system/HIP 22460`.

    Форма ответа отличается от журнальной: `num` вместо BodyID, `distLS` вместо
    DistanceFromArrivalLS, класс — в `subType` (в `type` короткий код), посадка —
    в списке `features`, радиус — в километрах и -1 вместо «неизвестно». Звезда
    приходит с `"type": "st"` и `num: 0`, плюс есть служебные записи: пояс
    астероидов (`"type": "ac"`) и барицентры (`"type": "bc"`).
    """
    return [
        {"name": "HIP 22460", "num": 0, "distLS": 0, "parents": [], "type": "st",
         "subType": "F (White) Star", "features": [], "radius": -1,
         "temp": 7147, "gravity": -1},
        {"name": "HIP 22460 A Belt", "num": 100000, "distLS": 6.986333191877696,
         "parents": [0], "type": "ac", "subType": "Metallic", "features": [],
         "radius": -1, "temp": 7147, "gravity": -1},
        {"name": "HIP 22460 1", "num": 5, "distLS": 45.876972, "parents": [0],
         "type": "hmc", "subType": "High metal content world",
         "features": ["landable", "geo", "rings", "volcanism", "tidal"],
         "radius": 9284.441, "temp": 967.035767, "gravity": 1.1765807076578},
        {"name": "HIP 22460 3", "num": 20, "distLS": 210.889612, "parents": [0],
         "type": "hmc", "subType": "High metal content world",
         "features": ["landable", "geo", "rings", "volcanism", "tidal"],
         "radius": 7750.072, "temp": 450.99, "gravity": 1.549},
        {"name": "HIP 22460 3 a", "num": 22, "distLS": 211.249559, "parents": [20, 0],
         "type": "rb", "subType": "Rocky body", "features": ["landable", "tidal"],
         "radius": 478.12615625, "temp": 450.99, "gravity": 0.055},
        {"name": "HIP 22460 barycentre 55", "num": 55, "distLS": 0, "parents": [],
         "type": "bc", "features": [], "radius": -1, "temp": -1, "gravity": -1},
        {"name": "HIP 22460 8", "num": 56, "distLS": 1122.007374, "parents": [55, 0],
         "type": "gg", "subType": "Gas giant with water-based life",
         "features": ["rings"], "radius": 70979.76, "temp": 238.56, "gravity": 2.908},
        {"name": "HIP 22460 13", "num": 93, "distLS": 2465.260776, "parents": [92, 0],
         "type": "gg", "subType": "Class III gas giant", "features": ["rings"],
         "radius": 71640.68, "temp": 507.56, "gravity": 15.075},
        {"name": "HIP 22460 13 e", "num": 99, "distLS": 2469.588361,
         "parents": [93, 92, 0], "type": "rb", "subType": "Rocky body",
         "features": ["landable", "bio", "tidal", "atmosphere"], "radius": 1370.6825},
        {"name": "HIP 22460 13 e a", "num": 100, "distLS": 2469.580469,
         "parents": [99, 93, 92, 0], "type": "rb", "subType": "Rocky body",
         "features": ["landable", "geo", "volcanism", "tidal"], "radius": 457.621},
    ]


class RavenV2RealPayloadTests(unittest.TestCase):
    """Тела из настоящего ответа Raven v2: карта не пустая до сканирования."""

    def builder(self, bodies=None):
        builder = SystemMapBuilder()
        builder.handle(location_event(Docked=False, StationName="", MarketID=0,
                                      StationServices=None, StationType="",
                                      Body="", BodyID=None))
        builder.merge_bodies(SYSTEM, raven_v2_bodies() if bodies is None else bodies)
        return builder

    def body(self, builder, name):
        found = [item for item in builder.snapshot().bodies if item.name == name]
        self.assertEqual(len(found), 1, f"тело {name} не найдено")
        return found[0]

    def test_kinds_star_planet_moon(self):
        builder = self.builder()
        star = self.body(builder, SYSTEM)
        self.assertEqual(star.kind, KIND_STAR)
        self.assertEqual(star.star_type, "F", "из «F (White) Star» нужен короткий класс")
        self.assertEqual(star.body_id, 0, "звезда Raven имеет num 0")
        self.assertFalse(star.body_class, "у звезды класс не показываем")
        planet = self.body(builder, "HIP 22460 1")
        self.assertEqual(planet.kind, KIND_PLANET,
                         "планета с parents=[звезда] не должна стать луной")
        self.assertEqual(planet.parent_name, SYSTEM)
        moon = self.body(builder, "HIP 22460 3 a")
        self.assertEqual(moon.kind, KIND_MOON)
        self.assertEqual(moon.parent_name, "HIP 22460 3")

    def test_submoon_resolves_through_moon_parent(self):
        builder = self.builder()
        self.assertEqual(self.body(builder, "HIP 22460 13 e").kind, KIND_MOON)
        submoon = self.body(builder, "HIP 22460 13 e a")
        self.assertEqual(submoon.kind, KIND_MOON)
        self.assertEqual(submoon.parent_name, "HIP 22460 13 e")

    def test_order_of_bodies_does_not_matter(self):
        """Raven отдаёт тела в своём порядке — дети могут прийти раньше родителей."""
        builder = self.builder(bodies=list(reversed(raven_v2_bodies())))
        self.assertEqual(self.body(builder, "HIP 22460 3 a").kind, KIND_MOON)
        self.assertEqual(self.body(builder, "HIP 22460 13 e a").kind, KIND_MOON)
        self.assertEqual(self.body(builder, "HIP 22460 1").kind, KIND_PLANET)

    def test_service_records_are_skipped(self):
        names = [body.name for body in self.builder().snapshot().bodies]
        self.assertNotIn("HIP 22460 A Belt", names, "пояс астероидов не тело")
        self.assertNotIn("HIP 22460 barycentre 55", names, "барицентр не тело")
        self.assertEqual(len(names), len(raven_v2_bodies()) - 2)

    def test_barycentre_child_becomes_planet_of_star(self):
        """Родитель-барицентр пропущен, поэтому планета висит на звезде."""
        body = self.body(self.builder(), "HIP 22460 8")
        self.assertEqual(body.kind, KIND_PLANET)
        self.assertEqual(body.parent_name, SYSTEM)

    def test_fields_distLS_subType_features_radius_km(self):
        builder = self.builder()
        planet = self.body(builder, "HIP 22460 1")
        self.assertAlmostEqual(planet.distance_ls, 45.876972, places=5)
        self.assertEqual(planet.body_class, "High metal content world")
        self.assertTrue(planet.landable, "посадка приходит в features")
        self.assertAlmostEqual(planet.radius_m, 9284441.0, delta=1.0)
        self.assertTrue(planet.from_raven)
        self.assertFalse(planet.scanned)
        giant = self.body(builder, "HIP 22460 8")
        self.assertFalse(giant.landable, "features без «landable» — посадки нет")
        star = self.body(builder, SYSTEM)
        self.assertEqual(star.radius_m, 0.0, "radius -1 означает «неизвестно»")

    def test_terraformable_from_subtype(self):
        bodies = raven_v2_bodies()
        bodies[3]["subType"] = "High metal content world (Terraformable)"
        builder = self.builder(bodies=bodies)
        self.assertTrue(self.body(builder, "HIP 22460 3").terraformable)

    def test_journal_still_wins(self):
        builder = scanned_system()
        journal_body = next(item for item in builder.snapshot().bodies
                            if item.name == BODY_1)
        self.assertTrue(journal_body.scanned)
        builder.merge_bodies(SYSTEM, [
            {"name": BODY_1, "num": 3, "distLS": 999.0, "parents": [0], "type": "rb",
             "subType": "Rocky body", "features": [], "radius": 100.0}])
        body = next(item for item in builder.snapshot().bodies if item.name == BODY_1)
        self.assertTrue(body.scanned)
        self.assertEqual(body.body_class, "High metal content world")
        self.assertAlmostEqual(body.distance_ls, 12.4, places=3)
        self.assertTrue(body.landable, "Raven без features не отменяет посадку")
        self.assertFalse(body.from_raven)

    def test_merge_is_idempotent(self):
        builder = SystemMapBuilder()
        builder.handle(location_event(Docked=False, StationName="", MarketID=0,
                                      StationServices=None, StationType="",
                                      Body="", BodyID=None))
        bodies = raven_v2_bodies()
        self.assertTrue(builder.merge_bodies(SYSTEM, bodies))
        self.assertFalse(builder.merge_bodies(SYSTEM, bodies))

    def test_project_attaches_to_raven_body(self):
        """Стройка Raven ложится на тело из того же ответа (bodyNum -> num)."""
        builder = self.builder()
        builder.merge_projects(SYSTEM, [
            {"buildId": "guid-v2-1", "buildName": "1", "marketId": 900001,
             "buildType": "PlanetaryInstallation", "bodyNum": 5,
             "sumTotal": 4000, "sumNeed": 1500, "commodities": {"steel": 1500}}])
        station = next(item for item in builder.snapshot().stations
                       if item.build_id == "guid-v2-1")
        self.assertEqual(station.body_name, "HIP 22460 1")
        self.assertEqual(station.percent_delivered, 62)

    def test_project_without_body_does_not_grab_the_star(self):
        builder = self.builder()
        builder.merge_projects(SYSTEM, [
            {"buildId": "guid-v2-2", "buildName": "Порт", "marketId": 900002,
             "buildType": "Orbis Starport", "bodyNum": 0}])
        station = next(item for item in builder.snapshot().stations
                       if item.build_id == "guid-v2-2")
        self.assertEqual(station.body_name, "")
        star = self.body(builder, SYSTEM)
        self.assertFalse(star.stations, "звезда не должна обрастать стройками")

    def test_layout_handles_raven_only_system(self):
        snapshot = self.builder().snapshot()
        items = layout(snapshot, 900, 620, zoom=1.0, show_moons=True)
        kinds = {item.kind for item in items}
        self.assertIn("star", kinds)
        self.assertIn("body", kinds)
        for item in items:
            self.assertGreaterEqual(item.x, -1.0)
            self.assertLessEqual(item.x, 901.0)
            self.assertGreaterEqual(item.y, -1.0)
            self.assertLessEqual(item.y, 621.0)


class MapRavenCacheTests(unittest.TestCase):
    """Кэш последнего ответа Raven: мгновенная карта без сети и без распухания."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "map_cache.json"

    def cache(self, **kwargs):
        return MapRavenCache(self.path, **kwargs)

    def test_roundtrip(self):
        cache = self.cache()
        self.assertEqual(cache.load(SYSTEM), {}, "пустой кэш молчит")
        self.assertTrue(cache.store(SYSTEM, bodies=[{"name": BODY_1}],
                                    projects=[{"buildId": "x"}], plans=[]))
        entry = cache.load(SYSTEM)
        self.assertEqual(entry.get("bodies"), [{"name": BODY_1}])
        self.assertEqual(entry.get("projects"), [{"buildId": "x"}])
        self.assertEqual(entry.get("plans"), [])
        self.assertIn("ts", entry)

    def test_garbage_in_payload_is_dropped(self):
        self.assertTrue(self.cache().store(SYSTEM, bodies=[{"name": BODY_1}, None, 5]))
        self.assertEqual(self.cache().load(SYSTEM)["bodies"], [{"name": BODY_1}])

    def test_corrupt_file_is_not_fatal(self):
        self.path.write_text("{это не json", encoding="utf-8")
        self.assertEqual(self.cache().load(SYSTEM), {})
        self.assertTrue(self.cache().store(SYSTEM, bodies=[{"name": BODY_1}]))
        self.assertEqual(self.cache().load(SYSTEM)["bodies"], [{"name": BODY_1}])

    def test_only_fresh_systems_survive(self):
        cache = self.cache(max_systems=3)
        for index in range(5):
            self.assertTrue(cache.store(f"SYS {index}", bodies=[{"name": f"B{index}"}]))
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual(sorted(data), ["SYS 2", "SYS 3", "SYS 4"])

    def test_empty_payload_not_stored(self):
        self.assertFalse(self.cache().store(SYSTEM))
        self.assertFalse(self.cache().store(""))
        self.assertEqual(self.cache().load(SYSTEM), {})

    def test_no_path_is_safe(self):
        cache = MapRavenCache(None)
        self.assertFalse(cache.store(SYSTEM, bodies=[{"name": BODY_1}]))
        self.assertEqual(cache.load(SYSTEM), {})


class CommodityLabelTests(unittest.TestCase):
    """Русские названия товаров в сводке: ключи Raven слепые и строчные."""

    def test_known_keys(self):
        self.assertEqual(commodity_label("steel"), "Сталь")
        self.assertEqual(commodity_label("liquidoxygen"), "Жидкий кислород")
        self.assertEqual(commodity_label("STEEL"), "Сталь", "регистр не важен")

    def test_unknown_key_untouched(self):
        self.assertEqual(commodity_label("unobtainium"), "unobtainium")
        self.assertEqual(commodity_label(""), "")


class LayoutCenterTests(unittest.TestCase):
    """Двойной клик: карта центрируется на объекте, вся геометрия едет вместе."""

    def test_center_on_body(self):
        snapshot = scanned_system().snapshot()
        plain = layout(snapshot, 900, 600)
        centered = layout(snapshot, 900, 600, center_on=BODY_1)
        target = next(item for item in centered if item.label == BODY_1)
        self.assertAlmostEqual(target.x, 450.0, delta=0.5)
        self.assertAlmostEqual(target.y, 300.0, delta=0.5)
        plain_target = next(item for item in plain if item.label == BODY_1)
        dx, dy = 450.0 - plain_target.x, 300.0 - plain_target.y
        self.assertTrue(abs(dx) + abs(dy) > 1.0, "тело и так было в центре?")
        for before, after in zip(plain, centered):
            self.assertAlmostEqual(after.x - before.x, dx, delta=0.01)
            self.assertAlmostEqual(after.y - before.y, dy, delta=0.01)
            self.assertAlmostEqual(after.pan_x, dx, delta=0.01)
            self.assertAlmostEqual(after.pan_y, dy, delta=0.01)

    def test_center_unknown_keeps_star(self):
        snapshot = scanned_system().snapshot()
        plain = layout(snapshot, 900, 600)
        centered = layout(snapshot, 900, 600, center_on="нет такого тела")
        star = next(item for item in centered if item.kind == "star")
        self.assertAlmostEqual(star.x, 450.0, delta=0.5)
        self.assertAlmostEqual(star.y, 300.0, delta=0.5)
        for before, after in zip(plain, centered):
            self.assertAlmostEqual(after.x, before.x, delta=0.01)
            self.assertAlmostEqual(after.y, before.y, delta=0.01)


class ProjectDueTests(unittest.TestCase):
    """Дедлайн проекта Raven (timeDue) доезжает до сводки."""

    NOW = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)

    def test_due_note_wording(self):
        self.assertEqual(due_note("2026-10-05T12:00:00Z", now=self.NOW),
                         "дедлайн через 21 дн (05.10)")
        self.assertEqual(due_note("2026-09-14T18:00:00Z", now=self.NOW),
                         "дедлайн сегодня (14.09)")
        self.assertEqual(due_note("2026-09-11T12:00:00Z", now=self.NOW),
                         "дедлайн просрочен на 3 дн (11.09)")
        self.assertEqual(due_note("", now=self.NOW), "")
        self.assertEqual(due_note("не дата", now=self.NOW), "")

    def test_merge_projects_keeps_timeDue(self):
        builder = scanned_system()
        builder.merge_projects(SYSTEM, [
            {"buildId": "guid-due", "buildName": "A 1", "marketId": SITE_MARKET,
             "sumTotal": 1000, "sumNeed": 100,
             "timeDue": "2026-10-05T12:00:00Z"}])
        station = next(item for item in builder.snapshot().stations
                       if item.build_id == "guid-due")
        self.assertEqual(station.due_at, "2026-10-05T12:00:00Z")

    def test_report_shows_deadline(self):
        builder = scanned_system()
        builder.handle(depot_event([resource("Steel", 6680, 1815)]))
        builder.merge_projects(SYSTEM, [
            {"buildId": "guid-due", "buildName": "A 1", "marketId": SITE_MARKET,
             "timeDue": "2026-10-05T12:00:00Z"}])
        report = map_report(builder.snapshot(), "2.10.6")
        self.assertIn("дедлайн через", report)
        self.assertIn("(05.10)", report)


class DueTimestampTests(unittest.TestCase):
    """Сортировка списка по дедлайну опирается на due_timestamp."""

    def test_empty_and_garbage_are_infinity(self):
        self.assertEqual(due_timestamp(""), math.inf)
        self.assertEqual(due_timestamp("не дата"), math.inf)

    def test_order_and_naive_utc(self):
        early = due_timestamp("2026-09-20T00:00:00Z")
        late = due_timestamp("2026-12-01T00:00:00+00:00")
        naive = due_timestamp("2026-09-20T00:00:00")
        self.assertLess(early, late)
        self.assertEqual(early, naive, "наивное время считаем UTC")


class UnscannedCounterTests(unittest.TestCase):
    """2.10.8: сводка сообщает, сколько тел журнал ещё не видел."""

    def test_counter_when_partial(self):
        # Raven добавил звезду и BODY_2, журнал видел только BODY_1.
        builder = SystemMapBuilder()
        builder.handle(location_event())
        builder.handle(scan_event(BODY_1, 3))
        builder.merge_bodies(SYSTEM, [
            {"bodyName": STAR, "bodyId": 1, "starType": "K",
             "distanceFromArrivalLS": 0.0},
            {"bodyName": BODY_1, "bodyId": 3, "planetClass": "Icy body",
             "distanceFromArrivalLS": 12.4},
            {"bodyName": BODY_2, "bodyId": 4, "planetClass": "Class III gas giant",
             "distanceFromArrivalLS": 812.0},
        ])
        self.assertIn("без скана: 2", map_summary(builder.snapshot()))

    def test_absent_when_all_scanned(self):
        snapshot = scanned_system().snapshot()
        self.assertNotIn("без скана", map_summary(snapshot))

    def test_absent_for_unscanned_empty_system(self):
        # Нет тел вовсе — остаётся прежняя формулировка «тела не отсканированы».
        builder = SystemMapBuilder()
        builder.handle({"event": "FSDJump", "StarSystem": SYSTEM,
                        "SystemAddress": ADDRESS})
        summary = map_summary(builder.snapshot())
        self.assertIn("тела не отсканированы", summary)
        self.assertNotIn("без скана", summary)


class OrbitRingTests(unittest.TestCase):
    """2.10.9: луны стоят на кольцах вокруг планеты, радиус кольца — из полуоси.

    Журнал Elite Dangerous даёт `SemiMajorAxis` (метры): у планет это почти
    дистанция от звезды, у лун — радиус орбиты вокруг планеты. Raven v2 полуосей
    не даёт, поэтому для лун оценка — |distLS луны − distLS планеты|.
    """

    MOON_2B = f"{SYSTEM} A 2 b"

    def test_scan_semi_major_axis_becomes_orbit_ls(self):
        builder = SystemMapBuilder()
        builder.handle(location_event())
        builder.handle(scan_event(BODY_1, 3, SemiMajorAxis=349340160000.0))
        body = next(item for item in builder.snapshot().bodies if item.name == BODY_1)
        self.assertAlmostEqual(body.orbit_ls, 349340160000.0 / 299792458.0, places=3)

    def _layout(self):
        builder = SystemMapBuilder()
        builder.handle(location_event())
        builder.handle(scan_event(STAR, 1, StarType="K", DistanceFromArrivalLS=0.0,
                                  Radius=5.9e8))
        builder.handle(scan_event(BODY_2, 4, Parents=[{"Star": 1}],
                                  PlanetClass="Class III gas giant",
                                  DistanceFromArrivalLS=812.0, Radius=6.1e7))
        builder.handle(scan_event(MOON_2A, 5, Parents=[{"Planet": 4}],
                                  PlanetClass="Icy body", DistanceFromArrivalLS=813.1,
                                  Radius=1.2e6, SemiMajorAxis=0.9 * 299792458.0))
        builder.handle(scan_event(self.MOON_2B, 6, Parents=[{"Planet": 4}],
                                  PlanetClass="Rocky body", DistanceFromArrivalLS=816.0,
                                  Radius=9e5, SemiMajorAxis=4.0 * 299792458.0))
        return layout(builder.snapshot(), 900, 560)

    def test_moon_ring_is_centered_on_planet(self):
        items = self._layout()
        planet = next(item for item in items if item.label == BODY_2)
        moon = next(item for item in items if item.label == MOON_2A)
        self.assertGreater(moon.orbit_radius, 0.0, "у луны есть орбитальное кольцо")
        self.assertAlmostEqual(moon.orbit_cx, planet.x, delta=0.01)
        self.assertAlmostEqual(moon.orbit_cy, planet.y, delta=0.01)
        distance = math.hypot(moon.x - planet.x, moon.y - planet.y)
        self.assertAlmostEqual(distance, moon.orbit_radius, delta=0.5,
                               msg="луна стоит НА своём кольце")

    def test_farther_moon_gets_bigger_ring(self):
        items = self._layout()
        near = next(item for item in items if item.label == MOON_2A)
        far = next(item for item in items if item.label == self.MOON_2B)
        self.assertGreater(far.orbit_radius, near.orbit_radius)

    def test_planet_ring_center_is_star(self):
        items = self._layout()
        planet = next(item for item in items if item.label == BODY_2)
        self.assertAlmostEqual(planet.orbit_cx, 450.0, delta=0.01)
        self.assertAlmostEqual(planet.orbit_cy, 280.0, delta=0.01)

    def test_raven_only_moon_still_gets_ring(self):
        # Без журнала полуось неизвестна: кольцо строим по оценке |ΔdistLS|.
        builder = SystemMapBuilder()
        builder.handle(location_event())
        builder.merge_bodies(SYSTEM, [
            {"bodyName": BODY_2, "bodyId": 4, "planetClass": "Class III gas giant",
             "distanceFromArrivalLS": 812.0},
            {"bodyName": MOON_2A, "bodyId": 5, "planetClass": "Icy body",
             "distanceFromArrivalLS": 813.2, "parents": [4]},
        ])
        items = layout(builder.snapshot(), 900, 560)
        planet = next(item for item in items if item.label == BODY_2)
        moon = next(item for item in items if item.label == MOON_2A)
        self.assertGreater(moon.orbit_radius, 0.0)
        self.assertAlmostEqual(moon.orbit_cx, planet.x, delta=0.01)
