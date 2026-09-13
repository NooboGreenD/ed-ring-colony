"""API клиент для Raven Colonial (ravencolonial.com).

Endpoint и формат из SRV Survey:
- Base URL: https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api
- Auth header: rcc-key (не Authorization: Bearer)
- Contribute: Dictionary<string, int> (не JSON с commodity/amount)
"""
import requests
import threading
import time
from typing import Any, Dict, Optional


class RavenColonialAPI:
    # Сколько держим в памяти результат поиска проекта.
    #
    # get_project() вызывался для КАЖДОЙ доставки: при первичной загрузке
    # истории это тысячи одинаковых запросов /system/{address}/{market_id} —
    # все доставки на одну стройплощадку дают один и тот же проект. Кэш
    # убирает тысячи лишних round trip'ов (каждый — до 15 с таймаута).
    PROJECT_CACHE_TTL = 300.0

    def __init__(self, api_key: str = ""):
        self.api_key = api_key
        self.base_url = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api"
        self._session = requests.Session()
        self._project_cache: Dict[tuple, tuple] = {}
        self._cache_lock = threading.Lock()

    def set_key(self, api_key: str):
        self.api_key = api_key
        # Проект не зависит от ключа, но при смене аккаунта кэш лучше сбросить.
        with self._cache_lock:
            self._project_cache.clear()

    @property
    def is_connected(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict:
        return {"rcc-key": self.api_key}

    def get_project(self, system_address: int, market_id: int) -> Optional[dict]:
        """Получить проект по system_address и market_id (с кэшем).

        Один и тот же проект запрашивался отдельным HTTP-запросом на каждую
        доставку — при импорте всей истории это тысячи одинаковых запросов.
        Результат (включая "проект не найден") кэшируется на
        `PROJECT_CACHE_TTL` секунд.
        """
        try:
            cache_key = (int(system_address or 0), int(market_id or 0))
        except (TypeError, ValueError):
            cache_key = (0, 0)

        now = time.monotonic()
        with self._cache_lock:
            cached = self._project_cache.get(cache_key)
        if cached is not None and now - cached[0] < self.PROJECT_CACHE_TTL:
            return cached[1]

        project = None
        try:
            resp = self._session.get(
                f"{self.base_url}/system/{system_address}/{market_id}",
                headers=self._headers(),
                timeout=15,
            )
            if resp.ok:
                project = resp.json()
        except Exception:
            project = None

        with self._cache_lock:
            self._project_cache[cache_key] = (time.monotonic(), project)
        return project

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

    def contribute(self, build_id: str, cmdr: str, commodities: dict) -> dict:
        """Отправить доставку на проект.

        Args:
            build_id: ID проекта
            cmdr: Имя командира
            commodities: {resource_name: amount} (Dictionary<string, int>)
        """
        last_error = "Raven Colonial request failed"
        for attempt in range(1, 4):
            try:
                resp = self._session.post(
                    f"{self.base_url}/project/{build_id}/contribute/{cmdr}",
                    headers=self._headers(),
                    json=commodities,
                    timeout=15,
                )
                if resp.ok:
                    try:
                        payload = resp.json()
                    except ValueError:
                        payload = None
                    return {"ok": True, "data": payload, "error": None}
                last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
                if resp.status_code not in (408, 429) and resp.status_code < 500:
                    break
            except requests.RequestException as exc:
                last_error = str(exc)
            if attempt < 3:
                time.sleep(attempt)
        return {"ok": False, "error": last_error}

    def update_supply(self, build_id: str, resources: dict) -> dict:
        """Обновить supply проекта."""
        try:
            resp = self._session.post(
                f"{self.base_url}/project/{build_id}/supply",
                headers=self._headers(),
                json=resources,
                timeout=15,
            )
            return {"ok": resp.ok, "data": resp.json() if resp.ok else None,
                    "error": resp.text if not resp.ok else None}
        except Exception as e:
            return {"ok": False, "error": str(e)}

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
        return {
            "ok": resp.ok,
            "data": payload if resp.ok else None,
            "error": None if resp.ok else (payload if isinstance(payload, str) else str(payload))[:500],
            "status": resp.status_code,
        }

    @staticmethod
    def _esc(value) -> str:
        """Имена командиров и товаров идут в пути — их нужно кодировать."""
        from urllib.parse import quote

        return quote(str(value), safe="")

    # -- чтение ------------------------------------------------------------
    def get_project_by_id(self, build_id: str) -> dict:
        """GET /api/project/{buildId} — проект целиком."""
        return self._request("GET", f"/project/{self._esc(build_id)}")

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

    # -- запись ------------------------------------------------------------
    def create_project(self, project: dict) -> dict:
        """PUT /api/project — создать проект.

        Ожидаемые поля (ProjectCore/ProjectCreate): systemName, buildName,
        buildType, marketId, systemAddress, starPos, bodyNum, bodyName,
        factionName, architectName, maxNeed, notes, isPrimaryPort, commodities.
        """
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
        """PUT /api/cmdr/{cmdr}/primary — сделать проект основным."""
        return self._request("PUT", f"/cmdr/{self._esc(cmdr)}/primary", json_body=str(build_id))

    def clear_primary(self, cmdr: str) -> dict:
        return self._request("DELETE", f"/cmdr/{self._esc(cmdr)}/primary")

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
