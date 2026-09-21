"""Доставки на стройплощадку -> Raven Colonial: отправка, повторы, сверка.

Тесты закрепляют причины, по которым тоннаж не доходил до Raven Colonial
(или доходил несколько раз):

* отправка в Raven была вложена в успех аплоада на ED Ring Colony, а ветка
  ошибки потеряла свой `else` — при сбое сайта доставка терялась для всех,
  а при успехе возвращалась в очередь и уходила повторно на каждом тике;
* кэш поиска проекта запоминал сетевой сбой как «проект не найден» на пять
  минут, и всё это окно доставки молча отбрасывались;
* программа, запущенная, когда командир уже стоит у площадки, не знала её
  `MarketID` — Raven не опрашивался, «осталось завезти» не считалось;
* повтор отправки не был защищён ничем: `contribute` суммирует тонны,
  поэтому дубль завышает вклад командира в общий проект.
"""

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from test_initial_upload_flow import install_gui_stubs, make_root  # noqa: E402

SITE_MARKET_ID = 3951663874
SITE_ADDRESS = 123456789

LOCATION = (
    '{"timestamp":"2026-09-14T10:00:00Z","event":"Location",'
    '"StarSystem":"HIP 22460","SystemAddress":123456789,'
    '"StationName":"Planetary Construction Site: A 1",'
    '"StationType":"PlanetaryInstallation"}'
)
DOCKED_SITE = (
    '{"timestamp":"2026-09-14T10:00:30Z","event":"Docked",'
    '"StationName":"Planetary Construction Site: A 1",'
    '"StationType":"PlanetaryInstallation","MarketID":3951663874,'
    '"StarSystem":"HIP 22460","SystemAddress":123456789,'
    '"StationServices":["colonisationcontribution","commodities"]}'
)
DEPOT = (
    '{"timestamp":"2026-09-14T10:00:40Z","event":"ColonisationConstructionDepot",'
    '"MarketID":3951663874,"ConstructionID":1,"ConstructionName":"A 1",'
    '"ConstructionProgress":0.35,"StarSystem":"HIP 22460","SystemAddress":123456789,'
    '"ResourcesRequired":[{"Name":"$steel_name;","Name_Localised":"Steel",'
    '"RequiredAmount":6680,"ProvidedAmount":1815},'
    '{"Name":"$liquidoxygen_name;","Name_Localised":"Liquid oxygen",'
    '"RequiredAmount":1865,"ProvidedAmount":0}]}'
)


def contribution(timestamp: str, amount: int, token: str = "$steel_name;",
                 localised: str = "Steel", market_id: int = SITE_MARKET_ID) -> str:
    event = {
        "timestamp": timestamp,
        "event": "ColonisationContribution",
        "Contributions": [{"Name": token, "Name_Localised": localised, "Amount": amount}],
    }
    if market_id:
        event["MarketID"] = market_id
    return json.dumps(event, ensure_ascii=False)


PROJECT = {
    "buildId": "b-site",
    "buildName": "A 1",
    "systemName": "HIP 22460",
    "commodities": {"steel": 4865, "liquidoxygen": 1865},
}


class _SyncThread:
    """Фоновые потоки исполняются сразу: тест не ждёт планировщик."""

    def __init__(self, target=None, args=(), kwargs=None, daemon=None, name=None):
        self._target = target
        self._args = tuple(args or ())
        self._kwargs = dict(kwargs or {})

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)

    def join(self, timeout=None):
        return None


class AppTestCase(unittest.TestCase):
    """Общая обвязка: приложение без настоящего Tk и без сети."""

    def setUp(self):
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
        with mock.patch.object(colonial_helper, "DEFAULT_JOURNAL_PATH", self.home), \
             mock.patch.object(colonial_helper.ColonialHelperApp, "save_config"), \
             mock.patch("pathlib.Path.home", return_value=self.home):
            self.app = colonial_helper.ColonialHelperApp(self.root)

        self.journal_dir = self.home / "journals"
        self.journal_dir.mkdir(parents=True, exist_ok=True)
        self.app.journal_path = self.journal_dir

        self.logged = []
        self.app.log = lambda text, level="info": self.logged.append((str(text), level))
        self.app.overlay_manager.log = lambda *args, **kwargs: None
        self.app.dispatcher.submit = lambda *args, **kwargs: None

        self.app.raven_api.api_key = "rcc-key"
        self.app.raven_api.get_system_sites = lambda system: {"ok": False, "error": "test"}
        self.app.raven_api.get_system_architect = lambda system: {"ok": False, "error": "test"}
        self.app.raven_api.get_cmdr_active = lambda cmdr: {"ok": True, "data": []}
        self.app.raven_api.get_primary = lambda cmdr: {"ok": True, "data": ""}
        self.app.raven_api.get_cmdr_by_key = lambda key="": {"ok": True, "data": {"displayName": "Raven CMDR"}}
        self.app.raven_api.get_project = lambda address, market_id, **kwargs: dict(PROJECT)
        self.app.raven_api.get_fc_cargo = lambda market_id: {"ok": True, "data": {}}

        self.contributed = []
        self.app.raven_api.contribute = (
            lambda build_id, cmdr, commodities: (
                self.contributed.append((build_id, cmdr, dict(commodities))) or {"ok": True}
            )
        )

        self.site_uploads = []
        self.site_ok = True

        class _Api:
            is_connected = True
            cmdr_name = "Test CMDR"
            token = "token"
            site_url = "https://edringcolony.ru"
            user_id = "test-user"
            user_id = "user-1"

            def upload_deliveries(_self, rows, cmdr, progress_cb=None):
                self.site_uploads.append(list(rows))
                if self.site_ok:
                    return {"ok": True, "inserted": len(rows)}
                return {"ok": False, "inserted": 0, "error": "HTTP 500: server busy"}

            def upload_construction_events(_self, events, cmdr, progress_cb=None):
                return {"ok": True}

        self.app.api = _Api()
        self.app._watcher_cmdr_name = "Test CMDR"
        self.app.ship.state.current_system = "HIP 22460"
        self.app.ship.state.system_address = SITE_ADDRESS

    def tearDown(self):
        self.tmp.cleanup()

    # -- помощники ---------------------------------------------------------
    def _texts(self):
        return [text for text, _level in self.logged]

    def _lines(self, level):
        return [text for text, got in self.logged if got == level]

    def _write_journal(self, lines, name="Journal.260914100000.01.log"):
        path = self.journal_dir / name
        path.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        return path

    def _tick(self, path, offset):
        """Один тик watcher'а по реальному файлу журнала."""
        size = path.stat().st_size
        self.app._process_journal_changes(path, offset, size, live=True)
        return size

    def _inline_threads(self):
        return mock.patch.object(self.module.threading, "Thread", _SyncThread)


# ---------------------------------------------------------------------------
class WatcherRavenPipelineTests(AppTestCase):
    """Живой тик watcher'а: сайт и Raven Colonial — две независимые очереди."""

    def setUp(self):
        super().setUp()
        self.path = self._write_journal([LOCATION, DOCKED_SITE])
        self.offset = self.path.stat().st_size

    def _deliver(self, timestamp, amount):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(contribution(timestamp, amount) + "\n")
        self.offset = self._tick(self.path, self.offset)

    def test_delivery_reaches_raven_when_site_upload_fails(self):
        """Главный сбой: сайт не ответил — тонны терялись и для Raven."""
        self.site_ok = False
        self._deliver("2026-09-14T10:01:00Z", 250)

        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 250})])
        # Доставка осталась в очереди сайта и уйдёт повторно.
        self.assertEqual(len(self.app._pending_watcher_deliveries), 1)
        self.assertTrue(any("Upload error" in t for t in self._lines("error")))

    def test_delivery_is_sent_to_raven_exactly_once(self):
        """При успехе сайта доставка не должна уходить в Raven на каждом тике."""
        for index in range(4):
            self._deliver(f"2026-09-14T10:0{index + 1}:00Z", 100 * (index + 1))

        self.assertEqual(
            self.contributed,
            [("b-site", "Test CMDR", {"steel": 100}),
             ("b-site", "Test CMDR", {"steel": 200}),
             ("b-site", "Test CMDR", {"steel": 300}),
             ("b-site", "Test CMDR", {"steel": 400})],
        )
        self.assertEqual(self.app._pending_watcher_deliveries, [])
        self.assertEqual(self.app._pending_raven_deliveries, [])

    def test_success_does_not_log_an_upload_error(self):
        """«[Watcher] Upload error: None» писался на каждом успешном тике."""
        self._deliver("2026-09-14T10:01:00Z", 250)
        self._deliver("2026-09-14T10:02:00Z", 250)

        errors = [t for t in self._texts() if "Upload error" in t]
        self.assertEqual(errors, [], errors)

    def test_site_retry_resends_once_when_server_recovers(self):
        """Сайт ожил: очередь досылается, но Raven второй раз не дёргаем."""
        self.site_ok = False
        self._deliver("2026-09-14T10:01:00Z", 250)
        self.assertEqual(len(self.contributed), 1)

        self.site_ok = True
        self._deliver("2026-09-14T10:02:00Z", 300)

        self.assertEqual(len(self.contributed), 2, self.contributed)
        self.assertEqual(self.contributed[1], ("b-site", "Test CMDR", {"steel": 300}))
        # Обе доставки ушли на сайт: первая — повтором из очереди.
        self.assertEqual([len(rows) for rows in self.site_uploads], [1, 2])
        self.assertEqual(self.app._pending_watcher_deliveries, [])

    def test_raven_failure_keeps_delivery_for_retry(self):
        """Raven ответил 5xx: доставка остаётся в очереди и досылается позже."""
        attempts = {"n": 0}

        def contribute(build_id, cmdr, commodities):
            attempts["n"] += 1
            if attempts["n"] == 1:
                return {"ok": False, "error": "HTTP 503: сервис временно недоступен",
                        "retryable": True}
            self.contributed.append((build_id, cmdr, dict(commodities)))
            return {"ok": True}

        self.app.raven_api.contribute = contribute
        self._deliver("2026-09-14T10:01:00Z", 250)
        self.assertEqual(self.contributed, [])
        self.assertEqual(len(self.app._pending_raven_deliveries), 1)
        self.assertTrue(any("не отправлено 1 доставок" in t for t in self._lines("warn")),
                        self._texts())

        # Пауза между повторами истекла — следующий тик досылает.
        self.app._raven_last_attempt = 0.0
        self.app._flush_raven_deliveries("Test CMDR", force=True)
        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 250})])
        self.assertEqual(self.app._pending_raven_deliveries, [])

    def test_permanent_raven_refusal_is_not_retried_forever(self):
        """401/403/422: повтор бессмыслен, очередь не должна расти вечно."""
        self.app.raven_api.contribute = lambda build_id, cmdr, commodities: {
            "ok": False, "error": "ключ RCC не принят (401)", "retryable": False}
        self._deliver("2026-09-14T10:01:00Z", 250)

        self.assertEqual(self.app._pending_raven_deliveries, [])
        self.assertTrue(any("отправка невозможна" in t for t in self._lines("warn")),
                        self._texts())

    def test_unknown_project_is_reported_with_reason(self):
        """Проекта нет на Raven: причина видна в логе, а не «просто не ушло»."""
        self.app.raven_api.get_project = lambda address, market_id, **kw: None
        self._deliver("2026-09-14T10:01:00Z", 250)

        warns = self._lines("warn")
        self.assertTrue(any(f"market_id={SITE_MARKET_ID}" in t for t in warns), warns)
        self.assertTrue(any("проект не найден" in t for t in warns), warns)
        self.assertEqual(self.contributed, [])

    def test_transient_lookup_error_is_distinguished_from_missing_project(self):
        """Сеть мигнула: в логе «не ответил», а не «проекта нет»."""
        def lookup(address, market_id, **kwargs):
            self.app.raven_api.last_lookup_error = "Raven Colonial не ответил (timeout)"
            return None

        self.app.raven_api.get_project = lookup
        self._deliver("2026-09-14T10:01:00Z", 250)

        warns = self._lines("warn")
        self.assertTrue(any("не ответил" in t for t in warns), warns)
        self.assertFalse(any("проект не найден" in t for t in warns), warns)
        # Доставка осталась в очереди — уйдёт, когда сервер ответит.
        self.assertEqual(len(self.app._pending_raven_deliveries), 1)

    def test_missing_key_keeps_deliveries_and_warns_once(self):
        """Без ключа RCC доставки не теряются, а подсказка пишется один раз."""
        self.app.raven_api.api_key = ""
        self._deliver("2026-09-14T10:01:00Z", 250)
        self._deliver("2026-09-14T10:02:00Z", 300)

        self.assertEqual(self.contributed, [])
        self.assertEqual(len(self.app._pending_raven_deliveries), 2)
        hints = [t for t in self._lines("warn") if "ключ RCC не задан" in t]
        self.assertEqual(len(hints), 1, hints)

        # Ключ появился — очередь дослалась (одним пакетом на проект: Raven
        # принимает словарь «товар -> тонны», поэтому две доставки стали суммой).
        self.app.raven_api.api_key = "rcc-key"
        self.app._flush_raven_deliveries("Test CMDR", force=True)
        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 550})])
        self.assertEqual(self.app._pending_raven_deliveries, [])
        self.assertEqual(self.app._raven_sent.keys() and len(self.app._raven_sent), 2)

    def test_success_refreshes_site_project(self):
        """После своей доставки «осталось завезти» перечитывается сразу."""
        refreshes = []
        self.app._refresh_site_project = lambda force=False: refreshes.append(force)
        self.app.construction.handle("", json.loads(DOCKED_SITE))
        self.app.construction.handle("", json.loads(DEPOT))

        self._deliver("2026-09-14T10:01:00Z", 250)
        self.assertEqual(refreshes, [True])

    def test_carrier_sales_are_not_queued_for_projects(self):
        """Продажа своему авианосцу — другой путь (/api/fc/{id}/cargo)."""
        carrier_line = (
            '{"timestamp":"2026-09-14T10:05:00Z","event":"MarketSell",'
            '"MarketID":3700005632,"Type":"$steel_name;","Type_Localised":"Steel",'
            '"Count":120,"CarrierID":3700005632,"StationType":"FleetCarrier"}'
        )
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(carrier_line + "\n")
        self.offset = self._tick(self.path, self.offset)

        self.assertEqual(self.contributed, [])
        self.assertEqual(self.app._pending_raven_deliveries, [])
        self.assertEqual(self._lines("warn"), [], self._texts())

    def test_cargo_delta_does_not_pollute_the_skip_report(self):
        """Убыль трюма без MarketID — не «отказ», а другой источник доставки."""
        before = (
            '{"timestamp":"2026-09-14T10:06:00Z","event":"Cargo","Count":2,'
            '"Inventory":[{"Name":"steel","Name_Localised":"Steel","Count":200}]}'
        )
        after = (
            '{"timestamp":"2026-09-14T10:07:00Z","event":"Cargo","Count":0,'
            '"Inventory":[]}'
        )
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(before + "\n" + after + "\n")
        self.offset = self._tick(self.path, self.offset)

        self.assertEqual(self._lines("warn"), [], self._texts())
        self.assertEqual(self.contributed, [])


# ---------------------------------------------------------------------------
class RavenQueueRetrySpamTests(AppTestCase):
    """Недоставленная строка: повтор раз в минуту, а не на каждом тике.

    Очередь досылки жила вечно: «проект не найден» означал, что каждые пять
    секунд вотчер заново опрашивал Raven и писал в лог одну и ту же сводку.
    Теперь состав очереди сравнивается с прошлым, попытка повторяется не чаще
    `RAVEN_IDLE_RETRY_SECONDS`, а безнадёжные строки (нет MarketID, нет
    тоннажа) снимаются сразу — они не могут стать отправимыми позже.
    """

    def setUp(self):
        super().setUp()
        self.path = self._write_journal([LOCATION, DOCKED_SITE])
        self.offset = self.path.stat().st_size
        self.app.raven_api.get_project = lambda address, market_id, **kwargs: None

    def _deliver(self, timestamp, amount, market_id=SITE_MARKET_ID):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(contribution(timestamp, amount, market_id=market_id) + "\n")
        self.offset = self._tick(self.path, self.offset)

    def _skip_lines(self):
        return [text for text in self._lines("warn") if "не отправлено" in text]

    def test_stuck_delivery_is_reported_once_across_ticks(self):
        """Шесть тиков подряд — одна сводка, а не шесть одинаковых строк."""
        self._deliver("2026-09-14T10:01:00Z", 250)
        self.assertEqual(len(self._skip_lines()), 1, self._lines("warn"))

        for _ in range(6):
            self.app._send_deliveries_to_raven([], "Test CMDR")

        self.assertEqual(len(self._skip_lines()), 1, self._skip_lines())
        self.assertEqual(len(self.app._pending_raven_deliveries), 1)

    def test_stuck_delivery_is_retried_after_idle_interval(self):
        """Проект появился позже: строка из очереди всё-таки уходит."""
        self._deliver("2026-09-14T10:01:00Z", 250)
        self.assertEqual(self.contributed, [])

        self.app.raven_api.get_project = lambda address, market_id, **kwargs: dict(PROJECT)
        self.app._raven_last_attempt = 0.0          # пауза между попытками истекла
        self.app._send_deliveries_to_raven([], "Test CMDR")

        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 250})])
        self.assertEqual(self.app._pending_raven_deliveries, [])

    def test_report_repeats_when_its_content_changes(self):
        """Вторая недоставленная строка меняет сводку — об этом пишем снова."""
        self._deliver("2026-09-14T10:01:00Z", 250)
        self._deliver("2026-09-14T10:02:00Z", 300)

        lines = self._skip_lines()
        self.assertEqual(len(lines), 2, lines)
        self.assertIn("не отправлено 2 доставок", lines[-1])

    def test_gives_up_after_max_attempts(self):
        """Вечно держать строку в очереди бессмысленно — снимаем и сообщаем."""
        self._deliver("2026-09-14T10:01:00Z", 250)
        clock = {"now": 1000.0}
        with mock.patch.object(self.module.time, "monotonic", lambda: clock["now"]):
            for _ in range(self.app.RAVEN_MAX_ATTEMPTS + 2):
                # Между попытками проходит пауза «проект не нашёлся»: именно
                # так это и происходит в жизни (редкие повторы, не каждый тик).
                clock["now"] += self.app.RAVEN_SITE_MISS_RETRY_SECONDS + 1
                self.app._raven_last_attempt = 0.0
                self.app._send_deliveries_to_raven([], "Test CMDR")

        self.assertEqual(self.app._pending_raven_deliveries, [])
        self.assertTrue(any("снято с досылки" in text for text in self._skip_lines()),
                        self._lines("warn"))
        # Очередь пуста: дальнейшие тики молчат и Raven не дёргают.
        reported = len(self._skip_lines())
        for _ in range(3):
            self.app._send_deliveries_to_raven([], "Test CMDR")
        self.assertEqual(len(self._skip_lines()), reported)
        self.assertEqual(self.contributed, [])

    def test_structural_problem_is_dropped_without_retry(self):
        """Без MarketID строка не «ждёт повтора»: она не отправима в принципе."""
        self._deliver("2026-09-14T10:01:00Z", 250, market_id=0)

        self.assertEqual(self.app._pending_raven_deliveries, [])
        self.assertTrue(any("в событии нет MarketID" in text
                            for text in self._lines("warn")), self._lines("warn"))

    def test_retryable_server_error_also_counts_attempts(self):
        """5xx подряд не крутит очередь бесконечно: счётчик попыток общий."""
        self.app.raven_api.get_project = lambda address, market_id, **kwargs: dict(PROJECT)
        self.app.raven_api.contribute = lambda build_id, cmdr, commodities: {
            "ok": False, "error": "HTTP 503", "retryable": True}
        self._deliver("2026-09-14T10:01:00Z", 250)

        for _ in range(self.app.RAVEN_MAX_ATTEMPTS + 2):
            self.app._raven_last_attempt = 0.0
            self.app._raven_fail_streak = 0
            self.app._send_deliveries_to_raven([], "Test CMDR")

        self.assertEqual(self.app._pending_raven_deliveries, [])
        self.assertEqual(self.contributed, [])


# ---------------------------------------------------------------------------
class SiteProjectResolutionTests(AppTestCase):
    """Поиск проекта площадки: одна попытка на площадку, а не на доставку.

    Именно здесь тонны терялись по-настоящему: проект в Raven есть, но его
    `marketId` не совпадает с журнальным `MarketID` площадки (проект создавали
    через сайт или из события другой площадки). Точный поиск отвечал 404,
    очередь переспрашивала Raven на каждом тике, а `contribute` не вызывался
    вовсе — со стороны это выглядело как «зацикливается, а ресурсы в проект не
    приходят».
    """

    def setUp(self):
        super().setUp()
        self.path = self._write_journal([LOCATION, DOCKED_SITE])
        self.offset = self.path.stat().st_size
        self.lookups = []

    def _deliver(self, timestamp, amount, commodity="$steel_name;", localised="Steel"):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(contribution(timestamp, amount, token=commodity, localised=localised) + "\n")
        self.offset = self._tick(self.path, self.offset)

    def _counting_lookup(self, result, source="market", error=""):
        def lookup(address, market_id, **kwargs):
            self.lookups.append((address, market_id))
            self.app.raven_api.last_lookup_source = source if result else ""
            self.app.raven_api.last_lookup_error = "" if result else error
            return dict(result) if result else None

        self.app.raven_api.get_project = lookup

    def test_one_lookup_per_site_not_per_delivery(self):
        """Четыре недоставленные строки на одну площадку = один запрос."""
        self._counting_lookup(None, error="проекта пока нет в Raven Colonial")
        for index in range(4):
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(contribution(f"2026-09-14T10:0{index}:00Z", 100 + index) + "\n")
        size = self.path.stat().st_size
        self.app._process_journal_changes(self.path, self.offset, size, live=True)
        self.offset = size

        self.assertEqual(len(self.lookups), 1, self.lookups)
        self.assertEqual(len(self.app._pending_raven_deliveries), 4)

    def test_unresolved_site_stops_hammering_raven(self):
        """Проект не нашёлся — дальше спрашиваем редко и молча."""
        self._counting_lookup(None, error="проекта пока нет в Raven Colonial")
        self._deliver("2026-09-14T10:01:00Z", 250)
        first_round = len(self.lookups)

        clock = {"now": 5000.0}
        with mock.patch.object(self.module.time, "monotonic", lambda: clock["now"]):
            for tick in range(20):
                clock["now"] += 5.0                      # тик вотчера раз в 5 с
                self.app._raven_last_attempt = 0.0
                self.app._send_deliveries_to_raven([], "Test CMDR")
            paused = len(self.lookups) - first_round
            self.assertLessEqual(paused, self.app.RAVEN_SITE_MISS_FAST_TRIES,
                                 f"слишком много запросов к Raven: {self.lookups}")

            # Пауза истекла — спросили снова (проект могли создать).
            clock["now"] += self.app.RAVEN_SITE_MISS_RETRY_SECONDS + 1
            self.app._raven_last_attempt = 0.0
            self.app._send_deliveries_to_raven([], "Test CMDR")
            self.assertGreater(len(self.lookups), first_round + paused)

        warns = [t for t in self._lines("warn") if "не отправлено" in t]
        self.assertLessEqual(len(warns), 2, warns)

    def test_unresolved_site_explains_what_to_do_once(self):
        """Одна подсказка «создайте проект или привяжите площадку», не поток."""
        self._counting_lookup(None, error="в системе 2 активных проектов и ни один "
                                          "не привязан к market_id 3951663874")
        self._deliver("2026-09-14T10:01:00Z", 250)
        for _ in range(3):
            self.app._raven_last_attempt = 0.0
            self.app._raven_site_miss.clear()
            self.app._send_deliveries_to_raven([], "Test CMDR")

        hints = [t for t in self._lines("warn") if "привяжите площадку" in t]
        self.assertEqual(len(hints), 1, self._lines("warn"))
        self.assertIn("250 t ждут отправки", hints[0])

    def test_project_found_by_system_reaches_raven(self):
        """Проект нашёлся по системе (market_id не совпал) — тонны уходят."""
        self._counting_lookup({"buildId": "b-sys", "buildName": "A 1"}, source="system")
        self._deliver("2026-09-14T10:01:00Z", 250)

        self.assertEqual(self.contributed, [("b-sys", "Test CMDR", {"steel": 250})])
        self.assertTrue(any("найден: system" in t for t in self._texts()), self._texts())

    def test_manual_binding_overrides_lookup(self):
        """Привязка площадки к проекту важнее любого поиска."""
        self._counting_lookup(None, error="проекта пока нет в Raven Colonial")
        self.app.config["raven_site_bindings"] = {
            str(SITE_MARKET_ID): {"build_id": "b-manual", "name": "Моя стройка"}}
        self._deliver("2026-09-14T10:01:00Z", 250)

        self.assertEqual(self.contributed, [("b-manual", "Test CMDR", {"steel": 250})])
        self.assertEqual(self.lookups, [], "привязанную площадку не ищем по market_id")

    def test_localised_commodity_name_reaches_raven_canonical(self):
        """«Liquid oxygen» без FDName-токена не должно уйти именем с пробелом."""
        self._counting_lookup(dict(PROJECT), source="market")
        self._deliver("2026-09-14T10:01:00Z", 120, commodity="", localised="Liquid oxygen")

        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"liquidoxygen": 120})])

    def test_force_refresh_invalidates_project_cache(self):
        """«Перечитать сразу» не должно упираться в кэш на пять минут."""
        invalidated = []
        # Площадка появляется из журнала — тем же путём, что и в жизни.
        with self._inline_threads():
            self.app._restore_station_state_from_journal()
        self.assertIsNotNone(self.app.construction.site)

        self.app.raven_api.invalidate_project_cache = (
            lambda address=None, market_id=None: invalidated.append((address, market_id)))
        self.app.raven_api.get_project = lambda address, market_id, **kw: dict(PROJECT)
        self.app._site_remote_at = 0.0
        self.app._refresh_site_project()             # обычный опрос по таймеру
        self.assertEqual(invalidated, [])
        self.app._refresh_site_project(force=True)
        self.assertEqual(invalidated, [(SITE_ADDRESS, SITE_MARKET_ID)])


# ---------------------------------------------------------------------------
class EndToEndFallbackTests(AppTestCase):
    """Живой `RavenColonialAPI` + фейковая сеть: от строки журнала до contribute.

    Все остальные тесты подменяют `get_project`/`contribute` заглушками, а
    здесь работает настоящий клиент: сам строит URL, сам решает, где искать
    проект, сам кодирует имя командира. Это единственная проверка того, что
    цепочка «журнал -> поиск проекта -> contribute» сходится целиком.
    """

    class _Resp:
        def __init__(self, ok=True, status=200, payload=None, text=""):
            self.ok = ok
            self.status_code = status
            self._payload = payload
            self.text = text

        def json(self):
            if self._payload is None:
                raise ValueError("no json")
            return self._payload

    def _install(self, system_projects, contribute_status=200):
        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("rcc-key")
        requests = []
        outer = self

        class Session:
            def get(self, url, headers=None, timeout=None):
                requests.append(("GET", url, None))
                if url.endswith(f"/system/{SITE_ADDRESS}/{SITE_MARKET_ID}"):
                    return outer._Resp(ok=False, status=404, text="")
                if url.endswith(f"/system/{SITE_ADDRESS}"):
                    return outer._Resp(payload=system_projects)
                return outer._Resp(ok=False, status=404, text="")

            def post(self, url, headers=None, json=None, timeout=None):
                requests.append(("POST", url, json))
                ok = contribute_status == 200
                return outer._Resp(ok=ok, status=contribute_status,
                                   payload={"ok": True} if ok else None,
                                   text="" if ok else "nope")

            def request(self, method, url, headers=None, json=None, timeout=None):
                requests.append((method, url, json))
                return outer._Resp(payload={})

        api._session = Session()
        self.app.raven_api = api
        return requests

    def setUp(self):
        super().setUp()
        self.path = self._write_journal([LOCATION, DOCKED_SITE])
        self.offset = self.path.stat().st_size

    def _deliver(self, timestamp, amount):
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(contribution(timestamp, amount) + "\n")
        size = self.path.stat().st_size
        self.app._process_journal_changes(self.path, self.offset, size, live=True)
        self.offset = size

    def test_tons_reach_project_when_market_id_does_not_match(self):
        """Проект создан через сайт: market_id другой, тонны всё равно зачтутся."""
        requests = self._install([
            {"buildId": "b-web", "buildName": "A 1", "marketId": 777,
             "commodities": {"steel": 4000}},
        ])
        self._deliver("2026-09-14T10:01:00Z", 250)

        posts = [item for item in requests if item[0] == "POST"]
        self.assertEqual(len(posts), 1, requests)
        method, url, body = posts[0]
        self.assertTrue(url.endswith("/project/b-web/contribute/Test%20CMDR"), url)
        self.assertEqual(body, {"steel": 250})
        self.assertTrue(any("найден: system" in t for t in self._texts()), self._texts())

    def test_several_projects_without_match_do_not_send_anywhere(self):
        """Угадывать проект нельзя: тонны ждут привязки, а не чужой стройки."""
        requests = self._install([
            {"buildId": "b-1", "marketId": 777},
            {"buildId": "b-2", "marketId": 888},
        ])
        self._deliver("2026-09-14T10:01:00Z", 250)

        self.assertEqual([item for item in requests if item[0] == "POST"], [])
        self.assertEqual(len(self.app._pending_raven_deliveries), 1)
        self.assertTrue(any("привяжите площадку к проекту вручную" in t
                            for t in self._lines("warn")), self._texts())

    def test_manual_binding_sends_straight_to_bound_project(self):
        requests = self._install([{"buildId": "b-1", "marketId": 777},
                                  {"buildId": "b-2", "marketId": 888}])
        self.app.config["raven_site_bindings"] = {
            str(SITE_MARKET_ID): {"build_id": "b-2", "name": "Моя стройка"}}
        self._deliver("2026-09-14T10:01:00Z", 250)

        posts = [item for item in requests if item[0] == "POST"]
        self.assertEqual(len(posts), 1, requests)
        self.assertTrue(posts[0][1].endswith("/project/b-2/contribute/Test%20CMDR"),
                        posts[0][1])
        self.assertEqual(posts[0][2], {"steel": 250})


# ---------------------------------------------------------------------------
class SiteBindingTests(AppTestCase):
    """Привязка площадки к проекту — когда поиск не может решить сам.

    В системе может быть несколько активных проектов, а проект, созданный через
    сайт, часто имеет другой `marketId`. Без привязки тонны зависали в очереди
    с «проект не найден» и в проект не попадали вовсе.
    """

    def setUp(self):
        super().setUp()
        self._write_journal([LOCATION, DOCKED_SITE, DEPOT])
        with self._inline_threads():
            self.app._restore_station_state_from_journal()
        self.logged.clear()
        self.app._selected_colony_project = lambda: {
            "buildId": "b-manual", "buildName": "Моя стройка", "systemName": "HIP 22460"}
        self.resolved = []
        self.app.raven_api.resolve_project_by_id = (
            lambda build_id: self.resolved.append(build_id) or {
                "buildId": build_id, "buildName": "Моя стройка",
                "commodities": {"steel": 4000}})
        self.app.raven_api.get_project = lambda address, market_id, **kw: None

    def test_binding_is_stored_in_config(self):
        with self._inline_threads():
            self.app._on_colony_bind_site()

        record = self.app.config["raven_site_bindings"][str(SITE_MARKET_ID)]
        self.assertEqual(record["build_id"], "b-manual")
        self.assertEqual(record["system"], "HIP 22460")

    def test_waiting_deliveries_go_to_bound_project(self):
        """То, что висело в очереди с «проект не найден», уходит сразу."""
        self.app._queue_raven_deliveries([{
            "source": "colonisation_contribution", "market_id": SITE_MARKET_ID,
            "system_address": SITE_ADDRESS, "commodity": "steel", "amount": 250,
            "delivered_at": "2026-09-14T10:01:00Z"}])
        self.assertEqual(len(self.app._pending_raven_deliveries), 1)

        with self._inline_threads():
            self.app._on_colony_bind_site()

        self.assertEqual(self.contributed, [("b-manual", "Test CMDR", {"steel": 250})])
        self.assertEqual(self.app._pending_raven_deliveries, [])
        self.assertTrue(any("дослано 1 доставок" in t for t in self._texts()), self._texts())

    def test_bound_project_card_is_fetched_once(self):
        """Карточку проекта не спрашиваем на каждую отправку."""
        with self._inline_threads():
            self.app._on_colony_bind_site()
        for _ in range(3):
            self.app._send_deliveries_to_raven([{
                "source": "colonisation_contribution", "market_id": SITE_MARKET_ID,
                "system_address": SITE_ADDRESS, "commodity": "steel", "amount": 10,
                "delivered_at": f"2026-09-14T10:0{_}:00Z"}], "Test CMDR")

        self.assertEqual(self.resolved, ["b-manual"], self.resolved)
        self.assertEqual(len(self.contributed), 3)

    def test_site_project_display_follows_binding(self):
        """«Осталось завезти» — по привязанному проекту, а не по market_id."""
        with self._inline_threads():
            self.app._on_colony_bind_site()
            self.app._load_site_project(SITE_ADDRESS, SITE_MARKET_ID)

        self.assertEqual(self.app.site_project["buildId"], "b-manual")
        self.assertTrue(any("осталось завезти 4 000 t" in t for t in self._texts()),
                        self._texts())

    def test_unbind_returns_to_lookup(self):
        with self._inline_threads():
            self.app._on_colony_bind_site()
            self.app._on_colony_unbind_site()

        self.assertEqual(self.app.config["raven_site_bindings"], {})
        self.assertTrue(any("Привязка площадки" in t and "снята" in t
                            for t in self._texts()), self._texts())
        # Без привязки проект снова ищется по market_id (и не находится).
        self.app._send_deliveries_to_raven([{
            "source": "colonisation_contribution", "market_id": SITE_MARKET_ID,
            "system_address": SITE_ADDRESS, "commodity": "steel", "amount": 20,
            "delivered_at": "2026-09-14T10:09:00Z"}], "Test CMDR")
        self.assertEqual(self.contributed, [])

    def test_bind_without_selected_project_explains(self):
        self.app._selected_colony_project = lambda: None
        self.app._on_colony_bind_site()
        self.assertTrue(any("Выберите проект" in t for t in self._lines("warn")),
                        self._texts())

    def test_bind_without_known_site_explains(self):
        self.app.construction.reset()
        self.app._on_colony_bind_site()
        self.assertTrue(any("Стройплощадка не определена" in t for t in self._lines("warn")),
                        self._texts())


# ---------------------------------------------------------------------------
class RavenFlushConcurrencyTests(AppTestCase):
    """Очередь досылают несколько потоков: watcher, проверка ключа, привязка."""

    def test_concurrent_flushes_send_each_delivery_once(self):
        import threading as real_threading

        self.app.raven_api.get_project = lambda address, market_id, **kw: dict(PROJECT)
        calls = []
        barrier = real_threading.Barrier(2, timeout=10)

        def contribute(build_id, cmdr, commodities):
            calls.append(dict(commodities))
            time.sleep(0.05)          # окно, в котором второй поток успел бы повторить
            return {"ok": True}

        self.app.raven_api.contribute = contribute
        self.app._queue_raven_deliveries([{
            "source": "colonisation_contribution", "market_id": SITE_MARKET_ID,
            "system_address": SITE_ADDRESS, "commodity": "steel", "amount": 250,
            "delivered_at": "2026-09-14T10:01:00Z"}])

        def worker():
            barrier.wait()
            self.app._flush_raven_deliveries("Test CMDR", force=True)

        threads = [real_threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertEqual(calls, [{"steel": 250}], calls)
        self.assertEqual(self.app._pending_raven_deliveries, [])


# ---------------------------------------------------------------------------
class RavenCreditCheckTests(AppTestCase):
    """Raven ответил 200, но зачислились ли тонны проекту?"""

    def _snapshot(self):
        """Один снимок проекта площадки — как после опроса по таймеру."""
        self.app._load_site_project(SITE_ADDRESS, SITE_MARKET_ID)

    def test_credited_delivery_stays_silent(self):
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": 1000}}
        self._snapshot()                                    # предыдущий снимок
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": 750}}
        self.app._raven_credit_pending = {"steel": 250}
        self._snapshot()

        self.assertEqual([t for t in self._lines("warn") if "не зачтены" in t], [])

    def _send(self, tons_by_commodity, snapshots=2):
        """Отправка + снимки потребности: первый сразу, второй — по таймеру."""
        self.app._raven_credit_pending = dict(tons_by_commodity)
        self.app._raven_credit_checks = 0
        for _ in range(snapshots):
            self._snapshot()

    def test_need_not_reduced_is_reported(self):
        """Классический «ответили, но не пришло»: потребность не изменилась."""
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": 1000}}
        self._snapshot()                                    # «до»
        self._send({"steel": 250})

        warns = [t for t in self._lines("warn") if "не зачтены" in t]
        self.assertEqual(len(warns), 1, self._texts())
        self.assertIn("steel (250 t)", warns[0])
        self.assertIn("потребность не уменьшилась", warns[0])

    def test_first_snapshot_after_send_does_not_panic(self):
        """Raven может зачесть тонны не мгновенно — по первому снимку не ругаемся."""
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": 1000}}
        self._snapshot()
        self._send({"steel": 250}, snapshots=1)

        self.assertEqual([t for t in self._lines("warn") if "не зачтены" in t], [])
        self.assertEqual(self.app._raven_credit_pending, {"steel": 250})

    def test_late_credit_clears_the_wait(self):
        """Потребность уменьшилась на втором снимке — предупреждения нет."""
        state = {"left": 1000}
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": state["left"]}}
        self._snapshot()
        self.app._raven_credit_pending = {"steel": 250}
        self.app._raven_credit_checks = 0
        self._snapshot()                                    # ещё не зачтено
        state["left"] = 750
        self._snapshot()                                    # зачтено

        self.assertEqual([t for t in self._lines("warn") if "не зачтены" in t], [])
        self.assertEqual(self.app._raven_credit_pending, {})

    def test_unknown_commodity_is_reported(self):
        """Товара нет в потребности проекта — тонны ушли в никуда."""
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": 1000}}
        self._snapshot()
        self._send({"platinum": 40})

        warns = [t for t in self._lines("warn") if "не зачтены" in t]
        self.assertEqual(len(warns), 1, self._texts())
        self.assertIn("товара нет в потребности проекта", warns[0])

    def test_same_warning_is_not_repeated(self):
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": 1000}}
        self._snapshot()
        for _ in range(3):
            self._send({"steel": 250})

        warns = [t for t in self._lines("warn") if "не зачтены" in t]
        self.assertEqual(len(warns), 1, warns)

    def test_warning_returns_after_problem_is_fixed(self):
        """Зачтено -> снова не зачтено: жалоба возвращается, а не глохнет навсегда."""
        state = {"left": 1000}
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": state["left"]}}
        self._snapshot()
        self._send({"steel": 250})                          # не зачтено -> жалоба
        state["left"] = 750
        self._send({"steel": 100}, snapshots=1)             # зачтено
        self._snapshot()
        self._send({"steel": 500})                          # снова не зачтено

        warns = [t for t in self._lines("warn") if "не зачтены" in t]
        self.assertEqual(len(warns), 2, warns)

    def test_no_snapshot_before_means_no_guessing(self):
        """Без «до» сравнивать не с чем — молчим, чтобы не врать."""
        self.app.raven_api.get_project = lambda a, m, **kw: {
            "buildId": "b-site", "commodities": {"steel": 1000}}
        self.app._raven_credit_pending = {"steel": 250}
        self._snapshot()

        self.assertEqual([t for t in self._lines("warn") if "не зачтены" in t], [])


# ---------------------------------------------------------------------------
class RavenLedgerTests(AppTestCase):
    """Журнал отправленного: одна доставка = одни тонны, даже после рестарта."""

    DELIVERY = {
        "source": "colonisation_contribution",
        "market_id": SITE_MARKET_ID,
        "system_address": SITE_ADDRESS,
        "commodity": "$steel_name;",
        "amount": 250,
        "delivered_at": "2026-09-14T10:01:00Z",
        "source_hash": "journal-v2-abc123",
    }

    def test_same_delivery_is_not_sent_twice(self):
        self.app._send_deliveries_to_raven([dict(self.DELIVERY)], "Test CMDR")
        self.app._send_deliveries_to_raven([dict(self.DELIVERY)], "Test CMDR")

        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 250})])

    def test_ledger_survives_restart(self):
        self.app._send_deliveries_to_raven([dict(self.DELIVERY)], "Test CMDR")
        ledger_path = self.home / ".colonial_helper_raven_sent.json"
        self.assertTrue(ledger_path.exists())
        saved = json.loads(ledger_path.read_text(encoding="utf-8"))
        self.assertIn("journal-v2-abc123", saved)

        # «Перезапуск»: новый экземпляр читает тот же файл.
        self.app._raven_sent = self.app._load_raven_ledger()
        self.contributed.clear()
        self.app._send_deliveries_to_raven([dict(self.DELIVERY)], "Test CMDR")
        self.assertEqual(self.contributed, [])

    def test_key_without_source_hash_is_stable(self):
        """Старые записи без source_hash тоже узнаются (по полям доставки)."""
        delivery = {key: value for key, value in self.DELIVERY.items() if key != "source_hash"}
        first = self.app._raven_delivery_key(delivery)
        second = self.app._raven_delivery_key(dict(delivery))
        self.assertEqual(first, second)
        self.assertTrue(first)

        self.app._send_deliveries_to_raven([dict(delivery)], "Test CMDR")
        self.app._send_deliveries_to_raven([dict(delivery)], "Test CMDR")
        self.assertEqual(len(self.contributed), 1)

    def test_failed_send_is_not_marked_as_sent(self):
        self.app.raven_api.contribute = lambda *a, **k: {
            "ok": False, "error": "HTTP 503", "retryable": True}
        self.app._send_deliveries_to_raven([dict(self.DELIVERY)], "Test CMDR")
        self.assertEqual(self.app._raven_sent, {})

    def test_ledger_is_bounded(self):
        self.app._raven_sent = {f"hash-{i}": {"tons": 1, "at": float(i)} for i in range(6000)}
        self.app._save_raven_ledger()
        self.assertLessEqual(len(self.app._raven_sent), 5000)


# ---------------------------------------------------------------------------
class JournalSiteDeliveryTests(AppTestCase):
    """«Смотреть в журнале, были ли завезены товары на стройплощадку»."""

    def setUp(self):
        super().setUp()
        self._write_journal([
            LOCATION,
            DOCKED_SITE,
            DEPOT,
            contribution("2026-09-14T10:01:00Z", 250),
            contribution("2026-09-14T10:20:00Z", 120, token="$liquidoxygen_name;",
                         localised="Liquid oxygen"),
            # Чужая площадка — в сверку не попадает.
            contribution("2026-09-14T10:30:00Z", 999, market_id=3999999999),
        ])

    def test_deliveries_are_filtered_by_market_id(self):
        result = self.app._journal_site_deliveries(SITE_MARKET_ID)
        self.assertEqual(result["total"], 370)
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["tons"], {"steel": 250, "liquidoxygen": 120})
        self.assertEqual(result["last_at"], "2026-09-14T10:20:00Z")

    def test_hashes_match_live_parser(self):
        """Ключи совпадают с live-разбором — иначе дубль не узнается."""
        from journal_parser import parse_journal

        text = (self.journal_dir / "Journal.260914100000.01.log").read_text(encoding="utf-8")
        _cmdr, live, *_rest = parse_journal(text, "HIP 22460", current_system_address=SITE_ADDRESS)
        live_hashes = {d["source_hash"] for d in live
                       if d.get("source") == "colonisation_contribution"}
        scanned = self.app._journal_site_deliveries(SITE_MARKET_ID)
        scanned_hashes = {d["source_hash"] for d in scanned["deliveries"]}

        self.assertTrue(live_hashes)
        self.assertEqual(live_hashes & scanned_hashes, scanned_hashes)

    def test_missing_site_is_reported_not_guessed(self):
        result = self.app._journal_site_deliveries(1)
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["deliveries"], [])


# ---------------------------------------------------------------------------
class SiteReconcileTests(AppTestCase):
    """Кнопка «Сверить стройплощадку с Raven»."""

    def setUp(self):
        super().setUp()
        self._write_journal([LOCATION, DOCKED_SITE, DEPOT,
                             contribution("2026-09-14T10:01:00Z", 250)])
        with self._inline_threads():
            self.app._restore_station_state_from_journal()
        self.logged.clear()

    def test_report_shows_remote_remaining_and_journal_totals(self):
        with self._inline_threads():
            self.app._on_colony_reconcile()

        report = "\n".join(self._texts())
        self.assertIn(f"Сверка стройплощадки {SITE_MARKET_ID}", report)
        self.assertIn("осталось завезти 6 730 t", report)   # данные Raven Colonial
        self.assertIn("вы завезли 250 t", report)           # данные журнала
        self.assertIn("b-site", report)

    def test_only_unsent_deliveries_are_offered(self):
        """Уже зачтённые тонны второй раз не отправляются."""
        journal = self.app._journal_site_deliveries(SITE_MARKET_ID)
        self.app._raven_sent[self.app._raven_delivery_key(journal["deliveries"][0])] = {
            "build_id": "b-site", "tons": 250, "at": time.time()}

        with self._inline_threads(), \
             mock.patch.object(self.module.messagebox, "askyesno", return_value=True) as ask:
            self.app._on_colony_reconcile()

        ask.assert_not_called()
        self.assertEqual(self.contributed, [])

    def test_unsent_deliveries_are_sent_after_confirmation(self):
        with self._inline_threads(), \
             mock.patch.object(self.module.messagebox, "askyesno", return_value=True):
            self.app._on_colony_reconcile()

        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 250})])

    def test_declined_confirmation_sends_nothing(self):
        with self._inline_threads(), \
             mock.patch.object(self.module.messagebox, "askyesno", return_value=False):
            self.app._on_colony_reconcile()
        self.assertEqual(self.contributed, [])

    def test_carrier_market_is_refreshed_too(self):
        """Состояние рынка авианосца тоже перечитывается (груз возят другие)."""
        self.app.carrier.state.market_id = 3700005632
        calls = []
        self.app._refresh_carrier_cargo = lambda market_id, force=False: calls.append(
            (market_id, force))

        with self._inline_threads():
            self.app._on_colony_reconcile()

        self.assertIn((3700005632, True), calls)

    def test_project_without_build_explains_what_to_do(self):
        self.app.raven_api.get_project = lambda address, market_id, **kw: None
        with self._inline_threads():
            self.app._on_colony_reconcile()

        warns = self._lines("warn")
        self.assertTrue(any("тонны не зачтутся" in t for t in warns), self._texts())
        self.assertTrue(any("250" in t for t in warns), warns)

    def test_no_key_explains_without_requests(self):
        self.app.raven_api.api_key = ""
        with self._inline_threads():
            self.app._on_colony_reconcile()
        self.assertTrue(any("ключ RCC не задан" in t for t in self._lines("warn")))
        self.assertEqual(self.contributed, [])

    def test_no_site_explains_where_to_dock(self):
        self.app.construction.reset()
        with self._inline_threads():
            self.app._on_colony_reconcile()
        self.assertTrue(any("Стройплощадка не найдена" in t for t in self._lines("warn")))


# ---------------------------------------------------------------------------
class RestoreStationStateTests(AppTestCase):
    """Программу запустили, когда командир уже стоит у площадки / на борту FC."""

    def test_site_is_restored_and_raven_is_asked(self):
        self._write_journal([LOCATION, DOCKED_SITE, DEPOT])
        lookups = []
        self.app.raven_api.get_project = lambda address, market_id, **kw: (
            lookups.append((address, market_id)) or dict(PROJECT))

        with self._inline_threads():
            restored = self.app._restore_station_state_from_journal()

        self.assertTrue(restored["site"])
        self.assertEqual(self.app.construction.site.market_id, SITE_MARKET_ID)
        self.assertEqual(lookups, [(SITE_ADDRESS, SITE_MARKET_ID)])
        self.assertEqual(self.app.site_project.get("buildId"), "b-site")
        self.assertTrue(any("Восстановлено из журнала" in t for t in self._texts()))

    def test_carrier_is_restored_and_cargo_is_asked(self):
        self._write_journal([
            '{"timestamp":"2026-09-14T09:00:00Z","event":"CarrierStats",'
            '"CarrierID":3700005632,"Callsign":"L14-X1J","Name":"Spirula",'
            '"SpaceUsage":{"TotalCapacity":25000,"Crew":5450,"Cargo":440,'
            '"CargoSpaceReserved":44,"ShipPacks":774,"ModulePacks":913,"FreeSpace":17379}}',
            '{"timestamp":"2026-09-14T09:05:00Z","event":"Docked",'
            '"StationName":"FC Spirula","StationType":"FleetCarrier",'
            '"MarketID":3700005632,"StarSystem":"Hermitage","SystemAddress":5363877956440}',
        ])
        calls = []
        self.app.raven_api.get_fc_cargo = lambda market_id: (
            calls.append(market_id) or {"ok": True, "data": {"steel": 250}})

        with self._inline_threads():
            restored = self.app._restore_station_state_from_journal()

        self.assertTrue(restored["carrier"])
        self.assertEqual(self.app.carrier.state.market_id, 3700005632)
        self.assertEqual(calls, [3700005632])
        self.assertEqual(self.app.carrier.state.commodities, {"steel": 250})

    def test_nothing_to_restore_stays_silent(self):
        self._write_journal([LOCATION])
        with self._inline_threads():
            restored = self.app._restore_station_state_from_journal()
        self.assertEqual(restored, {"site": False, "carrier": False})
        self.assertEqual(self._texts(), [])

    def test_empty_journal_folder_does_not_crash(self):
        (self.journal_dir / "Journal.260914100000.01.log").unlink(missing_ok=True)
        with self._inline_threads():
            restored = self.app._restore_station_state_from_journal()
        self.assertEqual(restored, {"site": False, "carrier": False})


# ---------------------------------------------------------------------------
class RemoteRefreshLogTests(AppTestCase):
    """Опрос Raven по таймеру не должен печатать одно и то же."""

    def test_carrier_cargo_line_only_on_change(self):
        self.app.carrier.handle({"timestamp": "2026-09-14T09:00:00Z", "event": "CarrierStats",
                                 "CarrierID": 3700005632,
                                 "SpaceUsage": {"TotalCapacity": 25000, "Cargo": 440,
                                                "FreeSpace": 17379}})
        self.app.raven_api.get_fc_cargo = lambda market_id: {
            "ok": True, "data": {"steel": 250, "liquidoxygen": 100}}

        for _ in range(4):
            self.app._load_carrier_cargo(3700005632)
        first = [t for t in self._texts() if "груз по товарам" in t]
        self.assertEqual(len(first), 1, first)
        self.assertIn("350 t", first[0])

        self.app.raven_api.get_fc_cargo = lambda market_id: {
            "ok": True, "data": {"steel": 300, "liquidoxygen": 100}}
        self.app._load_carrier_cargo(3700005632)
        second = [t for t in self._texts() if "груз по товарам" in t]
        self.assertEqual(len(second), 2, second)

    def test_site_project_line_only_on_change(self):
        for _ in range(4):
            self.app._load_site_project(SITE_ADDRESS, SITE_MARKET_ID)
        lines = [t for t in self._texts() if "осталось завезти" in t]
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("6 730 t", lines[0])

        updated = dict(PROJECT, commodities={"steel": 1000, "liquidoxygen": 1865})
        self.app.raven_api.get_project = lambda address, market_id, **kw: dict(updated)
        self.app._load_site_project(SITE_ADDRESS, SITE_MARKET_ID)
        lines = [t for t in self._texts() if "осталось завезти" in t]
        self.assertEqual(len(lines), 2, lines)
        self.assertIn("2 865 t", lines[1])


class ModulesLogSpamTests(AppTestCase):
    """«Постоянно пишет информацию о корабле, сколько модулей и т.д.»."""

    MODULES = [
        {"Slot": "PowerPlant", "Item": "powerplant_size4_class3", "Health": 1.0,
         "Power": 0.0, "On": True, "Priority": 1},
        {"Slot": "MainEngines", "Item": "engine_size3_class2", "Health": 1.0,
         "Power": 4.2, "On": True, "Priority": 1},
        {"Slot": "CargoHatch", "Item": "cargohatch", "Health": 1.0,
         "Power": 0.6, "On": True, "Priority": 5},
    ]

    def _write(self, modules):
        (self.journal_dir / "Status.json").write_text(
            json.dumps({"Balance": 10, "Cargo": 5}), encoding="utf-8")
        (self.journal_dir / "ModulesInfo.json").write_text(
            json.dumps({"Modules": modules}), encoding="utf-8")
        (self.journal_dir / "Cargo.json").write_text(
            json.dumps({"Count": 5, "Inventory": []}), encoding="utf-8")

    def _module_lines(self):
        return [t for t in self._texts() if t.startswith("Модули:")]

    def test_power_fluctuation_does_not_repeat_the_line(self):
        """Потребление меняется в полёте постоянно — это не новость."""
        for tick in range(12):
            modules = [dict(module) for module in self.MODULES]
            modules[2]["On"] = tick % 2 == 0                 # грузовой захват
            modules[1]["Power"] = 4.2 + (tick % 3) * 0.37    # плавающее потребление
            self._write(modules)
            self.app._load_current_state_files()

        self.assertEqual(len(self._module_lines()), 1, self._module_lines())

    def test_damage_is_still_reported(self):
        self._write(self.MODULES)
        self.app._load_current_state_files()
        self.logged.clear()

        self._write([dict(self.MODULES[0]), dict(self.MODULES[1], Health=0.4),
                     dict(self.MODULES[2])])
        self.app._load_current_state_files()

        lines = self._module_lines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn("повреждено: 1", lines[0])

    def test_oscillating_state_is_not_spammed(self):
        """Устаревший JSON и события журнала качают состояние туда-сюда."""
        self._write(self.MODULES)
        self.app._load_current_state_files()
        broken = [dict(self.MODULES[0]), dict(self.MODULES[1], Health=0.4), dict(self.MODULES[2])]
        self.logged.clear()

        for _ in range(6):
            self._write(broken)
            self.app._load_current_state_files()
            self._write(self.MODULES)
            self.app.ship.state.modules["MainEngines"].health = 0.4
            self.app._load_current_state_files()

        self.assertLessEqual(len(self._module_lines()), 2, self._module_lines())


# ---------------------------------------------------------------------------
class BackfillGatingTests(AppTestCase):
    """История не должна заливать Raven Colonial без явного разрешения."""

    def _queue_history(self):
        self.app._defer_uploads = True
        self.app._backfill_deliveries = [{
            "system_name": "HIP 22460", "commodity": "$steel_name;", "amount": 250,
            "delivered_at": "2026-09-14T10:01:00Z", "market_id": SITE_MARKET_ID,
            "system_address": SITE_ADDRESS, "source": "colonisation_contribution",
            "source_hash": "journal-v2-history",
        }]

    def test_full_history_is_not_sent_without_the_checkbox(self):
        self.app.dispatcher.backfill_enabled = False
        self._queue_history()
        self.app._flush_deferred_uploads(full_history=True)

        self.assertEqual(self.contributed, [])
        self.assertTrue(any("НЕ отправлены" in t for t in self._texts()), self._texts())

    def test_full_history_is_sent_with_the_checkbox(self):
        self.app.dispatcher.backfill_enabled = True
        self._queue_history()
        self.app._flush_deferred_uploads(full_history=True)

        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 250})])

    def test_interrupted_session_is_always_sent(self):
        """Смещения есть — это недосланное за сессию, а не вся история."""
        self.app.dispatcher.backfill_enabled = False
        self._queue_history()
        self.app._flush_deferred_uploads(full_history=False)

        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 250})])

    def test_raven_is_independent_of_site_result_in_history_flush(self):
        self.site_ok = False
        self._queue_history()
        self.app._flush_deferred_uploads(full_history=False)

        self.assertEqual(self.contributed, [("b-site", "Test CMDR", {"steel": 250})])
        self.assertEqual(len(self.app._pending_watcher_deliveries), 1)


# ---------------------------------------------------------------------------
class RavenProjectLookupTests(unittest.TestCase):
    """Кэш поиска проекта: сбой сети != «проекта нет»."""

    def _api(self):
        from raven_colonial_api import RavenColonialAPI

        return RavenColonialAPI("key")

    class _Response:
        def __init__(self, ok=True, status=200, payload=None, text=""):
            self.ok = ok
            self.status_code = status
            self._payload = payload
            self.text = text

        def json(self):
            if self._payload is None:
                raise ValueError("no json")
            return self._payload

    def test_success_is_cached(self):
        api = self._api()
        calls = {"n": 0}

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls["n"] += 1
                return RavenProjectLookupTests._Response(payload={"buildId": "b1"})

        api._session = Session()
        for _ in range(20):
            self.assertEqual(api.get_project(1, 2)["buildId"], "b1")
        self.assertEqual(calls["n"], 1)

    def test_network_error_is_not_cached(self):
        """Одна заминка сети не должна ставить deliveries на паузу в 5 минут."""
        api = self._api()
        state = {"fail": True}

        class Session:
            def get(self, url, headers=None, timeout=None):
                if state["fail"]:
                    raise api._session.__class__ and OSError("timeout")
                return RavenProjectLookupTests._Response(payload={"buildId": "b1"})

        api._session = Session()
        self.assertIsNone(api.get_project(1, 2))
        self.assertIn("не ответил", api.last_lookup_error)

        state["fail"] = False
        self.assertEqual(api.get_project(1, 2)["buildId"], "b1")

    def test_missing_project_is_cached_briefly(self):
        api = self._api()
        calls = {"n": 0}

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls["n"] += 1
                return RavenProjectLookupTests._Response(ok=False, status=404, text="")

        api._session = Session()
        self.assertIsNone(api.get_project(1, 2))
        # Первая проверка — два запроса: точная пара (systemAddress+marketId)
        # и запасной поиск по системе.
        self.assertEqual(calls["n"], 2)
        self.assertIsNone(api.get_project(1, 2))
        # Вторая — из кэша: новых запросов нет, иначе очередь доставок
        # долбила бы Raven на каждом тике.
        self.assertEqual(calls["n"], 2)
        self.assertLess(api.PROJECT_MISS_TTL, api.PROJECT_CACHE_TTL)

    def test_server_error_is_not_cached(self):
        api = self._api()
        calls = {"n": 0}

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls["n"] += 1
                return RavenProjectLookupTests._Response(ok=False, status=503, text="busy")

        api._session = Session()
        self.assertIsNone(api.get_project(1, 2))
        self.assertIsNone(api.get_project(1, 2))
        self.assertEqual(calls["n"], 2)
        self.assertIn("503", api.last_lookup_error)

    def test_invalidate_forces_new_request(self):
        api = self._api()
        calls = {"n": 0}

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls["n"] += 1
                return RavenProjectLookupTests._Response(ok=False, status=404, text="")

        api._session = Session()
        api.get_project(1, 2)                      # точный + по системе
        api.invalidate_project_cache(1, 2)
        api.get_project(1, 2)                      # и ещё раз оба
        self.assertEqual(calls["n"], 4)

    def test_invalidate_other_site_keeps_cache(self):
        api = self._api()
        calls = {"n": 0}

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls["n"] += 1
                return RavenProjectLookupTests._Response(payload={"buildId": "b1"})

        api._session = Session()
        api.get_project(1, 2)
        api.invalidate_project_cache(9, 9)
        api.get_project(1, 2)
        self.assertEqual(calls["n"], 1)


class ProjectSystemFallbackTests(unittest.TestCase):
    """Проект не нашёлся по (systemAddress, marketId) — ищем по системе.

    Ровно тот случай, из-за которого тонны не доходили до проекта: проект в
    Raven есть (его создали через сайт или из события другой площадки), но его
    `marketId` не совпадает с журнальным `MarketID` стройплощадки. Точный поиск
    отвечает 404, и без запасного пути доставки вечно висели в очереди.
    """

    def _api(self):
        from raven_colonial_api import RavenColonialAPI

        return RavenColonialAPI("key")

    class _Response:
        def __init__(self, ok=True, status=200, payload=None, text=""):
            self.ok = ok
            self.status_code = status
            self._payload = payload
            self.text = text

        def json(self):
            if self._payload is None:
                raise ValueError("no json")
            return self._payload

    def _session(self, urls, calls):
        """urls: точный путь -> ответ; прочее -> ответ по умолчанию."""

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls.append(url)
                for suffix, response in urls.items():
                    if url.endswith(suffix):
                        if isinstance(response, Exception):
                            raise response
                        return response
                return ProjectSystemFallbackTests._Response(ok=False, status=404, text="")

        return Session()

    R = _Response

    def test_single_active_project_in_system_is_used(self):
        api = self._api()
        calls = []
        api._session = self._session({
            "/system/1/2": self.R(ok=False, status=404, text=""),
            "/system/1": self.R(payload=[{"buildId": "b-sys", "buildName": "A 1",
                                          "marketId": 999}]),
        }, calls)

        project = api.get_project(1, 2)
        self.assertEqual(project["buildId"], "b-sys")
        self.assertEqual(api.last_lookup_source, "system")
        self.assertEqual(api.last_lookup_error, "")
        self.assertEqual(len(calls), 2)

    def test_matching_market_id_wins_among_several_projects(self):
        api = self._api()
        calls = []
        api._session = self._session({
            "/system/1/2": self.R(ok=False, status=404, text=""),
            "/system/1": self.R(payload=[
                {"buildId": "b-other", "marketId": 7},
                {"buildId": "b-ours", "marketId": 2},
            ]),
        }, calls)

        project = api.get_project(1, 2)
        self.assertEqual(project["buildId"], "b-ours")
        self.assertEqual(api.last_lookup_source, "system+market")

    def test_several_projects_without_match_are_not_guessed(self):
        """Тонны не должны уйти в чужой проект: угадывать нельзя."""
        api = self._api()
        calls = []
        api._session = self._session({
            "/system/1/2": self.R(ok=False, status=404, text=""),
            "/system/1": self.R(payload=[{"buildId": "b-1", "marketId": 7},
                                         {"buildId": "b-2", "marketId": 8}]),
        }, calls)

        self.assertIsNone(api.get_project(1, 2))
        self.assertIn("привяжите площадку к проекту вручную", api.last_lookup_error)
        self.assertEqual(api.last_lookup_source, "")

    def test_no_projects_anywhere_keeps_missing_reason(self):
        api = self._api()
        calls = []
        api._session = self._session({}, calls)      # всё 404

        self.assertIsNone(api.get_project(1, 2))
        self.assertIn("пока нет", api.last_lookup_error)
        self.assertEqual(len(calls), 2)

    def test_system_lookup_is_cached_too(self):
        """Один промах = два запроса, а не по два на каждую доставку."""
        api = self._api()
        calls = []
        api._session = self._session({}, calls)

        for _ in range(10):
            api.get_project(1, 2)
        self.assertEqual(len(calls), 2, calls)

    def test_network_error_in_fallback_is_not_cached(self):
        api = self._api()
        state = {"fail": True}
        calls = []

        class Session:
            def get(self, url, headers=None, timeout=None):
                calls.append(url)
                if state["fail"]:
                    raise OSError("timeout")
                return ProjectSystemFallbackTests._Response(
                    payload=[{"buildId": "b-sys", "marketId": 2}])

        api._session = Session()
        self.assertIsNone(api.get_project(1, 2))
        self.assertIn("не ответил", api.last_lookup_error)

        state["fail"] = False
        self.assertEqual(api.get_project(1, 2)["buildId"], "b-sys")

    def test_dict_shaped_answer_is_accepted(self):
        api = self._api()
        calls = []
        api._session = self._session({
            "/system/1": self.R(payload={"projects": [{"buildId": "b-1", "marketId": 2}]}),
        }, calls)

        self.assertEqual(api.get_project(1, 2)["buildId"], "b-1")

    def test_projects_from_normalizes_shapes(self):
        from raven_colonial_api import projects_from

        self.assertEqual(projects_from([{"buildId": "a"}, {"no": "id"}]), [{"buildId": "a"}])
        self.assertEqual(projects_from({"projects": [{"buildId": "a"}]}), [{"buildId": "a"}])
        self.assertEqual(projects_from({"buildId": "a"}), [{"buildId": "a"}])
        self.assertEqual(projects_from({"data": [{"buildId": "a"}]}), [{"buildId": "a"}])
        self.assertEqual(projects_from(None), [])
        self.assertEqual(projects_from("junk"), [])

    def test_resolve_project_by_id_for_manual_binding(self):
        api = self._api()
        calls = []

        class Session:
            def request(self, method, url, headers=None, json=None, timeout=None):
                calls.append(url)
                return ProjectSystemFallbackTests._Response(
                    payload={"buildId": "b-manual", "buildName": "A 1"})

        api._session = Session()
        project = api.resolve_project_by_id("b-manual")
        self.assertEqual(project["buildId"], "b-manual")
        self.assertEqual(api.last_lookup_source, "id")
        self.assertTrue(calls[0].endswith("/project/b-manual"))
        self.assertIsNone(api.resolve_project_by_id(""))

    def test_resolve_project_by_id_reports_failure(self):
        api = self._api()

        class Session:
            def request(self, method, url, headers=None, json=None, timeout=None):
                return ProjectSystemFallbackTests._Response(ok=False, status=404, text="")

        api._session = Session()
        self.assertIsNone(api.resolve_project_by_id("b-nope"))
        self.assertIn("404", api.last_lookup_error)
        self.assertEqual(api.last_lookup_source, "")


class RavenContributeTests(unittest.TestCase):
    """`POST /api/project/{buildId}/contribute/{cmdr}`."""

    def _api(self):
        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("key")
        self.requests = []

        class Session:
            def post(_self, url, headers=None, json=None, timeout=None):
                self.requests.append({"url": url, "headers": headers, "json": json})
                return self.response

        api._session = Session()
        return api

    class _Response:
        def __init__(self, ok=True, status=200, payload=None, text=""):
            self.ok = ok
            self.status_code = status
            self._payload = payload
            self.text = text

        def json(self):
            if self._payload is None:
                raise ValueError("no json")
            return self._payload

    def test_commander_name_is_url_encoded(self):
        """Документация Raven: «Be sure to URL encode for spaces, etc.»."""
        api = self._api()
        self.response = RavenContributeTests._Response(payload={"ok": True})

        api.contribute("b1", "James Holden", {"steel": 10})
        self.assertIn("/contribute/James%20Holden", self.requests[0]["url"])

    def test_body_is_commodity_to_tons(self):
        api = self._api()
        self.response = RavenContributeTests._Response(payload={"ok": True})

        result = api.contribute("b1", "Cmdr", {"steel": 10, "liquidoxygen": 5})
        self.assertTrue(result["ok"])
        self.assertEqual(self.requests[0]["json"], {"steel": 10, "liquidoxygen": 5})
        self.assertEqual(self.requests[0]["headers"], {"rcc-key": "key"})

    def test_zero_amounts_are_dropped(self):
        api = self._api()
        self.response = RavenContributeTests._Response(payload={"ok": True})

        api.contribute("b1", "Cmdr", {"steel": 0, "liquidoxygen": 5})
        self.assertEqual(self.requests[0]["json"], {"liquidoxygen": 5})

    def test_empty_payload_is_not_sent(self):
        api = self._api()
        self.response = RavenContributeTests._Response(payload={"ok": True})

        result = api.contribute("b1", "Cmdr", {})
        self.assertFalse(result["ok"])
        self.assertEqual(self.requests, [])

    def test_no_key_is_not_sent(self):
        from raven_colonial_api import RavenColonialAPI

        api = RavenColonialAPI("")
        result = api.contribute("b1", "Cmdr", {"steel": 10})
        self.assertFalse(result["ok"])
        self.assertIn("RCC", result["error"])

    def test_server_error_is_retryable(self):
        api = self._api()
        self.response = RavenContributeTests._Response(ok=False, status=503, text="busy")

        result = api.contribute("b1", "Cmdr", {"steel": 10})
        self.assertFalse(result["ok"])
        self.assertTrue(result["retryable"])
        self.assertIn("503", result["error"])

    def test_bad_key_is_not_retryable(self):
        api = self._api()
        self.response = RavenContributeTests._Response(ok=False, status=401, text="")

        result = api.contribute("b1", "Cmdr", {"steel": 10})
        self.assertFalse(result["ok"])
        self.assertFalse(result["retryable"])
        self.assertIn("401", result["error"])

    def test_rate_limit_is_retryable(self):
        api = self._api()
        self.response = RavenContributeTests._Response(ok=False, status=429, text="slow down")

        result = api.contribute("b1", "Cmdr", {"steel": 10})
        self.assertTrue(result["retryable"])

    def test_network_error_is_retryable_and_not_raised(self):
        from raven_colonial_api import RavenColonialAPI
        import requests

        api = RavenColonialAPI("key")

        class Session:
            def post(self, *args, **kwargs):
                raise requests.RequestException("connection reset")

        api._session = Session()
        result = api.contribute("b1", "Cmdr", {"steel": 10})
        self.assertFalse(result["ok"])
        self.assertTrue(result["retryable"])

    def test_empty_commander_falls_back_to_raven_unknown(self):
        """Без имени Raven сам зачисляет тонны на «Unknown» (по документации)."""
        api = self._api()
        self.response = RavenContributeTests._Response(payload={"ok": True})

        api.contribute("b1", "", {"steel": 10})
        self.assertTrue(self.requests[0]["url"].endswith("/contribute/"))


class CommanderNameResolutionTests(AppTestCase):
    """Имя командира для contribute: без него тонны уходят на «Unknown»."""

    def test_journal_name_is_used(self):
        self.assertEqual(self.app._raven_cmdr_name(), "Test CMDR")

    def test_key_display_name_is_used_when_journal_is_silent(self):
        self.app.api.cmdr_name = ""
        self.app._watcher_cmdr_name = ""
        self.app.config["cmdr_name"] = ""
        self.app.construction.commander = ""

        self.assertEqual(self.app._raven_cmdr_name(), "Raven CMDR")

    def test_lookup_is_throttled(self):
        self.app.api.cmdr_name = ""
        self.app._watcher_cmdr_name = ""
        calls = {"n": 0}

        def get_cmdr_by_key(key=""):
            calls["n"] += 1
            return {"ok": False, "data": None}

        self.app.raven_api.get_cmdr_by_key = get_cmdr_by_key
        self.app._raven_cmdr_name()
        self.app._raven_cmdr_name()
        self.assertEqual(calls["n"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
