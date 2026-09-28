"""Пакет кода Colonial Helper: манифест, проверка хешей, подпись, установка.

Программа поставляется двумя слоями:

* **лаунчер** — `ColonialHelper.exe`: Python, tkinter, ttkbootstrap, requests.
  Меняется редко (новая библиотека или версия Python), весит ~22 МиБ;
* **пакет кода** — те самые `uploader/*.py`: 1.55 МиБ исходников, меняется
  каждый день. Именно он обновляется по сети, пофайлово.

Этот модуль знает всё про формат пакета и раскладку установки, но **ничего**
про сеть — качает `bundle_updater`, запускает `launcher`. Так его можно
тестировать и звать из CI, не поднимая ни GUI, ни HTTP.

Раскладка установки (`%LOCALAPPDATA%\\ColonialHelper` на Windows)::

    <root>/
      app/
        2.13.0/            код версии + manifest.json
        2.13.1/            следующая версия (пока не активирована — .stage-*)
      state.json           какая версия текущая, какая предыдущая, здоровье
      cache/               кэш манифестов канала

Настройки пилота (`~/.colonial_helper.json`, токен, кэш импортов) лежат там же,
где и раньше: обновление кода их не трогает.

Безопасность. Мы **исполняем скачанный код**, поэтому манифест обязан быть
подписан Ed25519, а каждый файл — совпасть по sha256 с подписанным списком.
Публичные ключи зашиты в `TRUSTED_KEYS` (см. `build_bundle.py --keygen`).
Проверка подписи — своя, на stdlib: тянуть `cryptography`/PyNaCl в лаунчер
ради одной проверки не хочется, а лишняя зависимость — это лишний повод
пересобирать exe.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ---------------------------------------------------------------------------
#  Константы формата
# ---------------------------------------------------------------------------

#: Версия формата манифеста. Клиент отказывается ставить пакет со «старшей»
#: схемой: значит, лаунчер не понимает половину полей.
SCHEMA = 1

#: Точка входа по умолчанию — модуль, у которого зовут `main()`.
DEFAULT_ENTRY = "colonial_helper.py"

#: Что вообще может лежать в пакете. Исполняемых расширений здесь нет
#: намеренно: пакет — это код на Python и данные, а не установщик.
ALLOWED_SUFFIXES = (".py", ".json", ".txt", ".md", ".ico", ".png", ".csv")

#: Потолки здравого смысла: пакет — это ~30 модулей на пару мегабайт.
MAX_FILES = 400
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_BUNDLE_BYTES = 64 * 1024 * 1024

#: Имена служебных файлов.
MANIFEST_NAME = "manifest.json"
STATE_NAME = "state.json"

#: Сколько версий держим на диске: текущая + предыдущая (для отката).
KEEP_VERSIONS = 2

#: Сколько запусков даётся новой версии, чтобы отметиться здоровой.
#: Второй запуск без отметки — откат: значит, программа падает до готового окна.
MAX_LAUNCH_ATTEMPTS = 2

#: Доверенные ключи подписи: `key_id -> base64(32 байта Ed25519 public key)`.
#: Заполняется один раз при настройке канала обновлений:
#:     python uploader/build_bundle.py --keygen
#: Приватный ключ уходит в секреты CI (`UPLOADER_SIGN_KEY`), публичный — сюда.
#: Пустой словарь означает «канал обновлений не настроен»: клиент не поставит
#: НИ ОДНОГО пакета, и это правильное поведение по умолчанию.
TRUSTED_KEYS: Dict[str, str] = {}

#: Переменная окружения для своего ключа (self-hosted и отладка):
#: `COLONIAL_HELPER_UPDATE_KEYS="dev:BASE64[,id2:BASE64]"`.
KEYS_ENV = "COLONIAL_HELPER_UPDATE_KEYS"

#: Куда ставится программа. Переопределяется переменной окружения —
#: тесты и портативный режим не должны лезть в %LOCALAPPDATA%.
HOME_ENV = "COLONIAL_HELPER_HOME"

_VERSION_RE = re.compile(r"^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.\-]{1,40})?$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_KEY_ID_RE = re.compile(r"^[0-9A-Za-z._\-]{1,40}$")


class BundleError(Exception):
    """Пакет нельзя принять: формат, подпись или хеши не сошлись."""


# ---------------------------------------------------------------------------
#  Ed25519 (RFC 8032) на стандартной библиотеке
# ---------------------------------------------------------------------------
_P = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _sha512(data: bytes) -> bytes:
    return hashlib.sha512(data).digest()


def _modp_inv(x: int) -> int:
    return pow(x, _P - 2, _P)


def _recover_x(y: int, sign: int) -> Optional[int]:
    if y >= _P:
        return None
    xx = (y * y - 1) * _modp_inv(_D * y * y + 1) % _P
    if xx == 0:
        return None if sign else 0
    x = pow(xx, (_P + 3) // 8, _P)
    if (x * x - xx) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x * x - xx) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


_G_Y = 4 * _modp_inv(5) % _P
_G_X = _recover_x(_G_Y, 0) or 0
#: Базовая точка в расширенных координатах (x, y, z, t).
_G = (_G_X, _G_Y, 1, _G_X * _G_Y % _P)


def _point_add(p: Tuple[int, int, int, int], q: Tuple[int, int, int, int]):
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % _P
    b = (y1 + x1) * (y2 + x2) % _P
    c = 2 * t1 * t2 * _D % _P
    d = 2 * z1 * z2 % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _point_mul(scalar: int, point) -> Tuple[int, int, int, int]:
    result = (0, 1, 1, 0)
    while scalar > 0:
        if scalar & 1:
            result = _point_add(result, point)
        point = _point_add(point, point)
        scalar >>= 1
    return result


def _point_equal(p, q) -> bool:
    x1, y1, z1, _ = p
    x2, y2, z2, _ = q
    return (x1 * z2 - x2 * z1) % _P == 0 and (y1 * z2 - y2 * z1) % _P == 0


def _point_compress(p) -> bytes:
    x, y, z, _ = p
    z_inv = _modp_inv(z)
    x = x * z_inv % _P
    y = y * z_inv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _point_decompress(data: bytes):
    if len(data) != 32:
        return None
    value = int.from_bytes(data, "little")
    sign = value >> 255
    y = value & ((1 << 255) - 1)
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


def _secret_expand(secret: bytes) -> Tuple[int, bytes]:
    if len(secret) != 32:
        raise BundleError("Ed25519: приватный ключ должен быть ровно 32 байта")
    digest = _sha512(secret)
    a = int.from_bytes(digest[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, digest[32:]


def ed25519_public_key(secret: bytes) -> bytes:
    """Публичный ключ (32 байта) из seed'а (32 байта)."""
    a, _ = _secret_expand(secret)
    return _point_compress(_point_mul(a, _G))


def ed25519_sign(secret: bytes, message: bytes) -> bytes:
    """Подпись (64 байта). Используется только сборщиком пакета в CI."""
    a, prefix = _secret_expand(secret)
    public = _point_compress(_point_mul(a, _G))
    r = int.from_bytes(_sha512(prefix + message), "little") % _L
    big_r = _point_compress(_point_mul(r, _G))
    h = int.from_bytes(_sha512(big_r + public + message), "little") % _L
    s = (r + h * a) % _L
    return big_r + int.to_bytes(s, 32, "little")


def ed25519_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    """Проверка подписи. Никогда не бросает: плохой вход — это просто False."""
    try:
        if len(public) != 32 or len(signature) != 64:
            return False
        point_a = _point_decompress(public)
        if point_a is None:
            return False
        big_r = signature[:32]
        point_r = _point_decompress(big_r)
        if point_r is None:
            return False
        s = int.from_bytes(signature[32:], "little")
        if s >= _L:
            return False
        h = int.from_bytes(_sha512(big_r + public + message), "little") % _L
        return _point_equal(_point_mul(s, _G), _point_add(point_r, _point_mul(h, point_a)))
    except Exception:
        return False


# ---------------------------------------------------------------------------
#  Хеши и пути
# ---------------------------------------------------------------------------
def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 256), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_member_path(value: str) -> str:
    """Проверить путь файла внутри пакета и вернуть его в нормальном виде.

    Запрещено всё, чем распаковщики и апдейтеры традиционно простреливают
    ногу: абсолютные пути, `..`, диски, обратные слеши, скрытые каталоги и
    расширения не из белого списка.
    """
    raw = str(value or "").strip()
    if not raw or len(raw) > 200:
        raise BundleError(f"Недопустимое имя файла в пакете: {value!r}")
    if "\\" in raw or raw.startswith("/") or ":" in raw:
        raise BundleError(f"Абсолютный путь в пакете запрещён: {raw!r}")
    parts = [p for p in raw.split("/") if p not in ("",)]
    if not parts or any(p in (".", "..") or p.startswith(".") for p in parts):
        raise BundleError(f"Небезопасный путь в пакете: {raw!r}")
    if not re.fullmatch(r"[0-9A-Za-z._\-/]+", "/".join(parts)):
        raise BundleError(f"Недопустимые символы в пути: {raw!r}")
    if not "/".join(parts).lower().endswith(ALLOWED_SUFFIXES):
        raise BundleError(f"Файл такого типа в пакете не нужен: {raw!r}")
    return "/".join(parts)


def canonical_bytes(manifest: Dict[str, Any]) -> bytes:
    """Байты, которые подписываются: манифест без `signature`, стабильный JSON.

    Подпись считается по каноническому виду (сортировка ключей, без пробелов,
    UTF-8), иначе перестановка полей при пересохранении ломала бы проверку.
    """
    payload = {k: v for k, v in (manifest or {}).items() if k != "signature"}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False).encode("utf-8")


# ---------------------------------------------------------------------------
#  Манифест
# ---------------------------------------------------------------------------
def check_manifest(manifest: Any) -> str:
    """Валидность манифеста без учёта подписи. Пустая строка — всё хорошо."""
    if not isinstance(manifest, dict):
        return "манифест не является объектом JSON"
    schema = manifest.get("schema")
    if schema != SCHEMA:
        return f"схема манифеста {schema!r}, поддерживается {SCHEMA}"
    version = str(manifest.get("version") or "")
    if not _VERSION_RE.match(version):
        return f"некорректная версия {version!r}"
    channel = str(manifest.get("channel") or "")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,20}", channel):
        return f"некорректный канал {channel!r}"
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        return "в манифесте нет списка файлов"
    if len(files) > MAX_FILES:
        return f"слишком много файлов: {len(files)}"
    seen = set()
    total = 0
    for item in files:
        if not isinstance(item, dict):
            return "элемент files не является объектом"
        try:
            path = safe_member_path(item.get("path", ""))
        except BundleError as exc:
            return str(exc)
        if path in seen:
            return f"файл {path} указан дважды"
        seen.add(path)
        digest = str(item.get("sha256") or "").lower()
        if not _SHA256_RE.match(digest):
            return f"у файла {path} нет корректного sha256"
        size = item.get("size")
        if not isinstance(size, int) or size < 0 or size > MAX_FILE_BYTES:
            return f"у файла {path} недопустимый размер {size!r}"
        total += size
    if total > MAX_BUNDLE_BYTES:
        return f"пакет слишком велик: {total} байт"
    try:
        entry = safe_member_path(manifest.get("entry") or DEFAULT_ENTRY)
    except BundleError as exc:
        return str(exc)
    if entry not in seen:
        return f"точка входа {entry} отсутствует в списке файлов"
    if not entry.endswith(".py"):
        return f"точка входа {entry} должна быть модулем .py"
    return ""


def trusted_keys(extra: Optional[Dict[str, str]] = None) -> Dict[str, bytes]:
    """Доверенные публичные ключи: зашитые + из окружения + переданные явно."""
    keys: Dict[str, bytes] = {}

    def _add(key_id: str, encoded: str):
        if not _KEY_ID_RE.match(str(key_id or "")):
            return
        try:
            raw = base64.b64decode(str(encoded or ""), validate=True)
        except Exception:
            return
        if len(raw) == 32:
            keys[str(key_id)] = raw

    for key_id, encoded in (TRUSTED_KEYS or {}).items():
        _add(key_id, encoded)
    for chunk in str(os.environ.get(KEYS_ENV, "")).split(","):
        if ":" in chunk:
            key_id, _, encoded = chunk.partition(":")
            _add(key_id.strip(), encoded.strip())
    for key_id, encoded in (extra or {}).items():
        _add(key_id, encoded)
    return keys


def verify_manifest(manifest: Any, keys: Optional[Dict[str, str]] = None,
                    require_signature: bool = True) -> str:
    """Полная проверка манифеста: формат + подпись. Пустая строка — принят.

    Возвращаем текст ошибки, а не исключение: результат идёт в лог программы
    и в подсказку интерфейса, и ни одна из этих ошибок не должна ронять
    запуск — просто останемся на текущей версии.

    `require_signature=False` допустим ровно в одном месте — для пакета,
    встроенного в сам exe: он приехал внутри подписанного (или хотя бы
    скачанного пользователем вручную) файла программы, и отказать ему в
    установке означало бы «программа не запускается вообще». Всё, что
    приходит по сети, проверяется подписью всегда.
    """
    problem = check_manifest(manifest)
    if problem:
        return problem
    signature = manifest.get("signature")
    if not require_signature and not isinstance(signature, dict):
        return ""
    if not isinstance(signature, dict):
        return "манифест не подписан"
    if str(signature.get("alg") or "") != "ed25519":
        return f"неизвестный алгоритм подписи {signature.get('alg')!r}"
    key_id = str(signature.get("key_id") or "")
    available = trusted_keys(keys)
    if not available:
        return ("канал обновлений не настроен: в сборке нет доверенного ключа "
                "подписи (см. build_bundle.py --keygen)")
    public = available.get(key_id)
    if public is None:
        return f"подпись сделана неизвестным ключом {key_id!r}"
    try:
        raw = base64.b64decode(str(signature.get("value") or ""), validate=True)
    except Exception:
        return "подпись не читается (ожидался base64)"
    if not ed25519_verify(public, canonical_bytes(manifest), raw):
        return "подпись манифеста не сходится — пакет отвергнут"
    return ""


def manifest_files(manifest: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """`{путь: {'sha256': …, 'size': …}}` — удобная форма для сравнения."""
    out: Dict[str, Dict[str, Any]] = {}
    for item in manifest.get("files") or []:
        path = safe_member_path(item.get("path", ""))
        out[path] = {"sha256": str(item.get("sha256", "")).lower(),
                     "size": int(item.get("size") or 0)}
    return out


def build_manifest(source_dir, version: str, channel: str = "stable",
                   entry: str = DEFAULT_ENTRY, files: Optional[Iterable[str]] = None,
                   min_launcher: str = "1.0.0", notes: str = "",
                   released_at: str = "", extra: Optional[Dict[str, Any]] = None
                   ) -> Dict[str, Any]:
    """Собрать манифест по каталогу с кодом (используется сборщиком в CI)."""
    root = Path(source_dir)
    names: List[str]
    if files is None:
        names = sorted(p.name for p in root.glob("*.py"))
    else:
        names = sorted({safe_member_path(f) for f in files})
    records = []
    for name in names:
        path = root / name
        if not path.is_file():
            raise BundleError(f"Нет файла {path}")
        records.append({
            "path": safe_member_path(name),
            "size": path.stat().st_size,
            "sha256": sha256_file(path),
        })
    manifest: Dict[str, Any] = {
        "schema": SCHEMA,
        "channel": channel,
        "version": version,
        "entry": safe_member_path(entry),
        "min_launcher": str(min_launcher or "1.0.0"),
        "released_at": released_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "notes": str(notes or "")[:4000],
        "files": sorted(records, key=lambda r: r["path"]),
    }
    if extra:
        for key, value in extra.items():
            if key not in manifest and key != "signature":
                manifest[key] = value
    problem = check_manifest(manifest)
    if problem:
        raise BundleError(problem)
    return manifest


def sign_manifest(manifest: Dict[str, Any], secret: bytes, key_id: str) -> Dict[str, Any]:
    """Подписать манифест приватным ключом (32 байта seed)."""
    if not _KEY_ID_RE.match(str(key_id or "")):
        raise BundleError(f"Недопустимый key_id {key_id!r}")
    payload = {k: v for k, v in manifest.items() if k != "signature"}
    signature = ed25519_sign(secret, canonical_bytes(payload))
    payload["signature"] = {
        "alg": "ed25519",
        "key_id": str(key_id),
        "value": base64.b64encode(signature).decode("ascii"),
    }
    return payload


# ---------------------------------------------------------------------------
#  Раскладка установки
# ---------------------------------------------------------------------------
def install_root() -> Path:
    """Каталог установки: `%LOCALAPPDATA%\\ColonialHelper` или аналог."""
    override = os.environ.get(HOME_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            return Path(base) / "ColonialHelper"
        return Path.home() / "AppData" / "Local" / "ColonialHelper"
    data_home = os.environ.get("XDG_DATA_HOME", "").strip()
    if data_home:
        return Path(data_home) / "ColonialHelper"
    return Path.home() / ".local" / "share" / "ColonialHelper"


def versions_dir(root) -> Path:
    return Path(root) / "app"


def version_dir(root, version: str) -> Path:
    if not _VERSION_RE.match(str(version or "")):
        raise BundleError(f"Некорректная версия {version!r}")
    return versions_dir(root) / str(version)


def stage_dir(root, version: str) -> Path:
    if not _VERSION_RE.match(str(version or "")):
        raise BundleError(f"Некорректная версия {version!r}")
    return versions_dir(root) / f".stage-{version}"


def state_path(root) -> Path:
    return Path(root) / STATE_NAME


def _blank_state() -> Dict[str, Any]:
    return {"schema": SCHEMA, "current": "", "previous": "", "pending": None,
            "channel": "stable", "updated_at": ""}


def load_state(root) -> Dict[str, Any]:
    """Состояние установки. Битый или отсутствующий файл — пустое состояние."""
    try:
        data = json.loads(state_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _blank_state()
    if not isinstance(data, dict):
        return _blank_state()
    state = _blank_state()
    state.update({k: v for k, v in data.items() if k in state or k == "pending"})
    for key in ("current", "previous", "channel"):
        state[key] = str(state.get(key) or "")
    pending = state.get("pending")
    if not isinstance(pending, dict) or not pending.get("version"):
        state["pending"] = None
    return state


def save_state(root, state: Dict[str, Any]) -> None:
    """Записать состояние атомарно: обрыв не должен оставить битый JSON."""
    path = state_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(state)
    payload["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def read_manifest(root, version: str) -> Optional[Dict[str, Any]]:
    """Манифест установленной версии (лежит рядом с её файлами)."""
    try:
        data = json.loads((version_dir(root, version) / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError, BundleError):
        return None
    return data if isinstance(data, dict) else None


def verify_directory(folder, manifest: Dict[str, Any],
                     keys: Optional[Dict[str, str]] = None,
                     require_signature: bool = True) -> str:
    """Проверить каталог с кодом: подпись манифеста + хеши всех файлов."""
    problem = verify_manifest(manifest, keys, require_signature)
    if problem:
        return problem
    path_root = Path(folder)
    for path, meta in manifest_files(manifest).items():
        target = path_root / path
        if not target.is_file():
            return f"нет файла {path}"
        if target.stat().st_size != meta["size"]:
            return f"размер файла {path} не совпадает"
        if sha256_file(target) != meta["sha256"]:
            return f"файл {path} изменён (sha256 не совпадает)"
    return ""


def verify_installed(root, version: str, manifest: Optional[Dict[str, Any]] = None,
                     keys: Optional[Dict[str, str]] = None,
                     require_signature: bool = True) -> str:
    """Проверить установленную версию: подпись манифеста + хеши всех файлов.

    Делается при каждом запуске. 27 файлов на 1.55 МиБ — это ~15 мс, зато
    подменённый на диске модуль (антивирус «полечил», кто-то дописал свой код)
    не уедет в исполнение молча.
    """
    data = manifest or read_manifest(root, version)
    if data is None:
        return f"нет манифеста версии {version}"
    if str(data.get("version")) != str(version):
        return f"манифест от версии {data.get('version')}, а каталог {version}"
    return verify_directory(version_dir(root, version), data, keys, require_signature)


def write_bundle_files(target_dir, manifest: Dict[str, Any],
                       contents: Dict[str, bytes]) -> None:
    """Разложить файлы пакета в каталог и записать рядом манифест."""
    folder = Path(target_dir)
    folder.mkdir(parents=True, exist_ok=True)
    wanted = manifest_files(manifest)
    for path, meta in wanted.items():
        data = contents.get(path)
        if data is None:
            raise BundleError(f"В пакете нет файла {path}")
        if sha256_bytes(data) != meta["sha256"]:
            raise BundleError(f"Файл {path} не совпал по sha256")
        target = folder / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (folder / MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def promote_stage(root, version: str) -> Path:
    """Перенести подготовленный каталог `.stage-<version>` на его место."""
    stage = stage_dir(root, version)
    target = version_dir(root, version)
    if not stage.is_dir():
        raise BundleError(f"Нет подготовленного каталога {stage}")
    if target.exists():
        backup = target.with_name(f".old-{version}-{int(time.time())}")
        os.replace(target, backup)
        shutil.rmtree(backup, ignore_errors=True)
    os.replace(stage, target)
    return target


def activate(root, version: str) -> Dict[str, Any]:
    """Сделать версию текущей; прошлая становится кандидатом на откат."""
    state = load_state(root)
    previous = str(state.get("current") or "")
    if previous and previous != version:
        state["previous"] = previous
    state["current"] = str(version)
    # Новая версия считается «на испытательном сроке», пока не отметится
    # здоровой: два запуска без отметки — откат.
    state["pending"] = {"version": str(version), "attempts": 0}
    save_state(root, state)
    return state


def note_launch(root, version: str) -> Dict[str, Any]:
    """Отметить попытку запуска версии (зовёт лаунчер перед импортом кода)."""
    state = load_state(root)
    pending = state.get("pending")
    if isinstance(pending, dict) and str(pending.get("version")) == str(version):
        pending["attempts"] = int(pending.get("attempts") or 0) + 1
        state["pending"] = pending
        save_state(root, state)
    return state


def mark_healthy(root, version: str) -> None:
    """Версия дожила до готового окна — снимаем испытательный срок."""
    state = load_state(root)
    pending = state.get("pending")
    if isinstance(pending, dict) and str(pending.get("version")) == str(version):
        state["pending"] = None
        save_state(root, state)


def needs_rollback(state: Dict[str, Any]) -> bool:
    """Версия не отметилась здоровой за отведённые запуски?"""
    pending = state.get("pending")
    if not isinstance(pending, dict):
        return False
    if str(pending.get("version")) != str(state.get("current")):
        return False
    return int(pending.get("attempts") or 0) >= MAX_LAUNCH_ATTEMPTS


def rollback(root) -> str:
    """Вернуться на предыдущую версию. Возвращает версию или пустую строку."""
    state = load_state(root)
    previous = str(state.get("previous") or "")
    if not previous:
        return ""
    try:
        if not version_dir(root, previous).is_dir():
            return ""
    except BundleError:
        return ""
    state["current"] = previous
    state["previous"] = ""
    state["pending"] = None
    save_state(root, state)
    return previous


def installed_versions(root) -> List[str]:
    folder = versions_dir(root)
    if not folder.is_dir():
        return []
    out = []
    for item in folder.iterdir():
        if item.is_dir() and _VERSION_RE.match(item.name):
            out.append(item.name)
    return sorted(out)


def prune_versions(root, keep: int = KEEP_VERSIONS) -> List[str]:
    """Удалить старые версии, оставив текущую, предыдущую и `keep` свежих."""
    state = load_state(root)
    protected = {str(state.get("current") or ""), str(state.get("previous") or "")}
    versions = installed_versions(root)
    # Сначала номер версии, при равенстве — время установки: две сборки одной
    # версии (пересобранный prerelease) различаются только временем.
    versions.sort(key=lambda v: (version_tuple(v), version_dir(root, v).stat().st_mtime),
                  reverse=True)
    removed = []
    for index, version in enumerate(versions):
        if version in protected or index < keep:
            continue
        shutil.rmtree(version_dir(root, version), ignore_errors=True)
        removed.append(version)
    # Заодно подчищаем брошенные stage/old каталоги от прерванных установок.
    folder = versions_dir(root)
    if folder.is_dir():
        for item in folder.iterdir():
            if item.is_dir() and item.name.startswith((".stage-", ".old-")):
                shutil.rmtree(item, ignore_errors=True)
    return removed


# ---------------------------------------------------------------------------
#  Совместимость лаунчера
# ---------------------------------------------------------------------------
def version_tuple(text) -> Tuple[int, ...]:
    """«2.13.0-rc1» -> (2, 13, 0). Суффикс не участвует в сравнении."""
    match = re.match(r"(\d+(?:\.\d+)*)", str(text or "").strip().lstrip("vV"))
    if not match:
        return ()
    out = []
    for part in match.group(1).split("."):
        try:
            out.append(int(part))
        except ValueError:
            break
    return tuple(out)


def launcher_supports(manifest: Dict[str, Any], launcher_version: str) -> bool:
    """Потянет ли текущий лаунчер этот пакет (`min_launcher` из манифеста)."""
    need = version_tuple(manifest.get("min_launcher") or "0")
    have = version_tuple(launcher_version)
    if not need:
        return True
    return have >= need


def temp_dir_for(root) -> Path:
    """Временный каталог рядом с установкой: `os.replace` не ходит между дисками."""
    folder = versions_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=".tmp-", dir=str(folder)))
