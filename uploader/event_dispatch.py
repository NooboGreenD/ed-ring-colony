"""Фоновая отправка событий журнала во внешние сервисы.

Сервисы: EDSM, Inara и Raven Colonial (Fleet Carrier cargo).

Почему этот код вынесен в отдельный модуль
------------------------------------------

Раньше отправка была вшита прямо в поток обработки журналов:

* EDSM  — `threading.Thread(...).start()` на **каждое** событие;
* Inara — **синхронный** HTTP-запрос на каждое подходящее событие;
* Raven — **синхронный** HTTP-запрос на каждый MarketSell/MarketBuy на
  Fleet Carrier.

Живой watcher обрабатывает по несколько событий в секунду, и там это почти
незаметно. Но при **первичной загрузке всей истории** (сотни файлов, десятки
и сотни тысяч событий) получалось (замер на тестовом наборе из 800 файлов,
22 МБ, см. CHANGES.md):

* ~37 000 одновременных потоков под EDSM — распухание памяти и исчерпание
  пула соединений;
* ~55 000 последовательных запросов в Inara — часы ожидания;
* ~12 000 последовательных запросов в Raven.

Внешние сервисы вдобавок начинают отвечать 429 (rate limit), запросы
повторяются с таймаутом 15 с, и загрузка встаёт окончательно.

Как работает теперь
-------------------

Один или несколько фоновых воркеров + очередь ограниченного размера:

* `submit()` никогда не блокирует поток обработки — только кладёт задачу в
  очередь (или выбрасывает её, если сервис не успевает, а очередь забита);
* исторические события (первичная загрузка журналов или ручной импорт
  файлов) по умолчанию **не** уходят во внешние сервисы: это живые трекеры,
  им нужны только текущие события. Включается флагом `backfill_enabled`;
* дедупликация событий живёт здесь же, поэтому повторный проход по журналу
  не создаёт повторных запросов.

Модуль не зависит от Tkinter — его можно импортировать и тестировать
отдельно от GUI.
"""

import queue
import threading
import time
from typing import Callable, Optional

# Какие события журнала уходят в EDSM (навигация и сканирование).
EDSM_EVENTS = frozenset({
    "Location", "FSDJump", "Docked", "Scan", "FSSDiscoveryScan", "SAAScanComplete",
})

# События журнала -> имя события Inara API (модель EDDiscovery).
INARA_EVENT_NAMES = {
    "Location": "cmdrLocation",
    "FSDJump": "cmdrFSDJump",
    "Docked": "cmdrDock",
    "Scan": "cmdrScan",
    "FSSDiscoveryScan": "cmdrFSSDiscoveryScan",
    "MarketSell": "cmdrMarketSell",
    "MarketBuy": "cmdrMarketBuy",
    "ColonisationContribution": "cmdrTrade",
}

# Грузовые операции на Fleet Carrier уходят в Raven Colonial (/api/fc/...).
RAVEN_CARGO_EVENTS = frozenset({"MarketSell", "MarketBuy"})

# Результат постановки события в очередь.
_QUEUED = "queued"
_SKIPPED = "skipped"   # дубль или событие сервису не интересно
_DROPPED = "dropped"   # очередь переполнена


class ThirdPartyDispatcher:
    """Отправка событий журнала во внешние API из фоновых потоков."""

    def __init__(
        self,
        edsm_api=None,
        inara_api=None,
        raven_api=None,
        logger: Optional[Callable[[str], None]] = None,
        max_queue: int = 2000,
        workers: int = 2,
        backfill_enabled: bool = False,
    ):
        self.edsm_api = edsm_api
        self.inara_api = inara_api
        self.raven_api = raven_api
        self.logger = logger
        self.backfill_enabled = bool(backfill_enabled)
        self.max_queue = max(1, int(max_queue))
        self.workers = max(1, int(workers))

        self._queue: "queue.Queue" = queue.Queue(maxsize=self.max_queue)
        self._threads = []
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._started = False

        # Дедупликация: ключи уже отправленных событий по каждому сервису.
        self._seen = {"edsm": set(), "inara": set(), "raven": set()}

        # Статистика для UI/лога.
        self.stats = {
            "queued": 0,
            "sent": 0,
            "failed": 0,
            "dropped": 0,            # очередь переполнена — событие выброшено
            "skipped_backfill": 0,   # историческое событие, внешние API не нужны
            "duplicate": 0,
        }

        # Опциональный колбэк: on_result(service, ok, message)
        self.on_result: Optional[Callable[[str, bool, str], None]] = None
        self._last_drop_warning = 0.0

    # -- настройка ---------------------------------------------------------
    def configure(
        self,
        edsm_api=None,
        inara_api=None,
        raven_api=None,
        backfill_enabled: bool = None,
        logger: Callable[[str], None] = None,
    ):
        """Пере-привязать клиентов API (GUI-поля создаются позже клиентов)."""
        if edsm_api is not None:
            self.edsm_api = edsm_api
        if inara_api is not None:
            self.inara_api = inara_api
        if raven_api is not None:
            self.raven_api = raven_api
        if backfill_enabled is not None:
            self.backfill_enabled = bool(backfill_enabled)
        if logger is not None:
            self.logger = logger

    def _log(self, message: str):
        if not self.logger:
            return
        try:
            self.logger(message)
        except Exception:
            pass

    def _notify(self, service: str, ok: bool, message: str):
        if not self.on_result:
            return
        try:
            self.on_result(service, ok, message)
        except Exception:
            pass

    # -- отправка ----------------------------------------------------------
    def submit(self, event: dict, live: bool = True, station_type: str = "") -> bool:
        """Поставить событие в очередь внешних API.

        Возвращает False только если событие выброшено из-за переполнения
        очереди (внешние сервисы не успевают); иначе True.

        `live=False` — исторический разбор (первичная загрузка журналов или
        ручной импорт файлов). Такие события по умолчанию во внешние сервисы
        не уходят — см. `backfill_enabled`.
        """
        if not isinstance(event, dict):
            return True
        if not live and not self.backfill_enabled:
            self.stats["skipped_backfill"] += 1
            return True

        event_name = str(event.get("event", ""))
        results = []

        # ВАЖНО: раньше Inara и Raven вызывались только при включённом EDSM
        # (общий `if not self.edsm_api.enabled: return`). Проверяем каждый
        # сервис по отдельности.
        if self._edsm_enabled() and event_name in EDSM_EVENTS:
            results.append(self._submit_edsm(event, event_name))
        if self._inara_enabled() and event_name in INARA_EVENT_NAMES:
            results.append(self._submit_inara(event, event_name))
        if self._raven_enabled() and event_name in RAVEN_CARGO_EVENTS:
            results.append(self._submit_raven(event, event_name, station_type))

        return _DROPPED not in results

    # -- проверки сервисов -------------------------------------------------
    def _edsm_enabled(self) -> bool:
        return bool(self.edsm_api is not None and getattr(self.edsm_api, "enabled", False))

    def _inara_enabled(self) -> bool:
        return bool(self.inara_api is not None and getattr(self.inara_api, "enabled", False))

    def _raven_enabled(self) -> bool:
        return bool(self.raven_api is not None and getattr(self.raven_api, "is_connected", False))

    # -- постановка в очередь по сервисам ----------------------------------
    def _submit_edsm(self, event: dict, event_name: str) -> str:
        key = (
            event.get("timestamp", ""),
            event_name,
            event.get("SystemAddress", ""),
            event.get("BodyID", ""),
        )
        with self._lock:
            if key in self._seen["edsm"]:
                self.stats["duplicate"] += 1
                return _SKIPPED
            self._seen["edsm"].add(key)
        return self._enqueue("edsm", {"event": dict(event)})

    def _submit_inara(self, event: dict, event_name: str) -> str:
        key = (
            event.get("timestamp", ""),
            event_name,
            event.get("SystemAddress", ""),
            event.get("BodyID", ""),
            event.get("MarketID", ""),
        )
        with self._lock:
            if key in self._seen["inara"]:
                self.stats["duplicate"] += 1
                return _SKIPPED
            self._seen["inara"].add(key)
        payload = dict(event)
        payload.pop("event", None)
        return self._enqueue(
            "inara",
            {
                "event_name": INARA_EVENT_NAMES[event_name],
                "data": payload,
                "timestamp": str(event.get("timestamp", "")),
            },
        )

    def _submit_raven(self, event: dict, event_name: str, station_type: str = "") -> str:
        """Fleet Carrier cargo: продажа на FC добавляет груз, покупка — забирает."""
        market_id = event.get("MarketID")
        count = event.get("Count")
        commodity = event.get("Type_Localised") or event.get("Type")
        carrier_station = "carrier" in str(
            event.get("StationType", "") or station_type or ""
        ).lower()
        is_carrier = bool(event.get("CarrierID")) or carrier_station
        if not market_id or not count or not commodity or not is_carrier:
            return _SKIPPED

        key = "|".join(
            str(event.get(field, ""))
            for field in ("event", "timestamp", "MarketID", "Type", "Type_Localised", "Count", "CarrierID")
        )
        with self._lock:
            if key in self._seen["raven"]:
                self.stats["duplicate"] += 1
                return _SKIPPED
        # Ключ добавляется в `seen` только ПОСЛЕ успешной отправки, чтобы
        # неудачный запрос был предпринят ещё раз (как было раньше).
        delta = int(count) if event_name == "MarketSell" else -int(count)
        return self._enqueue(
            "raven",
            {
                "market_id": int(market_id),
                "commodity": str(commodity),
                "delta": delta,
                "key": key,
            },
        )

    def _enqueue(self, service: str, payload: dict) -> str:
        self._start_locked()
        try:
            self._queue.put_nowait((service, payload))
        except queue.Full:
            # Очередь переполнена — внешний сервис не успевает. Выбрасываем
            # событие, но НЕ блокируем разбор журнала: внешние API вторичны,
            # а подвисшая первичная загрузка — ровно то, на что жаловался
            # пользователь.
            self.stats["dropped"] += 1
            now = time.monotonic()
            if now - self._last_drop_warning > 30:
                self._last_drop_warning = now
                self._log(
                    f"Внешние API не успевают: очередь переполнена, "
                    f"пропущено событий — {self.stats['dropped']}"
                )
            return _DROPPED
        self.stats["queued"] += 1
        return _QUEUED

    # -- воркеры -----------------------------------------------------------
    def _start_locked(self):
        with self._lock:
            if self._started:
                return
            self._started = True
            for index in range(self.workers):
                thread = threading.Thread(
                    target=self._worker_loop,
                    name=f"third-party-dispatch-{index}",
                    daemon=True,
                )
                thread.start()
                self._threads.append(thread)

    def _worker_loop(self):
        while True:
            try:
                service, payload = self._queue.get(timeout=0.5)
            except queue.Empty:
                if self._stop_event.is_set():
                    return
                continue
            try:
                if service == "edsm":
                    self._do_edsm(payload)
                elif service == "inara":
                    self._do_inara(payload)
                elif service == "raven":
                    self._do_raven(payload)
            except Exception as exc:  # воркер не должен умирать из-за одного события
                self.stats["failed"] += 1
                self._log(f"Ошибка отправки в {service}: {exc}")
            finally:
                self._queue.task_done()

    def _do_edsm(self, payload: dict):
        if not self._edsm_enabled():
            return
        result = self.edsm_api.submit_event(payload["event"]) or {}
        if result.get("ok"):
            self.stats["sent"] += 1
        else:
            self.stats["failed"] += 1
            self._notify("edsm", False, str(result.get("error") or "EDSM отклонил событие"))

    def _do_inara(self, payload: dict):
        if not self._inara_enabled():
            return
        result = self.inara_api.submit(
            payload["event_name"], payload["data"], payload["timestamp"]
        ) or {}
        if result.get("ok"):
            self.stats["sent"] += 1
        else:
            self.stats["failed"] += 1
            self._notify("inara", False, str(result.get("error") or "Inara отклонила событие"))

    def _do_raven(self, payload: dict):
        if not self._raven_enabled():
            return
        result = self.raven_api.supply_fc(
            payload["market_id"], payload["commodity"], payload["delta"]
        ) or {}
        if result.get("ok"):
            self.stats["sent"] += 1
            with self._lock:
                self._seen["raven"].add(payload["key"])
            if result.get("already_exists"):
                self._notify(
                    "raven",
                    True,
                    f"Raven FC cargo: событие уже принято ранее "
                    f"({payload['commodity']} {payload['delta']:+d})",
                )
        else:
            self.stats["failed"] += 1
            self._notify("raven", False, str(result.get("error") or "Raven Colonial отклонил событие"))

    # -- состояние ---------------------------------------------------------
    def pending(self) -> int:
        return self._queue.qsize()

    def flush(self, timeout: float = None) -> bool:
        """Дождаться опустошения очереди. Возвращает True, если успели."""
        if not self._started:
            return True
        try:
            if timeout is None:
                self._queue.join()
                return True
            deadline = time.monotonic() + timeout
            while self._queue.unfinished_tasks:
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.05)
            return True
        except Exception:
            return False

    def snapshot_stats(self) -> dict:
        with self._lock:
            stats = dict(self.stats)
        stats["pending"] = self.pending()
        return stats

    def reset_stats(self):
        with self._lock:
            for key in self.stats:
                self.stats[key] = 0

    def stop(self, wait: bool = False, timeout: float = 2.0):
        self._stop_event.set()
        if wait:
            self.flush(timeout=timeout)
