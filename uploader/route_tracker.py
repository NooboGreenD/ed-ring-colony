"""Трекер маршрута — импорт/экспорт."""
import json
import csv
import io
import os
import threading
import time
from pathlib import Path
from typing import Callable, List, Dict, Optional

import route_hint


class RouteTracker:
    def __init__(self, hint_cache_path: Optional[Path] = None):
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
        # Кэш подсказок по системам: система -> {"at": когда спросили, "hint": ответ}.
        # Живёт и в памяти, и на диске: подсказка о системе, которую командир уже
        # проходил (или которую Helper спрашивал в прошлый запуск), показывается
        # сразу — без «спрашиваем…». Сеть идёт фоном и обновляет значение.
        self._hint_cache: Dict[str, Dict] = {}
        self._hint_cache_path = Path(hint_cache_path) if hint_cache_path else None
        self._hint_cache_dirty = False
        self._hint_cache_saved_at = 0.0
        self._hint_failures = 0
        self._hint_next_try = 0.0
        self._hint_prefetching: set = set()
        self._load_hint_cache()

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

    #: Сколько секунд подсказка о системе считается свежей: внутри этого окна
    #: сайт повторно не спрашиваем.
    HINT_TTL = 300
    #: Неполный ответ (сайт не успел посчитать стройку) перепрашиваем раньше.
    HINT_PARTIAL_TTL = 60
    #: Сколько секунд кэш живёт на диске. Стройка меняется медленно, а лишний
    #: запрос при старте Helper — это те самые секунды ожидания.
    HINT_CACHE_TTL = 24 * 3600
    #: Сколько систем вперёд прогреваем, чтобы к прилёту подсказка уже была.
    HINT_PREFETCH_AHEAD = 3
    #: Паузы между повторами после неудачи. Частые повторы «каждую секунду»
    #: только нагружают сайт: первый ответ всё равно ждёт холодный старт.
    HINT_BACKOFF = (2, 5, 15, 60, 120)

    # -- кэш подсказок -------------------------------------------------------
    def _load_hint_cache(self) -> None:
        path = self._hint_cache_path
        if path is None:
            return
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        now = time.time()
        for name, item in data.items():
            if not isinstance(item, dict):
                continue
            at = item.get("at")
            hint = item.get("hint")
            if not isinstance(hint, dict) or not isinstance(at, (int, float)):
                continue
            if now - float(at) > self.HINT_CACHE_TTL:
                continue
            self._hint_cache[str(name).casefold()] = {"at": float(at), "hint": hint}

    def _save_hint_cache(self, force: bool = False) -> None:
        """Сохранить кэш на диск (не чаще раза в 30 секунд, атомарной записью)."""
        path = self._hint_cache_path
        if path is None or not self._hint_cache_dirty:
            return
        now = time.time()
        if not force and now - self._hint_cache_saved_at < 30:
            return
        payload = json.dumps(self._hint_cache, ensure_ascii=False)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(payload)
            os.replace(tmp, path)
        except OSError:
            return
        self._hint_cache_dirty = False
        self._hint_cache_saved_at = now

    def _cached_hint(self, name: str) -> Optional[Dict]:
        item = self._hint_cache.get(str(name).casefold())
        if not item:
            return None
        if time.time() - float(item.get("at", 0)) > self.HINT_CACHE_TTL:
            return None
        return dict(item.get("hint") or {})

    def _hint_age(self, name: str) -> float:
        item = self._hint_cache.get(str(name).casefold())
        if not item:
            return float("inf")
        return time.time() - float(item.get("at", 0))

    # -- запрос подсказки ----------------------------------------------------
    def next_name(self) -> str:
        """Имя следующей (ещё не посещённой) системы маршрута."""
        pending = next((s for s in self.systems if s["status"] != "visited"), None)
        return str(pending["name"]) if pending else ""

    def upcoming_names(self, ahead: int = 0) -> List[str]:
        """Следующие системы маршрута по порядку — для прогрева подсказок."""
        ahead = ahead or self.HINT_PREFETCH_AHEAD
        names = [str(s["name"]) for s in self.systems if s["status"] != "visited"]
        return names[:max(0, int(ahead))]

    def refresh_system_hint(self, fetch: Optional[Callable[[str], dict]] = None,
                            force: bool = False) -> None:
        """Асинхронно получить подсказку о следующей системе с сайта.

        :param fetch: ``fetch(name) -> dict`` — запрос к сайту. Передаётся
            снаружи (``ApiClient.get_route_hint``), чтобы трекер не знал, какой
            клиент и какой адрес сайта используются, и чтобы это можно было
            проверить без сети.
        :param force: спросить заново, даже если ответ ещё свежий.

        Уже известный ответ (из памяти или с диска) показывается сразу — сеть
        дозаполняет его фоном. Поэтому после выбора маршрута в блоке не висит
        «спрашиваем…», если система командиру уже встречалась.
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
            cached = self._cached_hint(name)
            age = self._hint_age(name)
            ttl = self.HINT_PARTIAL_TTL if (cached and cached.get("partial")) else self.HINT_TTL
            fresh = cached is not None and age < ttl

            if cached is not None:
                # Известное значение печатаем сразу; «спрашиваем…» остаётся
                # только если данные несвежие и мы идём за ними в сеть.
                shown = dict(cached)
                shown["loading"] = bool(force) or not fresh
                self.system_hint = shown
                self._hint_name = name
                self._hint_at = now
            elif self.system_hint.get("system") != name:
                self.system_hint = route_hint.mark_loading(self.system_hint, name)

            if fresh and not force:
                return
            if not force and now < self._hint_next_try:
                # Недавно не получилось — ждём паузу, а не стучимся каждый тик.
                return
            self._hint_loading = True
            self.system_hint = route_hint.mark_loading(
                cached if cached is not None else self.system_hint, name)
        if fetch is None:
            with self._hint_lock:
                self._hint_loading = False
            return
        threading.Thread(target=self._hint_worker, args=(fetch, name), daemon=True).start()

    def _hint_worker(self, fetch: Callable[[str], dict], name: str) -> None:
        payload = {}
        try:
            payload = fetch(name) or {}
        except Exception as exc:                              # сеть — не повод падать
            payload = {"ok": False, "error": str(exc)}
        hint = route_hint.normalize_hint(payload, name)
        now = time.time()
        with self._hint_lock:
            if hint.get("error"):
                # Неудача: назад отступаем экспоненциально, но уже показанное
                # (из кэша) оставляем — прошлые данные лучше пустоты и лучше
                # «сайт недоступен» поверх известной системы.
                self._hint_failures += 1
                delay = self.HINT_BACKOFF[min(self._hint_failures - 1,
                                              len(self.HINT_BACKOFF) - 1)]
                self._hint_next_try = now + delay
                if self.system_hint.get("system") == name and self.system_hint.get("known"):
                    hint = dict(self.system_hint)
                    hint["loading"] = False
                    hint["error"] = ""
                else:
                    hint["system"] = name
            else:
                self._hint_failures = 0
                self._hint_next_try = 0.0
                self._hint_cache[str(name).casefold()] = {"at": now, "hint": hint}
                self._hint_cache_dirty = True
            self.system_hint = hint
            self._hint_name = name
            self._hint_at = now
            self._hint_loading = False
        self._save_hint_cache()

    def prefetch_system_hints(self, fetch: Optional[Callable[[str], dict]] = None,
                              ahead: int = 0) -> None:
        """Заранее спросить подсказки для следующих систем маршрута.

        Пока командир летит до первой системы, ответы на вторую-четвёртую уже
        готовы — и после прыжка блок заполняется мгновенно. Запросы идут по
        одному в отдельном потоке: сайт не любит пачку параллельных вызовов.
        """
        if fetch is None:
            return
        with self._hint_lock:
            names = [n for n in self.upcoming_names(ahead)
                     if n.casefold() not in self._hint_prefetching]
            if not names:
                return
            self._hint_prefetching.update(n.casefold() for n in names)

        def worker():
            for name in names:
                try:
                    with self._hint_lock:
                        busy = self._hint_loading and self._hint_name == name
                    age = self._hint_age(name)
                    # Систему, которую блок уже спрашивает, второй раз не трогаем.
                    if not busy and age >= self.HINT_TTL:
                        payload = fetch(name) or {}
                        hint = route_hint.normalize_hint(payload, name)
                        if not hint.get("error"):
                            with self._hint_lock:
                                self._hint_cache[name.casefold()] = {
                                    "at": time.time(), "hint": hint}
                                self._hint_cache_dirty = True
                except Exception:
                    pass
                finally:
                    with self._hint_lock:
                        self._hint_prefetching.discard(name.casefold())
            self._save_hint_cache()

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
            self._hint_next_try = 0.0
            self._hint_failures = 0

    @property
    def visited_count(self) -> int:
        return sum(1 for s in self.systems if s["status"] == "visited")
