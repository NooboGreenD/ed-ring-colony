"""API клиент для Raven Colonial (ravencolonial.com).

Endpoint и формат из SRV Survey:
- Base URL: https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api
- Auth header: rcc-key (не Authorization: Bearer)
- Contribute: Dictionary<string, int> (не JSON с commodity/amount)
"""
import requests
import time
from typing import Dict, Any, Optional


class RavenColonialAPI:
    def __init__(self, api_key: str = ""):
        self.api_key = api_key
        self.base_url = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net/api"
        self._session = requests.Session()

    def set_key(self, api_key: str):
        self.api_key = api_key

    @property
    def is_connected(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict:
        return {"rcc-key": self.api_key}

    def get_project(self, system_address: int, market_id: int) -> Optional[dict]:
        """Получить проект по system_address и market_id."""
        try:
            resp = self._session.get(
                f"{self.base_url}/system/{system_address}/{market_id}",
                headers=self._headers(),
                timeout=15,
            )
            if resp.ok:
                return resp.json()
        except Exception:
            pass
        return None

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
            return {"ok": response.ok, "data": payload, "error": response.text[:300] if not response.ok else None}
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
