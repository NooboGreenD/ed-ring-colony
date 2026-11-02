"""Выгрузка маршрута в CSV: какие столбцы выгружать и что в них попадает.

Раньше «Экспорт CSV» писал ровно четыре столбца (`index`, `system`, `status`,
`visited_at`) — ни расстояний, ни координат, ни данных о системах. Командиру же
нужен файл под свою задачу: одному — имена и расстояния, другому — тела,
первооткрыватели и готовность строек по маршруту.

Здесь описан весь набор столбцов и то, откуда берётся каждый: часть лежит в
самом маршруте (`NavRoute.json`, выгрузка из Atlas), часть приходит из подсказок
сайта (`/api/systems/route-hint` — тела, картография, первооткрыватель, стройка,
координаты). Модуль чистый: ни Qt, ни сети, ни файлов — поэтому его правила
проверяются обычными тестами, а окно выбора столбцов и запросы к сайту живут в
`helper_pages.RouteExportDialog` и `colonial_helper`.

Правило про пустоту: неизвестное значение — **пустая строка**, а не ноль. «Тел в
системе: 0» и «тел в системе неизвестно» — разные вещи, и в таблице это должно
быть видно.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

#: Разделитель столбцов: точка с запятой, как в выгрузках Atlas. Русский Excel
#: открывает такой файл сразу, не склеивая всё в одну колонку.
DELIMITER = ";"
#: BOM: без него Excel считает файл однобайтовым и ломает кириллицу.
BOM = "\ufeff"
LINE_END = "\r\n"


@dataclass(frozen=True)
class Field:
    """Один столбец выгрузки."""

    key: str
    #: Заголовок — ключ перевода (``tr()`` зовёт тот, кто собирает файл).
    title: str
    #: Значение приходит из подсказки о системе (сайт проекта), а не из маршрута.
    needs_hint: bool = False
    #: Координата в световых годах: печатается с тремя знаками.
    coordinate: bool = False


#: Столбцы в порядке появления в файле: от «что за система» к подробностям.
FIELDS: Tuple[Field, ...] = (
    # Номер строки не переводится (в каталоге его нет) — как заголовок «#»
    # в таблице маршрута.
    Field("index", "#"),
    Field("system", "Система"),
    Field("status", "Статус"),
    Field("visited_at", "Посещена"),
    Field("jump_ly", "Прыжок от предыдущей, св. л."),
    Field("x", "X, св. л.", coordinate=True),
    Field("y", "Y, св. л.", coordinate=True),
    Field("z", "Z, св. л.", coordinate=True),
    Field("bodies", "Тел в системе", needs_hint=True),
    Field("mapped", "Просканировано тел", needs_hint=True),
    Field("footfall", "Первый шаг по поверхности", needs_hint=True),
    Field("discoverer", "Первооткрыватель", needs_hint=True),
    Field("construction", "Стройка", needs_hint=True),
    Field("progress", "Готовность стройки, %", needs_hint=True),
    Field("remaining", "Осталось завезти, т", needs_hint=True),
    Field("system_address", "Адрес системы"),
)

BY_KEY: Dict[str, Field] = {field.key: field for field in FIELDS}

#: Без имени системы файл нечего выгружать — этот столбец есть всегда.
REQUIRED_KEYS: Tuple[str, ...] = ("system",)

#: Прежний формат выгрузки: те же четыре столбца, что были до меню.
DEFAULT_KEYS: Tuple[str, ...] = ("index", "system", "status", "visited_at")

#: Статусы маршрута: ключи перевода одинаковы у таблицы, экспорта и CSV.
STATUS_TITLES = {"visited": "Посещена", "current": "Текущая", "pending": "Ожидает"}

#: Состояния стройки из подсказки сайта (см. `route_hint.py`).
CONSTRUCTION_TITLES = {
    "building": "стройка идёт",
    "done": "стройка завершена",
    "planned": "стройка запланирована",
}


def default_keys() -> List[str]:
    """Столбцы по умолчанию — прежний формат файла."""
    return list(DEFAULT_KEYS)


def all_keys() -> List[str]:
    return [field.key for field in FIELDS]


def normalize_keys(keys: Optional[Iterable[str]]) -> List[str]:
    """Выбор из окна → порядок столбцов в файле.

    Неизвестные ключи отбрасываются, обязательные (`system`) добавляются
    всегда, а порядок фиксирован `FIELDS`: так файл читается одинаково, что бы
    ни нажимали в окне. Пустой выбор означает «прежний формат», а не пустой файл.
    """
    chosen = {str(key or "").strip() for key in keys or ()}
    chosen &= set(BY_KEY)
    if not chosen:
        chosen = set(DEFAULT_KEYS)
    chosen |= set(REQUIRED_KEYS)
    return [field.key for field in FIELDS if field.key in chosen]


def needs_hints(keys: Optional[Iterable[str]]) -> bool:
    """Нужны ли для этих столбцов данные сайта о системах."""
    return any(BY_KEY[key].needs_hint for key in normalize_keys(keys))


def needs_coordinates(keys: Optional[Iterable[str]]) -> bool:
    """Нужны ли координаты: свои есть не у каждого маршрута.

    `NavRoute.json` и выгрузка из Atlas приносят `StarPos`, а маршрут,
    набранный вручную или импортированный из списка имён, — нет. Тогда
    координаты берутся из подсказки сайта (и кэша), и без этого расстояния в
    файле остались бы пустыми.
    """
    return any(key in ("x", "y", "z", "jump_ly") for key in normalize_keys(keys))


def header_aliases(field: Field) -> List[str]:
    """Как этот столбец может называться в файле — по убыванию приоритета.

    Своя выгрузка пишет заголовок на языке интерфейса, старые файлы — по-
    английски, а координаты ещё и с единицами («X, св. л.»). Поэтому к ключу и
    русскому оригиналу добавляются все переводы из каталога.
    """
    names: List[str] = [field.key, field.title]
    if field.coordinate:
        # «X, св. л.» → «x»: единицы в заголовке могли быть другими.
        names.append(field.title.split(",")[0])
    try:
        import i18n
        from locale_config import SUPPORTED_LOCALES

        for code in list(SUPPORTED_LOCALES) + ["ru"]:
            text = i18n.catalog(code).get(field.title)
            if not text:
                continue
            names.append(str(text))
            if field.coordinate:
                names.append(str(text).split(",")[0])
    except Exception:            # каталога нет — хватает ключа и оригинала
        pass
    result: List[str] = []
    for name in names:
        alias = str(name or "").strip().casefold()
        if alias and alias not in result:
            result.append(alias)
    return result


def sniff_delimiter(header: str) -> str:
    """Разделитель файла по первой строке: ``;`` или ``,``.

    Считаем только то, что стоит вне кавычек. Иначе наша же выгрузка с
    координатами («X, св. л.») набирает столько же запятых, сколько в ней
    разделителей, и файл читался бы по запятым — с мусором в заголовках.
    При равенстве побеждает ``;``: это формат выгрузки.
    """
    counts = {DELIMITER: 0, ",": 0}
    quoted = False
    for char in str(header or ""):
        if char == '"':
            quoted = not quoted
        elif not quoted and char in counts:
            counts[char] += 1
    return DELIMITER if counts[DELIMITER] >= counts[","] else ","


def read_columns(header: Sequence[str]) -> Dict[str, str]:
    """Заголовки прочитанного файла → ключ столбца → имя колонки в файле.

    Нужно, чтобы открыть обратно собственную выгрузку: заголовки в ней на языке
    интерфейса, поэтому поиск по ключу (`x`, `system_address`) их не находит.
    """
    present: Dict[str, str] = {}
    for column in header or ():
        name = str(column or "").strip().casefold()
        if name and name not in present:
            present[name] = str(column)
    found: Dict[str, str] = {}
    for field in FIELDS:
        for alias in header_aliases(field):
            column = present.get(alias)
            if column is not None:
                found[field.key] = column
                break
    return found


def titles(keys: Optional[Iterable[str]],
           translate: Optional[Callable[[str], str]] = None) -> List[str]:
    """Заголовки столбцов на языке интерфейса."""
    tr = translate or (lambda text: text)
    return [tr(BY_KEY[key].title) for key in normalize_keys(keys)]


# ---------------------------------------------------------------------------
#  Значения
# ---------------------------------------------------------------------------
def _num(value: Any) -> Optional[float]:
    """Число из маршрута или ответа сайта; мусор и пустота — ``None``."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _coord(value: Any) -> str:
    """Координата: три знака — этого хватает, чтобы различать соседние системы."""
    number = _num(value)
    return "" if number is None else f"{number:.3f}"


def _ly(value: Any) -> str:
    """Расстояние прыжка: два знака (дальше всё равно не прыгнуть)."""
    number = _num(value)
    return "" if number is None else f"{number:.2f}"


def _count(value: Any) -> str:
    """Целое из подсказки; неизвестное — пустая строка, а не ноль."""
    number = _num(value)
    return "" if number is None else str(int(round(number)))


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def format_visited(value: Any) -> str:
    """Время посещения как в таблице маршрута: ``31.10.2026 22:14``."""
    text = _text(value)
    if not text:
        return ""
    try:
        from datetime import datetime
        return datetime.fromisoformat(text).strftime("%d.%m.%Y %H:%M")
    except ValueError:
        return text


def position(system: Mapping[str, Any],
             hint: Optional[Mapping[str, Any]] = None) -> Optional[Tuple[float, float, float]]:
    """Координаты системы: из маршрута (`StarPos`), иначе из подсказки сайта."""
    star_pos = system.get("star_pos") or system.get("StarPos")
    if isinstance(star_pos, (list, tuple)) and len(star_pos) >= 3:
        values = [_num(star_pos[0]), _num(star_pos[1]), _num(star_pos[2])]
        if all(value is not None for value in values):
            return (values[0], values[1], values[2])        # type: ignore[return-value]
    for source in (system, hint or {}):
        if isinstance(source, Mapping) and source.get("coordinates"):
            point = source["coordinates"]
            if isinstance(point, Mapping):
                values = [_num(point.get(axis)) for axis in ("x", "y", "z")]
                if all(value is not None for value in values):
                    return (values[0], values[1], values[2])  # type: ignore[return-value]
    return None


def jump_distance(previous: Optional[Tuple[float, float, float]],
                  current: Optional[Tuple[float, float, float]]) -> Optional[float]:
    """Расстояние между соседними системами маршрута в световых годах."""
    if previous is None or current is None:
        return None
    return ((current[0] - previous[0]) ** 2
            + (current[1] - previous[1]) ** 2
            + (current[2] - previous[2]) ** 2) ** 0.5


def build_rows(systems: Sequence[Mapping[str, Any]],
               keys: Optional[Iterable[str]] = None,
               *, hints: Optional[Mapping[str, Mapping[str, Any]]] = None,
               translate: Optional[Callable[[str], str]] = None,
               status_text: Optional[Callable[[str], str]] = None) -> List[List[str]]:
    """Строки для CSV: значения в том порядке, что задаёт `keys`.

    :param hints: подсказки сайта по имени системы (``{имя: hint}``); нужны
        только для столбцов с ``needs_hint``.
    :param translate: ``tr`` для заголовков значений (состояние стройки).
    :param status_text: как назвать статус маршрута (``visited``/``current``/
        ``pending``) на языке интерфейса.
    """
    order = normalize_keys(keys)
    tr = translate or (lambda text: text)
    by_name = {str(name).casefold(): hint for name, hint in (hints or {}).items()}
    rows: List[List[str]] = []
    previous: Optional[Tuple[float, float, float]] = None
    for offset, system in enumerate(systems or ()):
        name = _text(system.get("name") or system.get("system"))
        hint = by_name.get(name.casefold()) or {}
        point = position(system, hint)
        jump = jump_distance(previous, point)
        # Неизвестные координаты обрывают цепочку: иначе «прыжок от предыдущей»
        # посчитался бы через пропущенную систему — правдоподобное, но неверное
        # число. Пустая ячейка честнее.
        previous = point
        values: Dict[str, str] = {
            "index": str(system.get("index") or offset + 1),
            "system": name,
            "status": (status_text(system.get("status") or "")
                       if callable(status_text) else _text(system.get("status"))),
            "visited_at": format_visited(system.get("visited_at")),
            "jump_ly": _ly(jump),
            "x": _coord(point[0]) if point else "",
            "y": _coord(point[1]) if point else "",
            "z": _coord(point[2]) if point else "",
            "bodies": _count(hint.get("bodies")) if hint else "",
            "mapped": _count(hint.get("mapped")) if hint else "",
            "footfall": _count(hint.get("footfall")) if hint else "",
            "discoverer": _text(hint.get("discoverer")),
            "construction": "",
            "progress": _count(hint.get("progress")) if hint else "",
            "remaining": _count(hint.get("remaining")) if hint else "",
            "system_address": _text(system.get("system_address")),
        }
        if hint:
            status = _text(hint.get("status"))
            values["construction"] = tr(CONSTRUCTION_TITLES[status]) if status in CONSTRUCTION_TITLES else ""
        rows.append([values.get(key, "") for key in order])
    return rows


def build_csv(systems: Sequence[Mapping[str, Any]],
              keys: Optional[Iterable[str]] = None, *,
              hints: Optional[Mapping[str, Mapping[str, Any]]] = None,
              translate: Optional[Callable[[str], str]] = None,
              status_text: Optional[Callable[[str], str]] = None) -> str:
    """Готовый текст CSV: BOM, ``;``, CRLF — открывается в Excel как таблица."""
    order = normalize_keys(keys)
    out = io.StringIO()
    writer = csv.writer(out, delimiter=DELIMITER, lineterminator=LINE_END,
                        quoting=csv.QUOTE_ALL)
    writer.writerow(titles(order, translate))
    writer.writerows(build_rows(systems, order, hints=hints, translate=translate,
                                status_text=status_text))
    return BOM + out.getvalue()


def row_count(text: str) -> int:
    """Сколько строк данных в готовом файле (без заголовка) — для журнала."""
    return max(0, len([line for line in str(text or "").splitlines() if line.strip()]) - 1)
