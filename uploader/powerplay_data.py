"""PowerPlay 2.0: состояние командира и текущей системы — из журнала игры.

Зачем отдельный модуль
----------------------
Вкладка BGS показывает две разные вещи об одном и том же месте: кто здесь
правит по BGS (фракции) и что здесь происходит по PowerPlay. Второе игра пишет
в журнал двумя наборами полей:

* **командир** — событие ``Powerplay`` (держава, ранг, заслуги, голоса, срок
  присяги) и события действий: ``PowerplayCollect``/``Deliver`` (сбор и
  доставка), ``PowerplayVote`` (голоса), ``PowerplaySalary`` (выплата),
  ``PowerplayJoin``/``Leave``/``Defect`` (присяга, уход, переход),
  ``PowerplayFastTrack`` и ``PowerplayVoucher``;
* **система** — ``FSDJump``/``Location``/``CarrierJump``: ``ControllingPower``
  (владелец), ``Powers`` (все державы, чьи зоны её накрывают — владелец и
  соседи), ``PowerplayState`` (оплот, укреплённая, эксплуатируемая, свободная)
  и счётчики ``PowerplayStateControlProgress``/``…Reinforcement``/``…Undermining``.

Правило про «владельца» здесь то же, что на сайте (``POWERPLAY.md``): ``Powers``
— это не владелец, владелец только ``ControllingPower``. Без него показываем
«держава не определена», а не угадываем по единственной державе в списке.

Ещё одно правило — версия PowerPlay: наблюдения раньше 29.10.2024 не
принимаются, в PowerPlay 1.0 те же поля значили другое (проверка та же, что в
``src/lib/powerplayJournal.ts``).

Модуль без Qt и без сети: рисует — ``qt_powerplay``, сети — ``api_client``.
"""
from __future__ import annotations

import json
import threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Mapping, Optional

#: Запуск PowerPlay 2.0 (обновление «Ascendancy»): раньше поля значили другое.
POWERPLAY2_START = "2024-10-29T00:00:00Z"

#: Двенадцать держав PowerPlay 2.0 — тот же справочник, что
#: ``POWERPLAY_POWERS`` в ``src/lib/powerplay.ts``: имена как в журнале, подписи
#: как в игре и цвета, подобранные читаемыми на тёмном фоне.
POWERS: tuple = (
    {"name": "A. Lavigny-Duval", "label": "Arissa Lavigny-Duval",
     "allegiance": "Empire", "color": "#a13cf0"},
    {"name": "Aisling Duval", "label": "Aisling Duval",
     "allegiance": "Empire", "color": "#19b5e6"},
    {"name": "Archon Delaine", "label": "Archon Delaine",
     "allegiance": "Independent", "color": "#ef3b3d"},
    {"name": "Denton Patreus", "label": "Denton Patreus",
     "allegiance": "Empire", "color": "#4ad4da"},
    {"name": "Edmund Mahon", "label": "Edmund Mahon",
     "allegiance": "Alliance", "color": "#2fb53a"},
    {"name": "Felicia Winters", "label": "Felicia Winters",
     "allegiance": "Federation", "color": "#f0af28"},
    {"name": "Jerome Archer", "label": "Jerome Archer",
     "allegiance": "Federation", "color": "#e94ae6"},
    {"name": "Li Yong-Rui", "label": "Li Yong-Rui",
     "allegiance": "Independent", "color": "#2df598"},
    {"name": "Nakato Kaine", "label": "Nakato Kaine",
     "allegiance": "Alliance", "color": "#b6f837"},
    {"name": "Pranav Antal", "label": "Pranav Antal",
     "allegiance": "Independent", "color": "#f8f62e"},
    {"name": "Yuri Grom", "label": "Yuri Grom",
     "allegiance": "Independent", "color": "#ff7b2e"},
    {"name": "Zemina Torval", "label": "Zemina Torval",
     "allegiance": "Empire", "color": "#3d82f5"},
    # Наследие PowerPlay 1.0: в свежих данных не встречается, но старый журнал
    # не должен превращать знакомую державу в безымянную серую строку.
    {"name": "Zachary Hudson", "label": "Zachary Hudson",
     "allegiance": "Federation", "color": "#c2410c"},
)

#: Сторона державы — ключ перевода для подписи.
ALLEGIANCES = {
    "Empire": "Империя",
    "Federation": "Федерация",
    "Alliance": "Альянс",
    "Independent": "Независимые",
}

#: Состояние системы в PowerPlay 2.0: подпись (ключ перевода), зона влияния и
#: цвет для карточки. ``Stronghold``/``Fortified``/``Exploited`` — под
#: контролем державы; ``Unoccupied`` — свободна (её можно захватывать);
#: ``Contested`` — спорная, идёт борьба.
SYSTEM_STATES: Dict[str, Dict[str, Any]] = {
    "Stronghold": {"title": "Оплот", "range_ly": 30, "color": "#e57b28"},
    "Fortified": {"title": "Укреплённая", "range_ly": 20, "color": "#42b9d4"},
    "Exploited": {"title": "Эксплуатируемая", "range_ly": 0, "color": "#65c78a"},
    "Unoccupied": {"title": "Свободная система", "range_ly": 0, "color": "#8794a1"},
    "Contested": {"title": "Спорная", "range_ly": 0, "color": "#e27676"},
}

#: События о самом командире (держава, ранг, заслуги, действия).
COMMANDER_EVENTS = frozenset({
    "Powerplay", "PowerplayJoin", "PowerplayLeave", "PowerplayDefect",
    "PowerplayVote", "PowerplaySalary", "PowerplayCollect", "PowerplayDeliver",
    "PowerplayFastTrack", "PowerplayVoucher", "PowerplayMerits", "PowerplayRank",
})
#: События с состоянием системы в PowerPlay.
SYSTEM_EVENTS = frozenset({"FSDJump", "Location", "CarrierJump"})
#: Поля PowerPlay в событии системы — тот же список, что в ``bgs_sync``.
SYSTEM_FIELDS = ("ControllingPower", "Powers", "PowerplayState",
                 "PowerplayStateControlProgress", "PowerplayStateReinforcement",
                 "PowerplayStateUndermining")

#: Сколько последних действий командира помним и показываем.
ACTION_LIMIT = 8
#: Сколько последних файлов журнала просматривать.
JOURNAL_SCAN_FILES = 6
#: Сколько байт от конца файла читать: события PowerPlay — короткие строки.
JOURNAL_SCAN_BYTES = 2 * 1024 * 1024

def power_key(value: Any) -> str:
    """Ключ сравнения имени державы: регистр, точки, дефисы и кавычки не важны."""
    text = str(value or "").replace(".", " ").replace("-", " ")
    for char in ("_", "'", "’"):
        text = text.replace(char, " ")
    return " ".join(text.lower().split())


def power_info(value: Any) -> dict:
    """Держава по имени из журнала: подпись, сторона и цвет (неизвестная — своя).

    Новая держава, которой ещё нет в справочнике, не теряется: у неё остаётся
    имя из журнала и цвет, выведенный из имени, — так же поступает сайт.
    """
    name = normalize_power(value)
    if not name:
        return {}
    known = _POWERS_BY_KEY.get(power_key(name))
    if known:
        return dict(known)
    return {"name": name, "label": name, "allegiance": "", "color": color_for(name)}


def normalize_power(value: Any) -> str:
    """Каноническое имя державы (как пишет журнал); мусор — пустая строка."""
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split()).strip()
    if not text or len(text) > 64 or text.startswith("$"):
        return ""
    if not any(char.isalpha() for char in text):
        return ""
    known = _POWERS_BY_KEY.get(power_key(text))
    return known["name"] if known else text


def color_for(name: str) -> str:
    """Цвет по имени: тот же приём, что ``powerInfo`` на сайте (тон из хеша)."""
    hue = abs(_hash(name)) % 360
    return _hsl_to_hex(hue, 0.62, 0.58)


def state_info(value: Any) -> Dict[str, Any]:
    """Состояние системы PowerPlay: подпись, зона влияния и цвет.

    Неизвестное состояние не прячем: ``title`` пустой, а ``name`` — то, что
    пришло из журнала (например, новое состояние после обновления игры).
    """
    name = str(value or "").strip()
    if not name:
        return {}
    known = SYSTEM_STATES.get(name)
    if known:
        result = dict(known)
        result["name"] = name
        return result
    return {"name": name, "title": "", "range_ly": 0, "color": "#8794a1"}


def allegiance_title(value: Any) -> str:
    """Ключ перевода для стороны державы (пустая строка — стороны нет)."""
    return ALLEGIANCES.get(str(value or "").strip(), "")


# ---------------------------------------------------------------------------
#  Разбор значений
# ---------------------------------------------------------------------------
def _hash(text: str) -> int:
    """Хеш имени как 32-битное целое со знаком — как ``Math.imul`` на сайте."""
    value = 0
    for char in text:
        value = (value * 31 + ord(char)) & 0xFFFFFFFF
    return value - 0x100000000 if value >= 0x80000000 else value


def _hsl_to_hex(hue: int, saturation: float, lightness: float) -> str:
    """HSL → ``#rrggbb``: тот же пересчёт, что в справочнике держав сайта."""
    chroma = (1 - abs(2 * lightness - 1)) * saturation
    block = chroma * (1 - abs((hue / 60.0) % 2 - 1))
    if hue < 60:
        red, green, blue = chroma, block, 0.0
    elif hue < 120:
        red, green, blue = block, chroma, 0.0
    elif hue < 180:
        red, green, blue = 0.0, chroma, block
    elif hue < 240:
        red, green, blue = 0.0, block, chroma
    elif hue < 300:
        red, green, blue = block, 0.0, chroma
    else:
        red, green, blue = chroma, 0.0, block
    shift = lightness - chroma / 2
    return "#%02x%02x%02x" % tuple(int(round(min(1.0, max(0.0, value + shift)) * 255))
                                   for value in (red, green, blue))


_POWERS_BY_KEY: Dict[str, dict] = {}
for _power in POWERS:
    _POWERS_BY_KEY[power_key(_power["name"])] = _power
    _POWERS_BY_KEY[power_key(_power["label"])] = _power
for _alias, _canonical in (("arissa lavigny duval", "A. Lavigny-Duval"),
                           ("a lavigny duval", "A. Lavigny-Duval"),
                           ("lavigny duval", "A. Lavigny-Duval"),
                           ("li yong rui", "Li Yong-Rui"),
                           ("hudson", "Zachary Hudson")):
    for _power in POWERS:
        if _power["name"] == _canonical:
            _POWERS_BY_KEY.setdefault(_alias, _power)


def _int(value: Any, minimum: Optional[int] = None) -> Optional[int]:
    """Целое из журнала; мусор и пустое — ``None`` (а не ноль)."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None
    if minimum is not None and number < minimum:
        return None
    return number


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    if number != number:                          # NaN из битого JSON
        return None
    return number


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _powers_list(value: Any) -> List[str]:
    """``Powers`` журнала: канонические имена без повторов."""
    out: List[str] = []
    for item in value or []:
        name = normalize_power(item)
        if name and name not in out:
            out.append(name)
    return out


def parse_timestamp(value: Any) -> Optional[datetime]:
    """Время из журнала → ``datetime`` в UTC (``None``, если не разобрать)."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc)


def is_powerplay2(value: Any) -> bool:
    """Наблюдение из эпохи PowerPlay 2.0 (или время неизвестно — тогда верим)."""
    moment = parse_timestamp(value)
    started = parse_timestamp(POWERPLAY2_START)
    if moment is None or started is None:
        return True
    return moment >= started


def newer(first: Any, second: Any) -> bool:
    """Первое наблюдение не старше второго (снимок без времени — самое старое)."""
    first_at = parse_timestamp(first)
    second_at = parse_timestamp(second)
    if first_at is None:
        return False
    if second_at is None:
        return True
    return first_at >= second_at


def system_event(event: Mapping[str, Any]) -> bool:
    """Есть ли в событии системы хоть одно поле PowerPlay.

    ``FSDJump`` населённой системы вне PowerPlay полей не несёт вовсе — тогда
    показывать нечего, и подменять «неизвестно» нулями нельзя.
    """
    return any(event.get(key) is not None for key in SYSTEM_FIELDS)


def system_state(event: Mapping[str, Any], source: str = "journal") -> Optional[dict]:
    """Состояние PowerPlay системы из события журнала.

    Пустой результат — в событии нет PowerPlay (система свободна от него или
    журнал старше PowerPlay 2.0).
    """
    if not isinstance(event, Mapping):
        return None
    if event.get("event") not in SYSTEM_EVENTS:
        return None
    if not system_event(event):
        return None
    timestamp = _text(event.get("timestamp"))
    if not is_powerplay2(timestamp):
        return None
    name = _text(event.get("StarSystem"))
    if not name:
        return None
    state = state_info(event.get("PowerplayState"))
    controlling = normalize_power(event.get("ControllingPower"))
    return {
        "system": name,
        "address": _text(str(event.get("SystemAddress") or "")),
        "power": controlling,
        "state": state.get("name", ""),
        "powers": _powers_list(event.get("Powers")),
        "control_progress": _number(event.get("PowerplayStateControlProgress")),
        "reinforcement": _int(event.get("PowerplayStateReinforcement"), 0),
        "undermining": _int(event.get("PowerplayStateUndermining"), 0),
        "observed_at": timestamp,
        "source": source,
    }


def site_state(payload: Mapping[str, Any], system: str = "") -> Optional[dict]:
    """Состояние PowerPlay системы из ответа ``GET /api/systems/overview``.

    Сайт отдаёт то же наблюдение, но уже разложенное по ключам
    (``power``/``state``/``powers``/``controlProgress``…). Он нужен, когда в
    хвосте журнала системы нет: Helper запустили посреди сессии, а журнал успел
    провернуться.
    """
    if not isinstance(payload, Mapping):
        return None
    block = payload.get("powerplay")
    if not isinstance(block, Mapping):
        return None
    name = _text(payload.get("name")) or _text(system)
    state = state_info(block.get("state"))
    return {
        "system": name,
        "address": _text(str(payload.get("id64") or payload.get("key") or "")),
        "power": normalize_power(block.get("power")),
        "state": state.get("name", ""),
        "powers": _powers_list(block.get("powers")),
        "control_progress": _number(block.get("controlProgress")),
        "reinforcement": _int(block.get("reinforcement"), 0),
        "undermining": _int(block.get("undermining"), 0),
        "observed_at": _text(block.get("observedAt")),
        "source": "site",
    }


def action_record(event: Mapping[str, Any]) -> Optional[dict]:
    """Действие командира PowerPlay в виде, который рисует вкладка.

    Текст здесь не собирается: ``kind`` и числа — данные, подпись ставит UI на
    текущем языке (``qt_powerplay.action_text``).
    """
    kind = str(event.get("event") or "")
    if kind not in COMMANDER_EVENTS:
        return None
    record: Dict[str, Any] = {"kind": kind, "at": _text(event.get("timestamp"))}
    if kind == "PowerplayJoin":
        record["power"] = normalize_power(event.get("Power"))
    elif kind == "PowerplayLeave":
        record["power"] = normalize_power(event.get("Power"))
    elif kind == "PowerplayDefect":
        record["from_power"] = normalize_power(event.get("FromPower") or event.get("Power"))
        record["to_power"] = normalize_power(event.get("ToPower"))
    elif kind == "PowerplayMerits":
        record["count"] = _int(event.get("MeritsGained"), 0)
        record["total"] = _int(event.get("TotalMerits"), 0)
    elif kind == "PowerplayRank":
        record["count"] = _int(event.get("Rank"), 0)
    elif kind == "PowerplayVote":
        record["votes"] = _int(event.get("Votes"), 0)
    elif kind == "PowerplaySalary":
        record["amount"] = _int(event.get("Amount"), 0)
    elif kind in ("PowerplayCollect", "PowerplayDeliver"):
        record["count"] = _int(event.get("Count"), 0)
        record["item"] = _text(event.get("Type_Localised")) or _text(event.get("Type"))
    elif kind == "PowerplayFastTrack":
        record["amount"] = _int(event.get("Cost"), 0)
    elif kind == "PowerplayVoucher":
        systems = [str(item).strip() for item in event.get("Systems") or []
                   if str(item or "").strip()]
        record["systems"] = systems
        record["count"] = len(systems)
    return record


class PowerplayTracker:
    """Состояние PowerPlay: командир (держава, ранг, заслуги) и система.

    Один экземпляр живёт в Helper: живые события журнала зовут :meth:`handle`,
    фоновое чтение хвостов — тоже, а вкладка раз в кадр берёт :meth:`state`.
    Потокобезопасен: события приходят из потока watcher'а, а рисует Qt-поток.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._power = ""
        self._rank: Optional[int] = None
        self._merits: Optional[int] = None
        self._votes: Optional[int] = None
        self._time_pledged: Optional[int] = None
        self._pledged_at = ""
        self._commander_at = ""
        self._field_at = {}
        self._salary: Optional[dict] = None
        self._actions: Deque[dict] = deque(maxlen=ACTION_LIMIT)
        self._system: Optional[dict] = None

    # ------------------------------------------------------------------ данные
    def handle(self, event: Mapping[str, Any]) -> bool:
        """Обработать событие журнала; ``True`` — состояние изменилось."""
        if not isinstance(event, Mapping):
            return False
        name = str(event.get("event") or "")
        if name == "Powerplay":
            return self._take_commander(event)
        if name in COMMANDER_EVENTS:
            return self._take_action(event)
        if name in SYSTEM_EVENTS:
            return self._take_system(event)
        return False

    def _take_commander(self, event: Mapping[str, Any]) -> bool:
        """``Powerplay``: держава, ранг, заслуги, голоса и срок присяги.

        Полный снимок при входе; отдельные PowerplayMerits/PowerplayRank
        обновляют свои поля независимо. Старый снимок может заполнить ещё
        неизвестный ранг, но не откатывает уже полученные живые заслуги.
        """
        timestamp = _text(event.get("timestamp"))
        if not is_powerplay2(timestamp):
            # PowerPlay 1.0: те же поля значили другое (ранг 1–5, а не 1–100).
            return False
        power = normalize_power(event.get("Power"))
        if timestamp and not newer(timestamp, self._commander_at) \
                and self._commander_at:
            # Событие старше уже прочитанного (архив после живого): не откатываем.
            return False
        changed = False
        with self._lock:
            if power and timestamp >= self._field_at.get("_power", "") and power != self._power:
                self._power = power
                self._field_at["_power"] = timestamp
                changed = True
            for attribute, value in (("_rank", _int(event.get("Rank"), 0)),
                                     ("_merits", _int(event.get("Merits"), 0)),
                                     ("_votes", _int(event.get("Votes"), 0)),
                                     ("_time_pledged", _int(event.get("TimePledged"), 0))):
                if value is None or timestamp < self._field_at.get(attribute, ""):
                    continue
                self._field_at[attribute] = timestamp
                if getattr(self, attribute) != value:
                    setattr(self, attribute, value)
                    changed = True
            if timestamp and self._commander_at != timestamp:
                self._commander_at = timestamp
                changed = True
        return changed

    def _take_action(self, event: Mapping[str, Any]) -> bool:
        """Действие командира: заслуги, голоса, выплата, присяга, переход."""
        record = action_record(event)
        if record is None:
            return False
        if not any(record.get(key) not in (None, "", []) for key in
                   ("count", "votes", "amount", "power", "from_power",
                    "to_power", "systems")):
            # Пустая строка события (старый клиент, обрезанный журнал) ничего
            # не говорит: «собрано» без числа — не действие.
            return False
        timestamp = record.get("at") or ""
        kind = str(record.get("kind") or "")
        changed = False
        with self._lock:
            if kind in ("PowerplayMerits", "PowerplayRank"):
                field = "_merits" if kind == "PowerplayMerits" else "_rank"
                if not is_powerplay2(timestamp) or timestamp < max(self._commander_at, self._field_at.get(field, "")):
                    return False
                value = record.get("total") if kind == "PowerplayMerits" else record.get("count")
                if value is None:
                    return False
                setattr(self, field, value)  # TotalMerits is authoritative; never add the delta twice
                self._field_at[field] = timestamp
                if event.get("Power") and timestamp >= self._field_at.get("_power", ""):
                    self._power = normalize_power(event["Power"])
                    self._field_at["_power"] = timestamp
                changed = True
            elif kind in ("PowerplayJoin", "PowerplayLeave", "PowerplayDefect") and timestamp and timestamp < self._commander_at:
                return False
            elif kind == "PowerplayJoin" and record.get("power"):
                self._power = record["power"]
                self._rank = self._rank if self._rank is not None else 0
                self._merits = 0
                self._votes = 0
                self._time_pledged = 0
                self._pledged_at = timestamp
                changed = True
            elif kind == "PowerplayLeave":
                if self._power or self._rank is not None:
                    changed = True
                self._power = ""
                self._rank = None
                self._merits = None
                self._votes = None
                self._time_pledged = None
                self._pledged_at = ""
            elif kind == "PowerplayDefect" and record.get("to_power"):
                if record["to_power"] != self._power:
                    self._power = record["to_power"]
                    changed = True
                self._pledged_at = timestamp
                self._time_pledged = 0
            elif kind == "PowerplayVote" and record.get("votes") is not None:
                self._votes = record["votes"]
                changed = True
            elif kind == "PowerplaySalary":
                self._salary = {"amount": record.get("amount"), "at": timestamp}
                changed = True
            elif kind in ("PowerplayCollect", "PowerplayDeliver",
                          "PowerplayFastTrack", "PowerplayVoucher"):
                changed = True
            if changed and kind in ("PowerplayJoin", "PowerplayLeave", "PowerplayDefect"):
                self._commander_at = max(self._commander_at, timestamp)
                for field in ("_power", "_rank", "_merits", "_votes", "_time_pledged"):
                    self._field_at[field] = timestamp
        self._remember(record)
        return changed

    def _take_system(self, event: Mapping[str, Any]) -> bool:
        """Состояние системы из прыжка или ``Location``."""
        snapshot = system_state(event)
        if snapshot is None:
            return False
        return self.apply_system(snapshot)

    def apply_system(self, snapshot: Optional[Mapping[str, Any]]) -> bool:
        """Принять наблюдение системы, если оно не старше сохранённого."""
        if not isinstance(snapshot, Mapping) or not snapshot.get("system"):
            return False
        candidate = dict(snapshot)
        with self._lock:
            current = self._system or {}
            same_system = (str(current.get("system") or "").casefold()
                           == str(candidate.get("system") or "").casefold())
            if same_system and not newer(candidate.get("observed_at"),
                                         current.get("observed_at")):
                return False
            if current == candidate:
                return False
            self._system = candidate
        return True

    def _remember(self, record: Mapping[str, Any]) -> None:
        with self._lock:
            if self._actions and self._actions[0] == record:
                return
            self._actions.appendleft(dict(record))

    # ------------------------------------------------------------------ чтение
    def state(self, now_system: str = "") -> dict:
        """Всё, что рисует вкладка: командир, его действия и состояние системы."""
        with self._lock:
            power = power_info(self._power) if self._power else {}
            system = dict(self._system) if self._system else None
            actions = [dict(record) for record in self._actions]
            state = {
                "power": power,
                "rank": self._rank,
                "merits": self._merits,
                "votes": self._votes,
                "time_pledged": self._time_pledged,
                "pledged_at": self._pledged_at,
                "observed_at": max([self._commander_at, *self._field_at.values()]),
                "salary": dict(self._salary) if self._salary else None,
                "actions": actions,
            }
        if system and now_system:
            # Пилот уже в другой системе: чужое состояние на вкладке — неправда.
            if str(system.get("system") or "").casefold() != now_system.casefold():
                system = None
        if system:
            system["state_info"] = state_info(system.get("state"))
            system["power_info"] = (power_info(system.get("power"))
                                    if system.get("power") else {})
            system["powers_info"] = [power_info(name) for name in system.get("powers") or []]
        state["system"] = system
        state["known"] = bool(power or system or actions)
        return state

    def forget(self) -> None:
        """Забыть всё (смена командира в журнале): состояние было чужим."""
        with self._lock:
            self._power = ""
            self._rank = None
            self._merits = None
            self._votes = None
            self._time_pledged = None
            self._pledged_at = ""
            self._commander_at = ""
            self._field_at.clear()
            self._salary = None
            self._actions.clear()
            self._system = None


# ---------------------------------------------------------------------------
#  Хвосты журналов: то, что было до запуска Helper
# ---------------------------------------------------------------------------
def _matches(event: Mapping[str, Any], system: str, address: str) -> bool:
    own_address = _text(str(event.get("SystemAddress") or ""))
    if address and own_address:
        return own_address == address
    own_name = _text(event.get("StarSystem"))
    if system and own_name:
        return own_name.casefold() == system.casefold()
    return not system and not address


def scan_journal_for_powerplay(journal_dir: Any, system: str = "", address: Any = "",
                               files: int = JOURNAL_SCAN_FILES,
                               max_bytes: int = JOURNAL_SCAN_BYTES,
                               include_session: bool = False) -> dict:
    """Последние события PowerPlay в свежих журналах игры.

    Возвращает ``{"commander": событие|None, "system": событие|None}`` — их
    отдаёт трекеру тот, кто читал журнал. Читаются только хвосты последних
    файлов, от свежего к старому, а строки разбираются с конца: первое
    найденное событие и есть самое свежее.
    """
    result: Dict[str, Any] = {"commander": None, "system": None}
    directory = Path(journal_dir) if journal_dir else None
    if directory is None:
        return result
    wanted_name = _text(system)
    wanted_address = _text(str(address or ""))
    try:
        # Имя журнала начинается с даты и времени — оно и решает при равном mtime.
        logs = sorted(directory.glob("Journal.*.log"),
                      key=lambda item: (item.stat().st_mtime, item.name), reverse=True)
    except OSError:
        return result
    for path in logs[: max(1, int(files))]:
        try:
            size = path.stat().st_size
            with open(path, "rb") as handle:
                if size > max_bytes:
                    handle.seek(size - max_bytes)
                    handle.readline()             # неполная строка после сдвига
                raw = handle.read(max_bytes)
        except OSError:
            continue
        for line in reversed(raw.decode("utf-8", errors="replace").splitlines()):
            line = line.strip()
            if not line.startswith("{"):
                continue
            if not any(token in line for token in ("Powerplay", "FSDJump", "Location",
                                                    "CarrierJump", "LoadGame", "NewCommander")):
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            name = str(event.get("event") or "")
            if name in ("LoadGame", "NewCommander"):
                if include_session:
                    result["session"] = event
                return result  # never recover another pilot/session's pledge
            if (include_session and name in COMMANDER_EVENTS
                    and name not in ("Powerplay", "PowerplayMerits", "PowerplayRank")):
                actions = sum(key.startswith("action-") for key in result)
                if actions < ACTION_LIMIT:
                    result[f"action-{actions}"] = event
            if include_session and name in ("PowerplayMerits", "PowerplayRank"):
                field = "merits" if name == "PowerplayMerits" else "rank"
                if field not in result:
                    result[field] = event
            if result["commander"] is None and name == "Powerplay":
                if is_powerplay2(event.get("timestamp")):
                    result["commander"] = event
            elif result["system"] is None and name in SYSTEM_EVENTS:
                if _matches(event, wanted_name, wanted_address):
                    snapshot = system_state(event, source="journal-archive")
                    if snapshot is not None or (not wanted_name and not wanted_address):
                        result["system"] = event
            if not include_session and result["commander"] is not None and result["system"] is not None:
                return result
    return result


def actions_text_keys() -> Iterable[str]:
    """Ключи подписей действий — для проверок каталога переводов."""
    return ("PowerplayCollect", "PowerplayDeliver", "PowerplayVote", "PowerplaySalary",
            "PowerplayJoin", "PowerplayLeave", "PowerplayDefect", "PowerplayFastTrack",
            "PowerplayVoucher", "Powerplay", "PowerplayMerits", "PowerplayRank")


class PowerplayJournalReader:
    """Bounded bootstrap followed by byte-offset reads, only while the view polls.

    Independent of the uploader watcher (which may be stopped/offline). Never
    rereads the full journal directory on each UI tick. A partial final line is
    left for the next poll, including after log rotation or truncation.
    """

    CHUNK_BYTES = 512 * 1024

    def __init__(self):
        self._directory = None
        self._offsets = {}

    def poll(self, journal_dir, system="", address=""):
        directory = Path(journal_dir) if journal_dir else None
        if directory is None:
            return []
        try:
            paths = sorted(directory.glob("Journal.*.log"), reverse=True)[:3]
            sizes = {str(path): path.stat().st_size for path in paths}
        except OSError:
            return []
        if directory != self._directory:
            # Capture offsets BEFORE the bootstrap so appends during the scan
            # are not lost. Tracker timestamp/dedup guards handle any overlap.
            self._directory = directory
            self._offsets = sizes
            state = scan_journal_for_powerplay(directory, include_session=True)
            return sorted((event for event in state.values() if isinstance(event, dict)),
                          key=lambda event: (str(event.get("timestamp") or ""),
                                             0 if event.get("event") in ("LoadGame", "NewCommander") else 1))
        events = []
        relevant = COMMANDER_EVENTS | SYSTEM_EVENTS | {"Powerplay", "LoadGame", "NewCommander"}
        # Oldest -> newest, including the end of a file just rotated away.
        for path in reversed(paths):
            key = str(path)
            size = sizes[key]
            start = self._offsets.get(key, 0)
            if size < start:
                start = 0
            if size == start:
                continue
            try:
                with path.open("rb") as handle:
                    handle.seek(start)
                    raw = handle.read(min(size - start, self.CHUNK_BYTES))
            except OSError:
                continue
            end = raw.rfind(b"\n") + 1
            if not end:
                # Bound pathological oversized rows without stalling forever.
                if len(raw) == self.CHUNK_BYTES:
                    self._offsets[key] = start + len(raw)
                continue
            self._offsets[key] = start + end
            for line in raw[:end].splitlines():
                # Cheap filter before JSON: scans/market cargo often dominate.
                if not any(token in line for token in (b'Powerplay', b'FSDJump', b'Location',
                                                       b'CarrierJump', b'LoadGame', b'NewCommander')):
                    continue
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(event, dict) and event.get("event") in relevant:
                    events.append(event)
        self._offsets = {key: value for key, value in self._offsets.items() if key in sizes}
        return events
