"""Тесты учёта груза на авианосце (блок CARRIER в оверлее).

Проверяется ровно то, что видит командир: тоннаж из `CarrierStats`, товары
поимённо по дельтам журнала (`CargoTransfer`, `MarketSell`/`MarketBuy` на
борту FC) и «сколько осталось завезти» против потребности стройплощадки.
"""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from carrier import CarrierState, CarrierTracker, is_carrier_market  # noqa: E402

# Реальные примеры из журнала (формат сверен с Elite Dangerous Player Journal:
# SpaceUsage{TotalCapacity, Crew, Cargo, CargoSpaceReserved, ShipPacks,
# ModulePacks, FreeSpace}; CargoTransfer.Transfers[{Type, Count, Direction}]).
CARRIER_STATS = {
    "timestamp": "2020-03-27T09:42:04Z",
    "event": "CarrierStats",
    "CarrierID": 3700005632,
    "Callsign": "L14-X1J",
    "Name": "Spirula",
    "DockingAccess": "all",
    "FuelLevel": 63,
    "PendingDecommission": False,
    "SpaceUsage": {
        "TotalCapacity": 25000,
        "Crew": 5450,
        "Cargo": 440,
        "CargoSpaceReserved": 44,
        "ShipPacks": 774,
        "ModulePacks": 913,
        "FreeSpace": 17379,
    },
}

DOCKED_FC = {
    "timestamp": "2020-03-25T15:55:56Z",
    "event": "Docked",
    "StationName": "FC Spirula",
    "StationType": "FleetCarrier",
    "MarketID": 3700005632,
    "StarSystem": "Hermitage",
    "SystemAddress": 5363877956440,
}

DOCKED_STATION = {
    "timestamp": "2020-03-25T15:55:56Z",
    "event": "Docked",
    "StationName": "Jameson Memorial",
    "StationType": "Orbis Starport",
    "MarketID": 128695050,
    "StarSystem": "Shinrarta Dezhra",
    "SystemAddress": 3932277478114,
}

TRANSFER_TO_CARRIER = {
    "timestamp": "2023-10-18T15:54:12Z",
    "event": "CargoTransfer",
    "Transfers": [
        {"Type": "$steel_name;", "Type_Localised": "Steel", "Count": 120, "Direction": "tocarrier"},
        {"Type": "tritium", "Type_Localised": "Tritium", "Count": 300, "Direction": "tocarrier"},
    ],
}

TRANSFER_TO_SHIP = {
    "timestamp": "2023-10-18T15:56:37Z",
    "event": "CargoTransfer",
    "Transfers": [
        {"Type": "steel", "Count": 20, "Direction": "toship"},
        {"Type": "grain", "Count": 5, "Direction": "tosrv"},
    ],
}


class CarrierMarketIdTests(unittest.TestCase):
    def test_carrier_market_range(self):
        self.assertTrue(is_carrier_market(3700005632))
        self.assertTrue(is_carrier_market("3799999999"))
        self.assertFalse(is_carrier_market(128695050))   # обычная станция
        self.assertFalse(is_carrier_market(3800000000))  # граница не включена
        self.assertFalse(is_carrier_market(None))
        self.assertFalse(is_carrier_market("мусор"))


class CarrierStatsTests(unittest.TestCase):
    def setUp(self):
        self.tracker = CarrierTracker()

    def test_stats_give_tonnage_and_capacity(self):
        self.assertTrue(self.tracker.handle(CARRIER_STATS))
        state = self.tracker.state
        self.assertEqual(state.carrier_id, 3700005632)
        self.assertEqual(state.market_id, 3700005632)
        self.assertEqual(state.name, "Spirula")
        self.assertEqual(state.callsign, "L14-X1J")
        self.assertTrue(state.stats_seen)
        self.assertEqual(state.stored, 440)
        # Вместимость под груз — занятое + свободное, а не TotalCapacity:
        # в 25000 входят экипаж, ангары и модульные паки.
        self.assertEqual(state.cargo_capacity, 440 + 17379)
        self.assertEqual(state.free, 17379)
        self.assertEqual(state.reserved, 44)
        self.assertEqual(state.fill_percent, 2)
        self.assertIn("Spirula", state.summary())

    def test_unknown_until_stats_arrive(self):
        state = CarrierState()
        self.assertFalse(state.known)
        self.assertEqual(state.cargo_capacity, 0)
        self.assertEqual(state.fill_percent, 0)
        data = state.get_state_dict()
        self.assertFalse(data["stats_seen"])
        self.assertEqual(data["commodities"], [])

    def test_ignores_unrelated_events(self):
        self.assertFalse(self.tracker.handle({"event": "FSDJump", "StarSystem": "Kuma"}))
        self.assertFalse(self.tracker.handle({"event": "CargoTransfer"}))
        self.assertFalse(self.tracker.handle("не словарь"))
        self.assertFalse(self.tracker.handle(None))
        self.assertFalse(self.tracker.state.known)


class CarrierDockingTests(unittest.TestCase):
    def setUp(self):
        self.tracker = CarrierTracker()

    def test_dock_at_carrier(self):
        self.assertTrue(self.tracker.handle(DOCKED_FC))
        state = self.tracker.state
        self.assertTrue(state.at_carrier)
        self.assertEqual(state.market_id, 3700005632)
        self.assertEqual(state.name, "FC Spirula")
        self.assertEqual(state.system_name, "Hermitage")
        self.assertEqual(state.system_address, 5363877956440)

    def test_dock_at_station_clears_flag(self):
        self.tracker.handle(DOCKED_FC)
        self.assertTrue(self.tracker.handle(DOCKED_STATION))
        self.assertFalse(self.tracker.state.at_carrier)

    def test_undock(self):
        self.tracker.handle(DOCKED_FC)
        self.assertTrue(self.tracker.handle({"event": "Undocked", "MarketID": 3700005632}))
        self.assertFalse(self.tracker.state.at_carrier)
        # Повторный андок ничего не меняет.
        self.assertFalse(self.tracker.handle({"event": "Undocked", "MarketID": 3700005632}))

    def test_carrier_jump_keeps_us_on_board(self):
        jump = dict(DOCKED_FC, event="CarrierJump", StarSystem="Paesui Xena")
        self.assertTrue(self.tracker.handle(jump))
        self.assertTrue(self.tracker.state.at_carrier)
        self.assertEqual(self.tracker.state.system_name, "Paesui Xena")

    def test_rename_and_decommission(self):
        self.tracker.handle(CARRIER_STATS)
        self.assertTrue(self.tracker.handle(
            {"event": "CarrierNameChanged", "CarrierID": 3700005632, "Name": "Новое имя"}))
        self.assertEqual(self.tracker.state.name, "Новое имя")
        self.assertTrue(self.tracker.handle(
            {"event": "CarrierDecommission", "CarrierID": 3700005632}))
        self.assertTrue(self.tracker.state.pending_decommission)


class CarrierCargoAccountingTests(unittest.TestCase):
    def setUp(self):
        self.tracker = CarrierTracker()
        self.tracker.handle(DOCKED_FC)

    def test_transfer_to_carrier_counts_by_commodity(self):
        self.assertTrue(self.tracker.handle(TRANSFER_TO_CARRIER))
        # Локализационный токен `$steel_name;` приводится к `steel`.
        self.assertEqual(self.tracker.state.commodities["steel"], 120)
        self.assertEqual(self.tracker.state.commodities["tritium"], 300)
        self.assertEqual(self.tracker.state.tracked_total, 420)
        # Локализованное имя запоминается для подписи в оверлее.
        self.assertEqual(self.tracker.state.names["steel"], "Steel")

    def test_transfer_back_subtracts_and_tosrv_ignored(self):
        self.tracker.handle(TRANSFER_TO_CARRIER)
        self.assertTrue(self.tracker.handle(TRANSFER_TO_SHIP))
        self.assertEqual(self.tracker.state.commodities["steel"], 100)
        # `tosrv` — груз уехал в SRV, к авианосцу не относится.
        self.assertNotIn("grain", self.tracker.state.commodities)

    def test_stock_never_negative(self):
        self.tracker.handle({
            "event": "CargoTransfer",
            "Transfers": [{"Type": "steel", "Count": 500, "Direction": "toship"}],
        })
        self.assertEqual(self.tracker.state.commodities.get("steel", 0), 0)

    def test_market_events_only_on_carrier(self):
        self.tracker.handle({
            "event": "MarketSell", "MarketID": 3700005632,
            "Type": "tritium", "Type_Localised": "Tritium", "Count": 50,
        })
        self.assertEqual(self.tracker.state.commodities["tritium"], 50)
        self.tracker.handle({
            "event": "MarketBuy", "MarketID": 3700005632, "Type": "tritium", "Count": 20,
        })
        self.assertEqual(self.tracker.state.commodities["tritium"], 30)
        # Продажа на обычной станции грузом авианосца не считается.
        self.tracker.handle({
            "event": "MarketSell", "MarketID": 128695050, "Type": "gold", "Count": 10,
        })
        self.assertNotIn("gold", self.tracker.state.commodities)

    def test_transfer_without_dock_uses_market_id_range(self):
        tracker = CarrierTracker()
        self.assertTrue(tracker.handle({
            "event": "CargoTransfer", "MarketID": 3700005632,
            "Transfers": [{"Type": "steel", "Count": 10, "Direction": "tocarrier"}],
        }))
        self.assertEqual(tracker.state.commodities["steel"], 10)


class CarrierRemainingTests(unittest.TestCase):
    def setUp(self):
        self.tracker = CarrierTracker()
        self.tracker.handle(CARRIER_STATS)
        self.tracker.handle(DOCKED_FC)
        self.tracker.handle(TRANSFER_TO_CARRIER)

    def test_remaining_against_site_need(self):
        need = {"$steel_name;": 200, "tritium": 300, "gold": 40}
        remaining = self.tracker.state.remaining(need)
        self.assertEqual(remaining["steel"], 80)     # 200 нужно, 120 на борту
        self.assertEqual(remaining["tritium"], 0)    # закрыто
        self.assertEqual(remaining["gold"], 40)      # не завозили

    def test_state_dict_rows_for_overlay(self):
        data = self.tracker.state.get_state_dict({"$steel_name;": 200, "tritium": 300})
        self.assertEqual(data["name"], "Spirula")
        self.assertTrue(data["at_carrier"])
        self.assertEqual(data["stored"], 440)
        self.assertEqual(data["cargo_capacity"], 17819)
        self.assertEqual(data["need_total"], 500)
        rows = {row["key"]: row for row in data["commodities"]}
        self.assertEqual(rows["steel"], {
            "key": "steel", "name": "Steel", "amount": 120, "delivered": 120,
            "need": 200, "remaining": 80,
        })
        self.assertEqual(rows["tritium"]["remaining"], 0)
        # Сначала то, чего больше всего не хватает.
        self.assertEqual(data["commodities"][0]["key"], "steel")

    def test_remote_cargo_replaces_local_accounting(self):
        self.assertTrue(self.tracker.merge_remote({"steel": 250, "gold": 5, "bad": 0}))
        state = self.tracker.state
        self.assertTrue(state.remote_seen)
        self.assertEqual(state.commodities, {"steel": 250, "gold": 5})
        self.assertFalse(self.tracker.merge_remote({}))
        self.assertFalse(self.tracker.merge_remote("не карта"))
        # Новая дельта из журнала снова делает цифры неполными.
        self.tracker.handle(TRANSFER_TO_SHIP)
        self.assertFalse(self.tracker.state.remote_seen)

    def test_reset(self):
        self.tracker.reset()
        self.assertFalse(self.tracker.state.known)
        self.assertEqual(self.tracker.state.commodities, {})


class CarrierApiSurfaceTests(unittest.TestCase):
    """Клиент Raven Colonial умеет спросить поимённый груз авианосца."""

    def test_get_fc_cargo_path_and_validation(self):
        from unittest import mock

        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("ключ")
        with mock.patch.object(api, "_request", return_value={"ok": True, "data": {"steel": 3}}) as request:
            self.assertEqual(api.get_fc_cargo(3700005632), {"ok": True, "data": {"steel": 3}})
        request.assert_called_once_with("GET", "/fc/3700005632/cargo")

        self.assertFalse(api.get_fc_cargo(0)["ok"])
        self.assertFalse(api.get_fc_cargo("мусор")["ok"])
        self.assertFalse(api.get_fc_cargo(None)["ok"])

    def test_get_fc_cargo_full_url_has_single_api_segment(self):
        """`base_url` уже заканчивается на /api — путь не должен его повторять.

        Проверяем реальный URL, который уходит в сессию: при ошибке получался
        `.../api/api/fc/...`, и Raven отвечал 404.
        """
        from unittest import mock

        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("ключ")
        response = mock.MagicMock(ok=True, status_code=200)
        response.json.return_value = {"steel": 3}
        with mock.patch.object(api._session, "request", return_value=response) as request:
            self.assertTrue(api.get_fc_cargo(3700005632)["ok"])
        url = request.call_args[0][1]
        self.assertEqual(
            url,
            "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net"
            "/api/fc/3700005632/cargo",
        )
        self.assertEqual(request.call_args[0][0], "GET")
        self.assertNotIn("/api/api/", url)

    def test_get_fc_cargo_without_key(self):
        from raven_colonial_api import RavenColonialAPI

        result = RavenColonialAPI("").get_fc_cargo(3700005632)
        self.assertFalse(result["ok"])
        self.assertTrue(result["error"])


class CarrierOverlayIntegrationTests(unittest.TestCase):
    """Связка «журнал -> трекер -> блок CARRIER» на уровне приложения.

    Без настоящего Tk: GUI подменён заглушками, фоновые потоки исполняются
    сразу, Raven Colonial не ходит в сеть.
    """

    def setUp(self):
        import tempfile
        from unittest import mock as _mock

        from test_colonisation import DEPOT, DOCKED
        from test_initial_upload_flow import install_gui_stubs, make_root

        self.DEPOT, self.DOCKED = DEPOT, DOCKED
        self.mock = _mock
        install_gui_stubs()
        for name in ("colonial_helper", "api_client", "event_dispatch", "journal_parser",
                     "overlay", "ship_tracker", "route_tracker", "game_monitor",
                     "exobiology", "colonisation", "carrier", "raven_colonial_api"):
            sys.modules.pop(name, None)

        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.root = make_root()

        import colonial_helper

        self.module = colonial_helper
        with _mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             _mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             _mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)
        self.app.raven_api.api_key = "rcc-key"
        self.app.raven_api.get_system_sites = lambda system: {"ok": False, "error": "test"}
        self.app.raven_api.get_system_architect = lambda system: {"ok": False, "error": "test"}
        self.app.raven_api.get_cmdr_active = lambda cmdr: {"ok": True, "data": []}
        self.app.raven_api.get_primary = lambda cmdr: {"ok": True, "data": ""}
        self.app.raven_api.get_project = lambda address, market_id: None

    def tearDown(self):
        self.tmp.cleanup()

    def _run_threads_inline(self):
        """Фоновые потоки исполняем сразу: тест не должен ждать планировщик."""
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

        return self.mock.patch.object(self.module.threading, "Thread", _SyncThread)

    def _dock_at_site(self):
        self.app.construction.handle("", self.DOCKED)
        self.app.construction.handle("", self.DEPOT)

    def test_overlay_data_carries_carrier_block(self):
        self._dock_at_site()
        self.app.carrier.handle(CARRIER_STATS)
        self.app.carrier.handle(DOCKED_FC)
        self.app.carrier.handle(TRANSFER_TO_CARRIER)

        data = self.app._get_overlay_data()["carrier"]
        self.assertEqual(data["name"], "Spirula")
        self.assertEqual(data["stored"], 440)
        self.assertEqual(data["cargo_capacity"], 17819)
        rows = {row["key"]: row for row in data["commodities"]}
        # Потребность площадки: Steel 6680-720=5960, Liquid oxygen 1865-0=1865.
        self.assertEqual(rows["steel"]["need"], 5960)
        self.assertEqual(rows["steel"]["amount"], 120)
        self.assertEqual(rows["steel"]["remaining"], 5840)
        self.assertEqual(rows["liquidoxygen"]["need"], 1865)
        self.assertEqual(rows["liquidoxygen"]["amount"], 0)
        # Закрытый Aluminium в потребность не попадает.
        self.assertNotIn("aluminium", rows)

    def test_carrier_need_is_empty_without_site(self):
        self.app.carrier.handle(CARRIER_STATS)
        self.assertEqual(self.app._carrier_need(), {})
        data = self.app._get_overlay_data()["carrier"]
        self.assertEqual(data["need_total"], 0)

    def test_live_event_feeds_tracker_and_asks_raven_once(self):
        calls = []
        self.app.raven_api.get_fc_cargo = lambda market_id: (
            calls.append(market_id) or {"ok": True, "data": {"steel": 250}}
        )
        with self._run_threads_inline():
            self.app._feed_carrier(CARRIER_STATS, live=True)
            self.app._feed_carrier(DOCKED_FC, live=True)
            self.app._feed_carrier(DOCKED_FC, live=True)   # повтор — без запроса
        self.assertEqual(calls, [3700005632])
        # Груз по товарам пришёл из Raven и заменил локальный учёт.
        self.assertEqual(self.app.carrier.state.commodities, {"steel": 250})
        self.assertTrue(self.app.carrier.state.remote_seen)

    def test_raven_answer_with_nested_cargo_field(self):
        """Raven может отдать и {cargo: {...}}, и саму карту — принимаем оба."""
        self.app.raven_api.get_fc_cargo = lambda market_id: {
            "ok": True, "data": {"cargo": {"steel": 90, "gold": 4}, "cargoCapacity": 2000},
        }
        with self._run_threads_inline():
            self.app._feed_carrier(DOCKED_FC, live=True)
        self.assertEqual(self.app.carrier.state.commodities, {"steel": 90, "gold": 4})
        self.assertTrue(self.app.carrier.state.remote_seen)

    def test_trading_on_carrier_does_not_spam_log(self):
        """Строка в лог — на заметное событие, а не на каждую продажу."""
        # Пустой ответ Raven не логируется: нас интересует только то, что
        # пять продаж на борту не дают пять строк в лог.
        self.app.raven_api.get_fc_cargo = lambda market_id: {"ok": True, "data": {}}
        logged = []
        self.app.overlay_manager.log = lambda message, level="info": logged.append(message)
        with self._run_threads_inline():
            self.app._feed_carrier(DOCKED_FC, live=True)
            for index in range(5):
                self.app._feed_carrier({
                    "event": "MarketSell", "MarketID": 3700005632,
                    "Type": "tritium", "Count": 10 + index,
                }, live=True)
        self.assertEqual(len(logged), 1, f"ожидали одну строку, получили {logged}")
        self.assertEqual(self.app.carrier.state.commodities["tritium"], 60)

    def test_history_pass_does_not_touch_raven(self):
        calls = []
        self.app.raven_api.get_fc_cargo = lambda market_id: calls.append(market_id)
        with self._run_threads_inline():
            self.app._feed_carrier(DOCKED_FC, live=False)
        self.assertEqual(calls, [])

    # -- основной проект из «Колонизатора» --------------------------------
    def test_primary_project_need_reaches_overlay(self):
        """Материалы основного проекта — источник списка в блоке CARRIER."""
        self.app.colony_primary_project = {
            "buildId": "abc-123",
            "buildName": "Jameson Memorial",
            "systemName": "Kuma",
            "commodities": {"steel": 4000, "titanium": 900, "copper": 0},
        }
        self.app.carrier.handle(CARRIER_STATS)
        self.app.carrier.handle(DOCKED_FC)
        self.app.carrier.handle(TRANSFER_TO_CARRIER)

        need, label, source = self.app._carrier_need_info()
        self.assertEqual(source, "project")
        self.assertEqual(need, {"steel": 4000, "titanium": 900})
        self.assertIn("Jameson Memorial", label)
        self.assertIn("Kuma", label)

        data = self.app._get_overlay_data()["carrier"]
        rows = {row["key"]: row for row in data["commodities"]}
        self.assertEqual(rows["steel"]["need"], 4000)
        self.assertEqual(rows["steel"]["amount"], 120)
        self.assertEqual(rows["steel"]["remaining"], 3880)
        # Нулевая потребность в список не попадает.
        self.assertNotIn("copper", rows)
        self.assertEqual(data["need_label"], label)
        self.assertEqual(data["need_source"], "project")
        self.assertEqual(data["need_total"], 4900)

    def test_primary_project_wins_over_construction_site(self):
        """Проект из «Колонизатора» важнее площадки из журнала."""
        self._dock_at_site()
        self.app.colony_primary_project = {
            "buildName": "Primary port", "systemName": "Sol",
            "commodities": {"gold": 50},
        }
        need, label, source = self.app._carrier_need_info()
        self.assertEqual(source, "project")
        self.assertEqual(need, {"gold": 50})
        self.assertIn("Primary port", label)

    def test_site_is_used_when_no_primary_project(self):
        self._dock_at_site()
        need, label, source = self.app._carrier_need_info()
        self.assertEqual(source, "site")
        self.assertEqual(need["steel"], 5960)
        self.assertTrue(label)

    def test_project_without_commodities_falls_back_to_site(self):
        self._dock_at_site()
        self.app.colony_primary_project = {"buildName": "Пусто", "commodities": {}}
        need, _label, source = self.app._carrier_need_info()
        self.assertEqual(source, "site")
        self.assertEqual(need["steel"], 5960)

    def test_garbage_project_does_not_break_overlay(self):
        for bad in ({"commodities": "не карта"}, {"commodities": {"steel": "много"}},
                    {"commodities": None}):
            self.app.colony_primary_project = bad
            _need, _label, source = self.app._carrier_need_info()
            self.assertNotEqual(source, "project", bad)

    def test_set_primary_remembers_project_for_overlay(self):
        self.app._colony_projects_cache = {
            "abc-123": {"buildId": "abc-123", "buildName": "Jameson Memorial",
                        "systemName": "Kuma", "buildType": "Coriolis",
                        "commodities": {"steel": 100}},
        }
        self.app.colony_tree = self.mock.MagicMock()
        self.app.colony_tree.selection.return_value = ("item",)
        # `item(id, "values")` возвращает сам кортеж значений, а не словарь.
        self.app.colony_tree.item.return_value = (
            "", "Kuma", "Jameson Memorial", "Coriolis", "100 / 200", "abc-123")
        self.app.colony_cmdr_var = self.mock.MagicMock()
        self.app.colony_cmdr_var.get.return_value = "CMDR Test"
        self.app.raven_api.set_primary = lambda cmdr, build_id: {"ok": True}
        with self._run_threads_inline():
            self.app._on_colony_set_primary()
        self.assertEqual(self.app.colony_primary_project["buildId"], "abc-123")
        self.assertEqual(self.app._carrier_need_info()[0], {"steel": 100})

    def test_clear_primary_drops_the_list(self):
        self.app.colony_primary_project = {"buildId": "abc", "commodities": {"steel": 10}}
        self.app.colony_cmdr_var = self.mock.MagicMock()
        self.app.colony_cmdr_var.get.return_value = "CMDR Test"
        self.app.raven_api.clear_primary = lambda cmdr: {"ok": True}
        with self._run_threads_inline():
            self.app._on_colony_clear_primary()
        self.assertEqual(self.app.colony_primary_project, {})

    # -- «на борту» против «завезено мной» --------------------------------
    def test_on_board_and_delivered_are_separate(self):
        """Груз других командиров виден в «на борту», но не в «завезено мной»."""
        self.app.carrier.handle(DOCKED_FC)
        self.app.carrier.handle(TRANSFER_TO_CARRIER)      # +120 steel — наше
        state = self.app.carrier.state
        self.assertEqual(state.delivered["steel"], 120)
        # Raven отдаёт полный трюм: 250 steel (из них наши 120) и чужой gold.
        self.app.carrier.merge_remote({"steel": 250, "gold": 40})
        self.assertEqual(state.commodities, {"steel": 250, "gold": 40})
        self.assertEqual(state.delivered["steel"], 120)

        data = self.app.carrier.get_state_dict({"steel": 300})
        rows = {row["key"]: row for row in data["commodities"]}
        self.assertEqual(rows["steel"]["amount"], 250)
        self.assertEqual(rows["steel"]["delivered"], 120)
        self.assertEqual(rows["steel"]["remaining"], 50)
        self.assertEqual(rows["gold"]["amount"], 40)
        self.assertEqual(rows["gold"]["delivered"], 0)
        # Та же пересылка везла 120 steel + 300 tritium — считаем обе.
        self.assertEqual(data["delivered_total"], 420)
        self.assertTrue(data["remote_seen"])

    def test_new_deltas_count_on_top_of_remote_snapshot(self):
        self.app.carrier.handle(DOCKED_FC)
        self.app.carrier.merge_remote({"steel": 200})
        self.app.carrier.handle(TRANSFER_TO_CARRIER)      # +120
        self.assertEqual(self.app.carrier.state.commodities["steel"], 320)
        self.assertEqual(self.app.carrier.state.delivered["steel"], 120)
        # Снимок не испорчен локальной дельтой.
        self.assertEqual(self.app.carrier.state.remote_cargo["steel"], 200)
        self.assertFalse(self.app.carrier.state.remote_seen)

    def test_cargo_refresh_is_throttled_but_repeats(self):
        """Снимок Raven перечитывается по таймеру, но не на каждый тик."""
        calls = []
        self.app.raven_api.get_fc_cargo = lambda market_id: (
            calls.append(market_id) or {"ok": True, "data": {"steel": 10}})
        with self._run_threads_inline():
            self.app._refresh_carrier_cargo(3700005632)
            self.app._refresh_carrier_cargo(3700005632)
            self.app._refresh_carrier_cargo(3700005632)
        self.assertEqual(len(calls), 1, calls)
        # Другой авианосец — сразу новый запрос.
        with self._run_threads_inline():
            self.app._refresh_carrier_cargo(3700005633)
        self.assertEqual(calls, [3700005632, 3700005633])
        # Истёк интервал — перечитываем тот же.
        self.app._carrier_remote_at -= self.app.CARRIER_CARGO_REFRESH_SECONDS + 1
        with self._run_threads_inline():
            self.app._refresh_carrier_cargo(3700005633)
        self.assertEqual(len(calls), 3)

    def test_no_refresh_without_key(self):
        calls = []
        self.app.raven_api.api_key = ""
        self.app.raven_api.get_fc_cargo = lambda market_id: calls.append(market_id)
        with self._run_threads_inline():
            self.app._refresh_carrier_cargo(3700005632, force=True)
        self.assertEqual(calls, [])

    def test_switching_carrier_drops_old_cargo(self):
        self.app.carrier.handle(DOCKED_FC)
        self.app.carrier.merge_remote({"steel": 250})
        self.app.carrier.handle({
            "event": "Docked", "StationName": "Чужой FC", "StationType": "FleetCarrier",
            "MarketID": 3700009999, "StarSystem": "Kuma"})
        state = self.app.carrier.state
        self.assertEqual(state.commodities, {})
        self.assertEqual(state.delivered, {})
        self.assertEqual(state.remote_cargo, {})
        self.assertFalse(state.remote_seen)

    def test_raven_failure_keeps_local_accounting(self):
        self.app.carrier.handle(DOCKED_FC)
        self.app.carrier.handle(TRANSFER_TO_CARRIER)
        self.app.raven_api.get_fc_cargo = lambda market_id: {"ok": False, "error": "нет сети"}
        with self._run_threads_inline():
            self.app._feed_carrier(DOCKED_FC, live=True)
        self.assertEqual(self.app.carrier.state.commodities["steel"], 120)
        self.assertFalse(self.app.carrier.state.remote_seen)


class SiteProjectRefreshTests(unittest.TestCase):
    """Состояние рынка стройплощадки из Raven Colonial (2.9.0).

    Остаток потребности проекта на Raven общий на всех командиров. Журнал
    знает только то, что завезли вы, поэтому без перечитывания проекта
    «осталось завезти» не уменьшалось, когда часть груза сдавал другой
    командир или когда сессия прервалась и доставка досылалась позже.
    """

    def setUp(self):
        CarrierOverlayIntegrationTests.setUp(self)

    def tearDown(self):
        CarrierOverlayIntegrationTests.tearDown(self)

    _run_threads_inline = CarrierOverlayIntegrationTests._run_threads_inline
    _dock_at_site = CarrierOverlayIntegrationTests._dock_at_site

    PROJECT = {
        "buildId": "build-1",
        "buildName": "Hestia Depot",
        "systemName": "Kuma",
        # Raven уже учёл чужую доставку: стали не хватает 3000, а не 5960.
        "commodities": {"steel": 3000, "liquidoxygen": 1865},
    }

    def test_remote_project_wins_over_journal(self):
        """Чужие доставки уменьшают остаток — журнал их не знает."""
        self._dock_at_site()
        self.app.raven_api.get_project = lambda address, market_id: dict(self.PROJECT)

        with self._run_threads_inline():
            self.app._refresh_site_project()

        need, label, source = self.app._carrier_need_info()
        self.assertEqual(source, "site_project")
        self.assertEqual(need["steel"], 3000, "должен быть остаток с Raven, а не из журнала")
        self.assertEqual(need["liquidoxygen"], 1865)
        self.assertIn("Hestia Depot", label)

    def test_journal_site_used_when_no_remote_project(self):
        """Нет проекта на Raven — остаёмся на данных журнала."""
        self._dock_at_site()
        self.app.raven_api.get_project = lambda address, market_id: None

        with self._run_threads_inline():
            self.app._refresh_site_project()

        need, _label, source = self.app._carrier_need_info()
        self.assertEqual(source, "site")
        self.assertEqual(need["steel"], 5960, "журнальный остаток: 6680-720")

    def test_primary_project_still_wins(self):
        """Проект, выбранный основным, важнее площадки под ногами."""
        self._dock_at_site()
        self.app.colony_primary_project = {
            "buildId": "other", "buildName": "Другой", "systemName": "Kuma",
            "commodities": {"steel": 42},
        }
        self.app.raven_api.get_project = lambda address, market_id: dict(self.PROJECT)

        with self._run_threads_inline():
            self.app._refresh_site_project()

        need, _label, source = self.app._carrier_need_info()
        self.assertEqual(source, "project")
        self.assertEqual(need, {"steel": 42})

    def test_refresh_is_throttled(self):
        """Чаще, чем раз в SITE_PROJECT_REFRESH_SECONDS, в сеть не ходим."""
        self._dock_at_site()
        calls = []
        self.app.raven_api.get_project = lambda a, m: (calls.append((a, m)) or dict(self.PROJECT))

        with self._run_threads_inline():
            self.app._refresh_site_project()
            self.app._refresh_site_project()
            self.app._refresh_site_project()

        self.assertEqual(len(calls), 1, f"лишние запросы: {calls}")
        self.assertEqual(calls[0], (123456789, 3951663874))

    def test_force_bypasses_throttle(self):
        self._dock_at_site()
        calls = []
        self.app.raven_api.get_project = lambda a, m: (calls.append((a, m)) or dict(self.PROJECT))

        with self._run_threads_inline():
            self.app._refresh_site_project()
            self.app._refresh_site_project(force=True)

        self.assertEqual(len(calls), 2)

    def test_no_key_means_no_request(self):
        """Без ключа RCC в сеть не ходим и проект не подменяем."""
        self._dock_at_site()
        self.app.raven_api.api_key = ""
        calls = []
        self.app.raven_api.get_project = lambda a, m: (calls.append((a, m)) or dict(self.PROJECT))

        with self._run_threads_inline():
            self.app._refresh_site_project()

        self.assertEqual(calls, [])
        self.assertEqual(self.app.site_project, {})

    def test_remaining_total_is_logged(self):
        """В лог пишется суммарный остаток — его и просил видеть пользователь."""
        self._dock_at_site()
        self.app.raven_api.get_project = lambda address, market_id: dict(self.PROJECT)
        logged = []
        self.app.log = lambda text, level="info": logged.append(str(text))

        with self._run_threads_inline():
            self.app._refresh_site_project()

        # Число форматируется с пробелом-разделителем тысяч, запятая после
        # «позиц.» при этом должна остаться на месте.
        self.assertTrue(
            any("осталось завезти 4 865 t (2 позиц., данные Raven Colonial)" in t
                for t in logged),
            logged)

    def test_raven_error_is_not_fatal(self):
        self._dock_at_site()

        def _boom(address, market_id):
            raise RuntimeError("нет сети")

        self.app.raven_api.get_project = _boom
        with self._run_threads_inline():
            self.app._refresh_site_project()  # не должно бросить исключение
        self.assertEqual(self.app.site_project, {})


class StateFilesLogSpamTests(unittest.TestCase):
    """`_load_current_state_files` зовётся watcher'ом каждые 5 секунд (2.9.0).

    Без сравнения подписи две строки — «Модули: …» и «Загружено состояние: …» —
    писались в лог на каждом тике, хотя в корабле ничего не менялось. Это и был
    «лог постоянно печатает инфу о корабле», на который жаловался пользователь.
    """

    def setUp(self):
        CarrierOverlayIntegrationTests.setUp(self)
        self.journal = self.app.journal_path
        self.journal.mkdir(parents=True, exist_ok=True)
        self.logged = []
        self.app.log = lambda text, level="info": self.logged.append(str(text))

    def tearDown(self):
        CarrierOverlayIntegrationTests.tearDown(self)

    def _write(self, name: str, payload: dict):
        import json as _json

        (self.journal / name).write_text(
            _json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def _write_state(self, modules: list):
        self._write("Status.json", {"Fuel": {"FuelMain": 10.0, "FuelReservoir": 0.5},
                                    "Balance": 1000, "Cargo": 12})
        self._write("ModulesInfo.json", {"Modules": modules})
        self._write("Cargo.json", {"Count": 12, "Inventory": []})

    MODULES = [
        {"Slot": "PowerPlant", "Item": "powerplant_size4_class3", "Health": 1.0,
         "Power": 0.0, "On": True, "Priority": 1},
        {"Slot": "MainEngines", "Item": "engine_size3_class2", "Health": 1.0,
         "Power": 4.2, "On": True, "Priority": 1},
    ]

    def test_module_line_logged_once_when_nothing_changes(self):
        """Главная жалоба: одна и та же строка про модули каждые 5 секунд."""
        self._write_state(self.MODULES)

        for _ in range(5):
            self.app._load_current_state_files()

        module_lines = [t for t in self.logged if t.startswith("Модули:")]
        self.assertEqual(len(module_lines), 1, module_lines)

        state_lines = [t for t in self.logged if t.startswith("Загружено состояние:")]
        self.assertEqual(len(state_lines), 1, state_lines)

    def test_module_line_logged_again_when_state_changes(self):
        """Изменилось состояние — строку пишем, иначе починку не увидишь."""
        self._write_state(self.MODULES)
        self.app._load_current_state_files()
        self.logged.clear()

        # Модуль повредился: damaged 0 -> 1, подпись меняется.
        broken = [dict(self.MODULES[0]), dict(self.MODULES[1], Health=0.4)]
        self._write_state(broken)
        self.app._load_current_state_files()

        module_lines = [t for t in self.logged if t.startswith("Модули:")]
        self.assertEqual(len(module_lines), 1, module_lines)
        self.assertIn("повреждено: 1", module_lines[0])

    def test_module_line_logged_when_count_changes(self):
        self._write_state(self.MODULES)
        self.app._load_current_state_files()
        self.logged.clear()

        extra = self.MODULES + [
            {"Slot": "ShieldGenerator", "Item": "shieldgenerator_size3_class1",
             "Health": 1.0, "Power": 1.1, "On": True, "Priority": 2}]
        self._write_state(extra)
        self.app._load_current_state_files()

        module_lines = [t for t in self.logged if t.startswith("Модули:")]
        self.assertEqual(len(module_lines), 1, module_lines)
        self.assertIn("3 шт.", module_lines[0])

    def test_state_files_line_logged_once(self):
        """«Загружено состояние: Status, ModulesInfo, Cargo» — тоже раз."""
        self._write_state(self.MODULES)
        for _ in range(4):
            self.app._load_current_state_files()
        state_lines = [t for t in self.logged if t.startswith("Загружено состояние:")]
        self.assertEqual(len(state_lines), 1, state_lines)
        self.assertIn("Status", state_lines[0])

    def test_state_files_line_repeats_when_set_changes(self):
        """Появился новый файл — набор изменился, строку пишем снова."""
        self._write("Status.json", {"Balance": 10})
        self.app._load_current_state_files()
        self.logged.clear()

        self._write("Cargo.json", {"Count": 3, "Inventory": []})
        self.app._load_current_state_files()

        state_lines = [t for t in self.logged if t.startswith("Загружено состояние:")]
        self.assertEqual(len(state_lines), 1, state_lines)
        self.assertIn("Cargo", state_lines[0])

    def test_read_errors_still_logged_every_time(self):
        """Ошибку чтения прятать нельзя: анти-спам касается только рутины."""
        (self.journal / "Status.json").write_text("{ не json", encoding="utf-8")

        for _ in range(3):
            self.app._load_current_state_files()

        errors = [t for t in self.logged if "Ошибка чтения Status.json" in t]
        self.assertEqual(len(errors), 3, errors)


class RavenSkipReportTests(unittest.TestCase):
    """Почему тоннаж не дошёл до Raven Colonial (2.9.0).

    Все ветки отказа просто делали `continue`: в логе не было ни строки, и
    «Raven Colonial не получает инфу о доставленном грузе» выглядело как
    поломка сервера, хотя чаще всего проект просто не найден по market_id.
    """

    def setUp(self):
        CarrierOverlayIntegrationTests.setUp(self)
        self.logged = []
        self.app.log = lambda text, level="info": self.logged.append((str(text), level))
        self.sent = []
        self.app.raven_api.contribute = (
            lambda build_id, cmdr, commodities: (self.sent.append((build_id, commodities))
                                                 or {"ok": True})
        )

    def tearDown(self):
        CarrierOverlayIntegrationTests.tearDown(self)

    def _texts(self):
        return [t for t, _ in self.logged]

    def _warns(self):
        return [t for t, level in self.logged if level == "warn"]

    def test_missing_market_id_is_reported(self):
        self.app._send_deliveries_to_raven(
            [{"source": "colonisation_contribution", "system_address": 1,
              "commodity": "steel", "amount": 100}],
            cmdr_name="Cmdr")
        warns = self._warns()
        self.assertTrue(any("не отправлено 1 доставок" in t for t in warns), warns)
        self.assertTrue(any("в событии нет MarketID" in t for t in warns), warns)
        self.assertEqual(self.sent, [])

    def test_unknown_project_is_reported_with_market_id(self):
        """Самая частая причина: по market_id проект не находится."""
        self.app.raven_api.get_project = lambda address, market_id: None
        self.app._send_deliveries_to_raven(
            [{"source": "colonisation_contribution", "market_id": 3951663874,
              "system_address": 123456789, "commodity": "steel", "amount": 100}],
            cmdr_name="Cmdr")
        warns = self._warns()
        self.assertTrue(any("market_id=3951663874" in t for t in warns), warns)
        self.assertTrue(any("проект не найден" in t for t in warns), warns)

    def test_missing_system_address_is_reported(self):
        self.app.raven_api.get_project = lambda a, m: {"buildId": "b1"}
        self.app.ship.state.system_address = 0
        self.app._send_deliveries_to_raven(
            [{"source": "colonisation_contribution", "market_id": 1,
              "commodity": "steel", "amount": 100}],
            cmdr_name="Cmdr")
        self.assertTrue(any("не определён SystemAddress" in t for t in self._warns()),
                        self._warns())

    def test_empty_commodity_name_is_reported(self):
        self.app.raven_api.get_project = lambda a, m: {"buildId": "b1"}
        self.app._send_deliveries_to_raven(
            [{"source": "colonisation_contribution", "market_id": 1,
              "system_address": 5, "commodity": "", "amount": 100}],
            cmdr_name="Cmdr")
        self.assertTrue(any("пустое имя товара" in t for t in self._warns()), self._warns())

    def test_carrier_delivery_is_silent_by_design(self):
        """Продажа своему авианосцу идёт через PATCH /fc/{id}/cargo — не «пропуск»."""
        self.app._send_deliveries_to_raven(
            [{"source": "carrier_delivery", "market_id": 3700001234,
              "system_address": 5, "commodity": "steel", "amount": 100}],
            cmdr_name="Cmdr")
        self.assertEqual(self._warns(), [], "carrier_delivery не должен считаться отказом")
        self.assertEqual(self.sent, [])

    def test_counts_are_aggregated_per_reason(self):
        """Одна строка на пакет, а не по строке на каждую доставку."""
        self.app.raven_api.get_project = lambda a, m: None
        deliveries = [
            {"source": "colonisation_contribution", "market_id": 1,
             "system_address": 5, "commodity": "steel", "amount": 10},
            {"source": "colonisation_contribution", "market_id": 1,
             "system_address": 5, "commodity": "titanium", "amount": 20},
            {"source": "colonisation_contribution", "system_address": 5,
             "commodity": "steel", "amount": 30},
        ]
        self.app._send_deliveries_to_raven(deliveries, cmdr_name="Cmdr")

        skip_lines = [t for t in self._warns() if "не отправлено" in t]
        self.assertEqual(len(skip_lines), 1, skip_lines)
        self.assertIn("не отправлено 3 доставок", skip_lines[0])
        self.assertIn("проект не найден (market_id=1) — 2", skip_lines[0])
        self.assertIn("в событии нет MarketID — 1", skip_lines[0])

    def test_successful_delivery_reports_tonnage(self):
        self.app.raven_api.get_project = lambda a, m: {"buildId": "b1"}
        self.app._send_deliveries_to_raven(
            [{"source": "colonisation_contribution", "market_id": 1,
              "system_address": 5, "commodity": "$steel_name;", "amount": 250}],
            cmdr_name="Cmdr")
        self.assertEqual(self.sent, [("b1", {"steel": 250})])
        self.assertTrue(any("+250t" in t for t in self._texts()), self._texts())
        self.assertEqual(self._warns(), [])

    def test_nothing_to_report_stays_silent(self):
        self.app._send_deliveries_to_raven([], cmdr_name="Cmdr")
        self.assertEqual(self._warns(), [])


class LiveWatcherRavenTests(unittest.TestCase):
    """Раунд 33: ЖИВОЙ путь вотчера — `_process_journal_changes(live=True)`.

    Тесты выше дёргают `_send_deliveries_to_raven` напрямую, и шесть релизов
    подряд этого хватало: в `_process_journal_changes` лежала собственная копия
    цикла отправки, которая в живой игре и выполнялась. Она отправляла
    `commodity` как есть, то есть `Name_Localised` из журнала («Steel»,
    «Liquid oxygen»), хотя Raven Colonial требует lower-case language-agnostic
    имена, и молча теряла доставки без MarketID, без buildId и при ошибке API.
    Дубликат удалён — эти тесты гоняют именно тик вотчера по настоящему файлу
    журнала, чтобы дефект нельзя было вернуть unnoticed.
    """

    LOCATION = (
        '{"timestamp":"2026-09-14T10:00:00Z","event":"Location",'
        '"StarSystem":"HIP 22460","SystemAddress":123456789,'
        '"StationName":"Planetary Construction Site: A 1",'
        '"StationType":"PlanetaryConstructionSite"}'
    )
    CONTRIBUTION = (
        '{"timestamp":"2026-09-14T10:01:00Z","event":"ColonisationContribution",'
        '"MarketID":3951663874,"Contributions":['
        '{"Name":"$steel_name;","Name_Localised":"Steel","Amount":250},'
        '{"Name":"$liquidoxygen_name;","Name_Localised":"Liquid oxygen","Amount":120}]}'
    )

    def setUp(self):
        CarrierOverlayIntegrationTests.setUp(self)
        self.journal_dir = self.app.journal_path
        self.journal_dir.mkdir(parents=True, exist_ok=True)
        self.logged = []
        self.app.log = lambda text, level="info": self.logged.append((str(text), level))
        self.sent = []
        self.app.raven_api.get_project = lambda address, market_id: {"buildId": "b1"}
        self.app.raven_api.contribute = (
            lambda build_id, cmdr, commodities: (
                self.sent.append((build_id, cmdr, dict(commodities))) or {"ok": True})
        )
        # Аплоад на сайт должен пройти: отправка на Raven вложена в его успех
        # (иначе ретрай следующего тика зачёл бы тоннаж второй раз).
        class _Api:
            is_connected = True

            def upload_deliveries(self, rows, cmdr):
                return {"ok": True, "inserted": len(rows)}

            def upload_construction_events(self, events, cmdr):
                return {"ok": True}

        self.app.api = _Api()
        self.app.dispatcher.submit = lambda *args, **kwargs: None
        self.app._watcher_cmdr_name = "Test CMDR"
        self.app.ship.state.current_system = "HIP 22460"
        self.app.ship.state.system_address = 123456789

    def tearDown(self):
        CarrierOverlayIntegrationTests.tearDown(self)

    def _tick(self, lines):
        path = self.journal_dir / "Journal.260914100000.01.log"
        path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        size = path.stat().st_size
        self.app._process_journal_changes(path, 0, size, live=True)

    def _warns(self):
        return [t for t, level in self.logged if level == "warn"]

    def test_localised_names_are_normalized_before_raven(self):
        """Главный дефект: «Steel»/«Liquid oxygen» уходили в Raven как есть."""
        self._tick([self.LOCATION, self.CONTRIBUTION])
        self.assertEqual(
            self.sent,
            [("b1", "Test CMDR", {"steel": 250, "liquidoxygen": 120})],
        )

    def test_unknown_project_is_reported_on_live_path(self):
        self.app.raven_api.get_project = lambda address, market_id: None
        self._tick([self.LOCATION, self.CONTRIBUTION])
        warns = self._warns()
        self.assertTrue(any("не отправлено 2 доставок" in t for t in warns), warns)
        self.assertTrue(any("market_id=3951663874" in t for t in warns), warns)
        self.assertEqual(self.sent, [])

    def test_missing_market_id_is_reported_on_live_path(self):
        no_market = (
            '{"timestamp":"2026-09-14T10:01:00Z","event":"ColonisationContribution",'
            '"Contributions":[{"Name":"$steel_name;","Name_Localised":"Steel",'
            '"Amount":250}]}'
        )
        self._tick([self.LOCATION, no_market])
        self.assertTrue(any("в событии нет MarketID" in t for t in self._warns()),
                        self._warns())
        self.assertEqual(self.sent, [])

    def test_watcher_has_no_own_raven_send_loop(self):
        """Страховка от возвращения дубликата: путь отправки должен быть один."""
        import inspect

        source = inspect.getsource(self.app._process_journal_changes)
        self.assertNotIn("raven_api.contribute", source)
        self.assertIn("_send_deliveries_to_raven", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)
