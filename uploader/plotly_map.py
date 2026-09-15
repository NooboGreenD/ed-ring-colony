"""Интерактивная 3D/2D визуализация карты звездной системы с помощью Plotly.

Предоставляет функции построения интерактивной модели звездной системы (Orrery),
включая:
- Звёзды (спектральные классы, размеры, светимость)
- Орбиты небесных тел (с учетом эксцентриситета и наклонения)
- Планеты всех классов (ELW, WW, AW, HMC, газовые гиганты и т.д.)
- Луны с орбитами вокруг родительских планет
- Станции, аванпосты, поселения и мегакорабли
- Колонизационные стройплощадки с прогресс-барами и списком требуемых ресурсов
- Авианосцы (Fleet Carriers)
- Маркер положения пилота («Вы здесь» / CMDR)
- Богатые интерактивные карточки при наведении (hovertemplate)
- Переключение видов камеры (3D Orrery, вид сверху 2D, вид сбоку)
- Поддержка как 3D, так и 2D режима отображения
- Экспорт в автономный HTML и открытие в браузере
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
    HAS_PLOTLY = True
except ImportError:
    go = None
    HAS_PLOTLY = False

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


def get_star_color(star_type: str) -> str:
    """Вернуть цвет звезды по спектральному коду."""
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


def build_system_geometry(
    snapshot: MapSnapshot,
    scale_mode: str = "orrery",
    show_moons: bool = True,
    is_3d: bool = True,
) -> Dict[str, Any]:
    """Рассчитать координаты звезд, планет, лун, орбит и станций.

    Режимы масштабирования:
    - 'orrery': адаптивно-логарифмический масштаб (все тела отчетливо видны,
      орбиты не слипаются, идеален для интерактивного исследования).
    - 'linear': физический масштаб в св. секундах.
    """
    planets = [b for b in snapshot.bodies if b.kind not in (KIND_STAR, KIND_MOON)]
    stars = [b for b in snapshot.bodies if b.kind == KIND_STAR]
    moons = [b for b in snapshot.bodies if b.kind == KIND_MOON] if show_moons else []

    primary_star = snapshot.star
    other_stars = [s for s in stars if primary_star is None or s.name != primary_star.name]

    # Сортируем планеты по расстоянию
    planets.sort(key=lambda b: (b.orbit_ls or b.distance_ls, b.name))

    # Карта родителей для лун
    by_name = {b.name: b for b in snapshot.bodies}
    moons_by_parent: Dict[str, List[MapBody]] = {}
    for m in moons:
        p_name = m.parent_name or ""
        if not p_name and m.parent_ids:
            for b in snapshot.bodies:
                if b.body_id in m.parent_ids:
                    p_name = b.name
                    break
        moons_by_parent.setdefault(p_name, []).append(m)

    # Вычисляем радиусы орбит для планет и вторичных звёзд
    orbit_radii: Dict[str, float] = {}
    all_orbiters = list(planets) + list(other_stars)

    if scale_mode == "orrery":
        # Логарифмически-ранговое распределение орбит (от 24 до 240 единиц)
        r_min, r_max = 24.0, 240.0
        n_items = len(all_orbiters)
        if n_items == 1:
            orbit_radii[all_orbiters[0].name] = 60.0
        elif n_items > 1:
            all_distances = [max(0.1, b.orbit_ls or b.distance_ls) for b in all_orbiters]
            log_min = math.log10(min(all_distances))
            log_max = math.log10(max(all_distances))
            log_span = max(1e-4, log_max - log_min)

            # Базовый шаг гарантирует, что соседние орбиты не сольются
            min_step = max(12.0, (r_max - r_min) / (n_items + 1))
            current_r = r_min

            for idx, b in enumerate(all_orbiters):
                d = max(0.1, b.orbit_ls or b.distance_ls)
                log_frac = (math.log10(d) - log_min) / log_span
                target_r = r_min + log_frac * (r_max - r_min)
                target_r = max(target_r, current_r)
                orbit_radii[b.name] = target_r
                current_r = target_r + min_step
    else:
        # Линейный физический масштаб
        max_dist = max([b.orbit_ls or b.distance_ls for b in all_orbiters] or [100.0])
        factor = 200.0 / max(1.0, max_dist)
        for b in all_orbiters:
            orbit_radii[b.name] = max(15.0, (b.orbit_ls or b.distance_ls) * factor)

    # Координаты тел
    positions: Dict[str, Tuple[float, float, float]] = {}
    orbit_curves: Dict[str, Dict[str, Any]] = {}

    # Основная звезда в начале координат
    if primary_star:
        positions[primary_star.name] = (0.0, 0.0, 0.0)
    else:
        positions["__center__"] = (0.0, 0.0, 0.0)

    golden_angle = 2.399963229728653  # Золотой угол (~137.5 град)

    # Расставляем планеты и вторичные звёзды по орбитам
    for idx, body in enumerate(all_orbiters):
        r_orb = orbit_radii.get(body.name, 40.0 + idx * 18.0)
        ecc = max(0.0, min(0.65, float(body.eccentricity or 0.0)))
        inc_deg = float(body.orbital_inclination or 0.0) if is_3d else 0.0
        if is_3d and abs(inc_deg) < 1e-3:
            # Если наклонение в журнале не указано, даём реалистичный лёгкий наклон диска в 3D
            inc_deg = ((-1.0) ** idx) * (2.5 + ((idx * 5) % 9))
        inc_rad = math.radians(inc_deg)
        arg_rad = math.radians(float(body.arg_of_periapsis or (idx * 37.0)))

        # Положение тела на орбите
        theta = (idx * golden_angle) % (2 * math.pi)

        # Вычисляем эллиптическую кривую орбиты
        steps = 72
        xs, ys, zs = [], [], []
        a = r_orb

        for step in range(steps + 1):
            phi = 2 * math.pi * step / steps
            # Расстояние от фокуса
            r_focal = (a * (1.0 - ecc * ecc)) / (1.0 + ecc * math.cos(phi - arg_rad))
            xp = r_focal * math.cos(phi)
            yp = r_focal * math.sin(phi)
            # Наклонение вокруг оси X
            x_val = xp
            y_val = yp * math.cos(inc_rad) if is_3d else yp
            z_val = yp * math.sin(inc_rad) if is_3d else 0.0
            xs.append(x_val)
            ys.append(y_val)
            zs.append(z_val)

        orbit_curves[body.name] = {
            "x": xs, "y": ys, "z": zs,
            "inc_deg": inc_deg, "ecc": ecc,
        }

        # Координата планеты в точке theta
        r_body = (a * (1.0 - ecc * ecc)) / (1.0 + ecc * math.cos(theta - arg_rad))
        bx = r_body * math.cos(theta)
        by = r_body * math.sin(theta) * math.cos(inc_rad) if is_3d else r_body * math.sin(theta)
        bz = r_body * math.sin(theta) * math.sin(inc_rad) if is_3d else 0.0
        positions[body.name] = (bx, by, bz)

    # Расставляем луны вокруг их родительских планет
    moon_orbit_curves: Dict[str, Dict[str, Any]] = {}
    for parent_name, parent_moons in moons_by_parent.items():
        px, py, pz = positions.get(parent_name, (0.0, 0.0, 0.0))
        parent_moons.sort(key=lambda m: (m.orbit_ls or m.distance_ls, m.name))
        for m_idx, moon in enumerate(parent_moons):
            sub_r = 5.0 + m_idx * 3.5
            m_angle = (m_idx * 1.8 + 0.6) % (2 * math.pi)
            m_inc = math.radians(float(moon.orbital_inclination or ((-1.0) ** m_idx * 4.0))) if is_3d else 0.0

            # Орбита луны вокруг планеты
            m_xs, m_ys, m_zs = [], [], []
            steps = 48
            for step in range(steps + 1):
                phi = 2 * math.pi * step / steps
                mx = px + sub_r * math.cos(phi)
                my = py + (sub_r * math.sin(phi) * math.cos(m_inc) if is_3d else sub_r * math.sin(phi))
                mz = pz + (sub_r * math.sin(phi) * math.sin(m_inc) if is_3d else 0.0)
                m_xs.append(mx)
                m_ys.append(my)
                m_zs.append(mz)

            moon_orbit_curves[moon.name] = {"x": m_xs, "y": m_ys, "z": m_zs}

            # Координата луны
            mx_pos = px + sub_r * math.cos(m_angle)
            my_pos = py + (sub_r * math.sin(m_angle) * math.cos(m_inc) if is_3d else sub_r * math.sin(m_angle))
            mz_pos = pz + (sub_r * math.sin(m_angle) * math.sin(m_inc) if is_3d else 0.0)
            positions[moon.name] = (mx_pos, my_pos, mz_pos)

    # Расставляем станции, поселения, стройплощадки и авианосцы
    station_positions: Dict[str, Tuple[float, float, float]] = {}
    stations_by_body: Dict[str, List[MapStation]] = {}
    for st in snapshot.stations:
        b_name = st.body_name or ""
        stations_by_body.setdefault(b_name, []).append(st)

    for b_name, st_list in stations_by_body.items():
        if b_name and b_name in positions:
            bx, by, bz = positions[b_name]
        else:
            bx, by, bz = (0.0, 0.0, 0.0)

        for s_idx, station in enumerate(st_list):
            st_dist = 3.2 + (s_idx + 1) * 2.2
            st_angle = (s_idx * 1.57 + 0.78) % (2 * math.pi)
            sx = bx + st_dist * math.cos(st_angle)
            sy = by + st_dist * math.sin(st_angle)
            sz = bz + (((-1.0) ** s_idx) * 1.5 if is_3d else 0.0)
            station_positions[station.name or station.build_name] = (sx, sy, sz)

    # Позиция пилота («Вы здесь»)
    player_pos: Optional[Tuple[float, float, float]] = None
    if snapshot.player and snapshot.player.system == snapshot.system:
        p = snapshot.player
        if p.station_name and p.station_name in station_positions:
            sx, sy, sz = station_positions[p.station_name]
            player_pos = (sx, sy, sz + (1.2 if is_3d else 0.0))
        elif p.body_name and p.body_name in positions:
            bx, by, bz = positions[p.body_name]
            player_pos = (bx, by + 1.2, bz + (1.2 if is_3d else 0.0))
        elif primary_star:
            player_pos = (0.0, 5.0, 2.0 if is_3d else 0.0)

    return {
        "positions": positions,
        "orbit_curves": orbit_curves,
        "moon_orbit_curves": moon_orbit_curves,
        "station_positions": station_positions,
        "player_pos": player_pos,
        "planets": planets,
        "moons": moons,
        "primary_star": primary_star,
        "other_stars": other_stars,
        "by_name": by_name,
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
    if body.first_discovered_by:
        lines.append(f"<span style='color:#9ca3af'>Открыто: CMDR {body.first_discovered_by}</span>")
    if body.first_footfall_by:
        lines.append(f"<span style='color:#9ca3af'>Первопроходец: CMDR {body.first_footfall_by}</span>")
    return "<br>".join(lines)


def _build_station_hover(st: MapStation) -> str:
    """Сформировать HTML-карточку для станции/стройки."""
    title = st.build_name or st.name or "Объект"
    lines = [f"<b>{title}</b>"]
    kind_label = STATION_LABELS.get(st.kind, "станция")
    lines.append(f"Тип: <b>{st.build_type or st.station_type or kind_label}</b>")

    if st.body_name:
        lines.append(f"Орбита: {st.body_name}")

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
    title: Optional[str] = None,
) -> Dict[str, Any]:
    """Сгенерировать структуру данных Plotly (data, layout, config) в виде dict.

    Поддерживает режимы '3d' (Orrery) и '2d' (плоская схема).
    Работает автономно без обязательной установки сторонних пакетов.
    """
    is_3d = (str(view_mode or "3d").lower() == "3d")
    trace_type = "scatter3d" if is_3d else "scatter"

    geom = build_system_geometry(
        snapshot, scale_mode=scale_mode, show_moons=show_moons, is_3d=is_3d
    )
    positions = geom["positions"]
    orbit_curves = geom["orbit_curves"]
    moon_orbit_curves = geom["moon_orbit_curves"]
    station_positions = geom["station_positions"]
    player_pos = geom["player_pos"]
    planets = geom["planets"]
    moons = geom["moons"]
    primary_star = geom["primary_star"]
    other_stars = geom["other_stars"]

    data: List[Dict[str, Any]] = []

    # 1. Линии орбит планет
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

    # 2. Линии орбит лун
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

    # 3. Основная звезда системы
    if primary_star:
        p_color = get_star_color(primary_star.star_type)
        rad_km = (primary_star.radius_m or 6.96e8) / 1000.0
        m_size = max(14.0, min(34.0, 14.0 + math.log10(max(1000.0, rad_km) / 1.0e5) * 5.0))
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
            "text": [primary_star.name],
            "textposition": "top center",
            "textfont": {"color": "#f1c40f", "size": 12, "family": "Segoe UI, Arial"},
            "hovertext": [_build_body_hover(primary_star)],
            "hoverinfo": "text",
            "legendgroup": "stars",
            "showlegend": True,
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

    # 4. Вторичные звёзды
    if other_stars:
        s_xs, s_ys, s_zs, s_texts, s_hovers, s_colors = [], [], [], [], [], []
        for star in other_stars:
            if star.name in positions:
                x, y, z = positions[star.name]
                s_xs.append(x)
                s_ys.append(y)
                if is_3d:
                    s_zs.append(z)
                s_texts.append(star.name)
                s_hovers.append(_build_body_hover(star))
                s_colors.append(get_star_color(star.star_type))
        if s_xs:
            tr_s: Dict[str, Any] = {
                "type": trace_type,
                "name": "Вторичные звёзды",
                "x": s_xs,
                "y": s_ys,
                "mode": "markers+text",
                "marker": {
                    "size": 14,
                    "color": s_colors,
                    "line": {"color": "#ffd166", "width": 1.5},
                    "opacity": 0.95,
                },
                "text": s_texts,
                "textposition": "top center",
                "textfont": {"color": "#ffd166", "size": 11},
                "hovertext": s_hovers,
                "hoverinfo": "text",
                "legendgroup": "stars",
                "showlegend": True,
            }
            if is_3d:
                tr_s["z"] = s_zs
            data.append(tr_s)

    # 5. Планеты
    if planets:
        p_xs, p_ys, p_zs, p_texts, p_hovers, p_colors, p_sizes = [], [], [], [], [], [], []
        line_colors = []
        for p in planets:
            if p.name in positions:
                x, y, z = positions[p.name]
                p_xs.append(x)
                p_ys.append(y)
                if is_3d:
                    p_zs.append(z)
                p_texts.append(p.name)
                p_hovers.append(_build_body_hover(p))
                p_colors.append(body_color(p))

                # Размер маркера по логарифму радиуса
                r_km = (p.radius_m or 6000000.0) / 1000.0
                sz = max(7.0, min(24.0, 7.0 + math.log10(max(100.0, r_km) / 1000.0) * 4.5))
                p_sizes.append(sz)

                # Посадочные тела подсвечиваются ярким кольцом
                if p.landable:
                    line_colors.append(ED_COLOR_LANDABLE)
                elif p.bio_signals > 0:
                    line_colors.append(ED_COLOR_BIO)
                else:
                    line_colors.append("#1e293b")

        if p_xs:
            tr_p: Dict[str, Any] = {
                "type": trace_type,
                "name": "Планеты",
                "x": p_xs,
                "y": p_ys,
                "mode": "markers+text",
                "marker": {
                    "size": p_sizes,
                    "color": p_colors,
                    "line": {"color": line_colors, "width": 1.5},
                    "opacity": 0.95,
                },
                "text": p_texts,
                "textposition": "top center",
                "textfont": {"color": "#e2e8f0", "size": 11},
                "hovertext": p_hovers,
                "hoverinfo": "text",
                "legendgroup": "planets",
                "showlegend": True,
            }
            if is_3d:
                tr_p["z"] = p_zs
            data.append(tr_p)

    # 6. Луны
    if show_moons and moons:
        m_xs, m_ys, m_zs, m_texts, m_hovers, m_colors = [], [], [], [], [], []
        for m in moons:
            if m.name in positions:
                x, y, z = positions[m.name]
                m_xs.append(x)
                m_ys.append(y)
                if is_3d:
                    m_zs.append(z)
                m_texts.append(m.name)
                m_hovers.append(_build_body_hover(m))
                m_colors.append(body_color(m))
        if m_xs:
            tr_m_body: Dict[str, Any] = {
                "type": trace_type,
                "name": "Луны",
                "x": m_xs,
                "y": m_ys,
                "mode": "markers+text",
                "marker": {
                    "size": 5.5,
                    "color": m_colors,
                    "line": {"color": "#334155", "width": 1},
                    "opacity": 0.9,
                },
                "text": m_texts,
                "textposition": "top center",
                "textfont": {"color": "#94a3b8", "size": 9},
                "hovertext": m_hovers,
                "hoverinfo": "text",
                "legendgroup": "moons",
                "showlegend": True,
            }
            if is_3d:
                tr_m_body["z"] = m_zs
            data.append(tr_m_body)

    # 7. Стройплощадки колонизации
    sites = [s for s in snapshot.stations if s.is_site]
    if sites:
        st_xs, st_ys, st_zs, st_texts, st_hovers, st_colors = [], [], [], [], [], []
        for s in sites:
            key = s.name or s.build_name
            if key in station_positions:
                x, y, z = station_positions[key]
                st_xs.append(x)
                st_ys.append(y)
                if is_3d:
                    st_zs.append(z)
                pct = s.percent_delivered if getattr(s, "percent_delivered", None) is not None else s.progress
                pct_str = f" [{pct:.0f}%]" if pct is not None else ""
                st_texts.append(f"🏗️ {key}{pct_str}")
                st_hovers.append(_build_station_hover(s))
                st_colors.append(ED_COLOR_SITE_DONE if (pct or 0) >= 100 else ED_COLOR_SITE)
        if st_xs:
            tr_sites: Dict[str, Any] = {
                "type": trace_type,
                "name": "Стройплощадки",
                "x": st_xs,
                "y": st_ys,
                "mode": "markers+text",
                "marker": {
                    "size": 11,
                    "symbol": "diamond",
                    "color": st_colors,
                    "line": {"color": "#ffffff", "width": 1.5},
                    "opacity": 1.0,
                },
                "text": st_texts,
                "textposition": "bottom center",
                "textfont": {"color": "#ff9f43", "size": 11, "family": "Consolas, Segoe UI"},
                "hovertext": st_hovers,
                "hoverinfo": "text",
                "legendgroup": "sites",
                "showlegend": True,
            }
            if is_3d:
                tr_sites["z"] = st_zs
            data.append(tr_sites)

    # 8. Станции, порты и аванпосты
    regular_stations = [s for s in snapshot.stations if not s.is_site and s.kind != STATION_CARRIER]
    if regular_stations:
        st_xs, st_ys, st_zs, st_texts, st_hovers = [], [], [], [], []
        for s in regular_stations:
            key = s.name or s.build_name
            if key in station_positions:
                x, y, z = station_positions[key]
                st_xs.append(x)
                st_ys.append(y)
                if is_3d:
                    st_zs.append(z)
                st_texts.append(f"🛰️ {key}")
                st_hovers.append(_build_station_hover(s))
        if st_xs:
            tr_st: Dict[str, Any] = {
                "type": trace_type,
                "name": "Станции и порты",
                "x": st_xs,
                "y": st_ys,
                "mode": "markers+text",
                "marker": {
                    "size": 9.0,
                    "symbol": "diamond",
                    "color": "#3498db",
                    "line": {"color": "#ffffff", "width": 1},
                    "opacity": 0.95,
                },
                "text": st_texts,
                "textposition": "bottom center",
                "textfont": {"color": "#38bdf8", "size": 10},
                "hovertext": st_hovers,
                "hoverinfo": "text",
                "legendgroup": "stations",
                "showlegend": True,
            }
            if is_3d:
                tr_st["z"] = st_zs
            data.append(tr_st)

    # 9. Fleet Carriers
    carriers = [s for s in snapshot.stations if s.kind == STATION_CARRIER]
    if carriers:
        c_xs, c_ys, c_zs, c_texts, c_hovers = [], [], [], [], []
        for s in carriers:
            key = s.name or s.build_name
            if key in station_positions:
                x, y, z = station_positions[key]
                c_xs.append(x)
                c_ys.append(y)
                if is_3d:
                    c_zs.append(z)
                c_texts.append(f"🚀 {key}")
                c_hovers.append(_build_station_hover(s))
        if c_xs:
            tr_c: Dict[str, Any] = {
                "type": trace_type,
                "name": "Авианосцы (Fleet Carriers)",
                "x": c_xs,
                "y": c_ys,
                "mode": "markers+text",
                "marker": {
                    "size": 9.0,
                    "symbol": "square",
                    "color": "#a855f7",
                    "line": {"color": "#ffffff", "width": 1},
                    "opacity": 0.95,
                },
                "text": c_texts,
                "textposition": "bottom center",
                "textfont": {"color": "#c084fc", "size": 10},
                "hovertext": c_hovers,
                "hoverinfo": "text",
                "legendgroup": "carriers",
                "showlegend": True,
            }
            if is_3d:
                tr_c["z"] = c_zs
            data.append(tr_c)

    # 10. Пилот («Вы здесь»)
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

    if is_3d:
        camera_buttons = [
            {
                "label": "🔭 3D Orrery",
                "method": "relayout",
                "args": [{"scene.camera": {"eye": {"x": 1.5, "y": 1.5, "z": 1.1}, "up": {"x": 0, "y": 0, "z": 1}}}],
            },
            {
                "label": "🧭 Сверху (2D)",
                "method": "relayout",
                "args": [{"scene.camera": {"eye": {"x": 0.001, "y": 0.001, "z": 2.5}, "up": {"x": 0, "y": 1, "z": 0}}}],
            },
            {
                "label": "📐 Сбоку (Профиль)",
                "method": "relayout",
                "args": [{"scene.camera": {"eye": {"x": 2.5, "y": 0.001, "z": 0.001}, "up": {"x": 0, "y": 0, "z": 1}}}],
            },
            {
                "label": "🔄 Сброс",
                "method": "relayout",
                "args": [{"scene.camera": {"eye": {"x": 1.6, "y": 1.6, "z": 1.2}, "up": {"x": 0, "y": 0, "z": 1}}}],
            },
        ]
        layout["scene"] = {
            "bgcolor": ED_BG_CANVAS,
            "xaxis": {
                "title": "",
                "showgrid": True,
                "gridcolor": ED_COLOR_GRID,
                "zerolinecolor": "#1e293b",
                "showticklabels": False,
                "showbackground": False,
            },
            "yaxis": {
                "title": "",
                "showgrid": True,
                "gridcolor": ED_COLOR_GRID,
                "zerolinecolor": "#1e293b",
                "showticklabels": False,
                "showbackground": False,
            },
            "zaxis": {
                "title": "",
                "showgrid": True,
                "gridcolor": ED_COLOR_GRID,
                "zerolinecolor": "#1e293b",
                "showticklabels": False,
                "showbackground": False,
            },
            "camera": {
                "eye": {"x": 1.5, "y": 1.5, "z": 1.1},
                "up": {"x": 0, "y": 0, "z": 1},
            },
            "aspectmode": "data",
        }
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
    else:
        layout["xaxis"] = {
            "title": "",
            "showgrid": True,
            "gridcolor": ED_COLOR_GRID,
            "zerolinecolor": "#1e293b",
            "showticklabels": False,
        }
        layout["yaxis"] = {
            "title": "",
            "showgrid": True,
            "gridcolor": ED_COLOR_GRID,
            "zerolinecolor": "#1e293b",
            "showticklabels": False,
            "scaleanchor": "x",
            "scaleratio": 1,
        }

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
        title=title,
    )
    return go.Figure(data=schema["data"], layout=schema["layout"])


def generate_plotly_html(
    snapshot: MapSnapshot,
    view_mode: str = "3d",
    scale_mode: str = "orrery",
    show_moons: bool = True,
    title: Optional[str] = None,
) -> str:
    """Сгенерировать автономный HTML-документ с интерактивной картой.

    Работает надежно как при наличии установленного `plotly`, так и при его
    отсутствии (рендерит через CDN Plotly.js).
    """
    schema = build_plotly_dict(
        snapshot,
        view_mode=view_mode,
        scale_mode=scale_mode,
        show_moons=show_moons,
        title=title,
    )
    data_json = json.dumps(schema["data"], ensure_ascii=False)
    layout_json = json.dumps(schema["layout"], ensure_ascii=False)
    config_json = json.dumps(schema["config"], ensure_ascii=False)

    sys_name = snapshot.system or "Система"
    active_sites = [s for s in snapshot.stations if s.is_site]
    landables = [b for b in snapshot.bodies if b.landable]
    bio_count = sum(b.bio_signals for b in snapshot.bodies)

    html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Карта системы {sys_name} — Colonial Helper</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      background-color: #07090e;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }}
    header {{
      background: #0b0e14;
      border-bottom: 1px solid #1e293b;
      padding: 10px 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      z-index: 10;
    }}
    .title-group {{
      display: flex;
      align-items: center;
      gap: 14px;
    }}
    .sys-name {{
      font-size: 20px;
      font-weight: 700;
      color: #ff9f43;
      letter-spacing: 0.5px;
    }}
    .badges {{
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }}
    .badge {{
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 4px;
      background: #1e293b;
      color: #cbd5e1;
      border: 1px solid #334155;
    }}
    .badge.orange {{
      background: rgba(230, 126, 34, 0.18);
      border-color: rgba(230, 126, 34, 0.5);
      color: #ff9f43;
      font-weight: 600;
    }}
    .badge.green {{
      background: rgba(46, 204, 113, 0.18);
      border-color: rgba(46, 204, 113, 0.5);
      color: #2ecc71;
    }}
    .badge.cyan {{
      background: rgba(0, 243, 255, 0.15);
      border-color: rgba(0, 243, 255, 0.4);
      color: #00f3ff;
    }}
    .controls {{
      display: flex;
      gap: 8px;
      align-items: center;
    }}
    .btn {{
      padding: 6px 12px;
      border-radius: 6px;
      background: #1e293b;
      color: #f1f5f9;
      border: 1px solid #334155;
      font-size: 12px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s ease;
    }}
    .btn:hover {{
      background: #334155;
      border-color: #64748b;
    }}
    .btn.primary {{
      background: rgba(230, 126, 34, 0.2);
      border-color: #e67e22;
      color: #ff9f43;
    }}
    .btn.primary:hover {{
      background: rgba(230, 126, 34, 0.35);
    }}
    #map-container {{
      flex: 1;
      width: 100%;
      height: calc(100vh - 58px);
      position: relative;
    }}
    .hud-hint {{
      position: absolute;
      bottom: 12px;
      right: 18px;
      font-size: 11px;
      color: #64748b;
      pointer-events: none;
      background: rgba(7, 9, 14, 0.75);
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid #1e293b;
    }}
  </style>
</head>
<body>
  <header>
    <div class="title-group">
      <div class="sys-name">🪐 {sys_name}</div>
      <div class="badges">
        <span class="badge">Тел: {len(snapshot.bodies)}</span>
        {f'<span class="badge orange">🏗️ Строек: {len(active_sites)}</span>' if active_sites else ''}
        {f'<span class="badge cyan">🛬 Посадочных: {len(landables)}</span>' if landables else ''}
        {f'<span class="badge green">🌿 Биосигналов: {bio_count}</span>' if bio_count else ''}
        {f'<span class="badge cyan">🛸 CMDR в системе</span>' if snapshot.player and snapshot.player.system == snapshot.system else ''}
      </div>
    </div>
    <div class="controls">
      <a class="btn primary" href="https://ravencolonial.com/#sys={sys_name}" target="_blank" rel="noopener">
        RavenColonial ↗
      </a>
      <a class="btn" href="https://www.edsm.net/en/system?systemName={sys_name}" target="_blank" rel="noopener">
        EDSM ↗
      </a>
      <button class="btn" onclick="toggleFullscreen()">⛶ Полный экран</button>
    </div>
  </header>

  <div id="map-container"></div>
  <div class="hud-hint">ЛКМ: вращение 3D · ПКМ: смещение · Колесо: зум · Клик по легенде: вкл/выкл слоёв</div>

  <script>
    const data = {data_json};
    const layout = {layout_json};
    const config = {config_json};

    Plotly.newPlot('map-container', data, layout, config);

    window.addEventListener('resize', () => {{
      Plotly.Plots.resize('map-container');
    }});

    function toggleFullscreen() {{
      if (!document.fullscreenElement) {{
        document.documentElement.requestFullscreen().catch(() => {{}});
      }} else {{
        document.exitFullscreen().catch(() => {{}});
      }}
    }}
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
) -> Path:
    """Экспортировать интерактивную карту Plotly в HTML-файл на диске."""
    content = generate_plotly_html(
        snapshot, view_mode=view_mode, scale_mode=scale_mode, show_moons=show_moons
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
) -> Path:
    """Сгенерировать интерактивную карту Plotly и открыть её в веб-браузере."""
    target_path = export_plotly_html(
        snapshot,
        filepath=filepath,
        view_mode=view_mode,
        scale_mode=scale_mode,
        show_moons=show_moons,
    )
    webbrowser.open(target_path.as_uri())
    return target_path
