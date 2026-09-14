"""API клиент для Raven Colonial (ravencolonial.com).

Endpoint и формат из SRV Survey:
- Base URL: https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api
- Auth header: rcc-key (не Authorization: Bearer)
- Contribute: Dictionary<string, int> (не JSON с commodity/amount)

Схемы запросов сверены с официальным OpenAPI
(`https://ravencolonial100-…/openapi/v1.json`): `PUT /api/project` принимает
схему `ProjectCreate`, где обязательны ровно три поля — `marketId`,
`systemAddress` и `buildName`. Всё остальное (`buildType`, `systemName`,
`starPos`, `bodyNum`, `bodyName`, `architectName`, `commodities`, `maxNeed`,
`commanders`, `colonisationConstructionDepot`, `systemSiteId`, `notes`,
`isPrimaryPort`, `discordLink`) опционально.
"""
import requests
import threading
import time
from typing import Any, Dict, List, Optional

# Адрес сайта Raven Colonial. Страница проекта открывается как
# `https://ravencolonial.com/#build={buildId}` — так же её открывает сам
# SrvSurvey после создания проекта.
UX_URL = "https://ravencolonial.com"

# Поля, без которых Raven Colonial проект не создаст (схема ProjectCreate).
REQUIRED_PROJECT_FIELDS = ("marketId", "systemAddress", "buildName")


def projects_from(data) -> List[dict]:
    """Список проектов из ответа Raven Colonial.

    `GET /api/system/{systemAddress}` и `/api/cmdr/{cmdr}/active` отдают то
    список проектов, то объект со списком внутри, то один проект — зависит от
    версии сервиса. Приводим к одному виду, чтобы поиск по системе не зависел
    от формы ответа.
    """
    if isinstance(data, dict):
        for key in ("projects", "Projects", "data", "Data"):
            if isinstance(data.get(key), list):
                return [item for item in data[key]
                        if isinstance(item, dict) and item.get("buildId")]
        return [data] if data.get("buildId") else []
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict) and item.get("buildId")]
    return []


def project_url(build_id: str) -> str:
    """Ссылка на страницу проекта в Raven Colonial."""
    return f"{UX_URL}/#build={build_id}"


def system_url(system_name: str) -> str:
    """Ссылка на страницу системы в Raven Colonial."""
    from urllib.parse import quote

    return f"{UX_URL}/#sys={quote(str(system_name or ''), safe='')}"


class RavenColonialAPI:
    # Сколько держим в памяти результат поиска проекта.
    #
    # get_project() вызывался для КАЖДОЙ доставки: при первичной загрузке
    # истории это тысячи одинаковых запросов /system/{address}/{market_id} —
    # все доставки на одну стройплощадку дают один и тот же проект. Кэш
    # убирает тысячи лишних round trip'ов (каждый — до 15 с таймаута).
    PROJECT_CACHE_TTL = 300.0
    # «Проекта пока нет» (404) держим заметно меньше: площадку могут
    # зарегистрировать в Raven Colonial в любую минуту (это делает другой
    # командир или сам пользователь на вкладке «Колонизатор»), и доставка,
    # которая всё это время лежала в очереди, должна уйти сразу, как только
    # проект появится.
    PROJECT_MISS_TTL = 30.0

    def __init__(self, api_key: str = ""):
        self.api_key = api_key
        self.base_url = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api"
        self._session = requests.Session()
        # key -> (monotonic_time, project, ttl)
        self._project_cache: Dict[tuple, tuple] = {}
        self._cache_lock = threading.Lock()
        # Почему последний get_project() вернул None. Нужно вызывающему коду,
        # чтобы отличить «проекта нет» от «сервер не ответил»: во втором
        # случае доставку нельзя списывать со счетов, её надо повторить.
        self.last_lookup_error: str = ""
        # Как именно найден проект: "market" — точное совпадение
        # systemAddress+marketId, "system" — поиск по системе (единственный
        # активный проект), "system+market" — проект системы с тем же
        # marketId, "id" — по buildId (привязка площадки вручную). Пусто,
        # если не найден. Вызывающий код пишет это в лог: пользователю важно
        # видеть, куда именно зачислились тонны.
        self.last_lookup_source: str = ""

    def set_key(self, api_key: str):
        self.api_key = api_key
        # Проект не зависит от ключа, но при смене аккаунта кэш лучше сбросить.
        self.invalidate_project_cache()

    def invalidate_project_cache(self, system_address=None, market_id=None) -> None:
        """Сбросить кэш поиска проектов.

        Без аргументов — весь кэш (смена ключа, создание проекта, ручная
        сверка). С аргументами — только одну площадку: именно её проект
        только что создали/изменили, и следующая доставка должна увидеть
        свежий `buildId`, а не «проект не найден» из кэша.
        """
        with self._cache_lock:
            if system_address is None and market_id is None:
                self._project_cache.clear()
                return
            try:
                address = int(system_address or 0)
                market = int(market_id or 0)
            except (TypeError, ValueError):
                self._project_cache.clear()
                return
            for key in list(self._project_cache):
                if (not address or key[0] == address) and (not market or key[1] == market):
                    self._project_cache.pop(key, None)

    @property
    def is_connected(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict:
        return {"rcc-key": self.api_key}

    def get_project(self, system_address: int, market_id: int,
                    use_cache: bool = True) -> Optional[dict]:
        """Получить проект по system_address и market_id (с кэшем).

        Один и тот же проект запрашивался отдельным HTTP-запросом на каждую
        доставку — при импорте всей истории это тысячи одинаковых запросов.
        Успешный ответ кэшируется на `PROJECT_CACHE_TTL` секунд, «проекта нет»
        (404) — на `PROJECT_MISS_TTL`.

        Сетевая ошибка или 5xx НЕ кэшируются. Раньше в кэш писался любой
        результат, включая `None` после таймаута: одна секундная заминка сети
        превращалась в пять минут «проект не найден», и все доставки этого
        окна молча не уходили в Raven Colonial. Причина последнего отказа
        доступна в `last_lookup_error`.
        """
        try:
            cache_key = (int(system_address or 0), int(market_id or 0))
        except (TypeError, ValueError):
            cache_key = (0, 0)

        now = time.monotonic()
        if use_cache:
            with self._cache_lock:
                cached = self._project_cache.get(cache_key)
            if cached is not None and now - cached[0] < cached[2]:
                self.last_lookup_error = "" if cached[1] else "проекта пока нет в Raven Colonial"
                if cached[1]:
                    self.last_lookup_source = str(cached[3]) if len(cached) > 3 else "market"
                else:
                    self.last_lookup_source = ""
                return cached[1]

        self.last_lookup_error = ""
        self.last_lookup_source = ""
        try:
            resp = self._session.get(
                f"{self.base_url}/system/{system_address}/{market_id}",
                headers=self._headers(),
                timeout=15,
            )
        except Exception as exc:
            # Временный сбой: не кэшируем, следующая доставка спросит снова.
            self.last_lookup_error = f"Raven Colonial не ответил ({exc})"
            return None

        if resp.ok:
            try:
                project = resp.json()
            except ValueError:
                project = None
            if isinstance(project, dict) and project.get("buildId"):
                self.last_lookup_source = "market"
                self._cache_project(cache_key, project, self.PROJECT_CACHE_TTL, "market")
                return project
            # Пустой ответ — не «проекта нет»: пробуем найти по системе.
            return self._fallback_by_system(cache_key, system_address, market_id,
                                            "Raven Colonial вернул пустой ответ")

        status = int(getattr(resp, "status_code", 0) or 0)
        if status == 404:
            # Точной пары (systemAddress, marketId) в Raven нет. Это НЕ значит,
            # что проекта нет: его могли создать через сайт или из события
            # другой площадки, и тогда marketId в проекте отличается от
            # журнального. Раньше здесь поиск заканчивался, и все доставки
            # площадки бесконечно висели в очереди с «проект не найден» —
            # тонны в проект не попадали вовсе.
            return self._fallback_by_system(cache_key, system_address, market_id,
                                            "проекта пока нет в Raven Colonial")

        self.last_lookup_error = self._describe_error(status, getattr(resp, "text", ""),
                                                      "GET", f"/system/{system_address}/{market_id}")
        return None

    #: Как долго помним «проект не нашёлся и по системе тоже».
    SYSTEM_FALLBACK_TTL = 60.0

    def _cache_project(self, cache_key: tuple, project, ttl: float, source: str) -> None:
        with self._cache_lock:
            self._project_cache[cache_key] = (time.monotonic(), project, ttl, source)

    def _fallback_by_system(self, cache_key: tuple, system_address: int, market_id: int,
                            miss_reason: str):
        """Поиск проекта по системе, когда точная пара не совпала.

        `GET /api/system/{systemAddress}` отдаёт активные проекты системы.
        Берём проект, только если уверены: либо у одного из них совпал
        `marketId`, либо активный проект в системе ровно один. Угадывать из
        нескольких нельзя — тонны ушли бы в чужой проект.
        """
        try:
            resp = self._session.get(
                f"{self.base_url}/system/{system_address}",
                headers=self._headers(),
                timeout=15,
            )
        except Exception as exc:
            self.last_lookup_error = f"Raven Colonial не ответил ({exc})"
            self.last_lookup_source = ""
            return None

        if not resp.ok:
            status = int(getattr(resp, "status_code", 0) or 0)
            if status != 404:
                self.last_lookup_error = self._describe_error(
                    status, getattr(resp, "text", ""), "GET", f"/system/{system_address}")
                self.last_lookup_source = ""
                return None
            projects: List[dict] = []
        else:
            try:
                data = resp.json()
            except ValueError:
                data = None
            projects = projects_from(data)

        try:
            market = int(market_id or 0)
        except (TypeError, ValueError):
            market = 0

        if market:
            for project in projects:
                try:
                    if int(project.get("marketId") or 0) == market:
                        self.last_lookup_source = "system+market"
                        self.last_lookup_error = ""
                        self._cache_project(cache_key, project, self.PROJECT_CACHE_TTL,
                                            "system+market")
                        return project
                except (TypeError, ValueError):
                    continue

        if len(projects) == 1:
            # В системе один активный проект — он и есть наша стройка.
            self.last_lookup_source = "system"
            self.last_lookup_error = ""
            self._cache_project(cache_key, projects[0], self.PROJECT_CACHE_TTL, "system")
            return projects[0]

        if len(projects) > 1:
            self.last_lookup_error = (
                f"в системе {len(projects)} активных проектов и ни один не привязан к "
                f"market_id {market}: привяжите площадку к проекту вручную "
                "(вкладка «Колонизатор»)")
        else:
            self.last_lookup_error = miss_reason
        self.last_lookup_source = ""
        # «Не нашлось и по системе» тоже кэшируем — иначе каждая доставка
        # очереди делала бы два запроса вместо одного.
        self._cache_project(cache_key, None, self.SYSTEM_FALLBACK_TTL, "")
        return None

    def resolve_project_by_id(self, build_id: str) -> Optional[dict]:
        """Проект как словарь (или None) по его `buildId`.

        Обёртка над `get_project_by_id()`: нужна ручной привязке
        стройплощадки к проекту, где buildId известен заранее, а поиск по
        marketId не совпадает (именно поэтому площадку и привязывают руками).
        """
        build_id = str(build_id or "").strip()
        if not build_id:
            self.last_lookup_error = "не задан buildId"
            self.last_lookup_source = ""
            return None
        result = self.get_project_by_id(build_id)
        if not isinstance(result, dict) or not result.get("ok"):
            self.last_lookup_error = str((result or {}).get("error") or "проект не получен")
            self.last_lookup_source = ""
            return None
        projects = projects_from(result.get("data"))
        if not projects:
            self.last_lookup_error = "Raven Colonial вернул пустой проект"
            self.last_lookup_source = ""
            return None
        self.last_lookup_error = ""
        self.last_lookup_source = "id"
        return projects[0]

    def supply_fc(self, market_id: int, commodity: str, delta: int) -> dict:
        """Обновить груз Fleet Carrier по модели SrvSurvey/Raven Colonial.

        Positive delta — груз выгружен на FC, отрицательный — куплен/забран с FC.
        Raven использует PATCH /api/fc/{marketId}/cargo и заголовок rcc-key.
        """
        if not self.api_key:
            return {"ok": False, "error": "Raven Colonial API key is empty"}
        try:
            response = self._session.patch(
                f"{self.base_url}/fc/{int(market_id)}/cargo",
                headers=self._headers(),
                json={commodity: int(delta)},
                timeout=15,
            )
            try:
                payload = response.json()
            except ValueError:
                payload = None
            # Raven is backed by Azure storage and can answer 409 when the
            # requested FC commodity entity was already created by another
            # client (SrvSurvey, EDDiscovery, or a previous uploader retry).
            # For an idempotent signed cargo delta this is not a fatal upload
            # error; the entity already exists and the caller must not retry it
            # indefinitely.
            response_text = response.text[:500]
            already_exists = response.status_code == 409 and "already exists" in response_text.lower()
            # Код ответа попадает в сообщение об ошибке: без него в логе видно
            # только «Raven Colonial отклонил событие» и непонятно, что именно
            # не так (401 — ключ, 403 — чужой FC, 404 — авианосец не привязан).
            error = None
            if not (response.ok or already_exists):
                error = f"HTTP {response.status_code}: {response_text}" if response_text else f"HTTP {response.status_code}"
            return {
                "ok": response.ok or already_exists,
                "already_exists": already_exists,
                "status": response.status_code,
                "data": payload,
                "error": error,
            }
        except requests.RequestException as exc:
            return {"ok": False, "error": str(exc)}

    def get_fc_cargo(self, market_id: int) -> dict:
        """Поимённый груз Fleet Carrier: GET /api/fc/{marketId}/cargo.

        Raven хранит груз авианосца как карту «товар -> тонны» в нижнем
        регистре (`steel`, а не `Steel` и не `$steel_name;`) — ровно в том
        виде, в каком его отправляют клиенты через PATCH того же пути.
        Журнал таких данных не даёт: `CarrierStats` сообщает только общий
        тоннаж (`SpaceUsage.Cargo`), без разбивки по товарам.
        """
        try:
            market_id = int(market_id)
        except (TypeError, ValueError):
            return {"ok": False, "data": None, "error": "MarketID авианосца не задан", "status": 0}
        if market_id <= 0:
            return {"ok": False, "data": None, "error": "MarketID авианосца не задан", "status": 0}
        return self._request("GET", f"/fc/{market_id}/cargo")

    def contribute(self, build_id: str, cmdr: str, commodities: dict) -> dict:
        """Отправить доставку на проект.

        `POST /api/project/{buildId}/contribute/{cmdr?}`, тело — словарь
        «товар -> тонны» (имена в нижнем регистре, языконезависимые).

        Args:
            build_id: ID проекта
            cmdr: Имя командира (Raven приводит его к нижнему регистру сам,
                но пробелы и прочее в пути обязаны быть URL-кодированы —
                это прямое требование документации API)
            commodities: {resource_name: amount} (Dictionary<string, int>)

        Возвращает `{"ok", "data", "error", "retryable"}`. `retryable`
        показывает, имеет ли смысл повторить отправку: при 401/403/404/422
        повтор бессмысленен (данные/ключ неверны), при таймауте и 5xx — нужен.
        Повторы здесь не спят по несколько секунд: вызывающий код работает в
        потоке watcher'а, а досылкой занимается его собственная очередь.
        """
        if not self.api_key:
            return {"ok": False, "data": None, "retryable": False,
                    "error": "Ключ Raven Colonial (RCC) не задан"}
        cleaned = {
            str(name): int(amount)
            for name, amount in (commodities or {}).items()
            if str(name or "").strip() and int(amount or 0) != 0
        }
        if not cleaned:
            return {"ok": False, "data": None, "retryable": False,
                    "error": "нечего отправлять: пустой список товаров"}
        url = (f"{self.base_url}/project/{self._esc(build_id)}"
               f"/contribute/{self._esc(cmdr) if cmdr else ''}")
        try:
            resp = self._session.post(
                url,
                headers=self._headers(),
                json=cleaned,
                timeout=15,
            )
        except requests.RequestException as exc:
            return {"ok": False, "data": None, "retryable": True, "error": str(exc)}
        try:
            payload = resp.json()
        except ValueError:
            payload = None
        if resp.ok:
            return {"ok": True, "data": payload, "error": None, "retryable": False}
        status = int(getattr(resp, "status_code", 0) or 0)
        return {
            "ok": False,
            "data": payload,
            "status": status,
            # 408/429/5xx — сервер просит повторить позже, остальное нет.
            "retryable": status in (408, 429) or status >= 500 or status == 0,
            "error": self._describe_error(status, payload if payload is not None
                                          else getattr(resp, "text", ""),
                                          "POST", f"/project/{build_id}/contribute/{cmdr}"),
        }

    def update_supply(self, build_id: str, commodities: dict, max_need: int) -> dict:
        """Обновить потребность проекта по товарам (колонка Need на сайте).

        Raven Colonial НЕ пересчитывает `commodities` из доставок: вклад
        командира (`contribute`) прибавляет тонны к заслугам, а остаток
        потребности по материалам обновляет клиент архитектора отдельным
        `POST /api/project/{buildId}` с телом ProjectUpdate — ровно так же
        поступает эталонный плагин EDMC-Ravencolonial при каждом событии
        `ColonisationConstructionDepot`:

            {"buildId": ..., "commodities": {товар: ещё нужно}, "maxNeed": ...}

        Без этого вызова сайт показывает завезённый груз, но потребность по
        материалам не уменьшается — симптом, который невозможно отличить от
        «потерянных доставок».
        """
        payload = {
            "buildId": str(build_id or ""),
            "commodities": {str(k): int(v) for k, v in (commodities or {}).items()},
            "maxNeed": int(max_need or 0),
        }
        try:
            resp = self._session.post(
                f"{self.base_url}/project/{self._esc(build_id)}",
                headers=self._headers(),
                json=payload,
                timeout=15,
            )
        except requests.RequestException as exc:
            return {"ok": False, "data": None, "retryable": True, "error": str(exc)}
        try:
            data = resp.json()
        except ValueError:
            data = None
        if resp.ok:
            return {"ok": True, "data": data, "error": None, "retryable": False}
        status = int(getattr(resp, "status_code", 0) or 0)
        return {
            "ok": False,
            "data": data,
            "status": status,
            "retryable": status in (408, 429) or status >= 500 or status == 0,
            "error": self._describe_error(status, data if data is not None
                                          else getattr(resp, "text", ""),
                                          "POST", f"/project/{build_id}"),
        }

    # ============================================================
    #  Полный цикл работы с проектами (вкладка «Колонизатор»)
    #
    #  Схемы и методы — по официальной документации Raven Colonial
    #  (https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/about):
    #  PUT /api/project (создать), PATCH /api/project/{buildId} (изменить),
    #  POST /api/project/{buildId}/complete, GET /api/cmdr/{cmdr}/active,
    #  PUT|DELETE /api/cmdr/{cmdr}/primary, PUT|DELETE .../link/{cmdr},
    #  PUT|DELETE .../assign/{cmdr}/{commodity}, POST|DELETE .../ready.
    # ============================================================
    def _request(self, method: str, path: str, json_body: Any = None, timeout: int = 15) -> dict:
        """Один вызов Raven Colonial. Всегда возвращает {"ok","data","error","status"}.

        Ни один метод клиента не должен выбрасывать исключение наружу: UI
        вызывает их из фонового потока и показывает `error` в логе.
        """
        if not self.api_key:
            return {"ok": False, "data": None, "error": "Ключ Raven Colonial (RCC) не задан", "status": 0}
        try:
            resp = self._session.request(
                method.upper(),
                f"{self.base_url}/{path.lstrip('/')}",
                headers=self._headers(),
                json=json_body,
                timeout=timeout,
            )
        except Exception as exc:
            return {"ok": False, "data": None, "error": str(exc), "status": 0}

        try:
            payload = resp.json()
        except ValueError:
            payload = resp.text[:500]
        if resp.ok:
            return {"ok": True, "data": payload, "error": None,
                    "status": resp.status_code}
        return {
            "ok": False,
            "data": None,
            "error": self._describe_error(resp.status_code, payload, method, path),
            "status": resp.status_code,
        }

    @staticmethod
    def _describe_error(status: int, payload, method: str, path: str) -> str:
        """Текст ошибки для лога.

        Raven Colonial на многие отказы отвечает пустым телом (204/400/404 без
        JSON), и раньше в лог уезжала пустая строка, а UI показывал
        «неизвестная ошибка». Теперь статус расшифровывается, а тело ответа
        добавляется только если в нём действительно что-то есть.
        """
        reasons = {
            400: "неверный запрос — сервер не принял параметры",
            401: "ключ RCC не принят (401) — проверьте ключ на сайте Raven Colonial",
            403: "нет прав на эту операцию (403)",
            404: "не найдено (404) — проект или командир не существует",
            405: "метод не поддерживается сервером (405)",
            409: "конфликт: проект уже в таком состоянии (409)",
            422: "сервер не принял данные (422)",
            429: "слишком много запросов (429) — подождите немного",
            500: "ошибка сервера Raven Colonial (500)",
            502: "сервис недоступен (502)",
            503: "сервис временно недоступен (503)",
            504: "сервер не ответил вовремя (504)",
        }
        reason = reasons.get(status)
        if reason is None:
            reason = ("ошибка сервера Raven Colonial" if 500 <= status < 600
                      else "сервер отказал")
        # Код ответа показываем всегда: по нему Support Raven Colonial
        # понимает, о чём речь, даже если формулировка окажется неточной.
        if str(status) not in reason:
            reason += f" (HTTP {status})"
        detail = payload if isinstance(payload, str) else (str(payload) if payload else "")
        detail = detail.strip()
        if detail and detail.lower() not in ("null", "none", "''", '""'):
            reason += f": {detail[:300]}"
        return reason

    @staticmethod
    def _esc(value) -> str:
        """Имена командиров и товаров идут в пути — их нужно кодировать."""
        from urllib.parse import quote

        return quote(str(value), safe="")

    # -- чтение ------------------------------------------------------------
    def get_project_by_id(self, build_id: str) -> dict:
        """GET /api/project/{buildId} — проект целиком."""
        return self._request("GET", f"/project/{self._esc(build_id)}")

    def get_cmdr_by_key(self, api_key: str = "") -> dict:
        """GET /api/cmdr/ — чей это ключ.

        Raven Colonial отдаёт по ключу профиль командира, в том числе
        `displayName` — ровно то имя, под которым командир известен сервису.
        Это единственный способ узнать имя пилота, имея только ключ RCC:
        в журнале имя появляется лишь после `LoadGame`, а в настройках
        пользователь его может не заполнять.

        Ключ можно передать явно (проверка только что введённого ключа),
        иначе используется текущий.
        """
        key = (api_key or self.api_key or "").strip()
        if not key:
            return {"ok": False, "data": None, "status": 0,
                    "error": "Ключ Raven Colonial (RCC) не задан"}
        try:
            resp = self._session.request(
                "GET",
                f"{self.base_url}/cmdr/",
                headers={"rcc-key": key},
                timeout=15,
            )
        except Exception as exc:
            return {"ok": False, "data": None, "status": 0, "error": str(exc)}
        try:
            payload = resp.json()
        except ValueError:
            payload = None
        if not resp.ok:
            return {
                "ok": False,
                "data": None,
                "status": resp.status_code,
                "error": ("ключ RCC не принят (401) — проверьте ключ на сайте Raven Colonial"
                          if resp.status_code == 401
                          else self._describe_error(resp.status_code, payload, "GET", "/cmdr/")),
            }
        return {"ok": True, "data": payload, "error": None, "status": resp.status_code}

    @staticmethod
    def cmdr_display_name(result: dict) -> str:
        """Достать имя командира из ответа `get_cmdr_by_key()`."""
        data = result.get("data") if isinstance(result, dict) else None
        if isinstance(data, dict):
            for key in ("displayName", "DisplayName", "name", "cmdrName"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        if isinstance(data, str) and data.strip():
            return data.strip()
        return ""

    def get_cmdr_active(self, cmdr: str) -> dict:
        """GET /api/cmdr/{cmdr}/active — активные проекты командира со связями."""
        if not cmdr:
            return {"ok": False, "data": None, "error": "Не задан имя командира", "status": 0}
        return self._request("GET", f"/cmdr/{self._esc(cmdr)}/active")

    def get_system_projects(self, system: str) -> dict:
        """GET /api/system/{name|address} — активные проекты в системе."""
        return self._request("GET", f"/system/{self._esc(system)}")

    def get_primary(self, cmdr: str) -> dict:
        """GET /api/cmdr/{cmdr}/primary — текущий основной проект."""
        return self._request("GET", f"/cmdr/{self._esc(cmdr)}/primary")

    # -- v2: данные системы (тела, планы площадок, архитектор) --------------
    #
    # Эти методы нужны форме создания проекта: Raven Colonial знает, какие
    # площадки в системе уже запланированы и кто архитектор системы. Оттуда
    # берутся `systemSiteId`, `buildType` плана и `architectName` — то, чего
    # нет в журнале игрока.
    def get_system_sites(self, system: str) -> dict:
        """GET /api/v2/system/{name|address}/sites — площадки системы (планы и стройки)."""
        if not system:
            return {"ok": False, "data": None, "error": "Не задана система", "status": 0}
        return self._request("GET", f"/v2/system/{self._esc(system)}/sites")

    def get_system_architect(self, system: str) -> dict:
        """GET /api/v2/system/{name|address}/architect — архитектор системы."""
        if not system:
            return {"ok": False, "data": None, "error": "Не задана система", "status": 0}
        return self._request("GET", f"/v2/system/{self._esc(system)}/architect")

    def get_system_v2(self, system: str) -> dict:
        """GET /api/v2/system/{name|address} — система целиком (тела, площадки)."""
        if not system:
            return {"ok": False, "data": None, "error": "Не задана система", "status": 0}
        return self._request("GET", f"/v2/system/{self._esc(system)}")

    # -- запись ------------------------------------------------------------
    def create_project(self, project: dict) -> dict:
        """PUT /api/project — создать проект.

        Ожидаемые поля (схема ProjectCreate): обязательные `marketId`,
        `systemAddress`, `buildName`; опциональные `systemName`, `buildType`,
        `starPos`, `bodyNum`, `bodyName`, `architectName`, `maxNeed`, `notes`,
        `isPrimaryPort`, `commodities`, `commanders`, `discordLink`,
        `systemSiteId`, `colonisationConstructionDepot`.

        Обязательные поля проверяются здесь, до запроса: без них Raven
        отвечает 400, а в логе это выглядит как «неизвестная ошибка».
        """
        if not self.api_key:
            return {"ok": False, "data": None, "status": 0,
                    "error": "Ключ Raven Colonial (RCC) не задан"}
        missing = [
            field for field in REQUIRED_PROJECT_FIELDS
            if project.get(field) in (None, "", 0)
        ]
        if missing:
            return {
                "ok": False,
                "data": None,
                "status": 0,
                "error": "Не заполнены обязательные поля: " + ", ".join(missing),
            }
        body = {key: value for key, value in project.items() if value is not None}
        return self._request("PUT", "/project/", json_body=body)

    def update_project(self, build_id: str, fields: dict) -> dict:
        """PATCH /api/project/{buildId} — изменить поля (слияние, не замена)."""
        body = {key: value for key, value in fields.items() if value is not None}
        return self._request("PATCH", f"/project/{self._esc(build_id)}", json_body=body)

    def mark_complete(self, build_id: str) -> dict:
        """POST /api/project/{buildId}/complete — отметить завершённым (необратимо)."""
        return self._request("POST", f"/project/{self._esc(build_id)}/complete")

    def set_primary(self, cmdr: str, build_id: str) -> dict:
        """PUT /api/cmdr/{cmdr}/primary/{buildId} — сделать проект основным.

        `buildId` передаётся **в пути**, тело запроса пустое. Раньше сюда
        отправлялся `PUT /cmdr/{cmdr}/primary` с JSON-строкой в теле — сервер
        отвечал отказом с пустым телом, и в интерфейсе это выглядело как
        «неизвестная ошибка».
        """
        if not cmdr:
            return {"ok": False, "data": None, "status": 0,
                    "error": "Не задано имя командира"}
        if not build_id:
            return {"ok": False, "data": None, "status": 0,
                    "error": "Не выбран проект (пустой buildId)"}
        return self._request(
            "PUT", f"/cmdr/{self._esc(cmdr)}/primary/{self._esc(build_id)}"
        )

    def clear_primary(self, cmdr: str) -> dict:
        """DELETE /api/cmdr/{cmdr}/primary/ — снять основной проект."""
        if not cmdr:
            return {"ok": False, "data": None, "status": 0,
                    "error": "Не задано имя командира"}
        return self._request("DELETE", f"/cmdr/{self._esc(cmdr)}/primary/")

    def link_cmdr(self, build_id: str, cmdr: str, link: bool = True) -> dict:
        """PUT/DELETE /api/project/{buildId}/link/{cmdr}."""
        return self._request(
            "PUT" if link else "DELETE",
            f"/project/{self._esc(build_id)}/link/{self._esc(cmdr)}",
        )

    def assign_commodity(self, build_id: str, cmdr: str, commodity: str, assign: bool = True) -> dict:
        """PUT/DELETE /api/project/{buildId}/assign/{cmdr}/{commodity}."""
        return self._request(
            "PUT" if assign else "DELETE",
            f"/project/{self._esc(build_id)}/assign/{self._esc(cmdr)}/{self._esc(commodity)}",
        )

    def set_ready(self, build_id: str, commodities: list, ready: bool = True) -> dict:
        """POST/DELETE /api/project/{buildId}/ready — отметить товары готовыми."""
        return self._request(
            "POST" if ready else "DELETE",
            f"/project/{self._esc(build_id)}/ready",
            json_body=list(commodities),
        )
