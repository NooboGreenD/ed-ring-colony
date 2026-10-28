"""Трекер маршрута — импорт/экспорт."""
import json
import csv
import io
import threading
import time
from typing import Callable, List, Dict, Optional

import route_hint


class RouteTracker:
    def __init__(self):
        self.systems: List[dict] = []
        self.next_system_info: dict = {}
        self._info_lock = threading.Lock()
        self._info_loading = False
        self._last_info_name = ""
        self._last_info_at = 0.0
        #: Подсказка о следующей системе: стройка и первооткрыватель.
        self.system_hint: dict = route_hint.empty_hint()
        self._hint_lock = threading.Lock()
        self._hint_loading = False
        self._hint_name = ""
        self._hint_at = 0.0

    def load_from_navroute(self, data: dict):
        """Загрузить из NavRoute.json, сохранив уже посещённые системы."""
        route = data.get("Route") or data.get("NavRoute") or []
        previous = {s["name"].casefold(): s for s in self.systems}
        loaded = []
        seen = set()
        for item in route:
            name = str(item.get("StarSystem", "")).strip()
            key = name.casefold()
            if not name or key in seen:
                continue
            seen.add(key)
            old = previous.get(key, {})
            loaded.append({
                "index": len(loaded) + 1,
                "name": name,
                "status": old.get("status", "pending"),
                "visited_at": old.get("visited_at"),
                "system_address": item.get("SystemAddress", 0),
                "star_pos": item.get("StarPos"),
                "star_class": item.get("StarClass"),
            })
        self.systems = loaded

    def load_from_csv(self, text: str):
        """Загрузить из CSV."""
        reader = csv.DictReader(io.StringIO(text))
        self.systems = []
        idx = 1
        for row in reader:
            name = row.get("system") or row.get("name") or row.get("System") or row.get("Name")
            if name:
                self.systems.append({"index": idx, "name": name.strip(), "status": "pending", "visited_at": None})
                idx += 1

    def refresh_next_system_info(self, force: bool = False):
        """Асинхронно получить краткую информацию о следующей системе из EDSM."""
        pending = next((s for s in self.systems if s["status"] != "visited"), None)
        if not pending:
            with self._info_lock:
                self.next_system_info = {}
            return
        name = pending["name"]
        now = time.time()
        with self._info_lock:
            if self._info_loading or (not force and name == self._last_info_name and now - self._last_info_at < 300):
                return
            self._info_loading = True

        def worker():
            info = {"name": name, "known": False, "bodies": None, "population": None}
            try:
                import requests
                response = requests.get(
                    "https://www.edsm.net/api-v1/system",
                    params={"systemName": name, "showInformation": 1, "showCoordinates": 1},
                    timeout=8,
                )
                if response.ok:
                    data = response.json()
                    info["known"] = bool(data)
                    information = data.get("information", {}) if isinstance(data, dict) else {}
                    info["population"] = information.get("population")
                    bodies = requests.get(
                        "https://www.edsm.net/api-system-v1/bodies",
                        params={"systemName": name}, timeout=8,
                    )
                    if bodies.ok and isinstance(bodies.json(), list):
                        info["bodies"] = len(bodies.json())
            except Exception:
                pass
            with self._info_lock:
                self.next_system_info = info
                self._last_info_name = name
                self._last_info_at = time.time()
                self._info_loading = False

        threading.Thread(target=worker, daemon=True).start()

    #: Сколько секунд подсказка о системе считается свежей.
    HINT_TTL = 300

    def next_name(self) -> str:
        """Имя следующей (ещё не посещённой) системы маршрута."""
        pending = next((s for s in self.systems if s["status"] != "visited"), None)
        return str(pending["name"]) if pending else ""

    def refresh_system_hint(self, fetch: Optional[Callable[[str], dict]] = None,
                            force: bool = False) -> None:
        """Асинхронно получить подсказку о следующей системе с сайта.

        :param fetch: ``fetch(name) -> dict`` — запрос к сайту. Передаётся
            снаружи (``ApiClient.get_route_hint``), чтобы трекер не знал, какой
            клиент и какой адрес сайта используются, и чтобы это можно было
            проверить без сети.
        :param force: спросить заново, даже если ответ ещё свежий.

        Подсказка кэшируется по имени системы: оверлей обновляется раз в
        секунду, а ходить на сайт раз в секунду незачем.
        """
        name = self.next_name()
        now = time.time()
        with self._hint_lock:
            if not name:
                self.system_hint = route_hint.empty_hint()
                self._hint_name = ""
                self._hint_at = now
                return
            if self._hint_loading:
                return
            fresh = (name == self._hint_name
                     and self.system_hint.get("system") == name
                     and not self.system_hint.get("error")
                     and now - self._hint_at < self.HINT_TTL)
            if fresh and not force:
                return
            self._hint_loading = True
            self.system_hint = route_hint.mark_loading(self.system_hint, name)
        if fetch is None:
            with self._hint_lock:
                self._hint_loading = False
            return

        def worker():
            payload = {}
            try:
                payload = fetch(name) or {}
            except Exception as exc:                      # сеть — не повод падать
                payload = {"ok": False, "error": str(exc)}
            with self._hint_lock:
                self.system_hint = route_hint.normalize_hint(payload, name)
                self._hint_name = name
                self._hint_at = time.time()
                self._hint_loading = False

        threading.Thread(target=worker, daemon=True).start()

    def get_system_hint(self) -> dict:
        """Подсказка о следующей системе — то, что печатает оверлей ROUTE."""
        with self._hint_lock:
            return dict(self.system_hint)

    def hint_matches(self, system_name: str) -> bool:
        """Относится ли текущая подсказка именно к этой системе."""
        with self._hint_lock:
            return bool(system_name) and self.system_hint.get("system") == system_name

    def get_next_system_info(self) -> dict:
        with self._info_lock:
            return dict(self.next_system_info)

    def mark_visited(self, system_name: str) -> bool:
        """Отметить систему как посещённую."""
        key = system_name.lower()
        for s in self.systems:
            if s["name"].lower() == key and s["status"] != "visited":
                s["status"] = "visited"
                from datetime import datetime
                s["visited_at"] = datetime.now().isoformat()
                return True
        return False

    def is_on_route(self, system_name: str) -> bool:
        """Проверить, входит ли система в загруженный маршрут."""
        if not self.systems:
            return True  # Если маршрут не загружен — считаем все системы валидными
        key = system_name.lower()
        return any(s["name"].lower() == key for s in self.systems)

    def export_csv(self) -> str:
        """Экспортировать в CSV."""
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(["index", "system", "status", "visited_at"])
        for s in self.systems:
            writer.writerow([s["index"], s["name"], s["status"], s.get("visited_at") or ""])
        return out.getvalue()

    def clear(self):
        self.systems = []
        with self._hint_lock:
            self.system_hint = route_hint.empty_hint()
            self._hint_name = ""

    @property
    def visited_count(self) -> int:
        return sum(1 for s in self.systems if s["status"] == "visited")
