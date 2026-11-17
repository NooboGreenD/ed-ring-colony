"""Эскадрилья пилота из журнала игры → сайт проекта.

Зачем
-----
Игра пишет принадлежность к эскадрилье двумя событиями:

* ``SquadronStartup`` — при каждом запуске игры, если пилот состоит в
  эскадрилье: ``SquadronID``, ``SquadronName``, ``CurrentRank``;
* ``SquadronPromotion`` — при повышении: ``SquadronID``, ``NewRank``,
  ``OldRank`` (имени ранга в событии нет — только число).

До этой версии Helper их просто пропускал, и сайт знал об эскадрилье пилота
только то, что тот ввёл руками. В списках участников проектов, в досье и в
карточке командира у половины пилотов стоял прочерк, хотя игра всё это время
сообщала данные при каждом запуске.

Что делает модуль
-----------------
``SquadronInfoCollector`` копит **одно** состояние на пилота (эскадрилья, её
имя и ранг — самые свежие) и отдаёт его в ``POST /api/cmdr/squadron``.
Повторная отправка того же состояния не нужна: она сравнивается с последней
отправленной и пропускается. Outbox лежит на диске
(``.squadron_outbox.json``), поэтому неудачная отправка не теряется при
закрытии Helper'а — ровно как у авианосцев и фракций.

Почему не пачка событий
-----------------------
Сервер применяет состояние, а не историю: «пилот в эскадрилье X, ранг N».
Если пилот за сессию вступил, вышел и вступил снова, сайту нужно последнее
состояние, а не последовательность. Поэтому здесь тоже одна запись, как у
``BgsSnapshotCollector``.

Смена эскадрильи
----------------
Игра **не пишет событие о выходе** из эскадрильи: если пилота исключили или он
ушёл сам, следующего ``SquadronStartup`` просто не будет. Значит, отсутствие
события ничего не доказывает, и «выйти из состава сайта» по журналу нельзя —
модуль только сообщает то, что игра сказала явно.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from i18n import tr

#: События журнала, из которых берётся эскадрилья пилота.
SQUADRON_EVENTS = ("SquadronStartup", "SquadronPromotion")

#: Игровые ранги эскадрильи: 0 — самый младший. В журнале встречается до 8,
#: но точный потолок Frontier не обещает — значение проверяется диапазоном, а
#: не списком названий.
MAX_GAME_RANK = 20


def normalize_game_rank(value: Any) -> Optional[int]:
    """Ранг из журнала: целое 0…MAX_GAME_RANK или None.

    ``SquadronStartup`` у только что вступившего пилота может прислать ``-1``
    («ранга ещё нет») — это не ранг, а его отсутствие.
    """
    try:
        rank = int(value)
    except (TypeError, ValueError):
        return None
    if rank < 0 or rank > MAX_GAME_RANK:
        return None
    return rank


def _clean(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit]


def squadron_state_from_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Состояние эскадрильи из журнального события (или None).

    Оба события дают ID и имя; ранг у ``SquadronPromotion`` берётся из
    ``NewRank``, у ``SquadronStartup`` — из ``CurrentRank``.
    """
    name = str(event.get("event") or "")
    if name not in SQUADRON_EVENTS:
        return None
    try:
        squadron_id = int(event.get("SquadronID"))
    except (TypeError, ValueError):
        squadron_id = 0
    if squadron_id <= 0:
        return None
    state: Dict[str, Any] = {
        "squadron_id": squadron_id,
        "squadron_name": _clean(event.get("SquadronName"), 120),
        # Тег в событиях необязателен (`SquadronTag`), но если игра его дала —
        # сайт по нему не создаст дубль эскадрильи с другим написанием имени.
        "squadron_tag": _clean(event.get("SquadronTag"), 10),
        "rank": normalize_game_rank(
            event.get("NewRank") if name == "SquadronPromotion" else event.get("CurrentRank")
        ),
        "event": name,
    }
    timestamp = _clean(event.get("timestamp"), 40)
    if timestamp:
        state["timestamp"] = timestamp
    return state


class SquadronInfoCollector:
    """Последнее известное состояние эскадрильи пилота и его отправка на сайт.

    Один экземпляр на процесс Helper'а: состояние одно, оно переживает
    перезапуск (outbox на диске) и не зависит от того, прочитан журнал
    целиком или только живой хвост.
    """

    #: Как часто разрешено повторять неудачную отправку.
    RETRY_SECONDS = 30.0

    def __init__(self, outbox_path: Optional[os.PathLike] = None) -> None:
        self._path = Path(outbox_path) if outbox_path else None
        self._lock = threading.Lock()
        self._state: Optional[Dict[str, Any]] = None
        #: Что уже принято сервером — чтобы не слать одно и то же каждые 5 с.
        self._sent: Optional[Dict[str, Any]] = None
        self._failed_at = 0.0
        self._load()

    # ------------------------------------------------------------------ outbox
    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        state = data.get("state")
        if isinstance(state, dict) and state.get("squadron_id"):
            self._state = state
        sent = data.get("sent")
        if isinstance(sent, dict) and sent.get("squadron_id"):
            self._sent = sent

    def _save(self) -> None:
        if not self._path:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"state": self._state, "sent": self._sent}
            temp = self._path.with_suffix(self._path.suffix + ".tmp")
            temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(temp, self._path)
        except OSError:
            pass

    # ------------------------------------------------------------------- приём
    def feed(self, event: Dict[str, Any], live: bool = False) -> bool:
        """Учесть событие журнала. Возвращает True, если состояние изменилось.

        Живые события и история обрабатываются одинаково: ``SquadronStartup``
        бывает только в начале сессии, и при первом запуске Helper'а именно он
        и приносит данные. Разница лишь в том, что история может идти в любом
        порядке — поэтому состояние сравнивается по времени события.
        """
        state = squadron_state_from_event(event)
        if state is None:
            return False
        with self._lock:
            previous = self._state
            if previous:
                same_squadron = int(previous.get("squadron_id") or 0) == state["squadron_id"]
                old_at = str(previous.get("timestamp") or "")
                new_at = str(state.get("timestamp") or "")
                # Старое событие истории (пере-импорт прошлых сессий) не
                # перетирает свежее состояние, но ранг уточнить может.
                if same_squadron and old_at and new_at and new_at < old_at:
                    return False
                if (same_squadron
                        and previous.get("rank") == state["rank"]
                        and previous.get("squadron_name") == state["squadron_name"]):
                    return False
                merged = dict(state)
                if not merged.get("squadron_name"):
                    merged["squadron_name"] = previous.get("squadron_name") or ""
                if merged.get("rank") is None:
                    merged["rank"] = previous.get("rank")
                self._state = merged
            else:
                self._state = dict(state)
            self._save()
            return True

    # ------------------------------------------------------------------ чтение
    @property
    def state(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            return dict(self._state) if self._state else None

    def pending_payload(self) -> Optional[Dict[str, Any]]:
        """Что нужно отправить (None — отправлять нечего).

        Пилот без эскадрильи в игре не присылает ``SquadronStartup`` вовсе,
        поэтому «нет состояния» — это не «вышел из эскадрильи», а «нечего
        сообщать».
        """
        with self._lock:
            if not self._state:
                return None
            if self._sent and self._sent == self._state:
                return None
            if time.monotonic() - self._failed_at < self.RETRY_SECONDS:
                return None
            return dict(self._state)

    # ----------------------------------------------------------------- отправка
    def flush(self, api, cmdr: Optional[str] = None) -> Dict[str, Any]:
        """Отправить состояние на сайт. Возвращает ``{ok, sent, error}``."""
        if not getattr(api, "is_connected", False):
            return {"ok": False, "sent": False, "error": tr("Нет связи с сайтом")}
        payload = self.pending_payload()
        if payload is None:
            return {"ok": True, "sent": False}

        body = {
            "game_squadron_id": payload.get("squadron_id"),
            "game_squadron_name": payload.get("squadron_name") or "",
            "game_squadron_rank": payload.get("rank"),
        }
        if payload.get("squadron_tag"):
            body["game_squadron_tag"] = payload["squadron_tag"]
        if payload.get("timestamp"):
            body["event_at"] = payload["timestamp"]

        try:
            result = api.upload_squadron(body, cmdr)
        except Exception as exc:  # сеть не должна ронять цикл чтения журнала
            result = {"ok": False, "error": str(exc)}
        if not result.get("ok"):
            self._failed_at = time.monotonic()
            return {"ok": False, "sent": False, "error": result.get("error") or "unknown error"}

        with self._lock:
            self._sent = dict(payload)
            self._failed_at = 0.0
            self._save()
        return {
            "ok": True,
            "sent": True,
            "squadron": result.get("squadronName") or result.get("squadron_name"),
            "created": bool(result.get("created")),
            "joined": bool(result.get("joined")),
            "member": bool(result.get("member")),
            "rank": result.get("rankName") or result.get("rank_name"),
        }

    def reset(self) -> None:
        """Забыть отправленное (после смены аккаунта или сброса журналов)."""
        with self._lock:
            self._sent = None
            self._failed_at = 0.0
            self._save()
