"""Трекер маршрута — импорт/экспорт."""
import json
import csv
import io
from typing import List, Dict, Optional


class RouteTracker:
    def __init__(self):
        self.systems: List[dict] = []

    def load_from_navroute(self, data: dict):
        """Загрузить из NavRoute.json."""
        route = data.get("Route", [])
        self.systems = [
            {"index": i + 1, "name": r.get("StarSystem", ""), "status": "pending", "visited_at": None}
            for i, r in enumerate(route)
            if r.get("StarSystem")
        ]

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

    @property
    def visited_count(self) -> int:
        return sum(1 for s in self.systems if s["status"] == "visited")
