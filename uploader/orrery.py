"""Геометрия 3D-оррери системы — общая для Tk-карты и HTML-экспорта Plotly.

Модуль переносит на Python раскладку, которую сайт проекта считает в
`src/lib/systemOrrery.ts`, чтобы «Карта системы» в Colonial Helper и 3D-карта на
сайте выглядели одинаково. Ключевые отличия от старой версии `plotly_map.py`:

* **Многозвёздные системы.** Планета принадлежит своей звезде (цепочка
  `parent_ids`, как в `Scan.Parents` и EDSM), а не всем скопом крутится вокруг
  главной. Каждой звёзде выдаётся свой бюджет радиуса, который сжимается по мере
  роста числа звёзд —система из 20–40 звёзд остаётся читаемой.
* **Наземные постройки на поверхности.** Смещение станции/стройки считается от
  визуального радиуса тела (пересчёт пикселей маркера в unit'ы сцены), а не
  фиксированными `3.2 + i * 2.2` — иначе «поселение» висело в пустоте рядом с
  планетой.
* **Фокус с приближением.** `focus_view` отдаёт центр, разрез осей и дистанцию
  камеры: «система → кластер звезды → окрестность тела → тело крупно».

Модуль не тянет Plotly и Tk: чистые функции и словари, которые можно сериализовать
в JSON для браузера.
"""
from __future__ import annotations

import math
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

#: Половина размаха осей в unit'ах сцены (не зависит от реальных световых секунд).
SCENE_SPAN = 240.0
GOLDEN_ANGLE = 2.399963229728653
LS_PER_AU = 499.00478
SOL_RADIUS_M = 6.957e8
SOL_TEMP_K = 5778.0

#: Номинальный размер canvas'а, в пикселях. Нужен для пересчёта «пиксели маркера»
#: в «unit'ы сцены»: Plotly рисует маркеры в px, а координаты — в unit'ах.
CANVAS_PX = 1000.0


# ---------------------------------------------------------------------------
#  Мелкие утилиты
# ---------------------------------------------------------------------------
def _num(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(result) or math.isinf(result):
        return default
    return result


def _log_map(value: float, low: float, high: float) -> float:
    low_log = math.log10(max(1e-3, low))
    high_log = math.log10(max(1e-3, high))
    if abs(high_log - low_log) < 1e-9:
        return 0.5
    return min(1.0, max(0.0, (math.log10(max(1e-3, value)) - low_log) / (high_log - low_log)))


def star_designation(name: str, system: str = "") -> str:
    """Буквенное обозначение звезды из имени тела: «Sol A 3» → «A», «Sol 16» → ''.

    Python-порт `extractStarKey` из `src/lib/systemOrrery.ts`.
    """
    text = str(name or "").strip()
    prefix = str(system or "").strip()
    if prefix and text.lower().startswith(prefix.lower()):
        text = text[len(prefix):]
    match = _STAR_PREFIX_RE.match(text)
    return match.group(1) if match else ""


import re  # noqa: E402  (после star_designation — только для регулярки выше)

_STAR_PREFIX_RE = re.compile(r"^\s*([A-Z]{1,3})(?=\s|$)")


def estimate_star_luminosity(body: Dict[str, Any]) -> float:
    """Светимость в L☉ по радиусу и температуре (если их нет — 1)."""
    radius = _num(body.get("radius_m"))
    temp = _num(body.get("surface_temp_k"))
    radius_sol = radius / SOL_RADIUS_M if radius > 0 else 1.0
    temp_sol = temp / SOL_TEMP_K if temp > 0 else 1.0
    return max(1e-4, radius_sol ** 2 * temp_sol ** 4)


def habitable_zone_ls(body: Dict[str, Any]) -> Tuple[float, float]:
    """Границы обитаемой зоны в св. секундах: 0.75…1.77 а.е. × √L."""
    sqrt_l = math.sqrt(estimate_star_luminosity(body))
    inner = 0.75 * sqrt_l * LS_PER_AU
    outer = max(inner + 5.0, 1.77 * sqrt_l * LS_PER_AU)
    return inner, outer


def body_marker_size(kind: str, radius_m: float, crowded: bool) -> float:
    """Размер маркера в px: логарифм по радиусу, с подрезкой в плотных системах."""
    radius_km = max(50.0, _num(radius_m) / 1000.0)
    if kind == "star":
        base = 13.0 + math.log10(max(1000.0, radius_km) / 1e5) * 4.0
        ceiling = 13.0 if crowded else 26.0
        floor = 8.0 if crowded else 12.0
    else:
        base = 5.5 + math.log10(max(1.0, radius_km) / 1000.0) * 3.2
        ceiling = 10.0 if crowded else 18.0
        floor = 4.0 if crowded else 5.5
    return round(min(ceiling, max(floor, base)) * 10) / 10.0


def units_per_pixel(axis_span: float, canvas_px: float) -> float:
    if canvas_px <= 0 or axis_span <= 0:
        return 1.0
    return axis_span / canvas_px


def body_display_radius_units(markers: Dict[str, float], name: str,
                              half_span: float, canvas_px: float = CANVAS_PX) -> float:
    """Визуальный радиус тела в unit'ах сцены при текущем зуме."""
    size_px = _num(markers.get(name), 8.0)
    ratio = units_per_pixel(half_span * 2.0, canvas_px)
    return max(0.6, (size_px / 2.0) * ratio * 1.25)


def ellipse_path(radius: float, center: Sequence[float], phase: float = 0.0,
                 inclination: float = 0.0, steps: int = 64) -> List[Tuple[float, float, float]]:
    points: List[Tuple[float, float, float]] = []
    cx, cy, cz = (list(center) + [0.0, 0.0, 0.0])[:3]
    for step in range(steps + 1):
        phi = phase + 2.0 * math.pi * step / steps
        x = radius * math.cos(phi)
        y = radius * math.sin(phi)
        points.append((cx + x, cy + y * math.cos(inclination), cz + y * math.sin(inclination)))
    return points


# ---------------------------------------------------------------------------
#  Планировщик кластеров
# ---------------------------------------------------------------------------
def _body_view(body: Any) -> Dict[str, Any]:
    """MapBody → плоский dict (он же уходит в JSON для HTML-карты)."""
    rings: List[Dict[str, Any]] = []
    for ring in getattr(body, "rings", None) or []:
        if not isinstance(ring, dict):
            continue
        rings.append({
            "name": str(ring.get("name") or ring.get("Name") or "Кольцо"),
            "class": str(ring.get("ringClass") or ring.get("RingClass") or ring.get("type") or "Icy"),
            "inner_km": _num(ring.get("innerRadiusKm") or ring.get("innerRadius") or ring.get("InnerRad")) / 1000.0,
            "outer_km": _num(ring.get("outerRadiusKm") or ring.get("outerRadius") or ring.get("OuterRad")) / 1000.0,
        })
    kind = str(getattr(body, "kind", "") or "")
    # Неопознанное тело — планета: старая карта так и считала (`kind not in
    # (star, moon)`), иначе тело из неполного скана вообще не попадало на карту.
    view_kind = "star" if kind == "star" else ("moon" if kind == "moon" else "planet")
    return {
        "name": str(getattr(body, "name", "") or ""),
        "kind": view_kind,
        "raw_kind": kind,
        "body_id": getattr(body, "body_id", None),
        "class": str(getattr(body, "body_class", "") or getattr(body, "star_type", "") or ""),
        "star_type": str(getattr(body, "star_type", "") or ""),
        "distance_ls": _num(getattr(body, "distance_ls", 0.0)),
        "orbit_ls": max(0.0, _num(getattr(body, "orbit_ls", 0.0)) or _num(getattr(body, "semi_major_axis_ls", 0.0))
                        or _num(getattr(body, "distance_ls", 0.0))),
        "parent_ids": [int(pid) for pid in (getattr(body, "parent_ids", None) or []) if isinstance(pid, (int, float))],
        "parent_name": str(getattr(body, "parent_name", "") or ""),
        "radius_m": _num(getattr(body, "radius_m", 0.0)),
        "gravity": _num(getattr(body, "gravity", 0.0)),
        "surface_temp_k": _num(getattr(body, "surface_temp_k", 0.0)),
        "landable": bool(getattr(body, "landable", False)),
        "bio_signals": int(_num(getattr(body, "bio_signals", 0.0))),
        "atmosphere": str(getattr(body, "atmosphere", "") or ""),
        "scanned": bool(getattr(body, "scanned", False)),
        "mapped": bool(getattr(body, "mapped", False)),
        "first_discovered_by": str(getattr(body, "first_discovered_by", "") or ""),
        "first_mapped_by": str(getattr(body, "first_mapped_by", "") or ""),
        "rings": rings,
        "star_key": "",
    }


def _resolve_star_owner(view: Dict[str, Any], by_id: Dict[int, Dict[str, Any]],
                        stars: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not stars:
        return None
    if view["kind"] == "star":
        return view
    current: Optional[Dict[str, Any]] = view
    seen: set = set()
    for _ in range(8):
        if current is None or current["name"] in seen:
            break
        seen.add(current["name"])
        if current["kind"] == "star":
            return current
        parent_id = next((pid for pid in current["parent_ids"]
                          if pid in by_id and by_id[pid]["name"] not in seen), None)
        if parent_id is None:
            break
        current = by_id.get(parent_id)
    if len(stars) == 1:
        return stars[0]
    key = view.get("star_key") or ""
    if key:
        for star in stars:
            if star["name"].endswith(" " + key) or star.get("star_key") == key:
                return star
    nearest: Optional[Dict[str, Any]] = None
    best = float("inf")
    for star in stars:
        delta = abs(star["distance_ls"] - view["distance_ls"])
        if delta < best:
            best = delta
            nearest = star
    return nearest or stars[0]


def plan_system(bodies: Iterable[Any], system_name: str = "", scale_mode: str = "orrery",
                show_moons: bool = True, extra_marks: int = 0) -> Dict[str, Any]:
    """Раскладка системы: координаты, орбиты, кольца, HZ, размеры маркеров.

    `bodies` — итератор `MapBody` (из `system_map.MapSnapshot.bodies`).
    """
    views = [_body_view(body) for body in bodies or []]
    views = [view for view in views if view["name"]]
    for view in views:
        view["star_key"] = star_designation(view["name"], system_name)

    by_name = {view["name"]: view for view in views}
    by_id: Dict[int, Dict[str, Any]] = {}
    for view in views:
        if isinstance(view["body_id"], int) and view["body_id"] > 0 and view["body_id"] not in by_id:
            by_id[view["body_id"]] = view

    stars = sorted((view for view in views if view["kind"] == "star"),
                   key=lambda view: (view["distance_ls"], view["name"]))
    planets = [view for view in views if view["kind"] == "planet"]
    moons = [view for view in views if view["kind"] == "moon"]
    # Порог «тесно» считается по всем телам, а не только по планетам: система из
    # сорока звёзд так же превращается в кашу подписей, как и система из сорока
    # планет (в TS-версии тот же критерий — длина списка тел).
    crowded = len(views) > 28 or extra_marks > 6

    markers = {view["name"]: body_marker_size(view["kind"], view["radius_m"], crowded) for view in views}
    positions: Dict[str, Tuple[float, float, float]] = {}
    orbit_info: Dict[str, Dict[str, Any]] = {}
    orbits: List[Dict[str, Any]] = []
    moon_orbits: List[Dict[str, Any]] = []
    ring_paths: List[Dict[str, Any]] = []
    hz_paths: List[Dict[str, Any]] = []
    clusters: List[Dict[str, Any]] = []

    star_count = max(1, len(stars))
    # 0.88 — запас снаружи: «фокус на кластере» обязан быть чуть ближе общего обзора.
    primary_budget = SCENE_SPAN * (0.88 if star_count == 1 else max(0.34, 0.86 / math.sqrt(star_count)))
    star_spread = SCENE_SPAN

    cluster_members: Dict[str, List[Dict[str, Any]]] = {}
    for view in planets + (moons if show_moons else []):
        owner = _resolve_star_owner(view, by_id, stars)
        key = owner["name"] if owner else "__none__"
        cluster_members.setdefault(key, []).append(view)
        if owner and owner is not view:
            view["owner_star"] = owner["name"]

    star_radii: Dict[str, float] = {}
    secondary = stars[1:]
    if secondary:
        distances = [max(1.0, star["distance_ls"]) for star in secondary]
        min_distance, max_distance = min(distances), max(distances)
        min_step = max(8.0, (star_spread - primary_budget * 0.6) / (len(secondary) + 1))
        cursor = primary_budget * 0.6 + 10.0
        for index, star in enumerate(secondary):
            distance = max(1.0, star["distance_ls"])
            if scale_mode == "linear":
                target = cursor + (distance / max(1.0, max_distance)) * (star_spread - cursor)
            else:
                target = (primary_budget * 0.6
                          + _log_map(distance, min_distance, max_distance) * (star_spread - primary_budget * 0.6))
            radius = max(cursor, target, primary_budget * 0.6 + 12.0 + index * min_step * 0.15)
            star_radii[star["name"]] = radius
            cursor = radius + min_step * 0.5

    star_centers: Dict[str, Tuple[float, float, float]] = {}
    primary = stars[0] if stars else None
    if primary is not None:
        positions[primary["name"]] = (0.0, 0.0, 0.0)
        star_centers[primary["name"]] = (0.0, 0.0, 0.0)
    else:
        star_centers["__none__"] = (0.0, 0.0, 0.0)

    for index, star in enumerate(secondary):
        radius = star_radii.get(star["name"], SCENE_SPAN * 0.8)
        angle = index * GOLDEN_ANGLE
        inclination = ((-1.0) ** index) * math.radians(4.0 + (index * 7) % 12)
        center = (
            radius * math.cos(angle),
            radius * math.sin(angle) * math.cos(inclination),
            radius * math.sin(angle) * math.sin(inclination),
        )
        positions[star["name"]] = center
        star_centers[star["name"]] = center
        orbits.append({"owner": star["name"], "kind": "star", "radius": radius,
                       "center": (0.0, 0.0, 0.0), "angle": angle, "inc": inclination,
                       "points": ellipse_path(radius, (0.0, 0.0, 0.0), 0.0, inclination, 48)})

    for star in stars:
        center = star_centers.get(star["name"], (0.0, 0.0, 0.0))
        is_primary = primary is not None and primary["name"] == star["name"]
        own_budget = primary_budget if is_primary else max(
            14.0, min(SCENE_SPAN * 0.3, (star_radii.get(star["name"], SCENE_SPAN)) * 0.34))
        members = cluster_members.get(star["name"], [])
        own_planets = sorted((view for view in members if view["kind"] == "planet"),
                             key=lambda view: (view["orbit_ls"], view["name"]))
        radii = _distribute_radii(own_planets, own_budget, scale_mode)
        for index, view in enumerate(own_planets):
            radius = radii[index] if index < len(radii) else own_budget * 0.5
            angle = (index * GOLDEN_ANGLE) % (2.0 * math.pi)
            inclination = math.radians(((-1.0) ** index) * (2.5 + (index * 5) % 9))
            point = (
                center[0] + radius * math.cos(angle),
                center[1] + radius * math.sin(angle) * math.cos(inclination),
                center[2] + radius * math.sin(angle) * math.sin(inclination),
            )
            positions[view["name"]] = point
            orbit_info[view["name"]] = {"radius": radius, "center": center, "angle": angle,
                                        "inc": inclination, "kind": "planet", "star": star["name"]}
            orbits.append({"owner": star["name"], "kind": "planet", "name": view["name"],
                           "radius": radius, "center": center, "angle": angle, "inc": inclination,
                           "points": ellipse_path(radius, center, 0.0, inclination, 48 if crowded else 72)})
            for ring_index, ring in enumerate(view["rings"]):
                ring_radius = min(own_budget * 0.18, max(2.6, markers.get(view["name"], 8.0) * 0.42)) + ring_index * 2.4
                ring_paths.append({"owner": view["name"], "name": ring["name"], "class": ring["class"],
                                   "radius": ring_radius, "center": point, "angle": angle, "inc": inclination,
                                   "points": ellipse_path(ring_radius, point, 0.0, inclination, 40)})

        member_moons = [view for view in members if view["kind"] == "moon"]
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for moon in member_moons:
            parent_id = next((pid for pid in moon["parent_ids"]
                              if pid in by_id and by_id[pid]["kind"] == "planet"), None)
            parent = by_id.get(parent_id) if parent_id is not None else _parent_by_name(moon, own_planets)
            key = parent["name"] if parent else star["name"]
            grouped.setdefault(key, []).append(moon)
        for parent_name, group in grouped.items():
            parent_point = positions.get(parent_name, center)
            parent_size = markers.get(parent_name, 6.0)
            base_radius = max(3.2, parent_size * 0.55)
            group.sort(key=lambda view: (view["orbit_ls"], view["name"]))
            for index, moon in enumerate(group):
                radius = base_radius + 1.8 + index * max(1.6, base_radius * 0.45)
                angle = (index * 2.1 + 0.6) % (2.0 * math.pi)
                inclination = math.radians(((-1.0) ** index) * 4.0)
                point = (
                    parent_point[0] + radius * math.cos(angle),
                    parent_point[1] + radius * math.sin(angle) * math.cos(inclination),
                    parent_point[2] + radius * math.sin(angle) * math.sin(inclination),
                )
                positions[moon["name"]] = point
                orbit_info[moon["name"]] = {"radius": radius, "center": parent_point, "angle": angle,
                                            "inc": inclination, "kind": "moon", "star": star["name"],
                                            "parent": parent_name}
                if show_moons:
                    moon_orbits.append({"owner": parent_name, "name": moon["name"], "radius": radius,
                                        "center": parent_point, "angle": angle, "inc": inclination,
                                        "points": ellipse_path(radius, parent_point, 0.0, inclination, 32)})

        inner_ls, outer_ls = habitable_zone_ls(star)
        mapped_radius = _map_ls_to_units(inner_ls, outer_ls, own_planets, radii, own_budget, scale_mode)
        if mapped_radius > 0:
            hz_paths.append({"owner": star["name"], "radius": mapped_radius, "center": center,
                             "angle": 0.0, "inc": 0.0, "inner_ls": inner_ls, "outer_ls": outer_ls,
                             "points": ellipse_path(mapped_radius, center, 0.0, 0.0, 64)})

        clusters.append({
            "star": star["name"],
            "center": center,
            "budget": own_budget,
            "bodies": [view["name"] for view in own_planets] + [view["name"] for view in member_moons],
            "index": stars.index(star),
        })

    if not stars:
        ordered = sorted(planets, key=lambda view: (view["orbit_ls"], view["name"]))
        radii = _distribute_radii(ordered, SCENE_SPAN, scale_mode)
        for index, view in enumerate(ordered):
            radius = radii[index] if index < len(radii) else SCENE_SPAN * 0.5
            angle = (index * GOLDEN_ANGLE) % (2.0 * math.pi)
            point = (radius * math.cos(angle), radius * math.sin(angle), 0.0)
            positions[view["name"]] = point
            orbits.append({"owner": "", "kind": "planet", "name": view["name"], "radius": radius,
                           "center": (0.0, 0.0, 0.0), "angle": angle, "inc": 0.0,
                           "points": ellipse_path(radius, (0.0, 0.0, 0.0))})
        clusters.append({"star": "", "center": (0.0, 0.0, 0.0), "budget": SCENE_SPAN,
                         "bodies": [view["name"] for view in ordered], "index": 0})

    return {
        "bodies": views,
        "by_name": by_name,
        "orbit_info": orbit_info,
        "stars": stars,
        "clusters": clusters,
        "positions": positions,
        "markers": markers,
        "orbits": orbits,
        "moon_orbits": moon_orbits,
        "ring_paths": ring_paths,
        "hz_paths": hz_paths,
        "span": SCENE_SPAN,
        "crowded": crowded,
        "label_mode": "focused" if crowded else "all",
        "system": system_name,
    }


def _parent_by_name(moon: Dict[str, Any], planets: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    best: Optional[Dict[str, Any]] = None
    for planet in planets:
        if moon["name"].startswith(planet["name"]) and (best is None or len(planet["name"]) > len(best["name"])):
            best = planet
    return best


def _distribute_radii(bodies: Sequence[Dict[str, Any]], budget: float, scale_mode: str) -> List[float]:
    """Лог-раскладка орбит внутри бюджета кластера с гарантированным шагом."""
    if not bodies:
        return []
    inner = min(10.0, budget * 0.18)
    outer = budget
    if len(bodies) == 1:
        return [(inner + outer) / 2.0]
    distances = [max(0.1, view["orbit_ls"] or view["distance_ls"]) for view in bodies]
    low, high = min(distances), max(distances)
    min_step = max(2.2, (outer - inner) / (len(bodies) * 1.9))
    radii: List[float] = []
    cursor = inner
    for view in bodies:
        distance = max(0.1, view["orbit_ls"] or view["distance_ls"])
        if scale_mode == "linear":
            fraction = (distance - low) / max(1e-6, high - low)
        else:
            fraction = _log_map(distance, low, high)
        target = max(cursor, inner + fraction * (outer - inner))
        radii.append(target)
        cursor = target + min_step
    overflow = radii[-1] - outer
    if overflow > 0:
        scale = (outer - inner) / max(1.0, radii[-1] - inner)
        return [inner + (radius - inner) * min(1.0, scale) for radius in radii]
    return radii


def _map_ls_to_units(inner_ls: float, outer_ls: float, bodies: Sequence[Dict[str, Any]],
                     radii: Sequence[float], budget: float, scale_mode: str) -> float:
    if not bodies or not radii:
        return 0.0
    mid = (inner_ls + outer_ls) / 2.0
    distances = [max(0.1, view["orbit_ls"] or view["distance_ls"]) for view in bodies]
    low, high = min(distances), max(distances)
    if mid >= high:
        return budget
    if mid <= low:
        return radii[0] * 0.8
    if scale_mode == "linear":
        fraction = (mid - low) / max(1e-6, high - low)
    else:
        fraction = _log_map(mid, low, high)
    index = int(min(len(radii) - 1, max(0, round(fraction * (len(radii) - 1)))))
    return radii[index]


# ---------------------------------------------------------------------------
#  Постройки: наземные — на лимбе тела, орбитальные — кольцом
# ---------------------------------------------------------------------------
def place_stations(plan: Dict[str, Any], stations: Iterable[Dict[str, Any]],
                   half_span: float, canvas_px: float = CANVAS_PX,
                   sphere_radii: Optional[Dict[str, float]] = None) -> List[Dict[str, Any]]:
    """Развесить станции/стройки.

    Каждая запись `stations` — dict c `body_name`, `index`, `total` и прочими
    полями; сюда её передаёт `plotly_map`, а в HTML-экспорте та же логика
    продублирована на JS, чтобы при зуме постройки оставались на поверхности.
    """
    sphere_radii = sphere_radii or {}
    positions = plan["positions"]
    markers = plan["markers"]
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    orphans: List[Dict[str, Any]] = []
    for station in stations or []:
        anchor = str(station.get("body_name") or "")
        if anchor not in positions:
            anchor = _match_body(plan, anchor) or ""
        if not anchor:
            orphans.append(station)
            continue
        grouped.setdefault(anchor, []).append(station)

    placed: List[Dict[str, Any]] = []
    for anchor, group in grouped.items():
        center = positions.get(anchor, (0.0, 0.0, 0.0))
        body = plan["by_name"].get(anchor)
        on_surface = bool(body) and body.get("kind") != "star"
        sphere = sphere_radii.get(anchor)
        lift = body_display_radius_units(markers, anchor, half_span, canvas_px) + 0.35
        for index, station in enumerate(group):
            if sphere:
                position = on_sphere(center, sphere * 1.03, index, len(group))
            else:
                angle = math.pi / 2 if len(group) == 1 else math.pi / 2 + 2.0 * math.pi * index / len(group)
                position = (
                    center[0] + lift * math.cos(angle) * 0.35,
                    center[1] + lift * math.sin(angle) * 0.35,
                    center[2] + lift,
                )
            placed.append({**station, "anchor": anchor, "position": position,
                           "center": center, "on_surface": on_surface, "index": index, "total": len(group)})
    for index, station in enumerate(orphans):
        angle = index * GOLDEN_ANGLE
        radius = 16.0 + index * 4.0
        placed.append({**station, "anchor": None,
                       "position": (radius * math.cos(angle), radius * math.sin(angle), 2.0),
                       "center": (0.0, 0.0, 0.0), "on_surface": False, "index": index, "total": len(orphans)})
    return placed


def on_sphere(center: Sequence[float], radius: float, index: int, total: int) -> Tuple[float, float, float]:
    """Точка на сфере (золотая спираль) — постройки не слипаются в одну кучу."""
    count = max(1, int(total))
    y = 0.45 if count == 1 else 1.0 - (2.0 * (index + 0.5)) / count
    ring_radius = math.sqrt(max(0.0, 1.0 - y * y))
    theta = (index + 1) * GOLDEN_ANGLE
    cx, cy, cz = (list(center) + [0.0, 0.0, 0.0])[:3]
    return (cx + radius * ring_radius * math.cos(theta),
            cy + radius * ring_radius * math.sin(theta),
            cz + radius * y)


def body_sphere_radius_units(half_span: float, fraction: float) -> float:
    """Радиус «символической» сферы тела в unit'ах сцены при фокусе."""
    return max(0.5, half_span * fraction)


def _match_body(plan: Dict[str, Any], name: str) -> Optional[str]:
    """Найти тело по «свободному» имени — Raven шлёт «HD 183092 B 5» без системы."""
    target = str(name or "").strip().lower()
    if not target:
        return None
    positions = plan["positions"]
    if target in positions:
        return target
    for key in positions:
        if key.lower() == target:
            return key
    candidates = sorted(
        (key for key in positions
         if key.lower().endswith(target) or target.endswith(key.lower())
         or target in key.lower() or key.lower() in target),
        key=len,
    )
    return candidates[0] if candidates else None


# ---------------------------------------------------------------------------
#  Фокус / приближение
# ---------------------------------------------------------------------------
def focus_view(plan: Dict[str, Any], target: str, zoom: int,
               canvas_px: float = CANVAS_PX) -> Optional[Dict[str, Any]]:
    """Центр, разрез осей и дистанция камеры для фокуса на объекте.

    `zoom`: 0 — вся система, 1 — кластер звезды, 2 — окрестности тела,
    3 — тело крупно (видно, что постройки стоят на поверхности).
    """
    positions = plan["positions"]
    point = positions.get(target)
    if point is None:
        return None
    markers = plan["markers"]
    span = plan["span"]
    cluster = next((row for row in plan["clusters"]
                    if row["star"] == target or target in row["bodies"]), None)
    size_units = body_display_radius_units(markers, target, span, canvas_px)

    if zoom <= 0:
        # «Обзор с целью»: камера смотрит на цель, но размах осей растёт так,
        # чтобы система не вылезла за кадр.
        pad = max(abs(point[0]), abs(point[1]), abs(point[2]))
        return {"target": target, "center": point, "half_span": span + pad,
                "eye": 1.65, "cluster": cluster["star"] if cluster else None}
    if zoom == 1:
        center = cluster["center"] if cluster else (0.0, 0.0, 0.0)
        extent = 0.0
        for name in (cluster["bodies"] if cluster else []):
            member = positions.get(name)
            if not member:
                continue
            extent = max(extent, math.dist(member, center))
        half_span = max(min(span * 0.94, extent * 1.08 + 4.0), size_units * 6.0)
        return {"target": target, "center": center, "half_span": half_span,
                "eye": 1.2, "cluster": cluster["star"] if cluster else None}
    if zoom == 2:
        nearest = _nearest_distance(plan, target)
        half_span = max(size_units * 5.0, min(span * 0.35, nearest * 1.35))
        return {"target": target, "center": point, "half_span": half_span,
                "eye": 0.9, "cluster": cluster["star"] if cluster else None}
    return {"target": target, "center": point, "half_span": max(size_units * 1.9, 3.2),
            "eye": 0.72, "cluster": cluster["star"] if cluster else None}


def _nearest_distance(plan: Dict[str, Any], target: str) -> float:
    point = plan["positions"].get(target)
    if point is None:
        return plan["span"]
    best = float("inf")
    for name, other in plan["positions"].items():
        if name == target:
            continue
        distance = math.dist(point, other)
        if distance > 1e-4 and distance < best:
            best = distance
    return best if math.isfinite(best) else plan["span"] * 0.2


def neighbours_of(plan: Dict[str, Any], target: str, limit: int = 5) -> List[str]:
    """Соседние тела той же системы (звёзды не в счёт — у них свой переключатель)."""
    point = plan["positions"].get(target)
    if point is None:
        return []
    stars = {star["name"] for star in plan["stars"]}
    scored = []
    for name, other in plan["positions"].items():
        if name == target or name in stars:
            continue
        scored.append((math.dist(point, other), name))
    scored.sort()
    return [name for _distance, name in scored[:max(1, limit)]]


def summarize_plan(plan: Dict[str, Any], stations: Sequence[Dict[str, Any]] = ()) -> Dict[str, Any]:
    """Сводка для заголовка карты и карточек."""
    bodies = plan["bodies"]
    sites = [station for station in stations or () if station.get("is_site")]
    return {
        "stars": len(plan["stars"]),
        "planets": len([body for body in bodies if body["kind"] == "planet"]),
        "moons": len([body for body in bodies if body["kind"] == "moon"]),
        "landable": len([body for body in bodies if body["landable"]]),
        "bio_bodies": len([body for body in bodies if body["bio_signals"] > 0]),
        "bio_signals": int(sum(body["bio_signals"] for body in bodies)),
        "ringed": len([body for body in bodies if body["rings"]]),
        "structures": len(stations or ()),
        "active_sites": len([station for station in sites if not station.get("complete")]),
    }
