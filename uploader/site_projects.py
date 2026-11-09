"""Проекты строительства на сайте проекта — первичный источник для Helper.

Зачем модуль
------------
Raven Colonial — сторонний сервис: он отвечает 503, теряет ключи и меняет
схему без предупреждения. Пока проект стройки жил только там, любой его сбой
означал «нет действующих проектов»: вкладка «Колонизатор» пустела, а оверлей
CARRIER писал «Проект не выбран». Данные при этом были — их присылал сам
Helper, но деть их было некуда.

Теперь порядок обратный:

1. Helper **сначала** регистрирует проект на сайте проекта
   (`POST /api/projects/register`);
2. и только потом дублирует его в Raven Colonial (`PUT /api/project`), если
   ключ RCC задан и сервис отвечает;
3. если Raven недоступен — проект живёт на сайте, а Helper покажет его во
   вкладке «Колонизатор» и в оверлее. Синхронизация повторится при следующей
   перечитке: проект без `buildId` Helper попробует создать в Raven снова.

Модуль отвечает за три вещи и ничего не знает про окно и Qt:

* :func:`normalize_card` — привести карточку сайта к виду, в котором остальной
  код Helper привык видеть проекты Raven (`buildId`, `commodities`,
  `sumNeed`/`sumTotal`). Иначе пришлось бы ветвить каждый вызов;
* :func:`merge_projects` — слить проекты сайта и Raven в один список без
  дублей: площадка опознаётся по `marketId`, затем по `buildId`, затем по
  ключу;
* :func:`need_from_project` — остаток потребности для оверлея.
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

def _text(value: Any) -> str:
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, (str, int, float)):
        return str(value).strip()
    return ""


def _int(value: Any) -> Optional[int]:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _commodities(value: Any) -> Dict[str, int]:
    """`{"steel": 900}` → `{"steel": 900}`; мусор и нули отбрасываются."""
    if not isinstance(value, dict):
        return {}
    out: Dict[str, int] = {}
    for raw_key, raw_value in value.items():
        key = _text(raw_key).lower()
        amount = _float(raw_value)
        if not key or amount is None or amount <= 0:
            continue
        out[key] = int(round(amount))
    return out


def normalize_card(raw: Any) -> Dict[str, Any]:
    """Карточка сайта → проект в форме Raven Colonial.

    Поля, которых в карточке нет, не выдумываются: `buildId` остаётся пустым,
    и вызывающий код по нему понимает, что проект ещё не синхронизирован с
    Raven Colonial.
    """
    if not isinstance(raw, dict):
        return {}
    build_id = _text(raw.get("buildId"))
    commodities = _commodities(raw.get("commodities"))
    if not commodities:
        # Сайт может отдать только точные ресурсы депота — считаем остаток сами.
        commodities = _commodities(
            {row.get("Name"): (row.get("RequiredAmount") or 0) - (row.get("ProvidedAmount") or 0)
             for row in (raw.get("resources") or []) if isinstance(row, dict)})
    need = sum(commodities.values())
    max_need = _int(raw.get("maxNeed"))
    if max_need is None:
        max_need = _int(raw.get("sumTotal"))
    progress = _float(raw.get("progress"))
    sources = [str(item) for item in (raw.get("sources") or []) if item]
    return {
        "key": _text(raw.get("key")),
        "buildId": build_id,
        "systemName": _text(raw.get("systemName")),
        "systemAddress": _int(raw.get("systemAddress")),
        "marketId": _int(raw.get("marketId")),
        "buildName": _text(raw.get("buildName")),
        "buildType": _text(raw.get("buildType")),
        "bodyName": _text(raw.get("bodyName")),
        "bodyNum": _int(raw.get("bodyNum")),
        "architectName": _text(raw.get("architectName")),
        "commander": _text(raw.get("commander")),
        "status": "complete" if _text(raw.get("status")) == "complete" else "active",
        "progress": progress,
        "commodities": commodities,
        "sumNeed": need,
        "maxNeed": max_need,
        "sumTotal": max_need,
        "primary": bool(raw.get("primary")),
        "sources": sources,
        "stale": bool(raw.get("stale")),
        "rcState": _text(raw.get("rcState")) or "unknown",
        "updatedAt": _text(raw.get("updatedAt")),
        "fromSite": True,
    }


def normalize_raven(raw: Any) -> Dict[str, Any]:
    """Проект Raven Colonial → та же форма, что у карточки сайта."""
    if not isinstance(raw, dict) or not raw.get("buildId"):
        return {}
    commodities = _commodities(raw.get("commodities"))
    need = _int(raw.get("sumNeed"))
    if need is None:
        need = sum(commodities.values())
    total = _int(raw.get("sumTotal"))
    if total is None:
        total = _int(raw.get("maxNeed"))
    return {
        "key": f"rc:{_text(raw.get('buildId'))}",
        "buildId": _text(raw.get("buildId")),
        "systemName": _text(raw.get("systemName")),
        "systemAddress": _int(raw.get("systemAddress")),
        "marketId": _int(raw.get("marketId")),
        "buildName": _text(raw.get("buildName")),
        "buildType": _text(raw.get("buildType")),
        "bodyName": _text(raw.get("bodyName")),
        "bodyNum": _int(raw.get("bodyNum")),
        "architectName": _text(raw.get("architectName")),
        "commander": _text(raw.get("commander")),
        "status": "complete" if raw.get("complete") else "active",
        "progress": _float(raw.get("progress")),
        "commodities": commodities,
        "sumNeed": need,
        "maxNeed": total,
        "sumTotal": total,
        "primary": bool(raw.get("primary")),
        "sources": ["raven"],
        "stale": False,
        "rcState": "ok",
        "updatedAt": _text(raw.get("updatedAt")),
        "fromSite": False,
    }


def normalize_projects(items: Iterable[Any], *, from_site: bool) -> List[Dict[str, Any]]:
    normalize = normalize_card if from_site else normalize_raven
    out: List[Dict[str, Any]] = []
    for item in items or []:
        project = normalize(item)
        if project:
            out.append(project)
    return out


def _merge_into(target: Dict[str, Any], incoming: Dict[str, Any]) -> None:
    """Дополнить проект тем, чего у него нет; числа — только непустыми."""
    for field in ("buildId", "systemName", "marketId", "systemAddress",
                  "buildName", "buildType", "bodyName", "bodyNum",
                  "architectName", "commander", "updatedAt"):
        if not target.get(field) and incoming.get(field):
            target[field] = incoming[field]
    if not target.get("commodities") and incoming.get("commodities"):
        target["commodities"] = dict(incoming["commodities"])
        target["sumNeed"] = incoming.get("sumNeed") or sum(incoming["commodities"].values())
    if target.get("maxNeed") is None and incoming.get("maxNeed") is not None:
        target["maxNeed"] = incoming["maxNeed"]
        target["sumTotal"] = incoming["maxNeed"]
    if target.get("progress") is None and incoming.get("progress") is not None:
        target["progress"] = incoming["progress"]
    if incoming.get("status") == "complete":
        target["status"] = "complete"
    if incoming.get("primary"):
        target["primary"] = True
    sources = list(target.get("sources") or [])
    for source in incoming.get("sources") or []:
        if source not in sources:
            sources.append(source)
    target["sources"] = sources
    if incoming.get("rcState") == "ok" or target.get("rcState") in (None, "", "unknown"):
        target["rcState"] = incoming.get("rcState") or target.get("rcState")
    if incoming.get("buildId"):
        # Проект, который сайт знал без buildId, теперь связан с Raven.
        target["fromSite"] = target.get("fromSite", False)


def merge_projects(site_projects: Iterable[Any],
                   raven_projects: Iterable[Any] = ()) -> List[Dict[str, Any]]:
    """Слить проекты сайта и Raven в один список без дублей.

    Сайт — первичный источник: его карточка задаёт название, площадку и
    остаток. Raven дополняет `buildId` (без него не работают действия вкладки)
    и, если сайт ещё не получал депот, — остаток потребности.
    """
    merged: List[Dict[str, Any]] = []
    by_market: Dict[int, Dict[str, Any]] = {}
    by_build: Dict[str, Dict[str, Any]] = {}
    by_key: Dict[str, Dict[str, Any]] = {}

    def remember(project: Dict[str, Any]) -> None:
        market = project.get("marketId")
        if market:
            by_market[int(market)] = project
        build = project.get("buildId")
        if build:
            by_build[str(build)] = project
        key = project.get("key")
        if key:
            by_key[str(key)] = project

    for project in list(normalize_projects(site_projects, from_site=True)) \
            + list(normalize_projects(raven_projects, from_site=False)):
        market = project.get("marketId")
        build = project.get("buildId")
        found = (by_market.get(int(market)) if market else None) \
            or (by_build.get(str(build)) if build else None) \
            or by_key.get(str(project.get("key") or ""))
        if found is not None:
            _merge_into(found, project)
            remember(found)
            continue
        merged.append(dict(project))
        remember(merged[-1])

    # Активные — первыми: вкладка показывает список сверху вниз, и закрытые
    # проекты не должны оттеснять то, что строится сейчас.
    merged.sort(key=lambda item: (
        0 if item.get("status") != "complete" else 1,
        str(item.get("systemName") or "").lower(),
        str(item.get("buildName") or "").lower(),
    ))
    return merged


def need_from_project(project: Dict[str, Any]) -> Dict[str, int]:
    """Остаток потребности проекта: `{"steel": 900}` (только положительные)."""
    if not isinstance(project, dict):
        return {}
    return {str(key).lower(): int(amount)
            for key, amount in (project.get("commodities") or {}).items()
            if _float(amount) and int(float(amount)) > 0}


def project_label(project: Dict[str, Any], fallback: str = "") -> str:
    """Подпись проекта для строки лога и оверлея: `Система: постройка`."""
    if not isinstance(project, dict):
        return fallback
    name = _text(project.get("buildName")) or fallback
    system = _text(project.get("systemName"))
    return " · ".join(part for part in (name, system) if part) or fallback


def progress_text(project: Dict[str, Any]) -> str:
    """`осталось 900 / 5000 (18%)` — как в таблице вкладки «Колонизатор»."""
    if not isinstance(project, dict):
        return "—"
    need = _int(project.get("sumNeed"))
    total = _int(project.get("sumTotal"))
    if need is None and total is None:
        return "—"
    need = int(need or 0)
    total = int(total or 0)
    if total <= 0:
        return f"{need}"
    percent = 100 * need // total if total else 0
    return f"{need} / {total} ({percent}%)"


def raven_project_payload(project: Dict[str, Any], *, cmdr: str = "") -> Dict[str, Any]:
    """Карточка проекта → тело `PUT /api/project` для Raven Colonial.

    Нужно, когда Helper досылает проект, созданный при недоступном Raven:
    карточка сайта пришла из того же черновика, что ушёл бы в Raven, поэтому
    обратное преобразование однозначно. Пустые поля не отправляются — Raven
    делает merge и `null` затёр бы уже сохранённое значение.
    """
    if not isinstance(project, dict):
        return {}
    payload: Dict[str, Any] = {}
    mappings = (
        ("marketId", "marketId"), ("systemAddress", "systemAddress"),
        ("buildName", "buildName"), ("buildType", "buildType"),
        ("systemName", "systemName"), ("bodyName", "bodyName"),
        ("bodyNum", "bodyNum"), ("architectName", "architectName"),
    )
    numeric = {"marketId", "systemAddress", "bodyNum"}
    for source, target in mappings:
        value = project.get(source)
        if value in (None, ""):
            continue
        if target in numeric:
            number = _int(value)
            if number is not None:
                payload[target] = number
            continue
        payload[target] = str(value)
    commodities = need_from_project(project)
    if commodities:
        payload["commodities"] = commodities
    max_need = _int(project.get("maxNeed"))
    if max_need and max_need > 0:
        payload["maxNeed"] = max_need
    if project.get("primary"):
        payload["isPrimaryPort"] = True
    if cmdr:
        payload["commanders"] = {str(cmdr): []}
    return payload


def projects_payload(data: Any) -> List[Any]:
    """Список проектов из ответа `/api/projects/active` любой формы."""
    if isinstance(data, dict):
        for key in ("projects", "Projects", "data"):
            if isinstance(data.get(key), list):
                return data[key]
        return []
    if isinstance(data, list):
        return data
    return []


def raven_available(response: Any) -> Optional[bool]:
    """Доступен ли Raven Colonial по ответу Helper'а: True/False/None (неизвестно)."""
    if not isinstance(response, dict):
        return None
    if response.get("ok"):
        return True
    status = _int(response.get("status"))
    if status in (500, 502, 503, 504):
        return False
    error = _text(response.get("error")).lower()
    if any(token in error for token in ("503", "502", "504", "unavailable", "timed out",
                                        "timeout", "connection", "не ответил")):
        return False
    return None
