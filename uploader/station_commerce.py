"""Station metadata and complete Market/Outfitting/Shipyard snapshots for the project.

Frontier writes inventories only after the appropriate station service is opened.
Docking alone must NEVER upload an invented empty inventory. Persisted outbox
retries failed HTTP uploads independently of journal offsets.
"""
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

KINDS = {"Market": "market", "Outfitting": "outfitting", "Shipyard": "shipyard"}
MAX_PENDING = 5000


def _time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if parsed.timestamp() > datetime.now(timezone.utc).timestamp() + 300:
            return None
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, TypeError, OverflowError):
        return None


def _items(event, kind):
    raw = event.get("Items") if kind != "shipyard" else event.get("ShipsHere")
    if not isinstance(raw, list):
        return None
    result = []
    for entry in raw:
        if not isinstance(entry, dict):
            return None
        name = entry.get("Name") if kind != "shipyard" else entry.get("ShipType")
        if not name:
            return None
        item = {"name": name}
        fields = {"BuyPrice": "buyPrice", "SellPrice": "sellPrice", "Stock": "stock", "Demand": "demand"} if kind == "market" else (
            {"BuyPrice": "price"} if kind == "outfitting" else {"ShipPrice": "price"})
        for source, target in fields.items():
            value = entry.get(source)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1e15:
                item[target] = value
        if entry.get("id") is not None:
            item["id"] = str(entry["id"])
        result.append(item)
    return result if len(result) <= 5000 else None


class StationCommerceCollector:
    def __init__(self, outbox_path):
        self.path = Path(outbox_path)
        self.pending = {}
        self.context = {}
        self.files_seen = {}
        self.lock = threading.RLock()
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                self.pending = dict(list(value.items())[-MAX_PENDING:])
        except (OSError, ValueError):
            pass

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(self.path.suffix + ".tmp")
        temp.write_text(json.dumps(self.pending, ensure_ascii=False), encoding="utf-8")
        os.replace(temp, self.path)

    def _queue(self, report, kind="metadata"):
        identity = report.get("market_id") or (report["system_name"] + ":" + report["station_name"])
        key = identity + ":" + kind
        with self.lock:
            previous = self.pending.get(key)
            if previous:
                old = datetime.fromisoformat(previous["observed_at"].replace("Z", "+00:00"))
                new = datetime.fromisoformat(report["observed_at"].replace("Z", "+00:00"))
                if old > new or previous == report:
                    return
            self.pending[key] = report
            while len(self.pending) > MAX_PENDING:
                del self.pending[next(iter(self.pending))]
            self._save()

    def feed(self, event, live=False):
        name = event.get("event")
        if name in ("Location", "FSDJump", "Docked", "CarrierJump"):
            system = event.get("StarSystem")
            if system:
                if system != self.context.get("system_name"):
                    self.context = {"system_name": system}
                pos = event.get("StarPos")
                if isinstance(pos, list) and len(pos) == 3:
                    self.context.update(zip(("x", "y", "z"), pos))
                population = event.get("SystemPopulation")
                if isinstance(population, int) and not isinstance(population, bool) and 0 <= population <= 9007199254740991:
                    self.context["population"] = population
            if name == "FSDJump" or (name == "Location" and not event.get("Docked")):
                self.context.pop("station_name", None)
                self.context.pop("market_id", None)
            elif event.get("StationName"):
                self.context.update(station_name=event["StationName"], station_type=event.get("StationType", ""))
                # Never reuse the previous dock's identity or body metadata.
                self.context.pop("market_id", None)
                if event.get("MarketID"):
                    self.context["market_id"] = str(event["MarketID"])
                metadata = {}
                for source, target in (("Body", "body_name"), ("BodyID", "body_id"),
                                       ("DistFromStarLS", "distance_to_arrival"),
                                       ("Latitude", "latitude"), ("Longitude", "longitude"),
                                       ("StationServices", "services")):
                    if event.get(source) is not None:
                        metadata[target] = event[source]
                self.context["metadata"] = metadata
                report = self._report(event)
                if report:
                    self._queue(report)
        elif name == "Undocked":
            self.context.pop("station_name", None)
            self.context.pop("market_id", None)
        elif name in KINDS:
            self.inventory(event)

    def _report(self, event):
        station = event.get("StationName") or self.context.get("station_name")
        system = event.get("StarSystem") or self.context.get("system_name")
        stamp = _time(event.get("timestamp"))
        if not station or not system or not stamp:
            return None
        report = {"system_name": system, "station_name": station, "observed_at": stamp, "inventories": {}}
        same = system == self.context.get("system_name") and station == self.context.get("station_name")
        if same:
            for key in ("x", "y", "z", "population", "station_type", "metadata"):
                if key in self.context:
                    report[key] = self.context[key]
        market = event.get("MarketID") or (self.context.get("market_id") if same else None)
        if market:
            report["market_id"] = str(market)
        return report

    def inventory(self, event):
        kind = KINDS.get(event.get("event"))
        if not kind:
            return False
        report = self._report(event)
        items = _items(event, kind)
        if not report or items is None or not report.get("market_id"):
            return False
        report["inventories"][kind] = {"observed_at": report["observed_at"], "items": items}
        self._queue(report, kind)
        return True

    def read_files(self, journal_path):
        """Only current dock, correct MarketID and names; historical replay never reads sidecars."""
        if not self.context.get("station_name") or not self.context.get("market_id"):
            return
        for event_name in KINDS:
            path = Path(journal_path) / (event_name + ".json")
            try:
                signature = (path.stat().st_mtime_ns, path.stat().st_size)
                if self.files_seen.get(str(path)) == signature:
                    continue
                if signature[1] > 4 * 1024 * 1024:
                    continue
                event = json.loads(path.read_text(encoding="utf-8"))
                if (str(event.get("MarketID")) != self.context["market_id"] or
                    event.get("StarSystem") != self.context["system_name"] or
                    event.get("StationName") != self.context["station_name"] or
                    event.get("event") != event_name):
                    continue
                if self.inventory(event):
                    self.files_seen[str(path)] = signature
            except (OSError, ValueError, AttributeError):
                continue

    def flush(self, api):
        if not api.is_connected:
            return {"ok": False, "error": "Not connected"}
        with self.lock:
            batch = []
            size = 0
            for entry in list(self.pending.items())[:20]:
                length = len(json.dumps(entry[1], ensure_ascii=False).encode("utf-8"))
                if batch and size + length > 3 * 1024 * 1024:
                    break
                batch.append(entry)
                size += length
        if not batch:
            return {"ok": True, "accepted": 0}
        result = api.upload_station_reports([report for _, report in batch])
        if result.get("ok"):
            with self.lock:
                for key, report in batch:
                    if self.pending.get(key) == report:
                        self.pending.pop(key, None)
                self._save()
        return result
