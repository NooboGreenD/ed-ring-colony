"""Публикация исследовательских событий журнала в EDDN (открытую ленту сообщества).

Spansh не принимает данные напрямую: у spansh.co.uk нет документированного API
для записи, а данные он получает из EDDN (см. EDDN docs/Developers.md). Поэтому
Uploader публикует в EDDN только то, что принимает схема `journal/1`:
Docked, FSDJump, Scan, Location, SAASignalsFound, CarrierJump.

Колонизация (стройплощадки, вклады) в EDDN схем не имеет и сюда не попадает.
CodexEntry идёт в собственную схему `codexentry/1` и пока не отправляется.

Правила — из EDDN docs/Developers.md и schemas/journal-README.md:
  * только live-схема (без `/test` в `$schemaRef`) и только live-игра;
  * никаких данных командира, кроме uploaderID и флагов horizons/odyssey;
  * удаляются все ключи с суффиксом `_Localised` и запрещённые схемой ключи;
  * недостающие StarSystem / SystemAddress / StarPos дополняются ТОЛЬКО после
    сверки с последней локацией (Location, FSDJump, CarrierJump); при
    расхождении или отсутствии сверяемых полей сообщение не отправляется;
  * флаги horizons/odyssey — только из LoadGame и только если поле там есть;
  * сообщения с 400 и 426 не повторяются; повторов здесь нет вовсе.
"""

from __future__ import annotations

import json
from typing import Optional

import requests

from http_errors import apply_client_headers

EDDN_LIVE_URL = "https://eddn.edcd.io:4430/upload/"
JOURNAL_SCHEMA_REF = "https://eddn.edcd.io/schemas/journal/1"
SOFTWARE_NAME = "ED Ring Colony Uploader"

# События, которые принимает journal/1 (enum в схеме, без CodexEntry).
EDDN_EVENTS = frozenset({"Docked", "FSDJump", "Scan", "Location", "SAASignalsFound", "CarrierJump"})
# События, которые несут собственную локацию (источник для дополнения).
LOCATION_EVENTS = frozenset({"Location", "FSDJump", "CarrierJump"})

# Ключи верхнего уровня, которых схема не допускает (раздел `disallowed`).
DISALLOWED_KEYS = frozenset({
    "ActiveFine", "CockpitBreach", "BoostUsed", "FuelLevel", "FuelUsed", "JumpDist",
    "Latitude", "Longitude", "Wanted", "IsNewEntry", "NewTraitsDiscovered", "Traits",
    "VoucherAmount",
})
# Персональные поля элементов `Factions`.
DISALLOWED_FACTION_KEYS = frozenset({"HappiestSystem", "HomeSystem", "MyReputation", "SquadronFaction"})
LOCALISED_SUFFIX = "_Localised"


def _strip_localised(value):
    """Рекурсивно убрать ключи `*_Localised` (в том числе внутри Materials/Signals/…)."""
    if isinstance(value, dict):
        return {
            key: _strip_localised(item)
            for key, item in value.items()
            if not (isinstance(key, str) and key.endswith(LOCALISED_SUFFIX))
        }
    if isinstance(value, list):
        return [_strip_localised(item) for item in value]
    return value


def _clean_faction(faction: dict) -> dict:
    cleaned = _strip_localised(faction)
    return {key: item for key, item in cleaned.items() if key not in DISALLOWED_FACTION_KEYS}


def clean_message(event: dict) -> dict:
    """Копия события журнала, пригодная для схемы journal/1 (без персональных полей)."""
    message: dict = {}
    for key, value in event.items():
        if key in DISALLOWED_KEYS or (isinstance(key, str) and key.endswith(LOCALISED_SUFFIX)):
            continue
        if key == "Factions" and isinstance(value, list):
            message[key] = [_clean_faction(item) for item in value if isinstance(item, dict)]
        else:
            message[key] = _strip_localised(value)
    return message


def _valid_position(value) -> bool:
    return (
        isinstance(value, (list, tuple))
        and len(value) == 3
        and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value)
    )


def _present(value) -> bool:
    return value is not None and value != ""


def augment_location(message: dict, location: Optional[dict]) -> bool:
    """Дополнить StarSystem / SystemAddress / StarPos по последней локации — со сверкой.

    Возвращает False, если сообщение нельзя честно дополнить: нет последней
    локации, нечем сверить (нет ни имени, ни SystemAddress), либо значения из
    события не совпадают с последней локацией (бывает, когда игра перестала
    писать журнал и продолжила с пропусками).
    """
    missing = [key for key in ("StarSystem", "SystemAddress", "StarPos") if not _present(message.get(key))]
    if not missing:
        return _valid_position(message.get("StarPos"))
    if location is None:
        return False
    if _present(message.get("SystemAddress")) and message["SystemAddress"] != location["SystemAddress"]:
        return False
    if _present(message.get("StarSystem")) and message["StarSystem"] != location["StarSystem"]:
        return False
    if "StarSystem" in missing and "SystemAddress" in missing:
        return False  # сверить не с чем
    for key in missing:
        message[key] = list(location[key]) if key == "StarPos" else location[key]
    return _valid_position(message.get("StarPos"))


class EddnContext:
    """Сведения из журнала, которые нужны сообщениям: версия игры, командир, локация.

    Ведётся для ВСЕХ событий (и исторических), чтобы сверка локации была верной,
    даже если отправку включили посреди сессии.
    """

    def __init__(self) -> None:
        self.commander = ""
        self.game_version = ""
        self.game_build = ""
        self.horizons: Optional[bool] = None
        self.odyssey: Optional[bool] = None
        self.location: Optional[dict] = None

    def observe(self, event: dict) -> None:
        name = event.get("event")
        if name == "Fileheader":
            self._set_version(event.get("gameversion"), event.get("build"), keep_existing=False)
        elif name == "LoadGame":
            # В Fileheader версия надёжнее; LoadGame дополняет, если его не было.
            self._set_version(event.get("gameversion"), event.get("build"), keep_existing=True)
            if event.get("Commander"):
                self.commander = str(event["Commander"])
            if isinstance(event.get("Horizons"), bool):
                self.horizons = event["Horizons"]
            if isinstance(event.get("Odyssey"), bool):
                self.odyssey = event["Odyssey"]
        elif name in LOCATION_EVENTS:
            system = event.get("StarSystem")
            address = event.get("SystemAddress")
            position = event.get("StarPos")
            if _present(system) and _present(address) and _valid_position(position):
                self.location = {
                    "StarSystem": str(system),
                    "SystemAddress": address,
                    "StarPos": list(position),
                }
            else:
                # Неполная локация не годится для сверки: лучше ничего не дополнять.
                self.location = None

    def _set_version(self, version, build, *, keep_existing: bool) -> None:
        version_text = str(version or "").strip()
        build_text = str(build or "").strip()
        if version_text and not (keep_existing and self.game_version):
            self.game_version = version_text
        if build_text and not (keep_existing and self.game_build):
            self.game_build = build_text

    def is_live(self) -> bool:
        """Только live-игра: при неизвестной или бета/альфа-версии не отправляем."""
        version = self.game_version.lower()
        return bool(version) and "beta" not in version and "alpha" not in version

    def build(self, event: dict, *, software_version: str) -> Optional[dict]:
        """Сообщение для EDDN или None, если событие отправлять нельзя."""
        name = event.get("event")
        if name not in EDDN_EVENTS:
            return None
        if not self.is_live() or not self.commander:
            return None
        timestamp = event.get("timestamp")
        if not isinstance(timestamp, str) or not timestamp:
            return None

        message = clean_message(event)
        if not augment_location(message, self.location):
            return None
        if self.horizons is not None:
            message["horizons"] = self.horizons
        if self.odyssey is not None:
            message["odyssey"] = self.odyssey

        return {
            "$schemaRef": JOURNAL_SCHEMA_REF,
            "header": {
                "uploaderID": self.commander,
                "softwareName": SOFTWARE_NAME,
                "softwareVersion": str(software_version or "0.0.0"),
                "gameversion": self.game_version,
                "gamebuild": self.game_build,
            },
            "message": message,
        }


class EddnClient:
    """HTTP-отправка одного сообщения в EDDN. Повторов не делает (см. docstring модуля)."""

    def __init__(
        self,
        enabled: bool = False,
        *,
        url: str = EDDN_LIVE_URL,
        timeout: float = 15.0,
        app_version: str = "0.0.0",
    ) -> None:
        self._enabled = bool(enabled)
        self.url = url
        self.timeout = timeout
        self.software_version = str(app_version or "0.0.0")
        self._session = requests.Session()
        apply_client_headers(self._session, SOFTWARE_NAME, self.software_version)

    @property
    def enabled(self) -> bool:
        return self._enabled

    def set_enabled(self, value: bool) -> None:
        self._enabled = bool(value)

    def submit(self, message: dict) -> dict:
        """Отправить сообщение. Возвращает {"ok": bool, "status"?, "error"?}."""
        if not self._enabled:
            return {"ok": False, "skipped": True}
        body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            response = self._session.post(
                self.url,
                data=body,
                headers={"Content-Type": "application/json"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            return {"ok": False, "error": f"EDDN недоступен: {exc.__class__.__name__}"}
        if response.status_code == 200:
            return {"ok": True, "status": 200}
        # 400 и 426 по правилам EDDN не повторяются: сообщение нужно чинить.
        detail = (response.text or "").strip().replace("\n", " ")[:160]
        return {
            "ok": False,
            "status": response.status_code,
            "error": f"EDDN HTTP {response.status_code}: {detail}",
        }
