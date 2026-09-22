"""Пакет данных карты системы — общий для сайта и приложения.

Модуль — питоновская половина контракта карты: сайт собирает тот же пакет в
`src/lib/orrery3d/payload.ts` и рисует его three.js, приложение — здесь же
(`build_view_payload`) и рисует холстом Tk (`tk_orrery.py`). Структура пакета
одна (`ORRERY_VIEW_VERSION`), поэтому раскладка, цвета и факты на карте сайта
и в окне приложения совпадают.

Раньше карта приложения рисовалась Plotly, а рядом с окном открывался
автономный HTML с three.js; от него отказались в пользу сцены во вкладке, так
что модуль отвечает только за данные и оформление (цвета, подписи, формат
чисел) — их читает и вкладка, и рендерер Tk.

Минимум, который нужен этому модулю: `orrery.py` (раскладка) и `system_map.py`
(снимок системы).
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import orrery
import system_map as system_map_module
from system_map import (
    KIND_MOON,
    KIND_STAR,
    MapBody,
    MapSnapshot,
    MapStation,
    PlayerPosition,
)

# Версия контракта пакета данных (см. `ORRERY_VIEW_VERSION` в types.ts).
VIEW_VERSION = 3


# ─────────────────────────── цвета и подписи ───────────────────────────────
#: Цвета классов планет — те же строки, что в `src/lib/orrery3d/palette.ts`.
BODY_CLASS_COLORS: Tuple[Tuple[str, str], ...] = (
    ("earthlike", "#2ecc71"),
    ("water world", "#3498db"),
    ("water", "#3498db"),
    ("ammonia", "#b39ddb"),
    ("metal-rich", "#e67e22"),
    ("metal", "#e67e22"),
    ("high", "#f1c40f"),
    ("rich", "#f1c40f"),
    ("rocky", "#a08c7d"),
    ("icy", "#9fd8ef"),
    ("gas giant", "#ff9f43"),
    ("gas", "#ff9f43"),
    ("helium", "#48dbfb"),
    ("sudarsky class i", "#8fb8de"),
    ("sudarsky class ii", "#9fc9e8"),
    ("sudarsky class iii", "#c2a37a"),
    ("sudarsky class iv", "#a8746a"),
    ("sudarsky class v", "#6b5b4c"),
    ("thargoid", "#7ee787"),
)
BODY_FALLBACK_COLOR = "#8d99ae"
STAR_FALLBACK_COLOR = "#ffd166"
HABITABLE_ZONE_COLOR = "#2ecc71"
STRUCTURE_ACTIVE_COLOR = "#ff9f43"
STRUCTURE_COMPLETE_COLOR = "#2ecc71"
STRUCTURE_PLANNED_COLOR = "#64748b"

#: Цвета звёзд по спектральному классу (когда температуры нет).
STAR_SPECTRAL_COLORS: Dict[str, str] = {
    "O": "#9bb0ff", "B": "#bbccff", "A": "#f8f9fa", "F": "#fff4e8", "G": "#ffd166",
    "K": "#ff9e42", "M": "#ff5533", "L": "#b8432a", "T": "#8b2a1a", "Y": "#5c1b12",
    "N": "#00d4ff", "NEUTRON": "#00d4ff", "H": "#4a0e4e", "W": "#66aaff",
    "WN": "#5599ff", "WC": "#3377ff", "C": "#ff4422", "S": "#ff6633",
    "D": "#d8f0ff", "MS": "#ff7755", "AEBE": "#ccccff", "TTS": "#ff8844",
}


def body_color(body: Any) -> str:
    """Цвет тела: у звезды — по температуре/классу, у планеты — по классу.

    Принимает и `MapBody`, и плоский view из `orrery.plan_system`: приложение
    рисует холст по снимку, а HTML-экспорт — по раскладке, и цвет обязан
    совпадать, иначе одна и та же планета в двух окнах будет разной.
    """
    if hasattr(body, "is_star"):
        is_star = bool(body.is_star)
        star_type = body.star_type or body.body_class
        temp_k = body.surface_temp_k
        source = f"{body.body_class} {body.star_type}".lower()
    else:
        is_star = body.get("kind") == "star"
        star_type = str(body.get("star_type") or body.get("class") or "")
        temp_k = _as_float(body.get("surface_temp_k"))
        source = f"{body.get('class') or ''} {body.get('star_type') or ''}".lower()
    if is_star:
        return get_star_color(str(star_type or ""), temp_k)
    if not source.strip():
        return BODY_FALLBACK_COLOR
    for key, color in sorted(BODY_CLASS_COLORS, key=lambda item: -len(item[0])):
        if key in source:
            return color
    if "gas" in source or "sudarsky" in source:
        return "#ffb066"
    if "high metal" in source:
        return "#c9a227"
    return BODY_FALLBACK_COLOR


#: Прежнее имя: цвет тела по плоскому view (использовалось старым экспортом).
body_color_station_view = body_color


def get_star_color(star_type: str, temp_k: float = 0.0) -> str:
    """Цвет звезды: приоритет — настоящая температура (как на сайте).

    Спектральный класс остаётся запасным вариантом для записей без температуры,
    иначе сцена в окне и сайт показывали бы одну звезду разными цветами.
    """
    by_temperature = orrery.star_color_from_temperature(_as_float(temp_k, 0.0))
    if by_temperature:
        return by_temperature
    clean = str(star_type or "").strip()
    if not clean:
        return STAR_FALLBACK_COLOR
    upper = clean.upper()
    for prefix, color in sorted(STAR_SPECTRAL_COLORS.items(), key=lambda item: -len(item[0])):
        if upper.startswith(prefix):
            return color
    return STAR_FALLBACK_COLOR


def get_ring_color(ring_class: str) -> str:
    """Цвет кольца по его типу."""
    low = str(ring_class or "").lower()
    if "icy" in low:
        return "#9fd8ef"
    if "rich" in low:
        return "#e67e22"
    if "metal" in low:
        return "#f1c40f"
    if "rock" in low:
        return "#a08c7d"
    return "#b4c8dc"


def structure_color(progress: float, complete: bool, required_tons: float = 0.0) -> str:
    """Цвет маркера постройки по её состоянию (совпадает с palette.ts)."""
    if complete or progress >= 100:
        return STRUCTURE_COMPLETE_COLOR
    if progress > 0 or required_tons > 0:
        return STRUCTURE_ACTIVE_COLOR
    return STRUCTURE_PLANNED_COLOR


def _as_float(value: Any, default: float = 0.0) -> float:
    """Число из чего угодно — поля приходят и строками, и None."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(result) or math.isinf(result):
        return default
    return result


def _as_int(value: Any, default: int = 0) -> int:
    return int(_as_float(value, float(default)))


def format_number(value: Any, digits: int = 1) -> str:
    """«12 345,6» — единый формат чисел в карточках и подсказках."""
    number = _as_float(value, float("nan"))
    if math.isnan(number):
        return "—"
    text = f"{number:,.{digits}f}".replace(",", " ")
    return text.replace(".", ",")


def format_tons(value: Any) -> str:
    """Тоннаж: «12 345 т»."""
    number = _as_float(value, float("nan"))
    if math.isnan(number):
        return "—"
    return f"{round(number):,} т".replace(",", " ")


def format_distance(distance_ls: float) -> str:
    """Расстояние: световые секунды, километры и астрономические единицы."""
    distance = max(0.0, _as_float(distance_ls, 0.0))
    if distance <= 0:
        return "—"
    if distance < 0.1:
        return f"{distance * 299792.458:,.0f} км".replace(",", " ")
    if distance < 1000:
        return f"{distance:,.1f} св. с ({distance * 299792.458:,.0f} км)".replace(",", " ")
    au = distance / 499.00478
    return f"{distance:,.0f} св. с ({au:.2f} а.е.)".replace(",", " ")


def format_radius(radius_m: float) -> str:
    """Радиус тела: километры, для звёзд — радиусы Солнца."""
    radius_km = _as_float(radius_m, 0.0) / 1000.0
    if radius_km <= 0:
        return "—"
    if radius_km >= 696340:
        return f"{radius_km / 696340.0:.2f} R☉ ({radius_km:,.0f} км)".replace(",", " ")
    return f"{radius_km:,.0f} км".replace(",", " ")


def format_temp(temp_k: float) -> str:
    """Температура в Кельвинах и Цельсиях."""
    kelvin = _as_float(temp_k, 0.0)
    if kelvin <= 0:
        return "—"
    return f"{kelvin:,.0f} K ({kelvin - 273.15:+,.0f} °C)".replace(",", " ")


def format_gravity(gravity: float) -> str:
    """Гравитация в м/с² и в g."""
    value = _as_float(gravity, 0.0)
    if value <= 0:
        return "—"
    return f"{value:.2f} м/с² ({value / 9.80665:.2f} g)"


def format_period(days: float) -> str:
    """Период обращения: часы, сутки или годы."""
    value = _as_float(days, 0.0)
    if value <= 0:
        return "—"
    if value >= 365.25:
        return f"{value / 365.25:.2f} лет".replace(".", ",")
    if value >= 1:
        return f"{value:.1f} сут".replace(".", ",")
    return f"{value * 24:.1f} ч".replace(".", ",")


def build_progress_bar(progress_pct: float, length: int = 12) -> str:
    """Текстовый прогресс-бар для строк списка и статуса."""
    percent = max(0.0, min(100.0, _as_float(progress_pct, 0.0)))
    filled = int(round((percent / 100.0) * length))
    return "█" * filled + "░" * max(0, length - filled) + f" {percent:.1f}%"


def estimate_habitable_zone_ls(star: Optional[MapBody]) -> Optional[Tuple[float, float]]:
    """Обитаемая зона звезды в световых секундах (0.75–1.77 а.е. × √L)."""
    if star is None or not star.is_star:
        return None
    return orrery.habitable_zone_ls({
        "radius_m": star.radius_m,
        "surface_temp_k": star.surface_temp_k,
    })


def normalize_view_mode(view_mode: Any) -> str:
    """«2d»/«плоско» → «2d», всё остальное → «3d» (совместимость с конфигом)."""
    text = str(view_mode or "").strip().lower()
    if text in ("2d", "flat", "top", "плоско", "сверху"):
        return "2d"
    return "3d"


def short_label(name: str, system: str = "") -> str:
    """Короткое имя тела: без префикса системы.

    Длинные имена («HD 183092 B 5 A 3») не влезают ни в подписи карты, ни в
    карточки, поэтому префикс системы срезается.
    """
    text = str(name or "")
    prefix = str(system or "").strip()
    if prefix and text.lower().startswith(prefix.lower()):
        tail = text[len(prefix):].strip()
        if tail:
            return tail
    return text


#: Прежнее имя — зеркало `shortBodyName` из palette.ts.
short_name = short_label


# ─────────────────────────── пакет для рендерера ───────────────────────────
def build_view_payload(
    snapshot: MapSnapshot,
    scale_mode: str = "orrery",
    show_moons: bool = True,
    selected: str = "",
    zoom: int = 0,
    player: Optional[PlayerPosition] = None,
) -> Dict[str, Any]:
    """Свернуть снимок системы в пакет для JS-рендерера.

    Структура совпадает с `OrreryViewPayload` из `src/lib/orrery3d/types.ts`:
    координаты — в unit'ах сцены (Z вверх), у каждого тела полный набор фактов,
    орбиты — готовыми полилиниями, постройки — точками на поверхности тела.
    """
    system_name = snapshot.system or ""
    # Пилота можно не передавать: в снимке он уже есть — иначе сцена теряла бы
    # метку «вы здесь» при вызове без явного игрока.
    if player is None:
        player = getattr(snapshot, "player", None)
    plan = orrery.plan_system(
        snapshot.bodies, system_name, scale_mode=scale_mode,
        show_moons=show_moons, extra_marks=len(snapshot.stations or []),
    )
    span = float(plan["span"])
    canvas_px = float(orrery.CANVAS_PX)
    markers = plan["markers"]

    # Постройки сажаем на символическую сферу тела — тогда при любом
    # приближении они остаются «на поверхности», как на сайте.
    sphere_radii = {
        view["name"]: orrery.body_display_radius_units(markers, view["name"], span, canvas_px)
        for view in plan["bodies"] if view["kind"] != "star"
    }
    stations = [
        {
            "name": station.name or station.build_name or "",
            "body_name": station.body_name or "",
            "kind": station.kind,
            "is_site": bool(station.is_site),
            "complete": bool(station.complete),
            "station": station,
        }
        for station in (snapshot.stations or [])
    ]
    placements = orrery.place_stations(plan, stations, span, canvas_px, sphere_radii)

    # Обитаемые зоны: раскладка отдаёт центральную окружность, карте нужна полоса.
    zones: List[Dict[str, Any]] = []
    hz_ls: Dict[str, Tuple[float, float]] = {}
    for path in plan["hz_paths"]:
        star = plan["by_name"].get(path["owner"])
        if star is None:
            continue
        zone_ls = orrery.habitable_zone_ls(star)
        hz_ls[path["owner"]] = zone_ls
        mid_ls = (zone_ls[0] + zone_ls[1]) / 2.0
        scale = path["radius"] / mid_ls if mid_ls > 0 else 0.0
        if scale <= 0:
            continue
        zones.append({
            "owner": path["owner"],
            "center": _round3(path["center"]),
            "inner": round(zone_ls[0] * scale, 4),
            "outer": round(zone_ls[1] * scale, 4),
            "innerLs": round(zone_ls[0], 2),
            "outerLs": round(zone_ls[1], 2),
        })

    stations_by_body: Dict[str, List[Dict[str, Any]]] = {}
    view_structures: List[Dict[str, Any]] = []
    for placement in placements:
        station: MapStation = placement.get("station")
        progress = _station_progress_percent(station)
        required = _as_float(getattr(station, "required_tons", 0) or 0)
        provided = _as_float(getattr(station, "provided_tons", 0) or 0)
        complete = bool(getattr(station, "complete", False)) or progress >= 100
        structure = {
            "id": str(getattr(station, "build_id", "") or f"station-{len(view_structures)}"),
            "name": str(getattr(station, "title", "") or getattr(station, "name", "")
                        or getattr(station, "build_name", "") or "Объект"),
            "type": str(getattr(station, "build_type", "") or getattr(station, "station_type", "") or ""),
            "body": str(placement.get("anchor") or ""),
            "position": _round3(placement["position"]),
            "onSurface": bool(placement.get("on_surface")),
            "progress": round(progress, 2),
            "complete": complete,
            "requiredTons": round(required, 2),
            "providedTons": round(provided, 2),
            "remainingTons": round(max(0.0, required - provided), 2),
            "resources": _station_resources(station),
        }
        view_structures.append(structure)
        if structure["body"]:
            stations_by_body.setdefault(structure["body"], []).append(structure)

    cluster_of = {}
    for cluster in plan["clusters"]:
        for name in cluster["bodies"]:
            cluster_of[name] = cluster["star"]
    star_names = {star["name"] for star in plan["stars"]}

    bodies: List[Dict[str, Any]] = []
    for view in plan["bodies"]:
        name = view["name"]
        is_star = view["kind"] == "star"
        # Луны выключены — их не только не раскладывают, но и не показывают:
        # иначе они собрались бы в центре системы точкой без орбиты.
        if view["kind"] == "moon" and not show_moons:
            continue
        owner = name if is_star else cluster_of.get(name, "")
        if owner and owner not in star_names:
            owner = ""
        zone = hz_ls.get(owner) if owner else None
        if zone is None and owner:
            owner_body = plan["by_name"].get(owner)
            zone = orrery.habitable_zone_ls(owner_body) if owner_body else None
        orbit_ls = _as_float(view.get("orbit_ls")) or _as_float(view.get("distance_ls"))
        # Обитаемая зона считается от звезды: у луны сравнивать с ней нужно
        # орбиту её планеты, а не радиус обращения вокруг планеты.
        star_orbit_ls = orbit_ls
        if view["kind"] == "moon":
            parent = plan["by_name"].get(_parent_name(plan, view))
            star_orbit_ls = (_as_float(getattr(parent, "get", lambda *_: None)("orbit_ls"))
                             if parent else 0.0) or _as_float(view.get("distance_ls"))
        bodies.append({
            "name": name,
            "shortName": short_label(name, system_name) or name,
            "kind": view["kind"],
            "cls": str(view.get("class") or ""),
            "star": owner,
            "parent": _parent_name(plan, view) if not is_star else ("" if _is_primary(plan, name) else _primary_name(plan)),
            "position": _round3(plan["positions"].get(name, (0.0, 0.0, 0.0))),
            "radius": 0.0 if is_star else round(sphere_radii.get(name, 0.0), 4),
            "marker": round(_as_float(markers.get(name), 8.0), 3),
            "radiusM": round(_as_float(view.get("radius_m")), 2),
            "gravity": round(_as_float(view.get("gravity")), 3),
            "tempK": round(_as_float(view.get("surface_temp_k")), 2),
            "pressureAtm": round(_as_float(view.get("pressure_atm")), 4),
            "distanceLs": round(_as_float(view.get("distance_ls")), 2),
            "orbitLs": round(orbit_ls, 2),
            "atmosphere": str(view.get("atmosphere") or ""),
            "volcanism": str(view.get("volcanism") or ""),
            "landable": bool(view.get("landable")),
            "bioSignals": _as_int(view.get("bio_signals")),
            "mapped": bool(view.get("mapped")),
            "scanned": bool(view.get("scanned", True)),
            "rings": [
                {
                    "name": str(ring.get("name") or "Кольцо"),
                    "ringClass": str(ring.get("class") or "Icy"),
                    "innerKm": round(_as_float(ring.get("inner_km")), 2),
                    "outerKm": round(_as_float(ring.get("outer_km")), 2),
                }
                for ring in (view.get("rings") or [])
            ],
            "elements": {
                "eccentricity": round(min(0.98, max(0.0, _as_float(view.get("eccentricity")))), 5),
                "inclinationDeg": round(_as_float(view.get("orbital_inclination")), 3),
                "periapsisDeg": round(_as_float(view.get("arg_of_periapsis")), 3),
                "meanAnomalyDeg": round(_as_float(view.get("mean_anomaly_deg")), 3),
                "periodDays": round(_as_float(view.get("orbital_period_days")), 4),
                "axialTiltDeg": round(_as_float(view.get("axial_tilt_deg")), 3),
                "real": bool(orrery.has_real_elements(view)),
            },
            "firstDiscoveredBy": str(view.get("first_discovered_by") or ""),
            "firstMappedBy": str(view.get("first_mapped_by") or ""),
            "firstFootfallBy": str(view.get("first_footfall_by") or ""),
            "color": body_color_station_view(view),
            "habitableBand": _habitable_band(star_orbit_ls, zone),
            "habitableZoneLs": ([round(zone[0], 2), round(zone[1], 2)] if zone else None),
            "structures": [item["id"] for item in stations_by_body.get(name, [])],
        })

    orbits = [
        _orbit_payload(path) for path in plan["orbits"]
        if path.get("kind") in ("star", "planet")
    ]
    moon_orbits = [_orbit_payload(path) for path in plan["moon_orbits"]] if show_moons else []

    real_bodies = [body for body in bodies if body["kind"] != "star"]
    active = [structure for structure in view_structures if not structure["complete"]]
    summary = {
        "stars": len(plan["stars"]),
        "planets": len([body for body in real_bodies if body["kind"] != "moon"]),
        "moons": len([body for body in real_bodies if body["kind"] == "moon"]),
        "bodies": len(bodies),
        "landable": len([body for body in real_bodies if body["landable"]]),
        "bioBodies": len([body for body in real_bodies if body["bioSignals"] > 0]),
        "bioSignals": sum(body["bioSignals"] for body in real_bodies),
        "ringed": len([body for body in bodies if body["rings"]]),
        "structures": len(view_structures),
        "activeSites": len(active),
        "completedSites": len(view_structures) - len(active),
        "unscanned": len([body for body in real_bodies if not body["scanned"]]),
    }

    return {
        "version": VIEW_VERSION,
        "system": system_name,
        "span": span,
        "scaleMode": "linear" if str(scale_mode) == "linear" else "orrery",
        "crowded": bool(plan.get("crowded")),
        "summary": summary,
        "clusters": [
            {"star": cluster["star"], "center": _round3(cluster["center"]),
             "bodies": list(cluster["bodies"])}
            for cluster in plan["clusters"]
        ],
        "bodies": bodies,
        "orbits": orbits,
        "moonOrbits": moon_orbits,
        "zones": zones,
        "structures": view_structures,
        "player": _player_payload(player, plan),
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        # Поля ниже рендерер не читает: они нужны интерфейсу приложения
        # (стартовый фокус, уровень приближения, подписи).
        "startFocus": _match_body(plan, selected),
        "startZoom": max(0, min(3, int(_as_float(zoom, 0)))),
    }


def _station_progress_percent(station: Optional[MapStation]) -> float:
    """Готовность постройки в процентах: 0..100 (в MapStation — доли и проценты)."""
    if station is None:
        return 0.0
    percent = getattr(station, "percent_delivered", None)
    if percent is not None:
        return max(0.0, min(100.0, _as_float(percent)))
    progress = getattr(station, "progress", None)
    if progress is None:
        return 100.0 if getattr(station, "complete", False) else 0.0
    value = _as_float(progress)
    if value <= 1.0:
        value *= 100.0
    return max(0.0, min(100.0, value))


def _station_resources(station: Optional[MapStation]) -> List[Dict[str, Any]]:
    """Остатки по товарам: строка списка в подсказке постройки."""
    if station is None:
        return []
    labels = getattr(system_map_module, "COMMODITY_LABELS_RU", {}) or {}
    rows: List[Dict[str, Any]] = []
    for commodity, remaining in (getattr(station, "remaining_by_commodity", None) or {}).items():
        key = str(commodity)
        rows.append({
            # Ключи Raven — «слепые» строчные имена (`liquidoxygen`); в карточке
            # и подсказке показываем человеческое название, как в сводке.
            "name": str(labels.get(key.lower(), key)),
            "key": key,
            "required": round(_as_float(remaining), 2),
            "provided": 0.0,
            "remaining": round(_as_float(remaining), 2),
        })
    rows.sort(key=lambda item: -item["remaining"])
    return rows


def _orbit_payload(path: Dict[str, Any]) -> Dict[str, Any]:
    """Орбита: полилиния + метаданные (совпадает с OrreryViewOrbit)."""
    return {
        "name": str(path.get("name") or path.get("owner") or ""),
        "owner": str(path.get("owner") or ""),
        "kind": str(path.get("kind") or "planet"),
        "center": _round3(path.get("center") or (0.0, 0.0, 0.0)),
        "radius": round(_as_float(path.get("radius")), 4),
        "eccentricity": round(_as_float(path.get("eccentricity")), 5),
        "real": bool(path.get("real")),
        "periodDays": round(_as_float(path.get("period_days")), 4),
        "points": [_round3(point) for point in (path.get("points") or [])],
    }


def _player_payload(player: Optional[PlayerPosition], plan: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Где пилот: точка на карте рядом с его телом, иначе — у центра системы."""
    if player is None or not player.system:
        return None
    body_name = _match_body(plan, player.body_name or "")
    position = plan["positions"].get(body_name) if body_name else None
    if position is None:
        position = (0.0, 0.0, 0.0)
    return {
        "name": player.station_name or player.ship_name or body_name or "Вы здесь",
        "position": _round3(position),
        "body": body_name or "",
        "station": player.station_name or "",
    }


def _habitable_band(orbit_ls: float, zone: Optional[Tuple[float, float]]) -> Optional[str]:
    """Где тело относительно обитаемой зоны: внутри, в зоне или снаружи."""
    if not zone or orbit_ls <= 0:
        return None
    inner, outer = zone
    if inner <= 0 or outer <= inner:
        return None
    if orbit_ls < inner:
        return "inner"
    if orbit_ls > outer:
        return "outer"
    return "habitable"


def _parent_name(plan: Dict[str, Any], view: Dict[str, Any]) -> str:
    """Имя родителя: у луны — планета, у планеты — звезда."""
    by_name = plan["by_name"]
    for parent_id in view.get("parent_ids") or []:
        parent = plan.get("by_id", {}).get(parent_id) if isinstance(plan.get("by_id"), dict) else None
        if parent is None:
            parent = next((row for row in plan["bodies"] if row.get("body_id") == parent_id), None)
        if parent is not None:
            return str(parent.get("name") or "")
    owner = _match_body(plan, view.get("name") or "")
    cluster = next((row for row in plan["clusters"]
                    if owner and owner in row["bodies"]), None)
    if cluster:
        return str(cluster.get("star") or "")
    if view.get("parent_name"):
        return str(view["parent_name"])
    return ""


def _is_primary(plan: Dict[str, Any], name: str) -> bool:
    stars = plan.get("stars") or []
    return bool(stars) and stars[0].get("name") == name


def _primary_name(plan: Dict[str, Any]) -> str:
    stars = plan.get("stars") or []
    return str(stars[0].get("name") or "") if stars else ""


def _match_body(plan: Dict[str, Any], name: str) -> str:
    """Найти тело по «свободному» имени (Raven присылает имена без системы)."""
    matched = orrery._match_body(plan, name)
    return matched or ""


def _round3(point: Sequence[Any]) -> List[float]:
    values = list(point or ())[:3]
    while len(values) < 3:
        values.append(0.0)
    return [round(_as_float(value), 4) for value in values]
