"""API клиент для Raven Colonial (ravencolonial.com).

Endpoint и формат из SRV Survey:
- Base URL: https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api
- Auth header: rcc-key (не Authorization: Bearer)
- Contribute: Dictionary<string, int> (не JSON с commodity/amount)
"""
import requests
import threading
import time
from typing import Dict, Any, Optional


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
            return {
                "ok": response.ok or already_exists,
                "already_exists": already_exists,
                "data": payload,
                "error": None if (response.ok or already_exists) else response_text,
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
