"""Груз на авианосце (Fleet Carrier): сколько уже завезено и сколько осталось.

Блок «CARRIER» в оверлее отвечает на два вопроса командира-логиста:

1. **Сколько груза сейчас на авианосце** — по тоннам (достоверно, из
   `CarrierStats.SpaceUsage`) и по товарам поимённо.
2. **Сколько осталось туда завезти** — разница между потребностью
   стройплощадки колонизации и тем, что уже лежит на борту.

Источники данных (только журнал + Raven Colonial, ничего не выдумываем):

=========================  =====================================================
Событие                    Что даёт
=========================  =====================================================
``CarrierStats``           Вместимость трюма и сколько занято грузом. Пишется,
                           когда владелец открывает Carrier Management —
                           единственный достоверный источник тоннажа.
``Docked`` / ``Location``  У какого авианосца стоим: ``MarketID`` (у FC он
``CarrierJump``            равен ``CarrierID``), имя, система.
``CargoTransfer``          Погрузка через экран Inventory → Transfer
                           (``Direction: tocarrier`` / ``toship``). Основной
                           способ завозить груз на свой FC.
``MarketBuy`` /            Торговля на борту авианосца: продажа FC
``MarketSell``             добавляет груз, покупка с FC — забирает.
``CarrierNameChanged``     Переименование.
``CarrierDecommission``    Авианосец списан — состояние очищаем.
Raven Colonial             ``GET /api/fc/{marketId}/cargo`` — товары поимённо,
                           если клиент уже отправлял груз туда (см.
                           ``CarrierTracker.merge_remote``).
=========================  =====================================================

Поимённый учёт из журнала честен ровно настолько, насколько полон журнал:
``CargoTransfer``/``Market*`` дают только дельты с момента разбора. Поэтому
``CarrierState.remote_seen`` показывает, откуда взялись цифры по товарам —
из Raven Colonial (достоверно) или из локального учёта (примерно).

Тоннаж из ``CarrierStats`` — всегда достоверный: он не зависит от того,
видели мы дельты или нет.

Сверка списка с тоннажем (``CarrierState.reconcile``)
-----------------------------------------------------

Поимённый список «протухает» легко: груз с авианосца забирают другие
командиры, покупают с его рынка, увозят на стройку — в журнале владельца
таких событий нет. Плюс при запуске разбирается хвост старых журналов, и
дельты трёхдневной давности выглядят как груз «на борту прямо сейчас».
Именно так в блоке CARRIER оставались записи товаров, которых там давно нет.

Поэтому список всегда сверяется с достоверным тоннажем:

* ``CarrierStats.SpaceUsage.Cargo`` — сколько тонн лежит на борту на самом
  деле. Между ``CarrierStats`` тоннаж ведём сами: наши ``CargoTransfer`` и
  сделки на рынке FC двигают и его (``stored_estimated``).
* ``stored == 0`` → поимённый список обнуляется: трюм пуст, показывать
  нечего.
* сумма по товарам больше тоннажа → список ужимается пропорционально, а
  если «лишнего» больше половины — выбрасывается целиком (состав
  недостоверен, честнее показать один тоннаж).
* тоннаж больше суммы по товарам → разница показывается как «прочее»: это
  груз, который завезли не мы и о котором Raven ещё не знает.

Сверка выполняется только когда тоннаж не старше поимённых данных (см.
``RECONCILE_GRACE_SECONDS``): свежий снимок Raven урезать нечем.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Mapping, Optional

from event_dispatch import (
    FLEET_CARRIER_MARKET_MAX,
    FLEET_CARRIER_MARKET_MIN,
    canonical_commodity,
    normalize_commodity,
)

#: Какие события журнала вообще смотрит трекер.
CARRIER_EVENTS = frozenset({
    "CarrierStats",
    "CarrierNameChanged",
    "CarrierDecommission",
    "CarrierCancelDecommission",
    "CarrierBuy",
    "Docked",
    "Undocked",
    "Location",
    "CarrierJump",
    "CargoTransfer",
    "MarketBuy",
    "MarketSell",
})


def _as_int(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def is_carrier_market(market_id) -> bool:
    """MarketID лежит в диапазоне авианосцев (3.7 … 3.8 млрд)."""
    value = _as_int(market_id)
    return FLEET_CARRIER_MARKET_MIN <= value < FLEET_CARRIER_MARKET_MAX


def event_time(event: Mapping[str, Any], default: Optional[float] = None) -> float:
    """Время события журнала в секундах epoch.

    Нужно, чтобы отличать «CarrierStats пришёл только что» от «CarrierStats
    вычитан из журнала трёхдневной давности при запуске». От этого зависит,
    можно ли сверять поимённый список с тоннажем: старый тоннаж не должен
    урезать свежий снимок Raven.

    Формат журнала — ISO-8601 в UTC (`2023-10-18T15:54:12Z`). Всё, что не
    разбирается, считаем «сейчас»: событие пришло в реальном времени.
    Будущее время (часы пилота спешат) прижимаем к текущему моменту.
    """
    now = time.time() if default is None else float(default)
    raw = str((event or {}).get("timestamp") or "").strip()
    if not raw:
        return now
    try:
        stamp = datetime.strptime(raw[:19], "%Y-%m-%dT%H:%M:%S")
    except (TypeError, ValueError):
        return now
    try:
        value = stamp.replace(tzinfo=timezone.utc).timestamp()
    except (OverflowError, OSError, ValueError):
        return now
    return min(float(value), now)


class CarrierState:
    """Снимок состояния авианосца.

    `stored`/`capacity`/`free` — из `CarrierStats` (тонны, достоверно).
    `commodities` — товары поимённо: либо из Raven Colonial, либо по дельтам
    журнала. `tracked_total` — сумма того, что удалось посчитать поимённо;
    она может не совпадать со `stored`, и это нормально (см. модуль).
    """

    def __init__(self) -> None:
        self.carrier_id: int = 0
        self.market_id: int = 0
        self.name: str = ""
        self.callsign: str = ""
        self.system_name: str = ""
        self.system_address: int = 0
        self.at_carrier: bool = False
        self.stats_seen: bool = False
        self.remote_seen: bool = False
        self.pending_decommission: bool = False
        # SpaceUsage
        self.capacity: int = 0
        self.stored: int = 0
        self.reserved: int = 0
        self.free: int = 0
        self.crew_space: int = 0
        self.fuel_level: float = 0.0
        # Товары поимённо: нормализованное имя -> тонны.
        # Это оценка того, что СЕЙЧАС лежит на борту: снимок из Raven Colonial
        # плюс дельты журнала после него (см. `delivered`).
        self.commodities: Dict[str, int] = {}
        # Сколько завез лично этот командир (дельты журнала с момента разбора).
        # Отдельно от `commodities`: на борту может лежать груз других
        # командиров, и «завезено мной» != «есть на авианосце».
        self.delivered: Dict[str, int] = {}
        # Последний снимок груза из Raven Colonial (товар -> тонны).
        self.remote_cargo: Dict[str, int] = {}
        self.remote_at: float = 0.0
        # Когда тоннаж был достоверно известен (время события CarrierStats).
        # Сравнивается с `remote_at`: сверять список с тоннажем можно только
        # если тоннаж не старше самого списка.
        self.stats_at: float = 0.0
        # Время последней дельты журнала (перевод/сделка на борту).
        self.delta_at: float = 0.0
        # `stored` сдвинут нашими дельтами после последнего CarrierStats —
        # значит это уже оценка, а не цифра из игры.
        self.stored_estimated: bool = False
        # Тонны на борту, которые не удалось разложить по товарам (груз
        # других командиров, о котором Raven ещё не знает).
        self.untracked: int = 0
        # Что сделала последняя сверка: "" | "emptied" | "trimmed" | "dropped".
        self.reconciled: str = ""
        # Как товар подписать в оверлее (локализованное имя из журнала).
        self.names: Dict[str, str] = {}
        self.last_event: str = ""
        # Вид носителя: "own" — свой Drake-Class, "squadron" — эскадренный
        # Javelin-Class (Vanguards, 2025), "other" — чужой авианосец.
        # Эскадренный носитель у командира не «свой» (CarrierStats по нему не
        # приходит), но груз туда возят так же, и учитывать его надо отдельно,
        # а не затирать состояние личного носителя.
        self.kind: str = "other"
        self.station_type: str = ""

    # -- производные величины ---------------------------------------------
    @property
    def known(self) -> bool:
        """Знаем ли мы вообще, о каком авианосце речь."""
        return bool(self.carrier_id or self.market_id)

    @property
    def cargo_capacity(self) -> int:
        """Сколько тонн груза влезет: занятое + свободное место.

        `TotalCapacity` включает экипаж, ангары и модульные паки, поэтому
        «вместимость под груз» — это `Cargo + FreeSpace`.
        """
        if self.stats_seen:
            return max(0, self.stored + self.free)
        return 0

    @property
    def fill_percent(self) -> int:
        capacity = self.cargo_capacity
        if capacity <= 0:
            return 0
        return max(0, min(100, int(round(self.stored * 100 / capacity))))

    @property
    def tracked_total(self) -> int:
        return sum(int(v) for v in self.commodities.values() if v > 0)

    #: Трюм личного Drake-Class — 25 000 т; у эскадренного Javelin-Class —
    #: 60 000 т. Разница и служит распознаванием, когда тип станции в журнале
    #: не уточняет вид носителя.
    SQUADRON_CARGO_HINT = 30_000

    #: На сколько тонн поимённый список может превышать тоннаж, не считаясь
    #: испорченным. Ноль: у честного учёта расхождения вверх не бывает —
    #: журнал показывает только наши тонны, а их всегда не больше, чем лежит
    #: на борту.
    RECONCILE_TOLERANCE = 0
    #: Если достоверный тоннаж меньше этой доли от суммы по товарам, состав
    #: считается недостоверным целиком: показываем тоннаж, а список прячем —
    #: пропорционально ужимать «Steel 2000» до «Steel 40» бессмысленно.
    RECONCILE_DROP_RATIO = 0.5
    #: Насколько CarrierStats может быть старше снимка Raven и всё равно
    #: считаться достовернее. Raven отдаёт то, что последними прислали
    #: клиенты, — его карта груза тоже бывает несвежей, поэтому небольшую
    #: фору тоннажу из игры даём осознанно.
    RECONCILE_GRACE_SECONDS = 300.0

    @property
    def kind_label(self) -> str:
        return {
            "own": "ваш носитель",
            "squadron": "эскадренный носитель",
        }.get(self.kind, "чужой носитель")

    def display_name(self) -> str:
        if self.name:
            return self.name
        if self.callsign:
            return f"FC {self.callsign}"
        return ""

    def summary(self) -> str:
        """Одна строка для лога/подсказки."""
        name = self.display_name() or "Fleet Carrier"
        if not self.stats_seen:
            return f"{name}: данные CarrierStats ещё не встречались"
        return (
            f"{name}: груз {self.stored} t / {self.cargo_capacity} t "
            f"(свободно {self.free} t)"
        )

    def remaining(self, need: Mapping[str, int]) -> Dict[str, int]:
        """Сколько ещё завезти по каждому товару из потребности `need`.

        Ключи `need` приводятся к тому же виду, что и учёт (нижний регистр,
        без локализационных токенов), иначе `$steel_name;` и `steel`
        считались бы разными товарами.
        """
        result: Dict[str, int] = {}
        for raw, amount in (need or {}).items():
            key = canonical_commodity(raw)
            if not key:
                continue
            try:
                want = int(amount)
            except (TypeError, ValueError):
                continue
            have = int(self.commodities.get(key, 0) or 0)
            result[key] = max(0, want - have)
        return result

    # -- сверка списка с тоннажем -------------------------------------------
    def clear_cargo(self, reason: str = "") -> bool:
        """Забыть поимённый груз (тоннаж и «завезено мной» не трогаем).

        `delivered` — это «сколько тонн привёз лично командир», счётчик его
        работы, а не содержимое трюма: обнулять его при разгрузке носителя
        неправильно. В строках оверлея он и так не может превысить «на
        борту» (см. `get_state_dict`).
        """
        if not (self.commodities or self.remote_cargo):
            self.reconciled = reason or self.reconciled
            return False
        self.commodities = {}
        self.remote_cargo = {}
        self.remote_seen = False
        self.reconciled = reason
        return True

    @staticmethod
    def _spread(shares: Mapping[str, int], amount: int) -> Dict[str, int]:
        """Разложить `amount` по долям `shares` (метод наибольших остатков).

        Ни одна позиция не отдаёт больше своей доли, а сумма разложенного
        точно равна `amount` (или всей сумме долей, если их меньше).
        """
        total = sum(max(0, int(value or 0)) for value in shares.values())
        amount = min(int(amount), total)
        if amount <= 0 or total <= 0:
            return {}
        taken: Dict[str, int] = {}
        remainders = []
        used = 0
        for key, share in shares.items():
            share = max(0, int(share or 0))
            if not share:
                continue
            exact = share * amount / total
            whole = min(share, int(exact))
            taken[key] = whole
            used += whole
            remainders.append((exact - whole, key))
        remainders.sort(key=lambda item: (-item[0], item[1]))
        for _rest, key in remainders:
            if used >= amount:
                break
            if taken[key] < max(0, int(shares[key] or 0)):
                taken[key] += 1
                used += 1
        return taken

    def _trim_to(self, target: int) -> None:
        """Убрать «лишние» тонны, начиная с тех, что возили не мы.

        Свои перевозки (`delivered`) — самая надёжная часть списка: их мы
        видели в журнале своими глазами. А вот позиции без наших доставок
        приходят из снимка Raven, который обновляют другие клиенты и который
        как раз и «протухает». Поэтому расхождение сначала списывается с
        них, и только если этого мало — ужимается всё пропорционально.
        """
        excess = self.tracked_total - int(target)
        if excess <= 0:
            return
        foreign = {}
        for key, value in self.commodities.items():
            mine = int(self.delivered.get(key, 0) or 0)
            foreign[key] = max(0, int(value or 0) - mine)
        for key, amount in self._spread(foreign, excess).items():
            self.commodities[key] = max(0, int(self.commodities[key]) - int(amount))
        self.commodities = {key: value for key, value in self.commodities.items() if value > 0}
        if self.tracked_total > int(target):
            self._scale_commodities(int(target))

    def _scale_commodities(self, target: int) -> None:
        """Ужать список до `target` тонн, сохранив пропорции.

        Метод наибольших остатков: сумма после округления точно равна
        `target`, иначе «на борту» в блоке не сходилось бы с тоннажем.
        """
        total = self.tracked_total
        if target <= 0 or total <= 0:
            self.commodities = {}
            return
        scaled: Dict[str, int] = {}
        remainders = []
        used = 0
        for key, value in self.commodities.items():
            value = int(value or 0)
            if value <= 0:
                continue
            exact = value * target / total
            whole = int(exact)
            scaled[key] = whole
            used += whole
            remainders.append((exact - whole, key))
        remainders.sort(key=lambda item: (-item[0], item[1]))
        for _rest, key in remainders[: max(0, target - used)]:
            scaled[key] += 1
        self.commodities = {key: value for key, value in scaled.items() if value > 0}

    def reconcile(self) -> bool:
        """Свести поимённый список с достоверным тоннажем `CarrierStats`.

        Возвращает True, если список пришлось править. Без `CarrierStats`
        (чужой или эскадренный носитель) сверять не с чем — выходим сразу.

        Правила и зачем они такие:

        * тоннаж старше поимённых данных (снимок Raven новее более чем на
          `RECONCILE_GRACE_SECONDS`) — не трогаем ничего, иначе свежая
          погрузка другого командира была бы «урезана» по старому числу;
        * `stored == 0` — трюм пуст, список обнуляем: это и есть те самые
          «призрачные» строки, ради которых всё затевалось;
        * сумма по товарам больше тоннажа — ужимаем (или выбрасываем, если
          расхождение больше `RECONCILE_DROP_RATIO`);
        * остаток тоннажа сверх списка запоминаем в `untracked` — блок
          покажет его как «прочее», а не будет делать вид, что его нет.
        """
        if not self.stats_seen:
            self.untracked = 0
            return False
        stored = max(0, int(self.stored))
        total = self.tracked_total
        fresher = max(self.remote_at, self.delta_at)
        if fresher and fresher > self.stats_at + self.RECONCILE_GRACE_SECONDS:
            # Поимённые данные свежее тоннажа: сверять нечем и незачем.
            # Так же отрабатывает разбор старых журналов при запуске —
            # вчерашний CarrierStats не имеет права урезать сегодняшний груз.
            self.untracked = max(0, stored - total)
            return False
        if stored <= 0:
            self.untracked = 0
            return self.clear_cargo("emptied")
        if total > stored + self.RECONCILE_TOLERANCE:
            if stored < total * self.RECONCILE_DROP_RATIO:
                self.clear_cargo("dropped")
            else:
                self._trim_to(stored)
                self.remote_seen = False
                self.reconciled = "trimmed"
            self.untracked = max(0, stored - self.tracked_total)
            return True
        self.untracked = max(0, stored - total)
        return False

    @property
    def cargo_source(self) -> str:
        """Откуда взялись цифры по товарам — для подписи в блоке CARRIER.

        `remote` — чистый снимок Raven Colonial, `journal` — наши дельты,
        `estimate` — список после сверки с тоннажем (уже не «как есть»),
        пустая строка — данных по товарам нет вовсе.
        """
        if self.remote_seen:
            return "remote"
        if self.reconciled in ("trimmed", "dropped", "emptied"):
            return "estimate"
        if self.commodities or self.delivered:
            return "journal"
        return ""

    def get_state_dict(self, need: Optional[Mapping[str, int]] = None,
                       need_label: str = "", need_source: str = "") -> Dict[str, Any]:
        """Словарь для оверлея и для хеша данных (см. `_hash_data`).

        `need` — потребность проекта/площадки, `need_label` — как её подписать
        в блоке (название проекта), `need_source` — откуда она взялась
        (`project` / `site` / `remote`), чтобы в оверлее было видно, почему
        список именно такой.
        """
        need = dict(need or {})
        rows = []
        for key in sorted(set(self.commodities) | {canonical_commodity(k) for k in need if k}):
            if not key:
                continue
            want = 0
            for raw, amount in need.items():
                if canonical_commodity(raw) == key:
                    want = _as_int(amount)
                    break
            have = int(self.commodities.get(key, 0) or 0)
            rows.append({
                "key": key,
                "name": self.names.get(key) or key,
                # Сколько лежит на борту (снимок Raven + дельты журнала).
                "amount": have,
                # Сколько завёз лично этот командир. В строке это доля от
                # «на борту», поэтому больше него быть не может: после
                # сверки с тоннажем (или разгрузки носителя другими) счётчик
                # доставок иначе показывал бы «120 из 40».
                "delivered": min(int(self.delivered.get(key, 0) or 0), have),
                "need": want,
                "remaining": max(0, want - have),
            })
        rows.sort(key=lambda row: (-row["remaining"], -row["need"], row["name"]))
        return {
            "carrier_id": self.carrier_id,
            "market_id": self.market_id,
            "name": self.display_name(),
            "callsign": self.callsign,
            "system_name": self.system_name,
            "at_carrier": bool(self.at_carrier),
            "kind": self.kind,
            "kind_label": self.kind_label,
            "station_type": self.station_type,
            "stats_seen": bool(self.stats_seen),
            "remote_seen": bool(self.remote_seen),
            "pending_decommission": bool(self.pending_decommission),
            "stored": int(self.stored),
            "capacity": int(self.capacity),
            "cargo_capacity": int(self.cargo_capacity),
            "free": int(self.free),
            "reserved": int(self.reserved),
            "fuel_level": float(self.fuel_level or 0.0),
            "fill_percent": int(self.fill_percent),
            "tracked_total": int(self.tracked_total),
            "delivered_total": sum(int(v) for v in self.delivered.values() if v > 0),
            # Тонны на борту сверх поимённого списка: груз чужих командиров,
            # о котором ни журнал, ни Raven ещё не рассказали.
            "untracked": int(self.untracked),
            # `stored` сдвинут нашими дельтами после CarrierStats — блок
            # подписывает такое число как приблизительное.
            "stored_estimated": bool(self.stored_estimated),
            # Что сделала последняя сверка с тоннажем и откуда цифры товаров.
            "reconciled": str(self.reconciled or ""),
            "cargo_source": self.cargo_source,
            # Возраст достоверного тоннажа — в минутах (как и `remote_age`,
            # чтобы блок не перерисовывался каждую секунду).
            "stats_age": (int(max(0.0, time.time() - self.stats_at) // 60)
                          if self.stats_at else 0),
            # Возраст снимка — в минутах, не в секундах. Поле попадает в хеш
            # данных оверлея (`OverlayManager._hash_data`), и секундная
            # точность перерисовывала блок CARRIER каждую секунду: текст
            # мерцал, хотя груз не менялся.
            "remote_age": (int(max(0.0, time.time() - self.remote_at) // 60)
                           if self.remote_at else 0),
            "commodities": rows,
            "need_total": sum(max(0, _as_int(v)) for v in need.values()),
            "need_label": str(need_label or ""),
            "need_source": str(need_source or ""),
        }


class CarrierTracker:
    """Собирает состояние авианосца из потока событий журнала."""

    def __init__(self) -> None:
        self.state = CarrierState()
        # Состояние по каждому носителю, с которым командир имел дело в этой
        # сессии: market_id -> CarrierState. Раньше трекер держал ровно одно
        # состояние и при стыковке к чужому носителю обнулял товары. Логист,
        # который возит груз со своего Drake-Class на эскадренный Javelin-Class
        # и обратно, из-за этого терял учёт на каждом перелёте, а блок CARRIER
        # показывал то пусто, то цифры не того носителя.
        self.carriers: Dict[int, CarrierState] = {}
        # CarrierID личного носителя (приходит только в CarrierStats).
        self.own_carrier_id: int = 0

    # -- несколько носителей -------------------------------------------------
    def _remember(self, state: CarrierState) -> None:
        key = int(state.market_id or state.carrier_id or 0)
        if key:
            self.carriers[key] = state

    def _switch_to(self, market_id: int, station_type: str = "") -> CarrierState:
        """Сделать активным носитель с этим MarketID (создав состояние)."""
        key = int(market_id or 0)
        if not key:
            return self.state
        # Уходим с прежнего носителя: «вы на борту» относится ровно к одному.
        self.state.at_carrier = False
        self._remember(self.state)
        state = self.carriers.get(key)
        if state is None:
            state = CarrierState()
            state.market_id = key
            state.carrier_id = key
            self.carriers[key] = state
        if station_type:
            state.station_type = station_type
        state.kind = self._kind_for(state)
        self.state = state
        return state

    def _state_for(self, market_id: int) -> Optional[CarrierState]:
        """Состояние конкретного носителя, НЕ меняя активный.

        `CarrierStats` приходит владельцу где угодно — в том числе пока он
        стоит на чужом носителе (Carrier Management открывается удалённо).
        Раньше такое событие делало активным личный носитель, и блок CARRIER
        показывал его груз вместо того, у которого командир стоит. То же
        самое с фоновым ответом Raven: пока он летел, пилот мог перестыковаться,
        и чужой груз ложился в состояние соседнего носителя.
        """
        key = int(market_id or 0)
        if not key:
            return None
        if int(self.state.market_id or 0) == key:
            return self.state
        if key in self.carriers:
            return self.carriers[key]
        if not int(self.state.market_id or 0):
            # Активное состояние ещё пустое — заселяем его, а не плодим второе.
            self.state.market_id = key
            self.state.carrier_id = self.state.carrier_id or key
            self._remember(self.state)
            return self.state
        state = CarrierState()
        state.market_id = key
        state.carrier_id = key
        self.carriers[key] = state
        return state

    def _kind_for(self, state: CarrierState) -> str:
        """Свой / эскадренный / чужой носитель.

        Свой — тот, по которому пришёл `CarrierStats` (он приходит только
        владельцу). Эскадренный Javelin-Class отличается трюмом (60 000 т
        против 25 000 т) и типом станции, если игра его уточняет.
        """
        if self.own_carrier_id and int(state.carrier_id or 0) == int(self.own_carrier_id):
            return "own"
        station = str(state.station_type or "").lower()
        if "squadron" in station or "javelin" in station:
            return "squadron"
        if state.capacity and int(state.capacity) >= CarrierState.SQUADRON_CARGO_HINT:
            return "squadron"
        return "other"

    def states(self) -> Dict[int, CarrierState]:
        """Все известные носители сессии (включая активный)."""
        self._remember(self.state)
        return dict(self.carriers)

    # -- входная точка -----------------------------------------------------
    def handle(self, event: Mapping[str, Any]) -> bool:
        """Обработать событие журнала. Возвращает True, если состояние менялось."""
        if not isinstance(event, Mapping):
            return False
        name = str(event.get("event") or "")
        if name not in CARRIER_EVENTS:
            return False
        handler = {
            "CarrierStats": self._absorb_stats,
            "CarrierNameChanged": self._absorb_rename,
            "CarrierDecommission": self._absorb_decommission,
            "CarrierCancelDecommission": self._absorb_cancel_decommission,
            "CarrierBuy": self._absorb_buy,
            "Docked": self._absorb_docked,
            "Location": self._absorb_docked,
            "CarrierJump": self._absorb_docked,
            "Undocked": self._absorb_undocked,
            "CargoTransfer": self._absorb_transfer,
            "MarketBuy": self._absorb_market,
            "MarketSell": self._absorb_market,
        }.get(name)
        if handler is None:
            return False
        try:
            changed = bool(handler(event))
        except Exception:
            return False
        if changed:
            self.state.last_event = name
        return changed

    def reset(self) -> None:
        self.state = CarrierState()
        self.carriers = {}
        self.own_carrier_id = 0

    # -- события ------------------------------------------------------------
    def _absorb_stats(self, event: Mapping[str, Any]) -> bool:
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id:
            return False
        # CarrierStats приходит только владельцу — значит это его носитель.
        self.own_carrier_id = carrier_id
        state = self._state_for(carrier_id) or self.state
        # Пока мы стоим на чужом носителе, активным остаётся он: сводка по
        # своему обновится «в фоне» и попадёт в строку «ещё носители».
        if state is not self.state and not self.state.at_carrier:
            self._switch_to(carrier_id)
            state = self.state
        state.carrier_id = carrier_id
        # У авианосца MarketID == CarrierID.
        state.market_id = carrier_id
        if event.get("Name"):
            state.name = str(event["Name"])
        if event.get("Callsign"):
            state.callsign = str(event["Callsign"])
        usage = event.get("SpaceUsage") or {}
        if isinstance(usage, Mapping):
            state.capacity = _as_int(usage.get("TotalCapacity"))
            state.stored = _as_int(usage.get("Cargo"))
            state.reserved = _as_int(usage.get("CargoSpaceReserved"))
            state.free = _as_int(usage.get("FreeSpace"))
            state.crew_space = _as_int(usage.get("Crew"))
        try:
            state.fuel_level = float(event.get("FuelLevel") or 0.0)
        except (TypeError, ValueError):
            state.fuel_level = 0.0
        state.pending_decommission = bool(event.get("PendingDecommission"))
        state.stats_seen = True
        # Тоннаж снова достоверный: запоминаем момент (по времени события —
        # при разборе старого журнала это не «сейчас») и сверяем список.
        state.stats_at = event_time(event)
        state.stored_estimated = False
        state.kind = self._kind_for(state)
        state.reconcile()
        self._remember(state)
        return True

    def _absorb_rename(self, event: Mapping[str, Any]) -> bool:
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id or not event.get("Name"):
            return False
        # Переименование адресовано конкретному носителю: раньше имя
        # приклеивалось к активному состоянию, и «свой» носитель получал имя,
        # пока пилот стоял у чужого.
        state = self._state_for(carrier_id) or self.state
        state.carrier_id = carrier_id
        state.market_id = carrier_id
        state.name = str(event["Name"])
        return True

    def _absorb_buy(self, event: Mapping[str, Any]) -> bool:
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id:
            return False
        self.own_carrier_id = carrier_id
        state = self._state_for(carrier_id) or self.state
        state.carrier_id = carrier_id
        state.market_id = carrier_id
        if event.get("Callsign"):
            state.callsign = str(event["Callsign"])
        if event.get("Location"):
            state.system_name = str(event["Location"])
        if event.get("SystemAddress"):
            state.system_address = _as_int(event["SystemAddress"])
        state.pending_decommission = False
        # Только что купленный носитель пуст: любые товары, оставшиеся от
        # прежнего с тем же MarketID, — мусор.
        state.clear_cargo("bought")
        state.delivered = {}
        state.stored = 0
        state.stored_estimated = False
        state.untracked = 0
        state.kind = self._kind_for(state)
        return True

    def _absorb_decommission(self, event: Mapping[str, Any]) -> bool:
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id:
            return False
        state = self._state_for(carrier_id) or self.state
        state.pending_decommission = True
        return True

    def _absorb_cancel_decommission(self, event: Mapping[str, Any]) -> bool:
        """Списание отменено — снимаем метку.

        Событие входило в `CARRIER_EVENTS`, но обработчика не имело: метка
        «списывается!» висела в блоке до перезапуска программы.
        """
        carrier_id = _as_int(event.get("CarrierID"))
        if not carrier_id:
            return False
        state = self._state_for(carrier_id) or self.state
        if not state.pending_decommission:
            return False
        state.pending_decommission = False
        return True

    def _absorb_docked(self, event: Mapping[str, Any]) -> bool:
        """Docked / Location / CarrierJump: где мы сейчас стоим."""
        station_type = str(event.get("StationType") or "")
        if "carrier" not in station_type.lower():
            # Пристыковались к обычной станции — авианосец больше не «мы».
            if self.state.at_carrier:
                self.state.at_carrier = False
                return True
            return False
        market_id = _as_int(event.get("MarketID"))
        if not market_id:
            return False
        # Пришли к другому носителю — переключаем состояние, а не стираем его.
        if int(self.state.market_id or 0) not in (0, market_id):
            self._switch_to(market_id, station_type)
        state = self.state
        state.station_type = station_type
        state.market_id = market_id
        state.carrier_id = state.carrier_id or market_id
        state.kind = self._kind_for(state)
        # Имя из `CarrierStats`/`CarrierNameChanged` достовернее: `StationName`
        # у непереименованного авианосца — это «FC L14X1J» по позывному.
        if event.get("StationName") and not state.name:
            state.name = str(event["StationName"])
        if event.get("StarSystem"):
            state.system_name = str(event["StarSystem"])
        if event.get("SystemAddress"):
            state.system_address = _as_int(event["SystemAddress"])
        state.at_carrier = True
        self._remember(state)
        return True

    def _absorb_undocked(self, event: Mapping[str, Any]) -> bool:
        if not self.state.at_carrier:
            return False
        market_id = _as_int(event.get("MarketID"))
        if market_id and self.state.market_id and market_id != self.state.market_id:
            return False
        self.state.at_carrier = False
        return True

    def _absorb_transfer(self, event: Mapping[str, Any]) -> bool:
        """Inventory → Transfer: ship <-> авианосец."""
        transfers = event.get("Transfers")
        if not isinstance(transfers, Iterable) or isinstance(transfers, (str, bytes)):
            return False
        market_id = _as_int(event.get("MarketID")) or self.state.market_id
        if not is_carrier_market(market_id) and not self.state.carrier_id:
            return False
        if market_id:
            # Перевод адресован конкретному носителю: если это не активный —
            # переключаемся, иначе тонны легли бы не тому носителю.
            if int(self.state.market_id or 0) not in (0, market_id):
                self._switch_to(market_id)
            self.state.market_id = market_id
            self.state.carrier_id = self.state.carrier_id or market_id
        changed = False
        when = event_time(event)
        for transfer in transfers:
            if not isinstance(transfer, Mapping):
                continue
            direction = str(transfer.get("Direction") or "").lower()
            if direction == "tocarrier":
                delta = _as_int(transfer.get("Count"))
            elif direction == "toship":
                delta = -_as_int(transfer.get("Count"))
            else:
                continue  # tosrv / tomultiplier — к авианосцу не относятся
            key = canonical_commodity(transfer.get("Type") or transfer.get("Type_Localised"))
            if not key or not delta:
                continue
            self._add_commodity(key, delta, transfer.get("Type_Localised"), when=when)
            changed = True
        return changed

    def _absorb_market(self, event: Mapping[str, Any]) -> bool:
        """MarketSell на борту FC — груз прибыл, MarketBuy — убыл."""
        market_id = _as_int(event.get("MarketID"))
        if not market_id:
            return False
        # На своём/чужом авианосце рынок и есть его трюм; обычную станцию
        # не трогаем — иначе «груз авианосца» превратится в лог торговли.
        if not (is_carrier_market(market_id) or market_id == self.state.market_id):
            return False
        if int(self.state.market_id or 0) not in (0, market_id):
            self._switch_to(market_id)
        count = _as_int(event.get("Count"))
        if not count:
            return False
        key = canonical_commodity(event.get("Type") or event.get("Type_Localised"))
        if not key:
            return False
        if not self.state.carrier_id:
            self.state.carrier_id = market_id
            self.state.market_id = market_id
        delta = count if str(event.get("event")) == "MarketSell" else -count
        self._add_commodity(key, delta, event.get("Type_Localised"), when=event_time(event))
        return True

    # -- служебное ----------------------------------------------------------
    def _add_commodity(self, key: str, delta: int, label=None, when: Optional[float] = None) -> None:
        """Прибавить дельту к товару (ниже нуля не опускаемся).

        Дельта применяется к оценке груза на борту и отдельно учитывается как
        «завезено этим командиром». Снимок Raven при этом не портится: он
        остаётся в `remote_cargo`, и следующая дельта считается уже от него.

        Тоннаж (`stored`/`free`) двигается той же дельтой: в игре после
        перевода `CarrierStats.SpaceUsage.Cargo` именно так и меняется, а
        замороженное число ломало бы сверку — свежую погрузку приняли бы за
        расхождение и урезали.
        """
        delta = int(delta)
        current = int(self.state.commodities.get(key, 0) or 0)
        self.state.commodities[key] = max(0, current + delta)
        if not self.state.commodities[key]:
            self.state.commodities.pop(key, None)
        if delta > 0:
            self.state.delivered[key] = int(self.state.delivered.get(key, 0) or 0) + delta
        elif delta < 0:
            left = int(self.state.delivered.get(key, 0) or 0) + delta
            if left > 0:
                self.state.delivered[key] = left
            else:
                self.state.delivered.pop(key, None)
        if label and key not in self.state.names:
            self.state.names[key] = str(label)
        # Цифры Raven перестали быть «чистым снимком»: после него были дельты.
        self.state.remote_seen = False
        self.state.delta_at = float(when if when is not None else time.time())
        if self.state.reconciled == "emptied":
            # Трюм был подтверждённо пуст, и всё, что в нём теперь есть, мы
            # видели своими глазами: это уже не «оценка», а точный учёт.
            self.state.reconciled = ""
        if self.state.stats_seen and delta:
            # Считаем по полной дельте, а не по «сколько влезло в список»:
            # из трюма ушли настоящие тонны, даже если поимённо мы знали не
            # весь груз (остальное лежало в «прочем»).
            self.state.stored = max(0, int(self.state.stored) + delta)
            self.state.free = max(0, int(self.state.free) - delta)
            self.state.stored_estimated = True
        # После дельты пересчитываем «прочее»: сколько тонн на борту так и
        # осталось не разложено по товарам.
        self.state.untracked = max(
            0, int(self.state.stored) - self.state.tracked_total) if self.state.stats_seen else 0

    def merge_remote(self, cargo: Mapping[str, Any], capacity: Optional[int] = None,
                     name: str = "", market_id: Optional[int] = None,
                     allow_empty: bool = False) -> bool:
        """Подставить поимённый груз из Raven Colonial.

        ``cargo`` — карта «товар -> тонны» (имена в нижнем регистре, как их
        хранит Raven). Локальный учёт по дельтам журнала заменяется целиком:
        Raven видел груз всех клиентов, а не только наши переводы.

        ``market_id`` — какому носителю адресован снимок. Запрос уходит в
        фоновый поток, и пока он летит, пилот успевает перестыковаться к
        другому носителю: без адреса чужой груз ложился в состояние соседа и
        оставался там навсегда. Без аргумента (старое поведение) снимок
        применяется к активному носителю.

        ``allow_empty`` — принимать ли пустой ответ как «трюм пуст». Raven
        отдаёт пустую карту и для носителей, о которых ему просто ничего не
        присылали, поэтому очищаем список только когда пустота подтверждена:
        либо `CarrierStats` говорит `Cargo == 0`, либо раньше снимок по
        этому носителю приходил непустым и с тех пор наших дельт не было.
        """
        if not isinstance(cargo, Mapping):
            return False
        if not cargo and not allow_empty:
            return False
        merged: Dict[str, int] = {}
        aliases: Dict[str, int] = {}
        for raw, amount in cargo.items():
            key = canonical_commodity(raw)
            if not key:
                continue
            value = _as_int(amount)
            if value <= 0:
                continue
            # Канонический ключ (`cmmcomposite`) важнее псевдонима
            # (`cmm-composite`): на сервере FC-cargo мог скопиться мусор от
            # старых записей, и при слиянии он не должен перебивать актуальный
            # канонический счётчик — только дополнять отсутствующий.
            if str(raw).strip().lower() == key:
                merged[key] = value
            else:
                aliases[key] = value
        for key, value in aliases.items():
            merged.setdefault(key, value)
        state = self.state if market_id in (None, 0) else self._state_for(market_id)
        if state is None:
            return False
        if not merged:
            if not allow_empty:
                return False
            # Пустой ответ — это «на борту ничего нет» только когда пустоту
            # подтверждает второй источник. Иначе это молчание Raven, и
            # затирать им честный локальный учёт нельзя.
            confirmed_empty = state.stats_seen and int(state.stored) <= 0
            # `remote_seen` ещё держится — значит после прошлого снимка наших
            # дельт не было, и пустота пришла от того же источника, что и
            # прежний непустой список.
            known_carrier = bool(state.remote_cargo) and state.remote_seen
            if not (confirmed_empty or known_carrier):
                return False
        state.remote_cargo = dict(merged)
        state.remote_at = time.time()
        # Локальный учёт по дельтам заменяется снимком целиком: Raven видел
        # груз всех командиров, а не только наши переводы. «Завезено мной»
        # при этом сохраняем — это другая величина.
        state.commodities = dict(merged)
        state.remote_seen = True
        state.reconciled = ""
        if capacity:
            state.capacity = _as_int(capacity) or state.capacity
        if name and not state.name:
            state.name = str(name)
        # Свежий снимок тоже сверяем с тоннажем: если CarrierStats новее (мы
        # только что открыли Carrier Management), правда за ним.
        state.reconcile()
        self._remember(state)
        return True

    @property
    def delivered_total(self) -> int:
        """Сколько тонн завёз этот командир (по дельтам журнала)."""
        return sum(int(v) for v in self.state.delivered.values() if v > 0)

    @property
    def remote_age(self) -> float:
        """Сколько секунд назад получен снимок груза из Raven (0 — не получен)."""
        if not self.state.remote_at:
            return 0.0
        return max(0.0, time.time() - float(self.state.remote_at))

    def reconcile(self) -> bool:
        """Сверить с тоннажем все известные носители.

        Вызывается перед выдачей данных в оверлей: блок CARRIER не должен
        показывать товары, которых по достоверному тоннажу на борту уже нет.
        Операция идемпотентна — повторный вызов ничего не меняет.
        """
        changed = False
        # Активный носитель может быть ещё «безымянным» (MarketID не известен)
        # и в `carriers` не попасть — сверяем его отдельно.
        seen = {id(self.state)}
        try:
            changed = bool(self.state.reconcile())
        except Exception:
            changed = False
        for state in self.states().values():
            if id(state) in seen:
                continue
            seen.add(id(state))
            try:
                changed = bool(state.reconcile()) or changed
            except Exception:
                continue
        return changed

    def get_state_dict(self, need: Optional[Mapping[str, int]] = None,
                       need_label: str = "", need_source: str = "") -> Dict[str, Any]:
        # Сверка перед показом: за время между событиями могла прийти правда
        # о тоннаже (CarrierStats), и старые строки обязаны исчезнуть.
        self.reconcile()
        data = self.state.get_state_dict(need, need_label=need_label,
                                         need_source=need_source)
        others = []
        for key, state in self.states().items():
            if key == int(self.state.market_id or 0):
                continue
            if not (state.tracked_total or state.stats_seen):
                continue
            others.append({
                "market_id": key,
                "name": state.display_name() or f"FC {key}",
                "kind": state.kind,
                "kind_label": state.kind_label,
                "tracked_total": state.tracked_total,
                "stored": int(state.stored),
            })
        others.sort(key=lambda row: -int(row["tracked_total"] or 0))
        data["other_carriers"] = others
        return data
