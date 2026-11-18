"""Путешествие по маршруту: разбор вставленного маршрута, позиция пилота и статистика.

Зачем отдельный модуль. Вкладка «Путешествия» решает четыре задачи, и все они
проверяются без окна, игры и сети:

* **принять маршрут любым способом** — вставкой в поле (текст с сайта, список
  систем, содержимое ``NavRoute.json``), загрузкой того же текста из файла или
  готовым ``NavRoute.json``. Форматов в жизни больше, чем один: пилот копирует
  список из блокнота, из Discord, из выгрузки сайта; игра пишет JSON; Excel
  сохраняет CSV. Разбор здесь один на всех, поэтому «вставил — а оно не
  прочиталось» ловится тестом, а не на живом сервере;
* **знать, где сейчас пилот** — система из журнала сопоставляется с маршрутом:
  всё до неё считается пройденным, она сама — текущей, остальное ждёт;
* **назвать следующую систему** — её же кладут в буфер обмена, когда включён
  режим следования (скопировать имя и вставить в игру — быстрее, чем искать
  в галактической карте);
* **посчитать статистику пути** — сколько пройдено и осталось, сколько ещё
  прыжков, сколько световых лет впереди, сколько времени в пути и когда
  примерно финиш.

Правило проекта «не выдумывать данные» соблюдается строго: расстояние
считается только по известным координатам систем, а темп и оценка прибытия —
только по замеренным в этой сессии прыжкам. Пока прыжков не было, вместо
«прибудете через 2 часа» стоит прочерк: выдуманная оценка хуже её отсутствия.

Модуль чистый: ни Qt, ни сети, ни файлов. Подписи он получает через
``translate`` (в программе — ``i18n.tr``), поэтому тесты видят ровно тот
текст, что уедет на экран.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

#: Прочерк для неизвестных значений. Ноль и «неизвестно» — разные вещи, и в
#: статистике маршрута это различие важнее всего: «осталось 0 св. л.» означает
#: финиш, а «координат нет» — что считать нечем.
DASH = "—"

#: Маркеры форматов, которые пишет игра.
NAVROUTE_KEYS = ("Route", "NavRoute", "route", "systems")

#: Слова, которые не могут быть именем системы: это заголовки таблиц и
#: служебные подписи, попавшие в текст вместе с маршрутом.
HEADER_WORDS = frozenset({
    "#", "№", "система", "system", "systems", "name", "star_system",
    "starsystem", "статус", "status", "посещена", "visited", "visited_at",
    "прыжок", "jump", "x", "y", "z",
})

#: Разделители, которыми люди перечисляют системы в одной строке.
SEPARATORS = ("→", "->", "=>", "»", "\t", "|", ";")

#: Номер строки в начале: «1.», «1)», «#1 », «№ 1 —». Имена систем вроде
#: «LHS 3447» не задеваются: после цифр обязателен разделитель.
NUMBER_PREFIX = re.compile(r"^\s*(?:#|№)\s*\d+\s*[.):\-–—]?\s+|^\s*\d+\s*[.):\-–—]\s+")

#: Комментарий в тексте маршрута: так помечают планы в блокноте.
COMMENT_PREFIXES = ("//",)

#: Символы, которые обрезаются по краям имени системы (кавычки, маркеры).
TRIM_CHARS = " \t\"'«»“”`.,;:•*–—-"


# ---------------------------------------------------------------------------
#  Разбор маршрута
# ---------------------------------------------------------------------------
@dataclass
class ParsedRoute:
    """Разобранный маршрут: системы, определённый формат и что сказать пилоту."""

    systems: List[Dict[str, Any]] = field(default_factory=list)
    #: ``navroute`` (JSON игры), ``json`` (список JSON), ``csv`` (файл/текст с
    #: заголовками), ``list`` (список строк) или ``empty``.
    format: str = "empty"
    #: Исходный текст для CSV: его разбирает ``RouteTracker.load_from_csv``,
    #: чтобы правила чтения собственной выгрузки жили в одном месте.
    raw: str = ""
    #: Причина отказа — на языке интерфейса (её печатает окно).
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error and bool(self.systems)


def clean_name(value: Any) -> str:
    """Имя системы из строки: без кавычек, номеров и хвостовой пунктуации."""
    text = str(value or "").strip()
    text = NUMBER_PREFIX.sub("", text)
    # «# Sol» — маркер пункта списка; в именах систем решётки не бывает.
    text = text.lstrip("#").strip()
    text = text.strip(TRIM_CHARS)
    # Внутренние двойные пробелы — обычный след копирования из таблицы.
    return re.sub(r"\s{2,}", " ", text)


def _coords(item: Dict[str, Any]) -> Optional[List[float]]:
    """Координаты системы, если они полные и числовые."""
    for key in ("StarPos", "star_pos", "coordinates", "coords", "position"):
        value = item.get(key)
        if isinstance(value, (list, tuple)) and len(value) == 3:
            try:
                numbers = [float(v) for v in value]
            except (TypeError, ValueError):
                return None
            return numbers if all(math.isfinite(v) for v in numbers) else None
        if isinstance(value, dict):
            nested = [value.get(axis) for axis in "xyz"]
            if all(isinstance(v, (int, float)) for v in nested):
                return [float(v) for v in nested]
    xyz = [item.get(axis) for axis in ("x", "y", "z")]
    if all(isinstance(v, (int, float)) for v in xyz):
        return [float(v) for v in xyz]
    return None


def _system_from_item(item: Any) -> Optional[Dict[str, Any]]:
    """Одна система из элемента JSON: имя + координаты, если они есть."""
    if isinstance(item, str):
        name = clean_name(item)
        return {"name": name} if name else None
    if not isinstance(item, dict):
        return None
    for key in ("StarSystem", "name", "system", "System", "star_system"):
        name = clean_name(item.get(key))
        if name:
            system: Dict[str, Any] = {"name": name}
            position = _coords(item)
            if position is not None:
                system["star_pos"] = position
            star_class = str(item.get("StarClass") or item.get("star_class") or "").strip()
            if star_class:
                system["star_class"] = star_class
            address = item.get("SystemAddress") or item.get("system_address")
            if isinstance(address, (int, float)) and address:
                system["system_address"] = int(address)
            return system
    return None


def _unique(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Убрать повторы имён, сохранив порядок (маршрут игры может повторяться)."""
    seen = set()
    result: List[Dict[str, Any]] = []
    for item in items:
        key = str(item.get("name") or "").casefold()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _split_line(line: str) -> List[str]:
    """Системы из одной строки: «Sol → Alpha Centauri», «Sol|Wolf 359»…"""
    parts = [line]
    for separator in SEPARATORS:
        expanded: List[str] = []
        for part in parts:
            expanded.extend(part.split(separator))
        parts = expanded
    return parts


def _parse_lines(lines: Sequence[str]) -> List[Dict[str, Any]]:
    """Список систем из строк текста (запятые режем только внутри строки).

    Повторы убираются по всему списку, а не только подряд: маршрут, скопиро-
    ванный дважды (или с заголовком таблицы посредине), иначе удвоил бы все
    прыжки. Порядок первого появления сохраняется.
    """
    systems: List[Dict[str, Any]] = []
    seen = set()
    for line in lines:
        text = str(line).strip()
        if not text or text.startswith(COMMENT_PREFIXES):
            continue
        for part in _split_line(text):
            # Запятая — не разделитель в именах систем Elite, но часто
            # разделитель в списке; режем, если частей получилось больше одной.
            chunks = [chunk for chunk in part.split(",")] if "," in part else [part]
            for chunk in chunks:
                name = clean_name(chunk)
                if not name or name.casefold() in HEADER_WORDS:
                    continue
                # «1», «42» — остатки нумерации, а не системы.
                if name.isdigit():
                    continue
                key = name.casefold()
                if key in seen:
                    continue
                seen.add(key)
                systems.append({"name": name})
    return systems


def _looks_like_csv(lines: Sequence[str]) -> bool:
    """Первая строка выглядит как заголовок таблицы с колонкой «Система»?"""
    if len(lines) < 2:
        return False
    header = lines[0]
    if ";" not in header and "\t" not in header and "," not in header:
        return False
    lowered = header.casefold()
    return any(word in lowered for word in ("система", "system", "name", "star_system"))


def parse_route_text(text: Any) -> ParsedRoute:
    """Разобрать маршрут из текста: JSON игры, JSON-список, CSV или список строк.

    Пустой текст — не ошибка, а «маршрута нет»: окно скажет об этом подписью,
    а не красной строкой.
    """
    raw = str(text or "").lstrip("\ufeff")
    stripped = raw.strip()
    if not stripped:
        return ParsedRoute(format="empty")
    lines = [line for line in raw.splitlines() if line.strip()]

    if stripped[0] in "{[":
        try:
            data = json.loads(stripped)
        except ValueError:
            data = None
        if isinstance(data, dict):
            route = next((data.get(key) for key in NAVROUTE_KEYS
                          if isinstance(data.get(key), list)), None)
            if route is not None:
                systems = _unique([s for s in (_system_from_item(i) for i in route) if s])
                if systems:
                    return ParsedRoute(systems=systems, format="navroute")
                return ParsedRoute(format="json",
                                   error="в маршруте не нашлось ни одной системы")
        elif isinstance(data, list):
            systems = _unique([s for s in (_system_from_item(i) for i in data) if s])
            if systems:
                return ParsedRoute(systems=systems, format="json")
            return ParsedRoute(format="json",
                               error="в списке не нашлось ни одной системы")
        if data is not None:
            # JSON разобрался, но маршрута в нём нет (чужой файл, обрезанный
            # ответ сайта). Разбирать его как список строк — значит принять
            # «{"a": 1}» за имя системы.
            return ParsedRoute(format="json",
                               error="в JSON нет списка систем маршрута")
        if not _looks_like_csv(lines):
            return ParsedRoute(
                format="json",
                error="это не JSON: проверьте, что скопирован маршрут целиком")

    if _looks_like_csv(lines):
        return ParsedRoute(format="csv", raw=raw)

    systems = _parse_lines(lines)
    if not systems:
        return ParsedRoute(format="list", error="в тексте не нашлось ни одной системы")
    return ParsedRoute(systems=systems, format="list")


# ---------------------------------------------------------------------------
#  Сессия путешествия: когда начали и с какой скоростью идём
# ---------------------------------------------------------------------------
@dataclass
class Jump:
    """Один замеренный прыжок: система и когда пилот в неё пришёл."""

    name: str
    at: float
    distance: Optional[float] = None


class TravelSession:
    """Замеры текущего путешествия: старт, прыжки, темп.

    Темп считается ТОЛЬКО по замерам этой сессии: среднее между первым и
    последним прыжком. Пока прыжков меньше двух, темп неизвестен — и оценка
    прибытия честно пустая, а не «примерно 2 часа» из воздуха.
    """

    def __init__(self, started_at: Optional[float] = None,
                 jumps: Optional[Iterable[Jump]] = None) -> None:
        self.started_at = started_at
        self.jumps: List[Jump] = list(jumps or ())

    # -- ведение -------------------------------------------------------------
    def start(self, at: Optional[float] = None) -> None:
        if self.started_at is None:
            self.started_at = float(at if at is not None else _now())

    def restart(self, at: Optional[float] = None) -> None:
        self.started_at = float(at if at is not None else _now())
        self.jumps = []

    def record(self, name: str, at: Optional[float] = None,
               distance: Optional[float] = None) -> bool:
        """Записать прыжок. Повтор той же системы подряд — не прыжок."""
        text = clean_name(name)
        if not text:
            return False
        if self.jumps and self.jumps[-1].name.casefold() == text.casefold():
            return False
        moment = float(at if at is not None else _now())
        self.start(at=moment)
        self.jumps.append(Jump(name=text, at=moment,
                               distance=None if distance is None else float(distance)))
        return True

    def reset(self) -> None:
        self.started_at = None
        self.jumps = []

    # -- измерения -----------------------------------------------------------
    def elapsed(self, now: Optional[float] = None) -> Optional[float]:
        if self.started_at is None:
            return None
        return max(0.0, float(now if now is not None else _now()) - self.started_at)

    def tempo(self, now: Optional[float] = None) -> Optional[float]:
        """Секунд на прыжок по замерам сессии (минимум два прыжка)."""
        if len(self.jumps) < 2:
            return None
        span = self.jumps[-1].at - self.jumps[0].at
        if span <= 0:
            return None
        return span / (len(self.jumps) - 1)

    def measured_distance(self) -> Optional[float]:
        """Сколько световых лет пройдено по замерам (если расстояния известны)."""
        known = [jump.distance for jump in self.jumps if jump.distance is not None]
        if not known:
            return None
        return float(sum(known))


def _now() -> float:
    import time

    return time.time()


# ---------------------------------------------------------------------------
#  Форматирование
# ---------------------------------------------------------------------------
def _tr(translate: Optional[Callable[[str], str]]) -> Callable[[str], str]:
    return translate if callable(translate) else (lambda text: text)


def format_duration(seconds: Optional[float], translate: Optional[Callable] = None) -> str:
    """Длительность по-человечески: «2 ч 14 мин», «47 мин», «35 с»."""
    tr = _tr(translate)
    if seconds is None:
        return DASH
    total = int(max(0, round(float(seconds))))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return tr("{hours} ч {minutes} мин").format(hours=hours, minutes=minutes)
    if minutes:
        return tr("{minutes} мин").format(minutes=minutes)
    return tr("{seconds} с").format(seconds=secs)


def format_light_years(value: Optional[float], translate: Optional[Callable] = None) -> str:
    """Расстояние в световых годах: один знак после точки, «св. л.» в подписи."""
    tr = _tr(translate)
    if value is None:
        return DASH
    return tr("{value} св. л.").format(value=f"{float(value):.1f}")


def format_clock(moment: Optional[float], translate: Optional[Callable] = None) -> str:
    """Время прибытия как часы:минуты — только если оценка вообще есть."""
    tr = _tr(translate)
    if moment is None:
        return DASH
    import datetime

    stamp = datetime.datetime.fromtimestamp(float(moment))
    return tr("около {time}").format(time=stamp.strftime("%H:%M"))


# ---------------------------------------------------------------------------
#  Позиция пилота и состав маршрута
# ---------------------------------------------------------------------------
def _key(name: Any) -> str:
    return str(name or "").strip().casefold()


def find_system(systems: Sequence[Dict[str, Any]], name: str) -> int:
    """Индекс системы в маршруте по имени (регистр и пробелы не важны), иначе -1."""
    wanted = _key(name)
    if not wanted:
        return -1
    for index, system in enumerate(systems):
        if _key(system.get("name")) == wanted:
            return index
    return -1


def pending_from(systems: Sequence[Dict[str, Any]], position: int) -> List[Dict[str, Any]]:
    """Системы, которые ещё впереди: после позиции пилота, кроме пройденных."""
    start = 0 if position < 0 else position + 1
    return [system for system in systems[start:]
            if str(system.get("status") or "pending") != "visited"]


def next_system_name(systems: Sequence[Dict[str, Any]], current: str = "") -> str:
    """Имя следующей системы маршрута — то, что уходит в буфер обмена."""
    position = find_system(systems, current)
    if position >= 0 and _key(systems[position].get("name")) == _key(current):
        # Пилот уже в системе маршрута: следующая — первая непройденная после неё.
        ahead = pending_from(systems, position)
        if ahead:
            return str(ahead[0].get("name") or "")
        return ""
    ahead = [system for system in systems
             if str(system.get("status") or "pending") != "visited"]
    return str(ahead[0].get("name") or "") if ahead else ""


def _point(system: Dict[str, Any]) -> Optional[List[float]]:
    value = system.get("star_pos")
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return [float(v) for v in value]
        except (TypeError, ValueError):
            return None
    return None


def _distance(a: Optional[Sequence[float]], b: Optional[Sequence[float]]) -> Optional[float]:
    if a is None or b is None:
        return None
    return math.dist(list(a), list(b))


def _legs(systems: Sequence[Dict[str, Any]], start: int, stop: int) -> Optional[float]:
    """Сумма расстояний между системами ``start…stop`` — None, если хоть одно неизвестно.

    Лучше честный прочерк, чем «осталось 40 св. л.», посчитанные по дырке в
    координатах: пилот по такой цифре планирует топливо.
    """
    total = 0.0
    for index in range(max(0, start), max(0, min(stop, len(systems) - 1))):
        leg = _distance(_point(systems[index]), _point(systems[index + 1]))
        if leg is None:
            return None
        total += leg
    return total


def route_distances(systems: Sequence[Dict[str, Any]],
                    position: int) -> Dict[str, Optional[float]]:
    """Пройдено, осталось и всего — по координатам, если они известны.

    Координаты есть не у всех маршрутов (CSV без X/Y/Z, список из блокнота,
    выгрузка без столбцов координат). Поэтому каждая из трёх цифр считается
    отдельно и независимо: неизвестное плечо обнуляет только свою цифру.
    """
    done = _legs(systems, 0, position) if position >= 1 else None
    left = _legs(systems, position, len(systems) - 1) \
        if 0 <= position < len(systems) - 1 else None
    total = done + left if done is not None and left is not None else None
    return {"distance_done": done, "distance_left": left, "distance_total": total}


# ---------------------------------------------------------------------------
#  Статистика и подписи для вкладки
# ---------------------------------------------------------------------------
#: Показатели маршрута — в порядке показа. Ключ — как у страницы, текст — ключ
#: перевода (его переводит ``travel_state`` через ``translate``).
STAT_KEYS: Tuple[Tuple[str, str], ...] = (
    ("visited", "Пройдено"),
    ("jumps_left", "Осталось прыжков"),
    ("distance_done", "Пройдено, св. л."),
    ("distance_left", "Осталось лететь"),
    ("elapsed", "В пути"),
    ("tempo", "Среднее на прыжок"),
    ("eta", "Прибытие примерно"),
    ("current", "Сейчас"),
    ("next", "Следующая"),
    ("destination", "Финиш"),
)

#: Полезное о следующей системе — то, что пилот иначе ищет в карте и на сайте.
INFO_KEYS: Tuple[Tuple[str, str], ...] = (
    ("star", "Звезда"),
    ("jump", "Прыжок"),
    ("construction", "Стройка"),
    ("discoverer", "Первооткрыватель"),
    ("bodies", "Тел в системе"),
)

#: Символы класса звезды, у которых есть топливо для дозаправки в полёте.
SCOOPABLE_STARS = frozenset("OBAFGKM")


def _construction_text(hint: Dict[str, Any], tr: Callable[[str], str]) -> str:
    """Строка о стройке в следующей системе — без выдумок про неизвестное."""
    status = str(hint.get("status") or "").strip()
    if status == "building":
        progress = hint.get("progress")
        remaining = hint.get("remaining")
        parts = []
        if isinstance(progress, (int, float)):
            parts.append(tr("{value}% готово").format(value=int(round(float(progress)))))
        if isinstance(remaining, (int, float)) and float(remaining) > 0:
            parts.append(tr("осталось {tons} т").format(tons=int(round(float(remaining)))))
        return " · ".join(parts) or tr("идёт")
    if status == "done":
        return tr("стройка завершена")
    if status == "planned":
        return tr("стройка запланирована")
    if hint.get("known") is False and hint.get("system"):
        return tr("системы нет в базе проекта")
    return DASH


def travel_state(systems: Sequence[Dict[str, Any]], *, current: str = "",
                 session: Optional[TravelSession] = None,
                 hint: Optional[Dict[str, Any]] = None, follow: bool = False,
                 now: Optional[float] = None,
                 translate: Optional[Callable[[str], str]] = None,
                 upcoming_limit: int = 30) -> Dict[str, Any]:
    """Собрать всё, что показывает вкладка «Путешествия».

    Возвращает готовые подписи (переведённые), поэтому страница ничего не
    считает и не решает: она только раскладывает значения по виджетам.
    """
    tr = _tr(translate)
    systems = list(systems or ())
    hint = dict(hint or {})
    moment = float(now if now is not None else _now())
    limit = max(0, int(upcoming_limit))

    if not systems:
        return {
            "loaded": False,
            "status": tr("Маршрут не загружен"),
            "follow": bool(follow),
            "progress": 0.0,
            "stats": {key: DASH for key, _title in STAT_KEYS},
            "info": {key: DASH for key, _title in INFO_KEYS},
            "upcoming": [],
            "next": "",
            "note": tr("Вставьте маршрут в поле выше или загрузите его из файла."),
        }

    position = find_system(systems, current)
    visited = sum(1 for system in systems
                  if str(system.get("status") or "") == "visited")
    ahead = pending_from(systems, position) if position >= 0 else [
        system for system in systems if str(system.get("status") or "") != "visited"]
    next_name = str(ahead[0].get("name") or "") if ahead else ""
    destination = str(systems[-1].get("name") or "")
    done = position + 1 if position >= 0 else visited
    progress = 100.0 * done / len(systems) if systems else 0.0

    # Позиция пилота: текущая система маршрута, система из журнала или «вне».
    if position >= 0:
        current_text = str(systems[position].get("name") or current or DASH)
    else:
        current_text = current or DASH

    distances = route_distances(systems, position)
    session = session or TravelSession()
    elapsed = session.elapsed(moment) if session.started_at is not None else None
    tempo = session.tempo(moment)
    eta = tempo * len(ahead) if (tempo is not None and ahead) else None
    arrival = moment + eta if eta is not None else None

    if position < 0 and current:
        status = tr("Вы вне маршрута: {current}").format(current=current)
        note = tr("Маршрут загружен, но пилот не в нём: следующая система — {next}.").format(
            next=next_name or DASH)
    elif not ahead:
        status = tr("Маршрут пройден: {destination}").format(destination=destination)
        note = tr("Все системы маршрута отмечены пройденными.")
    else:
        status = tr("Следующая: {next} · осталось прыжков: {jumps}").format(
            next=next_name, jumps=len(ahead))
        note = tr("Слежение включено: имя следующей системы копируется в буфер обмена.") \
            if follow else tr("Включите слежение, чтобы следующая система попадала в буфер обмена.")

    jump_from = _point(systems[position]) if position >= 0 else None
    jump_to = _point(ahead[0]) if ahead else None
    jump_distance = _distance(jump_from, jump_to) if ahead else None
    star = str(ahead[0].get("star_class") or hint.get("star_class") or "").strip() \
        if ahead else ""
    if star:
        scoopable = str(hint.get("scoopable")) if hint.get("scoopable") is not None else None
        if scoopable is None:
            scoopable = star.upper()[:1] in SCOOPABLE_STARS
        star_text = tr("{star} · заправка есть").format(star=star) if scoopable else \
            tr("{star} · заправки нет").format(star=star)
    else:
        star_text = DASH

    bodies = hint.get("bodies")
    bodies_text = tr("{count} тел").format(count=int(bodies)) \
        if isinstance(bodies, (int, float)) and float(bodies) > 0 else DASH
    discoverer = str(hint.get("discoverer") or "").strip()

    stats = {
        "visited": tr("{done} из {total}").format(done=done, total=len(systems)),
        "jumps_left": str(len(ahead)),
        "distance_done": format_light_years(distances["distance_done"], translate),
        "distance_left": format_light_years(distances["distance_left"], translate),
        "elapsed": format_duration(elapsed, translate),
        "tempo": format_duration(tempo, translate),
        "eta": format_clock(arrival, translate) if eta is not None else DASH,
        "current": current_text,
        "next": next_name or DASH,
        "destination": destination or DASH,
    }
    info = {
        "star": star_text,
        "jump": format_light_years(jump_distance, translate),
        "construction": _construction_text(hint, tr) if hint else DASH,
        "discoverer": discoverer or DASH,
        "bodies": bodies_text,
    }
    upcoming = []
    for offset, system in enumerate(ahead[:limit]):
        index = (position + 1 + offset) if position >= 0 else offset + 1
        previous = system
        leg = None
        if offset > 0:
            leg = _distance(_point(ahead[offset - 1]), _point(previous))
        elif position >= 0:
            leg = _distance(_point(systems[position]), _point(system))
        upcoming.append((offset + 1, str(system.get("name") or ""),
                         format_light_years(leg, translate) if leg is not None else DASH))
    if len(ahead) > limit:
        note = note + " " + tr("Показаны первые {count} систем из {total}.").format(
            count=limit, total=len(ahead))

    return {
        "loaded": True,
        "status": status,
        "follow": bool(follow),
        "progress": progress,
        "stats": stats,
        "info": info,
        "upcoming": upcoming,
        "next": next_name,
        "note": note,
        "position": position,
        "destination": destination,
    }


def follow_status_text(follow: bool, systems: Sequence[Dict[str, Any]],
                       translate: Optional[Callable[[str], str]] = None) -> str:
    """Короткая строка состояния слежения для подписи у галочки."""
    tr = _tr(translate)
    if not systems:
        return tr("Слежение выключено: маршрута нет")
    return tr("Слежение включено") if follow else tr("Слежение выключено")


def route_format_title(fmt: str, translate: Optional[Callable[[str], str]] = None) -> str:
    """Название распознанного формата — пилоту видно, что именно прочиталось."""
    tr = _tr(translate)
    return {
        "navroute": tr("маршрут игры (NavRoute)"),
        "json": tr("список JSON"),
        "csv": tr("файл CSV"),
        "list": tr("список систем"),
    }.get(str(fmt), tr("неизвестный формат"))


__all__ = [
    "DASH", "INFO_KEYS", "Jump", "ParsedRoute", "STAT_KEYS", "TravelSession",
    "clean_name", "find_system", "follow_status_text", "format_clock",
    "format_duration", "format_light_years", "next_system_name", "parse_route_text",
    "pending_from", "route_distances", "route_format_title", "travel_state",
]
