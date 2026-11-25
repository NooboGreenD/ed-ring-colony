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
