"""Интерактивная 3D/2D визуализация карты звездной системы с помощью Plotly.

Предоставляет функции построения интерактивной модели звездной системы (Orrery),
включая:
- Звёзды (спектральные классы, размеры, светимость)
- Обитаемую зону звезды (Goldilocks Zone)
- Планетарные астероидные кольца (Icy, Metallic, Metal-Rich, Rocky)
- Орбиты небесных тел (с учетом эксцентриситета и наклонения)
- Планеты всех классов (ELW, WW, AW, HMC, газовые гиганты и т.д.)
- Луны с орбитами вокруг родительских планет
- Станции, аванпосты, поселения и мегакорабли
- Колонизационные стройплощадки с прогресс-барами и списком требуемых ресурсов
- Авианосцы (Fleet Carriers)
- Захват цели (Target Lock) и центрирование камеры на выбранном объекте
- Маркер положения пилота («Вы здесь» / CMDR)
- Богатые интерактивные карточки при наведении (hovertemplate)
- Переключение видов камеры (3D Orrery, вид сверху 2D, вид сбоку)
- Поддержка как 3D, так и 2D режима отображения
- Автономный экспорт в HTML (CDN или локальный bundle) и открытие в браузере
"""

import json
import math
import os
import sys
import tempfile
import webbrowser
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

try:
    import plotly.graph_objects as go
    import plotly.offline as po
    HAS_PLOTLY = True
except ImportError:
    go = None
    po = None
    HAS_PLOTLY = False

import orrery
from system_map import (
    BODY_COLORS,
    KIND_MOON,
    KIND_PLANET,
    KIND_STAR,
    KIND_UNKNOWN,
    STATION_CARRIER,
    STATION_INSTALLATION,
    STATION_LABELS,
    STATION_MEGASHIP,
    STATION_OTHER,
    STATION_OUTPOST,
    STATION_PORT,
    STATION_PRIMARY_PORT,
    STATION_SETTLEMENT,
    STATION_SITE,
    MapBody,
    MapSnapshot,
    MapStation,
    PlayerPosition,
    body_color,
    commodity_label,
    due_note,
    map_summary,
    station_color,
)

# ---------------------------------------------------------------------------
# Цветовая палитра Elite Dangerous Orrery
# ---------------------------------------------------------------------------
ED_BG_CANVAS = "#07090e"
ED_BG_PAPER = "#0b0e14"
ED_COLOR_GRID = "#15202e"
ED_COLOR_ORBIT_DEFAULT = "rgba(70, 105, 145, 0.45)"
ED_COLOR_ORBIT_MOON = "rgba(100, 130, 165, 0.35)"
ED_COLOR_STAR_DEFAULT = "#ffd166"
ED_COLOR_PLAYER = "#00f3ff"
ED_COLOR_SITE = "#ff8800"
ED_COLOR_SITE_DONE = "#2ecc71"
ED_COLOR_LANDABLE = "#00f3ff"
ED_COLOR_BIO = "#00ff88"
ED_COLOR_HABITABLE_ZONE = "rgba(46, 204, 113, 0.40)"

#: Цвета звезд по спектральному типу
STAR_SPECTRAL_COLORS: Dict[str, str] = {
    "O": "#9bb0ff",
    "B": "#bbccff",
    "A": "#f8f9fa",
    "F": "#fff4e8",
    "G": "#ffd166",
    "K": "#ff9e42",
    "M": "#ff5533",
    "L": "#b8432a",
    "T": "#8b2a1a",
    "Y": "#5c1b12",
    "TTS": "#ff8844",
    "AeBe": "#ccccff",
    "W": "#66aaff",
    "WN": "#5599ff",
    "WNC": "#4488ff",
    "WC": "#3377ff",
    "WO": "#2266ff",
    "CS": "#ff6644",
    "C": "#ff4422",
    "CN": "#ff3311",
    "CJ": "#ff2200",
    "CH": "#ff4433",
    "CHd": "#ff5544",
    "MS": "#ff7755",
    "S": "#ff6633",
    "D": "#d8f0ff",
    "DA": "#d8f0ff",
    "DAB": "#d8f0ff",
    "DAO": "#d8f0ff",
    "DAZ": "#d8f0ff",
    "DAV": "#d8f0ff",
    "DB": "#d8f0ff",
    "DBZ": "#d8f0ff",
    "DBV": "#d8f0ff",
    "DO": "#d8f0ff",
    "DOV": "#d8f0ff",
    "DQ": "#d8f0ff",
    "DC": "#d8f0ff",
    "DCV": "#d8f0ff",
    "DX": "#d8f0ff",
    "N": "#00d4ff",
    "Neutron": "#00d4ff",
    "H": "#4a0e4e",
    "Black Hole": "#4a0e4e",
    "X": "#ff007f",
    "SupermassiveBlackHole": "#2d004d",
}

#: Цвета колец планет
RING_CLASS_COLORS: Dict[str, str] = {
    "icy": "rgba(159, 216, 239, 0.75)",
    "metal": "rgba(241, 196, 15, 0.8)",
    "rich": "rgba(230, 126, 34, 0.8)",
    "rocky": "rgba(160, 140, 125, 0.75)",
    "default": "rgba(180, 200, 220, 0.7)",
}


def get_ring_color(ring_class: str) -> str:
    """Вернуть цвет кольца по его типу."""
    low = (ring_class or "").lower()
    for key, col in RING_CLASS_COLORS.items():
        if key in low:
            return col
    return RING_CLASS_COLORS["default"]


def get_star_color(star_type: str, temp_k: float = 0.0) -> str:
    """Вернуть цвет звезды.

    Приоритет — настоящая температура поверхности (как на сайте): цвет
    считается по излучению абсолютно чёрного тела. Спектральный класс остаётся
    запасным вариантом для записей без температуры — иначе экспорт десктопа и
    3D-карта сайта показывали бы одну звезду разными цветами.
    """
    by_temperature = orrery.star_color_from_temperature(_as_float(temp_k, 0.0))
    if by_temperature:
        return by_temperature
    clean = (star_type or "").strip()
    if clean in STAR_SPECTRAL_COLORS:
        return STAR_SPECTRAL_COLORS[clean]
    for prefix, col in STAR_SPECTRAL_COLORS.items():
        if clean.upper().startswith(prefix.upper()):
            return col
    return ED_COLOR_STAR_DEFAULT


def format_distance(distance_ls: float) -> str:
    """Форматирование расстояния в св. сек и км/а.е."""
    d = max(0.0, float(distance_ls or 0.0))
    if d < 0.1:
        return f"{d * 299792.458:,.0f} км".replace(",", " ")
    if d < 1000:
        return f"{d:,.1f} св. с ({d * 299792.458:,.0f} км)".replace(",", " ")
    if d > 499.00478:
        au = d / 499.00478
        return f"{d:,.0f} св. с ({au:.2f} а.е.)".replace(",", " ")
    return f"{d:,.0f} св. с".replace(",", " ")


def format_radius(radius_m: float) -> str:
    """Форматирование радиуса тела."""
    r_km = (radius_m or 0.0) / 1000.0
    if r_km <= 0:
        return "—"
    if r_km >= 696340:
        sol_r = r_km / 696340.0
        return f"{sol_r:.2f} R☉ ({r_km:,.0f} км)".replace(",", " ")
    return f"{r_km:,.0f} км".replace(",", " ")


def format_temp(temp_k: float) -> str:
    """Форматирование температуры в Кельвинах и Цельсиях."""
    k = float(temp_k or 0.0)
    if k <= 0:
        return "—"
    c = k - 273.15
    return f"{k:,.0f} K ({c:+,.0f} °C)".replace(",", " ")


def build_progress_bar(progress_pct: float, length: int = 12) -> str:
    """Текстовый прогресс-бар для тултипа."""
    p = max(0.0, min(100.0, float(progress_pct or 0.0)))
    filled = int(round((p / 100.0) * length))
    empty = max(0, length - filled)
    return "█" * filled + "░" * empty + f" {p:.1f}%"


def estimate_habitable_zone_ls(star: Optional[MapBody]) -> Optional[Tuple[float, float]]:
    """Оценить границы обитаемой зоны (в св. секундах) вокруг главной звезды."""
    if star is None or not star.is_star:
        return None
    r_sol = max(1e-4, star.radius_m / 6.957e8) if star.radius_m > 0 else 1.0
    t_sol = max(1e-4, star.surface_temp_k / 5778.0) if star.surface_temp_k > 0 else 1.0
    lum = (r_sol ** 2) * (t_sol ** 4)
    if lum <= 0:
        return None
    sqrt_l = math.sqrt(lum)
    hz_inner_ls = max(1.0, 474.0 * sqrt_l)
    hz_outer_ls = max(hz_inner_ls + 5.0, 684.0 * sqrt_l)
    return (hz_inner_ls, hz_outer_ls)


def _as_float(value: Any, default: float = 0.0) -> float:
    """Число из чего угодно — MapBody/EDSM-словари приходят с полями разных типов."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(result) or math.isinf(result):
        return default
    return result


def short_label(name: str, system: str = "") -> str:
    """Сократить имя тела до «хвоста» после имени системы — подписи в картах
    длинных систем иначе не влезают."""
    text = str(name or "")
    prefix = str(system or "").strip()
    if prefix and text.lower().startswith(prefix.lower()):
        tail = text[len(prefix):].strip()
        if tail:
            return tail
    return text


def _ellipse_curve(a_units: float, center: Tuple[float, float, float], ecc: float,
                   inc_rad: float, arg_rad: float, theta: float, is_3d: bool,
                   steps: int = 72) -> Tuple[List[float], List[float], List[float]]:
    """Точки эллиптической орбиты в unit''ах сцены вокруг `center`."""
    ecc = max(0.0, min(0.65, float(ecc or 0.0)))
    a = max(0.5, float(a_units))
    xs: List[float] = []
    ys: List[float] = []
    zs: List[float] = []
    for step in range(steps + 1):
        phi = 2 * math.pi * step / steps
        r_focal = (a * (1.0 - ecc * ecc)) / (1.0 + ecc * math.cos(phi - arg_rad))
        x_local = r_focal * math.cos(phi)
        y_local = r_focal * math.sin(phi)
        xs.append(center[0] + x_local)
        ys.append(center[1] + (y_local * math.cos(inc_rad) if is_3d else y_local))
        zs.append(center[2] + (y_local * math.sin(inc_rad) if is_3d else 0.0))
    return xs, ys, zs


def _orbit_scale(a_plan: float, ecc: float, theta: float, arg_rad: float) -> float:
    """Полуось кривой, при которой эллипс проходит через точку из плана.

    `orrery.plan_system` раскладывает тела по окружности радиуса `a_plan` — из
    этой же точки считаются фокус, подписи и плэйсменты построек (и на сайте, и
    здесь). Кривую орбиты приложение рисует реальным эллипсом, и без пересчёта
    маркер съезжал с нарисованной орбиты на величину ~e·a, а окно фокуса
    центрировалось не на теле: «при фокусе камера улетает в никуда».
    """
    ecc = max(0.0, min(0.65, float(ecc or 0.0)))
    base = max(0.5, float(a_plan))
    if ecc <= 1e-9:
        return base
    return base * (1.0 + ecc * math.cos(theta - arg_rad)) / (1.0 - ecc * ecc)


def normalize_view_mode(view_mode: Any) -> str:
    """Привести настройку вида карты к «3d» / «2d».

    И на сайте, и здесь «2D» — это только стартовая камера (вид сверху в
    ортографической проекции), а не отдельная плоская фигура: сцена всегда одна,
    поэтому переключить вид можно и внутри сохранённого HTML.
    """
    raw = str(view_mode or "3d").strip().lower()
    return "2d" if raw in ("2d", "2д", "top", "flat", "плоский", "сверху") else "3d"


def build_system_geometry(
    snapshot: MapSnapshot,
    scale_mode: str = "orrery",
    show_moons: bool = True,
    is_3d: bool = True,
    view_half_span: Optional[float] = None,
    canvas_px: float = orrery.CANVAS_PX,
    sphere_radii: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """Рассчитать координаты звёзд, планет, лун, колец, орбит и станций.

    Раскладку делает `orrery.plan_system` — тот же алгоритм, что и на сайте
    (`src/lib/systemOrrery.ts`): тела группируются по своей звезде, у каждой
    звезды свой бюджет радиуса, наземные постройки стоят на поверхности тела.
    """
    bodies = list(snapshot.bodies or [])
    stations = list(snapshot.stations or [])
    plan = orrery.plan_system(
        bodies,
        snapshot.system or "",
        scale_mode=scale_mode,
        show_moons=show_moons,
        extra_marks=len(stations),
    )

    primary_star = snapshot.star
    by_body = {body.name: body for body in bodies}
    stars = [body for body in bodies if body.kind == KIND_STAR]
    other_stars = [body for body in stars if primary_star is None or body.name != primary_star.name]
    planets = [body for body in bodies if body.kind == KIND_PLANET]
    moons = [body for body in bodies if body.kind == KIND_MOON] if show_moons else []
    planets.sort(key=lambda body: (body.orbit_ls or body.distance_ls, body.name))
    all_orbiters = list(planets) + list(other_stars)

    positions: Dict[str, Tuple[float, float, float]] = {}
    orbit_curves: Dict[str, Dict[str, Any]] = {}
    moon_orbit_curves: Dict[str, Dict[str, Any]] = {}
    body_rings: Dict[str, List[Dict[str, Any]]] = {}

    def flatten(point: Tuple[float, float, float]) -> Tuple[float, float, float]:
        if is_3d:
            return point
        return (point[0], point[1], 0.0)

    # Позиции тел — из плана кластеров.
    for name, point in plan["positions"].items():
        positions[name] = flatten(point)

    # Орбиты: кривая строится вокруг ЦЕНТРА КЛАСТЕРА своей звезды, с реальными
    # эксцентриситетом и наклонением, если они есть в данных.
    radius_by_body: Dict[str, float] = {}
    for orbit in plan["orbits"]:
        if orbit.get("kind") != "planet":
            continue
        name = orbit.get("name") or ""
        body = by_body.get(name)
        if body is None:
            continue
        ecc = float(body.eccentricity or 0.0)
        inc = math.radians(float(body.orbital_inclination or 0.0)) if is_3d else 0.0
        inc = inc or float(orbit.get("inc") or 0.0)
        arg = math.radians(float(body.arg_of_periapsis or 0.0))
        theta = float(orbit.get("angle") or 0.0)
        center = tuple(orbit["center"]) if is_3d else (orbit["center"][0], orbit["center"][1], 0.0)
        a_units = _orbit_scale(orbit["radius"], ecc, theta, arg)
        xs, ys, zs = _ellipse_curve(a_units, center, ecc, inc, arg, theta, is_3d,
                                    48 if plan["crowded"] else 72)
        orbit_curves[name] = {"x": xs, "y": ys, "z": zs, "inc_deg": math.degrees(inc), "ecc": ecc}
        # Маркер — ровно там, где его видит движок раскладки (и фокус, и JS в
        # HTML считают от той же точки); эллипс подстроён под неё выше.
        radius_by_body[name] = a_units
    for orbit in plan["orbits"]:
        if orbit.get("kind") != "star":
            continue
        name = orbit["owner"]
        body = by_body.get(name)
        ecc = float(getattr(body, "eccentricity", 0.0) or 0.0) if body else 0.0
        inc = float(orbit.get("inc") or 0.0)
        center = (0.0, 0.0, 0.0)
        star_theta = float(orbit.get("angle") or 0.0)
        xs, ys, zs = _ellipse_curve(_orbit_scale(orbit["radius"], ecc, star_theta, 0.0),
                                    center, ecc, inc, 0.0, star_theta, is_3d, 48)
        orbit_curves[f"__star__:{name}"] = {"x": xs, "y": ys, "z": zs, "inc_deg": math.degrees(inc), "ecc": ecc}
        if name in plan["positions"]:
            positions[name] = flatten(plan["positions"][name])

    # Луны — вокруг своей планеты.
    for orbit in plan["moon_orbits"]:
        name = orbit.get("name") or ""
        body = by_body.get(name)
        ecc = float(getattr(body, "eccentricity", 0.0) or 0.0) if body else 0.0
        inc = float(orbit.get("inc") or 0.0)
        center = tuple(orbit["center"]) if is_3d else (orbit["center"][0], orbit["center"][1], 0.0)
        theta = float(orbit.get("angle") or 0.0)
        xs, ys, zs = _ellipse_curve(_orbit_scale(orbit["radius"], ecc, theta, 0.0),
                                    center, ecc, inc, 0.0, theta, is_3d, 32)
        moon_orbit_curves[name] = {"x": xs, "y": ys, "z": zs}
        if name in plan["positions"]:
            positions[name] = flatten(plan["positions"][name])
        radius_by_body[name] = orbit["radius"]

    # Кольца планет.
    for ring_path in plan["ring_paths"]:
        owner = ring_path["owner"]
        entry = {
            "name": ring_path["name"],
            "class": ring_path["class"],
            "color": get_ring_color(ring_path["class"]),
            "inner_km": 0.0,
            "outer_km": 0.0,
            "x": [point[0] for point in ring_path["points"]],
            "y": [point[1] for point in ring_path["points"]],
            "z": [point[2] for point in ring_path["points"]] if is_3d else None,
        }
        body = by_body.get(owner)
        if body is not None and getattr(body, "rings", None):
            for raw in body.rings:
                if str(raw.get("Name") or raw.get("name") or "Кольцо") == ring_path["name"]:
                    entry["inner_km"] = _as_float(raw.get("InnerRad") or raw.get("innerRadiusKm") or 0.0) / 1000.0
                    entry["outer_km"] = _as_float(raw.get("OuterRad") or raw.get("outerRadiusKm") or 0.0) / 1000.0
                    break
        body_rings.setdefault(owner, []).append(entry)

    # Постройки: наземные — на визуальной поверхности тела, орбитальные — кольцом.
    half_span = float(view_half_span if view_half_span and view_half_span > 0 else plan["span"])
    station_payload: List[Dict[str, Any]] = []
    for station in stations:
        station_payload.append({
            "name": station.name or station.build_name,
            "body_name": station.body_name or "",
            "kind": station.kind,
            "is_site": bool(station.is_site),
            "complete": bool(station.complete),
        })
    placements = orrery.place_stations(plan, station_payload, half_span, canvas_px,
                                       sphere_radii=sphere_radii or {})
    station_positions: Dict[str, Tuple[float, float, float]] = {}
    for placement in placements:
        point = placement["position"]
        station_positions[str(placement["name"])] = flatten(point)

    # Позиция пилота («Вы здесь») — там, где нарисован соответствующий объект.
    player_pos: Optional[Tuple[float, float, float]] = None
    player = snapshot.player
    if player and player.system == snapshot.system:
        if player.station_name and player.station_name in station_positions:
            sx, sy, sz = station_positions[player.station_name]
            player_pos = (sx, sy, sz + (1.2 if is_3d else 0.0))
        elif player.body_name and player.body_name in positions:
            bx, by, bz = positions[player.body_name]
            player_pos = (bx, by + 1.2, bz + (1.2 if is_3d else 0.0))
        elif primary_star:
            player_pos = (0.0, 5.0, 2.0 if is_3d else 0.0)

    radii = list(radius_by_body.values()) or [24.0, 240.0]
    return {
        "positions": positions,
        "orbit_curves": orbit_curves,
        "moon_orbit_curves": moon_orbit_curves,
        "body_rings": body_rings,
        "station_positions": station_positions,
        "placements": placements,
        "player_pos": player_pos,
        "planets": planets,
        "moons": moons,
        "primary_star": primary_star,
        "other_stars": other_stars,
        "by_name": by_body,
        "r_min": min(radii),
        "r_max": max(radii),
        "all_orbiters": all_orbiters,
        # Новое: план кластеров, размеры маркеров (LOD) и обитаемые зоны по звёздам.
        "plan": plan,
        "markers": plan["markers"],
        "clusters": plan["clusters"],
        "hz_paths": plan["hz_paths"],
        "span": plan["span"],
        "crowded": plan["crowded"],
    }


def _build_body_hover(body: MapBody) -> str:
    """Сформировать HTML-карточку для тела."""
    lines = [f"<b>{body.name}</b>"]
    body_type_title = body.body_class or body.star_type or ("Звезда" if body.is_star else "Тело")
    lines.append(f"Класс: <b>{body_type_title}</b>")
    lines.append(f"Дистанция: {format_distance(body.distance_ls)}")

    if body.radius_m > 0:
        lines.append(f"Радиус: {format_radius(body.radius_m)}")
    if body.gravity > 0:
        lines.append(f"Гравитация: <b>{body.gravity:.2f} G</b>")
    if body.surface_temp_k > 0:
        lines.append(f"Температура: {format_temp(body.surface_temp_k)}")
    if body.atmosphere:
        lines.append(f"Атмосфера: {body.atmosphere}")
    if body.landable:
        lines.append("<span style='color:#00f3ff'>🛬 Пригодна для посадки</span>")
    elif not body.is_star:
        lines.append("<span style='color:#9ca3af'>Без посадки</span>")
    if body.terraformable:
        lines.append("<span style='color:#2ecc71'>🌱 Терраформируемая</span>")
    if body.bio_signals > 0:
        genus_str = f" ({', '.join(body.bio_genuses)})" if body.bio_genuses else ""
        lines.append(f"<span style='color:#00ff88'>🌿 Биосигналы: <b>{body.bio_signals}</b>{genus_str}</span>")
    if getattr(body, "rings", None):
        ring_parts = []
        for r in body.rings:
            rc = str(r.get("RingClass") or r.get("type") or "Icy").replace("eRingClass_", "")
            inner = float(r.get("InnerRad") or 0.0) / 1000.0
            outer = float(r.get("OuterRad") or 0.0) / 1000.0
            if inner > 0 and outer > 0:
                ring_parts.append(f"{rc} ({inner:,.0f}–{outer:,.0f} км)".replace(",", " "))
            else:
                ring_parts.append(rc)
        lines.append(f"💍 Кольца: <b>{', '.join(ring_parts)}</b>")
    if body.first_discovered_by:
        lines.append(f"<span style='color:#9ca3af'>Открыто: CMDR {body.first_discovered_by}</span>")
    if body.first_footfall_by:
        lines.append(f"<span style='color:#9ca3af'>Первопроходец: CMDR {body.first_footfall_by}</span>")
    return "<br>".join(lines)


def _build_station_hover(st: MapStation, on_surface: bool = False) -> str:
    """Сформировать HTML-карточку для станции/стройки."""
    title = st.build_name or st.name or "Объект"
    lines = [f"<b>{title}</b>"]
    kind_label = STATION_LABELS.get(st.kind, "станция")
    lines.append(f"Тип: <b>{st.build_type or st.station_type or kind_label}</b>")

    if st.body_name:
        where = "на поверхности" if on_surface else "на орбите"
        lines.append(f"{st.body_name} · {where}")

    if st.is_site:
        pct = st.percent_delivered if getattr(st, "percent_delivered", None) is not None else float(st.progress or 0.0)
        bar = build_progress_bar(pct)
        lines.append(f"Прогресс: <b>{bar}</b>")
        if st.required_tons > 0:
            lines.append(
                f"Доставка: <b>{st.provided_tons:,.0f} / {st.required_tons:,.0f} т</b> "
                f"(осталось {max(0, st.required_tons - st.provided_tons):,.0f} т)".replace(",", " ")
            )
        if st.remaining_by_commodity:
            lines.append("<b>Потребность по товарам:</b>")
            top_needed = sorted(st.remaining_by_commodity.items(), key=lambda kv: kv[1], reverse=True)[:5]
            for comm_key, amount in top_needed:
                lines.append(f" • {commodity_label(comm_key)}: {amount:,.0f} т".replace(",", " "))
            if len(st.remaining_by_commodity) > 5:
                extra = len(st.remaining_by_commodity) - 5
                lines.append(f" <i style='color:#9ca3af'>...и ещё {extra} поз.</i>")
        note = due_note(st.due_at)
        if note:
            lines.append(f"<span style='color:#f1c40f'>Срок: {note}</span>")
    elif st.kind == STATION_CARRIER:
        lines.append("<span style='color:#b39ddb'>🚀 Fleet Carrier</span>")

    return "<br>".join(lines)


def build_plotly_dict(
    snapshot: MapSnapshot,
    view_mode: str = "3d",
    scale_mode: str = "orrery",
    show_moons: bool = True,
    selected: str = "",
    title: Optional[str] = None,
    zoom: int = 0,
    show_all_labels: bool = False,
) -> Dict[str, Any]:
    """Сгенерировать структуру данных Plotly (data, layout, config) в виде dict.

    Поддерживает режимы '3d' (Orrery) и '2d' (плоская схема).

    `selected` + `zoom` (0…3) дают приближение: «система → кластер звезды →
    окрестности тела → тело крупно». Размах осей режется вокруг цели, поэтому
    камера действительно подлетает к планете, а постройки на её поверхности
    остаются на поверхности при любом зуме.
    """
    # Карта всегда строится как 3D-сцена — ровно так же, как на сайте
    # (`SystemPlotlyMap.tsx`). «2D» — это НЕ другой набор трасс, а камера сверху
    # с ортографической проекцией. Прежняя экономия (scatter + xaxis/yaxis без
    # scene) ломала саму идею: все кнопки вида в HTML пишут в `scene.*`, поэтому
    # в 2D-фигуре они молчали, и карта, открытая из приложения, намертво
    # оставалась плоской — «работает только в 2D режиме».
    # Геометрия всегда объёмная: `is_3d` оставлен, потому что им пользуется
    # `build_system_geometry` (и тесты плоской раскладки), но в этой карте он
    # всегда True — иначе «2D» снова превратился бы в отдельный недо-рендер.
    is_3d = True
    top_down = normalize_view_mode(view_mode) == "2d"
    trace_type = "scatter3d"
    zoom = max(0, min(3, int(zoom or 0)))

    plan_preview = orrery.plan_system(
        snapshot.bodies, snapshot.system or "", scale_mode=scale_mode,
        show_moons=show_moons, extra_marks=len(snapshot.stations or []),
    )
    focus = orrery.focus_view(plan_preview, selected, zoom) if selected else None
    half_span = float(focus["half_span"]) if focus else plan_preview["span"]

    # Сфера тела в фокусе (уровни «окрестности» и «поверхность») — как на сайте:
    # сама планета получает mesh3d-сферу с дымкой атмосферы, а наземные постройки
    # ставятся на её видимую поверхность. Без этого постройка в приближении
    # висела в пустоте рядом с точкой-маркером.
    sphere_radii: Dict[str, float] = {}
    detail_body = None
    if focus is not None and zoom >= 2 and selected:
        detail_body = next((b for b in (snapshot.bodies or []) if b.name == selected), None)
        # Уровень 2 не рисует оболочку вокруг центра кластера (обычно это звезда):
        # там фокус и так на самом теле, сфера только мешает (правило сайта).
        if zoom == 2 and focus.get("cluster") == selected:
            detail_body = None
        if detail_body is not None and detail_body.kind != KIND_STAR:
            sphere_radii[selected] = orrery.detail_sphere_radius_units(half_span, zoom)

    geom = build_system_geometry(
        snapshot,
        scale_mode=scale_mode,
        show_moons=show_moons,
        is_3d=is_3d,
        view_half_span=half_span,
        sphere_radii=sphere_radii,
    )
    markers = geom["markers"]
    crowded = bool(geom["crowded"])
    # Чем постройка связана с телом: «на поверхности» или «на орбите» — это
    # видно из плэйсментов, и то же самое подсказываем в hover'е и карточках.
    surface_flags = {str(item.get("name")): bool(item.get("on_surface")) for item in geom.get("placements", [])}
    # Подписи включаем только когда их количество не съедает карту: в плотной
    # системе или в сильном зуме подписываем лишь выбранную цель.
    label_all = show_all_labels or (not crowded and zoom < 2)
    positions = geom["positions"]
    orbit_curves = geom["orbit_curves"]
    moon_orbit_curves = geom["moon_orbit_curves"]
    body_rings = geom["body_rings"]
    station_positions = geom["station_positions"]
    player_pos = geom["player_pos"]
    planets = geom["planets"]
    moons = geom["moons"]
    primary_star = geom["primary_star"]
    other_stars = geom["other_stars"]
    r_min = geom["r_min"]
    r_max = geom["r_max"]
    all_orbiters = geom["all_orbiters"]

    data: List[Dict[str, Any]] = []

    # 1. Обитаемая зона — своя у каждой звезды (у многозвёздных систем их
    # несколько, и рисовать одну «на главную» было бы неправдой).
    hz_paths = geom.get("hz_paths") or []
    if hz_paths:
        hz_xs: List[Optional[float]] = []
        hz_ys: List[Optional[float]] = []
        hz_zs: List[Optional[float]] = []
        hz_notes: List[str] = []
        for path in hz_paths:
            note = (
                f"<b>🌱 Обитаемая зона {path['owner']}</b><br>"
                f"Диапазон: {path['inner_ls']:,.0f} — {path['outer_ls']:,.0f} св. с<br>"
                f"Зона жидкой воды и планет земного типа (ELW)"
            ).replace(",", " ")
            for point in path["points"]:
                hz_xs.append(point[0])
                hz_ys.append(point[1])
                hz_notes.append(note)
            hz_xs.append(None)
            hz_ys.append(None)
            hz_notes.append("")
            if is_3d:
                for point in path["points"]:
                    hz_zs.append(point[2])
                hz_zs.append(None)
        tr_hz: Dict[str, Any] = {
            "type": trace_type,
            "name": "🌱 Обитаемая зона",
            "x": hz_xs,
            "y": hz_ys,
            "mode": "lines",
            "line": {"color": ED_COLOR_HABITABLE_ZONE, "width": 2.2, "dash": "dash"},
            "hovertext": hz_notes,
            "hoverinfo": "text",
            "legendgroup": "habitable_zone",
            "showlegend": True,
        }
        if is_3d:
            tr_hz["z"] = hz_zs
        data.append(tr_hz)

    # 2. Линии орбит планет
    orb_x: List[Optional[float]] = []
    orb_y: List[Optional[float]] = []
    orb_z: List[Optional[float]] = []
    for curve in orbit_curves.values():
        orb_x.extend(curve["x"] + [None])
        orb_y.extend(curve["y"] + [None])
        if is_3d:
            orb_z.extend(curve["z"] + [None])

    if orb_x:
        tr: Dict[str, Any] = {
            "type": trace_type,
            "name": "Орбиты планет",
            "x": orb_x,
            "y": orb_y,
            "mode": "lines",
            "line": {"color": ED_COLOR_ORBIT_DEFAULT, "width": 2},
            "hoverinfo": "skip",
            "legendgroup": "orbits",
            "showlegend": True,
        }
        if is_3d:
            tr["z"] = orb_z
        data.append(tr)

    # 3. Линии орбит лун
    if show_moons and moon_orbit_curves:
        m_orb_x: List[Optional[float]] = []
        m_orb_y: List[Optional[float]] = []
        m_orb_z: List[Optional[float]] = []
        for curve in moon_orbit_curves.values():
            m_orb_x.extend(curve["x"] + [None])
            m_orb_y.extend(curve["y"] + [None])
            if is_3d:
                m_orb_z.extend(curve["z"] + [None])

        if m_orb_x:
            tr_m: Dict[str, Any] = {
                "type": trace_type,
                "name": "Орбиты лун",
                "x": m_orb_x,
                "y": m_orb_y,
                "mode": "lines",
                "line": {"color": ED_COLOR_ORBIT_MOON, "width": 1.5, "dash": "dot"},
                "hoverinfo": "skip",
                "legendgroup": "moon_orbits",
                "showlegend": True,
            }
            if is_3d:
                tr_m["z"] = m_orb_z
            data.append(tr_m)

    # 4. Кольца планет
    if body_rings:
        ring_xs: List[Optional[float]] = []
        ring_ys: List[Optional[float]] = []
        ring_zs: List[Optional[float]] = []
        for body_ring_list in body_rings.values():
            for r_entry in body_ring_list:
                ring_xs.extend(r_entry["x"] + [None])
                ring_ys.extend(r_entry["y"] + [None])
                if is_3d and r_entry["z"] is not None:
                    ring_zs.extend(r_entry["z"] + [None])
        if ring_xs:
            tr_rings: Dict[str, Any] = {
                "type": trace_type,
                "name": "💍 Кольца планет",
                "x": ring_xs,
                "y": ring_ys,
                "mode": "lines",
                "line": {"color": "rgba(159, 216, 239, 0.75)", "width": 2.5},
                "hoverinfo": "skip",
                "legendgroup": "rings",
                "showlegend": True,
            }
            if is_3d:
                tr_rings["z"] = ring_zs
            data.append(tr_rings)

    # 5. Основная звезда системы
    if primary_star:
        p_color = get_star_color(primary_star.star_type, primary_star.surface_temp_k)
        m_size = markers.get(primary_star.name, 20.0) * (1.25 if selected == primary_star.name or zoom >= 3 else 1.0)
        tr_star: Dict[str, Any] = {
            "type": trace_type,
            "name": "Главная звезда",
            "x": [0.0],
            "y": [0.0],
            "mode": "markers+text",
            "marker": {
                "size": m_size,
                "color": p_color,
                "line": {"color": "#ffffff", "width": 1.5},
                "opacity": 0.98,
            },
            "text": [primary_star.name if (label_all or not crowded) else ""],
            "textposition": "top center",
            "textfont": {"color": "#f1c40f", "size": 11, "family": "Segoe UI, Arial"},
            "customdata": [primary_star.name],
            "hovertext": [_build_body_hover(primary_star)],
            "hoverinfo": "text",
            "legendgroup": "stars",
            "showlegend": True,
            "meta": "body",
        }
        if is_3d:
            tr_star["z"] = [0.0]
        data.append(tr_star)
    elif "__center__" in positions:
        # Звезда не отсканирована
        tr_center: Dict[str, Any] = {
            "type": trace_type,
            "name": "Центр системы",
            "x": [0.0],
            "y": [0.0],
            "mode": "markers+text",
            "marker": {
                "size": 10,
                "color": "#555555",
                "line": {"color": "#888888", "width": 1},
            },
            "text": ["(Звезда не отсканирована)"],
            "textposition": "top center",
            "textfont": {"color": "#888888", "size": 10},
            "hovertext": ["<b>Центр системы</b><br>Звезда не отсканирована"],
            "hoverinfo": "text",
            "legendgroup": "stars",
            "showlegend": True,
        }
        if is_3d:
            tr_center["z"] = [0.0]
        data.append(tr_center)

    # 6. Вторичные звёзды
    if other_stars:
        s_xs, s_ys, s_zs, s_texts, s_hovers, s_colors, s_sizes, s_custom = [], [], [], [], [], [], [], []
        for star in other_stars:
            if star.name in positions:
                x, y, z = positions[star.name]
                s_xs.append(x)
                s_ys.append(y)
                if is_3d:
                    s_zs.append(z)
                # Десятки звёзд: подписи только у выбранной, иначе легенда
                # превращается в простыню, а карточки — в кашу.
                is_target = bool(selected) and selected == star.name
                s_texts.append(short_label(star.name, snapshot.system) if (label_all or is_target) else "")
                s_hovers.append(_build_body_hover(star))
                s_colors.append(get_star_color(star.star_type, star.surface_temp_k))
                s_sizes.append(markers.get(star.name, 13.0) * (1.2 if is_target else 1.0))
                s_custom.append(star.name)
        if s_xs:
            tr_s: Dict[str, Any] = {
                "type": trace_type,
                "name": f"Вторичные звёзды ({len(s_xs)})",
                "x": s_xs,
                "y": s_ys,
                "mode": "markers+text",
                "marker": {
                    "size": s_sizes,
                    "color": s_colors,
                    "line": {"color": "#ffd166", "width": 1.2},
                    "opacity": 0.95,
                },
                "text": s_texts,
                "textposition": "top center",
                "textfont": {"color": "#ffd166", "size": 9},
                "customdata": s_custom,
                "hovertext": s_hovers,
                "hoverinfo": "text",
                "legendgroup": "stars",
                "showlegend": True,
                "meta": "body",
            }
            if is_3d:
                tr_s["z"] = s_zs
            data.append(tr_s)

    # 7. Планеты и луны: размеры из LOD-таблицы, подписи — только когда они
    # не мешают (плотная система или мелкий зум → подписи прячутся).

    def _body_trace(body_list, name, line_fallback, text_color, font_size, symbol="circle"):
        xs, ys, zs, texts, hovers, colors, sizes, customs, line_colors = [], [], [], [], [], [], [], [], []
        for body in body_list:
            point = positions.get(body.name)
            if point is None:
                continue
            x, y, z = point
            xs.append(x)
            ys.append(y)
            if is_3d:
                zs.append(z)
            is_target = bool(selected) and selected == body.name
            sizes.append((markers.get(body.name, 7.0)) * (1.25 if (is_target or zoom >= 3) else 1.0))
            texts.append(short_label(body.name, snapshot.system) if (label_all or is_target) else "")
            hovers.append(_build_body_hover(body))
            colors.append(body_color(body))
            if is_target:
                line_colors.append("#00f3ff")
            elif body.landable:
                line_colors.append(ED_COLOR_LANDABLE)
            elif getattr(body, "bio_signals", 0):
                line_colors.append(ED_COLOR_BIO)
            else:
                line_colors.append(line_fallback)
            customs.append(body.name)
        if not xs:
            return None
        trace: Dict[str, Any] = {
            "type": trace_type,
            "name": name,
            "x": xs,
            "y": ys,
            "mode": "markers+text",
            "marker": {
                "size": sizes,
                "color": colors,
                "symbol": symbol,
                "line": {"color": line_colors, "width": 1.1 if selected else 0.8},
                "opacity": 0.94,
            },
            "text": texts,
            "textposition": "top center",
            "textfont": {"color": text_color, "size": 10 if zoom >= 2 else 9},
            "customdata": customs,
            "hovertext": hovers,
            "hoverinfo": "text",
            "legendgroup": name,
            "showlegend": True,
            "meta": "body",
        }
        if is_3d:
            trace["z"] = zs
        return trace

    tr_planets = _body_trace(planets, "Планеты", "#1e293b", "#e2e8f0", 9)
    if tr_planets:
        data.append(tr_planets)

    if show_moons and moons:
        tr_moons = _body_trace(moons, "Луны", "#334155", "#94a3b8", 8, "circle-dot")
        if tr_moons:
            data.append(tr_moons)

    # 9/10/11. Постройки: стройплощадки, станции и порты, авианосцы.
    #
    # Иконки уменьшены (11/9/9 → 5.5/5/5.5 px) и подписываются только у
    # выбранной цели или в зуме «поверхность»: в системе с десятками объектов
    # подписи строек закрывали орбиты.
    def _station_trace(station_list, name, symbol, color, base_size, text_color, font_size, surface_default,
                       symbol_emoji="🛰", color_for=None):
        xs, ys, zs, texts, hovers, colors, sizes, customs, anchors = [], [], [], [], [], [], [], [], []
        link_x, link_y, link_z = [], [], []
        for station in station_list:
            key = station.name or station.build_name
            if key not in station_positions:
                continue
            x, y, z = station_positions[key]
            xs.append(x)
            ys.append(y)
            if is_3d:
                zs.append(z)
            on_surface = surface_flags.get(str(key), surface_default)
            percent = (station.percent_delivered
                       if getattr(station, "percent_delivered", None) is not None else station.progress)
            pct_str = f" [{percent:.0f}%]" if percent is not None else ""
            is_target = bool(selected) and selected in (key, station.body_name, station.build_name, station.build_id)
            texts.append(f"{symbol_emoji} {short_label(key, snapshot.system)}{pct_str}"
                         if (is_target or zoom >= 3 or label_all) else "")
            hovers.append(_build_station_hover(station, on_surface=on_surface))
            colors.append(color_for(station) if color_for else color)
            sizes.append(base_size * (1.6 if is_target else 1.0))
            customs.append([str(key), station.body_name or ""])
            anchors.append(on_surface)
            anchor_point = positions.get(station.body_name or "")
            if is_target and anchor_point:
                link_x.extend([anchor_point[0], x, None])
                link_y.extend([anchor_point[1], y, None])
                link_z.extend([anchor_point[2], z, None])
        if not xs:
            return None
        trace: Dict[str, Any] = {
            "type": trace_type,
            "name": name,
            "x": xs,
            "y": ys,
            "mode": "markers+text",
            "marker": {
                "size": sizes,
                "symbol": symbol,
                "color": colors,
                "line": {"color": "#0b0e14", "width": 0.6},
                "opacity": 1.0,
            },
            "text": texts,
            "textposition": "bottom center",
            "textfont": {"color": text_color, "size": font_size, "family": "Consolas, Segoe UI"},
            "customdata": customs,
            "hovertext": hovers,
            "hoverinfo": "text",
            "legendgroup": name,
            "showlegend": True,
            "meta": "site",
        }
        if is_3d:
            trace["z"] = zs
        lines = None
        if link_x:
            lines = {
                "type": trace_type,
                "name": "связь постройка ↔ тело",
                "x": link_x,
                "y": link_y,
                "mode": "lines",
                "line": {"color": "rgba(255, 159, 67, 0.6)", "width": 1.2, "dash": "dot"},
                "hoverinfo": "skip",
                "legendgroup": name,
                "showlegend": False,
            }
            if is_3d:
                lines["z"] = link_z
        return trace, lines

    sites = [station for station in snapshot.stations if station.is_site]

    def color_for(station):
        percent = station.percent_delivered
        if percent is None and station.progress is not None:
            percent = float(station.progress)
        if percent is not None and percent >= 100:
            return ED_COLOR_SITE_DONE
        return ED_COLOR_SITE

    built = _station_trace(sites, "Стройплощадки", "diamond", ED_COLOR_SITE, 5.5, "#ff9f43", 9, True,
                           symbol_emoji="🏗", color_for=color_for)
    if built:
        if isinstance(built, tuple):
            data.extend([item for item in built if item])
        else:
            data.append(built)

    def color_for_station(station):
        return station_color(station)

    regular_stations = [station for station in snapshot.stations if not station.is_site and station.kind != STATION_CARRIER]
    carriers = [station for station in snapshot.stations if station.kind == STATION_CARRIER]

    def _append_station_trace(trace):
        if not trace:
            return
        if isinstance(trace, tuple):
            data.extend([item for item in trace if item])
        else:
            data.append(trace)

    _append_station_trace(_station_trace(regular_stations, "Станции и порты", "diamond", "#3498db", 5.0, "#38bdf8", 9,
                                         False, symbol_emoji="🛰", color_for=color_for_station))
    _append_station_trace(_station_trace(carriers, "Авианосцы (Fleet Carriers)", "square", "#a855f7", 5.5, "#c084fc", 9,
                                         False, symbol_emoji="🚀"))

    # 11.5 Сфера фокусируемого тела (mesh3d) + дымка атмосферы — паритет с
    # сайтом: там те же трассы рисует SystemPlotlyMap в detailMode.
    if detail_body is not None and selected in sphere_radii:
        body_center = positions.get(selected)
        if body_center is not None:
            sphere_r = float(sphere_radii[selected])
            segments, rings = orrery.sphere_mesh()
            mesh = orrery.sphere_geometry(body_center, sphere_r, segments, rings)
            material = dict(orrery.SPHERE_MATERIAL)
            data.append({
                "type": "mesh3d",
                "name": str(selected),
                "x": mesh["x"], "y": mesh["y"], "z": mesh["z"],
                "i": mesh["i"], "j": mesh["j"], "k": mesh["k"],
                "color": body_color(detail_body),
                "hoverinfo": "skip",
                "showlegend": False,
                "legendgroup": "focus_body",
                "meta": "sphere",
                **material,
            })
            atmosphere = str(getattr(detail_body, "atmosphere", "") or "")
            if atmosphere and "no atmosphere" not in atmosphere.lower():
                # Дымка атмосферы: своя сетка (иной размер — свои i/j/k),
                # полупрозрачная, поверх уже непрозрачной планеты.
                haze_segments = max(12, int(segments * 0.8))
                haze_rings = max(8, int(rings * 0.8))
                haze = orrery.sphere_geometry(body_center, sphere_r * orrery.SPHERE_HAZE_SCALE,
                                              haze_segments, haze_rings)
                data.append({
                    "type": "mesh3d",
                    "name": "Атмосфера",
                    "x": haze["x"], "y": haze["y"], "z": haze["z"],
                    "i": haze["i"], "j": haze["j"], "k": haze["k"],
                    "color": "rgba(120, 190, 255, 0.16)",
                    "opacity": 0.35,
                    "lighting": {"ambient": 0.7, "diffuse": 0.2, "specular": 0.0,
                                 "roughness": 1.0, "fresnel": 0.5},
                    "flatshading": False,
                    "hoverinfo": "skip",
                    "showlegend": False,
                    "legendgroup": "focus_body",
                    "meta": "sphere_haze",
                })

    # 12. Пилот («Вы здесь»)
    if player_pos is not None:
        px, py, pz = player_pos
        cmdr_note = "Ваш корабль в системе"
        if snapshot.player.docked:
            cmdr_note = f"Стыковка: {snapshot.player.station_name or 'станция'}"
        elif snapshot.player.body_name:
            cmdr_note = f"У тела: {snapshot.player.body_name}"

        tr_pl: Dict[str, Any] = {
            "type": trace_type,
            "name": "Вы здесь (CMDR)",
            "x": [px],
            "y": [py],
            "mode": "markers+text",
            "marker": {
                "size": 14,
                "symbol": "circle-open",
                "color": ED_COLOR_PLAYER,
                "line": {"color": ED_COLOR_PLAYER, "width": 3},
                "opacity": 1.0,
            },
            "text": ["🛸 CMDR (ВЫ)"],
            "textposition": "top center",
            "textfont": {"color": ED_COLOR_PLAYER, "size": 12, "family": "Consolas, Segoe UI"},
            "hovertext": [f"<b>🛸 CMDR (Вы здесь)</b><br>{cmdr_note}"],
            "hoverinfo": "text",
            "legendgroup": "player",
            "showlegend": True,
        }
        if is_3d:
            tr_pl["z"] = [pz]
        data.append(tr_pl)

    # 13. Захват цели (Target Lock)
    target_pos = None
    target_label = ""
    if selected:
        clean_sel = str(selected).strip().lower()
        for name, pos in {**positions, **station_positions}.items():
            if clean_sel == name.lower() or clean_sel in name.lower() or name.lower() in clean_sel:
                target_pos = pos
                target_label = name
                break

    if target_pos is not None:
        tx, ty, tz = target_pos
        tr_target: Dict[str, Any] = {
            "type": trace_type,
            "name": f"🎯 Цель: {target_label}",
            "x": [tx],
            "y": [ty],
            "mode": "markers+text",
            "marker": {
                "size": 15 + 4 * max(0, zoom),
                "symbol": "cross-thin-open",
                "color": "#00f3ff",
                "line": {"color": "#00f3ff", "width": 2},
                "opacity": 1.0,
            },
            "text": [f"🎯 {short_label(target_label, snapshot.system)}"],
            "textposition": "top center",
            "textfont": {"color": "#00f3ff", "size": 10, "family": "Consolas, Segoe UI"},
            "hovertext": [f"<b>🎯 Выбранная цель</b><br>{target_label}"],
            "hoverinfo": "text",
            "legendgroup": "target",
            "showlegend": True,
        }
        if is_3d:
            tr_target["z"] = [tz]
        data.append(tr_target)

    # Заголовок и сводка
    sys_title = title or f"Система {snapshot.system or 'Неизвестная'}"
    summary_text = map_summary(snapshot)

    layout: Dict[str, Any] = {
        "title": {
            "text": f"<b>{sys_title}</b><br><span style='font-size:12px;color:#94a3b8'>{summary_text}</span>",
            "x": 0.03,
            "y": 0.96,
            "font": {"family": "Segoe UI, Arial, sans-serif", "size": 17, "color": "#f8fafc"},
        },
        "paper_bgcolor": ED_BG_PAPER,
        "plot_bgcolor": ED_BG_CANVAS,
        "margin": {"l": 10, "r": 10, "t": 60, "b": 10},
        "showlegend": True,
        "legend": {
            "bgcolor": "rgba(11, 14, 20, 0.85)",
            "tracegroupgap": 2,
            "bordercolor": "#1e293b",
            "borderwidth": 1,
            "font": {"color": "#cbd5e1", "size": 11},
            "itemsizing": "constant",
            "x": 0.01,
            "y": 0.02,
            "xanchor": "left",
            "yanchor": "bottom",
            "orientation": "h",
        },
        "hoverlabel": {
            "bgcolor": "#0f172a",
            "bordercolor": "#e67e22",
            "font": {"family": "Consolas, Courier New, monospace", "size": 12, "color": "#ffffff"},
            "align": "left",
        },
    }

    # 14. Приближение: разрез осей вокруг цели. Без этого «фокус» лишь
    # слегка сдвигал центр, и в мультизвёздной системе тело оставалось
    # точкой в общей каше.
    # Размах осей задаём явно всегда (а не только в фокусе): иначе Plotly
    # сам считает авто-диапазон и «приближение» невозможно ни сравнить, ни
    # восстановить кнопкой «Сброс».
    #
    # Обзор = куб по габариту РЕАЛЬНО нарисованных точек. Раньше рамки считались
    # из бюджета раскладки (±plan["span"]), а орбиты, кольца и зоны обитаемости
    # выходят за него — их края обрезались краем поля («вся система не влазит,
    # часть орбит порезана»).
    overview_span = orrery.overview_window(orrery.trace_extent(data), float(plan_preview["span"]))
    view_span = overview_span
    base_ranges: Dict[str, Tuple[float, float]] = {
        axis: (-overview_span, overview_span) for axis in ("x", "y", "z")
    }
    if focus is not None:
        fx, fy, fz = focus["center"]
        view_span = orrery.focus_window(focus["half_span"])
        base_ranges = {
            "x": (fx - view_span, fx + view_span),
            "y": (fy - view_span, fy + view_span),
            "z": (fz - view_span, fz + view_span),
        }

    # Камера: направление (изометрия / сверху / сбоку) — зум делает размах осей.
    # `center` при этом всегда 0: Plotly меряет его в нормализованных единицах
    # сцены, и координата цели в unit'ах системы уносила вид в пустоту
    # («при фокусе чёрный экран»). См. `orrery.scene_camera`.
    cams = {name: orrery.scene_camera(name) for name in ("iso", "top", "side")}
    view_name = "top" if top_down else "iso"
    camera_buttons = [
        {"label": "🔭 3D Orrery", "method": "relayout", "args": [{"scene.camera": cams["iso"]}]},
        {"label": "🧭 Сверху (2D)", "method": "relayout", "args": [{"scene.camera": cams["top"]}]},
        {"label": "📐 Сбоку (Профиль)", "method": "relayout", "args": [{"scene.camera": cams["side"]}]},
        {
            "label": "🎥 Перспектива",
            "method": "relayout",
            "args": [{"scene.camera.projection.type": "perspective"}],
        },
        {
            "label": "🧊 Ортография",
            "method": "relayout",
            "args": [{"scene.camera.projection.type": "orthographic"}],
        },
        {
            "label": "🔄 Сброс",
            "method": "relayout",
            "args": [{
                "scene.camera": cams[view_name],
                "scene.xaxis.range": list(base_ranges["x"]) if focus is None else [-overview_span, overview_span],
                "scene.yaxis.range": list(base_ranges["y"]) if focus is None else [-overview_span, overview_span],
                "scene.zaxis.range": list(base_ranges["z"]) if focus is None else [-overview_span, overview_span],
            }],
        },
    ]
    # Кнопки приближения: уровни 0…3 вокруг выбранной цели. Их args — готовые
    # scene.camera + ranges, поэтому работают и в статичном HTML без JS.
    if target_pos is not None:
        for level, label in ((0, "🔭 система"), (1, "🪐 кластер"),
                             (2, "🛰 окрестности"), (3, "🏗 поверхность")):
            view = orrery.focus_view(plan_preview, selected, level) if selected else None
            if view is None:
                continue
            center = (0.0, 0.0, 0.0) if level == 0 else view["center"]
            span = overview_span if level == 0 else orrery.focus_window(view["half_span"])
            camera_buttons.insert(0 if level == zoom else len(camera_buttons), {
                "label": label,
                "method": "relayout",
                "args": [{
                    "scene.camera": cams[view_name],
                    "scene.xaxis.range": [center[0] - span, center[0] + span],
                    "scene.yaxis.range": [center[1] - span, center[1] + span],
                    "scene.zaxis.range": [center[2] - span, center[2] + span],
                }],
            })

    layout["scene"] = {
        "bgcolor": ED_BG_CANVAS,
        # Сетки и деления осей сцены глушим, как на сайте: в 3D рамка только
        # мешает, координаты здесь не читают (за них — подписи и hover).
        "xaxis": {"title": "", "showgrid": False, "zeroline": False,
                  "showticklabels": False, "showbackground": False},
        "yaxis": {"title": "", "showgrid": False, "zeroline": False,
                  "showticklabels": False, "showbackground": False},
        "zaxis": {"title": "", "showgrid": False, "zeroline": False,
                  "showticklabels": False, "showbackground": False},
        "camera": cams[view_name],
        **orrery.scene_aspect(),
    }
    layout["scene"]["xaxis"]["range"] = list(base_ranges["x"])
    layout["scene"]["yaxis"]["range"] = list(base_ranges["y"])
    layout["scene"]["zaxis"]["range"] = list(base_ranges["z"])
    layout["updatemenus"] = [
        {
            "type": "buttons",
            "direction": "left",
            "x": 0.98,
            "y": 0.97,
            "xanchor": "right",
            "yanchor": "top",
            "bgcolor": "#1e293b",
            "bordercolor": "#334155",
            "font": {"color": "#e2e8f0", "size": 11},
            "buttons": camera_buttons,
        }
    ]

    config: Dict[str, Any] = {
        "responsive": True,
        "displayModeBar": True,
        "displaylogo": False,
        "modeBarButtonsToRemove": ["toImage"],
        "toImageButtonOptions": {
            "format": "png",
            "filename": f"ed_system_{snapshot.system or 'map'}",
            "height": 1080,
            "width": 1920,
            "scale": 2,
        },
    }

    return {"data": data, "layout": layout, "config": config}


def build_plotly_figure(
    snapshot: MapSnapshot,
    view_mode: str = "3d",
    scale_mode: str = "orrery",
    show_moons: bool = True,
    selected: str = "",
    title: Optional[str] = None,
):
    """Собрать и вернуть объект plotly.graph_objects.Figure.

    Если библиотека Plotly установлена, возвращает полноценный объект Figure,
    иначе вызывает ImportError.
    """
    if not HAS_PLOTLY or go is None:
        raise ImportError(
            "Пакет 'plotly' не установлен. Установите его: pip install plotly"
        )
    schema = build_plotly_dict(
        snapshot,
        view_mode=view_mode,
        scale_mode=scale_mode,
        show_moons=show_moons,
        selected=selected,
        title=title,
    )
    return go.Figure(data=schema["data"], layout=schema["layout"])



# ---------------------------------------------------------------------------
#  Данные для «карточки системы» в HTML-экспорте
# ---------------------------------------------------------------------------
def build_map_payload(
    snapshot: MapSnapshot,
    scale_mode: str = "orrery",
    show_moons: bool = True,
    half_span: Optional[float] = None,
    canvas_px: float = orrery.CANVAS_PX,
) -> Dict[str, Any]:
    """Свернуть карту в JSON-подобный словарь для JS в автономном HTML.

    Нужен, чтобы браузер мог сам пересчитать приближение (уровни 0…3) и
    переложить постройки по поверхности тела при смене зума — ровно так же, как
    это делает React-компонент на сайте (`src/components/SystemPlotlyMap.tsx`).
    """
    plan = orrery.plan_system(
        snapshot.bodies, snapshot.system or "", scale_mode=scale_mode,
        show_moons=show_moons, extra_marks=len(snapshot.stations or []),
    )
    span = float(half_span if half_span and half_span > 0 else plan["span"])
    placements = orrery.place_stations(
        plan,
        [{
            "name": station.name or station.build_name,
            "body_name": station.body_name or "",
            "kind": station.kind,
            "is_site": bool(station.is_site),
            "complete": bool(station.complete),
        } for station in (snapshot.stations or [])],
        span, canvas_px,
    )
    return {
        "system": snapshot.system or "",
        "span": plan["span"],
        "canvasPx": canvas_px,
        "positions": {name: [round(value, 4) for value in point] for name, point in plan["positions"].items()},
        "markers": plan["markers"],
        "clusters": [
            {"star": cluster["star"], "center": [round(value, 4) for value in cluster["center"]],
             "budget": round(cluster["budget"], 4), "bodies": cluster["bodies"]}
            for cluster in plan["clusters"]
        ],
        "bodies": [
            {"name": body["name"], "kind": body["kind"], "cls": body["class"],
             "distance": round(body["distance_ls"], 1), "landable": body["landable"],
             "bio": body["bio_signals"], "rings": len(body["rings"]), "star": body["name"] if body["kind"] == "star" else ""}
            for body in plan["bodies"]
        ],
        "structures": [
            {"name": str(item.get("name")), "anchor": item.get("anchor"),
             "center": [round(value, 4) for value in item.get("center", (0, 0, 0))],
             "index": item.get("index", 0), "total": item.get("total", 1),
             "isSite": bool(item.get("is_site")), "complete": bool(item.get("complete")),
             "position": [round(value, 4) for value in item.get("position", (0, 0, 0))]}
            for item in placements
        ],
    }


def _card_html_for_body(body: MapBody, stations: List[MapStation]) -> str:
    """Карточка тела — как на сайте: имя, класс, параметры и стройки тела."""
    flags = []
    if body.landable:
        flags.append('<span class="tag cyan">🛬 посадка</span>')
    if body.bio_signals:
        flags.append(f'<span class="tag green">🌿 {body.bio_signals}</span>')
    if getattr(body, "rings", None):
        flags.append(f'<span class="tag">💍 {len(body.rings)}</span>')
    if body.mapped:
        flags.append('<span class="tag">🗺 карта</span>')
    details = []
    if body.distance_ls:
        details.append(f"{body.distance_ls:,.1f} св. с".replace(",", " "))
    if body.radius_m:
        details.append(f"{body.radius_m / 1000.0:,.0f} км".replace(",", " "))
    if body.gravity:
        details.append(f"{body.gravity / 9.80665:.2f} g")
    if body.surface_temp_k:
        details.append(f"{body.surface_temp_k:.0f} K")
    if body.atmosphere:
        details.append(body.atmosphere)
    sites_html = ""
    if stations:
        rows = []
        for station in stations:
            percent = station.percent_delivered
            state = "готово" if station.complete else (f"{percent:.0f}%" if percent is not None else "идёт стройка")
            width = max(0, min(100, percent if percent is not None else (station.progress or 0) * 100))
            rows.append(
                '<div class="site"><div class="site-head"><span>{name}</span><b>{state}</b></div>'
                '<div class="bar"><i style="width:{width:.0f}%"></i></div></div>'.format(
                    name=station.title or station.name, state=state, width=width)
            )
        sites_html = '<div class="sites">{}</div>'.format("".join(rows))
    return (
        '<div class="card" data-name="{name}" data-kind="{kind}">'
        '<div class="card-head"><span class="card-title">{title}</span>'
        '<span class="card-kind">{kind_label}</span></div>'
        '<div class="card-sub">{details}</div>'
        '<div class="tags">{flags}</div>'
        '{sites}'
        '</div>'
    ).format(
        name=body.name.replace('"', "'"),
        kind=body.kind,
        title=short_label(body.name, ""),
        kind_label={"star": "звезда", "planet": "планета", "moon": "луна"}.get(body.kind, "тело"),
        details=" · ".join(details) or (body.body_class or body.star_type or ""),
        flags="".join(flags),
        sites=sites_html,
    )


def _cards_html(snapshot: MapSnapshot, plan: Dict[str, Any]) -> str:
    """Карточки тел и построек — правая колонка автономного HTML-экспорта.

    Это тот же формат, что и на сайте (см. `SystemPlotlyMap`): карточка тела с
    параметрами и списком его построек, сгруппированная по звёздам. Раньше
    «Карта системы» в Colonial Helper была только схемой на холсте, и смотреть
    прогресс строек приходилось в отдельной таблице.
    """
    stations_by_body: Dict[str, List[MapStation]] = {}
    for station in snapshot.stations or []:
        stations_by_body.setdefault(str(station.body_name or ""), []).append(station)
    by_body = {body.name: body for body in snapshot.bodies or []}

    blocks: List[str] = []
    for cluster in plan.get("clusters", []):
        cards: List[str] = []
        for name in cluster["bodies"]:
            body = by_body.get(name)
            if body is None:
                continue
            cards.append(_card_html_for_body(body, stations_by_body.get(name, [])))
        star = by_body.get(cluster.get("star") or "")
        if star is not None:
            cards.insert(0, _card_html_for_body(star, stations_by_body.get(star.name, [])))
        if not cards:
            continue
        title = short_label(cluster.get("star") or "", snapshot.system or "") or "без звезды"
        blocks.append(
            f'<section class="cluster"><h4>★ {title} <small>{len(cluster["bodies"])} тел</small></h4>'
            + "".join(cards) + "</section>"
        )
    loose = [station for station in (snapshot.stations or []) if not station.body_name or station.body_name not in by_body]
    if loose:
        rows = []
        for station in loose:
            percent = station.percent_delivered
            rows.append(
                '<div class="card" data-name="{}"><div class="card-head"><span class="card-title">{}</span>'
                '<span class="card-kind">вне тела</span></div><div class="card-sub">{}</div></div>'.format(
                    (station.name or station.build_name or "").replace('"', "'"),
                    station.title or station.name,
                    station.caption or "",
                )
            )
        blocks.append('<section class="cluster"><h4>Объекты без привязки к телу</h4>' + "".join(rows) + "</section>")
    if not blocks:
        return '<div class="empty">Нет данных о телах системы. Отсканируйте систему (FSS/DSS) — карта и карточки наполнятся.</div>'
    return "".join(blocks)


def generate_plotly_html(
    snapshot: MapSnapshot,
    view_mode: str = "3d",
    scale_mode: str = "orrery",
    show_moons: bool = True,
    selected: str = "",
    include_plotlyjs: Union[str, bool] = "cdn",
    title: Optional[str] = None,
    zoom: int = 0,
    show_all_labels: bool = False,
) -> str:
    """Сгенерировать автономный HTML-документ с интерактивной картой системы.

    Отличия от прошлой версии: карта собрана «карточками системы», как на сайте
    проекта — справа список тел с их постройками, а приближение (фокус на теле)
    пересчитывается в браузере, поэтому наземные постройки остаются на
    поверхности тела при любом зуме.

    Поддерживает:
    - include_plotlyjs='cdn': легкий HTML со скриптом из CDN.
    - include_plotlyjs='inline': полностью автономный HTML с встроенным скриптом.

    `view_mode` выбирает только стартовую камеру: «3d» — изометрия, как на сайте,
    «2d» — вид сверху в ортографической проекции. Фигура при этом одна и та же
    3D-сцена, поэтому переключатель вида работает и внутри сохранённого HTML.
    """
    schema = build_plotly_dict(
        snapshot,
        view_mode=view_mode,
        scale_mode=scale_mode,
        show_moons=show_moons,
        selected=selected,
        title=title,
        zoom=zoom,
        show_all_labels=show_all_labels,
    )
    plan = orrery.plan_system(
        snapshot.bodies, snapshot.system or "", scale_mode=scale_mode,
        show_moons=show_moons, extra_marks=len(snapshot.stations or []),
    )
    payload = build_map_payload(
        snapshot, scale_mode=scale_mode, show_moons=show_moons, canvas_px=orrery.CANVAS_PX,
    )
    summary = orrery.summarize_plan(plan, payload["structures"])

    data_json = json.dumps(schema["data"], ensure_ascii=False)
    layout_json = json.dumps(schema["layout"], ensure_ascii=False)
    # JS в шаблоне не хранит свои догадки о камере: направления и кубический
    # разрез обзора приходят из Python (orrery.scene_camera / trace_extent).
    camera_json = json.dumps({name: orrery.scene_camera(name) for name in ("iso", "top", "side")},
                             ensure_ascii=False)
    focus_pad = orrery.FOCUS_PAD
    sphere_segments, sphere_rings = orrery.sphere_mesh()
    sphere_mesh_json = json.dumps([sphere_segments, sphere_rings])
    sphere_haze_json = json.dumps([max(12, int(sphere_segments * 0.8)),
                                   max(8, int(sphere_rings * 0.8))])
    haze_scale = orrery.SPHERE_HAZE_SCALE
    sphere_lift = orrery.SPHERE_SURFACE_LIFT
    overview_span = orrery.overview_window(orrery.trace_extent(schema["data"]), float(plan["span"]))
    config_json = json.dumps(schema["config"], ensure_ascii=False)
    payload_json = json.dumps(payload, ensure_ascii=False)

    sys_name = snapshot.system or "Система"
    active_sites = [s for s in snapshot.stations if s.is_site and not s.complete]
    cards_html = _cards_html(snapshot, plan)
    # «2D» в этой карте — вид сверху в той же 3D-сцене (кнопка переключает
    # камеру и проекцию), поэтому стартовое состояние задаём только камерой.
    flat = normalize_view_mode(view_mode) == "2d"
    view_label = "🧭 2D сверху" if flat else "🔭 3D"

    if include_plotlyjs in ("inline", True) and HAS_PLOTLY and po is not None:
        script_tag = f"<script>{po.get_plotlyjs()}</script>"
    else:
        script_tag = '<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>'

    html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Карта системы {sys_name} — Colonial Helper</title>
  {script_tag}
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      background-color: #07090e; color: #f1f5f9; overflow: hidden; height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex; flex-direction: column;
    }}
    header {{
      background: #0b0e14; border-bottom: 1px solid #1e293b; padding: 9px 16px;
      display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
    }}
    .title-group {{ display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }}
    .sys-name {{ font-size: 19px; font-weight: 700; color: #ff9f43; letter-spacing: .5px; }}
    .badges {{ display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }}
    .badge {{ font-size: 11px; padding: 2px 7px; border-radius: 4px; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }}
    .badge.orange {{ background: rgba(230,126,34,.18); border-color: rgba(230,126,34,.5); color: #ff9f43; font-weight: 600; }}
    .badge.green {{ background: rgba(46,204,113,.18); border-color: rgba(46,204,113,.5); color: #2ecc71; }}
    .badge.cyan {{ background: rgba(0,243,255,.15); border-color: rgba(0,243,255,.4); color: #00f3ff; }}
    .controls {{ display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }}
    .btn {{
      padding: 5px 10px; border-radius: 6px; background: #1e293b; color: #f1f5f9; border: 1px solid #334155;
      font-size: 11px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 5px;
      transition: all .15s ease;
    }}
    .btn:hover {{ background: #334155; border-color: #64748b; }}
    .btn[data-on="1"] {{ background: #e67e22; border-color: #e67e22; color: #0b0e14; font-weight: 600; }}
    .btn.primary {{ background: rgba(230,126,34,.2); border-color: #e67e22; color: #ff9f43; }}
    select.btn {{ max-width: 260px; }}
    main {{ flex: 1; display: flex; min-height: 0; }}
    #map-container {{ flex: 1 1 auto; min-width: 0; position: relative; }}
    aside {{
      flex: 0 0 330px; width: 330px; background: #0b0e14; border-left: 1px solid #1e293b;
      display: flex; flex-direction: column; min-height: 0;
    }}
    aside header.cards-head {{ padding: 8px 10px; border-bottom: 1px solid #1e293b; display: block; background: #0b0e14; }}
    #cards {{ overflow-y: auto; padding: 8px 10px 26px; flex: 1; min-height: 0; }}
    #cards::-webkit-scrollbar {{ width: 8px; }}
    #cards::-webkit-scrollbar-thumb {{ background: #1e293b; border-radius: 4px; }}
    .cluster h4 {{ font-size: 11px; color: #ffd166; text-transform: uppercase; margin: 10px 0 6px; letter-spacing: .4px; }}
    .cluster h4 small {{ color: #64748b; font-weight: 400; text-transform: none; }}
    .card {{
      background: #12161f; border: 1px solid #1e293b; border-radius: 7px; padding: 8px 9px; margin-bottom: 6px;
      cursor: pointer; transition: border-color .12s ease, transform .12s ease;
    }}
    .card:hover {{ border-color: #e67e22; transform: translateY(-1px); }}
    .card[data-target="1"] {{ border-color: #00f3ff; box-shadow: 0 0 0 1px rgba(0,243,255,.25) inset; }}
    .card-head {{ display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }}
    .card-title {{ font-size: 12.5px; font-weight: 600; color: #f8fafc; }}
    .card-kind {{ font-size: 10px; color: #64748b; text-transform: uppercase; }}
    .card-sub {{ font-size: 11px; color: #94a3b8; margin-top: 2px; line-height: 1.35; }}
    .tags {{ display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; }}
    .tag {{ font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #1e293b; color: #cbd5e1; }}
    .tag.cyan {{ color: #00f3ff; background: rgba(0,243,255,.12); }}
    .tag.green {{ color: #2ecc71; background: rgba(46,204,113,.14); }}
    .sites {{ margin-top: 6px; display: grid; gap: 4px; }}
    .site {{ background: #0f131b; border: 1px solid #1e293b; border-radius: 5px; padding: 4px 6px; }}
    .site-head {{ display: flex; justify-content: space-between; font-size: 11px; color: #ff9f43; gap: 6px; }}
    .bar {{ height: 4px; background: #1e293b; border-radius: 2px; margin-top: 3px; overflow: hidden; }}
    .bar i {{ display: block; height: 100%; background: #e67e22; }}
    .empty {{ color: #64748b; font-size: 12px; padding: 14px 4px; }}
    .hint {{
      position: absolute; bottom: 8px; left: 10px; font-size: 10.5px; color: #64748b; pointer-events: none;
      background: rgba(7,9,14,.7); padding: 3px 7px; border-radius: 4px; border: 1px solid #1e293b;
    }}
    @media (max-width: 980px) {{
      main {{ flex-direction: column; }}
      aside {{ flex: 0 0 40vh; width: 100%; border-left: none; border-top: 1px solid #1e293b; }}
    }}
  </style>
</head>
<body>
  <header>
    <div class="title-group">
      <div class="sys-name">🪐 {sys_name}</div>
      <div class="badges">
        <span class="badge">★ {summary['stars'] or '—'}</span>
        <span class="badge">Тел: {summary['planets'] + summary['moons'] + summary['stars']}</span>
        {f'<span class="badge">Лун: {summary["moons"]}</span>' if summary['moons'] else ''}
        {f'<span class="badge orange">🏗 Строек: {len(active_sites)}</span>' if active_sites else ''}
        {f'<span class="badge cyan">🛬 Посадочных: {summary["landable"]}</span>' if summary['landable'] else ''}
        {f'<span class="badge green">🌿 Биосигналов: {summary["bio_signals"]}</span>' if summary['bio_signals'] else ''}
        {f'<span class="badge">💍 С кольцами: {summary["ringed"]}</span>' if summary['ringed'] else ''}
        <span class="badge cyan" id="focus-badge" hidden></span>
      </div>
    </div>
    <div class="controls">
      <select class="btn" id="target"></select>
      <button class="btn" data-zoom="0">🔭 система</button>
      <button class="btn" data-zoom="1">🪐 кластер</button>
      <button class="btn" data-zoom="2">🛰 окрестности</button>
      <button class="btn" data-zoom="3">🏗 поверхность</button>
      <button class="btn" id="view" data-on="{1 if flat else 0}" title="3D-оррерий или плоский вид сверху — та же сцена, меняется только камера">{view_label}</button>
      <button class="btn" id="isolate" data-on="1">⧉ изолировать</button>
      <button class="btn" id="labels">Aa подписи</button>
      <button class="btn" id="fs">⛶ во весь экран</button>
      <a class="btn primary" href="https://ravencolonial.com/#sys={sys_name}" target="_blank" rel="noopener">RavenColonial ↗</a>
      <a class="btn" href="https://www.edsm.net/en/system?systemName={sys_name}" target="_blank" rel="noopener">EDSM ↗</a>
    </div>
  </header>

  <main>
    <div id="map-container"><div class="hint">колесо — зум · ЛКМ — вращение · ПКМ — панорама · клик по телу — фокус · клик по карточке — фокус</div></div>
    <aside>
      <header class="cards-head"><b style="font-size:12px;color:#e2e8f0">Карточки системы</b>
        <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
          <input class="btn" id="search" placeholder="фильтр тел…" style="flex:1;min-width:0">
          <button class="btn" id="only-sites">🏗 только со стройками</button>
        </div>
      </header>
      <div id="cards">{cards_html}</div>
    </aside>
  </main>

  <script>
    const DATA = {data_json};
    const LAYOUT = {layout_json};
    // Направления камеры и кубический разрез обзора приходят из Python
    // (`orrery.scene_camera` / `orrery.trace_extent`) — тот же источник, что у
    // статичной фигуры, поэтому кнопки и JS не могут разойтись с картой сайта.
    const CAMERA = {camera_json};
    const OVERVIEW_SPAN = {overview_span};
    const FOCUS_PAD = {focus_pad};
    // Сетка и материал сферы — из orrery: перекладывать вершины при зуме можно
    // только сеткой ровно того же размера, иначе индексы граней поедут.
    const SPHERE_MESH = {sphere_mesh_json};
    const SPHERE_HAZE = {sphere_haze_json};
    const HAZE_SCALE = {haze_scale};
    const SPHERE_LIFT = {sphere_lift};
    const CONFIG = {config_json};
    const PLAN = {payload_json};

    const gd = document.getElementById('map-container');
    Plotly.newPlot(gd, DATA, LAYOUT, CONFIG);

    const state = {{ target: {json.dumps(selected or "", ensure_ascii=False)}, zoom: {int(zoom or 0)}, isolate: true, labels: false, flat: {json.dumps(flat)} }};

    const targetSelect = document.getElementById('target');
    const names = Object.keys(PLAN.positions);
    const sysPrefix = (PLAN.system || '') + ' ';
    const pretty = (n) => n.startsWith(sysPrefix) ? n.slice(sysPrefix.length) : n;
    names.forEach((name) => {{
      const opt = document.createElement('option');
      opt.value = name;
      const body = PLAN.bodies.find((b) => b.name === name) || {{}};
      opt.textContent = (body.kind === 'star' ? '★ ' : body.kind === 'moon' ? '☾ ' : '● ') + pretty(name) + (body.bio ? ' · 🌿' + body.bio : '');
      targetSelect.appendChild(opt);
    }});
    targetSelect.value = state.target || '';

    // ── Фокус: те же формулы, что в orrery.py / src/lib/systemOrrery.ts ──
    function unitsPerPx(halfSpan) {{
      const px = Math.max(240, Math.min(gd.clientWidth || 900, (gd.clientHeight || 500) * 1.6));
      return (halfSpan * 2) / px;
    }}
    function sizeUnits(name, halfSpan) {{
      const px = PLAN.markers[name] || 8;
      return Math.max(0.6, (px / 2) * unitsPerPx(halfSpan) * 1.25);
    }}
    function clusterOf(name) {{
      return PLAN.clusters.find((c) => c.star === name || (c.bodies || []).includes(name)) || null;
    }}
    function focusView(name, level) {{
      const pos = PLAN.positions[name];
      if (!pos) return {{ center: [0, 0, 0], halfSpan: PLAN.span, eye: 1.65 }};
      const span = PLAN.span;
      if (level <= 0) {{
        const pad = Math.max(Math.abs(pos[0]), Math.abs(pos[1]), Math.abs(pos[2]));
        return {{ center: pos, halfSpan: span + pad, eye: 1.65 }};
      }}
      const cluster = clusterOf(name);
      const size = sizeUnits(name, span);
      if (level === 1) {{
        const center = cluster ? cluster.center : [0, 0, 0];
        let extent = 0;
        ((cluster && cluster.bodies) || []).forEach((member) => {{
          const point = PLAN.positions[member];
          if (!point) return;
          extent = Math.max(extent, Math.hypot(point[0] - center[0], point[1] - center[1], point[2] - center[2]));
        }});
        return {{ center: center, halfSpan: Math.max(Math.min(span * 0.94, extent * 1.08 + 4), size * 6), eye: 1.2 }};
      }}
      if (level === 2) {{
        let nearest = Infinity;
        names.forEach((other) => {{
          if (other === name) return;
          const p = PLAN.positions[other];
          const d = Math.hypot(p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]);
          if (d > 1e-4 && d < nearest) nearest = d;
        }});
        if (!isFinite(nearest)) nearest = span * 0.2;
        return {{ center: pos, halfSpan: Math.max(size * 5, Math.min(span * 0.35, nearest * 1.35)), eye: 0.9 }};
      }}
      return {{ center: pos, halfSpan: Math.max(size * 1.9, 3.2), eye: 0.72 }};
    }}

    function onSphere(center, radius, index, total) {{
      const count = Math.max(1, total);
      const y = count === 1 ? 0.45 : 1 - (2 * (index + 0.5)) / count;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = (index + 1) * 2.399963229728653;
      return [center[0] + radius * ring * Math.cos(theta), center[1] + radius * ring * Math.sin(theta), center[2] + radius * y];
    }}

    /**
     * Наземные постройки — на визуальной поверхности тела.
     *
     * При смене зума пересчитываем смещение заново: иначе постройка, «посаженная»
     * на лимб в обзоре системы, улетает внутрь планеты при приближении.
     */
    function structurePositions() {{
      const view = focusView(state.target || '', state.zoom);
      const halfSpan = state.target ? view.halfSpan : PLAN.span;
      const sphereBodyFor = (anchor, span) => sphereRadiusFor(anchor, span);
      const groups = {{}};
      PLAN.structures.forEach((item) => {{
        const key = item.anchor || '__none__';
        (groups[key] = groups[key] || []).push(item);
      }});
      const out = {{}};
      Object.keys(groups).forEach((anchor) => {{
        const list = groups[anchor];
        const center = anchor === '__none__' ? [0, 0, 0] : (PLAN.positions[anchor] || [0, 0, 0]);
        list.forEach((item, index) => {{
          let point;
          const sphereR = sphereBodyFor(anchor, halfSpan);
          if (sphereR > 0) {{
            point = onSphere(center, sphereR * SPHERE_LIFT, index, list.length);
          }} else if (anchor === '__none__') {{
            const angle = index * 2.399963229728653;
            const radius = 16 + index * 4;
            point = [radius * Math.cos(angle), radius * Math.sin(angle), 2];
          }} else {{
            const lift = sizeUnits(anchor, halfSpan) + 0.35;
            const angle = list.length === 1 ? Math.PI / 2 : Math.PI / 2 + (2 * Math.PI * index) / list.length;
            point = [center[0] + lift * Math.cos(angle) * 0.35, center[1] + lift * Math.sin(angle) * 0.35, center[2] + lift];
          }}
          out[item.name] = {{ point: point, anchor: anchor, center: center }};
        }});
      }});
      return out;
    }}

    /**
     * Радиус сферы тела в фокусе — правила уровня 2/3 как в `build_plotly_dict`
     * (п. 11.5) и на сайте: 0.42 от разреза на «поверхности», 0.14 на
     * «окрестностях», и только если цель — не центр кластера (звезда).
     */
    function sphereRadiusFor(name, halfSpan) {{
      if (!name || !state.target || name !== state.target) return 0;
      const body = PLAN.bodies.find((b) => b.name === name) || {{}};
      if (body.kind === 'star') return 0;
      if (state.zoom >= 3) return halfSpan * 0.42;
      if (state.zoom === 2) {{
        const cluster = clusterOf(name);
        if (!(cluster && cluster.star === name)) return halfSpan * 0.14;
      }}
      return 0;
    }}

    function sphereGeometry(center, radius, segments, rings) {{
      const x = [], y = [], z = [], i = [], j = [], k = [];
      for (let ring = 0; ring <= rings; ring += 1) {{
        const phi = (Math.PI * ring) / rings;
        for (let segment = 0; segment <= segments; segment += 1) {{
          const theta = (2 * Math.PI * segment) / segments;
          x.push(center[0] + radius * Math.sin(phi) * Math.cos(theta));
          y.push(center[1] + radius * Math.sin(phi) * Math.sin(theta));
          z.push(center[2] + radius * Math.cos(phi));
        }}
      }}
      const stride = segments + 1;
      for (let ring = 0; ring < rings; ring += 1) {{
        for (let segment = 0; segment < segments; segment += 1) {{
          const first = ring * stride + segment;
          const second = first + stride;
          i.push(first, second);
          j.push(second, first + 1);
          k.push(first + 1, second + 1);
        }}
      }}
      return {{ x, y, z, i, j, k }};
    }}

    /**
     * mesh3d-сферы уже лежат в фигуре (их собрал Python), но их радиус
     * зависит от зума — пересчитываем координаты вершин на месте: сетка та же,
     * поэтому индексы граней остаются валидными.
     */
    function refreshSphere() {{
      const indices = [];
      DATA.forEach((trace, index) => {{
        if (trace.meta === 'sphere' || trace.meta === 'sphere_haze') indices.push(index);
      }});
      if (!indices.length) return;
      const view = focusView(state.target || '', state.zoom);
      const halfSpan = state.target ? view.halfSpan : PLAN.span;
      const center = state.target ? (PLAN.positions[state.target] || null) : null;
      const radius = center ? Math.max(sphereRadiusFor(state.target, halfSpan), 1e-3) : 1e-3;
      indices.forEach((index) => {{
        const haze = DATA[index].meta === 'sphere_haze';
        const size = haze ? SPHERE_HAZE : SPHERE_MESH;
        const geometry = sphereGeometry(center || [0, 0, 0], haze ? radius * HAZE_SCALE : radius,
                                        size[0], size[1]);
        Plotly.restyle(gd, {{
          x: [geometry.x], y: [geometry.y], z: [geometry.z],
          visible: [Boolean(center) && radius > 0.01],
        }}, [index]);
      }});
    }}

    function apply(setCamera) {{
      const view = focusView(state.target || '', state.zoom);
      // Обзор — куб по габариту всех точек (OVERVIEW_SPAN), а не PLAN.span:
      // иначе внешние орбиты и кольца обрезаются краем поля.
      const halfSpan = state.target ? view.halfSpan * FOCUS_PAD : OVERVIEW_SPAN;
      const center = state.target ? view.center : [0, 0, 0];
      const relayout = {{
        'scene.xaxis.range': [center[0] - halfSpan, center[0] + halfSpan],
        'scene.yaxis.range': [center[1] - halfSpan, center[1] + halfSpan],
        'scene.zaxis.range': [center[2] - halfSpan, center[2] + halfSpan],
      }};
      if (setCamera) {{
        // camera.center — нормализованные единицы сцены, всегда 0: центр окна
        // задают размахи осей. Сюда клали координату цели в unit'ах системы —
        // камера улетала в пустоту, и при фокусе был чёрный экран.
        const cam = CAMERA[state.flat ? 'top' : 'iso'];
        relayout['scene.camera'] = {{
          eye: cam.eye, up: cam.up, center: {{ x: 0, y: 0, z: 0 }},
          projection: cam.projection,
        }};
      }}

      const positions = structurePositions();
      const restyle = {{ x: [], y: [], z: [], text: [], 'marker.size': [] }};
      const indices = [];
      DATA.forEach((trace, index) => {{
        if (trace.meta !== 'site') return;
        const xs = [], ys = [], zs = [], texts = [], sizes = [];
        (trace.customdata || []).forEach((entry, i) => {{
          const key = Array.isArray(entry) ? entry[0] : entry;
          const found = positions[key];
          const point = found ? found.point : (trace.z ? [trace.x[i], trace.y[i], trace.z[i]] : [trace.x[i], trace.y[i], 0]);
          xs.push(point[0]); ys.push(point[1]); zs.push(point[2]);
          const anchor = found ? found.anchor : null;
          const isTarget = Boolean(state.target) && anchor === state.target;
          texts.push((isTarget || state.zoom >= 3 || state.labels) ? (trace.text && trace.text[i] ? trace.text[i] : '🏗 ' + pretty(key)) : '');
          sizes.push(isTarget ? 9 : 5.5);
        }});
        restyle.x.push(xs); restyle.y.push(ys); restyle.z.push(zs); restyle.text.push(texts); restyle['marker.size'].push(sizes);
        indices.push(index);
      }});

      const cluster = state.target ? clusterOf(state.target) : null;
      const visibleClusters = state.zoom > 0 && state.isolate && cluster
        ? [cluster.star].concat(PLAN.clusters.filter((c) => false).map((c) => c.star))
        : PLAN.clusters.map((c) => c.star);
      // Скрываем чужие орбиты/кольца в изолированном кластере: трэки орбит —
      // единая линия, поэтому просто подсвечиваем свой кластер ярче.
      DATA.forEach((trace, index) => {{
        if (trace.name === 'Орбиты планет' || trace.name === 'Орбиты лун') {{
          Plotly.restyle(gd, {{ 'line.width': [state.zoom > 0 && state.isolate && cluster ? 1.1 : 2] }}, [index]);
        }}
      }});

      if (indices.length) Plotly.restyle(gd, restyle, indices);
      refreshSphere();
      Plotly.relayout(gd, relayout);

      const badge = document.getElementById('focus-badge');
      if (state.target) {{
        badge.hidden = false;
        badge.textContent = '🎯 ' + pretty(state.target) + ' · ' + ['система', 'кластер', 'окрестности', 'поверхность'][state.zoom];
      }} else {{
        badge.hidden = true;
      }}
      document.querySelectorAll('#cards .card').forEach((card) => {{
        card.dataset.target = (state.target && card.dataset.name === state.target) ? '1' : '0';
      }});
      document.querySelectorAll('[data-zoom]').forEach((button) => {{
        button.dataset.on = (Number(button.dataset.zoom) === state.zoom) ? '1' : '0';
      }});
    }}

    targetSelect.addEventListener('change', (event) => {{
      state.target = event.target.value;
      if (state.target && state.zoom === 0) state.zoom = 2;
      if (!state.target) state.zoom = 0;
      apply(true);
    }});
    document.querySelectorAll('[data-zoom]').forEach((button) => {{
      button.addEventListener('click', () => {{
        state.zoom = Number(button.dataset.zoom);
        if (state.zoom > 0 && !state.target && names.length) {{
          state.target = names[0];
          targetSelect.value = state.target;
        }}
        apply(true);
      }});
    }});
    document.getElementById('view').addEventListener('click', (event) => {{
      state.flat = !state.flat;
      event.currentTarget.dataset.on = state.flat ? '1' : '0';
      event.currentTarget.textContent = state.flat ? '🧭 2D сверху' : '🔭 3D';
      apply(true);
    }});
    document.getElementById('isolate').addEventListener('click', (event) => {{
      state.isolate = !state.isolate;
      event.currentTarget.dataset.on = state.isolate ? '1' : '0';
      apply();
    }});
    document.getElementById('labels').addEventListener('click', (event) => {{
      state.labels = !state.labels;
      event.currentTarget.dataset.on = state.labels ? '1' : '0';
      apply();
    }});
    document.getElementById('fs').addEventListener('click', () => {{
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {{}});
      else document.exitFullscreen().catch(() => {{}});
    }});
    document.getElementById('search').addEventListener('input', (event) => {{
      const query = event.target.value.trim().toLowerCase();
      document.querySelectorAll('#cards .card').forEach((card) => {{
        const hit = !query || (card.dataset.name || '').toLowerCase().includes(query) || card.textContent.toLowerCase().includes(query);
        card.style.display = hit ? '' : 'none';
      }});
      if (query) document.querySelectorAll('#cards .cluster').forEach((block) => {{
        const any = Array.from(block.querySelectorAll('.card')).some((card) => card.style.display !== 'none');
        block.style.display = any ? '' : 'none';
      }});
      else document.querySelectorAll('#cards .cluster').forEach((block) => {{ block.style.display = ''; }});
    }});
    let onlySites = false;
    document.getElementById('only-sites').addEventListener('click', (event) => {{
      onlySites = !onlySites;
      event.currentTarget.dataset.on = onlySites ? '1' : '0';
      document.querySelectorAll('#cards .card').forEach((card) => {{
        card.style.display = (!onlySites || card.querySelector('.sites')) ? '' : 'none';
      }});
    }});
    document.querySelectorAll('#cards .card').forEach((card) => {{
      card.addEventListener('click', () => {{
        state.target = card.dataset.name;
        targetSelect.value = state.target;
        if (state.zoom === 0) state.zoom = 2;
        apply(true);
        gd.scrollIntoView({{ behavior: 'smooth', block: 'nearest' }});
      }});
    }});

    if (typeof gd.on === 'function') {{
      gd.on('plotly_click', (event) => {{
        const point = (event && event.points && event.points[0]) || null;
        if (!point) return;
        const data = point.data || {{}};
        let name = null;
        if (data.meta === 'site') {{
          const entry = (data.customdata || [])[point.pointNumber || 0];
          name = Array.isArray(entry) ? (entry[1] || entry[0]) : entry;
        }} else {{
          name = (point.customdata || data.customdata || [])[0] || point.customdata || null;
        }}
        if (!name || !PLAN.positions[name]) return;
        state.target = name;
        targetSelect.value = name;
        state.zoom = data.meta === 'site' ? 3 : 2;
        apply(true);
      }});
    }}

    window.addEventListener('resize', () => Plotly.Plots.resize(gd));
    apply();
  </script>
</body>
</html>
"""
    return html


def export_plotly_html(
    snapshot: MapSnapshot,
    filepath: Union[str, Path, None] = None,
    view_mode: str = "3d",
    scale_mode: str = "orrery",
    show_moons: bool = True,
    selected: str = "",
    include_plotlyjs: Union[str, bool] = "cdn",
    title: Optional[str] = None,
    zoom: int = 0,
    show_all_labels: bool = False,
) -> Path:
    """Экспортировать интерактивную карту Plotly в HTML-файл на диске."""
    content = generate_plotly_html(
        snapshot,
        view_mode=view_mode,
        scale_mode=scale_mode,
        show_moons=show_moons,
        selected=selected,
        include_plotlyjs=include_plotlyjs,
        title=title,
        zoom=zoom,
        show_all_labels=show_all_labels,
    )

    if filepath is None:
        safe_sys = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in (snapshot.system or "system"))
        tmp_dir = Path(tempfile.gettempdir())
        filepath = tmp_dir / f"colonial_helper_system_{safe_sys}.html"
    else:
        filepath = Path(filepath)

    filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.write_text(content, encoding="utf-8")
    return filepath


def open_plotly_in_browser(
    snapshot: MapSnapshot,
    filepath: Union[str, Path, None] = None,
    view_mode: str = "3d",
    scale_mode: str = "orrery",
    show_moons: bool = True,
    selected: str = "",
    include_plotlyjs: Union[str, bool] = "cdn",
    title: Optional[str] = None,
    zoom: int = 0,
    show_all_labels: bool = False,
) -> Path:
    """Сгенерировать интерактивную карту Plotly и открыть её в веб-браузере."""
    target_path = export_plotly_html(
        snapshot,
        filepath=filepath,
        view_mode=view_mode,
        scale_mode=scale_mode,
        show_moons=show_moons,
        selected=selected,
        include_plotlyjs=include_plotlyjs,
        title=title,
        zoom=zoom,
        show_all_labels=show_all_labels,
    )
    webbrowser.open(target_path.as_uri())
    return target_path
