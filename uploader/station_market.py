"""Current dock's sale availability for CARRIER (local journal, no network).

A carrier's cargo is NOT the market of the station the pilot is visiting.
Keep these independent. A Market snapshot is usable only for this docking;
replaying history must never resurrect sale highlights from an old station.
"""
from __future__ import annotations

import math
import threading
from datetime import datetime, timezone

from carrier_sync import canonical_commodity


def _stamp(value):
    try:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        seconds = stamp.timestamp()
        if not math.isfinite(seconds) or seconds > datetime.now(timezone.utc).timestamp() + 300:
            return None
        return seconds
    except (ValueError, TypeError, OverflowError):
        return None


def _market_id(value):
    if isinstance(value, bool):
        return ""
    text = str(value or "")
    return str(int(text)) if len(text) <= 20 and text.isascii() and text.isdigit() and int(text) > 0 else ""


def _positive(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and 0 < value <= 1e15 and math.isfinite(value))


class StationMarketAvailability:
    def __init__(self):
        self._lock = threading.RLock()
        self._clear()

    def _clear(self):
        self._dock = {}
        self._since = None
        self._observed = None
        self._stocks = {}
        self._known = False
        self._last_buys = {}

    def handle(self, event, live=False):
        if not isinstance(event, dict):
            return
        with self._lock:
            name = event.get("event")
            if name in ("Undocked", "FSDJump", "SupercruiseEntry", "Shutdown", "Commander", "LoadGame"):
                self._clear()
            elif name in ("Docked", "Location", "CarrierJump"):
                self._clear()
                docked = name == "Docked" or event.get("Docked") is True
                market = _market_id(event.get("MarketID"))
                if docked and market and event.get("StationName") and event.get("StarSystem"):
                    self._dock = {"market_id": market, "station_name": str(event["StationName"]),
                                  "system_name": str(event["StarSystem"])}
                    self._since = _stamp(event.get("timestamp"))
            elif live and name == "Market":
                self._snapshot(event)
            elif live and name == "MarketBuy" and self._matches(event):
                # Buying the last units must remove the highlight immediately,
                # without waiting for the next Market.json rewrite.
                stamp = _stamp(event.get("timestamp"))
                key = canonical_commodity(event.get("Type"))
                count = event.get("Count")
                trade = (stamp, count, event.get("TotalCost"))
                if (self._last_buys.get(key) != trade and self._known and key in self._stocks and _positive(count)
                        and stamp is not None and stamp >= self._observed):
                    left = max(0, self._stocks[key] - int(count))
                    if left:
                        self._stocks[key] = left
                    else:
                        self._stocks.pop(key, None)
                    self._observed = stamp
                    self._last_buys[key] = trade

    def _matches(self, event):
        return bool(self._dock and _market_id(event.get("MarketID")) == self._dock["market_id"]
                    and (not event.get("StationName") or event["StationName"] == self._dock["station_name"])
                    and (not event.get("StarSystem") or event["StarSystem"] == self._dock["system_name"]))

    def _snapshot(self, event):
        items = event.get("Items")
        stamp = _stamp(event.get("timestamp"))
        if (not self._matches(event) or not isinstance(items, list) or len(items) > 5000
                or stamp is None or self._since is None or stamp < self._since
                or (self._observed is not None and stamp < self._observed)):
            return
        stocks = {}
        for item in items:
            if not isinstance(item, dict) or not item.get("Name"):
                return  # partial/malformed file is not an empty market
            key = canonical_commodity(item["Name"])
            stock = item.get("Stock")
            # BuyPrice is what the pilot pays. Demand/SellPrice alone means
            # the station BUYS the commodity, not that the pilot can buy it.
            if (key and _positive(stock) and _positive(item.get("BuyPrice"))
                    and item.get("Producer") is not False and int(stock) > 0):
                stocks[key] = int(stock)
        self._stocks = stocks
        self._known = True
        self._observed = stamp

    def decorate_carrier(self, carrier):
        """Return independent row copies, preserving cargo, order and totals."""
        with self._lock:
            result = dict(carrier or {})
            result["station_market"] = {**self._dock, "docked": bool(self._dock), "known": self._known}
            result["commodities"] = [
                {**row, "station_stock": self._stocks.get(canonical_commodity(row.get("key")), 0),
                 "station_sells": canonical_commodity(row.get("key")) in self._stocks}
                for row in (result.get("commodities") or [])
            ]
            return result
