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


if __name__ == "__main__":
    unittest.main(verbosity=2)
