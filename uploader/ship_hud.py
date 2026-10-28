"""Компактная модель SHIP-оверлея: только то, что действительно известно.

Зачем отдельный модуль. Оверлей рисовал корабль «красивыми» числами, которых в
журнале нет, и молча терял те, что есть:

* щиты показывались как 100 % — в журнале нет процента щитов, есть только
  состояние (бит ``Shields`` в ``Status`` и событие ``ShieldState``);
* прочность модулей бралась из ``ModuleInfo``, а это событие (и файл
  ``ModulesInfo.json``) отдаёт лишь ``Power``/``Priority``: ``Health`` там
  появляется не во всех версиях игры, и список может лежать под ключом
  ``Slots``;
* ``Repair`` пишет ``Item``, ``AfmuRepairs`` — локализационный id
  ``$int_shieldbooster_..._name;``, ``RebootRepair`` — слоты. Слоты и имена
  путались, и починка модулей в оверлее не отражалась вовсе;
* ``RefuelAll.Amount`` — это кредиты, а не тонны, поэтому бак после полной
  заправки уезжал в непонятно куда.

Здесь собрано представление: список строк с метками, чипы флагов и таблица
модулей. Никакого Tk — чтобы раскладку можно было тестировать как чистые
функции, а оверлей только печатал результат.
"""

from typing import Any, Dict, List, Optional, Sequence, Tuple

from i18n import tr

#: Русские строки файла, которые не являются подписями интерфейса.
#: ``HeatDamage (оценка)`` — ключ источника значения корпуса (на него ссылается
#: ``ship_tracker``), а не текст для командира: подпись берётся из значения
#: :data:`HULL_SOURCES`.
NON_UI_LITERALS = frozenset({
    # ключи источника значения корпуса, а не подписи: подпись берётся из
    # значения `HULL_SOURCES` ниже
    "HeatDamage (оценка)", "Repair (корпус)",
})

#: Разрезы HUD — те же ключи, что в настройках блока (``show_<разрез>``).
SECTIONS = ("flags", "pips", "hull", "shield", "power", "fuel",
            "cargo_info", "balance", "legal", "destination", "modules")

#: Сколько строк модулей показываем в компактном режиме: блок не резиновый.
MAX_MODULE_ROWS = 6

#: Максимальная длина шкалы — шире в 360-пиксельный блок не влезает.
BAR_MAX_WIDTH = 12

#: Ширина шкалы по умолчанию: 10 клеток, чтобы вместе с подписью источника
#: строка гарантированно влезала в блок 360 px при шрифте 10 pt.
BAR_WIDTH_DEFAULT = 10

#: Что печатать, пока журнал ничего не сказал о корабле. Это ключ перевода:
#: подпись берётся из :func:`empty_hint`, иначе текст остался бы русским.
EMPTY_HINT = "нет данных: дождитесь Loadout или Status"


def empty_hint() -> str:
    """Подпись «данных о корабле ещё нет» на текущем языке."""
    return tr(EMPTY_HINT)

#: Откуда взято значение корпуса — в HUD пишем коротко, место на счету.
#: Значения — ключи перевода, их печатает :func:`hull_source_text`.
HULL_SOURCES = {
    "HullDamage": "попадание", "Loadout": "снимок", "RepairDrone": "дрон",
    "Synthesis": "синтез", "HeatDamage": "перегрев", "ModulesInfo": "файл",
    "Status": "Status", "AfmuRepairs": "AFMU", "Repair": "ремонт",
    "RepairAll": "ремонт", "Resurrect": "воскрешение",
    "Collision": "столкновение", "Touchdown": "посадка",
    "HeatDamage (оценка)": "перегрев", "Damage": "урон",
    # ``Repair`` чинит корпус целиком, ``Repair (корпус)`` — тот же источник
    # из ship_tracker: без записи в подписи в HUD уезжал бы технический ключ.
    "Repair (корпус)": "ремонт",
}

def hull_source_text(source: str) -> str:
    """Короткая подпись источника значения корпуса на текущем языке."""
    return tr(HULL_SOURCES.get(source, source))


#: Сколько символов влезает в строку при блоке 360 px и шрифте 10 pt.
DEFAULT_MAX_CHARS = 40
#: Средняя ширина глифа в моноширинном шрифте (em) и перевод пунктов в пиксели.
CHAR_WIDTH_EM = 0.62
POINTS_TO_PX = 96.0 / 72.0


def line_budget(settings: Optional[Dict[str, Any]]) -> int:
    """Сколько символов помещается в одну строку блока.

    Оверлей печатает `wraplength = ship_width - 26`, поэтому длинные строки
    Tk переносит сам — и строка занимает две высоты. Считаем бюджет по ширине
    блока и размеру шрифта, чтобы разбивать строки самим и держать высоту.
    """
    settings = settings or {}
    try:
        width = int(settings.get("ship_width", 360))
    except (TypeError, ValueError):
        width = 360
    try:
        size = float(settings.get("font_size", 10))
    except (TypeError, ValueError):
        size = 10.0
    usable = max(150, width - 26)
    per_char = max(4.0, CHAR_WIDTH_EM * max(6.0, size) * POINTS_TO_PX)
    return max(20, int(usable / per_char))
#: Сколько инцидентов показывать в ленте: блок обязан остаться компактным.
MAX_INCIDENT_LINES = 2
#: Длина текстового индикатора (оверлей — моноширинный Label, не Canvas).
BAR_NARROW = 6

FILLED = "▓"
EMPTY = "░"

#: Чипы состояния: имя флага из ``ship_tracker.decode_status_flags`` ->
#: (текст в HUD, тон). Порядок словаря = порядок показа. «MainShip» не
#: показываем: он включён почти всегда и места стоит дороже, чем информации.
CHIP_RULES: Tuple[Tuple[str, str, str], ...] = (
    ("Danger", "ОПАСНОСТЬ", "bad"),
    ("Interdicted", "ПЕРЕХВАТ", "bad"),
    ("MassLock", "МАС-ЛОК", "bad"),
    ("Overheat", "ПЕРЕГРЕВ", "bad"),
    ("LowFuel", "МАЛО ТОПЛИВА", "warn"),
    ("Hardpoints", "ХАРДПОИНТЫ", "warn"),
    # «ЩИТЫ ↑» как чип не нужен: строка ЩИТЫ показывает то же и точнее
    # (она же различает «упали» и «нет генератора»).
    ("Docked", "В ДОКЕ", "ok"),
    ("Landed", "НА ГРУНТЕ", "ok"),
    ("Gear", "ОПОРЫ", "info"),
    ("Supercruise", "СУПЕРКРУИЗ", "info"),
    ("FsdCharging", "ФСД ЗАРЯД", "info"),
    ("FsdCooldown", "ФСД ОСТЫВ", "muted"),
    ("FsdJump", "ПРЫЖОК", "info"),
    ("FsdHyper", "ГИПЕРКРЫЛО", "info"),
    ("FsdTransit", "В ПРЫЖКЕ", "info"),
    ("Scooping", "СКОП", "info"),
    ("CargoScoop", "СКУП ГРУЗА", "info"),
    ("Silent", "ТИХИЙ ХОД", "info"),
    ("Lights", "СВЕТОСИГНАЛ", "muted"),
    ("Wing", "КРЫЛО", "info"),
    ("Fighter", "ИСТРЕБИТЕЛЬ", "info"),
    ("SRV", "SRV", "info"),
    ("OnFoot", "ПЕШКОМ", "info"),
    ("Taxi", "ТАКСИ", "info"),
    ("MultiCrew", "МУЛЬТИЭКИПАЖ", "info"),
    ("Analysis", "СКАНЕР", "muted"),
    ("NV", "НВ", "muted"),
    ("LowO2", "КИСЛОРОД", "bad"),
    ("LowHealth", "ЗДОРОВЬЕ", "bad"),
)

#: Подписи модулей: loc-id журнала -> короткое имя для строки HUD. Это ключи
#: перевода: их печатает :func:`short_name` через ``tr()``.
LABELS: Tuple[Tuple[str, str], ...] = (
    ("repairer", "AFMU"),
    ("hyperdrive", "ФСД"),
    ("powerplant", "РЕАКТОР"),
    ("shieldgenerator", "ЩИТ"),
    ("shieldbooster", "БУСТЕР ЩИТА"),
    ("engine", "ДВИГАТЕЛЬ"),
    ("fuelscoop", "ТОПЛ. СКОП"),
    ("fueltank", "БАК"),
    ("lifefsupport", "ЖИЗНЕОБЕСП."),
    ("lifesupport", "ЖИЗНЕОБЕСП."),
    ("sensors", "СКАНЕР"),
    ("cargorack", "ГРУЗ. СЕКЦИЯ"),
    ("cockpit", "КАБИНА"),
    ("canopy", "ФОНАРЬ"),
    ("distributor", "РАСПРЕД."),
    ("plantediscovery", "СКАН ПЛАНЕТ"),
    ("probemaker", "ПРОБЫ"),
    ("fuelscoop", "ТОПЛ. СКОП"),
)

#: Ключевые системы: их состояние интересно, даже когда целое — без них нельзя
#: уйти с орбиты или дотянуть до станции. Грузовые стойки и сканеры в этот
#: список не входят: компактный блок — не инвентарь.
CRITICAL_HINTS = ("repairer", "hyperdrive", "powerplant", "shieldgenerator",
                  "shieldbooster", "engine", "lifesupport", "cockpit",
                  "canopy", "distributor")

#: Оружие: по нему показываем боезапас, а не только прочность.
WEAPON_HINTS = ("hpt_", "cannon", "machinegun", "pulselaser", "beamlaser",
                "minelayer", "torp", "missile", "railgun", "flak", "lasers")


def tone_for_percent(percent: Optional[int]) -> str:
    """Цветовой тон по проценту прочности."""
    if percent is None:
        return "muted"
    if percent >= 80:
        return "ok"
    if percent >= 50:
        return "warn"
    return "bad"


def bar(percent: Optional[float], width: int = BAR_WIDTH_DEFAULT) -> str:
    """Текстовая шкала ``▓▓▓▓░░░░░░░░``.

    ``None`` — не «пустая шкала», а отсутствие данных: возвращаем пустую строку,
    иначе HUD рисовал бы нулевой индикатор там, где игра ничего не сообщила
    (например, мощность реактора известна только после Loadout).
    """
    if percent is None:
        return ""
    filled = int(round(max(0.0, min(100.0, float(percent))) / 100.0 * width))
    return FILLED * filled + EMPTY * (width - filled)


def short_name(name: str) -> str:
    """Человеческое имя модуля из ``int_shieldbooster_size3_class5``."""
    text = str(name or "").strip().lower()
    if not text:
        return "—"
    text = text.replace("$", "").replace("_name;", "").rstrip(";")
    parts = [p for p in text.split("_") if p and p not in ("int", "hpt")]
    tail = []
    for part in parts:
        if part.startswith("size") or part.startswith("class"):
            continue
        tail.append(part)
    core = "_".join(tail) or parts[-1] if tail or parts else text
    for hint, label in LABELS:
        if hint in core:
            return tr(label)
    return core.replace("_", " ")[:18]


#: Именованные слоты: по ним и так понятно, о чём строка, — имя модуля
#: («ДВИГАТЕЛЬ», «ЩИТ») заменяет метку, чтобы не печатать «ДВИГ ДВИГАТЕЛЬ».
NAMED_SLOTS = {
    "MainEngines", "PowerPlant", "FrameShiftDrive", "LifeSupport",
    "PowerDistributor", "Radar", "FuelTank", "CargoHatch", "ShipCockpit",
    "Armour", "DataLinkScanner", "PlanetaryApproachSuite", "FuelScoop",
}


def slot_label(slot: str) -> str:
    """Короткая метка слота: ``Slot04_Size2`` -> ``04/S2``; именованный слот -> ''."""
    text = str(slot or "")
    if text in NAMED_SLOTS:
        return ""
    if text.startswith("Slot") and "_" in text:
        number = text[4:].split("_")[0] or "0"
        size = text.split("_", 1)[1].replace("Size", "S")
        return f"{number}/{size}"
    for prefix in ("Tiny", "Small", "Medium", "Large", "Huge"):
        if text.startswith(prefix + "Hardpoint"):
            return f"{prefix[0]}H{text.replace(prefix + 'Hardpoint', '')}"
    if text.startswith("Tiny") and text[4:].isdigit():
        return f"T{text[4:]}"
    if text.startswith("Slot"):
        return text.replace("Slot", "").split("_")[0] or text
    return (text[:8] or "—").upper()


def percent_of(value: Any, default: int = 100) -> int:
    """Прочность в проценты: журнал отдаёт 0..1, `get_state_dict()` — 0..100.

    Модель HUD не имеет права путать 44 % с нулём, поэтому оба формата
    приводятся к одному.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number < 0:
        return default
    if number <= 1.0:
        number *= 100.0
    return max(0, min(100, int(round(number))))


def clip(text: str, max_chars: int) -> str:
    """Обрезать по бюджету, не теряя смысл: многоточие говорит «дальше есть»."""
    text = str(text)
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars - 1].rstrip() + "…"


def is_weapon(module: Dict[str, Any]) -> bool:
    name = str(module.get("name", "")).lower()
    return name.startswith("hpt_") or any(hint in name for hint in WEAPON_HINTS)


def _age_seconds(iso: str, now: Optional[float]) -> Optional[float]:
    """Сколько секунд назад событие дало это значение (по timestamp журнала)."""
    if not iso:
        return None
    try:
        import calendar
        import datetime as _dt
        import time as _time
        stamp = str(iso).replace("Z", "").split(".")[0]
        parsed = _dt.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S")
        # Журнал пишет UTC, а `time.mktime` — локальный часовой пояс:
        # берём calendar.timegm, иначе «возраст» съедет на целую зону.
        made = calendar.timegm(parsed.timetuple())
    except (ValueError, TypeError):
        return None
    reference = now if now is not None else _time.time()
    return max(0.0, float(reference) - made)


#: Подпись «только что»: её же сравнивает сборка HUD, чтобы не тратить место
#: на строку «данные свежие». Сравнение идёт с переводом, а не с русским
#: текстом, — иначе после смены языка подпись попадала бы в подсказку.
AGE_NOW = "сейчас"


def age_text(iso: str, now: Optional[float] = None) -> str:
    """«сейчас» / «42с» / «7м» / «2ч» — насколько свежи данные."""
    seconds = _age_seconds(iso, now)
    if seconds is None:
        return ""
    if seconds < 10:
        return tr(AGE_NOW)
    if seconds < 60:
        return tr("{seconds}с", seconds=int(seconds))
    if seconds < 3600:
        return tr("{minutes}м", minutes=int(seconds // 60))
    if seconds < 86400:
        return tr("{hours}ч", hours=int(seconds // 3600))
    return tr("{days}д", days=int(seconds // 86400))


def hhmm(iso: str) -> str:
    """Часы:минуты из штампа журнала ('' если штампа нет)."""
    text = str(iso or "")
    if "T" in text:
        return text.split("T", 1)[1][:5]
    return ""


def module_rows(modules: Sequence[Dict[str, Any]], *, mode: str = "important",
                limit: int = MAX_MODULE_ROWS) -> Tuple[List[Dict[str, Any]], int]:
    """Строки модулей и число тех, что не показаны.

    «Важные» = повреждённые, выключенные и ключевые системы: список держится
    в одном экране и не превращается в простыню из 27 строк. Целые второстепенные
    модули в компактном режиме не показываются вовсе — их место под итогом.
    """
    items = [m for m in modules if m.get("slot")]

    def rank(module: Dict[str, Any]) -> Tuple[int, int, str]:
        health = percent_of(module.get("health"))
        if health < 100:
            group = 0
        elif not module.get("on", True):
            group = 1
        elif "repairer" not in str(module.get("name", "")).lower() and any(
                hint in str(module.get("name", "")).lower() for hint in CRITICAL_HINTS):
            group = 2
        else:
            group = 3
        return (group, health, str(module.get("slot", "")))

    ordered = sorted(items, key=rank)
    if str(mode or "important").lower() == "important":
        ordered = [m for m in ordered if rank(m)[0] <= 2]
    shown = ordered[:limit] if limit else ordered
    rows = []
    for module in shown:
        percent = percent_of(module.get("health"))
        row = {
            "slot": slot_label(module.get("slot", "")),
            "name": short_name(module.get("name", "")),
            "percent": percent,
            "tone": tone_for_percent(percent),
            "on": bool(module.get("on", True)),
            "priority": int(module.get("priority", 0) or 0),
            "power": float(module.get("power", 0.0) or 0.0),
            "engineered": bool(module.get("engineered")),
            "suspect": bool(module.get("suspect")),
        }
        clip = module.get("ammo_clip")
        hopper = module.get("ammo_hopper")
        if clip is not None and hopper is not None:
            row["ammo"] = f"{int(clip) + int(hopper)}"
        rows.append(row)
    return rows, max(0, len(ordered) - len(rows))


def module_mark(row: Dict[str, Any]) -> str:
    """Пометка состояния модуля перед строкой: ``?``, ``!``, ``*`` или пробел."""
    if row.get("suspect"):
        return "?"
    percent = int(row.get("percent") or 0)
    if percent < 50:
        return "!"
    if percent < 100:
        return "*"
    return " "


def module_note(row: Dict[str, Any]) -> str:
    """Заметка строки модуля: «ВЫКЛ», приоритет питания, боезапас."""
    flags = []
    if not row.get("on", True):
        flags.append(tr("ВЫКЛ"))
    if row.get("priority"):
        flags.append(f"P{row['priority']}")
    if row.get("ammo"):
        flags.append(tr("ЗАП {ammo}", ammo=row["ammo"]))
    return " ".join(flags)


def module_line(row: Dict[str, Any], *, bar_width: int = BAR_NARROW,
                slot: bool = True, name: Optional[str] = None,
                note: bool = True) -> str:
    """Строка модуля из кусков: метка, слот, имя, шкала, процент, заметка.

    Шкала — отдельное слово строки, поэтому её нельзя «порезать пополам»:
    либо она есть целиком, либо её нет.
    """
    pieces = [module_mark(row)]
    if slot and row.get("slot"):
        pieces.append(f"{row['slot']:>6}")
    text = str(row.get("name") or "—") if name is None else str(name)
    if text:
        pieces.append(text)
    if bar_width > 0:
        scale = bar(row.get("percent"), int(bar_width))
        if scale:
            pieces.append(scale)
    pieces.append(f"{int(row.get('percent') or 0):>3}%")
    line = " ".join(piece for piece in pieces if piece)
    tail = module_note(row)
    if note and tail:
        line = f"{line} {tail}"
    return line


def fit_module_line(row: Dict[str, Any], budget: int,
                    *, bar_limit: int = BAR_NARROW) -> str:
    """Строка модуля ровно по бюджету блока — без «обрезанной» шкалы.

    Раньше строка собиралась как есть, а потом резалась по числу символов:
    многоточие съедало то заметку, то процент, то саму шкалу — именно это и
    выглядело как «оверлей обрезает прогресс-бары». Теперь теряется не хвост
    строки, а самый необязательный кусок, и порядок потерь задан здесь:

    1. номер слота («05/S2») — модуль и так узнаётся по имени;
    2. заметка («ВЫКЛ», «P2», «ЗАП 12») — уточнение к проценту;
    3. шкала: клетки убавляются целиком (6 → 5 → 4 → 3 → 2), потом пропадает;
    4. имя модуля укорачивается с многоточием — в последнюю очередь.

    Процент и пометка состояния остаются всегда: это и есть данные.
    """
    budget = int(budget)
    note = module_note(row)
    name = str(row.get("name") or "—")
    percent = f"{int(row.get('percent') or 0):>3}%"

    widths: List[int] = []
    for width in (int(bar_limit), 5, 4, 3, 2, 0):
        if 0 <= width <= max(0, int(bar_limit)) and width not in widths:
            widths.append(width)

    def compose(bar_width: int, with_note: bool, with_slot: bool, text: str) -> str:
        pieces = [module_mark(row)]
        if with_slot and row.get("slot"):
            pieces.append(f"{row['slot']:>6}")
        if text:
            pieces.append(text)
        if bar_width > 0:
            scale = bar(row.get("percent"), bar_width)
            if scale:
                pieces.append(scale)
        pieces.append(percent)
        line = " ".join(piece for piece in pieces if piece)
        if with_note and note:
            line = f"{line} {note}"
        return line

    if budget <= 0:
        return percent.strip()
    # Порядок перебора = порядок потерь: шкала пробуется целиком, внутри одной
    # её ширины сначала отдаём номер слота, потом заметку.
    for bar_width in widths:
        for with_note in (True, False):
            for with_slot in (True, False):
                line = compose(bar_width, with_note, with_slot, name)
                if len(line) <= budget:
                    return line
    # Всё равно длинно: шкалу сохраняем, а имя режем по месту.
    for bar_width in widths:
        for with_slot in (False, True):
            headroom = budget - len(compose(bar_width, False, with_slot, "")) - 1
            if headroom < 4:
                continue
            cut = name[:max(1, headroom - 1)].rstrip() + "…"
            line = compose(bar_width, False, with_slot, cut)
            if len(line) <= budget:
                return line
    tail = f"{module_mark(row)} {percent}"
    if len(tail) <= budget:
        return tail
    return percent if len(percent) <= budget else percent.strip()[:budget]


def modules_table_line(row: Dict[str, Any], *, width: int = 34) -> str:
    """Одна строка списка модулей: метка слота, имя, шкала, процент, заметка.

    Отдельная функция — потому что и текстовый дамп, и оверлей должны печатать
    ровно одну и ту же строку: иначе «что в тесте» и «что на экране» разъедутся,
    а это ровно тот класс багов, из-за которого HUD и переписывали. ``width`` —
    бюджет строки в символах: длиннее она не бывает никогда, и шкала не рвётся
    посередине (см. :func:`fit_module_line`).
    """
    return fit_module_line(row, width)


def module_bar_limit(rows: Sequence[Dict[str, Any]], budget: int,
                     *, max_width: int = BAR_NARROW) -> int:
    """Общая ширина шкалы для всех строк списка: колонки обязаны совпадать.

    Если у каждой строки ужимать шкалу отдельно, проценты встанут по разным
    колонкам и таблица рассыплется. Поэтому ширину выбираем одну — самую
    широкую из тех, при которых в бюджет влезает любая строка.
    """
    for width in range(max(0, int(max_width)), 1, -1):
        if all(len(module_line(row, bar_width=width, note=False)) <= budget
               for row in rows):
            return width
    return 0


def modules_table(rows: Sequence[Dict[str, Any]], *, width: int = 34) -> str:
    rows = list(rows)
    limit = module_bar_limit(rows, width)
    return "\n".join(fit_module_line(row, width, bar_limit=limit) for row in rows)


def build_ship_hud(state: Dict[str, Any], *, settings: Optional[Dict[str, Any]] = None,
                   now: Optional[float] = None) -> Dict[str, Any]:
    """Собрать компактное состояние корабля для оверлея.

    :param state: ``ShipTracker.get_state_dict()``.
    :param settings: настройки блока — по ним режутся разрезы (``show_*``) и
        режим списка модулей (``ship_modules_view``).
    :param now: «сейчас» для возраста данных (секунды с эпохи); нужен в тестах.
    """
    settings = settings or {}

    def shown(section: str, default: bool = True) -> bool:
        if section == "modules":
            return modules_mode != "off"
        return bool(settings.get(f"show_{section}", default))

    # Старая настройка `show_modules` сильнее новой: снятая галочка «Модули»
    # обязана прятать список, каким бы ни был выбранный режим.
    modules_hidden = settings.get("show_modules", True) is False
    if modules_hidden:
        modules_mode = "off"
    else:
        modules_mode = str(settings.get("ship_modules_view") or "important").lower()
    if modules_mode not in ("important", "all", "off"):
        modules_mode = "important"

    if not has_ship_data(state):
        return empty_hud()

    hull_percent = state.get("hull_percent")
    hull_percent = percent_of(hull_percent, default=0) if hull_percent is not None else None
    shield_state = str(state.get("shield_state") or "unknown")
    power_used = float(state.get("power_used") or 0.0)
    power_cap = float(state.get("power_capacity") or 0.0)
    power_percent = percent_of(state.get("power_percent"), default=0)
    fuel_level = float(state.get("fuel_level") or 0.0)
    fuel_cap = float(state.get("fuel_capacity") or 0.0)
    fuel_res = float(state.get("fuel_reservoir") or 0.0)
    fuel_percent = percent_of(state.get("fuel_percent"), default=0)
    modules = list(state.get("modules") or [])
    damaged = [m for m in modules if percent_of(m.get("health")) < 100]
    critical = [m for m in damaged if percent_of(m.get("health")) < 50]
    off = [m for m in modules if not m.get("on", True)]

    lines: List[Dict[str, Any]] = []

    if shown("hull"):
        hint_bits = []
        hull_age = age_text(state.get("hull_at", ""), now)
        # «сейчас» — не информация, а место в строке стоит дорого.
        if hull_age and hull_age != tr(AGE_NOW):
            hint_bits.append(hull_age)
        source = str(state.get("hull_source") or "")
        if source:
            hint_bits.append(hull_source_text(source))
        lines.append({
            "section": "hull",
            "kind": "bar",
            "label": tr("КОРПУС"),
            "value": (f"{hull_percent}%" if hull_percent is not None
                      else tr("нет данных")),
            "hint": " · ".join(hint_bits),
            "percent": hull_percent,
            "bar_width": BAR_WIDTH_DEFAULT,
            "tone": tone_for_percent(hull_percent),
        })

    if shown("shield"):
        # Процента щитов в журнале нет — показываем состояние, а не выдуманные 100 %.
        value = tr({"up": "вверху", "down": "упали", "none": "нет генератора",
                    "unknown": "нет данных"}[shield_state])
        lines.append({
            "section": "shield",
            "kind": "bar",
            "label": tr("ЩИТЫ"),
            "value": value,
            "hint": (tr("регенерация") if shield_state == "down" else ""),
            # Процента щитов журнал не отдаёт: шкалы нет, только состояние.
            "percent": None,
            "tone": {"up": "ok", "down": "bad", "none": "muted", "unknown": "muted"}[shield_state],
        })

    if shown("power"):
        hint = ""
        if shown("pips"):
            # Pips — 4 символа на группу вместо 7: строка влезает в блок целиком,
            # а цвет и так показывает перегрузку (шкала тут только шум).
            hint = (f"SYS{int(state.get('pips_sys', 0) or 0)}·"
                    f"ENG{int(state.get('pips_eng', 0) or 0)}·"
                    f"WEP{int(state.get('pips_wep', 0) or 0)}")
        lines.append({
            "section": "power",
            "kind": "bar",
            "label": tr("ЭНЕРГИЯ"),
            "value": (f"{power_used:.2f}/{power_cap:.2f} MW" if power_cap > 0
                      else f"{power_used:.2f} MW"),
            "hint": hint,
            "percent": None,
            "tone": "bad" if power_percent >= 100 else ("warn" if power_percent >= 80 else "ok"),
        })

    if shown("fuel"):
        hint_bits = []
        if fuel_res > 0:
            hint_bits.append(tr("рез {value}", value=f"{fuel_res:.1f}"))
        if state.get("fuel_low"):
            hint_bits.append(tr("МАЛО"))
        lines.append({
            "section": "fuel",
            "kind": "bar",
            "label": tr("ТОПЛИВО"),
            "value": (f"{fuel_level:.1f}/{fuel_cap:.1f} t" if fuel_cap > 0
                      else f"{fuel_level:.1f} t"),
            "hint": " · ".join(hint_bits),
            "percent": fuel_percent if fuel_cap > 0 else None,
            "bar_width": 8,  # топлива хватает на знак, а не на шкалу
            "tone": "bad" if fuel_percent <= 10 else ("warn" if fuel_percent <= 25 else "ok"),
        })

    info_bits = []
    if shown("cargo_info"):
        info_bits.append(tr("ГРУЗ {used}/{capacity} t",
                            used=int(state.get("cargo_count", 0) or 0),
                            capacity=int(state.get("cargo_capacity", 0) or 0)))
    ammo_total = state.get("ammo_total")
    if ammo_total is not None:
        info_bits.append(tr("БОЕЗАПАС {ammo}", ammo=int(ammo_total)))
        if state.get("ammo_stale"):
            info_bits[-1] += "?"
    afmu = state.get("afmu") or {}
    if afmu.get("charges") is not None:
        label = f"AFMU {int(afmu['charges'])}"
        if afmu.get("capacity"):
            label += f"/{int(afmu['capacity'])}"
        info_bits.append(label)
    if shown("balance") and int(state.get("balance", 0) or 0) > 0:
        info_bits.append(f"{int(state['balance']):,} CR".replace(",", " "))
    if shown("legal") and str(state.get("legal_state", "Clean")) != "Clean":
        info_bits.append(str(state["legal_state"]).upper())
    if info_bits:
        lines.append({"section": "cargo_info", "kind": "text", "label": "",
                      "parts": info_bits,
                      "value": "  ·  ".join(info_bits), "hint": "",
                      "tone": "warn" if "WANTED" in " ".join(info_bits).upper() else "text"})

    if shown("destination") and state.get("destination_name"):
        lines.append({"section": "destination", "kind": "text", "label": tr("КУДА"),
                      "value": str(state["destination_name"]), "hint": "", "tone": "muted"})

    chips: List[Dict[str, str]] = []
    if shown("flags"):
        # Сравниваем имена флагов, а не подписи: подпись зависит от языка, и
        # сравнение по ней ломалось при смене языка интерфейса.
        seen = set()
        for name, text, tone in CHIP_RULES:
            if name in (state.get("flags_list") or []) and name not in seen:
                seen.add(name)
                chips.append({"text": tr(text), "tone": tone})
        if state.get("overheat") and "Overheat" not in seen:
            chips.append({"text": tr("ПЕРЕГРЕВ"), "tone": "bad"})
        if state.get("canopy_breached"):
            chips.append({"text": tr("КАБИНА ПРОБИТА"), "tone": "bad"})
        if state.get("systems_offline"):
            chips.append({"text": tr("СИСТЕМЫ ВЫКЛ"), "tone": "bad"})

    rows, hidden = module_rows(modules, mode=modules_mode)
    if modules_mode == "off":
        rows, hidden = [], 0
    damage_bits: List[str] = []
    modules_head_bits = [tr("{count} мод.", count=len(modules))]
    if damaged:
        damage_bits.append(tr("повр {count}", count=len(damaged)))
    if critical:
        damage_bits.append(tr("крит {count}", count=len(critical)))
    # «выкл» дублирует строку списка (в ней стоит ВЫКЛ): две подсказки про одно
    # и то же на счету компактности не поместятся. При «только итог» строк нет —
    # там счётчик выключенных остаётся.
    if off and not any(not row["on"] for row in rows):
        damage_bits.append(tr("выкл {count}", count=len(off)))
    snapshot_age = age_text(state.get("modules_at", ""), now)
    if snapshot_age and snapshot_age != tr(AGE_NOW) and modules_mode != "off":
        damage_bits.append(tr("снимок {age}", age=snapshot_age))
    modules_note = (tr("прочность целых модулей — по снимку: журнал её не обновляет")
                    if state.get("modules_incomplete") else "")
    if modules_mode == "off" and (modules_hidden or not damage_bits):
        # Галочка «Модули» снята совсем — строку не показываем даже с итогом;
        # режим «только итог» остаётся, но молчит, когда повредить нечего.
        modules_head_bits = []
        modules_note = ""
    if modules_hidden:
        hidden = 0

    # В ленте слот меняем на короткое имя модуля: «Slot03_Size3» втрое длиннее
    # «ЩИТ», а в логе программы остаётся точный идентификатор.
    slot_names = {str(m.get("slot")): short_name(m.get("name", ""))
                  for m in modules if m.get("slot")}
    incidents = []
    for row in list(state.get("incidents") or [])[-MAX_INCIDENT_LINES:]:
        text = str(row.get("text") or "")
        if not text:
            continue
        for slot, display in slot_names.items():
            if slot and display and display != slot and slot in text:
                text = text.replace(slot, display)
                break
        incidents.append(f"{hhmm(row.get('at', ''))} {text}".strip())
    rows_payload = [modules_table_line(row) for row in rows]

    signature = "|".join([
        str(hull_percent), shield_state, str(power_percent), f"{power_used:.2f}",
        f"{fuel_level:.2f}", f"{fuel_res:.3f}", str(state.get("cargo_count")),
        str(ammo_total), str(afmu.get("charges")), ",".join(sorted(c["text"] for c in chips)),
        str(state.get("modules_at", "")), str(state.get("hull_at", "")),
        str(len(damaged)), str(len(off)), str(hidden), ";".join(str(r) for r in rows),
        ";".join(incidents), str(state.get("legal_state")), str(state.get("balance")),
        str(state.get("destination_name")), str(state.get("overheat")),
        str(state.get("canopy_breached")), str(state.get("systems_offline")),
        modules_note,
    ])

    return {
        "title": ship_title(state),
        "chips": chips,
        "lines": lines,
        "modules": {
            "header": (tr("МОДУЛИ ·") + " " + " · ".join(modules_head_bits + damage_bits)
                       if modules_head_bits else ""),
            #: Те же кусочки по отдельности — при узком блоке заголовок
            #  переносится целиком, а не обрезается.
            "header_parts": list(modules_head_bits + damage_bits),
            "rows": rows,
            "text": "\n".join(rows_payload),
            "hidden": hidden,
            "mode": modules_mode,
            "note": modules_note,
        },
        "incidents": incidents,
        "signature": signature,
        "empty": False,
        #: Бюджет строки: оверлей и тесты меряют компактность по нему.
        "max_chars": line_budget(settings),
    }


def has_ship_data(state: Dict[str, Any]) -> bool:
    """Есть ли о корабле хоть что-нибудь: тип, снимок модулей, корпус или Status."""
    if not isinstance(state, dict) or not state:
        return False
    if state.get("ship_type") or state.get("modules") or state.get("hull_percent") is not None:
        return True
    return str(state.get("shield_state") or "unknown") in ("up", "down", "none")


def empty_hud() -> Dict[str, Any]:
    """HUD без данных: одна честная строка вместо шести рядов нулей.

    Нули — это ложь: «ТОПЛИВО 0.00 t» читается как «бак пуст», хотя корабль
    просто ещё не описан журналом.
    """
    return {
        "title": ship_title({}),
        "chips": [],
        "lines": [{"section": "note", "kind": "text", "label": "",
                   "value": empty_hint(), "hint": "", "tone": "muted", "percent": None}],
        "modules": {"header": "", "rows": [], "text": "", "hidden": 0,
                    "mode": "off", "note": ""},
        "incidents": [],
        "signature": "empty",
        "empty": True,
        "max_chars": DEFAULT_MAX_CHARS,
    }


def ship_title(state: Dict[str, Any]) -> str:
    """Заголовок блока: тип, имя и идентификатор корабля в одну строку."""
    ship_type = str(state.get("ship_type") or tr("Корабль не определён"))
    name = str(state.get("ship_name") or "").strip()
    ident = str(state.get("ship_ident") or "").strip()
    parts = [ship_type]
    if name:
        parts.append(f"«{name}»")
    if ident:
        parts.append(f"[{ident}]")
    return " ".join(parts)[:46]




#: Насколько уменьшать шрифт строки относительно базового — ради компактности.
ROW_FONT_DELTA = {"bar": 0, "text": -1, "mod": -1, "note": -2, "event": -2}
#: Тоны HUD -> цвета оверлея (маппинг держит оверлей, здесь только имена).
ROW_TONES = ("ok", "warn", "bad", "muted", "text", "info")


def pack_parts(parts: Sequence[str], max_chars: int) -> List[str]:
    """Собрать короткие строки из кусочков: «A · B», перенося целые куски.

    Длинная строка в Tk переносится по ширине и занимает две высоты. Здесь мы
    режем сами — по границам показателей, а не по середине числа.
    """
    lines: List[str] = []
    current = ""
    for part in parts:
        text = str(part).strip()
        if not text:
            continue
        candidate = f"{current} · {text}" if current else text
        if current and len(candidate) > max_chars:
            lines.append(current)
            current = text
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def fit_bar_line(line: Dict[str, Any], budget: int, bar_limit: int) -> str:
    """Строка со шкалой: тесно — сначала коротаем шкалу, потом убираем подпись.

    Перенос строки в Tk стоит двойной высоты блока, а терять проще декорацию
    (шкалу) и уточнение (возраст/источник), чем само число.
    """
    percent = line.get("percent")
    value = str(line.get("value", ""))
    hint = str(line.get("hint") or "")
    label = str(line.get("label") or "")
    width = max(0, min(int(line.get("bar_width", BAR_WIDTH_DEFAULT)), int(bar_limit)))
    attempts = []
    for scale_width in (width, max(4, width // 2), 0):
        for tail in ((hint, "") if hint else ("",)):
            attempts.append((bar(percent, scale_width) if scale_width else "", tail))
    for scale, tail in attempts:
        body = " ".join(part for part in (scale, value) if part)
        # Метка — ровно 7 символов (длиннейшей, «ЭНЕРГИЯ», этого хватает),
        # скобки через один пробел: иначе строка не влезает в блок 360 px.
        text = f"{label:<7} {body}".rstrip()
        if tail:
            text += f" ({tail})"
        if len(text) <= budget:
            return text.rstrip()
    return f"{label.strip()} {value}".strip()


def hud_rows(hud: Dict[str, Any], max_chars: Optional[int] = None) -> List[Dict[str, Any]]:
    """Плоский список строк для оверлея: текст, тон и размер шрифта.

    Оверлей рисует ровно то, что возвращает эта функция, — тесты проверяют
    раскладку здесь и не могут разойтись с Tk-кодом.
    """
    budget = int(max_chars or hud.get("max_chars") or DEFAULT_MAX_CHARS)
    # Узкий блок или крупный шрифт: шкалу укорачиваем, чтобы строка не переносилась.
    bar_limit = max(4, min(BAR_MAX_WIDTH, budget - 26))
    rows: List[Dict[str, Any]] = []
    for line in hud.get("lines") or []:
        if line.get("parts"):
            for packed in pack_parts(line["parts"], budget):
                label = line.get("label") or ""
                text = f"{label} {packed}".strip() if label else packed
                rows.append({"kind": line["kind"], "text": text,
                             "tone": line.get("tone", "text")})
            continue
        if line["kind"] == "bar":
            text = fit_bar_line(line, budget, bar_limit)
        else:
            label = line.get("label") or ""
            text = f"{label} {line['value']}".strip() if label else str(line.get("value", ""))
            if line.get("hint"):
                text += f"  ({line['hint']})"
        rows.append({"kind": line["kind"], "text": text.rstrip(), "tone": line.get("tone", "text")})
    modules = hud.get("modules") or {}
    if modules.get("header"):
        parts = [p for p in (modules.get("header_parts") or []) if p]
        # Метка «МОДУЛИ ·» занимает ~8 символов — учитываем это в бюджете частей.
        head = tr("МОДУЛИ ·")
        if parts:
            chunks = pack_parts(parts, budget - len(head) - 1)
            texts = [f"{head} {chunks[0]}"] + [f" · {chunk}" for chunk in chunks[1:]]
        else:
            texts = [modules["header"]]
        for packed in texts:
            rows.append({"kind": "text", "text": clip(packed, budget), "tone": "muted"})
    module_list = list(modules.get("rows") or [])
    # Одна ширина шкалы на весь список: иначе колонка процентов «пляшет».
    bar_limit = module_bar_limit(module_list, budget)
    for row in module_list:
        rows.append({"kind": "mod",
                     "text": fit_module_line(row, budget, bar_limit=bar_limit),
                     "tone": row.get("tone", "ok")})
    tail_bits = []
    if modules.get("hidden"):
        tail_bits.append(tr("ещё {count}", count=modules["hidden"]))
    if modules.get("note"):
        tail_bits.append(modules["note"])
    if tail_bits:
        rows.append({"kind": "note", "text": "  " + " · ".join(tail_bits), "tone": "muted"})
    for row in hud.get("incidents") or []:
        rows.append({"kind": "event", "text": row, "tone": "muted"})
    # Страховка: ни одна строка не должна переноситься — полная формулировка
    # остаётся в логе программы, здесь важно только начало.
    for row in rows:
        row["text"] = clip(row["text"], budget)
    return rows


def limit_module_rows(hud: Dict[str, Any], keep: int) -> Dict[str, Any]:
    """Оставить в списке модулей ``keep`` строк, остальные свернуть в «ещё N».

    Блок HUD — окно фиксированного размера: если список длиннее, Qt ужимает
    строки, и текст режется по высоте (а при включённом переносе вторая половина
    строки просто не рисуется). Поэтому лишние строки не «сжимаются», а
    убираются из списка — с честным счётчиком в последней строке.
    """
    modules = dict(hud.get("modules") or {})
    rows = list(modules.get("rows") or [])
    keep = max(0, min(int(keep), len(rows)))
    if keep == len(rows):
        return hud
    dropped = len(rows) - keep
    limited = dict(hud)
    modules["rows"] = rows[:keep]
    modules["hidden"] = int(modules.get("hidden") or 0) + dropped
    modules["text"] = "\n".join(modules_table_line(row) for row in modules["rows"])
    limited["modules"] = modules
    return limited


def render_hud_text(hud: Dict[str, Any]) -> str:
    """Текстовое представление HUD — то же, что печатает оверлей.

    Нужен тестам (и отладочному логу): проверка компактности и состава строк не
    должна требовать Tk.
    """
    out: List[str] = [hud.get("title", "")]
    chips = hud.get("chips") or []
    if chips:
        out.append(" ".join(f"[{chip['text']}]" for chip in chips))
    out.extend(row["text"] for row in hud_rows(hud))
    return "\n".join(part for part in out if part)
