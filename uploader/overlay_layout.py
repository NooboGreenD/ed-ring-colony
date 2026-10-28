"""Настройки блоков HUD и раскладка: чистые функции без тулкита.

Раньше эти таблицы и расчёты лежали в `overlay.py` рядом с окнами на Tk.
Теперь ими пользуются и окна (`hud_window`), и менеджер оверлея, а сами
функции ничего не знают ни о Qt, ни о Tk — поэтому их легко проверять.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple


# ============================================================
#  Настройки блоков: размеры, шрифт, прозрачность, поведение
# ============================================================
BLOCK_LABELS = {
    "route": "ROUTE — маршрут",
    "status": "STATUS — статус",
    "ship": "SHIP — корабль",
    "cargo": "CARGO — трюм",
    "session": "SESSION — сессия",
    "events": "EVENTS — события",
    "exobio": "EXOBIO — экзобиология",
    "carrier": "CARRIER — авианосец",
}

#: Размеры по умолчанию (используются и «Сбросить позиции», и пресетами).
#: Ширина и высота обязаны совпадать с <ключ>_width/_height в DEFAULT_SETTINGS:
#: иначе «Сбросить позиции» и пресет M возвращают блоку другой размер, чем у
#: свежей установки. Блоки разложены в четыре колонки без перекрытий.
DEFAULT_BLOCK_POSITIONS = {
    "route": (50, 50, 280, 160),
    "status": (50, 220, 280, 220),
    "ship": (50, 450, 360, 330),
    "cargo": (430, 450, 300, 340),
    "session": (430, 50, 320, 300),
    "events": (770, 50, 320, 260),
    "exobio": (1120, 50, 360, 620),
    "carrier": (770, 330, 330, 300),
}

#: Пресеты размера: множитель к стандартному размеру блока.
SIZE_PRESETS = (("XS", 0.75), ("S", 0.85), ("M", 1.0), ("L", 1.25), ("XL", 1.5))
SIZE_PRESET_LABELS = {
    "XS": "XS — 75%",
    "S": "S — 85%",
    "M": "M — 100%",
    "L": "L — 125%",
    "XL": "XL — 150%",
}

#: Когда блок показывать самому (поверх ручного включения).
AUTO_RULES = (
    "always", "never", "game_focused", "docked", "in_space",
    "in_srv", "on_foot", "has_cargo", "has_bio", "has_route",
    "at_carrier",
)
AUTO_RULE_LABELS = {
    "always": "всегда",
    "never": "никогда (только вручную)",
    "game_focused": "когда игра в фокусе",
    "docked": "на станции / у дока",
    "in_space": "в полёте (не на станции)",
    "in_srv": "в SRV",
    "on_foot": "пешком (OnFoot)",
    "has_cargo": "когда есть груз",
    "has_bio": "когда есть биосигналы",
    "has_route": "когда задан маршрут",
    "at_carrier": "когда вы на авианосце",
}

#: Через сколько секунд без событий прятать HUD; 0 — не прятать.
IDLE_TIMEOUTS = (0, 30, 60, 120, 300, 600)

#: Как часто на всякий случай переподнимать блоки в Z-order (секунды).
#: Раз в секунду (частота цикла обновления) — слишком часто: Windows
#: пересобирает layered-окна, и HUD заметно мерцает при редактировании.
ZORDER_REFRESH_SECONDS = 15.0


def preset_size(key: str, preset: str) -> Optional[Tuple[int, int]]:
    """Размер блока для пресета (M — стандартный)."""
    base = DEFAULT_BLOCK_POSITIONS.get(key)
    if not base:
        return None
    factor = dict(SIZE_PRESETS).get(preset)
    if not factor:
        return None
    _x, _y, width, height = base
    return int(round(width * factor)), int(round(height * factor))


def resolve_block_alpha(settings: dict, key: str) -> float:
    """Прозрачность блока: своя, если задана, иначе общая."""
    value = settings.get(f"{key}_alpha")
    if value is None:
        return float(settings.get("alpha", 0.90) or 0.90)
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(settings.get("alpha", 0.90) or 0.90)


def resolve_block_font_size(settings: dict, key: str) -> int:
    """Размер шрифта блока: свой, если задан, иначе общий."""
    value = settings.get(f"{key}_font_size")
    if value in (None, ""):
        return int(settings.get("font_size", 10) or 10)
    try:
        return max(6, min(28, int(value)))
    except (TypeError, ValueError):
        return int(settings.get("font_size", 10) or 10)


def block_click_through(settings: dict, key: str) -> bool:
    """Пропускает ли блок мышь в игру («клик насквозь»).

    С 2.15.0 отдельной настройки нет: закреплённый блок всегда прозрачен для
    мыши, откреплённый всегда принимает клики — его двигают и настраивают.
    Раньше это были две независимые галочки, и закреплённый блок без «клика
    насквозь» перехватывал мышь у игры.
    """
    return bool(settings.get(f"{key}_locked", False))


def legacy_click_through(settings: dict, key: str) -> bool:
    """Значение «клик насквозь» по правилам до 2.15.0: своё у блока, иначе общее.

    Нужно только миграции настроек и старым профилям раскладки.
    """
    value = settings.get(f"{key}_click_through")
    if value is None:
        return bool(settings.get("click_through", False))
    return bool(value)


def block_detached(settings: dict, key: str) -> bool:
    """Блок отвязан от игры: виден и без фокуса игры, живёт на своём экране."""
    return bool(settings.get(f"{key}_detached", False))


def auto_rule_matches(rule: str, context: dict) -> bool:
    """Подходит ли текущая ситуация под правило автопоказа.

    Чистая функция: контекст собирает менеджер из состояния игры, корабля и
    данных маршрута, а здесь решается только «показывать или нет».
    """
    rule = rule or "always"
    if rule == "always":
        return True
    if rule == "never":
        return False
    flags = set(context.get("flags") or ())
    game_running = bool(context.get("game_running"))
    if rule == "game_focused":
        return game_running and bool(context.get("game_focused"))
    if rule == "docked":
        return "Docked" in flags
    if rule == "in_space":
        return game_running and not ({"Docked", "Landed", "SRV", "OnFoot"} & flags)
    if rule == "in_srv":
        return "SRV" in flags
    if rule == "on_foot":
        return "OnFoot" in flags
    if rule == "has_cargo":
        return float(context.get("cargo_count") or 0) > 0
    if rule == "has_bio":
        return int(context.get("bio_signals") or 0) > 0
    if rule == "has_route":
        return int(context.get("route_total") or 0) > 0
    if rule == "at_carrier":
        return bool(context.get("at_carrier"))
    return True


# ============================================================
#  Якоря и раскладка
# ============================================================
# Порядок — как в UI: сверху вниз, слева направо.
ANCHOR_KEYS = (
    "custom",
    "top_left", "top_center", "top_right",
    "mid_left", "mid_center", "mid_right",
    "bottom_left", "bottom_center", "bottom_right",
)

ANCHOR_LABELS = {
    "custom": "Свободная",
    "top_left": "↖ Верх лево",
    "top_center": "↑ Верх центр",
    "top_right": "↗ Верх право",
    "mid_left": "← Середина лево",
    "mid_center": "• Центр",
    "mid_right": "→ Середина право",
    "bottom_left": "↙ Низ лево",
    "bottom_center": "↓ Низ центр",
    "bottom_right": "↘ Низ право",
}


def compute_anchored_position(
    anchor: str,
    area_x: int,
    area_y: int,
    area_w: int,
    area_h: int,
    win_w: int,
    win_h: int,
    margin: int = 24,
) -> Optional[Tuple[int, int]]:
    """Куда поставить окно размера (win_w, win_h) внутри области по якорю.

    Чистая функция (без Tk) — её удобно тестировать и переиспользовать:
    область может быть как весь экран, так и прямоугольник окна игры.

    Возвращает None для `custom` — значит, позицией управляет пользователь.
    Координаты всегда зажимаются внутрь области, чтобы блок не оказался за
    её пределами (актуально для второго монитора и окон игры в окне).
    """
    if not anchor or anchor == "custom":
        return None

    left = area_x + margin
    top = area_y + margin
    right = area_x + area_w - win_w - margin
    bottom = area_y + area_h - win_h - margin
    center_x = area_x + (area_w - win_w) // 2
    center_y = area_y + (area_h - win_h) // 2

    position = {
        "top_left": (left, top),
        "top_center": (center_x, top),
        "top_right": (right, top),
        "mid_left": (left, center_y),
        "mid_center": (center_x, center_y),
        "mid_right": (right, center_y),
        "bottom_left": (left, bottom),
        "bottom_center": (center_x, bottom),
        "bottom_right": (right, bottom),
    }.get(anchor)

    if position is None:
        return None

    x, y = position
    # Зажимаем внутрь области (с запасом, чтобы окно не «убежало» полностью).
    x = max(area_x, min(x, area_x + max(0, area_w - win_w)))
    y = max(area_y, min(y, area_y + max(0, area_h - win_h)))
    return int(x), int(y)


#: Общие настройки, которые профиль раскладки сохраняет вместе с блоками.
LAYOUT_GLOBAL_KEYS = (
    "alpha", "font_family", "font_size", "layout_margin", "idle_timeout",
    "auto_rules_enabled", "hide_when_game_off", "attach_to_game",
)


def capture_layout_snapshot(settings: dict, windows: dict, blocks: tuple) -> dict:
    """Снимок текущей раскладки для профиля (чистая функция, без Tk).

    `windows`: {key: overlay|None}, `blocks`: ключи блоков.
    """
    snapshot: Dict[str, Any] = {}
    for key in blocks:
        overlay = windows.get(key)
        entry = {
            "x": settings.get(f"{key}_x"),
            "y": settings.get(f"{key}_y"),
            "width": settings.get(f"{key}_width"),
            "height": settings.get(f"{key}_height"),
            "anchor": settings.get(f"{key}_anchor", "custom"),
            "visible": settings.get(f"show_{key}", True),
            # Настройки вида и поведения блока — тоже часть раскладки:
            # «Хаул» и «Эксобиология» отличаются не только позициями.
            "alpha": settings.get(f"{key}_alpha"),
            "font_size": settings.get(f"{key}_font_size"),
            # Закреплённый блок заодно пропускает мышь в игру (см.
            # block_click_through) — отдельного «клика насквозь» больше нет.
            "locked": settings.get(f"{key}_locked", False),
            "detached": block_detached(settings, key),
            "auto_rule": settings.get(f"{key}_auto_rule", "always"),
            "hotkey": settings.get(f"{key}_hotkey", ""),
        }
        if overlay is not None:
            # Живое окно: его фактическая геометрия актуальнее сохранённой.
            # Блок — сам Qt-виджет, отдельного `overlay.window` с
            # `winfo_*`-методами больше нет: этот путь молча падал, и профиль
            # раскладки запоминал старые координаты из настроек.
            try:
                geometry = (int(overlay.x()), int(overlay.y()),
                            int(overlay.width()), int(overlay.height()))
            except Exception:
                geometry = None
            if geometry:
                entry["x"], entry["y"], entry["width"], entry["height"] = geometry
            entry["anchor"] = getattr(overlay, "_anchor", entry["anchor"])
        snapshot[key] = entry
    # Общие настройки вида и поведения тоже часть раскладки.
    for key in LAYOUT_GLOBAL_KEYS:
        if key in settings:
            snapshot[key] = settings[key]
    return snapshot


def apply_layout_snapshot(settings: dict, snapshot: dict, blocks: tuple) -> None:
    """Записать снимок раскладки в настройки (чистая функция, без Tk)."""
    for key in blocks:
        entry = snapshot.get(key)
        if not isinstance(entry, dict):
            continue
        for suffix in (
            "x", "y", "width", "height", "anchor",
            # None означает «как везде» — важно уметь вернуть общее значение,
            # поэтому сбрасываем ключ, а не пишем None.
            "alpha", "font_size",
        ):
            if entry.get(suffix) is not None:
                settings[f"{key}_{suffix}"] = entry[suffix]
            elif f"{key}_{suffix}" in settings:
                settings.pop(f"{key}_{suffix}", None)
        for suffix in ("locked", "detached", "auto_rule", "hotkey"):
            if suffix in entry:
                settings[f"{key}_{suffix}"] = entry[suffix]
        if "click_through" in entry or "click_through" in snapshot:
            # Профиль до 2.15.0: «клик насквозь» был отдельной галочкой.
            # Блок, который пропускал мышь, теперь закреплён — иначе после
            # применения старого профиля он начал бы перехватывать клики.
            legacy = {"click_through": snapshot.get("click_through", False)}
            if entry.get("click_through") is not None:
                legacy[f"{key}_click_through"] = entry["click_through"]
            if legacy_click_through(legacy, key):
                settings[f"{key}_locked"] = True
        if entry.get("visible") is not None:
            settings[f"show_{key}"] = bool(entry["visible"])
    for key in LAYOUT_GLOBAL_KEYS:
        if key in snapshot and snapshot[key] is not None:
            settings[key] = snapshot[key]


