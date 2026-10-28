"""Подсказка о следующей системе маршрута: стройка и первооткрыватель.

Оверлей ROUTE показывает маршрут, но командиру нужны ещё две вещи о следующей
системе: идёт ли там стройка и на сколько она готова, и кто открыл систему —
если система вообще есть в базе проекта. Данные приходят с сайта
(`GET /api/systems/route-hint`, `src/lib/routeHint.ts`), а здесь они
приводятся к одному виду, который печатает оверлей.

Модуль чистый: ни сети, ни Qt. Поэтому и тесты, и оверлей видят ровно одно и
то же состояние, а «в тестах зелено, на экране пусто» невозможно.

Важное правило: **ничего не выдумывать**. Если система не найдена в базе —
это «ещё не исследована», а не «нет данных» и не пустая строка. Если
первооткрыватель неизвестен, но система в базе есть — так и говорим, потому
что «система в базе» и «известен первооткрыватель» — разные факты.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

#: Состояния стройки: те же три, что у статуса систем на сайте, плюс
#: «неизвестно» — когда проект о системе ничего не знает.
BUILDING = "building"
DONE = "done"
PLANNED = "planned"
UNKNOWN = "unknown"

#: Статусы, которые оверлей умеет показать. Всё прочее считаем «неизвестно».
STATUSES = (BUILDING, DONE, PLANNED, UNKNOWN)

#: Сколько недостач по товарам имеет смысл печатать в узком блоке.
MAX_NEEDS = 3


def empty_hint() -> Dict[str, Any]:
    """Состояние «подсказки ещё нет»: ничего не знаем, ничего не выдумываем."""
    return {
        "system": "",
        "loading": False,
        "error": "",
        # Система есть в базе проекта (журналы пилотов, EDSM, Spansh).
        "known": False,
        "bodies": 0,
        "mapped": 0,
        "footfall": 0,
        "discoverer": "",
        "status": UNKNOWN,
        "progress": None,
        "remaining": None,
        "needs": [],
        "sites_active": 0,
        "sites_complete": 0,
        "updated_at": None,
    }


def _text(value: Any, limit: int = 120) -> str:
    if value is None:
        return ""
    return str(value).strip()[:limit]


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):   # NaN/inf
        return None
    return number


def _percent(value: Any) -> Optional[int]:
    number = _number(value)
    if number is None:
        return None
    return max(0, min(100, int(round(number))))


def _count(value: Any) -> int:
    number = _number(value)
    return 0 if number is None else max(0, int(number))


def normalize_hint(payload: Any, system: str = "") -> Dict[str, Any]:
    """Ответ сайта → состояние для оверлея.

    Принимает и полный ответ (`{ok, system, construction, discovery}`), и
    пустоту: оверлей обязан показать «ещё не исследована», а не упасть.
    """
    hint = empty_hint()
    hint["system"] = _text(system, 200)
    if not isinstance(payload, dict):
        return hint
    if not payload.get("ok", True):
        hint["error"] = _text(payload.get("error") or "нет ответа сайта", 200)
        return hint

    system_name = _text(payload.get("system"), 200)
    if system_name:
        hint["system"] = system_name

    construction = payload.get("construction")
    if isinstance(construction, dict):
        status = _text(construction.get("status"), 20).lower()
        if status not in STATUSES:
            status = UNKNOWN
        progress = _percent(construction.get("progress"))
        # Процент без статуса — тоже стройка: сайт мог отдать только прогресс.
        if status == UNKNOWN and progress is not None:
            status = DONE if progress >= 100 else BUILDING
        needs: List[Dict[str, Any]] = []
        for need in construction.get("needs") or []:
            if not isinstance(need, dict):
                continue
            label = _text(need.get("label"), 60)
            amount = _number(need.get("remaining"))
            if not label or amount is None:
                continue
            needs.append({"label": label, "remaining": max(0, int(round(amount)))})
            if len(needs) >= MAX_NEEDS:
                break
        remaining = _number(construction.get("remaining"))
        if construction.get("known") is False:
            # Проект о стройке не знает — ни процент, ни остаток ничего не значат.
            status, progress, remaining, needs = UNKNOWN, None, None, []
        hint["status"] = status
        hint["progress"] = progress
        hint["remaining"] = None if remaining is None else max(0, int(round(remaining)))
        hint["sites_active"] = _count(construction.get("sitesActive"))
        hint["sites_complete"] = _count(construction.get("sitesComplete"))
        hint["updated_at"] = construction.get("updatedAt") or None
        hint["needs"] = needs

    discovery = payload.get("discovery")
    if isinstance(discovery, dict):
        hint["known"] = bool(discovery.get("known"))
        hint["bodies"] = _count(discovery.get("bodies"))
        hint["mapped"] = _count(discovery.get("mapped"))
        hint["footfall"] = _count(discovery.get("footfall"))
        hint["discoverer"] = _text(discovery.get("discoverer"), 80)
    return hint


def mark_loading(hint: Dict[str, Any], system: str) -> Dict[str, Any]:
    """То же состояние, но с пометкой «запрашиваем» — для нового маршрута."""
    fresh = empty_hint()
    if isinstance(hint, dict) and hint.get("system") == system:
        fresh.update(hint)
    fresh["system"] = _text(system, 200)
    fresh["loading"] = True
    return fresh


def hint_signature(hint: Optional[Dict[str, Any]]) -> str:
    """Короткая подпись для кэша оверлея: изменилось — перерисовать."""
    hint = hint or {}
    return "|".join(str(hint.get(key, "")) for key in (
        "system", "loading", "error", "known", "discoverer", "status", "progress",
        "remaining", "sites_active", "sites_complete", "bodies", "mapped", "footfall",
    ))
