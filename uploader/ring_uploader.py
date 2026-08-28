"""
ED Ring Colony — Journal Uploader
Загружает Cargo-события из журналов Elite Dangerous в Supabase.
Теперь поддерживает доставки во ВСЕ системы проекта (хабы + маршрут).
"""

import os
import sys
import json
import time
import hashlib
import pathlib
import threading
from typing import Any

import requests

# ------------------------------------------------------------------
# Конфигурация
# ------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
CHUNK = 500

# ------------------------------------------------------------------
# Утилиты
# ------------------------------------------------------------------

def jwt_sub(token: str) -> str:
    """Извлекает 'sub' из JWT без проверки подписи."""
    import base64
    parts = token.split(".")
    if len(parts) != 3:
        return ""
    payload = parts[1]
    # padding
    payload += "=" * (4 - len(payload) % 4)
    try:
        data = json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return ""
    return data.get("sub", "")


def http_json(url: str, payload: Any, *, extra_headers: dict[str, str] | None = None, method: str = "POST") -> Any:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    }
    if extra_headers:
        headers.update(extra_headers)
    resp = requests.request(method, url, headers=headers, json=payload, timeout=60)
    if resp.status_code in (204, 404):
        return None
    try:
        return resp.json()
    except Exception:
        return resp.text


def http_get_json(url: str, *, extra_headers: dict[str, str] | None = None) -> Any:
    headers = {
        "Accept": "application/json",
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    }
    if extra_headers:
        headers.update(extra_headers)
    resp = requests.get(url, headers=headers, timeout=60)
    if resp.status_code in (204, 404):
        return None
    try:
        return resp.json()
    except Exception:
        return resp.text


# ------------------------------------------------------------------
# Парсер журналов
# ------------------------------------------------------------------

def parse_journal(text: str, state: dict[str, Any] | None = None) -> dict[str, Any]:
    cmdr = state.get("cmdr") if state else None
    current_system = state.get("system") if state else None
    last_cargo: dict[str, int] | None = dict(state["cargo"]) if state and state.get("cargo") is not None else None
    deliveries: list[dict[str, Any]] = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] != "{":
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = ev.get("event")
        if name == "Commander":
            if ev.get("Name"):
                cmdr = ev["Name"]
        elif name == "LoadGame":
            if not cmdr and ev.get("Commander"):
                cmdr = ev["Commander"]
        elif name in ("Location", "FSDJump", "Docked", "CarrierJump"):
            if ev.get("StarSystem"):
                current_system = ev["StarSystem"]
        elif name == "Cargo":
            inv: dict[str, int] = {}
            for it in ev.get("Inventory") or []:
                item_name = str(it.get("Name_Localised") or it.get("Name") or "").lower()
                count = it.get("Count") or 0
                if item_name and count > 0:
                    inv[item_name] = count
            if last_cargo is not None and current_system:
                for cargo_name, prev in last_cargo.items():
                    now = inv.get(cargo_name, 0)
                    if now < prev:
                        deliveries.append(
                            {
                                "systemName": current_system,
                                "commodity": cargo_name,
                                "amount": prev - now,
                                "timestamp": ev.get("timestamp"),
                            }
                        )
            last_cargo = inv

    return {
        "cmdrName": cmdr,
        "deliveries": deliveries,
        "state": {"cmdr": cmdr, "system": current_system, "cargo": last_cargo},
    }


# ------------------------------------------------------------------
# Uploader
# ------------------------------------------------------------------

class Uploader:
    def __init__(self, token: str | None = None):
        self.token = token
        self._lock = threading.Lock()

    def _user_db_headers(self, prefer: str | None = None) -> dict[str, str]:
        h: dict[str, str] = {"apikey": SUPABASE_ANON_KEY}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        else:
            h["Authorization"] = f"Bearer {SUPABASE_ANON_KEY}"
        if prefer:
            h["Prefer"] = prefer
        return h

    def _project_systems(self) -> dict[str, dict[str, Any]]:
        """Возвращает все системы проекта: хабы + маршрут."""
        hub_rows = http_get_json(
            f"{SUPABASE_URL}/rest/v1/hubs?select=system_name,id",
            extra_headers=self._user_db_headers(),
        )
        route_rows = http_get_json(
            f"{SUPABASE_URL}/rest/v1/route_systems?select=system_name,id",
            extra_headers=self._user_db_headers(),
        )
        systems: dict[str, dict[str, Any]] = {}
        if isinstance(hub_rows, list):
            for r in hub_rows:
                sn = str(r.get("system_name", "")).lower()
                if sn:
                    systems[sn] = {"id": r.get("id"), "is_hub": True}
        if isinstance(route_rows, list):
            for r in route_rows:
                sn = str(r.get("system_name", "")).lower()
                if sn and sn not in systems:
                    systems[sn] = {"id": r.get("id"), "is_hub": False}
        return systems

    def _post_via_rest(self, cmdr: str | None, deliveries: list[dict[str, Any]]) -> tuple[int, int, int]:
        uid = jwt_sub(self.token or "")
        if cmdr:
            http_json(
                f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{uid}",
                {"cmdr_name": cmdr},
                extra_headers=self._user_db_headers("return=minimal"),
                method="PATCH",
            )
        if not deliveries:
            return 0, 0, 0

        systems = self._project_systems()
        rows = []
        for d in deliveries:
            system = str(d.get("systemName") or "")
            key = system.lower()
            if not system or key not in systems:
                continue
            try:
                amount_n = int(d.get("amount"))
            except (TypeError, ValueError):
                continue
            if amount_n <= 0:
                continue
            ts = str(d.get("timestamp") or "")
            commodity = str(d.get("commodity") or "unknown")
            source_hash = hashlib.sha256(
                "|".join([uid, system, commodity, str(amount_n), ts]).encode("utf-8")
            ).hexdigest()

            meta = systems[key]
            rows.append(
                {
                    "user_id": uid,
                    "cmdr_name": cmdr or "Unknown",
                    "system_name": system,
                    "commodity": commodity,
                    "amount": amount_n,
                    "delivered_at": ts.replace("Z", "+00:00") if ts else ts,
                    "source_hash": source_hash,
                    "route_system_id": meta.get("id") if not meta.get("is_hub") else None,
                    "is_hub": meta.get("is_hub", False),
                }
            )
        if not rows:
            return 0, 0, 0

        inserted = 0
        for i in range(0, len(rows), CHUNK):
            part = rows[i : i + CHUNK]
            data = http_json(
                f"{SUPABASE_URL}/rest/v1/deliveries?on_conflict=source_hash",
                part,
                extra_headers=self._user_db_headers("resolution=ignore-duplicates,return=representation"),
            )
            if isinstance(data, list):
                inserted += len(data)
            elif isinstance(data, dict) and data.get("id"):
                inserted += 1
        return len(rows), inserted, max(0, len(rows) - inserted)

    def upload_file(self, path: pathlib.Path, state: dict[str, Any] | None = None) -> dict[str, Any]:
        text = path.read_text(encoding="utf-8", errors="ignore")
        result = parse_journal(text, state)
        found, inserted, dups = self._post_via_rest(result["cmdrName"], result["deliveries"])
        return {
            "file": str(path),
            "cmdr": result["cmdrName"],
            "eventsFound": found,
            "inserted": inserted,
            "duplicates": dups,
            "state": result["state"],
        }

    def upload_directory(self, dir_path: pathlib.Path) -> list[dict[str, Any]]:
        results = []
        state: dict[str, Any] | None = None
        for file in sorted(dir_path.glob("Journal*.log")):
            res = self.upload_file(file, state)
            state = res.get("state")
            results.append(res)
            print(f"  {file.name}: found={res['eventsFound']} inserted={res['inserted']} dups={res['duplicates']}")
        return results


# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------

def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="ED Ring Colony Journal Uploader")
    parser.add_argument("--token", default=os.environ.get("SUPABASE_TOKEN", ""), help="JWT токен пользователя")
    parser.add_argument("--dir", default=str(pathlib.Path.home() / "Saved Games" / "Frontier Developments" / "Elite Dangerous"), help="Папка с журналами")
    parser.add_argument("--file", help="Один файл журнала")
    args = parser.parse_args()

    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        print("Ошибка: задайте SUPABASE_URL и SUPABASE_ANON_KEY")
        sys.exit(1)

    uploader = Uploader(token=args.token or None)

    if args.file:
        path = pathlib.Path(args.file)
        if not path.exists():
            print(f"Файл не найден: {path}")
            sys.exit(1)
        res = uploader.upload_file(path)
        print(json.dumps(res, indent=2, ensure_ascii=False))
    else:
        dir_path = pathlib.Path(args.dir)
        if not dir_path.exists():
            print(f"Папка не найдена: {dir_path}")
            sys.exit(1)
        print(f"Сканирование: {dir_path}")
        results = uploader.upload_directory(dir_path)
        total_found = sum(r["eventsFound"] for r in results)
        total_inserted = sum(r["inserted"] for r in results)
        print(f"\nИтого: найдено={total_found} вставлено={total_inserted}")


if __name__ == "__main__":
    main()
