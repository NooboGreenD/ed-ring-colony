"""Pure loading-pattern session/projection. No Qt, network or journal writes."""

from copy import deepcopy
from threading import RLock
from i18n import tr


def _synchronized(method):
    def call(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)

    return call


class LoadingPatternState:
    def __init__(self):
        self._lock = RLock()
        self.identity = None
        self.pattern_id = ""
        self.payload = {}
        self.error = ""

    @_synchronized
    def clear(self, identity=None, pattern_id=""):
        self.identity, self.pattern_id = identity, pattern_id
        self.payload, self.error = {}, ""

    @_synchronized
    def prepare(self, identity, pattern_id):
        if (identity, pattern_id) != (self.identity, self.pattern_id):
            self.clear(identity, pattern_id)

    @_synchronized
    def accept(self, identity, pattern_id, result):
        if (identity, pattern_id) != (self.identity, self.pattern_id):
            return False
        if not result.get("ok") or not isinstance(result.get("progress"), dict):
            self.payload = {}
            self.error = str(result.get("error") or tr("Не удалось загрузить паттерн"))
            return False
        self.payload = deepcopy(result)
        self.error = ""
        return True

    @_synchronized
    def snapshot(self, identity, pattern_id, carrier_id=""):
        if (identity, pattern_id) != (self.identity, self.pattern_id):
            return {}
        if self.error:
            return {"note": self.error}
        result = deepcopy(self.payload)
        result["carrier_id"] = carrier_id
        return result


def loading_lines(data, show_completed=False):
    """Compact pending rows, never treat an inaccessible inventory as zero."""
    progress = data.get("progress") or {}
    selected = data.get("carrier_id")
    carriers, rows = [], []
    for carrier in progress.get("carriers") or []:
        if selected and str(carrier.get("carrierId")) != str(selected):
            continue
        name = str(carrier.get("name") or carrier.get("carrierId") or "?")
        known = carrier.get("known") is True
        value = str(carrier.get("loaded") or 0) if known else "?"
        carriers.append(
            f"{name}  {value} / {carrier.get('target', 0)} t · {carrier.get('updatedAt') or '?'}"
        )
        for item in carrier.get("items") or []:
            remaining = item.get("remaining")
            if remaining == 0 and not show_completed:
                continue
            left = "?" if remaining is None else str(remaining)
            rows.append(
                f"{name[:16]} · {item.get('name') or item.get('commodity', '?')}  -{left} t"
            )
    return carriers, rows


def loading_tables(data, show_completed=False):
    """Per-carrier table projection. Filtering never changes header totals.

    'loaded' is covered target stock, not cumulative deliveries or surplus.
    A missing observation stays None; partial coverage is a lower bound.
    """
    result = []
    selected = str(data.get("carrier_id") or "")
    for carrier in (data.get("progress") or {}).get("carriers") or []:
        carrier_id = str(carrier.get("carrierId") or "")
        if selected and selected != carrier_id:
            continue
        rows = []
        loaded = target = unknown = 0
        for item in carrier.get("items") or []:
            required = max(0, int(item.get("required") or 0))
            if not required:
                continue
            quantity = item.get("loaded")
            done = None if quantity is None else min(required, max(0, int(quantity)))
            remaining = None if done is None else required - done
            target += required
            loaded += done or 0
            if done is None:
                unknown += required
            if not show_completed and remaining == 0:
                continue
            rows.append(
                {
                    "commodity": str(item.get("commodity") or "?"),
                    "name": str(item.get("name") or item.get("commodity") or "?"),
                    "required": required,
                    "loaded": done,
                    "remaining": remaining,
                }
            )
        result.append(
            {
                "carrierId": carrier_id,
                "name": str(carrier.get("name") or carrier_id or "?"),
                "target": target,
                "loaded": loaded if unknown < target or not target else None,
                "remaining": None if unknown else target - loaded,
                "unknown": unknown,
                "rows": rows,
                "updatedAt": carrier.get("updatedAt"),
            }
        )
    return result


def loading_segments(loaded, target, count=20):
    """Whole filled squares: 99% must not look complete; None means unknown."""
    if loaded is None:
        return None
    if target <= 0:
        return 0
    return min(count, max(0, int(loaded) * count // int(target)))
