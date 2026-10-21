"""Extract account-scoped Community Goal snapshots from Elite journal events."""

import re
import threading
from typing import Iterable, List


def _number(value, default=None):
    if isinstance(value, bool) or value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return parsed if parsed >= 0 else default


def _tier(value):
    number = _number(value)
    if number is not None:
        return number
    match = re.search(r"\d+", str(value or ""))
    return int(match.group(0)) if match else None


def community_goal_reports_from_event(event: dict) -> List[dict]:
    """Return normalized current-goal records from one CommunityGoal event.

    Personal values remain account-scoped. The server derives the matching key
    and ignores any caller-supplied account identity.
    """
    if not isinstance(event, dict) or event.get("event") != "CommunityGoal":
        return []
    timestamp = str(event.get("timestamp") or "").strip()
    current_goals = event.get("CurrentGoals")
    if not timestamp or not isinstance(current_goals, list):
        return []

    rows = []
    for goal in current_goals:
        if not isinstance(goal, dict):
            continue
        game_cg_id = _number(goal.get("CGID"))
        title = str(goal.get("Title") or "").strip()
        if not game_cg_id or not title:
            continue
        rows.append({
            "game_cg_id": game_cg_id,
            "title": title,
            "system_name": str(goal.get("SystemName") or "").strip() or None,
            "station_name": str(goal.get("MarketName") or "").strip() or None,
            "expiry_date": str(goal.get("Expiry") or "").strip() or None,
            "player_contribution": _number(goal.get("PlayerContribution"), 0),
            "current_total": _number(goal.get("CurrentTotal")),
            "tier_reached": _tier(goal.get("TierReached")),
            "tier_max": _tier(goal.get("TierMax")),
            "contributors_num": _number(goal.get("NumContributors")),
            "percentile_band": _number(goal.get("PlayerPercentileBand")),
            "is_top_rank": goal.get("PlayerInTopRank") if isinstance(goal.get("PlayerInTopRank"), bool) else None,
            "is_complete": goal.get("IsComplete") if isinstance(goal.get("IsComplete"), bool) else None,
            "observed_at": timestamp,
        })
    return rows


class CommunityGoalReportCollector:
    """Dedupe repeated journal records while retaining failed uploads for retry."""

    def __init__(self):
        self._lock = threading.Lock()
        self._seen = set()
        self._pending: List[dict] = []

    @staticmethod
    def _key(row: dict) -> tuple:
        return (
            row.get("game_cg_id"), row.get("observed_at"),
            row.get("player_contribution"), row.get("current_total"),
            row.get("tier_reached"),
        )

    def feed(self, _line: str, event: dict) -> bool:
        return self.add_reports(community_goal_reports_from_event(event))

    def add_reports(self, rows: Iterable[dict]) -> bool:
        added = False
        with self._lock:
            for row in rows:
                key = self._key(row)
                if key in self._seen:
                    continue
                self._seen.add(key)
                self._pending.append(dict(row))
                added = True
        return added

    def drain(self) -> List[dict]:
        with self._lock:
            rows, self._pending = self._pending, []
            return rows

    def requeue(self, rows: Iterable[dict]) -> None:
        with self._lock:
            pending_keys = {self._key(row) for row in self._pending}
            for row in rows:
                key = self._key(row)
                if key not in pending_keys:
                    self._pending.append(dict(row))
                    pending_keys.add(key)
