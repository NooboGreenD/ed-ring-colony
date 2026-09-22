"""3D-карта системы для Colonial Helper: пакет данных и автономный HTML.

Модуль — питоновская половина общего движка карты. Сайт собирает пакет в
`src/lib/orrery3d/payload.ts`, приложение — здесь; структура одна и та же
(`ORRERY_VIEW_VERSION`), а рисует обе карты один и тот же рендерер three.js из
`uploader/assets/orrery-viewer.js` (сборка `npm run viewer:build` из
`src/lib/orrery3d`).

Раньше карта приложения рисовалась Plotly: графиковая библиотека тянула 3.5 МБ
на автономный файл, подписи и камеру приходилось «дожимать» через relayout, а
вид карты в приложении (Tk-холст) и в браузере расходился. Теперь браузерная
карта совпадает с сайтом, а Plotly в проекте не нужен вовсе.

Минимум, который нужен этому модулю: `orrery.py` (раскладка) и `system_map.py`
(снимок системы).
"""

from __future__ import annotations

import json
import math
import os
import string
import sys
import tempfile
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
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

# Версия контракта с JS-рендерером (см. `ORRERY_VIEW_VERSION` в types.ts).
VIEW_VERSION = 3

#: Имя файла сборки рендерера внутри пакета приложения.
VIEWER_BUNDLE = "orrery-viewer.js"

#: Запасной путь: сборка лежит рядом с исходниками (запуск из репозитория).
VIEWER_BUNDLE_FALLBACK = Path(__file__).resolve().parent / "assets" / VIEWER_BUNDLE


def _asset_paths() -> List[Path]:
    """Где искать сборку рендерера: и в exe (PyInstaller), и из исходников."""
    paths: List[Path] = []
    base = getattr(sys, "_MEIPASS", "")
    if base:
        paths.append(Path(base) / "assets" / VIEWER_BUNDLE)
        paths.append(Path(base) / VIEWER_BUNDLE)
    paths.append(VIEWER_BUNDLE_FALLBACK)
    paths.append(Path.cwd() / "assets" / VIEWER_BUNDLE)
    return paths


def viewer_script() -> Optional[str]:
    """Прочитать сборку рендерера (None — файла нет, карта деградирует до списка)."""
    for path in _asset_paths():
        try:
            if path.is_file():
                return path.read_text(encoding="utf-8")
        except OSError:
            continue
    return None


def viewer_contract() -> Optional[int]:
    """Версия контракта, с которой собрана сборка рендерера (из её заголовка)."""
    script = viewer_script()
    if not script:
        return None
    for line in script.splitlines()[:6]:
        marker = "contract="
        if marker in line:
            tail = line.split(marker, 1)[1]
            digits = ""
            for char in tail:
                if char.isdigit():
                    digits += char
                else:
                    break
            if digits:
                return int(digits)
    return None


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
    иначе автономная карта и сайт показывали бы одну звезду разными цветами.
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
    # Пилота можно не передавать: в снимке он уже есть — иначе автономный HTML
    # терял бы метку «вы здесь» при вызове без явного игрока.
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


# ──────────────────────────── автономный HTML ──────────────────────────────
CARD_RAIL_CSS = """
* { box-sizing: border-box; }
body { margin: 0; background: #05070d; color: #e6eef8; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between;
  padding: 10px 14px; background: #0b0e14; border-bottom: 1px solid #1e293b; }
.sys-name { font-size: 18px; font-weight: 700; color: #ff9f43; letter-spacing: .4px; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.badge { font-size: 11px; padding: 2px 7px; border-radius: 4px; background: #16202e; border: 1px solid #2b3a4d; color: #cbd5e1; }
.badge.orange { color: #ff9f43; border-color: #e67e22; background: rgba(230,126,34,.16); }
.badge.green { color: #2ecc71; border-color: #2ecc71; background: rgba(46,204,113,.14); }
.badge.cyan { color: #00f3ff; border-color: #00f3ff; background: rgba(0,243,255,.12); }
.controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.btn { padding: 5px 10px; border-radius: 6px; background: #16202e; color: #e6eef8; border: 1px solid #2b3a4d;
  font-size: 11.5px; cursor: pointer; text-decoration: none; display: inline-flex; gap: 5px; align-items: center; }
.btn:hover { background: #223247; }
.btn[data-on="1"] { background: rgba(230,126,34,.22); border-color: #e67e22; color: #ff9f43; font-weight: 600; }
.btn.primary { background: rgba(0,243,255,.12); border-color: rgba(0,243,255,.5); color: #00f3ff; }
select.btn { padding-right: 4px; }
main { display: flex; align-items: stretch; min-height: 0; height: calc(100vh - 112px); }
#map { flex: 1 1 auto; min-width: 0; }
aside { flex: 0 0 340px; width: 340px; border-left: 1px solid #1e293b; background: #0b0e14; display: flex; flex-direction: column; min-height: 0; }
.rail-head { padding: 8px 10px; border-bottom: 1px solid #1e293b; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
#cards { overflow-y: auto; padding: 8px 10px 24px; flex: 1; min-height: 0; }
#cards::-webkit-scrollbar { width: 8px; }
#cards::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }
.cluster h4 { font-size: 11px; color: #ffd166; text-transform: uppercase; margin: 10px 0 6px; letter-spacing: .4px; }
.cluster h4 small { color: #64748b; font-weight: 400; text-transform: none; }
.card { background: #12161f; border: 1px solid #1e293b; border-radius: 7px; padding: 8px 9px; margin-bottom: 6px; cursor: pointer; }
.card:hover { border-color: #e67e22; }
.card[data-target="1"] { border-color: #00f3ff; box-shadow: 0 0 0 1px rgba(0,243,255,.25) inset; }
.card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.card-title { font-size: 12.5px; font-weight: 600; color: #f8fafc; }
.card-kind { font-size: 10px; color: #64748b; text-transform: uppercase; }
.card-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; line-height: 1.35; }
.tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 5px; }
.tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #1e293b; color: #cbd5e1; }
.tag.cyan { color: #00f3ff; background: rgba(0,243,255,.12); }
.tag.green { color: #2ecc71; background: rgba(46,204,113,.14); }
.tag.orange { color: #ff9f43; background: rgba(230,126,34,.16); }
.sites { margin-top: 6px; display: grid; gap: 4px; }
.site { background: #0f131b; border: 1px solid #1e293b; border-radius: 5px; padding: 4px 6px; }
.site-head { display: flex; justify-content: space-between; font-size: 11px; color: #ff9f43; gap: 6px; }
.bar { height: 4px; background: #1e293b; border-radius: 2px; margin-top: 3px; overflow: hidden; }
.bar i { display: block; height: 100%; }
.empty { color: #64748b; font-size: 12px; padding: 14px 4px; }
footer { padding: 6px 14px; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; display: flex; gap: 12px; flex-wrap: wrap; }
.hint { color: #8fa3bf; }
@media (max-width: 980px) {
  main { flex-direction: column; height: auto; }
  #map { height: 62vh; }
  aside { flex: 1 1 auto; width: 100%; border-left: none; border-top: 1px solid #1e293b; max-height: 46vh; }
}
"""


def _stations_by_body(snapshot: MapSnapshot) -> Dict[str, List[MapStation]]:
    grouped: Dict[str, List[MapStation]] = {}
    for station in snapshot.stations or []:
        grouped.setdefault(str(station.body_name or ""), []).append(station)
    return grouped


def cards_html(snapshot: MapSnapshot, payload: Dict[str, Any]) -> str:
    """Правая колонка автономного HTML: тела по кластерам со своими стройками.

    Раньше это была одна длинная лента без поиска; теперь у неё есть фильтр и
    поиск (см. JS страницы), а клик по карточке ставит фокус на 3D-сцене.
    """
    by_body = {body.name: body for body in snapshot.bodies or []}
    structures_by_body: Dict[str, List[Dict[str, Any]]] = {}
    for structure in payload["structures"]:
        if structure["body"]:
            structures_by_body.setdefault(structure["body"], []).append(structure)

    blocks: List[str] = []
    for cluster in payload["clusters"]:
        cards: List[str] = []
        star = by_body.get(cluster.get("star") or "")
        if star is not None:
            cards.append(_card_html(star, structures_by_body.get(star.name, []), snapshot))
        for name in cluster["bodies"]:
            body = by_body.get(name)
            if body is None:
                continue
            cards.append(_card_html(body, structures_by_body.get(name, []), snapshot))
        if not cards:
            continue
        title = short_label(cluster.get("star") or "", snapshot.system or "") or "без звезды"
        blocks.append(
            f'<section class="cluster"><h4>★ {title} <small>{len(cluster["bodies"])} тел</small></h4>'
            + "".join(cards) + "</section>"
        )
    loose = [structure for structure in payload["structures"] if not structure["body"]]
    if loose:
        rows = "".join(
            f'<div class="card" data-name="{_attr(structure["name"])}"><div class="card-head">'
            f'<span class="card-title">{_escape(structure["name"])}</span>'
            f'<span class="card-kind">вне тела</span></div>'
            f'<div class="card-sub">{_escape(structure["type"] or "объект")}</div></div>'
            for structure in loose
        )
        blocks.append('<section class="cluster"><h4>Объекты без привязки к телу</h4>' + rows + "</section>")
    if not blocks:
        return ('<div class="empty">Нет данных о телах системы. Отсканируйте систему (FSS/DSS) — '
                "карта и карточки наполнятся.</div>")
    return "".join(blocks)


def _card_html(body: MapBody, structures: List[Dict[str, Any]], snapshot: MapSnapshot) -> str:
    """Карточка тела: класс, параметры, метки и стройки с прогрессом."""
    tags: List[str] = []
    if body.landable:
        tags.append('<span class="tag cyan">🛬 посадка</span>')
    if body.bio_signals:
        tags.append(f'<span class="tag green">🌿 {body.bio_signals}</span>')
    if body.rings:
        tags.append(f'<span class="tag">💍 {len(body.rings)}</span>')
    if body.mapped:
        tags.append('<span class="tag">🗺 карта</span>')
    if not body.scanned:
        tags.append('<span class="tag">❔ нет скана</span>')

    details: List[str] = []
    if body.orbit_ls or body.distance_ls:
        details.append(format_distance(body.orbit_ls or body.distance_ls))
    if body.radius_m:
        details.append(format_radius(body.radius_m))
    if body.gravity:
        details.append(f"{body.gravity / 9.80665:.2f} g")
    if body.surface_temp_k:
        details.append(format_temp(body.surface_temp_k))
    if body.atmosphere:
        details.append(str(body.atmosphere))

    sites_html = ""
    if structures:
        rows: List[str] = []
        for structure in structures:
            color = structure_color(structure["progress"], structure["complete"], structure["requiredTons"])
            width = max(0.0, min(100.0, structure["progress"]))
            state = "готово" if structure["complete"] else f'{structure["progress"]:.0f}%'
            rows.append(
                '<div class="site"><div class="site-head"><span>{name}</span><b>{state}</b></div>'
                '<div class="bar"><i style="width:{width:.0f}%;background:{color}"></i></div>'
                "{remaining}</div>".format(
                    name=_escape(structure["name"]),
                    state=state,
                    width=width,
                    color=color,
                    remaining=(f'<div style="font-size:10px;color:#94a3b8">осталось '
                               f'{format_tons(structure["remainingTons"])}</div>'
                               if structure["remainingTons"] > 0 else ""),
                )
            )
        sites_html = '<div class="sites">' + "".join(rows) + "</div>"

    kind_label = {"star": "звезда", "planet": "планета", "moon": "луна"}.get(body.kind, "тело")
    return (
        '<div class="card" data-name="{name}" data-kind="{kind}">'
        '<div class="card-head"><span class="card-title">{title}</span>'
        '<span class="card-kind">{kind_label}</span></div>'
        '<div class="card-sub">{details}</div>'
        '<div class="tags">{tags}</div>{sites}</div>'
    ).format(
        name=_attr(body.name),
        kind=body.kind,
        title=_escape(short_label(body.name, snapshot.system or "")),
        kind_label=kind_label,
        details=" · ".join(details) or _escape(body.body_class or body.star_type or ""),
        tags="".join(tags),
        sites=sites_html,
    )


def _escape(text: Any) -> str:
    return (str(text or "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _attr(text: Any) -> str:
    return _escape(text).replace('"', "&quot;")


def generate_map_html(
    snapshot: MapSnapshot,
    scale_mode: str = "orrery",
    show_moons: bool = True,
    selected: str = "",
    zoom: int = 0,
    view_mode: str = "3d",
    labels: bool = False,
    title: Optional[str] = None,
    player: Optional[PlayerPosition] = None,
    include_viewer: bool = True,
) -> str:
    """Собрать автономный HTML с 3D-картой системы.

    Пакет данных и движок лежат прямо в файле: карта работает без сети и без
    Python (можно отправить товарищу по эскадрилье), а тот же движок рисует
    карту на сайте.
    """
    payload = build_view_payload(
        snapshot, scale_mode=scale_mode, show_moons=show_moons,
        selected=selected, zoom=zoom, player=player,
    )
    payload_json = json.dumps(payload, ensure_ascii=False)
    summary = payload["summary"]
    sys_name = snapshot.system or "Система"
    script = viewer_script() if include_viewer else None
    contract = viewer_contract() if include_viewer else VIEW_VERSION
    if script is None:
        viewer_block = (
            '<div style="padding:18px;color:#f0b37e;font-size:12.5px">'
            "Сборка 3D-карты не найдена рядом с программой "
            f"(<code>assets/{VIEWER_BUNDLE}</code>). Список тел и построек справа работает, "
            "карту можно пересобрать командой <code>npm run viewer:build</code>."
            "</div>"
        )
    else:
        viewer_block = f"<script>{script}</script>"
    contract_note = ""
    if contract is not None and contract != VIEW_VERSION:
        contract_note = (f'<span class="badge" style="color:#f0b37e">движок v{contract} ≠ данных v{VIEW_VERSION}: '
                         "пересоберите карту (npm run viewer:build)</span>")

    active_sites = summary["activeSites"]
    badges: List[str] = [
        f'<span class="badge">★ {summary["stars"] or "—"}</span>',
        f'<span class="badge">тел: {summary["bodies"]}</span>',
    ]
    if summary["moons"]:
        badges.append(f'<span class="badge">лун: {summary["moons"]}</span>')
    if active_sites:
        badges.append(f'<span class="badge orange">🏗 строек: {active_sites}</span>')
    if summary["landable"]:
        badges.append(f'<span class="badge cyan">🛬 посадка: {summary["landable"]}</span>')
    if summary["bioSignals"]:
        badges.append(f'<span class="badge green">🌿 био: {summary["bioSignals"]}</span>')
    if summary["ringed"]:
        badges.append(f'<span class="badge">💍 кольца: {summary["ringed"]}</span>')
    if summary["unscanned"]:
        badges.append(f'<span class="badge">❔ без скана: {summary["unscanned"]}</span>')

    return string.Template(MAP_TEMPLATE).safe_substitute(
        title=_escape(title or f"Карта системы {sys_name} — Colonial Helper"),
        sys_name=_escape(sys_name),
        badges="".join(badges),
        contract_note=contract_note,
        cards=cards_html(snapshot, payload),
        payload_json=payload_json.replace("</", "<\\/"),
        viewer_block=viewer_block,
        start_focus=json.dumps(payload.get("startFocus") or selected or ""),
        start_zoom=int(payload.get("startZoom") or 0),
        flat="1" if normalize_view_mode(view_mode) == "2d" else "0",
        labels_mode=json.dumps("all" if labels else "auto"),
        css=CARD_RAIL_CSS,
        generated=datetime.now().strftime("%d.%m.%Y %H:%M"),
        version=VIEW_VERSION,
    )


#: Шаблон страницы. `$viewer_block` — сборка движка, `$payload_json` — данные.
MAP_TEMPLATE = """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>$title</title>
<style>$css</style>
</head>
<body>
<header>
  <div>
    <div class="sys-name">🪐 $sys_name</div>
    <div class="badges">$badges$contract_note</div>
  </div>
  <div class="controls">
    <button class="btn" data-zoom="0" title="Вся система">🌌 система</button>
    <button class="btn" data-zoom="1" title="Кластер звезды">⭐ кластер</button>
    <button class="btn" data-zoom="2" title="Тело и соседи">🛰 окрестность</button>
    <button class="btn" data-zoom="3" title="Постройки на поверхности">🏗 поверхность</button>
    <button class="btn" data-view="iso" data-on="1" title="Изометрия">3D</button>
    <button class="btn" data-view="top" title="Вид на плоскость системы">сверху</button>
    <button class="btn" data-view="side" title="Вид вдоль плоскости">сбоку</button>
    <select class="btn" id="filter" title="Оставить только нужные тела">
      <option value="all">все тела</option>
      <option value="sites">со стройками</option>
      <option value="landable">с посадкой</option>
      <option value="bio">с био</option>
      <option value="rings">с кольцами</option>
      <option value="unscanned">без скана</option>
    </select>
    <select class="btn" id="labels" title="Подписи тел">
      <option value="auto">подписи: по ситуации</option>
      <option value="all">подписи: все</option>
      <option value="focus">подписи: только фокус</option>
      <option value="none">подписи: нет</option>
    </select>
    <button class="btn" id="motion" title="Движение тел по орбитам">▶ движение</button>
    <select class="btn" id="speed" title="Скорость времени" hidden>
      <option value="0.25">0,25 сут/с</option>
      <option value="1" selected>1 сут/с</option>
      <option value="4">4 сут/с</option>
      <option value="16">16 сут/с</option>
      <option value="64">64 сут/с</option>
    </select>
    <button class="btn" id="reset-time" title="Вернуться к дате сканов" hidden>⟲ к сканам</button>
    <a class="btn primary" href="https://ravencolonial.com/#sys=$sys_name" target="_blank" rel="noopener">RavenColonial ↗</a>
    <a class="btn" href="https://www.edsm.net/en/system?systemName=$sys_name" target="_blank" rel="noopener">EDSM ↗</a>
  </div>
</header>

<main>
  <div id="map" data-orrery-viewer></div>
  <aside>
    <div class="rail-head">
      <input class="btn" id="search" placeholder="поиск тела…" style="flex:1;min-width:120px" aria-label="Поиск тела">
      <button class="btn" id="only-sites" title="Только тела со стройками">🏗 только со стройками</button>
    </div>
    <div id="cards">$cards</div>
  </aside>
</main>

<footer>
  <span class="hint">колесо — зум · ЛКМ — вращение · ПКМ — панорама · клик по телу — фокус · двойной клик — ближе</span>
  <span class="hint">движок three.js (v$version) · данные от $generated</span>
</footer>

<script type="application/json" data-orrery-payload>$payload_json</script>
$viewer_block
<script>
(function () {
  var container = document.querySelector('[data-orrery-viewer]');
  if (!container) return;
  var startFocus = $start_focus;
  var startZoom = $start_zoom;
  var flat = $flat === 1;
  var labelsMode = $labels_mode;

  // Движок поднимается сам на DOMContentLoaded, а этот скрипт выполняется
  // раньше. Настройки копятся в очереди и уезжают во вьюер, как только он
  // появится: иначе «сверху» и фокус из ссылки терялись бы.
  var pending = [];
  function flush(api) {
    var queue = pending.splice(0);
    for (var i = 0; i < queue.length; i += 1) {
      try { queue[i](api); } catch (error) { /* одна настройка не рушит карту */ }
    }
  }
  function withViewer(fn) {
    var api = container.__orreryViewerMounted;
    if (api) { fn(api); return; }
    pending.push(fn);
    if (pending.length === 1) waitForViewer(0);
  }
  function waitForViewer(tries) {
    var api = container.__orreryViewerMounted;
    if (api) { flush(api); return; }
    if (tries > 120) return;   // 12 секунд: движка нет — карточки и список работают
    setTimeout(function () { waitForViewer(tries + 1); }, 100);
  }

  withViewer(function (api) {
    api.setLabels(labelsMode);
    if (flat) api.setView('top');
    if (startFocus) api.focus(startFocus, startZoom || 2);
    api.on('select', function (pick) {
      markCards(pick && pick.kind === 'body' ? pick.name : (pick && pick.body) || '');
    });
    api.on('state', function (state) {
      document.querySelectorAll('[data-zoom]').forEach(function (button) {
        var active = String(state.zoom) === button.dataset.zoom && (state.focus || state.zoom === 0);
        button.dataset.on = active ? '1' : '0';
      });
      document.querySelectorAll('[data-view]').forEach(function (button) {
        button.dataset.on = state.view === button.dataset.view ? '1' : '0';
      });
      if (state.timeDays) {
        var days = state.timeDays;
        var text = Math.abs(days) >= 365 ? (days / 365.25).toFixed(2) + ' лет'
          : Math.abs(days) >= 1 ? days.toFixed(1) + ' сут' : (days * 24).toFixed(1) + ' ч';
        document.getElementById('motion').textContent = (state.playing ? '⏸ ' : '▶ ') + text + ' от сканов';
      }
    });
  });

  function markCards(name) {
    document.querySelectorAll('#cards .card').forEach(function (card) {
      card.dataset.target = card.dataset.name === name ? '1' : '0';
    });
  }

  document.querySelectorAll('[data-zoom]').forEach(function (button) {
    button.addEventListener('click', function () {
      withViewer(function (api) { api.setZoom(Number(button.dataset.zoom)); });
    });
  });
  document.querySelectorAll('[data-view]').forEach(function (button) {
    button.addEventListener('click', function () {
      withViewer(function (api) { api.setView(button.dataset.view); });
    });
  });
  document.getElementById('filter').addEventListener('change', function (event) {
    withViewer(function (api) { api.setFilter(event.target.value); });
  });
  document.getElementById('labels').addEventListener('change', function (event) {
    withViewer(function (api) { api.setLabels(event.target.value); });
  });
  document.getElementById('motion').addEventListener('click', function () {
    withViewer(function (api) {
      var state = api.getState();
      api.setMotion(!state.playing, Number(document.getElementById('speed').value));
      document.getElementById('speed').hidden = state.playing;
      document.getElementById('reset-time').hidden = state.playing;
    });
  });
  document.getElementById('speed').addEventListener('change', function (event) {
    withViewer(function (api) { api.setMotion(true, Number(event.target.value)); });
  });
  document.getElementById('reset-time').addEventListener('click', function () {
    withViewer(function (api) { api.resetTime(); });
  });
  document.getElementById('only-sites').addEventListener('click', function (event) {
    var button = event.currentTarget;
    var active = button.dataset.on === '1';
    button.dataset.on = active ? '0' : '1';
    document.getElementById('filter').value = active ? 'all' : 'sites';
    withViewer(function (api) { api.setFilter(active ? 'all' : 'sites'); });
  });
  document.getElementById('search').addEventListener('input', function (event) {
    var needle = event.target.value.trim().toLowerCase();
    document.querySelectorAll('#cards .card').forEach(function (card) {
      var name = (card.dataset.name || '').toLowerCase();
      var text = (card.textContent || '').toLowerCase();
      card.style.display = !needle || name.indexOf(needle) >= 0 || text.indexOf(needle) >= 0 ? '' : 'none';
    });
  });
  document.querySelectorAll('#cards .card').forEach(function (card) {
    card.addEventListener('click', function () {
      var name = card.dataset.name || '';
      withViewer(function (api) { api.focus(name); });
      markCards(name);
    });
  });
})();
</script>
</body>
</html>
"""


def export_map_html(snapshot: MapSnapshot, filepath: Any = None, **kwargs: Any) -> Path:
    """Записать автономный HTML-файл карты и вернуть путь к нему."""
    target = Path(filepath) if filepath else None
    if target is None:
        name = f"system_map_{str(snapshot.system or 'system').replace(' ', '_')}.html"
        target = Path(tempfile.gettempdir()) / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(generate_map_html(snapshot, **kwargs), encoding="utf-8")
    return target


def open_map_in_browser(snapshot: MapSnapshot, **kwargs: Any) -> Path:
    """Собрать карту во временный файл и открыть в браузере по умолчанию."""
    path = export_map_html(snapshot, **kwargs)
    webbrowser.open(path.resolve().as_uri())
    return path


#: Совместимость с прежним API (`plotly_map.open_plotly_in_browser`).
open_plotly_in_browser = open_map_in_browser
export_plotly_html = export_map_html


def map_summary_text(snapshot: MapSnapshot, payload: Dict[str, Any]) -> str:
    """Однострочная сводка для статусной строки приложения."""
    summary = payload["summary"]
    parts = [f"★ {summary['stars']}", f"тел {summary['bodies']}"]
    if summary["moons"]:
        parts.append(f"лун {summary['moons']}")
    if summary["structures"]:
        parts.append(f"строек {summary['structures']}")
    if summary["landable"]:
        parts.append(f"посадка {summary['landable']}")
    return " · ".join(parts)
